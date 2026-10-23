import type { PolicyVersion } from '@mamoru/policy'
import { rangeAround, sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import type { Observation, PeerPositionObs, PoolObs } from '../types.ts'
import { amountsForLiquidity, inSavings } from '../value.ts'

const Q96 = 1n << 96n
/** Reference liquidity for the value of a range: large enough that integer division keeps the precision. */
const REF_L = 10n ** 24n

export type Depth = {
  /** Most the account's positions in this pool may be worth, in raw savings units, at `maxShareBps` of active liquidity. */
  shareRoom: bigint
  /** Most savings one entry swap may sell into the pool at `maxImpactBps`, in raw savings units. */
  swapRoom: bigint
  /** Most of the volatile token one swap may sell back into the pool at `maxImpactBps`, in raw units of that token. */
  sellRoom: bigint
}

/** Value in the savings asset of `REF_L` liquidity in a fresh range of the policy width around the tick, at the pool price. */
function refValue(pool: PoolObs, width: number, savings: string): bigint {
  const r = rangeAround(pool.tick, width, pool.tickSpacing)
  const a = amountsForLiquidity(pool.sqrtPriceX96, r.tickLower, r.tickUpper, REF_L)
  return inSavings(pool, pool.token0, a.amount0, savings) + inSavings(pool, pool.token1, a.amount1, savings)
}

/**
 * otto/mamoru#127. What a pool can take from this account at the observed block, from its in-range liquidity only
 * (no tick data is read), at the TWAP price and with the smaller of the active and the window's mean liquidity. Both limits are conservative near the tick and
 * do not see liquidity beyond it:
 * - share: the account's liquidity in the pool stays at or under `maxShareBps` of the pool's active liquidity, so
 *   Mamoru never becomes most of the market it trades in (and can always exit into it);
 * - impact: a swap is sized to half of `maxImpactBps` of average execution impact against constant liquidity, the
 *   pool fee aside (the other half is headroom until inclusion). Selling Δ of token1 moves √P by Δ/L; of token0, √P
 *   to L·√P/(L + Δ·√P). Both linearised: Δ1 = b·L·√P, Δ0 = b·L/√P with b the allowed impact as a fraction. It does
 *   not see thinner liquidity past the current tick range; the engine checks the real quote before sending
 *   (EHG_SWAP_IMPACT_OVER_LIMIT).
 */
export function depthOf(obs: Observation, policy: PolicyVersion, pool: PoolObs, width: number): Depth | null {
  const d = policy.depth
  if (!d) return null
  const none = { shareRoom: 0n, swapRoom: 0n, sellRoom: 0n }
  // Manipulation: slot0 and the active liquidity can be moved inside the block we read. Everything here is read at
  // the TWAP and with the smaller of the active and the window's harmonic-mean liquidity; without either, no room.
  if (pool.twapTick === null || pool.twapLiquidity === undefined || pool.twapLiquidity === null) return none
  const tick = pool.twapTick
  const sqrtP = sqrtRatioAtTick(tick)
  const L = pool.liquidity < pool.twapLiquidity ? pool.liquidity : pool.twapLiquidity
  if (L === 0n) return none
  const at = { ...pool, tick, sqrtPriceX96: sqrtP }
  const savings = policy.savingsAsset
  // otto/mamoru#184: the limit is Mamoru's share of the pool, not one account's: every other account's in-range
  // liquidity counts too. Unknown until the operator has seen every account (null): no share room until then, while
  // the swap and sell rooms (exits, the depeg guard) do not depend on it.
  const inPool = (p: PeerPositionObs) => p.pool === pool.name && tick >= p.tickLower && tick < p.tickUpper
  const ours = [...obs.positions, ...(obs.peerPositions ?? [])].filter(inPool).reduce((s, p) => s + p.liquidity, 0n)
  const maxL = (L * BigInt(d.maxShareBps)) / 10_000n
  const roomL = maxL > ours ? maxL - ours : 0n
  const shareRoom = obs.peerPositions === null ? 0n : (roomL * refValue(at, width, savings)) / REF_L
  // Half of the impact budget for sizing: the other half is headroom for the price to move until inclusion. The
  // engine holds the whole budget against the TWAP when it quotes (EHG_SWAP_IMPACT_OVER_LIMIT) and in the minimum out.
  const impact = BigInt(d.maxImpactBpsByPool?.[pool.name] ?? d.maxImpactBps)
  // Selling token1 moves √P by Δ/L; selling token0 the other way, by about Δ·√P/L: the same bound, per side.
  const room1 = (impact * L * sqrtP) / (2n * 10_000n * Q96)
  const room0 = (impact * L * Q96) / (2n * 10_000n * sqrtP)
  const swapRoom = pool.token1 === savings ? room1 : room0
  const sellRoom = pool.token1 === savings ? room0 : room1
  return { shareRoom, swapRoom, sellRoom }
}

/**
 * otto/mamoru#127: the least a swap of `amountIn` may return, judged at the TWAP tick: what it buys there after the
 * pool fee, less `limitBps`. The engine refuses a quote under it and uses it as the router minimum, so a price moved
 * inside the block (or before inclusion) can never make the swap execute worse than the limit against the TWAP.
 */
export function twapFloor(amountIn: bigint, fee: number, twapTick: number, tokenInIsToken0: boolean, limitBps: number): bigint {
  const sqrt = sqrtRatioAtTick(twapTick)
  const sq = sqrt * sqrt
  const Q192 = 1n << 192n
  const afterFee = (amountIn * BigInt(1_000_000 - fee)) / 1_000_000n
  const ideal = tokenInIsToken0 ? (afterFee * sq) / Q192 : (afterFee * Q192) / sq
  return (ideal * BigInt(10_000 - limitBps)) / 10_000n
}
