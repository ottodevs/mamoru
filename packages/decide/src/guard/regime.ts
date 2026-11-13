// Lab (otto/mamoru#409): regime of the `risk` bucket's pool for `policy.regimeShift`. Pure; read only by a policy with
// `regimeShift`. Prices are "up ticks": the tick of the volatile token's price in the savings asset (the pool tick,
// negated when the volatile token is token1), so a higher number is a dearer token.
import type { RegimeShift } from '@mamoru/policy'
import { fallFromBps } from '../rebalance/staged.ts'

/** The bucket whose preference the rule lowers. */
export const REGIME_BUCKET = 'risk'

/**
 * What the engine keeps (and would persist) per account: the state, when it last changed, and while defensive the
 * lowest TWAP seen since entry with its time. Four numbers and a flag; a restart that loses them starts normal.
 */
export type RegimeState = { defensive: boolean; since: number; low: number; lowAt: number }

export const REGIME_NORMAL: RegimeState = { defensive: false, since: 0, low: 0, lowAt: 0 }

/** One review's market figures, all from TWAP history (the pool's oracle cumulatives or the engine's snapshots). */
export type RegimeInput = {
  now: number
  /** TWAP up tick now. */
  price: number
  /** TWAP up tick 24 h ago; null without that history. */
  ago24h: number | null
  /** TWAP up tick 7 days ago, or at the start of the history there is (at least 24 h); null with less. */
  ago7d: number | null
  /** Mean up tick over the last 7 days, or the history there is (at least 24 h); null with less. */
  mean7d: number | null
}

/**
 * One review. Entry needs both falls (or the 24 h fall and the gap under the 7-day mean); exit needs a recovery over the
 * 7-day mean or a quiet spell with no new low. Neither may happen within `minDwellSeconds` of the last change, so the
 * state cannot flap from one review to the next. Missing history never enters; while defensive it only lets the
 * no-new-low exit run.
 */
export function regimeStep(prev: RegimeState | undefined, x: RegimeInput, rule: RegimeShift): RegimeState {
  const s = prev ?? REGIME_NORMAL
  if (!s.defensive) {
    if (prev && x.now - s.since < rule.minDwellSeconds) return s
    const fell24h = x.ago24h !== null && fallFromBps(x.ago24h, x.price) >= rule.fall24hBps
    const trend = rule.belowMeanBps > 0 ? x.mean7d !== null && fallFromBps(x.mean7d, x.price) >= rule.belowMeanBps : x.ago7d !== null && fallFromBps(x.ago7d, x.price) >= rule.fall7dBps
    return fell24h && trend ? { defensive: true, since: x.now, low: x.price, lowAt: x.now } : s
  }
  const next = x.price < s.low ? { ...s, low: x.price, lowAt: x.now } : s
  if (x.now - s.since < rule.minDwellSeconds) return next
  const recovered = rule.exitOnMean && x.mean7d !== null && x.price > x.mean7d
  const quiet = x.now - next.lowAt >= rule.exitNoLowSeconds
  return recovered || quiet ? { defensive: false, since: x.now, low: 0, lowAt: 0 } : next
}

/** The preference a bucket takes under the rule: `defensivePreference` (never above its own) while defensive. */
export function regimePreference(bucket: string, preference: number, defensive: boolean | undefined, rule: RegimeShift | undefined): number {
  if (!rule || bucket !== REGIME_BUCKET || defensive !== true) return preference
  return Math.min(preference, Math.max(0, Math.floor(rule.defensivePreference)))
}
