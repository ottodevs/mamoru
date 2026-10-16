import type { PolicyVersion } from '@mamoru/policy'
import type { RegistryName } from '@mamoru/registry'
import type { GuardNote, Observation, PoolObs } from '../types.ts'
import { volatileOf } from '../value.ts'

const DAY = 86_400
const YEAR = 365 * DAY
const LN_TICK = Math.log(1.0001)

/** One `observe` cumulative of a pool at a time. */
export type CumulativePoint = { time: number; tickCumulative: bigint }

/**
 * Spec 004, `Observation.guard` per pool, from TWAP samples only (FR-LC-002):
 * - `twap24hAgoTick`: the mean tick of the `windowSeconds` that ended 24 h before `now`;
 * - `realizedVol24hBps`: annualized realized volatility of the consecutive `windowSeconds` mean ticks over the last
 *   24 h, in basis points (8000 = 80%).
 * `cumulativeAt(t)` answers the pool's tick cumulative at time `t`, or null when it cannot. Any missing point makes
 * both null: the rule abstains (`RISK_DATA_INSUFFICIENT`), it never acts on part of the history. So does a window that
 * does not divide 24 h: the windows would cover less than a day.
 */
export function marketOf(now: number, windowSeconds: number, cumulativeAt: (t: number) => CumulativePoint | null): { twap24hAgoTick: number | null; realizedVol24hBps: number | null } {
  const none = { twap24hAgoTick: null, realizedVol24hBps: null }
  if (windowSeconds <= 0 || DAY % windowSeconds !== 0) return none
  const segments = DAY / windowSeconds
  if (segments < 2) return none
  const points: CumulativePoint[] = []
  for (let m = segments + 1; m >= 0; m--) {
    const p = cumulativeAt(now - m * windowSeconds)
    if (!p) return none
    points.push(p)
  }
  // means[0] is the window that ended 24 h ago; the rest cover the 24 h since.
  const means: number[] = []
  for (let k = 1; k < points.length; k++) {
    const secs = points[k]!.time - points[k - 1]!.time
    if (secs <= 0) return none
    means.push(Number(points[k]!.tickCumulative - points[k - 1]!.tickCumulative) / secs)
  }
  let sum = 0
  for (let k = 1; k < means.length; k++) sum += ((means[k]! - means[k - 1]!) * LN_TICK) ** 2
  const vol = Math.sqrt((sum / (means.length - 1)) * (YEAR / windowSeconds))
  return { twap24hAgoTick: Math.floor(means[0]!), realizedVol24hBps: Math.round(vol * 10_000) }
}

/** Fall of the volatile token's price in the savings asset from `fromTick` to `toTick`, in bps (negative: it rose). */
export function fallBpsOf(pool: PoolObs, savings: RegistryName, fromTick: number, toTick: number): number {
  // The tick prices token0 in token1: the volatile token falls with the tick when it is token0, rises when token1.
  const d = volatileOf(pool, savings) === pool.token0 ? toTick - fromTick : fromTick - toTick
  return Math.round((1 - 1.0001 ** d) * 10_000)
}

/**
 * Spec 004 (#101), FREEZE on a fall: one note per guarded bucket whose pool is observed. `DECIDE_ENTRY_PAUSED_FALL`
 * when the 24 h TWAP fall and the 24 h volatility are both at or over the bucket's thresholds: the bucket gets no
 * entry or top-up this review. `RISK_DATA_INSUFFICIENT` when history is missing: the rule abstains, entries go.
 * No note: the condition is clear.
 */
export function fallFreezeOf(obs: Observation, policy: PolicyVersion): GuardNote[] {
  const notes: GuardNote[] = []
  for (const b of policy.buckets) {
    const rule = policy.guards?.byBucket[b.id]?.fallFreeze
    const pool = rule && b.pools[0] ? obs.pools.find((x) => x.name === b.pools[0]) : undefined
    if (!rule || !pool) continue
    const threshold = { fallBps: rule.fallBps, volBps: rule.volBps }
    const m = obs.guard?.pools[pool.name]
    if (!m || m.twap24hAgoTick === null || m.realizedVol24hBps === null || pool.twapTick === null) {
      notes.push({ bucket: b.id, pool: pool.name, code: 'RISK_DATA_INSUFFICIENT', metric: null, threshold })
      continue
    }
    const metric = { fallBps: fallBpsOf(pool, policy.savingsAsset, m.twap24hAgoTick, pool.twapTick), volBps: m.realizedVol24hBps }
    if (metric.fallBps >= rule.fallBps && metric.volBps >= rule.volBps) notes.push({ bucket: b.id, pool: pool.name, code: 'DECIDE_ENTRY_PAUSED_FALL', metric, threshold })
  }
  return notes
}
