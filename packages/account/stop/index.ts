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
import { encodeFunctionData, getAddress, hashTypedData, type Hex } from 'viem'
import type { Address, StopInput } from '@mamoru/domain'
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
