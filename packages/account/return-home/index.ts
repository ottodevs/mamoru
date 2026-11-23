// otto/mamoru#428 (spec 014), step 1 of leaving Monad: the owner's Safe transaction on a design-C Safe on Monad that ends
// Mamoru's access there and sends its USDC home. The one builder the operator prepares with and the Worker rebuilds with:
// explicit inputs, the same bytes and hash on any machine.
//
//   removeSession(id) for every session still enabled on the Safe (the same set as Stop)
//   USDC.approve(TokenMessengerV2, amount)                                                      } only when amount > 0
//   TokenMessengerV2.depositForBurn(amount, Base, mintRecipient = home, USDC, destinationCaller 0, maxFee 0, Standard) }
//
// No position may be open and no WMON held beyond dust when it is built (#427 winds them down first): a burn of a fixed
// amount is then the whole Safe, with nothing priced at signing time.
import { encodeFunctionData, getAddress, hashTypedData, isAddressEqual, pad, type Hex } from 'viem'
import type { Address, MonadSellInput, ReturnHomeInput } from '@mamoru/domain'
import { liveWmonUsdcMonadV6 } from '@mamoru/policy'
import { address, entry, erc20Abi, tokenMessengerV2Abi, type Registry } from '@mamoru/registry'
import { sqrtRatioAtTick, token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { ownerSafeTx } from '../live/index.ts'
import { safeTxTypedData } from '../safe/index.ts'
import { revocationCalls } from '../sessions/index.ts'
import { swapBackCalls } from '../stop/index.ts'
import type { WireSafeTx } from '../one-auth/index.ts'

/** Circle's TokenMessengerV2: the same address on Ethereum, Base and Monad (registry abis note). */
export const TOKEN_MESSENGER_V2: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
/** CCTP domain of Base, the only home a return goes to. */
export const RETURN_HOME_DOMAIN = 6
/** Standard finality: no fee today; maxFee 0 never pays Circle anything. */
export const RETURN_HOME_FINALITY = 2000
const BASE_CHAIN_ID = 8453

export type { MonadSellInput, ReturnHomeInput } from '@mamoru/domain'

const ZERO: Address = '0x0000000000000000000000000000000000000000'
const dec = (s: string, what: string): bigint => {
  if (typeof s !== 'string' || !/^[0-9]+$/.test(s)) throw new Error(`buildReturnHome: ${what} is not a decimal integer`)
  return BigInt(s)
}

/**
 * The release id of an owner-signed return, derived from its burn transaction's hash: the Monad operator records it under
 * this id and the home accepts an owner report only under the id it derives itself from the attested tx.
 */
export function returnReleaseId(txHash: Hex): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('returnReleaseId: not a transaction hash')
  return `home-${txHash.slice(2, 26).toLowerCase()}`
}

/** The calls of `input`, in order. Throws on any input the operator would not prepare. */
export function returnHomeCalls(input: ReturnHomeInput, registry: Registry): { to: Address; value: bigint; data: Hex }[] {
  if (registry.chainId !== input.chainId) throw new Error(`buildReturnHome: registry of chain ${registry.chainId}, input on ${input.chainId}`)
  if (input.chainId === BASE_CHAIN_ID) throw new Error('buildReturnHome: a return leaves a remote chain, never Base')
  const amount = dec(input.amountUsdc, 'amountUsdc')
  if (amount === 0n && !input.removeIds.length) throw new Error('buildReturnHome: nothing to send home and nothing to revoke')
  const home = getAddress(input.home)
  const safe = getAddress(input.safe)
  if (BigInt(home) === 0n || isAddressEqual(home, safe)) throw new Error('buildReturnHome: home is the Base Safe, neither zero nor this Safe')
  if (new Set(input.removeIds.map((id) => id.toLowerCase())).size !== input.removeIds.length) throw new Error('buildReturnHome: duplicate session id')
  const usdc = address('USDC', registry)
  if (amount === 0n) return revocationCalls(input.removeIds, registry)
  return [
    ...revocationCalls(input.removeIds, registry),
    { to: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TOKEN_MESSENGER_V2, amount] }) },
    {
      to: TOKEN_MESSENGER_V2,
      value: 0n,
      data: encodeFunctionData({ abi: tokenMessengerV2Abi, functionName: 'depositForBurn', args: [amount, RETURN_HOME_DOMAIN, pad(home, { size: 32 }), usdc, `0x${'00'.repeat(32)}`, 0n, RETURN_HOME_FINALITY] }),
    },
  ]
}

/** The return-home Safe transaction of `input` and its hash (the passkey's challenge). No refund: Mamoru pays. */
export function buildReturnHome(input: ReturnHomeInput, registry: Registry): { safeTx: WireSafeTx; safeTxHash: Hex; calls: { to: Address; value: bigint; data: Hex }[] } {
  const calls = returnHomeCalls(input, registry)
  const nonce = dec(input.safeNonce, 'safeNonce')
  const tx = ownerSafeTx(calls, nonce, registry)
  const safeTx: WireSafeTx = { to: tx.to, value: '0', data: tx.data, operation: tx.operation as 0 | 1, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: nonce.toString() }
  const safeTxHash = hashTypedData(safeTxTypedData(getAddress(input.safe), input.chainId, tx))
  return { safeTx, safeTxHash, calls }
}

// ---- step A0: the owner sale on a Safe whose engine cannot sell (spec 014 RH-07) ------------------------------------------
//
// MamoruActionPolicyV3 refuses every swap of a session whose daily budget is over the pool's depth (#410), so on such a Safe
// the WMON the unwind left can only be sold by the owner. One owner Safe tx, nothing revoked and nothing sent:
//
//   WMON.approve(SwapRouter02, w)
//   SwapRouter02.exactInputSingle(WMON -> USDC, the growth pool's fee, recipient = this Safe, amountIn = w, amountOutMinimum = m)
//   WMON.approve(SwapRouter02, 0)
//
// `w` is the Safe's whole WMON balance and `m` the full sale's QuoterV2 quote less MONAD_SELL_SLIPPAGE_BPS. The owner path
// is not under the action policy, so the price is guarded here instead (monadSellPrice): by the operator when it prepares,
// and again by the Worker from its own reads before the owner signs.

/** The chain step A0 exists on. */
export const MONAD_SELL_CHAIN_ID = 143
/** The growth pool every design-C Safe on Monad holds: the only pool the sale goes through. */
export const MONAD_SELL_POOL = 'pool:WMON/USDC/3000'
/** The token sold. */
export const MONAD_SELL_TOKEN = 'WMON'
/** `amountOutMinimum` is the quote less this (fees and impact are in the quote). */
export const MONAD_SELL_SLIPPAGE_BPS = 30n
/** The quote may be at most this far under what the WMON is worth at the pool's TWAP; further, the pool is too shallow to sell into. */
export const MONAD_SELL_MAX_UNDER_TWAP_BPS = 300n
/** The TWAP window the sale is judged at: the Monad policy's own. */
export const MONAD_SELL_TWAP_WINDOW_SECONDS = liveWmonUsdcMonadV6.execution.twapWindowSeconds

/** The least a sale quoted at `quote` may return: the quote less MONAD_SELL_SLIPPAGE_BPS. */
export function monadSellMinOut(quote: bigint): bigint {
  return (quote * (10_000n - MONAD_SELL_SLIPPAGE_BPS)) / 10_000n
}

/** What `amountIn` of WMON is worth in USDC at the growth pool's TWAP tick, before any fee. */
export function monadSellTwapValue(amountIn: bigint, twapTick: number, registry: Registry): bigint {
  const pool = entry(MONAD_SELL_POOL, registry)
  const sqrt = sqrtRatioAtTick(twapTick)
  return pool.token0 === MONAD_SELL_TOKEN ? token0InToken1(amountIn, sqrt) : token1InToken0(amountIn, sqrt)
}

/**
 * Why a sale of `amountIn` WMON with minimum `amountOutMinimum` may not be signed against `quote` (QuoterV2's answer for the
 * whole `amountIn`) and `twapTick` (the growth pool's TWAP over MONAD_SELL_TWAP_WINDOW_SECONDS), or null:
 * - `MONAD_DEPTH_TOO_LOW`: the quote is more than MONAD_SELL_MAX_UNDER_TWAP_BPS under the TWAP value, or nothing;
 * - `MIN_OUT_TOO_LOW`: the minimum is more than MONAD_SELL_SLIPPAGE_BPS under the quote.
 * Both the operator (at prepare) and the Worker (from its own reads) judge with this.
 */
export function monadSellPrice(p: { amountIn: bigint; amountOutMinimum: bigint; quote: bigint; twapTick: number }, registry: Registry): 'MONAD_DEPTH_TOO_LOW' | 'MIN_OUT_TOO_LOW' | null {
  const worth = monadSellTwapValue(p.amountIn, p.twapTick, registry)
  if (p.quote <= 0n || worth <= 0n || p.quote * 10_000n < worth * (10_000n - MONAD_SELL_MAX_UNDER_TWAP_BPS)) return 'MONAD_DEPTH_TOO_LOW'
  if (p.amountOutMinimum <= 0n || p.amountOutMinimum < monadSellMinOut(p.quote)) return 'MIN_OUT_TOO_LOW'
  return null
}

/** The calls of step A0, in order. Throws on any input the operator would not prepare. */
export function monadSellCalls(input: MonadSellInput, registry: Registry): { to: Address; value: bigint; data: Hex }[] {
  if (registry.chainId !== input.chainId) throw new Error(`buildMonadSell: registry of chain ${registry.chainId}, input on ${input.chainId}`)
  if (input.chainId !== MONAD_SELL_CHAIN_ID) throw new Error('buildMonadSell: the sale exists on Monad only')
  const amountIn = dec(input.amountIn, 'amountIn')
  const amountOutMinimum = dec(input.amountOutMinimum, 'amountOutMinimum')
  if (amountIn === 0n) throw new Error('buildMonadSell: nothing to sell')
  if (amountOutMinimum === 0n) throw new Error('buildMonadSell: a sale without a minimum is never built')
  const safe = getAddress(input.safe)
  if (BigInt(safe) === 0n) throw new Error('buildMonadSell: no Safe')
  return swapBackCalls(safe, [{ token: MONAD_SELL_TOKEN, pool: MONAD_SELL_POOL, amountIn, amountOutMinimum }], registry).map((c) => ({ to: c.to as Address, value: c.value, data: c.data as Hex }))
}

/** Step A0's Safe transaction and its hash (the passkey's challenge). No refund: Mamoru pays. */
export function buildMonadSell(input: MonadSellInput, registry: Registry): { safeTx: WireSafeTx; safeTxHash: Hex; calls: { to: Address; value: bigint; data: Hex }[] } {
  const calls = monadSellCalls(input, registry)
  const nonce = dec(input.safeNonce, 'safeNonce')
  const tx = ownerSafeTx(calls, nonce, registry)
  const safeTx: WireSafeTx = { to: tx.to, value: '0', data: tx.data, operation: tx.operation as 0 | 1, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: nonce.toString() }
  const safeTxHash = hashTypedData(safeTxTypedData(getAddress(input.safe), input.chainId, tx))
  return { safeTx, safeTxHash, calls }
}
