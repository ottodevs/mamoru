// Reads the yield ledger the Worker cron writes (otto/mamoru#129, yield-ledger.ts) for one account. Pure D1
// reads: this never calls the operator, so it answers even when the operator is down, same as the rest of the
// live-funds dashboard's not_observed discipline. Shared by GET /api/accounts/:accountKey/yield and the
// dashboard route, so the two never drift.
import type { YieldLedgerView } from '@mamoru/domain'
import type { Db } from '../env.ts'

type LatestRow = { fees_usdc: number; read_at: string }
type DailyRow = { collected_usdc: number | null; gas_paid_wei: string | null }
type PositionRow = { value_usd: number; accrued_usd_close: number; hold_value_usd: number; fee_accrued_usd: number | null }

export async function loadYieldLedger(db: Db, chainId: number, accountKey: string): Promise<YieldLedgerView> {
  const [latest, daily, positions] = await Promise.all([
    db.prepare('SELECT fees_usdc, read_at FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?').bind(chainId, accountKey).first<LatestRow>(),
    db.prepare('SELECT collected_usdc, gas_paid_wei FROM account_daily WHERE chain_id = ? AND account_key = ?').bind(chainId, accountKey).all<DailyRow>(),
    db
      .prepare(
        `SELECT value_usd, accrued_usd_close, hold_value_usd, fee_accrued_usd FROM yield_ledger_position_daily
         WHERE chain_id = ? AND account_key = ? AND day = (SELECT MAX(day) FROM yield_ledger_position_daily WHERE chain_id = ? AND account_key = ?)`,
      )
      .bind(chainId, accountKey, chainId, accountKey)
      .all<PositionRow>(),
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

  let valueVsHold = 0n
  let feeAccrued = 0n
  let anyFeeAccrued = false
  for (const p of positions.results) {
    valueVsHold += BigInt(p.value_usd) + BigInt(p.accrued_usd_close) - BigInt(p.hold_value_usd)
    if (p.fee_accrued_usd != null) {
      feeAccrued += BigInt(p.fee_accrued_usd)
      anyFeeAccrued = true
    }
  }

  const accrued = latest ? BigInt(latest.fees_usdc) : null
  return {
    asOf: latest?.read_at ?? null,
    accruedUsd: accrued !== null ? accrued.toString() : null,
    collectedUsd: anyCollected ? collected.toString() : null,
    earnedSoFarUsd: accrued !== null ? (accrued + collected).toString() : null,
    gasPaidWei: anyGas ? gas.toString() : null,
    valueVsHoldUsd: positions.results.length ? valueVsHold.toString() : null,
    feeAccruedUsd: anyFeeAccrued ? feeAccrued.toString() : null,
  }
}
