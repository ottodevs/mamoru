// otto/mamoru#380: the intervals an account was actually sampled (account_worked_samples), shared by the APR of the
// Portfolio (vs-idle.ts) and of each pool (pool-earnings.ts). The capital-time of an APR (worked.ts) only exists where
// samples were taken, so its numerator must count the income of those same intervals and nothing else, and the figure
// needs enough of the window sampled to mean anything.
import type { Db } from '../env.ts'
import { WORKED_MAX_GAP_S } from './worked.ts'

export type Interval = { from: number; to: number }

/** The window must be at least this fraction sampled for an APR to be shown. */
export const COVERAGE_MIN = 0.8

/**
 * Intervals (previous sample, sample] of one sleeve inside the window (start, end]: each distinct sample time stands for
 * the time since the previous one only if that was at most WORKED_MAX_GAP_S ago, clipped to the window; the same rule
 * as worked.ts, so the two always agree.
 */
export async function sampledIntervals(db: Db, chainId: number, accountKey: string, start: number, end: number): Promise<Interval[]> {
  const rows = (await db.prepare('SELECT DISTINCT t_s FROM account_worked_samples WHERE chain_id = ? AND account_key = ? AND t_s > ? AND t_s <= ? ORDER BY t_s').bind(chainId, accountKey, start - WORKED_MAX_GAP_S, end).all<{ t_s: number }>()).results
  const out: Interval[] = []
  for (let i = 1; i < rows.length; i++) {
    const to = rows[i]!.t_s
    const prev = rows[i - 1]!.t_s
    if (to - prev > WORKED_MAX_GAP_S) continue
    const from = Math.max(prev, start)
    if (to > from) out.push({ from, to: Math.min(to, end) })
  }
  return out
}

export const sampledSeconds = (iv: readonly Interval[]) => iv.reduce((n, x) => n + (x.to - x.from), 0)

/** Fraction of (start, end] that was sampled. */
export const coverage = (iv: readonly Interval[], start: number, end: number) => (end > start ? sampledSeconds(iv) / (end - start) : 0)

/** Seconds of [a, b] inside the sampled intervals. */
export function overlapS(iv: readonly Interval[], a: number, b: number): number {
  let n = 0
  for (const x of iv) n += Math.max(0, Math.min(x.to, b) - Math.max(x.from, a))
  return n
}

/**
 * The part (0..1) of an income row that belongs to the sampled intervals of its window (start, end]:
 * - 'point' (a collect at its block time): whole if its time is inside a sampled interval, else nothing;
 * - 'span' (vault yield over [from, t]): the sampled share of its interval;
 * - 'day' (collects known per UTC day, `t` = the day's end): the sampled share of that day.
 */
export function sampledShare(iv: readonly Interval[], row: { kind: 'point' | 'span' | 'day'; t: number; from?: number | null }, start: number, end: number): number {
  if (row.kind === 'span' && row.from != null && row.t > row.from) {
    const a = Math.max(row.from, start)
    const b = Math.min(row.t, end)
    return b > a ? overlapS(iv, a, b) / (row.t - row.from) : 0
  }
  if (row.kind === 'day') {
    const a = Math.max(row.t - 86_400 + 1, start)
    const b = Math.min(row.t, end)
    return b > a ? overlapS(iv, a, b) / 86_400 : 0
  }
  return row.t > start && row.t <= end && iv.some((x) => row.t > x.from && row.t <= x.to) ? 1 : 0
}
