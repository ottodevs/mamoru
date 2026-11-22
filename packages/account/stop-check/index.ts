// otto/mamoru#430: what a Stop may ask the owner to sign. The operator plans a Stop from what it reads at that block
// (positions, quotes, vault liquidity), so the Worker cannot rebuild it from explicit inputs the way it rebuilds a
// migration or a return home. It reads the Safe tx instead and passes it only when every call is one a Stop makes, with
// the Safe itself as the only recipient:
//
//   SmartSession.removeSession(id)
//   NonfungiblePositionManager.decreaseLiquidity(..) / collect(recipient = Safe) / burn(tokenId)
//   <registry token>.approve(SwapRouter02, amount), back to 0 before the batch ends
//   SwapRouter02.exactInputSingle(tokenIn a registry token, tokenOut USDC, recipient = Safe)
//   <registry vault>.redeem(shares, Safe, Safe) / withdraw(assets, Safe, Safe)
//
// Every call: value 0, calldata exactly the canonical encoding of what it decodes to (no trailing or dirty bytes). Several
// calls only through MultiSendCallOnly 1.4.1, every entry a CALL. The hash the owner signs is recomputed from the tx.
//
// Not checked here: the amounts (a swap's minimum out or price limit, how much liquidity is removed). Every one of them leaves the money
// in the Safe; the summary the owner reads names them.
import { decodeFunctionData, encodeFunctionData, getAddress, hashTypedData, hexToBigInt, isAddressEqual, size, slice, type Abi, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, erc20Abi, erc4626Abi, multiSendCallOnlyAbi, nonfungiblePositionManagerAbi, smartSessionAbi, swapRouter02Abi, type Registry } from '@mamoru/registry'
import { safeTxTypedData, type MultiSendCall, type SafeTx } from '../safe/index.ts'
import type { WireSafeTx } from '../one-auth/index.ts'

/**
 * A Stop the Safe pays for itself refunds `(gasUsed + baseGas) * gasPrice` to the relayer (operator feePlan: the Safe-paid
 * base gas plus a deploy, 120k + 500k). A larger baseGas would pay the relayer for gas it never spent.
 */
export const STOP_MAX_BASE_GAS = 620_000n

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

/** Why `calls` are not a Stop of `safe` on `registry`'s chain, or null when every call is one a Stop makes. */
export function whyNotStopCalls(safe: Address, calls: readonly MultiSendCall[], registry: Registry): string | null {
  if (!calls.length) return 'no call'
  const at = (name: string) => address(name, registry)
  const usdc = at('USDC')
  const router = at('SwapRouter02')
  const tokens = registry.entries.filter((e) => e.kind === 'token').map((e) => e.address)
  const vaults = registry.entries.filter((e) => e.kind === 'vault').map((e) => e.address)
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
        const p = d.args[0] as { tokenIn: Address; tokenOut: Address; recipient: Address }
        if (!is(p.recipient, safe)) return 'swap recipient'
        return is(p.tokenOut, usdc) && tokens.some((t) => is(p.tokenIn, t)) ? null : 'swap tokens'
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
 * Why the Stop prepare `body` is not one the owner of the Safe `safe` on `chainId` may sign, or null when it is: its
 * `safeTx` hashes to the `safeTxHash` it asks for, pays no token but the native one, refunds at most STOP_MAX_BASE_GAS
 * over the gas used, and makes only the calls whyNotStopCalls admits.
 */
export function whyNotStop(safe: Address, chainId: number, body: { safe?: string; chainId?: number; safeTxHash?: string; safeTx?: WireSafeTx }, registry: Registry): string | null {
  if (registry.chainId !== chainId || body.chainId !== chainId) return 'chain'
  if (typeof body.safe !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.safe) || !isAddressEqual(body.safe as Address, safe)) return 'safe'
  const w = body.safeTx
  if (!w) return 'no safeTx'
  let tx: SafeTx
  let calls: MultiSendCall[]
  try {
    if (!isAddressEqual(w.gasToken, ZERO)) return 'gas token'
    const value = dec(w.value, 'value')
    const safeTxGas = dec(w.safeTxGas, 'safeTxGas')
    const baseGas = dec(w.baseGas, 'baseGas')
    const gasPrice = dec(w.gasPrice, 'gasPrice')
    const refunds = gasPrice !== 0n
    if (refunds ? baseGas > STOP_MAX_BASE_GAS || isAddressEqual(w.refundReceiver, ZERO) : safeTxGas !== 0n || baseGas !== 0n || !isAddressEqual(w.refundReceiver, ZERO)) return 'refund'
    tx = { to: getAddress(w.to), value, data: w.data, operation: w.operation, nonce: dec(w.nonce, 'nonce'), ...(refunds ? { refund: { safeTxGas, baseGas, gasPrice, refundReceiver: getAddress(w.refundReceiver) } } : {}) }
    if (w.operation === 1) {
      if (!isAddressEqual(tx.to, address('MultiSendCallOnly_141', registry)) || value !== 0n) return 'batch'
      calls = multiSendEntries(w.data)
      if (calls.length < 2) return 'batch'
    } else if (w.operation === 0) calls = [{ to: tx.to, value, data: w.data }]
    else return 'operation'
  } catch (e) {
    return `safeTx: ${e instanceof Error ? e.message : String(e)}`
  }
  const why = whyNotStopCalls(safe, calls, registry)
  if (why) return why
  const hash = hashTypedData(safeTxTypedData(safe, chainId, tx))
  return hash.toLowerCase() === (body.safeTxHash ?? '').toLowerCase() ? null : 'hash'
}
