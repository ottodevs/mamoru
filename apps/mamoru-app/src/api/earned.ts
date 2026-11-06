// One definition of "earned" (spec 012 HRV-R9, used by Portfolio and by Stats, spec 013): what an account earned is
// the income events up to its cutoff plus the fees still uncollected at that cutoff.
// - cutoff t_a: the account's latest snapshot on that chain (account_snapshot_latest.read_at), the moment its
//   uncollected fees were read. A collect after t_a is not counted as income yet: its fees are still in the accrued
//   level read at t_a, so nothing is counted twice.
// - total = Σ yield_ledger_income.usd with t_s ≤ t_a (fees, vault yield, backfill) + accrued at t_a.
// - last 24 h = income in (t_a − 24 h, t_a] without backfill, a vault-yield row prorated by how much of its interval
//   falls in the window. Approximate by decision (Ot and Brais, 6 Nov): the accrued change over the window needs fee
//   samples (spec 013 B5) and is reported as not counted until they exist.
// Anything not counted makes the figure 'partial' and is named, never folded in as 0 (constitution XVI).
import type { Db } from './env.ts'

export type NotCounted = 'fees' | 'vault-yield' | 'history' | 'accrued-24h'
/** `status`/`notCounted` are the total's; the 24 h figure has its own (it also misses the accrued change and history days). */
export type EarnedView = {
  asOf: string
  totalUsd: string
  status: 'complete' | 'partial'
  notCounted: NotCounted[]
  last24hUsd: string
  last24hStatus: 'complete' | 'partial'
  last24hNotCounted: NotCounted[]
}

type IncomeRow = { event_id: string; source: string; t_s: number; from_s: number | null; usd: number | null }

const DAY = 86_400
/** A vault interval longer than this (samples run every few minutes) makes the 24 h figure partial. */
const LONG_INTERVAL_S = 2 * 3600

/** Pure: the earned figures from the account's income rows, its accrued fees at t_a, and its vault holdings' state. */
export function earnedFrom(rows: readonly IncomeRow[], tA: number, accrued: bigint, unexplainedVault: boolean): Omit<EarnedView, 'asOf'> {
  const missing = new Set<NotCounted>()
  const missing24 = new Set<NotCounted>(['accrued-24h'])
  if (unexplainedVault) missing.add('vault-yield')
  let total = accrued
  let day = 0n
  const from = tA - DAY
  for (const r of rows) {
    if (r.t_s > tA) continue
    if (r.usd === null) {
      // Only a vault's first sample writes a null backfill (shares not explained); a day backfill always has a figure.
      missing.add(r.source === 'vault-yield' || r.source === 'backfill' ? 'vault-yield' : 'fees')
      continue
    }
    // A day backfill (collected fees known only as that day's total) of t_a's own day may hold a collect made after
    // t_a, whose fees are still in the accrued level: left out and named until the operator's events cover the day.
    if (r.event_id.startsWith('backfill:') && r.t_s >= tA - (tA % DAY) && r.usd > 0) {
      missing.add('history')
      continue
    }
    const usd = BigInt(r.usd)
    total += usd
    if (r.source === 'backfill') {
      // A day of collected fees known only as a total, within the window: its share of the last 24 h is unknown.
      if (r.t_s > tA - 3 * DAY && r.usd > 0) missing24.add('history')
      continue
    }
    if (r.source === 'vault-yield' && r.from_s !== null) {
      if (r.t_s <= from) continue
      const span = r.t_s - r.from_s
      if (span > LONG_INTERVAL_S) missing24.add('vault-yield')
      const overlap = r.t_s - Math.max(r.from_s, from)
      day += span > 0 ? (usd * BigInt(overlap)) / BigInt(span) : usd
      continue
    }
    if (r.t_s > from) day += usd
  }
  const notCounted = [...missing].sort()
  const last24hNotCounted = [...new Set([...missing, ...missing24])].sort()
  return {
    totalUsd: total.toString(),
    status: notCounted.length ? 'partial' : 'complete',
    notCounted,
    last24hUsd: day.toString(),
    last24hStatus: last24hNotCounted.length ? 'partial' : 'complete',
    last24hNotCounted,
  }
}

/**
 * The account's earned figures on one chain, or null when the ledger cannot say: no snapshot of the account yet, or
 * the income tables are not migrated (the caller keeps its older figure).
 */
export async function loadEarned(db: Db, chainId: number, accountKey: string): Promise<EarnedView | null> {
  const latest = await db.prepare('SELECT fees_usdc, read_at FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?').bind(chainId, accountKey).first<{ fees_usdc: number; read_at: string }>()
  if (!latest) return null
  const tA = Math.floor(Date.parse(latest.read_at) / 1000)
  if (!Number.isFinite(tA)) return null
  try {
    const [rows, vaults] = await Promise.all([
      db.prepare('SELECT event_id, source, t_s, from_s, usd FROM yield_ledger_income WHERE chain_id = ? AND account_key = ? AND t_s <= ?').bind(chainId, accountKey, tA).all<IncomeRow>(),
      db
        .prepare(
          `SELECT s.shares, s.explained FROM yield_ledger_vault_samples s
           WHERE s.chain_id = ? AND s.account_key = ? AND s.t_s = (SELECT MAX(x.t_s) FROM yield_ledger_vault_samples x WHERE x.chain_id = s.chain_id AND x.account_key = s.account_key AND x.vault = s.vault)`,
        )
        .bind(chainId, accountKey)
        .all<{ shares: string; explained: number }>(),
    ])
    const unexplained = vaults.results.some((v) => BigInt(v.shares) > 0n && v.explained !== 1)
    return { asOf: latest.read_at, ...earnedFrom(rows.results, tA, BigInt(latest.fees_usdc), unexplained) }
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return null
    throw e
  }
}
