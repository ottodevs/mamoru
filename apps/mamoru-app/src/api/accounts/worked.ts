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
  const anchor = Date.parse(last.read_at)
  const iso = (windowS: number) => new Date(anchor - windowS * 1000).toISOString()
  const rows = await db
    .prepare(
      `SELECT pool, SUM(CASE WHEN read_at > ? THEN value_usd * dt_s ELSE 0 END) AS day, SUM(value_usd * dt_s) AS month
       FROM account_worked_samples
       WHERE chain_id = ? AND account_key = ? AND in_range = 1 AND read_at > ? AND read_at <= ?
       GROUP BY pool ORDER BY pool`,
    )
    .bind(iso(DAY_S), chainId, accountKey, iso(MONTH_S), last.read_at)
    .all<SumRow>()
  const pick = (k: 'day' | 'month') => rows.results.filter((r) => r[k] > 0).map((r) => ({ pool: r.pool, usdSeconds: r[k] }))
  return { asOf: last.read_at, day: pick('day'), month: pick('month') }
}
