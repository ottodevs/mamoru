import { describe, expect, test } from 'bun:test'
import { runOperatorMetrics, runYieldLedger } from '../../src/worker.ts'
import type { Env } from '../../src/api/env.ts'
import { memoryD1 } from './d1.ts'
import { loadWorked } from '../../src/api/accounts/worked.ts'

function envOf(db: ReturnType<typeof memoryD1>, over: Partial<Env> = {}): Env {
  return { DB: db, MODE: 'production', CHAIN_ID: '8453', CORE_DRY_RUN: 'true', SESSION_SECRET: 'x'.repeat(32), OPERATOR_URL: 'http://operator', OPERATOR_SECRET: 'op-secret', ...over }
}

function turnOn(db: ReturnType<typeof memoryD1>) {
  db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('yield_ledger', 1, 'ot', 'test', '2026-10-18T00:00:00Z')`).run()
}

describe('runYieldLedger cron gate (otto/mamoru#129: D1 flag, not an env var)', () => {
  test('no ops_flag_changes row: the flag is off, the cron never calls the operator', async () => {
    const db = memoryD1()
    let called = false
    await runYieldLedger(envOf(db), async () => {
      called = true
      return new Response(JSON.stringify({ error: 'snapshot off' }), { status: 404 })
    })
    expect(called).toBe(false)
  })

  test('the newest row turns the flag on: the cron pulls the operator', async () => {
    const db = memoryD1()
    turnOn(db)
    let called = false
    await runYieldLedger(envOf(db), async () => {
      called = true
      return new Response(JSON.stringify({ error: 'no snapshot yet' }), { status: 503 })
    })
    expect(called).toBe(true)
  })

  test('the flag on is not enough without OPERATOR_URL and OPERATOR_SECRET', async () => {
    const db = memoryD1()
    turnOn(db)
    let called = false
    const fetcher = async () => {
      called = true
      return new Response('{}', { status: 404 })
    }
    await runYieldLedger(envOf(db, { OPERATOR_URL: undefined }), fetcher)
    await runYieldLedger(envOf(db, { OPERATOR_SECRET: undefined }), fetcher)
    expect(called).toBe(false)
  })

  test('a D1 read that fails while reading the flag never throws out of the cron, and skips the pull', async () => {
    const db = memoryD1()
    const broken = { ...db, prepare: () => { throw new Error('D1_ERROR: network connection lost') } } as unknown as ReturnType<typeof memoryD1>
    let called = false
    await expect(
      runYieldLedger(envOf(broken), async () => {
        called = true
        return new Response('{}', { status: 404 })
      }),
    ).resolves.toBeUndefined()
    expect(called).toBe(false)
  })

  test('an operator error during a pull never throws out of the cron', async () => {
    const db = memoryD1()
    turnOn(db)
    await expect(
      runYieldLedger(envOf(db), async () => {
        throw new Error('connect refused')
      }),
    ).resolves.toBeUndefined()
  })
})

describe('runOperatorMetrics (otto/mamoru#129 follow-up): ungated, unlike runYieldLedger', () => {
  test('no ops_flag_changes row at all: the pull still runs (not gated by yield_ledger)', async () => {
    const db = memoryD1()
    let called = false
    await runOperatorMetrics(envOf(db), async () => {
      called = true
      return new Response('{}', { status: 404 })
    })
    expect(called).toBe(true)
  })

  test('still needs OPERATOR_URL and OPERATOR_SECRET', async () => {
    const db = memoryD1()
    let called = false
    const fetcher = async () => {
      called = true
      return new Response('{}', { status: 404 })
    }
    await runOperatorMetrics(envOf(db, { OPERATOR_URL: undefined }), fetcher)
    await runOperatorMetrics(envOf(db, { OPERATOR_SECRET: undefined }), fetcher)
    expect(called).toBe(false)
  })

  test('an operator error during a pull never throws out of the cron', async () => {
    const db = memoryD1()
    await expect(
      runOperatorMetrics(envOf(db), async () => {
        throw new Error('connect refused')
      }),
    ).resolves.toBeUndefined()
  })
})

describe('runYieldLedger: Monad worked samples (otto/mamoru#343 phase B)', () => {
  const MKEY = 'acct-monad-sleeve'
  const MSAFE = '0xabcdef0000000000000000000000000000005678'
  const seedSleeve = (db: ReturnType<typeof memoryD1>) => {
    db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('u1', 'a@b.c', '2026-10-01T00:00:00.000Z')`)
    db.raw.exec(
      `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at)
       VALUES ('${MKEY}', 'u1', 143, '${MSAFE}', '[]', 'cred', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z')`,
    )
  }
  const monadSnap = {
    chainId: 143, block: '5', readAt: new Date().toISOString(), pools: {}, calls: 1, lastError: null,
    safes: [{ accountKey: MKEY.slice(0, 8), safe: MSAFE, active: true, armed: true, deployed: true, eth: '0', tokens: {}, idleUsdc: '0', lpUsdc: '0', feesUsdc: '0', owedUsdc: '0', totalUsdc: '0',
      positions: [{ tokenId: '7', pool: 'pool:WMON/USDC/3000', token0: 'WMON', token1: 'USDC', liquidity: '10', tickLower: -1, tickUpper: 1, inRange: true, amount0: '0', amount1: '0', accrued0: '0', accrued1: '0', owed0: '0', owed1: '0', collectable0: '0', collectable1: '0', valueUsdc: '3000000', feesUsdc: '0', owedUsdc: '0' }] }],
  }
  const samples = (db: ReturnType<typeof memoryD1>) => db.raw.query('SELECT chain_id, account_key, pool, value_usd FROM account_worked_samples').all()

  test('the Monad pull writes samples and (spec 013 B1) the snapshot and daily totals under the sleeve; no Base-bound hold ledger', async () => {
    const db = memoryD1()
    seedSleeve(db)
    turnOn(db)
    const urls: string[] = []
    await runYieldLedger(envOf(db, { OPERATOR_URL_143: 'http://monad-op/' }), async (input) => {
      urls.push(String(input))
      if (String(input).startsWith('http://operator')) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify(monadSnap), { status: 200 })
    })
    expect(urls).toEqual(['http://operator/snapshot', 'http://monad-op/snapshot'])
    expect(samples(db)).toEqual([{ chain_id: 143, account_key: MKEY, pool: 'pool:WMON/USDC/3000', value_usd: 3_000_000 }])
    expect(db.raw.query('SELECT count(*) AS n FROM yield_ledger_position_daily').get()).toEqual({ n: 0 })
    expect(db.raw.query('SELECT chain_id, account_key FROM account_snapshot_latest').all()).toEqual([{ chain_id: 143, account_key: MKEY }])
    expect(db.raw.query('SELECT chain_id, account_key FROM account_daily').all()).toEqual([{ chain_id: 143, account_key: MKEY }])
  })
  test('404 (its loop is off) is skipped quietly; flag off or no URL never calls it', async () => {
    const db = memoryD1()
    seedSleeve(db)
    const calls: string[] = []
    const f = async (input: unknown) => (calls.push(String(input)), new Response('{"error":"snapshot off"}', { status: 404 }))
    await runYieldLedger(envOf(db, { OPERATOR_URL_143: 'http://monad-op' }), f)
    expect(calls).toEqual([])
    turnOn(db)
    await runYieldLedger(envOf(db, { OPERATOR_URL_143: 'http://monad-op' }), f)
    expect(calls).toEqual(['http://operator/snapshot', 'http://monad-op/snapshot'])
    expect(samples(db)).toEqual([])
    calls.length = 0
    await runYieldLedger(envOf(db), f)
    expect(calls).toEqual(['http://operator/snapshot'])
  })
  test('the Base pull and the Monad pull are independent: Base unreachable, Monad still stored', async () => {
    const db = memoryD1()
    seedSleeve(db)
    turnOn(db)
    await runYieldLedger(envOf(db, { OPERATOR_URL_143: 'http://monad-op' }), async (input) => {
      if (String(input).startsWith('http://operator')) throw new Error('down')
      return new Response(JSON.stringify(monadSnap), { status: 200 })
    })
    expect(samples(db)).toHaveLength(1)
    expect(await loadWorked(db, 143, MKEY)).not.toBeNull()
  })
})
