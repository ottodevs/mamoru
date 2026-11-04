// Brais, 2 Nov: the APY under the balance counts only the money that works. Idle money earns nothing and is left
// out. This is how much capital worked in each pool or vault, and for how long, over the last 24 hours and the last
// 30 days (otto/mamoru#343). It is measured at each snapshot (account_worked_samples, written by the yield-ledger
// cron): the value in range at that snapshot times the seconds since the previous one. The SPA weights each rate by it.
// Pure D1 reads, like the rest of the ledger.
import { BASE_CHAIN_ID, type WorkedView } from '@mamoru/domain'
import type { Db } from '../env.ts'

const DAY_S = 86_400
const MONTH_S = 30 * DAY_S

/** A snapshot stands for the time since the previous one only if that was at most this long ago: a longer silence is a gap nobody saw. */
export const WORKED_MAX_GAP_S = 25 * 60

type Sample = { t_s: number; read_at: string; pool: string; value_usd: number; in_range: number }

/** A sleeve whose latest sample is older than this, against the newest sample of the view, is left out (the SPA's 6 h sample-age rule). */
export const WORKED_STALE_S = 6 * 3600

type Windows = { day: Map<string, number>; month: Map<string, number> }

/**
 * USDC base units x seconds per pool or vault, in range only, over the `DAY_S` and `MONTH_S` seconds before the
 * latest sample (`asOf`). Null until the cron has stored a sample of this account. Each distinct sample
 * time stands for (previous distinct time, itself]: nothing for the first, nothing after a gap, and the interval
 * is clipped to the window. Intervals come from the stored times alone, so two Workers writing different snapshots
 * of one account can never count the same seconds twice. A position that was emptied has no row (the writer skips
 * value 0), so it counts nothing from then on.
 *
 * otto/mamoru#343 phase B: the account of an owner on Base also counts the owner's sleeves on other chains (Monad,
 * `accounts.user_id` + chain_id, migration 0017). Each sleeve's intervals are derived on its own samples (its
 * times are its own, a Monad read is not a Base read), over windows that end at the latest sample of any of them, and
 * the pools are merged. `chains` names the other chains that contributed to each window, so the SPA drops its
 * «Base only» note only when Monad money was actually measured in the window it shows.
 */
export async function loadWorked(db: Db, chainId: number, accountKey: string): Promise<WorkedView | null> {
  const lastOf = (id: number, key: string) => db.prepare('SELECT t_s, read_at FROM account_worked_samples WHERE chain_id = ? AND account_key = ? ORDER BY t_s DESC LIMIT 1').bind(id, key).first<{ t_s: number; read_at: string }>()
  const own = await lastOf(chainId, accountKey)
  const sleeves =
    chainId === BASE_CHAIN_ID
      ? (await db.prepare('SELECT s.account_key AS account_key, s.chain_id AS chain_id FROM accounts s JOIN accounts b ON b.user_id = s.user_id WHERE b.account_key = ? AND b.chain_id = ? AND s.chain_id <> ? ORDER BY s.chain_id').bind(accountKey, chainId, BASE_CHAIN_ID).all<{ account_key: string; chain_id: number }>()).results
      : []
  type Last = { t_s: number; read_at: string }
  const withSamples: { id: number; key: string; last: Last }[] = own ? [{ id: chainId, key: accountKey, last: own }] : []
  for (const sl of sleeves) {
    const last = await lastOf(sl.chain_id, sl.account_key)
    if (last) withSamples.push({ id: sl.chain_id, key: sl.account_key, last })
  }
  if (!withSamples.length) return null
  // A cold Base account (no sample yet) still shows its sleeve's samples: the anchor is the latest of the accounts that have any.
  const anchor = Math.max(...withSamples.map((l) => l.last.t_s))
  // A sleeve whose cron stalled is left out: its old samples must not pass for a window that ends at another account's read.
  const lasts = withSamples.filter((l) => l.id === chainId || anchor - l.last.t_s <= WORKED_STALE_S)
  // asOf is the account's own latest read when it has one, so a stalled Base cron trips the SPA's sample-age rule even while Monad is fresh.
  const asOf = own ? own.read_at : lasts.reduce((a, b) => (b.last.t_s > a.last.t_s ? b : a)).last.read_at
  const day = new Map<string, number>()
  const month = new Map<string, number>()
  const chains = { day: [] as number[], month: [] as number[] }
  for (const l of lasts) {
    const w = await windowsOf(db, l.id, l.key, anchor)
    for (const [m, into] of [[w.day, day], [w.month, month]] as const) for (const [pool, v] of m) into.set(pool, (into.get(pool) ?? 0) + v)
    if (l.id !== chainId) {
      if ([...w.day.values()].some((v) => v > 0)) chains.day.push(l.id)
      if ([...w.month.values()].some((v) => v > 0)) chains.month.push(l.id)
    }
  }
  const pick = (m: Map<string, number>) => [...m].filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b)).map(([pool, usdSeconds]) => ({ pool, usdSeconds }))
  return { asOf, day: pick(day), month: pick(month), ...(lasts.some((l) => l.id !== chainId) ? { chains } : {}) }
}

/** One account's worked USDC seconds per pool in the day and month windows ending at `anchor`. */
async function windowsOf(db: Db, chainId: number, accountKey: string, anchor: number): Promise<Windows> {
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
  return { day, month }
}
