// Lab (#101 round 3, research note experiment 3): staged exits of a volatile bucket on a fall from its high. Pure;
// read only by a policy with `stagedExit`. Prices are "up ticks": the tick of the volatile token's price in the
// savings asset (the pool tick, negated when the volatile token is token1), so a higher number is a dearer token.
import type { StagedExit } from '@mamoru/policy'

const WEEK = 7 * 86_400

/**
 * What the engine keeps per bucket. `sold`: up tick at which each third was sold, in order; `rebought`: how many of
 * them came back by the ladder; `anchor`: time of the last re-entry (or the first review), with `anchorHigh` the high
 * since then; `belowEma`: the TWAP was under its EMA at some review since the first third was sold.
 */
export type StageState = { sold: number[]; rebought: number; anchor: number; anchorHigh: number; belowEma: boolean }

/** Thirds a bucket holds out now. */
export function thirdsOut(s: StageState): number {
  return s.sold.length - s.rebought
}

/** Fall in bps from `high` to `now`, both up ticks (0 when not under it). */
export function fallFromBps(high: number, now: number): number {
  return now >= high ? 0 : Math.round((1 - 1.0001 ** (now - high)) * 10_000)
}

/** Up ticks `bps` below `upTick` (a price that much lower). */
function below(upTick: number, bps: number): number {
  return upTick + Math.log(1 - bps / 10_000) / Math.log(1.0001)
}

export type StageInput = {
  now: number
  /** TWAP of the pool, as an up tick. */
  price: number
  /** Highest TWAP up tick of the last 7 days (what history there is). */
  high7d: number
  /** 7-day EMA of the TWAP, as an up tick; null before a day of history. */
  ema: number | null
}

/**
 * One review of a bucket. Steps fire in order (a gap can fire several at once); a third sold by the ladder's buy-back
 * is not sold again until the next re-anchor. The high is the 7-day high, or the high since the last re-entry when
 * that is more recent, so a re-entry does not sell again at once against the old high.
 */
export function stageStep(prev: StageState | undefined, x: StageInput, rule: StagedExit): StageState {
  const s: StageState = prev ? { ...prev, sold: [...prev.sold] } : { sold: [], rebought: 0, anchor: x.now, anchorHigh: x.price, belowEma: false }
  s.anchorHigh = Math.max(s.anchorHigh, x.price)
  const high = x.now - s.anchor < WEEK ? s.anchorHigh : x.high7d
  const fall = fallFromBps(high, x.price)
  const reset = (): StageState => ({ sold: [], rebought: 0, anchor: x.now, anchorHigh: x.price, belowEma: false })
  if (s.sold.length > 0) {
    if (rule.reentry === 'ema') {
      if (x.ema !== null && s.belowEma && x.price > x.ema) return reset()
    } else {
      if (fall < rule.step1Bps) return reset()
      while (s.rebought < s.sold.length && x.price <= below(s.sold[s.rebought]!, rule.ladderGapBps)) s.rebought++
    }
  }
  // A step fires once per anchor; after the ladder bought a third back, that third waits for the re-anchor.
  if (s.rebought === 0) {
    const steps = [rule.step1Bps, rule.step2Bps, rule.step3Bps]
    while (s.sold.length < 3 && fall >= steps[s.sold.length]!) s.sold.push(x.price)
  }
  // The EMA re-entry needs the TWAP under its EMA once a third is out, this review included.
  if (s.sold.length > 0 && x.ema !== null && x.price < x.ema) s.belowEma = true
  return s
}
