import { beforeEach, describe, expect, test } from 'bun:test'
import { memoryD1 } from './d1.ts'
import { loadYieldLedger } from '../../src/api/accounts/yield.ts'

const CHAIN_ID = 8453
const ACCOUNT_KEY = 'acct-yield-loader-1'

describe('loadYieldLedger (otto/mamoru#129)', () => {
  let db: ReturnType<typeof memoryD1>
  beforeEach(() => {
    db = memoryD1()
  })

  test('every field is null before the cron has ever pulled a snapshot for this account', async () => {
    const view = await loadYieldLedger(db, CHAIN_ID, ACCOUNT_KEY)
    expect(view).toEqual({ asOf: null, accruedUsd: null, collectedUsd: null, earnedSoFarUsd: null, gasPaidWei: null, valueVsHoldUsd: null, feeAccruedUsd: null })
  })

  test('accruedUsd and earnedSoFarUsd come from account_snapshot_latest once it has a row, collected folded in as 0 when none is known', async () => {
    db.raw.exec(
      `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
       VALUES (${CHAIN_ID}, '0xsafe', '${ACCOUNT_KEY}', 'unknown', 1000, '2026-10-16T09:00:00.000Z', 1, 1000000, 5000000, 1234, 0, 6001234, '[]', '2026-10-16T09:00:05.000Z')`,
    )
    const view = await loadYieldLedger(db, CHAIN_ID, ACCOUNT_KEY)
    expect(view.asOf).toBe('2026-10-16T09:00:00.000Z')
    expect(view.accruedUsd).toBe('1234')
    expect(view.earnedSoFarUsd).toBe('1234')
    expect(view.collectedUsd).toBeNull()
    expect(view.gasPaidWei).toBeNull()
  })

  test('collectedUsd and gasPaidWei sum across account_daily rows once any is known', async () => {
    db.raw.exec(
      `INSERT INTO account_daily (day, chain_id, address, account_key, env, block_open, block_close, total_open_usdc, total_close_usdc, idle_close_usdc, lp_close_usdc, fees_open_usdc, fees_close_usdc, collected_usdc, gas_paid_wei)
       VALUES ('2026-10-15', ${CHAIN_ID}, '0xsafe', '${ACCOUNT_KEY}', 'unknown', 1, 1, 0, 0, 0, 0, 0, 0, 100, '1000000000000000')`,
    )
    db.raw.exec(
      `INSERT INTO account_daily (day, chain_id, address, account_key, env, block_open, block_close, total_open_usdc, total_close_usdc, idle_close_usdc, lp_close_usdc, fees_open_usdc, fees_close_usdc, collected_usdc, gas_paid_wei)
       VALUES ('2026-10-16', ${CHAIN_ID}, '0xsafe', '${ACCOUNT_KEY}', 'unknown', 1, 1, 0, 0, 0, 0, 0, 0, 50, '2000000000000000')`,
    )
    const view = await loadYieldLedger(db, CHAIN_ID, ACCOUNT_KEY)
    expect(view.collectedUsd).toBe('150')
    expect(view.gasPaidWei).toBe('3000000000000000')
  })

  function seedPositionDaily(db: ReturnType<typeof memoryD1>, day: string, tokenId: number, value: number, accrued: number, hold: number, fee: number | null) {
    db.raw.exec(
      `INSERT INTO yield_ledger_position_daily (day, chain_id, token_id, account_key, address, env, pool, block_open, block_close, accrued0_open, accrued1_open, accrued_usd_open, accrued0_close, accrued1_close, accrued_usd_close, value_usd, hold_value_usd, collected0, collected1, collected_usd, fee_accrued_usd, updated_at)
       VALUES ('${day}', ${CHAIN_ID}, ${tokenId}, '${ACCOUNT_KEY}', '0xsafe', 'unknown', 'pool:USDC/cbBTC/500', 1, 1, '0', '0', 0, '0', '0', ${accrued}, ${value}, ${hold}, NULL, NULL, NULL, ${fee === null ? 'NULL' : fee}, '2026-10-16T09:00:00.000Z')`,
    )
  }
  function seedLatest(db: ReturnType<typeof memoryD1>, readAt: string, openTokenIds: number[]) {
    db.raw.exec(
      `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
       VALUES (${CHAIN_ID}, '0xsafe', '${ACCOUNT_KEY}', 'unknown', 1000, '${readAt}', 1, 0, 0, 0, 0, 0, '${JSON.stringify(openTokenIds.map((id) => ({ tokenId: String(id) })))}', '${readAt}')`,
    )
  }

  test('valueVsHoldUsd sums the latest snapshot\'s day, scoped to the positions account_snapshot_latest says are still open', async () => {
    seedPositionDaily(db, '2026-10-15', 1, 4_000_000, 0, 4_000_000, null)
    seedPositionDaily(db, '2026-10-16', 1, 5_000_000, 1_000, 4_500_000, 50)
    seedPositionDaily(db, '2026-10-16', 2, 2_000_000, 500, 1_900_000, 25)
    seedLatest(db, '2026-10-16T09:00:00.000Z', [1, 2])
    const view = await loadYieldLedger(db, CHAIN_ID, ACCOUNT_KEY)
    // (5_000_000+1_000-4_500_000) + (2_000_000+500-1_900_000) = 501_000 + 100_500.
    expect(view.valueVsHoldUsd).toBe('601500')
  })

  test('feeAccruedUsd is a lifetime sum of each day\'s 10% of account_daily.collected_usdc, the same rows as collectedUsd (a burned position may have no position row)', async () => {
    for (const [day, collected] of [['2026-10-15', 100], ['2026-10-16', 500]] as const) {
      db.raw.exec(
        `INSERT INTO account_daily (day, chain_id, address, account_key, env, block_open, block_close, total_open_usdc, total_close_usdc, idle_close_usdc, lp_close_usdc, fees_open_usdc, fees_close_usdc, collected_usdc, gas_paid_wei)
         VALUES ('${day}', ${CHAIN_ID}, '0xsafe', '${ACCOUNT_KEY}', 'unknown', 1, 1, 0, 0, 0, 0, 0, 0, ${collected}, '1')`,
      )
    }
    seedPositionDaily(db, '2026-10-16', 1, 5_000_000, 1_000, 4_500_000, 999)
    seedLatest(db, '2026-10-16T09:00:00.000Z', [1])
    const view = await loadYieldLedger(db, CHAIN_ID, ACCOUNT_KEY)
    expect(view.collectedUsd).toBe('600')
    expect(view.feeAccruedUsd).toBe('60')
  })

  test('a position that closed is excluded from valueVsHoldUsd even though its last open day left a row (code-review finding: no stale or double-counted figure)', async () => {
    // tokenId 1 closed on 2026-10-15 (its last row); tokenId 2 opened same-day, 2026-10-16, and is the only one
    // account_snapshot_latest still lists. Blindly summing "the latest day's rows" would double-count a position
    // that is not open any more, or (once nothing is open) keep reporting a stale figure forever.
    seedPositionDaily(db, '2026-10-15', 1, 5_000_000, 1_000, 4_500_000, null)
    seedPositionDaily(db, '2026-10-16', 2, 2_000_000, 500, 1_900_000, null)
    seedLatest(db, '2026-10-16T09:00:00.000Z', [2])
    const view = await loadYieldLedger(db, CHAIN_ID, ACCOUNT_KEY)
    expect(view.valueVsHoldUsd).toBe('100500')
  })

  test('valueVsHoldUsd is null once every position has closed, never a stale figure from the last day one was open', async () => {
    seedPositionDaily(db, '2026-10-15', 1, 5_000_000, 1_000, 4_500_000, null)
    seedLatest(db, '2026-10-16T09:00:00.000Z', [])
    const view = await loadYieldLedger(db, CHAIN_ID, ACCOUNT_KEY)
    expect(view.valueVsHoldUsd).toBeNull()
  })
})
