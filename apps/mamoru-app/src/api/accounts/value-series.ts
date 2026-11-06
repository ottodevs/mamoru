// Spec 013 STATS-R14: the Portfolio's Total value chart. One point per UTC day: the owner's accounts on every chain
// (Base account and its sleeves, `sleevesOfUser`) summed from `account_daily.total_close_usdc`, today's row being the
// running close the cron keeps updating. Chains are aligned by last known value, never by an exact join: a chain with
// no row on a day contributes its previous close and the point says `partial`; before a chain's first row it adds
// nothing (the account did not exist). The last point is also `partial` when a chain's latest read is older than
// VALUE_STALE_MS. Intraday points from `account_worked_samples` are left out on purpose: those samples omit idle money
// whenever positions exist, so a sum of them would understate the value. Pure D1 reads.
import type { Db } from '../env.ts'
import { sleevesOfUser } from './store.ts'

export const VALUE_STALE_MS = 30 * 60 * 1000

export type ValuePoint = { day: string; usd: number; partial?: true }
export type ValueSeriesView = {
  /** Oldest latest read among the chains that have one (ISO), null before the first read. */
  asOf: string | null
  points: ValuePoint[]
  /** Chain ids that contributed at least one row. */
  chains: number[]
}

const usd = (baseUnits: number) => Math.round(baseUnits / 10_000) / 100

export async function loadValueSeries(db: Db, userId: string, now: Date): Promise<ValueSeriesView> {
  const sleeves = await sleevesOfUser(db, userId)
  const perChain: { chainId: number; byDay: Map<string, number>; readAt: string | null }[] = []
  for (const s of sleeves) {
    const rows = (await db
      .prepare('SELECT day, total_close_usdc FROM account_daily WHERE chain_id = ? AND account_key = ? ORDER BY day')
      .bind(s.chain_id, s.account_key)
      .all<{ day: string; total_close_usdc: number }>()).results
    if (!rows.length) continue
    const last = await db
      .prepare('SELECT read_at FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?')
      .bind(s.chain_id, s.account_key)
      .first<{ read_at: string }>()
    perChain.push({ chainId: s.chain_id, byDay: new Map(rows.map((r) => [r.day, r.total_close_usdc])), readAt: last?.read_at ?? null })
  }
  if (!perChain.length) return { asOf: null, points: [], chains: [] }

  const days = [...new Set(perChain.flatMap((c) => [...c.byDay.keys()]))].sort()
  const firstDay = new Map(perChain.map((c) => [c.chainId, [...c.byDay.keys()].sort()[0]!]))
  const lastKnown = new Map<number, number>()
  const points: ValuePoint[] = days.map((day) => {
    let total = 0
    let partial = false
    for (const c of perChain) {
      if (day < firstDay.get(c.chainId)!) continue
      const v = c.byDay.get(day)
      if (v === undefined) {
        partial = true
        total += lastKnown.get(c.chainId) ?? 0
      } else {
        lastKnown.set(c.chainId, v)
        total += v
      }
    }
    return { day, usd: usd(total), ...(partial ? { partial: true as const } : {}) }
  })

  const reads = perChain.map((c) => c.readAt)
  const known = reads.filter((r): r is string => r !== null).sort()
  const stale = reads.some((r) => r === null || now.getTime() - Date.parse(r) > VALUE_STALE_MS)
  if (stale && points.length) points[points.length - 1] = { ...points[points.length - 1]!, partial: true }
  return { asOf: known[0] ?? null, points, chains: perChain.map((c) => c.chainId) }
}
