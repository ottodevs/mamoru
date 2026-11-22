import { describe, expect, test } from 'bun:test'
import type { OwnerResponse } from '@mamoru/domain'
import { memoryD1 } from './d1.ts'
import { harness, register, PASSKEY_A, PASSKEY_B, sessionCookie } from './helpers.ts'
import { loadVsIdle, mamoruFeeUsdc, MAMORU_FEE_FROM } from '../../src/api/accounts/vs-idle.ts'

// otto/mamoru#380: "vs idle USDC": net = total value - pending fees - net deposited - Mamoru fee, on realized yield.

const U = 1_000_000
const NOW = new Date('2026-11-06T18:00:00.000Z')
const t = (iso: string) => Date.parse(iso) / 1000

function seed() {
  const db = memoryD1()
  db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('u1', 'a@b.c', '2026-10-01T00:00:00.000Z')`)
  db.raw.exec(
    `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at)
     VALUES ('base-u1', 'u1', 8453, '0x00000000000000000000000000000000000000b1', '[]', 'c1', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z')`,
  )
  return db
}
type Db = ReturnType<typeof seed>
const daily = (db: Db, day: string, total: number, fees: number) =>
  db.raw.exec(
    `INSERT INTO account_daily (day, chain_id, address, account_key, env, block_open, block_close, total_open_usdc, total_close_usdc, idle_close_usdc, lp_close_usdc, fees_open_usdc, fees_close_usdc)
     VALUES ('${day}', 8453, 'base-u1', 'base-u1', 'prod', 1, 1, ${total * U}, ${total * U}, 0, ${total * U}, 0, ${fees * U})`,
  )
const latest = (db: Db, fees: number, total: number) =>
  db.raw.exec(
    `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
     VALUES (8453, 'base-u1', 'base-u1', 'prod', 1, '2026-11-06T17:50:00.000Z', 1, 0, 0, ${fees * U}, 0, ${total * U}, '[]', '2026-11-06T17:50:00.000Z')`,
  )
const flow = (db: Db, id: string, kind: 'in' | 'out', at: string, usdc: number) =>
  db.raw.exec(`INSERT INTO account_flows (chain_id, account_key, flow_id, kind, t_s, usd, updated_at) VALUES (8453, 'base-u1', '${id}', '${kind}', ${t(at)}, ${usdc * U}, '${at}')`)
const gasDay = (db: Db, day: string, wei: string, usdc: number | null) =>
  db.raw.exec(`INSERT INTO yield_ledger_account_receipts (day, chain_id, address, account_key, env, gas_paid_wei, gas_paid_usdc, collected_usdc, digest, updated_at) VALUES ('${day}', 8453, 'base-u1', 'base-u1', 'prod', '${wei}', ${usdc === null ? 'NULL' : Math.round(usdc * U)}, NULL, 'd${day}', 'x')`)
const income = (db: Db, id: string, at: string, usdc: number) =>
  db.raw.exec(`INSERT INTO yield_ledger_income (event_id, chain_id, account_key, env, source, t_s, from_s, usd, updated_at) VALUES ('${id}', 8453, 'base-u1', 'prod', 'harvest', ${t(at)}, NULL, ${usdc * U}, 'x')`)

function funded() {
  const db = seed()
  daily(db, '2026-11-04', 1000, 0)
  daily(db, '2026-11-05', 1006, 2)
  daily(db, '2026-11-06', 1010, 4)
  latest(db, 4, 1010)
  flow(db, 'in:0xa:0', 'in', '2026-11-04T09:00:00.000Z', 1000)
  income(db, '0xh1:0', '2026-11-04T12:00:00.000Z', 3) // before 5 Nov: earned, not charged
  income(db, '0xh2:0', '2026-11-05T12:00:00.000Z', 2) // charged: 0.20
  return db
}

describe('mamoruFeeUsdc', () => {
  test('10 % of income realized from 5 Nov on, up to the cut; nothing before', () => {
    const rows = [{ t_s: MAMORU_FEE_FROM - 1, usd: 100 * U }, { t_s: MAMORU_FEE_FROM, usd: 5 * U }, { t_s: MAMORU_FEE_FROM + 86_400, usd: 5 * U }]
    expect(mamoruFeeUsdc(rows, MAMORU_FEE_FROM + 1)).toBe(500_000n)
    expect(mamoruFeeUsdc(rows, MAMORU_FEE_FROM + 90_000)).toBe(1_000_000n)
    expect(mamoruFeeUsdc([{ t_s: MAMORU_FEE_FROM - 1, usd: 100 * U }], MAMORU_FEE_FROM + 90_000)).toBe(0n)
  })
})

describe('loadVsIdle', () => {
  test('rows add up exactly to net; pending is apart; the series ends on net', async () => {
    const v = await loadVsIdle(funded(), 'u1', NOW, true)
    expect(v.totalUsd).toBe(1010)
    expect(v.pendingUsd).toBe(4)
    expect(v.netDeposited).toEqual({ usd: 1000, status: 'partial', since: '2026-11-04' }) // the arithmetic is run with a complete baseline
    // net = 1010 - 4 pending - 1000 deposited - 0.20 fee = 5.80; fees earned = 5.00 realized (3 + 2)
    expect(v.breakdown).toEqual({ feesUsd: 5, priceMoveUsd: 1, costsUsd: -0, mamoruFeeUsd: -0.2, netUsd: 5.8 })
    const b = v.breakdown!
    expect(Math.round((b.feesUsd + b.priceMoveUsd! + b.mamoruFeeUsd + b.costsUsd) * 100)).toBe(Math.round(b.netUsd! * 100))
    // 11-05: 1006 - 2 pending - 1000 deposited - 0.20 (the fee on the income up to that day's end)
    expect(v.series).toEqual([
      { day: '2026-11-04', netUsd: 0 },
      { day: '2026-11-05', netUsd: 3.8 },
      { day: '2026-11-06', netUsd: 5.8 },
    ])
    expect(v.notCounted).toEqual([])
    expect(v.status).toBe('complete')
  })

  test('costs are the gas paid in USDC; the price move gives them back; unpriced gas makes costs partial, not zero', async () => {
    const db = funded()
    gasDay(db, '2026-11-05', '5000', 0.3)
    gasDay(db, '2026-11-06', '7000', 0.2)
    const v = await loadVsIdle(db, 'u1', NOW, true)
    // net 5.80 = fees 5.00 + price move 1.50 - costs 0.50 - fee 0.20
    expect(v.breakdown).toEqual({ feesUsd: 5, priceMoveUsd: 1.5, costsUsd: -0.5, mamoruFeeUsd: -0.2, netUsd: 5.8 })
    expect(v.notCounted).toEqual([])
    gasDay(db, '2026-11-07', '4000', 9) // after the last value day: not in the balance shown
    expect((await loadVsIdle(db, 'u1', NOW, true)).breakdown!.costsUsd).toBe(-0.5)
    gasDay(db, '2026-11-04', '9000', null)
    const part = await loadVsIdle(db, 'u1', NOW, true)
    expect(part.notCounted).toEqual(['costs'])
    expect(part.breakdown!.costsUsd).toBe(-0.5)
    expect(part.status).toBe('partial')
  })

  test('income newer than the balance read is not in the fee yet; a stale or carried value is named', async () => {
    const db = funded()
    income(db, '0xh3:0', '2026-11-06T17:55:00.000Z', 100) // after the 17:50 read
    const v = await loadVsIdle(db, 'u1', NOW, true)
    expect(v.breakdown!.netUsd).toBe(5.8)
    expect(v.breakdown!.mamoruFeeUsd).toBe(-0.2)
    expect(v.notCounted).toEqual([])
    const stale = await loadVsIdle(db, 'u1', new Date('2026-11-08T18:00:00.000Z'), true)
    expect(stale.notCounted).toEqual(['value'])
    expect(stale.status).toBe('partial')
  })

  test('a loss shows negative: price move carries it', async () => {
    const db = seed()
    daily(db, '2026-11-06', 970, 0)
    latest(db, 0, 970)
    flow(db, 'in:0xa:0', 'in', '2026-11-04T09:00:00.000Z', 975)
    income(db, '0xh2:0', '2026-11-05T12:00:00.000Z', 6)
    const v = await loadVsIdle(db, 'u1', NOW, true)
    expect(v.breakdown).toEqual({ feesUsd: 6, priceMoveUsd: -11, costsUsd: -0, mamoruFeeUsd: -0.6, netUsd: -5.6 })
  })

  test('the baseline is recorded flows only (never complete yet): net, price move and series are n/a, fees, costs and the fee still show', async () => {
    const v = await loadVsIdle(funded(), 'u1', NOW)
    expect(v.netDeposited.status).toBe('partial')
    expect(v.breakdown).toEqual({ feesUsd: 5, priceMoveUsd: null, costsUsd: -0, mamoruFeeUsd: -0.2, netUsd: null })
    expect(v.series).toEqual([])
    expect(v.notCounted).toEqual(['flows'])
    expect(v.status).toBe('partial')
    expect(v.totalUsd).toBe(1010)
    expect(v.pendingUsd).toBe(4)
    const db = funded()
    db.raw.exec('DELETE FROM account_flows')
    const none = await loadVsIdle(db, 'u1', NOW)
    expect(none.netDeposited.status).toBe('none')
    expect(none.breakdown!.netUsd).toBeNull()
  })

  test('nothing read yet', async () => {
    const v = await loadVsIdle(seed(), 'u1', NOW)
    expect(v).toMatchObject({ asOf: null, totalUsd: null, breakdown: null, series: [], pendingUsd: 0, since: null })
  })
})

describe('APR · 30-day avg', () => {
  const worked = (db: Db, at: string, value: number) =>
    db.raw.exec(`INSERT INTO account_worked_samples (chain_id, account_key, read_at, t_s, pool, value_usd, in_range) VALUES (8453, 'base-u1', '${at}', ${t(at)}, 'pool:WETH/USDC/3000', ${value * U}, 1)`)

  test('real net APR: income of the window net of the fee over the capital-time that worked, annualised', async () => {
    const db = seed()
    daily(db, '2026-09-01', 1000, 0)
    daily(db, '2026-11-06', 1000, 0)
    latest(db, 0, 1000)
    flow(db, 'in:0xa:0', 'in', '2026-08-30T09:00:00.000Z', 1000)
    worked(db, '2026-10-08T17:30:00.000Z', 1000) // observed across the window (the interval to the next is a gap: no capital-time)
    worked(db, '2026-11-06T17:30:00.000Z', 1000)
    worked(db, '2026-11-06T17:50:00.000Z', 1000)
    income(db, '0xh:0', '2026-11-06T17:40:00.000Z', 0.01) // 0.009 net; 1000 USDC x 1200 s
    expect((await loadVsIdle(db, 'u1', NOW)).apr).toEqual({ pct: 23.7, reason: null })
  })

  test('an account younger than 30 days has none (the app shows the Mamoru average); nothing worked is not measured', async () => {
    const db = funded()
    expect((await loadVsIdle(db, 'u1', NOW)).apr).toEqual({ pct: null, reason: 'not-measured' })
    const old = seed()
    daily(old, '2026-09-01', 1000, 0)
    daily(old, '2026-11-06', 1000, 0)
    latest(old, 0, 1000)
    worked(old, '2026-10-08T17:30:00.000Z', 1000)
    worked(old, '2026-11-06T17:30:00.000Z', 1000)
    worked(old, '2026-11-06T17:50:00.000Z', 1000)
    expect((await loadVsIdle(old, 'u1', NOW)).apr).toEqual({ pct: 0, reason: null })
    // two recent samples only: the income of the month has no capital-time behind it, so no figure
    const sparse = seed()
    daily(sparse, '2026-09-01', 1000, 0)
    daily(sparse, '2026-11-06', 1000, 0)
    latest(sparse, 0, 1000)
    worked(sparse, '2026-11-06T17:30:00.000Z', 1000)
    worked(sparse, '2026-11-06T17:50:00.000Z', 1000)
    income(sparse, '0xh:0', '2026-11-05T12:00:00.000Z', 30)
    expect((await loadVsIdle(sparse, 'u1', NOW)).apr).toEqual({ pct: null, reason: 'not-measured' })
    const young = seed()
    daily(young, '2026-10-20', 1000, 0)
    daily(young, '2026-11-06', 1000, 0)
    latest(young, 0, 1000)
    worked(young, '2026-11-06T17:30:00.000Z', 1000)
    worked(young, '2026-11-06T17:50:00.000Z', 1000)
    expect((await loadVsIdle(young, 'u1', NOW)).apr).toEqual({ pct: null, reason: 'first-30-days' })
  })
})

describe('GET /api/accounts/:key/vs-idle', () => {
  test('needs a session; another owner and a malformed key get the same 404', async () => {
    const h = harness()
    const a = await register(h, PASSKEY_A)
    const b = await register(h, PASSKEY_B)
    const owner = (await a.json()) as OwnerResponse
    expect((await h.request(`/api/accounts/${owner.accountKey}/vs-idle`)).status).toBe(401)
    expect((await h.request(`/api/accounts/${owner.accountKey}/vs-idle`, { cookie: sessionCookie(b) })).status).toBe(404)
    expect((await h.request(`/api/accounts/not-a-key/vs-idle`, { cookie: sessionCookie(a) })).status).toBe(404)
    const res = await h.request(`/api/accounts/${owner.accountKey}/vs-idle`, { cookie: sessionCookie(a) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ asOf: null, totalUsd: null, breakdown: null, series: [] })
  })
})
