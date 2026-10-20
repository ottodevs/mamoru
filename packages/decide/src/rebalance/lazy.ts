// Lab (#101, experiment 4): is a re-range worth what it costs? Pure; read only by a policy with `range.lazy`.
import type { LazyRerange, PolicyVersion } from '@mamoru/policy'
import { rangeAround } from '@mamoru/uniswap-v3/quote'
import { widthOf } from '../allocate/index.ts'
import type { Observation, PoolObs, PositionObs } from '../types.ts'
import { amountsForLiquidity, inSavings, opCostInSavings } from '../value.ts'

const YEAR = 365 * 86_400
const Q96 = 2 ** 96
/** A re-range is three operations: the close, the ratio convert and the mint. */
export const RERANGE_OPS = 3n

export type RerangeWorth = { fees: bigint; gas: bigint; swap: bigint; lvr: bigint; worth: boolean }

/**
 * otto/mamoru#172 (peer review, round 5): live, an estimate whose fees over the horizon mean more than this annual
 * rate on the position's value is no estimate (the lazy rule holds): it can only come from a bad fee point (a saved
 * one below the real counter adds days or months of fees to "the last 24 h"). 20,000% a year: 5x the highest rate
 * measured on the Lab datasets (Aug 2024 to Oct 2026, the three live pools, a centred range of the policy width,
 * undiluted, 24 h fee growth): WETH/USDC 0.3% 4,003% (6 Feb 2026), USDC/USDT 3,894%, USDC/cbBTC 1,302%; medians
 * 61%, 1% and 25%. Lab variants (no `requireCostEstimate`) are not bounded, so their measured results do not move.
 */
export const MAX_FEE_APR_BPS = 2_000_000n

/**
 * What a new centred range of the position's value would earn over `lazy.horizonSeconds`, against what moving there
 * costs (see `LazyRerange`). Null when the pool's fee growth or volatility history is missing: the test abstains.
 */
export function rerangeWorth(obs: Observation, policy: PolicyVersion, p: PositionObs, pool: PoolObs, lazy: LazyRerange): RerangeWorth | null {
  const m = obs.guard?.pools[pool.name]
  const g = m?.feeGrowth24h
  const vol = m?.realizedVol24hBps ?? null
  if (!g || g.seconds <= 0 || vol === null) return null
  const savings = policy.savingsAsset
  const held = amountsForLiquidity(pool.sqrtPriceX96, p.tickLower, p.tickUpper, p.liquidity)
  const value = inSavings(pool, pool.token0, held.amount0 + p.collectable0, savings) + inSavings(pool, pool.token1, held.amount1 + p.collectable1, savings)
  if (value === 0n) return null
  const range = rangeAround(pool.tick, widthOf(policy, pool.name), pool.tickSpacing)
  const UNIT = 10n ** 24n
  const u = amountsForLiquidity(pool.sqrtPriceX96, range.tickLower, range.tickUpper, UNIT)
  const unitValue = inSavings(pool, pool.token0, u.amount0, savings) + inSavings(pool, pool.token1, u.amount1, savings)
  if (unitValue === 0n) return null
  const L = (value * UNIT) / unitValue
  // The new position's share of the fees: its liquidity over the active liquidity plus itself, as the simulator credits it.
  const twapL = pool.twapLiquidity ?? pool.liquidity
  const active = twapL < pool.liquidity ? twapL : pool.liquidity
  const H = BigInt(lazy.horizonSeconds)
  const S = BigInt(g.seconds)
  const earn = (growth: bigint) => (active + L === 0n ? 0n : (L * growth * H * active) / ((active + L) * S) >> 128n)
  const fees = inSavings(pool, pool.token0, earn(g.growth0X128), savings) + inSavings(pool, pool.token1, earn(g.growth1X128), savings)
  const gas = opCostInSavings(obs, savings) * RERANGE_OPS
  // The ratio convert swaps about half of the value back, paying the pool fee on it.
  const swap = (value * BigInt(pool.fee)) / 2n / 1_000_000n
  // LVR of a concentrated range in range: sigma^2 / 4 * L * sqrt(P) per year, in token1 (Milionis et al.).
  const sigma = vol / 10_000
  const lvr1 = ((sigma * sigma) / 4) * Number(L) * (Number(pool.sqrtPriceX96) / Q96) * (lazy.horizonSeconds / YEAR) * (lazy.lvrWeightBps / 10_000)
  const lvr = inSavings(pool, pool.token1, BigInt(Math.floor(lvr1)), savings)
  if (lazy.requireCostEstimate && fees * BigInt(YEAR) * 10_000n > value * H * MAX_FEE_APR_BPS) return null
  return { fees, gas, swap, lvr, worth: fees > gas + swap + lvr }
}

/**
 * otto/mamoru#172: `PositionObs.outOfRangeSince` for the live engine, as the Lab simulator keeps it
 * (`packages/backtest/src/run.ts`): the block time of the first review that saw the pool tick outside the range,
 * cleared at the first review that sees it back inside. Returns the next map (tokenId to that time); positions
 * the observation no longer has, or without liquidity, drop out. The clock starts at the engine's first review: an
 * engine that just started (a restart, a session that came back after days) never counts time it did not see, so
 * its dwell is never shorter than the real one.
 */
export function outOfRangeSinceOf(prev: ReadonlyMap<bigint, bigint>, obs: Observation): Map<bigint, bigint> {
  const next = new Map<bigint, bigint>()
  for (const p of obs.positions) {
    const pool = p.pool ? obs.pools.find((x) => x.name === p.pool) : undefined
    if (!pool || p.liquidity === 0n) continue
    if (pool.tick >= p.tickLower && pool.tick < p.tickUpper) continue
    next.set(p.tokenId, prev.get(p.tokenId) ?? obs.block.timestamp)
  }
  return next
}

/** The observation with each position's `outOfRangeSince` from `since` (null when it is in range). */
export function withOutOfRangeSince(obs: Observation, since: ReadonlyMap<bigint, bigint>): Observation {
  return { ...obs, positions: obs.positions.map((p) => ({ ...p, outOfRangeSince: since.get(p.tokenId) ?? null })) }
}
