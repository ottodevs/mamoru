// otto/mamoru#430: what a Stop may ask the owner to sign. The operator plans a Stop from what it reads at that block
// (positions, quotes, vault liquidity), so the Worker cannot rebuild it from explicit inputs the way it rebuilds a
// migration or a return home. It reads the Safe tx instead and passes it only when every call is one a Stop makes, with
// the Safe itself as the only recipient:
//
//   SmartSession.removeSession(id)
//   NonfungiblePositionManager.decreaseLiquidity(..) / collect(recipient = Safe) / burn(tokenId)
//   <registry token>.approve(SwapRouter02, amount), back to 0 before the batch ends
//   SwapRouter02.exactInputSingle(tokenIn -> USDC on a pool of the registry, recipient = Safe)
//   <registry vault>.redeem(shares, Safe, Safe) / withdraw(assets, Safe, Safe)
//
// Every call: value 0, calldata exactly the canonical encoding of what it decodes to (no trailing or dirty bytes). Several
// calls only through MultiSendCallOnly 1.4.1, every entry a CALL. The hash the owner signs is recomputed from the tx.
//
// The amounts are bounded by what the Worker reads itself (whyNotStopBounds): each swap's minimum out against QuoterV2 at
// the time of the check, and a Safe-paid refund's gas price against the chain's. How much liquidity is removed or how much
// a vault pays out is not bounded: whatever it is stays in the Safe.
import { decodeFunctionData, encodeFunctionData, getAddress, hashTypedData, hexToBigInt, isAddressEqual, parseAbi, size, slice, type Abi, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, erc20Abi, erc4626Abi, multiSendCallOnlyAbi, nonfungiblePositionManagerAbi, smartSessionAbi, swapRouter02Abi, type Registry } from '@mamoru/registry'
import { safeTxTypedData, type MultiSendCall, type SafeTx } from '../safe/index.ts'
import type { WireSafeTx } from '../one-auth/index.ts'

/**
 * A Stop the Safe pays for itself refunds `(gasUsed + baseGas) * gasPrice` to the relayer (operator feePlan: the Safe-paid
 * base gas plus a deploy, 120k + 500k). A larger baseGas would pay the relayer for gas it never spent.
 */
export const STOP_MAX_BASE_GAS = 620_000n
/** The gas a Safe-paid Stop may forward to its calls: the operator's OWNER_TX_GAS. */
export const STOP_MAX_SAFE_TX_GAS = 4_000_000n
/** A Safe-paid Stop's gas price, at most this many times the chain's when the Worker checks it (the operator asks twice). */
export const STOP_MAX_GAS_PRICE_TIMES = 3n
/**
 * A swap's minimum out, at least this share (bps) of what QuoterV2 answers the Worker for the same swap. The operator asks
 * its own quote less the policy's slippage (50 bps); the rest is room for the price to move between the two reads.
 */
export const STOP_MIN_OUT_BPS = 9_700n

export const quoteExactInputSingleAbi = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

/** A swap back to USDC a Stop makes, as decoded from its calldata. */
export type StopSwap = { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; amountOutMinimum: bigint }
/** What a Stop that passed the shape check asks the Worker to read before it may be signed. */
export type StopNeeds = { swaps: StopSwap[]; refundGasPrice: bigint | null }

const ZERO: Address = '0x0000000000000000000000000000000000000000'

const dec = (s: unknown, what: string): bigint => {
  if (typeof s !== 'string' || !/^[0-9]+$/.test(s)) throw new Error(`${what} is not a decimal integer`)
  return BigInt(s)
}

/** The entries of a MultiSendCallOnly `multiSend(bytes)` payload; throws unless every entry is a well-formed CALL. */
export function multiSendEntries(data: Hex): MultiSendCall[] {
  const { functionName, args } = decodeFunctionData({ abi: multiSendCallOnlyAbi, data })
  if (functionName !== 'multiSend' || encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName, args }).toLowerCase() !== data.toLowerCase()) throw new Error('multiSend: not canonical')
  const packed = args[0]
  const end = size(packed)
  const calls: MultiSendCall[] = []
  for (let at = 0; at < end; ) {
    if (end - at < 85) throw new Error('multiSend: truncated entry')
    if (Number(hexToBigInt(slice(packed, at, at + 1))) !== 0) throw new Error('multiSend: not a CALL')
    const to = getAddress(slice(packed, at + 1, at + 21))
    const value = hexToBigInt(slice(packed, at + 21, at + 53))
    const len = Number(hexToBigInt(slice(packed, at + 53, at + 85)))
    if (end - at - 85 < len) throw new Error('multiSend: truncated data')
    calls.push({ to, value, data: len ? slice(packed, at + 85, at + 85 + len) : '0x' })
    at += 85 + len
  }
  return calls
}

/** The function `data` calls on `abi` with its args, only when `data` is exactly its canonical encoding. */
function decodeExact(abi: Abi, data: Hex): { functionName: string; args: readonly unknown[] } | null {
  try {
    const d = decodeFunctionData({ abi, data })
    const args = (d.args ?? []) as readonly unknown[]
    return encodeFunctionData({ abi, functionName: d.functionName, args } as never).toLowerCase() === data.toLowerCase() ? { functionName: d.functionName, args } : null
  } catch {
    return null
  }
}

/**
 * Why `calls` are not a Stop of `safe` on `registry`'s chain, or null when every call is one a Stop makes. `swaps`, when
 * given, receives every swap back to USDC, for whyNotStopBounds.
 */
export function whyNotStopCalls(safe: Address, calls: readonly MultiSendCall[], registry: Registry, swaps: StopSwap[] = []): string | null {
  if (!calls.length) return 'no call'
  const at = (name: string) => address(name, registry)
  const usdc = at('USDC')
  const router = at('SwapRouter02')
  const tokens = registry.entries.filter((e) => e.kind === 'token').map((e) => e.address)
  const vaults = registry.entries.filter((e) => e.kind === 'vault').map((e) => e.address)
  // A pool of the registry that pairs `token` with USDC at `fee`: never one an operator could have made thin itself.
  const usdcPool = (token: Address, fee: number) =>
    registry.entries.some((e) => e.kind === 'pool' && e.fee === fee && e.token0 && e.token1 && ((e.token0 === 'USDC' && is(token, at(e.token1))) || (e.token1 === 'USDC' && is(token, at(e.token0)))))
  const is = (a: unknown, b: Address) => typeof a === 'string' && isAddressEqual(a as Address, b)
  const allowance = new Map<string, bigint>()
  for (const [i, c] of calls.entries()) {
    const why = (() => {
      if (c.value !== 0n) return 'value'
      if (is(c.to, at('SmartSession'))) return decodeExact(smartSessionAbi, c.data)?.functionName === 'removeSession' ? null : 'session call'
      if (is(c.to, at('NonfungiblePositionManager'))) {
        const d = decodeExact(nonfungiblePositionManagerAbi, c.data)
        if (d?.functionName === 'decreaseLiquidity' || d?.functionName === 'burn') return null
        if (d?.functionName === 'collect') return is((d.args[0] as { recipient: Address }).recipient, safe) ? null : 'collect recipient'
        return 'position call'
      }
      if (is(c.to, router)) {
        const d = decodeExact(swapRouter02Abi, c.data)
        if (d?.functionName !== 'exactInputSingle') return 'router call'
        const p = d.args[0] as { tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint; amountOutMinimum: bigint }
        if (!is(p.recipient, safe)) return 'swap recipient'
        if (!is(p.tokenOut, usdc) || !tokens.some((t) => is(p.tokenIn, t))) return 'swap tokens'
        if (!usdcPool(p.tokenIn, p.fee)) return 'swap pool'
        swaps.push({ tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum })
        return null
      }
      if (vaults.some((v) => is(c.to, v))) {
        const d = decodeExact(erc4626Abi, c.data)
        if (d?.functionName !== 'redeem' && d?.functionName !== 'withdraw') return 'vault call'
        return is(d.args[1], safe) && is(d.args[2], safe) ? null : 'vault receiver'
      }
      if (tokens.some((t) => is(c.to, t))) {
        const d = decodeExact(erc20Abi, c.data)
        if (d?.functionName !== 'approve' || !is(d.args[0], router)) return 'token call'
        allowance.set(c.to.toLowerCase(), d.args[1] as bigint)
        return null
      }
      return 'target'
    })()
    if (why) return `call ${i}: ${why}`
  }
  for (const [token, left] of allowance) if (left !== 0n) return `approval of ${token} left open`
  return null
}

/**
 * Reads the Stop prepare `body` the operator gave for the Safe `safe` on `chainId`. `why` when the owner may not sign it:
 * its `safeTx` must hash to the `safeTxHash` it asks for, pay no token but the native one, refund at most
 * STOP_MAX_BASE_GAS over the gas used with a gas budget of its own, and make only the calls whyNotStopCalls admits.
 * Otherwise what the Worker must read before passing it on (whyNotStopBounds).
 */
export function readStop(safe: Address, chainId: number, body: { safe?: string; chainId?: number; safeTxHash?: string; safeTx?: WireSafeTx }, registry: Registry): { why: string } | StopNeeds {
  if (registry.chainId !== chainId || body.chainId !== chainId) return { why: 'chain' }
  if (typeof body.safe !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.safe) || !isAddressEqual(body.safe as Address, safe)) return { why: 'safe' }
  const w = body.safeTx
  if (!w) return { why: 'no safeTx' }
  let tx: SafeTx
  let calls: MultiSendCall[]
  try {
    if (!isAddressEqual(w.gasToken, ZERO)) return { why: 'gas token' }
    const value = dec(w.value, 'value')
    const safeTxGas = dec(w.safeTxGas, 'safeTxGas')
    const baseGas = dec(w.baseGas, 'baseGas')
    const gasPrice = dec(w.gasPrice, 'gasPrice')
    const refunds = gasPrice !== 0n
    // A refund forwards exactly safeTxGas to the calls: 0 there would let them fail and the refund still be paid.
    const refundOk = safeTxGas > 0n && safeTxGas <= STOP_MAX_SAFE_TX_GAS && baseGas <= STOP_MAX_BASE_GAS && !isAddressEqual(w.refundReceiver, ZERO)
    if (refunds ? !refundOk : safeTxGas !== 0n || baseGas !== 0n || !isAddressEqual(w.refundReceiver, ZERO)) return { why: 'refund' }
    tx = { to: getAddress(w.to), value, data: w.data, operation: w.operation, nonce: dec(w.nonce, 'nonce'), ...(refunds ? { refund: { safeTxGas, baseGas, gasPrice, refundReceiver: getAddress(w.refundReceiver) } } : {}) }
    if (w.operation === 1) {
      if (!isAddressEqual(tx.to, address('MultiSendCallOnly_141', registry)) || value !== 0n) return { why: 'batch' }
      calls = multiSendEntries(w.data)
      if (calls.length < 2) return { why: 'batch' }
    } else if (w.operation === 0) calls = [{ to: tx.to, value, data: w.data }]
    else return { why: 'operation' }
  } catch (e) {
    return { why: `safeTx: ${e instanceof Error ? e.message : String(e)}` }
  }
  const swaps: StopSwap[] = []
  const why = whyNotStopCalls(safe, calls, registry, swaps)
  if (why) return { why }
  if (hashTypedData(safeTxTypedData(safe, chainId, tx)).toLowerCase() !== (body.safeTxHash ?? '').toLowerCase()) return { why: 'hash' }
  return { swaps, refundGasPrice: tx.refund?.gasPrice ?? null }
}

/** readStop's verdict alone: why the owner may not sign `body`, or null when only the reads remain. */
export function whyNotStop(safe: Address, chainId: number, body: Parameters<typeof readStop>[2], registry: Registry): string | null {
  const r = readStop(safe, chainId, body, registry)
  return 'why' in r ? r.why : null
}

/**
 * Why what the Worker read refuses the Stop of `needs`, or null when it may be signed: each swap's minimum out at least
 * STOP_MIN_OUT_BPS of `quotes` (QuoterV2's answer for that swap, in order), a refund's gas price at most
 * STOP_MAX_GAS_PRICE_TIMES the chain's `gasPrice`.
 */
export function whyNotStopBounds(needs: StopNeeds, read: { quotes: readonly bigint[]; gasPrice: bigint | null }): string | null {
  if (read.quotes.length !== needs.swaps.length) return 'quotes'
  for (const [i, sw] of needs.swaps.entries()) if (sw.amountOutMinimum * 10_000n < read.quotes[i]! * STOP_MIN_OUT_BPS) return `swap ${i} minimum out`
  if (needs.refundGasPrice !== null && (read.gasPrice === null || needs.refundGasPrice > read.gasPrice * STOP_MAX_GAS_PRICE_TIMES)) return 'refund gas price'
  return null
}
