import { describe, expect, test } from 'bun:test'
import { memoryD1 } from './d1.ts'
import { loadWorked, workedByPool } from '../../src/api/accounts/worked.ts'

// Brais, 2 Nov: the APY counts only the capital that worked; this is how much worked in each pool, and how long.

const row = (pool: string, open: number, close: number, value: number, hold = value) => ({ pool, block_open: open, block_close: close, value_usd: value, hold_value_usd: hold })

describe('workedByPool', () => {
  test('capital x seconds inside the window, per pool; a row before the window counts only its part inside', () => {
    // Window of 24 h on 2 s blocks ending at block 100_000: from block 56_800.
    const w = workedByPool([row('pool:A', 50_000, 100_000, 2_000_000), row('pool:B', 90_000, 95_000, 1_000_000)], 100_000, 86_400, 2)
    expect(w).toEqual([
      { pool: 'pool:A', usdSeconds: 2_000_000 * 43_200 * 2 },
      { pool: 'pool:B', usdSeconds: 1_000_000 * 5_000 * 2 },
    ])
  })
  test('a closed position (value 0) counts its entry value for the time it was open', () => {
    expect(workedByPool([row('pool:A', 99_000, 99_500, 0, 6_900_000)], 100_000, 86_400, 2)).toEqual([{ pool: 'pool:A', usdSeconds: 6_900_000 * 500 * 2 }])
  })
  test('rows outside the window or with no span count nothing', () => {
    expect(workedByPool([row('pool:A', 1_000, 2_000, 5_000_000), row('pool:B', 99_000, 99_000, 5_000_000)], 100_000, 86_400, 2)).toEqual([])
  })
})

describe('loadWorked', () => {
  const KEY = 'acct-worked-1'
  test('null before any snapshot; then both windows from the ledger rows', async () => {
    const db = memoryD1()
    expect(await loadWorked(db, 8453, KEY)).toBeNull()
    db.raw.exec(
      `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
       VALUES (8453, '0xsafe', '${KEY}', 'unknown', 2000000, '2026-11-02T19:00:00.000Z', 1, 0, 0, 0, 0, 0, '[]', '2026-11-02T19:00:05.000Z')`,
    )
    const seed = (day: string, tokenId: number, open: number, close: number, value: number) =>
      db.raw.exec(
        `INSERT INTO yield_ledger_position_daily (day, chain_id, token_id, account_key, address, env, pool, block_open, block_close, accrued0_open, accrued1_open, accrued_usd_open, accrued0_close, accrued1_close, accrued_usd_close, value_usd, hold_value_usd, collected0, collected1, collected_usd, fee_accrued_usd, updated_at)
         VALUES ('${day}', 8453, ${tokenId}, '${KEY}', '0xsafe', 'unknown', 'pool:WETH/USDC/3000', ${open}, ${close}, '0', '0', 0, '0', '0', 0, ${value}, ${value}, NULL, NULL, NULL, NULL, '${day}T00:00:00.000Z')`,
      )
    seed('2026-10-20', 1, 1_400_000, 1_420_000, 10_000_000) // 13 days back: the month only
    seed('2026-11-02', 2, 1_990_000, 2_000_000, 4_000_000) // the last ~5.5 h
    const w = await loadWorked(db, 8453, KEY)
    expect(w?.asOf).toBe('2026-11-02T19:00:00.000Z')
    expect(w?.day).toEqual([{ pool: 'pool:WETH/USDC/3000', usdSeconds: 4_000_000 * 10_000 * 2 }])
    expect(w?.month).toEqual([{ pool: 'pool:WETH/USDC/3000', usdSeconds: 10_000_000 * 20_000 * 2 + 4_000_000 * 10_000 * 2 }])
    expect(await loadWorked(db, 143, KEY)).toBeNull()
  })
})
