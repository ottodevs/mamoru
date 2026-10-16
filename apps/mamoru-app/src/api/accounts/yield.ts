// Reads the yield ledger the Worker cron writes (otto/mamoru#129, yield-ledger.ts) for one account. Pure D1
// reads: this never calls the operator, so it answers even when the operator is down, same as the rest of the
// live-funds dashboard's not_observed discipline. Shared by GET /api/accounts/:accountKey/yield and the
// dashboard route, so the two never drift.
import type { YieldLedgerView } from '@mamoru/domain'
import type { Db } from '../env.ts'

type LatestRow = { fees_usdc: number; read_at: string; positions_json: string }
type DailyRow = { collected_usdc: number | null; gas_paid_wei: string | null }
type PositionRow = { value_usd: number; accrued_usd_close: number; hold_value_usd: number }
type FeeRow = { fee_accrued_usd: number | null }

const dayOf = (iso: string): string => iso.slice(0, 10)

/**
 * `valueVsHoldUsd` is read-time, not lifetime (packages/domain/src/app-api.ts's doc comment: "today's ... minus
 * the hold baseline"), so it is scoped to the positions account_snapshot_latest says are open right now, on the
 * day of that same snapshot. Without this, a position that closed still had a row written on its last open day,
 * and summing blindly by MAX(day) would (a) keep reporting a closed position's stale figure forever once it is
 * the account's only position, and (b) double-count a same-day close-then-open (rerange) against the new
 * position's row for the rest of that UTC day. Both were code-review findings on PR #43.
 */
async function openPositionsValueVsHold(db: Db, chainId: number, accountKey: string, latest: LatestRow | null): Promise<bigint | null> {
  if (!latest) return null
  const tokenIds: number[] = (JSON.parse(latest.positions_json) as { tokenId: string }[]).map((p) => Number(p.tokenId))
  if (tokenIds.length === 0) return null
  const placeholders = tokenIds.map(() => '?').join(', ')
  const rows = await db
    .prepare(`SELECT value_usd, accrued_usd_close, hold_value_usd FROM yield_ledger_position_daily WHERE chain_id = ? AND account_key = ? AND day = ? AND token_id IN (${placeholders})`)
    .bind(chainId, accountKey, dayOf(latest.read_at), ...tokenIds)
    .all<PositionRow>()
  if (rows.results.length === 0) return null
  return rows.results.reduce((n, p) => n + BigInt(p.value_usd) + BigInt(p.accrued_usd_close) - BigInt(p.hold_value_usd), 0n)
}

export async function loadYieldLedger(db: Db, chainId: number, accountKey: string): Promise<YieldLedgerView> {
  const [latest, daily, feeRows] = await Promise.all([
    db.prepare('SELECT fees_usdc, read_at, positions_json FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?').bind(chainId, accountKey).first<LatestRow>(),
    db.prepare('SELECT collected_usdc, gas_paid_wei FROM account_daily WHERE chain_id = ? AND account_key = ?').bind(chainId, accountKey).all<DailyRow>(),
    // Lifetime, matching collectedUsd: every day's fee_accrued_usd is already that day's own 10% of that day's
    // collected_usd (migrations/d1/0010_yield_ledger.sql), so summing every row is the lifetime readiness figure.
    db.prepare('SELECT fee_accrued_usd FROM yield_ledger_position_daily WHERE chain_id = ? AND account_key = ?').bind(chainId, accountKey).all<FeeRow>(),
  ])

  let collected = 0n
  let anyCollected = false
  let gas = 0n
  let anyGas = false
  for (const row of daily.results) {
    if (row.collected_usdc != null) {
      collected += BigInt(row.collected_usdc)
      anyCollected = true
    }
    if (row.gas_paid_wei != null) {
      gas += BigInt(row.gas_paid_wei)
      anyGas = true
    }
  }

  let feeAccrued = 0n
  let anyFeeAccrued = false
  for (const row of feeRows.results) {
    if (row.fee_accrued_usd != null) {
      feeAccrued += BigInt(row.fee_accrued_usd)
      anyFeeAccrued = true
    }
  }

  const valueVsHold = await openPositionsValueVsHold(db, chainId, accountKey, latest)
  const accrued = latest ? BigInt(latest.fees_usdc) : null
  return {
    asOf: latest?.read_at ?? null,
    accruedUsd: accrued !== null ? accrued.toString() : null,
    collectedUsd: anyCollected ? collected.toString() : null,
    earnedSoFarUsd: accrued !== null ? (accrued + collected).toString() : null,
    gasPaidWei: anyGas ? gas.toString() : null,
    valueVsHoldUsd: valueVsHold !== null ? valueVsHold.toString() : null,
    feeAccruedUsd: anyFeeAccrued ? feeAccrued.toString() : null,
  }
}
