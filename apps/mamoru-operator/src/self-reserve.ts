import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { SUBSIDY_MIN_USDC } from './subsidy.ts'

/**
 * The gas reserve a Safe needs to start (policy gasReserveWei + TOP_UP_MARGIN_WEI, 0.0005 ETH on the live policies)
 * is bought by the Safe itself, inside the activation the owner signs (otto/mamoru#15): a small USDC -> ETH swap,
 * paid to the Safe, after the grants are enabled. The relayer then only pays the deploy and the execTransaction gas,
 * which are spent on chain and leave the owner nothing to take away. The relayer's subsidy (subsidy.ts, #82) stays
 * for the starts that cannot buy their own reserve in the batch: an approval signed before any USDC arrived, an
 * account under SELF_RESERVE_MIN_USDC, no quote or no TWAP, a spot price away from the TWAP, or a reserve that
 * would cost more than SELF_RESERVE_MAX_USDC.
 *
 * Priced against the pool's 30-minute TWAP, not the spot alone: the USDC spent is the TWAP-fair cost of the reserve
 * plus SELF_RESERVE_TWAP_TOLERANCE_BPS plus the pool fee, and never more; the minimum out is the reserve the Safe
 * lacks. So what the owner can lose to price or MEV is that tolerance and fee, whatever the spot says at the
 * prepare. A spot that makes the reserve dearer than the TWAP by more than the tolerance means no swap at all.
 * The swap either fills the reserve or reverts, and the activation with it, before the relayer sends anything
 * (the preflight simulates the whole execTransaction), and never after its deadline (see reserveExpired).
 */

/** USDC (base units) the Safe must hold for the activation to buy its own reserve; smaller accounts keep #82's path. */
export const SELF_RESERVE_MIN_USDC = SUBSIDY_MIN_USDC
/** The most USDC one activation converts (3 USDC: 0.0005 ETH up to ~5,900 USD/ETH). */
export const SELF_RESERVE_MAX_USDC = 3_000_000n
/** How far the spot may make the reserve dearer than the TWAP, and the margin paid over the TWAP: 1%, ~100 ticks (the policies' maxTwapDeviationTicks). */
export const SELF_RESERVE_TWAP_TOLERANCE_BPS = 100n
/** The TWAP window (the policies' twapWindowSeconds). */
export const SELF_RESERVE_TWAP_SECONDS = 1_800
/** USDC the spot is probed with: one dollar, far from the pools' depth, so its rate scales linearly to ~1.5. */
export const SELF_RESERVE_PROBE_USDC = 1_000_000n
/**
 * How long the signed swap stays valid. An armed approval has no lifetime of its own (it ends by running or by the
 * owner), so this is the bound: an approval still waiting past it is dropped and the owner signs again.
 */
export const SELF_RESERVE_DEADLINE_SECONDS = 7n * 86_400n
/** Nothing is simulated or sent this close to the swap's deadline: a block could not include it in time. */
export const SELF_RESERVE_DEADLINE_MARGIN_SECONDS = 600n

export type SelfReserveSkip = 'FUNDED' | 'NO_DEPOSIT' | 'BELOW_MINIMUM' | 'NO_QUOTE' | 'NO_TWAP' | 'TWAP_DIVERGENCE' | 'OVER_MAX' | 'QUOTE_SHORT'
export type SelfReservePlan = { amountIn: bigint; minOut: bigint } | { skip: SelfReserveSkip }

const Q192 = 1n << 192n

/** Time-weighted tick from observe([window, 0]) cumulatives, rounded towards negative infinity like OracleLibrary. */
export function meanTick(cumulatives: readonly [bigint, bigint], windowSeconds: number): number {
  const delta = cumulatives[1] - cumulatives[0]
  const w = BigInt(windowSeconds)
  let t = delta / w
  if (delta < 0n && delta % w !== 0n) t -= 1n
  return Number(t)
}

/** USDC base units worth `wei` at `tick` of a WETH/USDC pool (`wethIsToken0`: the pool's token order), rounded up. */
export function usdcForWeiAtTick(wei: bigint, tick: number, wethIsToken0: boolean): bigint {
  const s = sqrtRatioAtTick(tick)
  const p = s * s
  // token1 per token0 = sqrtPrice^2 / 2^192.
  return wethIsToken0 ? (wei * p + Q192 - 1n) / Q192 : (wei * Q192 + p - 1n) / p
}

/**
 * Whether this activation buys its own reserve, and with what. `probeOut`: wei the spot quote gives for
 * SELF_RESERVE_PROBE_USDC (null: no quote). `fairCost`: USDC worth the missing reserve at the pool TWAP (null: the
 * pool could not answer observe). `feeBps`: the pool fee. Pure; the exact amount is quoted again by the caller.
 */
export function selfReservePlan(i: { usdc: bigint; eth: bigint; target: bigint; probeOut: bigint | null; fairCost: bigint | null; feeBps: bigint }): SelfReservePlan {
  const need = i.eth >= i.target ? 0n : i.target - i.eth
  if (need === 0n) return { skip: 'FUNDED' }
  if (i.usdc === 0n) return { skip: 'NO_DEPOSIT' }
  if (i.usdc < SELF_RESERVE_MIN_USDC) return { skip: 'BELOW_MINIMUM' }
  if (i.probeOut === null || i.probeOut <= 0n) return { skip: 'NO_QUOTE' }
  if (i.fairCost === null || i.fairCost <= 0n) return { skip: 'NO_TWAP' }
  // What the spot quote (pool fee included) asks for the reserve, against the TWAP: dearer by more than the tolerance and fee, no swap.
  const spotCost = (need * SELF_RESERVE_PROBE_USDC + i.probeOut - 1n) / i.probeOut
  const amountIn = (i.fairCost * (10_000n + SELF_RESERVE_TWAP_TOLERANCE_BPS + i.feeBps)) / 10_000n
  if (spotCost > amountIn) return { skip: 'TWAP_DIVERGENCE' }
  if (amountIn > SELF_RESERVE_MAX_USDC) return { skip: 'OVER_MAX' }
  return { amountIn, minOut: need }
}

/** The quote for exactly `amountIn` must give at least the minimum, or the swap would revert: no swap. */
export function selfReserveConfirmed(minOut: bigint, quoted: bigint): boolean {
  return quoted >= minOut
}

/** Whether a swap with this deadline can no longer be simulated or sent: within the margin of it, or past it. */
export function reserveExpired(deadline: bigint, nowSeconds: bigint): boolean {
  return nowSeconds + SELF_RESERVE_DEADLINE_MARGIN_SECONDS >= deadline
}
