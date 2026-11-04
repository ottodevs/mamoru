// Brais, 2 Nov: the APY under the balance counts only the money that works. Idle money earns nothing and is left
// out. This is how much capital worked in each pool or vault, and for how long, over the last 24 hours and the last
// 30 days (otto/mamoru#343). It is measured at each snapshot (account_worked_samples, written by the yield-ledger
// cron): the value in range at that snapshot times the seconds since the previous one. The SPA weights each rate by it.
// Pure D1 reads, like the rest of the ledger.
import type { WorkedView } from '@mamoru/domain'
import type { Db } from '../env.ts'

const DAY_S = 86_400
const MONTH_S = 30 * DAY_S

/** A snapshot stands for the time since the previous one only if that was at most this long ago: a longer silence is a gap nobody saw. */
export const WORKED_MAX_GAP_S = 25 * 60

type Sample = { t_s: number; read_at: string; pool: string; value_usd: number; in_range: number }

/**
 * USDC base units x seconds per pool or vault, in range only, over the `DAY_S` and `MONTH_S` seconds before the
 * account's latest sample (`asOf`). Null until the cron has stored a sample of this account. Each distinct sample
 * time stands for (previous distinct time, itself]: nothing for the first, nothing after a gap, and the interval
 * is clipped to the window. Intervals come from the stored times alone, so two Workers writing different snapshots
 * of one account can never count the same seconds twice. A position that was emptied has no row (the writer skips
 * value 0), so it counts nothing from then on.
 */
export async function loadWorked(db: Db, chainId: number, accountKey: string): Promise<WorkedView | null> {
  const last = await db.prepare('SELECT t_s, read_at FROM account_worked_samples WHERE chain_id = ? AND account_key = ? ORDER BY t_s DESC LIMIT 1').bind(chainId, accountKey).first<{ t_s: number; read_at: string }>()
  if (!last) return null
  const anchor = last.t_s
  const rows = await db
    .prepare('SELECT t_s, read_at, pool, value_usd, in_range FROM account_worked_samples WHERE chain_id = ? AND account_key = ? AND t_s > ? AND t_s <= ?')
    .bind(chainId, accountKey, anchor - MONTH_S - WORKED_MAX_GAP_S, anchor)
    .all<Sample>()
  const times = [...new Set(rows.results.map((r) => r.t_s))].sort((a, b) => a - b)
  const prev = new Map<number, number>(times.slice(1).map((t, i) => [t, times[i]!]))
  const day = new Map<string, number>()
  const month = new Map<string, number>()
  for (const r of rows.results) {
    const p = prev.get(r.t_s)
    if (!r.in_range || p === undefined || r.t_s - p > WORKED_MAX_GAP_S) continue
    const within = (windowS: number) => Math.max(0, r.t_s - Math.max(p, anchor - windowS))
    day.set(r.pool, (day.get(r.pool) ?? 0) + r.value_usd * within(DAY_S))
    month.set(r.pool, (month.get(r.pool) ?? 0) + r.value_usd * within(MONTH_S))
  }
  const pick = (m: Map<string, number>) => [...m].filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b)).map(([pool, usdSeconds]) => ({ pool, usdSeconds }))
  return { asOf: last.read_at, day: pick(day), month: pick(month) }
}
