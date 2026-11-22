import { describe, expect, test } from 'bun:test'
import { memoryD1 } from './d1.ts'
import { loadPoolEarnings } from '../../src/api/accounts/pool-earnings.ts'

// otto/mamoru#380: per pool or vault, realized income net of the 10 % fee (from 5 Nov), and APR 30d where it was measured.

const U = 1_000_000
const t = (iso: string) => Date.parse(iso) / 1000
const SLEEVES = [{ chain_id: 8453, account_key: 'base-u1' }]

function seed() {
  const db = memoryD1()
  db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('u1', 'a@b.c', '2026-10-01T00:00:00.000Z')`)
  return db
}
type Db = ReturnType<typeof seed>
const entry = (db: Db, token: number, pool: string) =>
  db.raw.exec(`INSERT INTO yield_ledger_position_entry (chain_id, token_id, account_key, address, env, pool, entry_day, entry_block, entry_amount0, entry_amount1, captured_at) VALUES (8453, ${token}, 'base-u1', 'a', 'prod', '${pool}', '2026-10-20', 1, '0', '0', 'x')`)
const collected = (db: Db, day: string, token: number, usdc: number) =>
  db.raw.exec(`INSERT INTO yield_ledger_position_collected (day, chain_id, token_id, account_key, address, env, collected0, collected1, collected_usd, updated_at) VALUES ('${day}', 8453, ${token}, 'base-u1', 'a', 'prod', '0', '0', ${Math.round(usdc * U)}, 'x')`)
const vault = (db: Db, id: string, at: string, usdc: number) =>
  db.raw.exec(`INSERT INTO yield_ledger_income (event_id, chain_id, account_key, env, source, t_s, from_s, usd, updated_at) VALUES ('${id}', 8453, 'base-u1', 'prod', '${id.startsWith('vault-backfill') ? 'backfill' : 'vault-yield'}', ${t(at)}, ${t(at) - 600}, ${Math.round(usdc * U)}, 'x')`)
const worked = (db: Db, at: string, pool: string, value: number) =>
  db.raw.exec(`INSERT INTO account_worked_samples (chain_id, account_key, read_at, t_s, pool, value_usd, in_range) VALUES (8453, 'base-u1', '${at}', ${t(at)}, '${pool}', ${value * U}, 1)`)

describe('loadPoolEarnings', () => {
  test('earned per pool across re-ranged positions and vaults, net of the fee only from 5 Nov', async () => {
    const db = seed()
    entry(db, 1, 'pool:WETH/USDC/3000')
    entry(db, 2, 'pool:WETH/USDC/3000') // the re-ranged position of the same pool
    collected(db, '2026-11-04', 1, 2) // before the fee: whole
    collected(db, '2026-11-06', 2, 1) // 0.90 net
    vault(db, 'vault:8453:base-u1:vault:gtUSDCp:' + t('2026-11-06T10:00:00.000Z'), '2026-11-06T10:00:00.000Z', 0.5) // 0.45 net
    const r = await loadPoolEarnings(db, SLEEVES)
    expect(r).toEqual([
      { pool: 'pool:WETH/USDC/3000', earnedUsd: 2.9, aprPct: null },
      { pool: 'vault:gtUSDCp', earnedUsd: 0.45, aprPct: null },
    ])
  })

  test('APR 30d only where capital worked in the pool across an observed window', async () => {
    const db = seed()
    entry(db, 1, 'pool:WETH/USDC/3000')
    collected(db, '2026-11-06', 1, 0.01) // 0.009 net
    worked(db, '2026-10-08T17:30:00.000Z', 'pool:WETH/USDC/3000', 1000)
    worked(db, '2026-11-06T17:30:00.000Z', 'pool:WETH/USDC/3000', 1000)
    worked(db, '2026-11-06T17:50:00.000Z', 'pool:WETH/USDC/3000', 1000) // 1000 USDC x 1200 s
    const r = await loadPoolEarnings(db, SLEEVES)
    expect(r).toEqual([{ pool: 'pool:WETH/USDC/3000', earnedUsd: 0.01, aprPct: 23.7 }])
  })

  test('a pool that worked a full window and collected nothing is 0 earned, 0 %', async () => {
    const db = seed()
    worked(db, '2026-10-08T17:30:00.000Z', 'pool:WETH/USDC/3000', 1000)
    worked(db, '2026-11-06T17:30:00.000Z', 'pool:WETH/USDC/3000', 1000)
    worked(db, '2026-11-06T17:50:00.000Z', 'pool:WETH/USDC/3000', 1000)
    expect(await loadPoolEarnings(db, SLEEVES)).toEqual([{ pool: 'pool:WETH/USDC/3000', earnedUsd: 0, aprPct: 0 }])
  })

  test('nothing earned yet: no rows', async () => {
    expect(await loadPoolEarnings(seed(), SLEEVES)).toEqual([])
  })
})
