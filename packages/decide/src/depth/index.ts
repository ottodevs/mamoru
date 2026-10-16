import type { PolicyVersion } from '@mamoru/policy'
import { rangeAround } from '@mamoru/uniswap-v3/quote'
import type { Observation, PoolObs } from '../types.ts'
import { amountsForLiquidity, inSavings } from '../value.ts'

const Q96 = 1n << 96n
/** Reference liquidity for the value of a range: large enough that integer division keeps the precision. */
const REF_L = 10n ** 24n

export type Depth = {
  /** Most the account's positions in this pool may be worth, in raw savings units, at `maxShareBps` of active liquidity. */
  shareRoom: bigint
  /** Most savings one entry swap may sell into the pool at `maxImpactBps`, in raw savings units. */
  swapRoom: bigint
}

/** Value in the savings asset of `REF_L` liquidity in a fresh range of the policy width around the tick, at the pool price. */
function refValue(pool: PoolObs, width: number, savings: string): bigint {
  const r = rangeAround(pool.tick, width, pool.tickSpacing)
  const a = amountsForLiquidity(pool.sqrtPriceX96, r.tickLower, r.tickUpper, REF_L)
  return inSavings(pool, pool.token0, a.amount0, savings) + inSavings(pool, pool.token1, a.amount1, savings)
}

/**
 * otto/mamoru#127. What a pool can take from this account at the observed block, from its active liquidity only
 * (the liquidity of the current tick range; no tick data is read). Both limits are conservative near the tick and
 * do not see liquidity beyond it:
 * - share: the account's liquidity in the pool stays at or under `maxShareBps` of the pool's active liquidity, so
 *   Mamoru never becomes most of the market it trades in (and can always exit into it);
 * - impact: an entry swap of savings moves the price by at most twice `maxImpactBps`, which is an average execution
 *   impact of `maxImpactBps` against constant liquidity. Selling Δ of token1 moves √P by Δ/L; of token0, √P to
 *   L·√P/(L + Δ·√P). Both linearised: Δ1 = b·L·√P, Δ0 = b·L/√P with b the allowed impact as a fraction.
 */
export function depthOf(obs: Observation, policy: PolicyVersion, pool: PoolObs, width: number): Depth | null {
  const d = policy.depth
  if (!d) return null
  const savings = policy.savingsAsset
  const ours = obs.positions.filter((p) => p.pool === pool.name && pool.tick >= p.tickLower && pool.tick < p.tickUpper).reduce((s, p) => s + p.liquidity, 0n)
  const maxL = (pool.liquidity * BigInt(d.maxShareBps)) / 10_000n
  const roomL = maxL > ours ? maxL - ours : 0n
  const shareRoom = (roomL * refValue(pool, width, savings)) / REF_L
  const impact = BigInt(d.maxImpactBpsByPool?.[pool.name] ?? d.maxImpactBps)
  const swapRoom = pool.token1 === savings ? (impact * pool.liquidity * pool.sqrtPriceX96) / (10_000n * Q96) : (impact * pool.liquidity * Q96) / (10_000n * pool.sqrtPriceX96)
  return { shareRoom, swapRoom }
}
