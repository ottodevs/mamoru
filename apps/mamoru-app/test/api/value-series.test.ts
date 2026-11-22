import { describe, expect, test } from 'bun:test'
import type { OwnerResponse } from '@mamoru/domain'
import { memoryD1 } from './d1.ts'
import { harness, register, PASSKEY_A, PASSKEY_B, sessionCookie } from './helpers.ts'
import { loadValueSeries } from '../../src/api/accounts/value-series.ts'
import { writeFlows } from '../../src/api/flows-ledger.ts'

// Spec 013 STATS-R14 / STATS-S10, S19: the Portfolio's Total value series.

const USDC = 1_000_000
const NOW = new Date('2026-11-06T18:00:00.000Z')

function seed() {
  const db = memoryD1()
  db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('u1', 'a@b.c', '2026-10-01T00:00:00.000Z'), ('u2', 'b@b.c', '2026-10-01T00:00:00.000Z')`)
  const acct = (key: string, user: string, chain: number, safe: string, cred: string) =>
    db.raw.exec(
      `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at)
       VALUES ('${key}', '${user}', ${chain}, '${safe}', '[]', '${cred}', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z')`,
    )
  acct('base-u1', 'u1', 8453, '0x00000000000000000000000000000000000000b1', 'c1')
  acct('monad-u1', 'u1', 143, '0x00000000000000000000000000000000000000b1', 'c2')
  acct('base-u2', 'u2', 8453, '0x00000000000000000000000000000000000000b2', 'c3')
  return db
}
function daily(db: ReturnType<typeof seed>, day: string, chain: number, key: string, total: number) {
  db.raw.exec(
    `INSERT INTO account_daily (day, chain_id, address, account_key, env, block_open, block_close, total_open_usdc, total_close_usdc, idle_close_usdc, lp_close_usdc, fees_open_usdc, fees_close_usdc)
     VALUES ('${day}', ${chain}, '${key}', '${key}', 'prod', 1, 1, ${total}, ${total}, 0, ${total}, 0, 0)`,
  )
}
function latest(db: ReturnType<typeof seed>, chain: number, key: string, readAt: string) {
  db.raw.exec(
    `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
     VALUES (${chain}, '${key}', '${key}', 'prod', 1, '${readAt}', 1, 0, 0, 0, 0, 0, '[]', '${readAt}')`,
  )
}

describe('loadValueSeries', () => {
  test('S19: Base and Monad summed per day by last known value; a missing Monad day carries its close and is partial', async () => {
    const db = seed()
    daily(db, '2026-11-04', 8453, 'base-u1', 1000 * USDC)
    daily(db, '2026-11-05', 8453, 'base-u1', 1010 * USDC)
    daily(db, '2026-11-06', 8453, 'base-u1', 1020 * USDC)
    daily(db, '2026-11-05', 143, 'monad-u1', 37 * USDC) // Monad starts on the 5th, misses the 6th
    latest(db, 8453, 'base-u1', '2026-11-06T17:50:00.000Z')
    latest(db, 143, 'monad-u1', '2026-11-06T17:55:00.000Z')
    const v = await loadValueSeries(db, 'u1', NOW)
    expect(v.points).toEqual([
      { day: '2026-11-04', usd: 1000 },
      { day: '2026-11-05', usd: 1047 },
      { day: '2026-11-06', usd: 1057, partial: true },
    ])
    expect(v.chains).toEqual([8453, 143])
    expect(v.asOf).toBe('2026-11-06T17:50:00.000Z')
  })

  test('a chain read older than 30 min marks the last point partial; another owner is never summed', async () => {
    const db = seed()
    daily(db, '2026-11-06', 8453, 'base-u1', 500 * USDC)
    daily(db, '2026-11-06', 8453, 'base-u2', 9999 * USDC)
    latest(db, 8453, 'base-u1', '2026-11-06T17:00:00.000Z')
    const v = await loadValueSeries(db, 'u1', NOW)
    expect(v.points).toEqual([{ day: '2026-11-06', usd: 500, partial: true }])
  })

  test('no rows yet: empty series, no asOf', async () => {
    expect(await loadValueSeries(seed(), 'u1', NOW)).toEqual({ asOf: null, points: [], chains: [], netDeposited: { usd: 0, status: 'none' } })
  })
})

function flow(db: ReturnType<typeof seed>, chain: number, key: string, id: string, kind: 'in' | 'out', at: string, usdc: number) {
  db.raw.exec(`INSERT INTO account_flows (chain_id, account_key, flow_id, kind, t_s, usd, updated_at) VALUES (${chain}, '${key}', '${id}', '${kind}', ${Date.parse(at) / 1000}, ${usdc * USDC}, '${at}')`)
}

describe('net deposited (otto/mamoru#380)', () => {
  test('each day carries the cumulative in minus out up to its end; the total is the net now', async () => {
    const db = seed()
    daily(db, '2026-11-04', 8453, 'base-u1', 1000 * USDC)
    daily(db, '2026-11-05', 8453, 'base-u1', 1500 * USDC)
    daily(db, '2026-11-06', 8453, 'base-u1', 1100 * USDC)
    latest(db, 8453, 'base-u1', '2026-11-06T17:50:00.000Z')
    flow(db, 8453, 'base-u1', 'in:0xa:0', 'in', '2026-11-04T09:00:00.000Z', 1000)
    flow(db, 8453, 'base-u1', 'in:0xb:1', 'in', '2026-11-05T23:59:59.000Z', 400)
    flow(db, 8453, 'base-u1', 'out:0xc', 'out', '2026-11-06T08:00:00.000Z', 300)
    flow(db, 8453, 'base-u2', 'in:0xd:0', 'in', '2026-11-04T09:00:00.000Z', 9999) // another owner
    const v = await loadValueSeries(db, 'u1', NOW)
    expect(v.points.map((p) => p.deposited)).toEqual([1000, 1400, 1100])
    expect(v.netDeposited).toEqual({ usd: 1100, status: 'complete', since: '2026-11-04' })
  })

  test('value before the first known flow is partial; no flow at all is none, never a zero baseline', async () => {
    const db = seed()
    daily(db, '2026-11-01', 8453, 'base-u1', 500 * USDC)
    daily(db, '2026-11-06', 8453, 'base-u1', 520 * USDC)
    latest(db, 8453, 'base-u1', '2026-11-06T17:50:00.000Z')
    expect((await loadValueSeries(db, 'u1', NOW)).netDeposited).toEqual({ usd: 0, status: 'none' })
    flow(db, 8453, 'base-u1', 'in:0xa:0', 'in', '2026-11-05T09:00:00.000Z', 20)
    const v = await loadValueSeries(db, 'u1', NOW)
    expect(v.netDeposited.status).toBe('partial')
    expect(v.points[0]!.deposited).toBe(0)
  })

  test('Base and Monad flows of one owner are summed', async () => {
    const db = seed()
    daily(db, '2026-11-05', 8453, 'base-u1', 100 * USDC)
    daily(db, '2026-11-05', 143, 'monad-u1', 50 * USDC)
    flow(db, 8453, 'base-u1', 'in:0xa:0', 'in', '2026-11-05T01:00:00.000Z', 100)
    flow(db, 143, 'monad-u1', 'in:0xb:0', 'in', '2026-11-05T02:00:00.000Z', 40)
    expect((await loadValueSeries(db, 'u1', NOW)).netDeposited).toEqual({ usd: 140, status: 'complete', since: '2026-11-05' })
  })
})

describe('writeFlows', () => {
  test('writes each flow once for a known Safe; unknown Safes, bad rows and repeats add nothing', async () => {
    const db = seed()
    const resolve = async (chainId: number, address: string) => (chainId === 8453 && address === '0x00000000000000000000000000000000000000b1' ? { accountKey: 'base-u1' } : null)
    const snap = {
      chainId: 8453,
      receipts: [
        { safe: '0x00000000000000000000000000000000000000B1', flows: [{ id: 'in:0xa:0', t: 1_762_000_000, kind: 'in' as const, usdc: '2000000' }, { id: 'out:0xb', t: 1_762_000_100, kind: 'out' as const, usdc: '0' }] },
        { safe: '0x00000000000000000000000000000000000000ff', flows: [{ id: 'in:0xc:0', t: 1_762_000_000, kind: 'in' as const, usdc: '5' }] },
      ],
    }
    await writeFlows(db, snap, NOW, resolve)
    await writeFlows(db, snap, new Date('2026-11-07T00:00:00.000Z'), resolve)
    const rows = db.raw.query('SELECT account_key, flow_id, kind, usd, updated_at FROM account_flows').all()
    expect(rows).toEqual([{ account_key: 'base-u1', flow_id: 'in:0xa:0', kind: 'in', usd: 2_000_000, updated_at: NOW.toISOString() }])
  })
})

describe('GET /api/accounts/:key/value-series (STATS-S10)', () => {
  test('needs a session; another owner and a malformed key get the same 404', async () => {
    const h = harness()
    const a = await register(h, PASSKEY_A)
    const b = await register(h, PASSKEY_B)
    const owner = (await a.json()) as OwnerResponse
    expect((await h.request(`/api/accounts/${owner.accountKey}/value-series`)).status).toBe(401)
    expect((await h.request(`/api/accounts/${owner.accountKey}/value-series`, { cookie: sessionCookie(b) })).status).toBe(404)
    expect((await h.request(`/api/accounts/not-a-key/value-series`, { cookie: sessionCookie(a) })).status).toBe(404)
    const res = await h.request(`/api/accounts/${owner.accountKey}/value-series`, { cookie: sessionCookie(a) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ asOf: null, points: [], chains: [], netDeposited: { usd: 0, status: 'none' } })
  })
})
