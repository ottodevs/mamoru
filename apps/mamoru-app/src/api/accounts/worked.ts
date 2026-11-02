// Brais, 2 Nov: the APY under the balance counts only the money that works. Idle money earns nothing and is left
// out. This is how much capital worked in each pool, and for how long, over the last 24 hours and the last 30
// days, read from the yield ledger (yield_ledger_position_daily). The SPA weights each pool's rate by it.
// Pure D1 reads, like the rest of the ledger.
import type { WorkedView } from '@mamoru/domain'
import type { Db } from '../env.ts'

/** Seconds per block on the chains the ledger covers. Elsewhere: no figure. */
const BLOCK_SECONDS: Record<number, number> = { 8453: 2 }
const DAY_S = 86_400
const MONTH_S = 30 * DAY_S

type Anchor = { block: number; read_at: string }
type Row = { pool: string; block_open: number; block_close: number; value_usd: number; hold_value_usd: number }

/**
 * USDC base units x seconds per pool inside the `windowS` seconds before `anchor`. A row covers one position for
 * one UTC day, from the first snapshot that saw it to the last one. Its capital is its value at that last
 * snapshot. A row whose value is 0 is for a position that has closed, so its entry value (the hold baseline)
 * stands in for the capital it had while open.
 */
export function workedByPool(rows: Row[], anchor: number, windowS: number, blockS: number): { pool: string; usdSeconds: number }[] {
  const start = anchor - windowS / blockS
  const by = new Map<string, number>()
  for (const r of rows) {
    const blocks = Math.min(r.block_close, anchor) - Math.max(r.block_open, start)
    const capital = r.value_usd > 0 ? r.value_usd : r.hold_value_usd
    if (blocks <= 0 || capital <= 0) continue
    by.set(r.pool, (by.get(r.pool) ?? 0) + capital * blocks * blockS)
  }
  return [...by].map(([pool, usdSeconds]) => ({ pool, usdSeconds })).sort((a, b) => a.pool.localeCompare(b.pool))
}

/** Null until the cron has pulled a snapshot of this account, or on a chain with no known block time. */
export async function loadWorked(db: Db, chainId: number, accountKey: string): Promise<WorkedView | null> {
  const blockS = BLOCK_SECONDS[chainId]
  if (!blockS) return null
  const anchor = await db.prepare('SELECT block, read_at FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?').bind(chainId, accountKey).first<Anchor>()
  if (!anchor) return null
  const from = new Date(Date.parse(anchor.read_at) - MONTH_S * 1000 - DAY_S * 1000).toISOString().slice(0, 10)
  const rows = await db
    .prepare('SELECT pool, block_open, block_close, value_usd, hold_value_usd FROM yield_ledger_position_daily WHERE day >= ? AND chain_id = ? AND account_key = ?')
    .bind(from, chainId, accountKey)
    .all<Row>()
  return {
    asOf: anchor.read_at,
    day: workedByPool(rows.results, anchor.block, DAY_S, blockS),
    month: workedByPool(rows.results, anchor.block, MONTH_S, blockS),
  }
}
