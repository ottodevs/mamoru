import { describe, expect, test } from 'bun:test'
import { memoryD1 } from './d1.ts'
import { loadValueSeries } from '../../src/api/accounts/value-series.ts'
import { writeCover, type FlowCoverWire } from '../../src/api/flow-cover.ts'

// otto/mamoru#438: net deposited is complete only on the operator's word, per chain with value.

const USDC = 1_000_000
const NOW = new Date('2026-11-06T18:00:00.000Z')
const S1 = '0x00000000000000000000000000000000000000b1'
const S2 = '0x00000000000000000000000000000000000000c1'

function seed() {
  const db = memoryD1()
  db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('u1', 'a@b.c', '2026-10-01T00:00:00.000Z')`)
  const acct = (key: string, chain: number, safe: string, cred: string) =>
    db.raw.exec(
      `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at)
       VALUES ('${key}', 'u1', ${chain}, '${safe}', '[]', '${cred}', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z')`,
    )
  acct('base-u1', 8453, S1, 'c1')
  acct('monad-u1', 143, S2, 'c2')
  return db
}
type Db = ReturnType<typeof seed>
function daily(db: Db, day: string, chain: number, key: string, total: number, blockOpen: number) {
  db.raw.exec(
    `INSERT INTO account_daily (day, chain_id, address, account_key, env, block_open, block_close, total_open_usdc, total_close_usdc, idle_close_usdc, lp_close_usdc, fees_open_usdc, fees_close_usdc)
     VALUES ('${day}', ${chain}, '${key}', '${key}', 'prod', ${blockOpen}, ${blockOpen + 10}, ${total}, ${total}, 0, ${total}, 0, 0)`,
  )
}
function latest(db: Db, chain: number, key: string, block: number) {
  db.raw.exec(
    `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
     VALUES (${chain}, '${key}', '${key}', 'prod', ${block}, '2026-11-06T17:55:00.000Z', 1, 0, 0, 0, 0, 0, '[]', '2026-11-06T17:55:00.000Z')`,
  )
}
function flow(db: Db, chain: number, key: string, id: string, kind: 'in' | 'out' | 'gap', at: string, usdc: number) {
  db.raw.exec(`INSERT INTO account_flows (chain_id, account_key, flow_id, kind, t_s, usd, updated_at) VALUES (${chain}, '${key}', '${id}', '${kind}', ${Date.parse(at) / 1000}, ${usdc * USDC}, '${at}')`)
}
const resolve = async (chainId: number, address: string) => (chainId === 8453 && address === S1 ? { accountKey: 'base-u1' } : chainId === 143 && address === S2 ? { accountKey: 'monad-u1' } : null)
const cover = (db: Db, chainId: number, safe: string, c: FlowCoverWire) => writeCover(db, { chainId, receipts: [{ safe, cover: c }] }, NOW, resolve)
const status = async (db: Db) => (await loadValueSeries(db, 'u1', NOW)).netDeposited.status

/** Base funded on the 4th (first read at block 100), topped up on the 5th; read through block 500. */
function base(db: Db) {
  daily(db, '2026-11-04', 8453, 'base-u1', 1000 * USDC, 100)
  daily(db, '2026-11-05', 8453, 'base-u1', 1500 * USDC, 300)
  latest(db, 8453, 'base-u1', 500)
  flow(db, 8453, 'base-u1', 'in:0xa:0', 'in', '2026-11-04T09:00:00.000Z', 1000)
  flow(db, 8453, 'base-u1', 'in:0xb:0', 'in', '2026-11-05T09:00:00.000Z', 500)
}

describe('net deposited complete (otto/mamoru#438)', () => {
  test('a cover from before the first read, through the latest read, nothing open and the first day explained: complete', async () => {
    const db = seed()
    base(db)
    expect(await status(db)).toBe('partial') // no cover yet
    await cover(db, 8453, S1, { from: 50, through: 500, open: [], mints: [] })
    expect((await loadValueSeries(db, 'u1', NOW)).netDeposited).toEqual({ usd: 1500, status: 'complete', since: '2026-11-04' })
  })

  test('first-day check (second line of defence; the operator sends no cover over a funded start): a Safe funded before the deposit look plus a recorded top-up is partial even with the cover row', async () => {
    const db = seed()
    daily(db, '2026-11-04', 8453, 'base-u1', 1000 * USDC, 100) // 1000 USDC there on the first read, never recorded
    daily(db, '2026-11-05', 8453, 'base-u1', 1500 * USDC, 300)
    latest(db, 8453, 'base-u1', 500)
    flow(db, 8453, 'base-u1', 'in:0xb:0', 'in', '2026-11-05T09:00:00.000Z', 500)
    await cover(db, 8453, S1, { from: 50, through: 500, open: [], mints: [] })
    expect(await status(db)).toBe('partial')
  })

  test('cover block: a cover that starts after the first read is partial, even on the same UTC day', async () => {
    const db = seed()
    base(db)
    await cover(db, 8453, S1, { from: 101, through: 500, open: [], mints: [] })
    expect(await status(db)).toBe('partial')
  })

  test('an open reason pins nothing: the next pull replaces it', async () => {
    const db = seed()
    base(db)
    await cover(db, 8453, S1, { from: 50, through: 500, open: ['out:own-1'], mints: [] })
    expect(await status(db)).toBe('partial')
    await cover(db, 8453, S1, { from: 50, through: 500, open: [], mints: [] })
    expect(await status(db)).toBe('complete')
  })

  test('a cover behind the latest read (not sent or not written since) or with an arrival not recorded yet is partial; old gap rows are not read', async () => {
    const db = seed()
    base(db)
    flow(db, 8453, 'base-u1', 'gap:deposits-cap', 'gap', '2026-11-01T00:00:00.000Z', 0)
    await cover(db, 8453, S1, { from: 50, through: 499, open: [], mints: [] })
    expect(await status(db)).toBe('partial')
    await cover(db, 8453, S1, { from: 50, open: [], mints: [] })
    expect(await status(db)).toBe('partial')
    await cover(db, 8453, S1, { from: 50, through: 500, open: [], mints: [] })
    expect(await status(db)).toBe('complete')
  })

  test('per chain: a Monad sleeve with value needs its own cover; its mints must match a transfer between the owner Safes', async () => {
    const db = seed()
    base(db)
    await cover(db, 8453, S1, { from: 50, through: 500, open: [], mints: [] })
    // 400 bridged Base -> Monad on the 5th: burned on Base, minted on Monad at block 7000.
    daily(db, '2026-11-05', 143, 'monad-u1', 400 * USDC, 7100)
    latest(db, 143, 'monad-u1', 9000)
    db.raw.exec(`UPDATE account_daily SET total_close_usdc = ${1100 * USDC} WHERE chain_id = 8453 AND day = '2026-11-05'`)
    expect(await status(db)).toBe('partial') // Monad has no cover
    const mint = { block: 7000, t: Date.parse('2026-11-05T12:00:00.000Z') / 1000, usdc: String(400 * USDC) }
    await cover(db, 143, S2, { from: 6000, through: 9000, open: [], mints: [mint] })
    expect(await status(db)).toBe('partial') // the mint matches nothing: money from elsewhere
    db.raw.exec(
      `INSERT INTO yield_ledger_bridges (id, direction, account_key, env, amount_usdc, state, burn_block, burn_at, minted_block, minted_at, updated_at)
       VALUES ('b1', 'out', 'base-u1', 'prod', ${400 * USDC}, 'minted', 350, '2026-11-05T11:00:00.000Z', 7000, '2026-11-05T12:00:00.000Z', '2026-11-05T12:00:00.000Z')`,
    )
    const v = await loadValueSeries(db, 'u1', NOW)
    expect(v.netDeposited).toEqual({ usd: 1500, status: 'complete', since: '2026-11-04' }) // the bridge is not a deposit
    // One own bridge matches one mint, of its amount: a second mint in the same block is money from elsewhere.
    await cover(db, 143, S2, { from: 6000, through: 9000, open: [], mints: [mint, { ...mint, usdc: String(10_000 * USDC) }] })
    expect(await status(db)).toBe('partial')
    await cover(db, 143, S2, { from: 6000, through: 9000, open: [], mints: [{ ...mint, usdc: String(4_000 * USDC) }] })
    expect(await status(db)).toBe('partial')
  })

  test('a mint on a chain whose first day it does not explain, or flows on a chain without value, is partial', async () => {
    const db = seed()
    base(db)
    await cover(db, 8453, S1, { from: 50, through: 500, open: [], mints: [] })
    flow(db, 143, 'monad-u1', 'in:0xm:0', 'in', '2026-11-05T09:00:00.000Z', 10)
    expect(await status(db)).toBe('partial')
  })
})

describe('writeCover', () => {
  test('one row per chain and account, replaced each pull; unknown Safes and malformed covers are not written', async () => {
    const db = seed()
    expect(await writeCover(db, { chainId: 8453, receipts: [{ safe: S1.toUpperCase().replace('0X', '0x'), cover: { from: 1, through: 2, open: ['x'], mints: [] } }, { safe: '0xff', cover: { from: 1, open: [], mints: [] } }, { safe: S1, cover: { from: -1, open: [], mints: [] } }] }, NOW, resolve)).toBe(1)
    await writeCover(db, { chainId: 8453, receipts: [{ safe: S1, cover: { from: 1, open: [], mints: [] } }] }, NOW, resolve)
    // A flow writeFlows would skip: the cover is not written (the row stays as it was).
    expect(await writeCover(db, { chainId: 8453, receipts: [{ safe: S1, flows: [{ id: 'in:0x1:0', t: 1, kind: 'in', usdc: '0' }], cover: { from: 9, through: 9, open: [], mints: [] } }] }, NOW, resolve)).toBe(0)
    expect(db.raw.query('SELECT chain_id, account_key, from_block, through_block, open_json, mints_json FROM account_flow_cover').all()).toEqual([
      { chain_id: 8453, account_key: 'base-u1', from_block: 1, through_block: null, open_json: '[]', mints_json: '[]' },
    ])
  })
})
