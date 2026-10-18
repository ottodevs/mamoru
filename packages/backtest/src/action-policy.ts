// Spec 007 (otto/mamoru#151) T5, Lab only: how often MamoruActionPolicy's price band would have made the engine
// wait, and how much of each pool's capital the engine turns over per approval. Pure analysis over a decoded
// `Dataset` and a finished `RunResult.ops`: nothing here changes `decide` or the backtest's session enforcement, so
// the run is the deployed policy's, and a wait is measured after the fact (the run does not replay what the engine
// would have done next had it waited).
import { entry, type RegistryName } from '@mamoru/registry'
import { twapTick } from './observe.ts'
import type { Dataset, OpEntry } from './types.ts'

/** Spot tick minus the pool's TWAP tick over `windowSeconds` at sample `i`; null where the pool was not read. */
export function spotTwapDeviation(ds: Dataset, poolIndex: number, i: number, windowSeconds: number): number | null {
  const ps = ds.samples[i]?.pools[poolIndex]
  if (!ps) return null
  return ps.tick - twapTick(ds, poolIndex, i, windowSeconds)
}

/**
 * Which deviations refuse an op. `symmetric`: |spot - twap| > band (mint and increase at execution; the task's
 * conservative reading for swap and decrease). `down`/`up`: a swap that sells token0 (price falls) is refused when
 * spot is already past `twap - band` (its price limit is behind it), one that sells token1 when past `twap + band`.
 */
export type Side = 'symmetric' | 'down' | 'up'

export function refuses(dev: number, band: number, side: Side): boolean {
  if (side === 'down') return dev < -band
  if (side === 'up') return dev > band
  return Math.abs(dev) > band
}

/** The side an executed op is refused on: swaps by direction, everything else symmetric. */
export function sideOf(op: Pick<OpEntry, 'kind' | 'pool' | 'spend'>): Side {
  if (op.kind !== 'enter_swap' && op.kind !== 'harvest') return 'symmetric'
  const sold = op.spend?.[0]?.token
  if (!sold) return 'symmetric'
  return sold === entry(op.pool).token0 ? 'down' : 'up'
}

export type Wait = {
  i: number
  time: number
  kind: OpEntry['kind']
  dev: number | null
  refused: boolean
  /** Seconds from the proposal to the first later sample the band accepts; 0 when accepted at once. */
  waitSeconds: number
  /** False when the band still refused at the dataset's last sample: `waitSeconds` is then a lower bound. */
  cleared: boolean
  /** Pool tick move over the wait (ticks, signed). */
  moveTicks: number
}

/** For one op at sample `i`: refused at proposal, and how long until the band accepts it. */
export function waitFor(ds: Dataset, poolIndex: number, windowSeconds: number, band: number, side: Side, op: { i: number; kind: OpEntry['kind'] }): Wait {
  const s = ds.samples[op.i]!
  const dev = spotTwapDeviation(ds, poolIndex, op.i, windowSeconds)
  const base = { i: op.i, time: s.time, kind: op.kind, dev }
  if (dev === null || !refuses(dev, band, side)) return { ...base, refused: false, waitSeconds: 0, cleared: true, moveTicks: 0 }
  const tick0 = s.pools[poolIndex]!.tick
  for (let j = op.i + 1; j < ds.samples.length; j++) {
    const d = spotTwapDeviation(ds, poolIndex, j, windowSeconds)
    if (d !== null && !refuses(d, band, side)) return { ...base, refused: true, waitSeconds: ds.samples[j]!.time - s.time, cleared: true, moveTicks: ds.samples[j]!.pools[poolIndex]!.tick - tick0 }
  }
  const last = ds.samples.at(-1)!
  return { ...base, refused: true, waitSeconds: last.time - s.time, cleared: false, moveTicks: (last.pools[poolIndex]?.tick ?? tick0) - tick0 }
}

/** Share of the pool's read samples the band refuses (symmetric), and the longest run of refusing samples. */
export function bandScan(ds: Dataset, poolIndex: number, windowSeconds: number, band: number): { samples: number; refused: number; longestSeconds: number; episodes: number } {
  let samples = 0
  let refused = 0
  let longest = 0
  let episodes = 0
  let start: number | null = null
  let prev: number | null = null
  for (let i = 0; i < ds.samples.length; i++) {
    const dev = spotTwapDeviation(ds, poolIndex, i, windowSeconds)
    if (dev === null) continue
    samples++
    const t = ds.samples[i]!.time
    if (Math.abs(dev) > band) {
      refused++
      if (start === null || (prev !== null && t - prev > 2 * windowSeconds)) {
        start = t
        episodes++
      }
      // An episode lasts until the first accepting sample after it, so a lone refusing sample counts one step.
      longest = Math.max(longest, t - start + (ds.samples[i + 1] ? ds.samples[i + 1]!.time - t : 0))
    } else start = null
    prev = t
  }
  return { samples, refused, longestSeconds: longest, episodes }
}

export type Spend = { time: number; token: RegistryName; amount: bigint }

/** Budget spend of a pool's executed ops (swaps' amountIn, mints' amountDesired; `OpEntry.spend`), in time order. */
export function spendOf(ops: readonly OpEntry[], pool: RegistryName): Spend[] {
  const out: Spend[] = []
  for (const op of ops) if (op.pool === pool && op.ok && op.spend) for (const s of op.spend) if (s.amount > 0n) out.push({ time: op.time, token: s.token, amount: s.amount })
  return out.sort((a, b) => a.time - b.time)
}

/**
 * One approval of `seconds` from `from`: total spend of `token` and the spend of every fixed `windowSeconds` window
 * (windows reset at multiples of their length from activation, as the policy's epoch does).
 */
export function approvalSpend(spend: readonly Spend[], token: RegistryName, from: number, seconds: number, windowSeconds: number): { total: bigint; perWindow: bigint[] } {
  const n = Math.ceil(seconds / windowSeconds)
  const perWindow: bigint[] = Array.from({ length: n }, () => 0n)
  let total = 0n
  for (const s of spend) {
    if (s.token !== token || s.time < from || s.time >= from + seconds) continue
    perWindow[Math.floor((s.time - from) / windowSeconds)]! += s.amount
    total += s.amount
  }
  return { total, perWindow }
}

/** Ticks to a price fraction: a band of `ticks` lets price move 1.0001^ticks - 1. */
export const tickFraction = (ticks: number): number => Math.pow(1.0001, ticks) - 1

/**
 * Spec 007 "Max loss with a leaked key", as a fraction of the account cap:
 * L <= sum_p (band_p + fee_p) x (V_p + 2 x min(T_p, W_p x windows)), with V_p = C_p = share_p x cap and W_p, T_p
 * given as multiples of C_p.
 */
export function lossBound(pools: readonly { share: number; bandTicks: number; feeBps: number; w: number; t: number }[], windows: number): number {
  return pools.reduce((a, p) => a + (tickFraction(p.bandTicks) + p.feeBps / 10_000) * p.share * (1 + 2 * Math.min(p.t, p.w * windows)), 0)
}
