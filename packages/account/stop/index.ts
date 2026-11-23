// otto/mamoru#430: the owner's Stop on any chain, from explicit inputs. The one builder the operator prepares a Stop with
// and the Worker rebuilds it with before the owner signs: the same bytes and hash on any machine.
//
//   removeSession(id) for every id in `revokes`
//   NPM decreaseLiquidity + collect (to the Safe) + burn for every position
//   ERC-4626 redeem/withdraw of each vault exit, paid to the Safe
//   exact approve, exactInputSingle back to USDC (to the Safe), approve 0, for each swap
//
// Every call is the Safe acting on its own funds: nothing a Stop builds pays anyone but the Safe. The operator chooses the
// amounts (minimums, shares) from its chain reads; the targets come from the chain's pinned registry.
import { encodeFunctionData, getAddress, hashTypedData, parseAbi, type Hex } from 'viem'
import { chainOf, isChainId, type Address, type StopInput } from '@mamoru/domain'
import { address, entry, erc4626Abi, type Registry } from '@mamoru/registry'
import { uniswapV3 } from '@mamoru/uniswap-v3'
import { ownerSafeTx, stopBatch, type LivePosition } from '../live/index.ts'
import { safeTxTypedData, type MultiSendCall, type SafeTx } from '../safe/index.ts'
import type { WireSafeTx } from '../one-auth/index.ts'

export type { StopInput } from '@mamoru/domain'

/** A swap of `token` back to USDC on `pool`. */
export type SwapBack = { token: string; pool: string; amountIn: bigint; amountOutMinimum: bigint }
/** What one vault call of an exit takes: `redeem` burns `shares`, `withdraw` takes exactly `assets`. Both pay the Safe. */
export type VaultCall = { vault: string; mode: 'redeem' | 'withdraw'; assets: bigint; shares: bigint }

/**
 * The most a Safe-paid Stop may have refunded, in gas: the operator's OWNER_TX_GAS as safeTxGas, and SAFE_PAID_BASE_GAS plus
 * DEPLOY_GAS (a Safe the relayer deploys first) as baseGas. A refund over these is not one the operator prepares.
 */
export const STOP_REFUND_MAX_SAFE_TX_GAS = 4_000_000n
export const STOP_REFUND_MAX_BASE_GAS = 620_000n

const ZERO: Address = '0x0000000000000000000000000000000000000000'
const strip = (c: { to: Address; value: bigint; data: Hex }): MultiSendCall => ({ to: c.to, value: c.value, data: c.data })
const dec = (s: unknown, what: string): bigint => {
  if (typeof s !== 'string' || !/^[0-9]+$/.test(s)) throw new Error(`buildStop: ${what} is not a decimal integer`)
  return BigInt(s)
}

/** Each swap: exact approve to SwapRouter02, exactInputSingle to the Safe, approve back to 0. */
export function swapBackCalls(account: Address, swaps: readonly SwapBack[], registry: Registry): MultiSendCall[] {
  const { approve, exactInputSingle } = uniswapV3(registry)
  return swaps
    .filter((s) => s.amountIn > 0n)
    .flatMap((s) =>
      [
        approve(s.token, 'SwapRouter02', s.amountIn),
        exactInputSingle({ account, tokenIn: s.token, tokenOut: 'USDC', fee: entry(s.pool, registry).fee!, amountIn: s.amountIn, amountOutMinimum: s.amountOutMinimum }),
        approve(s.token, 'SwapRouter02', 0n),
      ].map(strip),
    )
}

/** Each exit: the vault's redeem(shares) or withdraw(assets), with the Safe as receiver and owner. */
export function vaultExitCalls(account: Address, exits: readonly VaultCall[], registry: Registry): MultiSendCall[] {
  return exits.map((x) => ({
    to: address(x.vault, registry),
    value: 0n,
    data:
      x.mode === 'redeem'
        ? encodeFunctionData({ abi: erc4626Abi, functionName: 'redeem', args: [x.shares, account, account] })
        : encodeFunctionData({ abi: erc4626Abi, functionName: 'withdraw', args: [x.assets, account, account] }),
  }))
}

/** The calls of `input`, in order. Throws on any input the operator would not prepare. */
export function stopCalls(input: StopInput, registry: Registry): MultiSendCall[] {
  if (registry.chainId !== input.chainId) throw new Error(`buildStop: registry of chain ${registry.chainId}, input on ${input.chainId}`)
  const safe = getAddress(input.safe)
  if (!Array.isArray(input.revokes) || !Array.isArray(input.positions) || !Array.isArray(input.vaultExits) || !Array.isArray(input.swaps)) throw new Error('buildStop: malformed input')
  for (const id of input.revokes) if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error('buildStop: a revoke is not a session id')
  const positions: LivePosition[] = input.positions.map((p) => ({ tokenId: dec(p.tokenId, 'tokenId'), liquidity: dec(p.liquidity, 'liquidity'), amount0Min: dec(p.amount0Min, 'amount0Min'), amount1Min: dec(p.amount1Min, 'amount1Min') }))
  const deadline = dec(input.deadline, 'deadline')
  const exits: VaultCall[] = input.vaultExits.map((x) => {
    if (x.mode !== 'redeem' && x.mode !== 'withdraw') throw new Error('buildStop: a vault exit is neither redeem nor withdraw')
    if (entry(x.vault, registry).kind !== 'vault') throw new Error(`buildStop: ${x.vault} is not a vault`)
    return { vault: x.vault, mode: x.mode, assets: dec(x.assets, 'assets'), shares: dec(x.shares, 'shares') }
  })
  if (new Set(exits.map((x) => x.vault)).size !== exits.length) throw new Error('buildStop: one vault exited twice')
  const swaps: SwapBack[] = input.swaps.map((s) => {
    const pool = entry(s.pool, registry)
    if (pool.kind !== 'pool' || s.token === 'USDC' || ![pool.token0, pool.token1].includes(s.token) || ![pool.token0, pool.token1].includes('USDC')) throw new Error(`buildStop: ${s.token} does not swap back to USDC on ${s.pool}`)
    return { token: s.token, pool: s.pool, amountIn: dec(s.amountIn, 'amountIn'), amountOutMinimum: dec(s.amountOutMinimum, 'amountOutMinimum') }
  })
  const calls = [
    ...(input.revokes.length || positions.length ? stopBatch({ account: safe, permissionIds: input.revokes as Hex[], positions, deadline, registry }) : []),
    ...vaultExitCalls(safe, exits, registry),
    ...swapBackCalls(safe, swaps, registry),
  ]
  if (!calls.length) throw new Error('buildStop: nothing to stop')
  return calls
}

/** The refund of a Safe-paid Stop, or undefined. Throws on one the operator would not prepare. */
function refundOf(input: StopInput): SafeTx['refund'] {
  if (!input.refund) return undefined
  const r = input.refund
  const refund = { safeTxGas: dec(r.safeTxGas, 'safeTxGas'), baseGas: dec(r.baseGas, 'baseGas'), gasPrice: dec(r.gasPrice, 'gasPrice'), refundReceiver: getAddress(r.refundReceiver) }
  if (refund.gasPrice === 0n || BigInt(refund.refundReceiver) === 0n) throw new Error('buildStop: a refund pays someone at some price')
  if (refund.safeTxGas > STOP_REFUND_MAX_SAFE_TX_GAS || refund.baseGas > STOP_REFUND_MAX_BASE_GAS) throw new Error('buildStop: a refund over what a Stop is given')
  return refund
}

/** The Stop Safe transaction of `input` and its hash (the passkey's challenge). */
export function buildStop(input: StopInput, registry: Registry): { safeTx: WireSafeTx; safeTxHash: Hex; calls: MultiSendCall[] } {
  const calls = stopCalls(input, registry)
  const nonce = dec(input.safeNonce, 'safeNonce')
  const refund = refundOf(input)
  const tx: SafeTx = { ...ownerSafeTx(calls, nonce, registry), ...(refund ? { refund } : {}) }
  const safeTx: WireSafeTx = {
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: tx.operation as 0 | 1,
    safeTxGas: (refund?.safeTxGas ?? 0n).toString(),
    baseGas: (refund?.baseGas ?? 0n).toString(),
    gasPrice: (refund?.gasPrice ?? 0n).toString(),
    gasToken: ZERO,
    refundReceiver: refund?.refundReceiver ?? ZERO,
    nonce: nonce.toString(),
  }
  const safeTxHash = hashTypedData(safeTxTypedData(getAddress(input.safe), input.chainId, tx))
  return { safeTx, safeTxHash, calls }
}

// ---- each swap's minimum out against QuoterV2 (otto/mamoru#430 review) ------------------------------------------------

/**
 * A swap's minimum out, at least this share (bps) of what QuoterV2 answers the Worker for the same swap. The operator asks
 * its own quote less the policy's slippage (50 bps); the rest is room for the price to move between the two reads.
 */
export const STOP_MIN_OUT_BPS = 9_700n

export const quoteExactInputSingleAbi = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

/** A swap back to USDC the Stop of `input` makes, as QuoterV2 is asked about it. */
export type StopQuote = { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; amountOutMinimum: bigint }

/** The swaps of `input` that buildStop puts in the Safe tx (amountIn > 0), in order, with the registry's addresses. */
export function stopQuotes(input: StopInput, registry: Registry): StopQuote[] {
  return input.swaps
    .map((s) => ({ tokenIn: address(s.token, registry), tokenOut: address('USDC', registry), fee: entry(s.pool, registry).fee!, amountIn: dec(s.amountIn, 'amountIn'), amountOutMinimum: dec(s.amountOutMinimum, 'amountOutMinimum') }))
    .filter((q) => q.amountIn > 0n)
}

/** Null when each swap's minimum out is at least STOP_MIN_OUT_BPS of `quotes` (QuoterV2's answer for it, in order); else which. */
export function quoteFloorMismatch(swaps: readonly StopQuote[], quotes: readonly bigint[]): string | null {
  if (quotes.length !== swaps.length) return 'quotes'
  for (const [i, sw] of swaps.entries()) if (sw.amountOutMinimum * 10_000n < quotes[i]! * STOP_MIN_OUT_BPS) return `swap ${i} minimum out`
  return null
}

// ---- what the owner reads before signing a Stop (otto/mamoru#430 review) ---------------------------------------------

const usdc = (v: bigint): string => {
  const t = v.toString().padStart(7, '0')
  return `${t.slice(0, -6)}.${t.slice(-6, -4)}`
}
const units18 = (v: bigint): string => {
  const t = v.toString().padStart(19, '0')
  const frac = t.slice(-18).slice(0, 6).replace(/0+$/, '')
  return frac ? `${t.slice(0, -18)}.${frac}` : t.slice(0, -18)
}

/** The fixed lines of a revoke-only Stop (the operator's planRevokeOnly): positions readable, or not. */
export const REVOKE_ONLY_LINES = [
  'Your positions and tokens stay in your Safe as they are; Stop again closes them',
  'Your positions could not be read just now: they stay in your Safe as they are, and Stop again closes them',
] as const

/**
 * Whether `summary`, the lines the owner reads before signing, says exactly what `input` builds, line by line, in the
 * operator's own words (planFullStop, planRevokeOnly, feePlan): the number of revocations, each position closed (by its
 * token id, labelled as a pool of the registry), each vault exit and swap with its amounts, and the fee line exactly when
 * the Safe pays a refund, with the most it can cost. Free numbers only where the input has none (what a vault cannot pay
 * now, how many positions stay, until when sponsorship is used up). Null when it does; else what does not match.
 */
export function stopSummaryMismatch(input: StopInput, summary: unknown, registry: Registry): string | null {
  if (!Array.isArray(summary) || !summary.every((l) => typeof l === 'string')) return 'summary is not a list of lines'
  const lines = summary as string[]
  let i = 0
  const take = (ok: (l: string) => boolean): boolean => {
    if (i < lines.length && ok(lines[i]!)) {
      i++
      return true
    }
    return false
  }
  const exact = (want: string) => take((l) => l === want)
  const revokes = input.revokes.length
  const revokeOnly = !input.positions.length && !input.vaultExits.length && !input.swaps.length && input.deadline === '0'
  if (revokeOnly) {
    if (!exact(`Revoke the engine's ${revokes} session grant(s)`)) return 'revocations'
    if (!take((l) => (REVOKE_ONLY_LINES as readonly string[]).includes(l))) return 'revoke-only'
  } else {
    if (revokes && !exact(`Revoke the engine's ${revokes} session grant(s)`)) return 'revocations'
    const pools = registry.entries.filter((e) => e.kind === 'pool').map((e) => `${e.token0}/${e.token1} ${(e.fee! / 10_000).toFixed(2)}%`)
    for (const p of input.positions) if (!take((l) => pools.some((label) => l === `Close and burn position #${p.tokenId} (${label})`))) return `position ${p.tokenId}`
    for (const x of input.vaultExits) {
      const label = entry(x.vault, registry).label ?? x.vault.replace(/^vault:/, '')
      if (!exact(`Take ${usdc(BigInt(x.assets))} USDC out of ${label}`)) return `vault ${x.vault}`
    }
    take((l) => /^[0-9]+\.[0-9]{2} USDC stays in a lending vault that cannot pay it out right now: Stop again later to take it$/.test(l))
    for (const sw of input.swaps) if (!exact(`Swap ${BigInt(sw.amountIn)} ${sw.token} units to at least ${usdc(BigInt(sw.amountOutMinimum))} USDC`)) return `swap ${sw.token}`
    if (!exact('Everything stays in your Safe as USDC')) return 'closing line'
    take((l) => /^[1-9][0-9]* more position\(s\) stay in your Safe: Stop again to close them$/.test(l))
  }
  if (input.refund) {
    const fee = (BigInt(input.refund.safeTxGas) + BigInt(input.refund.baseGas)) * BigInt(input.refund.gasPrice)
    const symbol = isChainId(input.chainId) ? chainOf(input.chainId).native.symbol : 'ETH'
    const head = `Your Safe pays this transaction's network fee to Mamoru's relayer, at most about ${units18(fee)} ${symbol} (sponsored transactions are used up until `
    if (!take((l) => l.startsWith(head) && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\)$/.test(l.slice(head.length)))) return 'fee line'
  }
  return i === lines.length ? null : `unexpected line ${i + 1}`
}

/**
 * Who a Safe-paid Stop may refund, and at most at what gas price, per chain: `chainId:receiver:maxGasPriceWei`, comma
 * separated (the Worker's STOP_REFUND_POLICY). A malformed entry is skipped: that chain then has no policy.
 */
export function parseRefundPolicy(text: string | undefined): Map<number, { receiver: Address; maxGasPrice: bigint }> {
  const out = new Map<number, { receiver: Address; maxGasPrice: bigint }>()
  for (const part of (text ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
    const m = /^([0-9]+):(0x[0-9a-fA-F]{40}):([0-9]+)$/.exec(part)
    if (!m || BigInt(m[2]!) === 0n || BigInt(m[3]!) === 0n) continue
    out.set(Number(m[1]), { receiver: getAddress(m[2]!), maxGasPrice: BigInt(m[3]!) })
  }
  return out
}

/** Null when `input` refunds nobody, or only `policy`'s receiver at no more than its gas price; else why not. */
export function refundMismatch(input: StopInput, policy: { receiver: Address; maxGasPrice: bigint } | undefined): string | null {
  if (!input.refund) return null
  if (!policy) return 'a refund on a chain with no refund policy'
  if (typeof input.refund.refundReceiver !== 'string' || input.refund.refundReceiver.toLowerCase() !== policy.receiver.toLowerCase()) return 'refund receiver'
  return dec(input.refund.gasPrice, 'gasPrice') > policy.maxGasPrice ? 'refund gas price' : null
}
