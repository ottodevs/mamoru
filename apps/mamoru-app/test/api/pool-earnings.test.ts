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
const END = '2026-11-06T17:50:00.000Z'
const MONTH_AGO = '2026-10-07T17:50:00.000Z'
/** A sample every 20 minutes from `fromIso` to END, skipping [hole[0], hole[1]) when given. */
const run = (db: Db, fromIso: string, pool = 'pool:WETH/USDC/3000', hole?: [string, string]) => {
  const rows: string[] = []
  for (let x = t(fromIso); x <= t(END); x += 1200) {
    if (hole && x >= t(hole[0]) && x < t(hole[1])) continue
    rows.push(`(8453, 'base-u1', '${new Date(x * 1000).toISOString()}', ${x}, '${pool}', ${1000 * U}, 1)`)
  }
  db.raw.exec(`INSERT INTO account_worked_samples (chain_id, account_key, read_at, t_s, pool, value_usd, in_range) VALUES ${rows.join(',')}`)
}

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

  test('APR 30d: the pool\'s income of the sampled window over the capital-time of the same intervals', async () => {
    const db = seed()
    entry(db, 1, 'pool:WETH/USDC/3000')
    collected(db, '2026-10-20', 1, 0.5) // before the fee: whole; 1000 USDC x 30 days
    run(db, MONTH_AGO)
    expect(await loadPoolEarnings(db, SLEEVES)).toEqual([{ pool: 'pool:WETH/USDC/3000', earnedUsd: 0.5, aprPct: 0.6 }])
  })

  test('income of a day nobody sampled, or booked after the window\'s read, is not counted', async () => {
    const hole = seed()
    entry(hole, 1, 'pool:WETH/USDC/3000')
    collected(hole, '2026-10-21', 1, 0.5)
    run(hole, MONTH_AGO, 'pool:WETH/USDC/3000', ['2026-10-20T00:00:00.000Z', '2026-10-22T00:00:00.000Z'])
    expect((await loadPoolEarnings(hole, SLEEVES))[0]!.aprPct).toBe(0)
    const after = seed()
    entry(after, 1, 'pool:WETH/USDC/3000')
    collected(after, '2026-10-20', 1, 0.5)
    collected(after, '2026-11-09', 1, 5) // after the read of the 6th
    run(after, MONTH_AGO)
    expect((await loadPoolEarnings(after, SLEEVES))[0]!.aprPct).toBe(0.6)
  })

  test('a window sampled under the minimum has no APR (n/a), earned still shows', async () => {
    const db = seed()
    entry(db, 1, 'pool:WETH/USDC/3000')
    collected(db, '2026-11-05', 1, 1)
    run(db, '2026-10-30T00:00:00.000Z') // 7 of 30 days
    const r = await loadPoolEarnings(db, SLEEVES)
    expect(r[0]!.aprPct).toBeNull()
    expect(r[0]!.earnedUsd).toBe(0.9)
  })

  test('every contributing sleeve must be sampled enough: a thin Monad sleeve takes the APR away', async () => {
    const db = seed()
    db.raw.exec(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at) VALUES ('base-u1', 'u1', 8453, '0x00000000000000000000000000000000000000b1', '[]', 'c1', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z')`)
    db.raw.exec(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at) VALUES ('monad-u1', 'u1', 143, '0x00000000000000000000000000000000000000b1', '[]', 'c2', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z')`)
    entry(db, 1, 'pool:WETH/USDC/3000')
    collected(db, '2026-10-20', 1, 0.5)
    run(db, MONTH_AGO)
    const rows: string[] = []
    for (let x = t('2026-11-01T00:00:00.000Z'); x <= t(END); x += 1200) rows.push(`(143, 'monad-u1', '${new Date(x * 1000).toISOString()}', ${x}, 'pool:WETH/USDC/3000', ${1000 * U}, 1)`)
    db.raw.exec(`INSERT INTO account_worked_samples (chain_id, account_key, read_at, t_s, pool, value_usd, in_range) VALUES ${rows.join(',')}`)
    const both = [...SLEEVES, { chain_id: 143, account_key: 'monad-u1' }]
    expect((await loadPoolEarnings(db, both))[0]!.aprPct).toBeNull()
    expect((await loadPoolEarnings(db, SLEEVES))[0]!.aprPct).toBeNull() // loadWorked for the Base account merges the contributing Monad sleeve
  })

  test('a pool that worked a full window and collected nothing is 0 earned, 0 %', async () => {
    const db = seed()
    run(db, MONTH_AGO)
    expect(await loadPoolEarnings(db, SLEEVES)).toEqual([{ pool: 'pool:WETH/USDC/3000', earnedUsd: 0, aprPct: 0 }])
  })

  test('nothing earned yet: no rows', async () => {
    expect(await loadPoolEarnings(seed(), SLEEVES)).toEqual([])
  })
})
