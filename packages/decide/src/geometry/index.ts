// Lab (#101, range geometry): where a new range sits around the price, and how wide it is. Pure: reads the policy's
// `geometry` and the observation's `geometry` history only. Without `policy.geometry` every function here gives the
// centred range of the policy width, as before.
import type { PolicyVersion, SkewRule, VolWidthRule } from '@mamoru/policy'
import { rangeAround } from '@mamoru/uniswap-v3/quote'
import { fallBpsOf } from '../guard/index.ts'
import type { Observation, PoolGeometryObs, PoolObs } from '../types.ts'
import type { CumulativePoint } from '../guard/index.ts'
import { volatileOf } from '../value.ts'

const YEAR = 365 * 86_400
const LN_TICK = Math.log(1.0001)

export type Regime = 'fall' | 'rally' | 'flat'

/** The policy width of a pool: its `widthTicksByPool` entry, else `range.widthTicks`. */
export function widthOf(policy: PolicyVersion, pool: string): number {
  return policy.range.widthTicksByPool?.[pool] ?? policy.range.widthTicks
}

/** A pool with its own width (the stables pool) keeps the policy geometry: no skew, no volatility width. */
function fixed(policy: PolicyVersion, pool: string): boolean {
  return policy.range.widthTicksByPool?.[pool] !== undefined
}

function historyOf(obs: Observation, pool: PoolObs): PoolGeometryObs | null {
  return obs.geometry?.pools[pool.name] ?? null
}

/**
 * The regime the skew rule reads, in the volatile token's price: `fall`, `rally` or `flat`. Null when the policy has
 * no skew rule, the pool keeps a fixed width, or history is missing.
 */
export function regimeOf(obs: Observation, policy: PolicyVersion, pool: PoolObs, rule: SkewRule | undefined = policy.geometry?.skew): Regime | null {
  if (!rule || fixed(policy, pool.name) || pool.twapTick === null) return null
  const m = historyOf(obs, pool)
  if (!m) return null
  if (rule.regime === 'ret24h') {
    if (m.twap24hAgoTick === null) return null
    const fall = fallBpsOf(pool, policy.savingsAsset, m.twap24hAgoTick, pool.twapTick)
    return fall >= rule.fallBps ? 'fall' : -fall >= rule.fallBps ? 'rally' : 'flat'
  }
  if (m.emaTick === null) return null
  const under = fallBpsOf(pool, policy.savingsAsset, m.emaTick, pool.twapTick)
  return under > 0 ? 'fall' : under < 0 ? 'rally' : 'flat'
}

/** 1 h volatility over `earlyRatio` times the 7-day one. */
export function spiking(m: PoolGeometryObs | null, rule: VolWidthRule): boolean {
  if (!m || rule.earlyRatio <= 0 || m.vol1hBps === null || m.vol7dBps === null || m.vol7dBps <= 0) return false
  return m.vol1hBps > rule.earlyRatio * m.vol7dBps
}

/** Width in ticks of `k * sigma * sqrt(H)`, sigma annualized in bps, clamped to the rule's bounds. */
export function volWidthTicks(rule: VolWidthRule, sigmaBps: number): number {
  const ticks = (rule.k * (sigmaBps / 10_000) * Math.sqrt(rule.horizonSeconds / YEAR)) / LN_TICK
  return Math.min(rule.maxTicks, Math.max(rule.minTicks, Math.round(ticks)))
}

/** Width of a new range in `pool`: the volatility width when the rule applies and history exists, else the policy's. */
export function widthFor(obs: Observation, policy: PolicyVersion, pool: PoolObs): number {
  const base = widthOf(policy, pool.name)
  const rule = policy.geometry?.volWidth
  if (!rule || fixed(policy, pool.name)) return base
  const m = historyOf(obs, pool)
  if (!m || m.vol24hBps === null) return base
  const sigma = spiking(m, rule) && m.vol1hBps !== null ? Math.max(m.vol24hBps, m.vol1hBps) : m.vol24hBps
  return volWidthTicks(rule, sigma)
}

/**
 * A range of `width` ticks with `belowBps` of it under the price in the volatile token's terms. At 5000 it is
 * `rangeAround` exactly. The volatile token's price falls with the tick when it is token0, rises when token1.
 */
export function skewedRange(tick: number, width: number, spacing: number, belowBps: number, volatileIs0: boolean): { tickLower: number; tickUpper: number } {
  const half = Math.floor(width / 2 / spacing) * spacing
  const total = 2 * half
  const base = Math.floor(tick / spacing) * spacing
  const below = Math.min(total, Math.max(0, Math.round((total * belowBps) / 10_000 / spacing) * spacing))
  const lowerSide = volatileIs0 ? below : total - below
  return { tickLower: base - lowerSide, tickUpper: base + (total - lowerSide) + spacing }
}

/** Share of the width (bps) under the price, in the volatile token's terms, for a new range now. 5000: centred. */
export function belowShareOf(obs: Observation, policy: PolicyVersion, pool: PoolObs): number {
  const rule = policy.geometry?.skew
  const regime = regimeOf(obs, policy, pool, rule)
  if (!rule || regime === null) return 5_000
  if (regime === 'fall') return rule.belowShareBps
  if (regime === 'rally' && rule.mirror) return 10_000 - rule.belowShareBps
  return 5_000
}

/** The range a new mint in `pool` gets now. Without `policy.geometry`: `rangeAround(tick, policy width)`. */
export function rangeFor(obs: Observation, policy: PolicyVersion, pool: PoolObs): { tickLower: number; tickUpper: number } {
  const width = widthFor(obs, policy, pool)
  const below = belowShareOf(obs, policy, pool)
  if (below === 5_000) return rangeAround(pool.tick, width, pool.tickSpacing)
  return skewedRange(pool.tick, width, pool.tickSpacing, below, volatileOf(pool, policy.savingsAsset) === pool.token0)
}

/**
 * Near-edge share of the width (bps) on each tick side for the re-range rule. With a skew rule, a range is placed
 * with the price close to one edge on purpose: that edge's threshold is half of the short side, so the placement
 * does not trip the re-range at once. `edge` is the policy-wide threshold.
 */
export function edgeBpsOf(policy: PolicyVersion, pool: PoolObs, edge: number): { lower: number; upper: number } {
  const rule = policy.geometry?.skew
  if (!rule || fixed(policy, pool.name)) return { lower: edge, upper: edge }
  const short = Math.min(rule.belowShareBps, 10_000 - rule.belowShareBps)
  const near = Math.min(edge, Math.floor(short / 2))
  // In a fall the price sits near the edge of a higher volatile price; mirrored in a rally, near the lower one.
  const up = rule.belowShareBps > 5_000 ? near : edge
  const down = rule.mirror && rule.belowShareBps > 5_000 ? near : edge
  return volatileOf(pool, policy.savingsAsset) === pool.token0 ? { lower: down, upper: up } : { lower: up, upper: down }
}

/** Early widening: volatility spiking and the position narrower than two thirds of the width a new range would get. */
export function widenEarly(obs: Observation, policy: PolicyVersion, pool: PoolObs, width: number): boolean {
  const rule = policy.geometry?.volWidth
  if (!rule || fixed(policy, pool.name) || !spiking(historyOf(obs, pool), rule)) return false
  return width * 3 < widthFor(obs, policy, pool) * 2
}

/**
 * Annualized realized volatility (bps) of consecutive `segSeconds` TWAP means over the `lookbackSeconds` that end at
 * `now`, from pool tick cumulatives (`cumulativeAt(t)`: the cumulative at or before `t`, or null). A point more than
 * half a segment before the time asked is missing; a segment with a missing end is skipped. Null when fewer than
 * `minCoverage` of the returns (and fewer than two) could be measured: the rule abstains on thin history.
 */
export function realizedVolOf(now: number, lookbackSeconds: number, segSeconds: number, cumulativeAt: (t: number) => CumulativePoint | null, minCoverage = 0.8): number | null {
  const n = Math.floor(lookbackSeconds / segSeconds)
  if (segSeconds <= 0 || n < 3) return null
  const points: (CumulativePoint | null)[] = []
  for (let m = n; m >= 0; m--) {
    const at = now - m * segSeconds
    const p = cumulativeAt(at)
    points.push(p && p.time <= at && at - p.time < segSeconds / 2 ? p : null)
  }
  const means: (number | null)[] = []
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]
    const b = points[k]
    const secs = a && b ? b.time - a.time : 0
    means.push(a && b && secs > 0 ? Number(b.tickCumulative - a.tickCumulative) / secs : null)
  }
  let sum = 0
  let count = 0
  for (let k = 1; k < means.length; k++) {
    const a = means[k - 1]
    const b = means[k]
    if (a === null || b === null || a === undefined || b === undefined) continue
    sum += ((b - a) * LN_TICK) ** 2
    count++
  }
  if (count < 2 || count < minCoverage * (means.length - 1)) return null
  return Math.round(Math.sqrt((sum / count) * (YEAR / segSeconds)) * 10_000)
}

/** Mean tick over the `windowSeconds` that end at `t`, rounded toward negative infinity; null when either end is missing. */
export function meanTickAt(t: number, windowSeconds: number, cumulativeAt: (t: number) => CumulativePoint | null): number | null {
  const a = cumulativeAt(t - windowSeconds)
  const b = cumulativeAt(t)
  if (!a || !b || b.time <= a.time || t - b.time >= windowSeconds / 2 || t - windowSeconds - a.time >= windowSeconds / 2) return null
  return Math.floor(Number(b.tickCumulative - a.tickCumulative) / (b.time - a.time))
}
