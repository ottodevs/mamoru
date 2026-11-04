import { describe, expect, test } from 'bun:test'
import { memoryD1 } from './d1.ts'
import { loadWorked } from '../../src/api/accounts/worked.ts'
import { writeWorkedSamples, type PositionWire, type SafeWire, type SnapshotWire } from '../../src/api/yield-ledger.ts'
import { workedRate, DAY_S } from '../../src/web/lib/rates.ts'
import type { ApyView, FundingView } from '@mamoru/domain'

// Brais, 2 Nov / otto/mamoru#343: the APY counts only the capital that worked, measured at each snapshot.

const CHAIN = 8453
const SAFE = '0xabcdef0000000000000000000000000000001234'
const KEY = 'acct-worked-1'
const USDC = 1_000_000

function seed() {
  const db = memoryD1()
  db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('u1', 'a@b.c', '2026-10-01T00:00:00.000Z')`)
  db.raw.exec(
    `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at)
     VALUES ('${KEY}', 'u1', ${CHAIN}, '${SAFE}', '[]', 'cred', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z')`,
  )
  return db
}

const pos = (tokenId: string, pool: string, valueUsdc: number, over: Partial<PositionWire> = {}): PositionWire => ({
  tokenId, pool, token0: 'USDC', token1: 'X', liquidity: '1000', tickLower: -1, tickUpper: 1, inRange: true, amount0: '0', amount1: '0', accrued0: '0', accrued1: '0', owed0: '0', owed1: '0',
  collectable0: '0', collectable1: '0', valueUsdc: String(valueUsdc), feesUsdc: '0', owedUsdc: '0', ...over,
})
const safe = (positions: PositionWire[], vaults?: SafeWire['vaults']): SafeWire => ({
  accountKey: KEY.slice(0, 8), safe: SAFE, active: true, armed: true, deployed: true, eth: '0', tokens: {}, positions, idleUsdc: '0', lpUsdc: '0', feesUsdc: '0', owedUsdc: '0', totalUsdc: '0', ...(vaults ? { vaults } : {}),
})
const snap = (readAt: string, safes: SafeWire[]): SnapshotWire => ({ chainId: CHAIN, block: '1', readAt, pools: {}, safes, calls: 1, lastError: null })
const T0 = Date.parse('2026-11-03T12:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const NOW = new Date(T0 + 3 * 86_400_000)
const rowsOf = (db: ReturnType<typeof memoryD1>) => db.raw.query('SELECT pool, value_usd, in_range, read_at FROM account_worked_samples ORDER BY read_at, pool').all() as { pool: string; value_usd: number; in_range: number; read_at: string }[]

describe('writeWorkedSamples', () => {
  test('stores samples only: one row per pool with its value and time', async () => {
    const db = seed()
    await writeWorkedSamples(db, snap(at(0), [safe([pos('1', 'pool:A', 5 * USDC)])]), NOW)
    await writeWorkedSamples(db, snap(at(300), [safe([pos('1', 'pool:A', 6 * USDC)])]), NOW)
    expect(rowsOf(db).map((r) => [r.read_at, r.value_usd])).toEqual([[at(0), 5 * USDC], [at(300), 6 * USDC]])
  })
  test('the same snapshot pulled twice (beta and prod) counts once', async () => {
    const db = seed()
    const s = (t: number) => snap(at(t), [safe([pos('1', 'pool:A', USDC)])])
    await writeWorkedSamples(db, s(0), NOW)
    await writeWorkedSamples(db, s(300), NOW)
    await writeWorkedSamples(db, s(300), NOW)
    expect(rowsOf(db)).toHaveLength(2)
    expect((await loadWorked(db, CHAIN, KEY))?.day).toEqual([{ pool: 'pool:A', usdSeconds: USDC * 300 }])
  })
  test('two Workers writing different snapshots of one account: 630 s from the 12:00 anchor, not 1230', async () => {
    const db = seed()
    const s = (t: number) => snap(at(t), [safe([pos('1', 'pool:A', USDC)])])
    await writeWorkedSamples(db, s(0), NOW) // 12:00
    await writeWorkedSamples(db, s(600), NOW) // 12:10, one Worker
    await writeWorkedSamples(db, s(630), NOW) // 12:10:30, the other, which never saw 12:10
    expect((await loadWorked(db, CHAIN, KEY))?.day).toEqual([{ pool: 'pool:A', usdSeconds: USDC * 630 }])
  })
  test('a batch that fails leaves nothing; the retry writes every pool', async () => {
    const db = seed()
    const s = snap(at(0), [safe([pos('1', 'pool:A', USDC), pos('2', 'pool:B', 2 * USDC)])])
    let fail = true
    const flaky = { ...db, batch: async (st: Parameters<typeof db.batch>[0]) => {
      if (fail) {
        fail = false
        // The first statement would be applied, then the second throws: the transaction undoes it.
        db.raw.exec('BEGIN')
        try { await (st[0] as unknown as { run(): Promise<unknown> }).run(); throw new Error('boom') } catch { db.raw.exec('ROLLBACK') }
        throw new Error('boom')
      }
      return db.batch(st)
    } }
    await expect(writeWorkedSamples(flaky, s, NOW)).rejects.toThrow('boom')
    expect(rowsOf(db)).toHaveLength(0)
    await writeWorkedSamples(flaky, s, NOW)
    expect(rowsOf(db).map((r) => r.pool)).toEqual(['pool:A', 'pool:B'])
  })
  test('a 26-minute gap counts nothing, and the next snapshot counts again', async () => {
    const db = seed()
    const s = (t: number) => snap(at(t), [safe([pos('1', 'pool:A', USDC)])])
    await writeWorkedSamples(db, s(0), NOW)
    await writeWorkedSamples(db, s(26 * 60), NOW)
    await writeWorkedSamples(db, s(26 * 60 + 300), NOW)
    expect((await loadWorked(db, CHAIN, KEY))?.day).toEqual([{ pool: 'pool:A', usdSeconds: USDC * 300 }])
  })
  test('an emptied NFT (liquidity 0, value 0) is not written; a vault is, in range', async () => {
    const db = seed()
    const s = (t: number) => snap(at(t), [safe([pos('1', 'pool:USDC/cbBTC/500', 0, { liquidity: '0' }), pos('2', 'pool:A', USDC)], [{ name: 'vault:gtUSDCp', shares: '1', valueUsdc: String(2 * USDC) }])])
    await writeWorkedSamples(db, s(0), NOW)
    expect(rowsOf(db).map((r) => [r.pool, r.value_usd, r.in_range])).toEqual([['pool:A', USDC, 1], ['vault:gtUSDCp', 2 * USDC, 1]])
  })
  test('a snapshot with nothing working still leaves its time: idle time between two invested snapshots is not counted', async () => {
    const db = seed()
    const on = (t: number) => snap(at(t), [safe([pos('1', 'pool:A', USDC)])])
    const off = (t: number) => snap(at(t), [{ ...safe([]), idleUsdc: String(7 * USDC) }])
    await writeWorkedSamples(db, on(0), NOW)
    await writeWorkedSamples(db, on(300), NOW)
    await writeWorkedSamples(db, off(600), NOW)
    await writeWorkedSamples(db, off(900), NOW)
    await writeWorkedSamples(db, on(1200), NOW)
    expect(rowsOf(db).filter((r) => r.pool === 'idle').map((r) => [r.value_usd, r.in_range])).toEqual([[7 * USDC, 0], [7 * USDC, 0]])
    // 0-300 and 900-1200 at $1 as measured; the idle snapshots in between are in range 0. Intervals (300,600], (600,900] belong to the idle samples.
    expect((await loadWorked(db, CHAIN, KEY))?.day).toEqual([{ pool: 'pool:A', usdSeconds: USDC * (300 + 300) }])
  })
  test('an account with nothing working has an asOf and no worked capital', async () => {
    const db = seed()
    await writeWorkedSamples(db, snap(at(0), [safe([])]), NOW)
    expect(await loadWorked(db, CHAIN, KEY)).toEqual({ asOf: at(0), day: [], month: [] })
  })
  test('positions of one pool add up; an out of range one is kept but never counted', async () => {
    const db = seed()
    const s = (t: number) => snap(at(t), [safe([pos('1', 'pool:A', USDC), pos('2', 'pool:A', 2 * USDC), pos('3', 'pool:B', 9 * USDC, { inRange: false })])])
    await writeWorkedSamples(db, s(0), NOW)
    await writeWorkedSamples(db, s(60), NOW)
    expect(await loadWorked(db, CHAIN, KEY)).toMatchObject({ day: [{ pool: 'pool:A', usdSeconds: 3 * USDC * 60 }] })
  })
  test('rows older than 31 days are deleted', async () => {
    const db = seed()
    await writeWorkedSamples(db, snap(at(-32 * 86_400), [safe([pos('1', 'pool:A', USDC)])]), new Date(T0 - 32 * 86_400_000))
    await writeWorkedSamples(db, snap(at(0), [safe([pos('1', 'pool:A', USDC)])]), new Date(T0))
    expect(rowsOf(db).map((r) => r.read_at)).toEqual([at(0)])
  })
})

describe('loadWorked', () => {
  test('null before any sample; null on a chain with none', async () => {
    const db = seed()
    expect(await loadWorked(db, CHAIN, KEY)).toBeNull()
    await writeWorkedSamples(db, snap(at(0), [safe([pos('1', 'pool:A', USDC)])]), NOW)
    expect(await loadWorked(db, 143, KEY)).toBeNull()
  })
  test('window clipping: a sample older than 24 h counts for the month only', async () => {
    const db = seed()
    const s = (t: number) => snap(at(t), [safe([pos('1', 'pool:A', USDC)])])
    const T = (d: number, m: number) => -d * 86_400 + m * 300
    for (let m = 0; m <= 12; m++) await writeWorkedSamples(db, s(T(2, m)), NOW)
    for (let m = -12; m <= 0; m++) await writeWorkedSamples(db, s(T(0, m)), NOW)
    const w = await loadWorked(db, CHAIN, KEY)
    expect(w?.asOf).toBe(at(0))
    expect(w?.day).toEqual([{ pool: 'pool:A', usdSeconds: USDC * 12 * 300 }])
    expect(w?.month).toEqual([{ pool: 'pool:A', usdSeconds: USDC * 24 * 300 }])
  })
  test('a sample 1 s inside the 24 h boundary stands for 1 s of the day and 600 s of the month', async () => {
    const db = seed()
    const row = (t: number) => db.raw.exec(`INSERT INTO account_worked_samples (chain_id, account_key, read_at, t_s, pool, value_usd, in_range) VALUES (${CHAIN}, '${KEY}', '${at(t)}', ${T0 / 1000 + t}, 'pool:A', ${USDC}, 1)`)
    row(-86_999)
    row(-86_399) // stands for (-86_999, -86_399]; the window starts at -86_400
    row(0)
    const w = await loadWorked(db, CHAIN, KEY)
    // (-86_399, 0] is a gap (over 25 min) and counts nothing.
    expect(w?.day).toEqual([{ pool: 'pool:A', usdSeconds: USDC * 1 }])
    expect(w?.month).toEqual([{ pool: 'pool:A', usdSeconds: USDC * 600 }])
  })
  test('a sample 1 s inside the boundary, snapshots continuous after it: 1 s of the day', async () => {
    const db = seed()
    const row = (t: number) => db.raw.exec(`INSERT INTO account_worked_samples (chain_id, account_key, read_at, t_s, pool, value_usd, in_range) VALUES (${CHAIN}, '${KEY}', '${at(t)}', ${T0 / 1000 + t}, 'pool:A', ${USDC}, 1)`)
    row(-86_999)
    row(-86_399)
    for (let t = -86_399 + 600; t < 0; t += 600) row(t)
    row(0)
    const day = (await loadWorked(db, CHAIN, KEY))?.day
    expect(day).toEqual([{ pool: 'pool:A', usdSeconds: USDC * 86_400 }]) // 1 s from the first interval + the rest of the day
  })
  test('the reviewer\'s case: A $1 for 23h40 then $1000 for 10 min, B $100 for 24 h, is 3.66 % not 11.18 %', async () => {
    const db = seed()
    // A snapshot every 5 min over 24 h. A is not there for the first 10 min, then $1 for 23h40, then $1000 for the last
    // 10 min; B is $100 throughout.
    const n = 288
    for (let i = 0; i <= n; i++) {
      const a = i <= 2 ? 0 : i > n - 2 ? 1000 : 1
      await writeWorkedSamples(db, snap(at(-86_400 + i * 300), [safe([...(a ? [pos('1', 'pool:A', a * USDC)] : []), pos('2', 'pool:B', 100 * USDC)])]), NOW)
    }
    const w = await loadWorked(db, CHAIN, KEY)
    const apy: ApyView = { pool: 'x', currentPct: 0, currentWindow: '24h', currentSource: 's', monthlyPct: 0, monthlySource: 's', byPool: [{ pool: 'pool:A', weight: 0, currentPct: 12, monthlyPct: 12 }, { pool: 'pool:B', weight: 0, currentPct: 3, monthlyPct: 3 }], asOf: '' }
    const f = { positions: [] } as unknown as FundingView
    const r = workedRate(f, w!.day, apy, 'currentPct', DAY_S)
    // A: 1 x 23h40 + 1000 x 10 min = 685_200 $s; B: 100 x 24 h = 8_640_000 $s.
    // (12 x 685_200 + 3 x 8_640_000) / 9_325_200 = 3.66 (the review's 3.67 rounds the same figures), nowhere near 11.18.
    expect(r.pct).toBe(3.66)
  })
})

// otto/mamoru#343 phase B: the owner's Monad sleeve is measured like the Base account and merged into its view.
describe('loadWorked with the owner\'s Monad sleeve', () => {
  const MKEY = 'acct-worked-monad'
  const MSAFE = '0xabcdef0000000000000000000000000000005678'
  const withSleeve = (db: ReturnType<typeof seed>, user = 'u1') =>
    db.raw.exec(
      `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at)
       VALUES ('${MKEY}', '${user}', 143, '${MSAFE}', '[]', 'cred-m', '0x1', '0x2', '2', 'v1', '2026-10-01T00:00:00.000Z')`,
    )
  const monad = (t: number, value: number): SnapshotWire => ({ ...snap(at(t), [{ ...safe([pos('7', 'pool:WMON/USDC/3000', value)]), safe: MSAFE, accountKey: MKEY.slice(0, 8) }]), chainId: 143 })
  const base = (t: number) => snap(at(t), [safe([pos('1', 'pool:A', USDC)])])

  test('Base and Monad samples merge per pool, each interval from its own times; chains names Monad', async () => {
    const db = seed()
    withSleeve(db)
    await writeWorkedSamples(db, base(0), NOW)
    await writeWorkedSamples(db, base(300), NOW)
    await writeWorkedSamples(db, monad(100, 2 * USDC), NOW)
    await writeWorkedSamples(db, monad(400, 2 * USDC), NOW)
    const w = await loadWorked(db, CHAIN, KEY)
    expect(w?.asOf).toBe(at(400))
    // Base (0, 300] = 300 s; Monad (100, 400] = 300 s, the window ends at 400 for both.
    expect(w?.day).toEqual([{ pool: 'pool:A', usdSeconds: USDC * 300 }, { pool: 'pool:WMON/USDC/3000', usdSeconds: 2 * USDC * 300 }])
    expect(w?.chains).toEqual({ day: [143], month: [143] })
  })
  test('a sleeve with no samples adds no chains (the note stays); one with samples older than the day counts for the month only', async () => {
    const db = seed()
    withSleeve(db)
    await writeWorkedSamples(db, base(0), NOW)
    await writeWorkedSamples(db, base(300), NOW)
    expect((await loadWorked(db, CHAIN, KEY))?.chains).toBeUndefined()
    await writeWorkedSamples(db, monad(-2 * 86_400, USDC), NOW)
    await writeWorkedSamples(db, monad(-2 * 86_400 + 300, USDC), NOW)
    expect((await loadWorked(db, CHAIN, KEY))?.chains).toEqual({ day: [], month: [143] })
  })
  test('no sleeve: the view has no chains key; another owner\'s sleeve is never merged', async () => {
    const db = seed()
    db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('u2', 'x@y.z', '2026-10-01T00:00:00.000Z')`)
    withSleeve(db, 'u2')
    await writeWorkedSamples(db, base(0), NOW)
    await writeWorkedSamples(db, monad(0, USDC), NOW)
    await writeWorkedSamples(db, monad(300, USDC), NOW)
    expect(await loadWorked(db, CHAIN, KEY)).toEqual({ asOf: at(0), day: [], month: [] })
  })
})
