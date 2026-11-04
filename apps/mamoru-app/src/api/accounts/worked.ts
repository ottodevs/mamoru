// Brais, 2 Nov: the APY under the balance counts only the money that works. Idle money earns nothing and is left
// out. This is how much capital worked in each pool or vault, and for how long, over the last 24 hours and the last
// 30 days (otto/mamoru#343). It is measured at each snapshot (account_worked_samples, written by the yield-ledger
// cron): the value in range at that snapshot times the seconds since the previous one. The SPA weights each rate by it.
// Pure D1 reads, like the rest of the ledger.
import type { WorkedView } from '@mamoru/domain'
import type { Db } from '../env.ts'

const DAY_S = 86_400
const MONTH_S = 30 * DAY_S

type SumRow = { pool: string; day: number; month: number }

/**
 * USDC base units x seconds per pool or vault, in range only, over the `DAY_S` and `MONTH_S` seconds before the
 * account's latest sample (`asOf`). Null until the cron has stored a sample of this account. A position that was
 * emptied has no sample (the writer skips value 0), so it counts nothing from then on.
 */
export async function loadWorked(db: Db, chainId: number, accountKey: string): Promise<WorkedView | null> {
  const last = await db.prepare('SELECT MAX(read_at) AS read_at FROM account_worked_samples WHERE chain_id = ? AND account_key = ?').bind(chainId, accountKey).first<{ read_at: string | null }>()
  if (!last?.read_at) return null
  const anchor = Math.floor(Date.parse(last.read_at) / 1000)
  // A row stands for (t_s - dt_s, t_s]: only the part inside (anchor - window, anchor] counts, so a sample just
  // inside the boundary gives its few seconds, not its whole dt.
  const part = (windowS: number) => `value_usd * MAX(0, MIN(t_s, ${anchor}) - MAX(t_s - dt_s, ${anchor - windowS}))`
  const rows = await db
    .prepare(
      `SELECT pool, SUM(${part(DAY_S)}) AS day, SUM(${part(MONTH_S)}) AS month
       FROM account_worked_samples
       WHERE chain_id = ? AND account_key = ? AND in_range = 1 AND t_s > ? AND t_s <= ?
       GROUP BY pool ORDER BY pool`,
    )
    .bind(chainId, accountKey, anchor - MONTH_S, anchor)
    .all<SumRow>()
  const pick = (k: 'day' | 'month') => rows.results.filter((r) => r[k] > 0).map((r) => ({ pool: r.pool, usdSeconds: r[k] }))
  return { asOf: last.read_at, day: pick('day'), month: pick('month') }
}
