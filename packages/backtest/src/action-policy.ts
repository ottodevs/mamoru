// Spec 007 (otto/mamoru#151), task T5: Lab measurement of MamoruActionPolicy's bands and budgets against the
// Lab's 2024-2026 history. Pure analysis over an already-decoded `Dataset` (bands) and an already-run
// `RunResult.ops` (exit waits, budgets); no chain calls, no change to `decide` or session enforcement. The band
// and budget checks are not wired into the backtest's own refusal logic (that is T4's precheck, engine-side) — this
// module answers "how often would the policy have refused, on the market and turnover the Lab already recorded",
// not "replay the run with the policy enforced".
import { twapTick } from './observe.ts'
import type { Dataset, OpEntry } from './types.ts'
import type { RegistryName } from '@mamoru/registry'

/** Ticks the spot sits from the pool's own TWAP at sample `i`; null where the pool was not read at that sample. */
export function spotTwapDeviation(ds: Dataset, poolIndex: number, i: number, windowSeconds: number): number | null {
  const ps = ds.samples[i]!.pools[poolIndex]
  if (!ps) return null
  return ps.tick - twapTick(ds, poolIndex, i, windowSeconds)
}

/** One run of consecutive breached samples: `seconds` is the time between its first and last breach sample. */
export type Episode = { start: number; end: number; seconds: number; peakDeviation: number }

export type BandScan = {
  thresholdTicks: number
  /** Samples where the pool was read. */
  samples: number
  breachSamples: number
  breachRatePct: number
  episodes: Episode[]
  totalBreachSeconds: number
  maxEpisodeSeconds: number
}

/**
 * Spec 007 "Liveness cost": every sample of `poolIndex` where `|spot - twap| > thresholdTicks`, folded into
 * episodes. A data gap longer than `windowSeconds` (the pool went unread for a full TWAP window or more) ends an
 * episode rather than bridging it: a real gap is missing history, not a long breach.
 */
export function scanBand(ds: Dataset, poolIndex: number, windowSeconds: number, thresholdTicks: number): BandScan {
  const episodes: Episode[] = []
  let cur: Episode | null = null
  let samples = 0
  let breachSamples = 0
  let prevTime: number | null = null
  for (let i = 0; i < ds.samples.length; i++) {
    const s = ds.samples[i]!
    const ps = s.pools[poolIndex]
    if (!ps) continue
    samples++
    const dev = ps.tick - twapTick(ds, poolIndex, i, windowSeconds)
    const gap = prevTime !== null && s.time - prevTime > windowSeconds
    const breached = Math.abs(dev) > thresholdTicks
    if (breached) {
      breachSamples++
      if (cur && !gap) {
        cur.end = s.time
        cur.seconds = cur.end - cur.start
        cur.peakDeviation = Math.max(cur.peakDeviation, Math.abs(dev))
      } else {
        if (cur) episodes.push(cur)
        cur = { start: s.time, end: s.time, seconds: 0, peakDeviation: Math.abs(dev) }
      }
    } else if (cur) {
      episodes.push(cur)
      cur = null
    }
    prevTime = s.time
  }
  if (cur) episodes.push(cur)
  const totalBreachSeconds = episodes.reduce((a, e) => a + e.seconds, 0)
  const maxEpisodeSeconds = episodes.reduce((a, e) => Math.max(a, e.seconds), 0)
  return { thresholdTicks, samples, breachSamples, breachRatePct: samples === 0 ? 0 : (breachSamples / samples) * 100, episodes, totalBreachSeconds, maxEpisodeSeconds }
}

export type BandGridRow = { band: number; factor: number } & BandScan

/**
 * `scanBand` over a grid of bands x factors, threshold = floor(band x factor) (same flooring direction as
 * `@mamoru/uniswap-v3/policy-bounds`'s `narrowBand`: never wider than the nominal band).
 */
export function bandGrid(ds: Dataset, poolIndex: number, windowSeconds: number, bands: readonly number[], factors: readonly number[]): BandGridRow[] {
  const out: BandGridRow[] = []
  for (const band of bands) for (const factor of factors) out.push({ band, factor, ...scanBand(ds, poolIndex, windowSeconds, Math.floor(band * factor)) })
  return out
}

const LN_TICK = Math.log(1.0001)

/** Log-price move of `token` (the pool's token0) between two samples, signed so a rise is positive — see market.ts. */
function tickMoveBps(tickA: number, tickB: number): number {
  return (Math.exp((tickB - tickA) * LN_TICK) - 1) * 10_000
}

export type ExitWait = {
  time: number
  i: number
  kind: 'rerange' | 'reduce'
  /** Ticks from the TWAP at the moment the exit was proposed; null when the pool had no read there. */
  deviationAtProposal: number | null
  /** Whether `|deviationAtProposal| > thresholdTicks`: the band would have refused this exit at that moment. */
  breached: boolean
  /** Seconds until `|spot - twap| <= thresholdTicks` again, scanning forward from the proposal; 0 when not breached. */
  waitSeconds: number
  /** False when the breach never cleared before the dataset ran out (censored: a lower bound on the true wait). */
  cleared: boolean
  /** Move of the pool's token0 price over the wait, in bps, signed (token0 falling is negative). */
  priceMoveBps: number
}

/**
 * Spec 007 "T5 Lab: ... how often exits wait": for each sample index of an exit op (`rerange`/`reduce`, already
 * executed by the backtest), whether the band would have refused it at that moment and, if so, how long until the
 * TWAP caught up (the band's own liveness cost, spec 007 "Liveness cost": "the engine loses nothing it has
 * today ... T5 measures how often and how long exits wait"). `opIndices` pairs a sample index with the op kind; both
 * must come from the exact `ds` passed here (the same window slice the backtest ran on), so indices line up.
 */
export function exitWaits(ds: Dataset, poolIndex: number, windowSeconds: number, thresholdTicks: number, ops: readonly { i: number; kind: 'rerange' | 'reduce' }[]): ExitWait[] {
  return ops.map(({ i, kind }) => {
    const s = ds.samples[i]!
    const dev = spotTwapDeviation(ds, poolIndex, i, windowSeconds)
    const breached = dev !== null && Math.abs(dev) > thresholdTicks
    if (!breached) return { time: s.time, i, kind, deviationAtProposal: dev, breached: false, waitSeconds: 0, cleared: true, priceMoveBps: 0 }
    const tickAtProposal = s.pools[poolIndex]!.tick
    let j = i
    while (j < ds.samples.length - 1) {
      j++
      const next = ds.samples[j]!
      const d = spotTwapDeviation(ds, poolIndex, j, windowSeconds)
      if (d !== null && Math.abs(d) <= thresholdTicks) {
        const tickAtClear = next.pools[poolIndex]!.tick
        return { time: s.time, i, kind, deviationAtProposal: dev, breached: true, waitSeconds: next.time - s.time, cleared: true, priceMoveBps: tickMoveBps(tickAtProposal, tickAtClear) }
      }
    }
    const last = ds.samples[ds.samples.length - 1]!
    const lastPs = last.pools[poolIndex]
    return { time: s.time, i, kind, deviationAtProposal: dev, breached: true, waitSeconds: last.time - s.time, cleared: false, priceMoveBps: lastPs ? tickMoveBps(tickAtProposal, lastPs.tick) : 0 }
  })
}

/** p50/p95/max of the wait, over breached exits only (an un-breached exit waits 0 by construction). */
export function waitStats(waits: readonly ExitWait[]): { breached: number; of: number; medianSeconds: number; p95Seconds: number; maxSeconds: number; censored: number } {
  const breached = waits.filter((w) => w.breached)
  const sorted = [...breached].map((w) => w.waitSeconds).sort((a, b) => a - b)
  const at = (p: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!)
  return { breached: breached.length, of: waits.length, medianSeconds: at(0.5), p95Seconds: at(0.95), maxSeconds: sorted.at(-1) ?? 0, censored: breached.filter((w) => !w.cleared).length }
}

export type PoolTokenSpend = { time: number; token: RegistryName; amount: bigint }

/** The budget-relevant spend of a pool's executed ops, in time order — see `OpEntry.spend`. */
export function spendOf(ops: readonly OpEntry[], pool: RegistryName): PoolTokenSpend[] {
  const out: PoolTokenSpend[] = []
  for (const op of ops) {
    if (op.pool !== pool || !op.ok || !op.spend) continue
    for (const sp of op.spend) if (sp.amount > 0n) out.push({ time: op.time, token: sp.token, amount: sp.amount })
  }
  return out.sort((a, b) => a.time - b.time)
}

export type BudgetScan = {
  token: RegistryName
  windowCap: bigint
  totalCap: bigint
  windowsScanned: number
  peakWindowSpend: bigint
  peakWindowSpendPct: number
  windowBreaches: number
  totalSpend: bigint
  totalSpendPct: number
  totalBreached: boolean
}

/**
 * Spec 007 "(c) budgets": fixed `budgetWindowSeconds` windows from `firstTime` (same convention `run.ts`'s session
 * renewal uses: the window resets at fixed multiples of its length from activation, not a sliding window), and one
 * running total from `firstTime` to `lastTime` for the whole approval. `windowCap` is `W_p`, `totalCap` is `T_p`,
 * both already resolved to this token's raw units (see `capsAt`/`v4CapFormulas`).
 */
export function scanBudget(spend: readonly PoolTokenSpend[], token: RegistryName, firstTime: number, lastTime: number, budgetWindowSeconds: number, windowCap: bigint, totalCap: bigint): BudgetScan {
  const forToken = spend.filter((s) => s.token === token)
  let windowsScanned = 0
  let windowBreaches = 0
  let peakWindowSpend = 0n
  let totalSpend = 0n
  let idx = 0
  for (let t = firstTime; t <= lastTime; t += budgetWindowSeconds) {
    const winEnd = t + budgetWindowSeconds
    let winSpend = 0n
    while (idx < forToken.length && forToken[idx]!.time < winEnd) {
      winSpend += forToken[idx]!.amount
      totalSpend += forToken[idx]!.amount
      idx++
    }
    windowsScanned++
    if (winSpend > peakWindowSpend) peakWindowSpend = winSpend
    if (windowCap > 0n && winSpend > windowCap) windowBreaches++
  }
  return {
    token,
    windowCap,
    totalCap,
    windowsScanned,
    peakWindowSpend,
    peakWindowSpendPct: windowCap === 0n ? 0 : Number((peakWindowSpend * 10_000n) / windowCap) / 100,
    windowBreaches,
    totalSpend,
    totalSpendPct: totalCap === 0n ? 0 : Number((totalSpend * 10_000n) / totalCap) / 100,
    totalBreached: totalCap > 0n && totalSpend > totalCap,
  }
}
