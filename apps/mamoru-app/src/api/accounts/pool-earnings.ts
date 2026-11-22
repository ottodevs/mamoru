// otto/mamoru#380: what each pool or vault earned the owner, for the Working capital table's APR 30d and Earned columns.
// Realized income only (collected fees, vault share growth), net of Mamoru's 10 % fee for income from 5 Nov on (same
// rule and same seam as vs-idle.ts: `MAMORU_FEE_*`). Pure D1 reads.
// - Earned: lifetime, per pool (`pool:WETH/USDC/3000`) or vault (`vault:gtUSDCp`), every chain of the owner. A pool that
//   re-ranged keeps what its burned positions collected (collected fees are keyed by token id, read through the entry's pool).
// - APR 30d: that pool's income of the last 30 days over the capital that worked in it in that window times its time
//   (worked samples, in range only), annualised. Null (the app says n/a) when nothing worked in the pool or the window
//   was observed under 28 days, never a figure.
import type { Db } from '../env.ts'
import { MAMORU_FEE_BPS, MAMORU_FEE_FROM } from './vs-idle.ts'
import { loadWorked } from './worked.ts'

const DAY_S = 86_400
const MONTH_S = 30 * DAY_S
const YEAR_S = 365 * DAY_S

export type PoolEarning = { pool: string; earnedUsd: number; aprPct: number | null }

type Row = { pool: string; t: number; usd: number; from?: number | null; vault: boolean; chain: number }

const net = (usd: number, t: number) => (t >= MAMORU_FEE_FROM ? usd * (1 - Number(MAMORU_FEE_BPS) / 10_000) : usd)
const VAULT_YIELD = /^vault:\d+:[^:]+:(.+):\d+$/
const VAULT_BACKFILL = /^vault-backfill:\d+:[^:]+:(.+)$/

async function rowsOf(db: Db, chainId: number, accountKey: string): Promise<Row[]> {
  // `chain` tags each row so the APR counts only the chains whose capital-time it divides by.
  const rows: Row[] = []
  const lp = (
    await db
      .prepare(
        `SELECT e.pool AS pool, c.day AS day, c.collected_usd AS usd FROM yield_ledger_position_collected c
         JOIN yield_ledger_position_entry e ON e.chain_id = c.chain_id AND e.token_id = c.token_id
         WHERE c.chain_id = ? AND c.account_key = ? AND c.collected_usd IS NOT NULL`,
      )
      .bind(chainId, accountKey)
      .all<{ pool: string; day: string; usd: number }>()
  ).results
  // A day's collects are credited at its end: the day is whole in the window or out of it.
  for (const r of lp) rows.push({ pool: r.pool, t: Date.parse(`${r.day}T00:00:00.000Z`) / 1000 + DAY_S - 1, usd: r.usd, vault: false, chain: chainId })
  const income = (
    await db
      .prepare("SELECT event_id, source, t_s, from_s, usd FROM yield_ledger_income WHERE chain_id = ? AND account_key = ? AND usd IS NOT NULL AND (source = 'vault-yield' OR event_id LIKE 'vault-backfill:%')")
      .bind(chainId, accountKey)
      .all<{ event_id: string; source: string; t_s: number; from_s: number | null; usd: number }>()
  ).results
  for (const r of income) {
    const m = VAULT_YIELD.exec(r.event_id) ?? VAULT_BACKFILL.exec(r.event_id)
    if (m) rows.push({ pool: m[1]!, t: r.t_s, usd: r.usd, from: r.from_s, vault: true, chain: chainId })
  }
  return rows
}

export async function loadPoolEarnings(db: Db, sleeves: { chain_id: number; account_key: string }[]): Promise<PoolEarning[]> {
  const rows: Row[] = []
  try {
    for (const s of sleeves) rows.push(...(await rowsOf(db, s.chain_id, s.account_key)))
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return []
    throw e
  }
  const base = sleeves.find((s) => s.chain_id === 8453) ?? sleeves[0]
  const worked = base ? await loadWorked(db, base.chain_id, base.account_key) : null
  let window: { start: number; end: number } | null = null
  if (worked && base) {
    const end = Math.floor(Date.parse(worked.asOf) / 1000)
    const start = end - MONTH_S
    const span = await db.prepare('SELECT MIN(t_s) AS lo, MAX(t_s) AS hi FROM account_worked_samples WHERE chain_id = ? AND account_key = ? AND t_s > ? AND t_s <= ?').bind(base.chain_id, base.account_key, start, end).first<{ lo: number | null; hi: number | null }>()
    if (Number.isFinite(end) && span?.lo != null && span.hi != null && span.hi - span.lo >= 28 * DAY_S) window = { start, end }
  }
  const counted = new Set([base?.chain_id ?? 8453, ...(worked?.chains?.month ?? [])])
  const capital = new Map((worked?.month ?? []).map((p) => [p.pool, p.usdSeconds / 1e6]))
  // A pool that worked but collected nothing yet is 0 earned and 0 %, not unmeasured.
  const pools = [...new Set([...rows.map((r) => r.pool), ...(window ? [...capital].filter(([, c]) => c > 0).map(([p]) => p) : [])])].sort()
  if (!pools.length) return []
  return pools.map((pool) => {
    const mine = rows.filter((r) => r.pool === pool)
    const earned = mine.reduce((n, r) => n + net(r.usd / 1e6, r.t), 0)
    let aprPct: number | null = null
    const cap = capital.get(pool) ?? 0
    if (window && cap > 0) {
      let inWindow = 0
      for (const r of mine) {
        // Only the chains whose samples are in `cap`, and nothing booked after the read the window ends at.
        if (!counted.has(r.chain)) continue
        // LP day rows: a day starting after the read is out. Vault rows accrue over [from, t]: only the part up to the read counts.
        if (!r.vault && r.t - DAY_S + 1 > window.end) continue
        const at = Math.min(r.t, window.end)
        if (at <= window.start) continue
        const total = r.vault && r.from != null ? r.t - r.from : 0
        const share = total > 0 ? Math.max(0, at - Math.max(r.from!, window.start)) / total : 1
        inWindow += net(r.usd / 1e6, r.t) * share
      }
      aprPct = Math.round((inWindow / cap) * YEAR_S * 1000) / 10
    }
    return { pool, earnedUsd: Math.round(earned * 100) / 100, aprPct }
  })
}
