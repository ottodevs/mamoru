import { describe, expect, test } from 'bun:test'
import type { StatsView } from '@mamoru/domain'
import { memoryD1 } from './d1.ts'
import { harness } from './helpers.ts'
import { inFlightNow, rowExposure, statsInput } from '../../src/api/stats/queries.ts'
import { guardStats } from '../../src/api/stats/privacy.ts'
import { refreshStatsView, STORED_TTL_S } from '../../src/api/stats/routes.ts'

// Spec 013 amendment A1, task A1-D3: GET /api/stats v2 from D1 fixtures.

const USDC = 1_000_000
const NOW = new Date('2026-11-06T19:00:00.000Z')
const READ = '2026-11-06T18:55:00.000Z'
type Db = ReturnType<typeof memoryD1>
const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`

function user(db: Db, id: string) {
  db.raw.exec(`INSERT INTO users (user_id, email, created_at) VALUES ('${id}', '${id}@x.y', '2026-10-01T00:00:00.000Z')`)
}
function account(db: Db, key: string, userId: string, chain: number, address: string, env = 'prod', isTest = 0) {
  db.raw.exec(
    `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at, env, is_test)
     VALUES ('${key}', '${userId}', ${chain}, '${address}', '[]', 'cred-${key}', '0x1', '0x2', '1', 'v1', '2026-10-01T00:00:00.000Z', '${env}', ${isTest})`,
  )
}
/** A latest row: idle (by token), one USDC/WETH position split 60/40, and a vault (the remainder of total). */
function latest(db: Db, chain: number, key: string, o: { idle: number; lp: number; vault: number; fees?: number; tokens?: Record<string, number> | null; readAt?: string; block?: number }) {
  const fees = o.fees ?? 0
  const positions = o.lp > 0 ? [{ tokenId: '1', pool: 'pool:WETH/USDC/500', token0: 'WETH', token1: 'USDC', valueUsdc: String(o.lp), value0Usdc: String(o.lp * 0.4), value1Usdc: String(o.lp * 0.6), feesUsdc: String(fees), owedUsdc: '0' }] : []
  const tokens = o.tokens === null ? 'NULL' : `'${JSON.stringify(Object.fromEntries(Object.entries(o.tokens ?? { USDC: o.idle }).map(([k, v]) => [k, String(v)])))}'`
  db.raw.exec(
    `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at, tokens_json)
     VALUES (${chain}, '${key}-${chain}', '${key}', 'prod', ${o.block ?? 100}, '${o.readAt ?? READ}', 1, ${o.idle}, ${o.lp}, ${fees}, 0, ${o.idle + o.lp + fees + o.vault}, '${JSON.stringify(positions)}', '${o.readAt ?? READ}', ${tokens})`,
  )
}
function daily(db: Db, day: string, chain: number, key: string, o: { total: number; idle: number; lp: number; feesOpen?: number; feesClose?: number; collected?: number | null }) {
  db.raw.exec(
    `INSERT INTO account_daily (day, chain_id, address, account_key, env, block_open, block_close, total_open_usdc, total_close_usdc, idle_close_usdc, lp_close_usdc, fees_open_usdc, fees_close_usdc, collected_usdc)
     VALUES ('${day}', ${chain}, '${key}-${chain}', '${key}', 'prod', 1, 1, ${o.total}, ${o.total}, ${o.idle}, ${o.lp}, ${o.feesOpen ?? 0}, ${o.feesClose ?? 0}, ${o.collected ?? 'NULL'})`,
  )
}

/** n owners, each with a Base account (idle 100, LP 200, vault 300) and the first three a Monad sleeve (idle 50). */
function platform(n: number) {
  const db = memoryD1()
  for (let i = 1; i <= n; i++) {
    user(db, `u${i}`)
    account(db, `key-${i}`, `u${i}`, 8453, addr(i))
    latest(db, 8453, `key-${i}`, { idle: 100 * USDC, lp: 200 * USDC, vault: 300 * USDC })
    if (i <= 3) {
      account(db, `mon-${i}`, `u${i}`, 143, addr(i))
      latest(db, 143, `mon-${i}`, { idle: 50 * USDC, lp: 0, vault: 0 })
    }
  }
  return db
}

describe('GET /api/stats v2', () => {
  test('public, cacheable, and S1–S3, S7–S10 and the three distributions add up', async () => {
    const h = harness(() => NOW, { statsCache: () => null })
    h.env.DB = platform(5)
    const res = await h.request('/api/stats')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300')
    const v = (await res.json()) as StatsView
    expect(v.snapshots.totalDeposits?.value).toBe(3150) // 5 × 600 + 3 × 50
    expect(v.snapshots.moneyWorking?.value).toBe(2500)
    expect(v.snapshots.idleCapital?.value).toBe(650)
    expect(v.snapshots.totalAccounts?.value).toBe(5)
    expect(v.snapshots.averageAccount?.value).toBe(630)
    expect(v.snapshots.largestAccount?.value).toBe(650)
    // Stable: idle USDC 650 + USDC legs 5 × 120 + vaults 1,500 = 2,750 of 3,150.
    expect(v.snapshots.inStablecoins?.value).toBe(87.3)
    expect(v.distributions.byToken).toEqual([{ key: 'USDC', usd: 2750, pct: 87.3 }, { key: 'WETH', usd: 400, pct: 12.7 }])
    expect(v.distributions.byChain).toEqual([{ key: 'Base', usd: 3000, pct: 95.2 }, { key: 'Monad', usd: 150, pct: 4.8 }])
    expect(v.distributions.byPlace).toEqual([{ key: 'Stable vaults', usd: 1500, pct: 47.6 }, { key: 'Volatile pairs', usd: 1000, pct: 31.7 }, { key: 'Idle', usd: 650, pct: 20.6 }])
    expect(v.dataAsOf).toBe(READ)
  })

  test('S02: no account key, address, user id or owner count in the body', async () => {
    const h = harness(() => NOW, { statsCache: () => null })
    h.env.DB = platform(5)
    const raw = await (await h.request('/api/stats')).text()
    for (let i = 1; i <= 5; i++) for (const s of [`key-${i}`, `mon-${i}`, addr(i), `"u${i}"`]) expect(raw).not.toContain(s)
    expect(raw).not.toMatch(/owners|not counted|NOT_COUNTED/i)
  })

  test('every figure counts every chain: a chain with accounts but no read hides the snapshots', async () => {
    const db = platform(5)
    db.raw.exec('DELETE FROM account_snapshot_latest WHERE chain_id = 143')
    const v = guardStats(await statsInput(db, NOW))
    expect(v.snapshots.totalDeposits).toBeUndefined()
    expect(v.distributions.byChain).toBeUndefined()
    expect(v.snapshots.totalAccounts?.value).toBe(5)
  })

  test('a funded row older than 1 h hides the snapshot figures; a row without the token split hides D1, D3 and S10 only', async () => {
    const stale = platform(5)
    stale.raw.exec(`UPDATE account_snapshot_latest SET read_at = '2026-11-06T17:00:00.000Z' WHERE account_key = 'key-1'`)
    expect(guardStats(await statsInput(stale, NOW)).snapshots.totalDeposits).toBeUndefined()
    const noSplit = platform(5)
    noSplit.raw.exec(`UPDATE account_snapshot_latest SET tokens_json = NULL WHERE account_key = 'key-2'`)
    const v = guardStats(await statsInput(noSplit, NOW))
    expect(v.snapshots.totalDeposits?.value).toBe(3150)
    expect(v.distributions.byToken).toBeUndefined()
    expect(v.distributions.byPlace).toBeUndefined()
    expect(v.snapshots.inStablecoins).toBeUndefined()
  })

  test('S17: two owners: nothing about their money is published', async () => {
    const v = guardStats(await statsInput(platform(2), NOW))
    expect(v.snapshots.totalDeposits).toBeUndefined()
    expect(v.snapshots.largestAccount).toBeUndefined()
    expect(v.distributions).toEqual({})
  })

  test('test accounts are in no figure', async () => {
    const db = platform(5)
    user(db, 'ut')
    account(db, 'key-test', 'ut', 8453, addr(99), 'prod', 1)
    latest(db, 8453, 'key-test', { idle: 9999 * USDC, lp: 0, vault: 0 })
    const v = guardStats(await statsInput(db, NOW))
    expect(v.snapshots.totalDeposits?.value).toBe(3150)
    expect(v.snapshots.totalAccounts?.value).toBe(5)
  })
})

describe('days: T1, T2, T3 and S6 from account_daily', () => {
  test('a day counts once every chain is known; earned = accrued change + collected; APR over the average working capital', async () => {
    const db = platform(5)
    for (let d = 1; d <= 6; d++) {
      const day = `2026-11-0${d}`
      for (let i = 1; i <= 5; i++) daily(db, day, 8453, `key-${i}`, { total: 300 * USDC, idle: 100 * USDC, lp: 200 * USDC, feesOpen: 0, feesClose: 0.05 * USDC, collected: d % 2 ? 0.01 * USDC : null })
      if (d >= 3) for (let i = 1; i <= 3; i++) daily(db, day, 143, `mon-${i}`, { total: 50 * USDC, idle: 50 * USDC, lp: 0 })
    }
    const v = guardStats(await statsInput(db, NOW))
    expect(v.series.totalDeposits?.map((p) => [p.day, p.usd])).toEqual([['2026-11-03', 1650], ['2026-11-04', 1650], ['2026-11-05', 1650]])
    expect(v.series.earnedPerDay?.at(-1)).toEqual({ day: '2026-11-05', usd: 0.3, collectedUsd: 0.05 })
    // Closed days only, from the first day every chain with accounts has rows (Monad from the 3rd here).
    expect(v.series.apr?.all.map((p) => p.day)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05'])
    // 5 × 0.06 earned on 5 × 200 working: 0.03 % a day, 10.95 % a year.
    expect(v.series.apr?.all[0]?.apr).toBe(11)
    expect(v.snapshots.apr7d).toBeUndefined() // only 3 closed days with every chain known
  })

  test('vault money without vault yield in the ledger leaves the day incomplete', async () => {
    const db = platform(5)
    for (let i = 1; i <= 5; i++) daily(db, '2026-11-05', 8453, `key-${i}`, { total: 600 * USDC, idle: 100 * USDC, lp: 200 * USDC })
    for (let i = 1; i <= 3; i++) daily(db, '2026-11-05', 143, `mon-${i}`, { total: 50 * USDC, idle: 50 * USDC, lp: 0 })
    expect(guardStats(await statsInput(db, NOW)).series.apr).toBeUndefined()
    // The backfill's full-day vault yield completes the day (and is used instead of ledger rows).
    for (let i = 1; i <= 5; i++) db.raw.exec(`INSERT INTO stats_vault_daily (day, chain_id, account_key, usd) VALUES ('2026-11-05', 8453, 'key-${i}', ${0.1 * USDC})`)
    const v = guardStats(await statsInput(db, NOW))
    expect(v.series.earnedPerDay).toEqual([{ day: '2026-11-05', usd: 0.5, collectedUsd: 0 }])
  })

  /** Days 1..lastDay of Nov: Base (5 accounts, no vault) and Monad every day; `gap` has no rows, `vaultFrom` days hold unpriced vault money. */
  function history(lastDay: number, o: { gap?: number; vaultFrom?: number }) {
    const db = platform(5)
    for (let d = 1; d <= lastDay; d++) {
      if (d === o.gap) continue
      const day = `2026-11-${String(d).padStart(2, '0')}`
      const vault = o.vaultFrom !== undefined && d >= o.vaultFrom ? 300 : 0
      for (let i = 1; i <= 5; i++) daily(db, day, 8453, `key-${i}`, { total: (300 + vault) * USDC, idle: 100 * USDC, lp: 200 * USDC, feesOpen: 0, feesClose: 0.05 * USDC })
      for (let i = 1; i <= 3; i++) daily(db, day, 143, `mon-${i}`, { total: 50 * USDC, idle: 50 * USDC, lp: 0 })
    }
    return db
  }
  const LATER = new Date('2026-11-14T10:00:00.000Z')

  test('an incomplete last closed day is dropped; the days before it, and the 7-day APR, still show', async () => {
    // 1..12 Nov; the 12th has vault money and no priced vault yield (ticket otto/mamoru#404).
    const db = history(12, { vaultFrom: 12 })
    const input = await statsInput(db, LATER)
    const v = guardStats(input)
    expect(v.series.totalDeposits?.at(0)?.day).toBe('2026-11-01')
    expect(v.series.totalDeposits?.at(-1)?.day).toBe('2026-11-11')
    expect(v.series.earnedPerDay?.at(-1)?.day).toBe('2026-11-11')
    expect(v.series.apr?.all.at(-1)).toMatchObject({ day: '2026-11-11' })
    expect(v.series.apr?.all.at(-1)?.apr7d).toBeDefined()
    expect(input.snapshots.apr7d?.complete).toBe(true)
    expect(Number.isFinite(input.snapshots.apr7d?.value)).toBe(true)
  })

  test('served route: GET /api/stats with 12 Nov incomplete still serves the three series', async () => {
    const h = harness(() => LATER, { statsCache: () => null })
    h.env.DB = history(12, { vaultFrom: 12 })
    const res = await h.request('/api/stats')
    expect(res.status).toBe(200)
    const v = (await res.json()) as StatsView
    expect(v.series.totalDeposits?.length).toBe(11)
    expect(v.series.earnedPerDay?.length).toBe(11)
    expect(v.series.apr?.all.length).toBe(11)
    expect(v.series.apr?.all.at(-1)?.apr7d).toBeDefined()
  })

  test('a day with no rows inside the history keeps the days after it, contiguous, and the 7-day APR is not taken across it', async () => {
    const db = history(11, { gap: 4 })
    const v = guardStats(await statsInput(db, LATER))
    expect(v.series.totalDeposits?.map((p) => p.day)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'])
    const apr = v.series.apr?.all ?? []
    expect(apr.filter((p) => p.apr7d !== undefined).map((p) => p.day)).toEqual(['2026-11-11'])
  })

  test('more than three incomplete trailing days: the data is stale and the series are withheld', async () => {
    const db = history(12, { vaultFrom: 8 })
    const input = await statsInput(db, LATER)
    const v = guardStats(input)
    expect(v.series.totalDeposits).toBeUndefined()
    expect(v.series.apr).toBeUndefined()
    expect(input.snapshots.apr7d?.complete).toBe(false)
  })
})

describe('pure pieces', () => {
  test('rowExposure splits fees by leg and puts the vault in USDC', () => {
    const e = rowExposure({ account_key: 'k', chain_id: 8453, total_usdc: 610, idle_usdc: 0, lp_usdc: 100, fees_usdc: 10, owed_usdc: 0, read_at: READ, block: 1, tokens_json: null, positions_json: JSON.stringify([{ token0: 'WETH', token1: 'USDC', valueUsdc: '100', value0Usdc: '40', value1Usdc: '60', feesUsdc: '10', owedUsdc: '0' }]) })!
    expect(Object.fromEntries(e.byToken)).toEqual({ WETH: 44, USDC: 566 })
    expect(Object.fromEntries(e.byPlace)).toEqual({ 'Volatile pairs': 110, 'Stable vaults': 500 })
  })
  test('in flight: counted once on the destination chain; a transfer both reads hold is taken out once', () => {
    const rows = new Map([['8453:b', { block: 150 }], ['143:s', { block: 900 }]])
    const at = (c: number, k: string) => rows.get(`${c}:${k}`) as never
    const t = (direction: string, state: string, burn_block: number | null, minted_block: number | null) => ({ id: 'x', direction, account_key: 'b', amount_usdc: 50, state, burn_block, minted_block })
    expect(inFlightNow([t('out', 'burned', 100, null)], at, () => 's').moves).toEqual([{ baseKey: 'b', chainId: 143, amount: 50 }])
    expect(inFlightNow([t('home', 'burned', 800, null)], at, () => 's').moves).toEqual([{ baseKey: 'b', chainId: 8453, amount: 50 }])
    expect(inFlightNow([t('out', 'minted', 100, 800)], at, () => 's').moves).toEqual([])
    rows.set('8453:b', { block: 90 })
    expect(inFlightNow([t('out', 'minted', 100, 800)], at, () => 's').moves).toEqual([{ baseKey: 'b', chainId: 143, amount: -50 }])
  })

})

describe('review fixes', () => {
  test('dust owners do not count: two $0.01 sleeves do not unmask a single Monad owner', async () => {
    const db = memoryD1()
    for (let i = 1; i <= 5; i++) {
      user(db, `u${i}`)
      account(db, `key-${i}`, `u${i}`, 8453, addr(i))
      latest(db, 8453, `key-${i}`, { idle: 100 * USDC, lp: 200 * USDC, vault: 300 * USDC })
      account(db, `mon-${i}`, `u${i}`, 143, addr(i))
      latest(db, 143, `mon-${i}`, { idle: i === 1 ? 500 * USDC : i <= 3 ? 10_000 : 0, lp: 0, vault: 0 })
    }
    const v = guardStats(await statsInput(db, NOW))
    expect(v.distributions.byChain).toBeUndefined() // Monad backed by one real owner: merged with Base, then a one-slice split
    expect(v.snapshots.totalDeposits?.value).toBe(3500)
  })

  test('an account the operator never read holds nothing; any stale read, even of $0, hides the snapshot figures', async () => {
    const db = platform(5)
    user(db, 'u9')
    account(db, 'key-9', 'u9', 8453, addr(9))
    expect(guardStats(await statsInput(db, NOW)).snapshots.totalDeposits?.value).toBe(3150)
    latest(db, 8453, 'key-9', { idle: 0, lp: 0, vault: 0, readAt: '2026-11-06T12:00:00.000Z' })
    expect(guardStats(await statsInput(db, NOW)).snapshots.totalDeposits).toBeUndefined()
  })

  test('a gap in an account\'s daily rows leaves that day incomplete', async () => {
    const db = platform(5)
    for (const day of ['2026-11-03', '2026-11-04', '2026-11-05']) {
      for (let i = 1; i <= 5; i++) if (!(i === 2 && day === '2026-11-04')) daily(db, day, 8453, `key-${i}`, { total: 300 * USDC, idle: 100 * USDC, lp: 200 * USDC, feesClose: 0.05 * USDC })
      for (let i = 1; i <= 3; i++) daily(db, day, 143, `mon-${i}`, { total: 50 * USDC, idle: 50 * USDC, lp: 0 })
    }
    expect(guardStats(await statsInput(db, NOW)).series.totalDeposits?.map((p) => p.day)).toEqual(['2026-11-05'])
  })

  test('earned figures are raw USDC from earned.ts: $1.50 of income and $0.30 accrued per account', async () => {
    const db = platform(5)
    db.raw.exec("UPDATE account_snapshot_latest SET fees_usdc = 300000, total_usdc = total_usdc + 300000")
    for (const k of ['key-1', 'key-2', 'key-3', 'key-4', 'key-5']) db.raw.exec(`INSERT INTO yield_ledger_income (event_id, chain_id, account_key, env, source, t_s, from_s, usd, updated_at) VALUES ('0x${k}:1', 8453, '${k}', 'prod', 'harvest', ${Date.parse('2026-11-05T10:00:00Z') / 1000}, NULL, 1500000, '${READ}')`)
    const v = guardStats(await statsInput(db, NOW))
    expect(v.snapshots.totalEarned?.value).toBe(9.9) // 5 × (1.50 + 0.30) on Base + 3 × 0.30 accrued on Monad
  })

  test('the collected part of a day goes out only with 3 collectors', async () => {
    const db = platform(5)
    for (let i = 1; i <= 5; i++) daily(db, '2026-11-05', 8453, `key-${i}`, { total: 300 * USDC, idle: 100 * USDC, lp: 200 * USDC, feesClose: 0.05 * USDC, collected: i === 1 ? 412 * USDC : null })
    for (let i = 1; i <= 3; i++) daily(db, '2026-11-05', 143, `mon-${i}`, { total: 50 * USDC, idle: 50 * USDC, lp: 0 })
    const v = guardStats(await statsInput(db, NOW))
    expect(v.series.earnedPerDay).toEqual([{ day: '2026-11-05', usd: 412.25 }])
  })
})

describe('GET /api/stats reads the view the cron stored', () => {
  test('a stored view younger than 15 min is served as stored, without building it again', async () => {
    const h = harness(() => NOW, { statsCache: () => null })
    const db = platform(5)
    h.env.DB = db
    await refreshStatsView(db, new Date(NOW.getTime() - 60_000))
    // Money added after the build is not read: the request served the stored row.
    latest(db, 8453, 'key-99', { idle: 1000 * USDC, lp: 0, vault: 0 })
    const v = (await (await h.request('/api/stats')).json()) as StatsView
    expect(v.snapshots.totalDeposits?.value).toBe(3150)
  })

  test('a stored view older than 15 min is built again on the request and stored', async () => {
    const h = harness(() => NOW, { statsCache: () => null })
    const db = platform(5)
    h.env.DB = db
    await refreshStatsView(db, new Date(NOW.getTime() - (STORED_TTL_S + 60) * 1000))
    user(db, 'u6')
    account(db, 'key-6', 'u6', 8453, addr(6))
    latest(db, 8453, 'key-6', { idle: 100 * USDC, lp: 200 * USDC, vault: 300 * USDC })
    const v = (await (await h.request('/api/stats')).json()) as StatsView
    expect(v.snapshots.totalDeposits?.value).toBe(3750)
    const row = db.raw.query('SELECT built_ms FROM stats_view WHERE id = 1').get() as { built_ms: number }
    expect(row.built_ms).toBe(NOW.getTime())
  })

  test('an older build never overwrites a newer stored view', async () => {
    const db = platform(5)
    await refreshStatsView(db, NOW)
    await refreshStatsView(db, new Date(NOW.getTime() - 60_000))
    const row = db.raw.query('SELECT built_ms FROM stats_view WHERE id = 1').get() as { built_ms: number }
    expect(row.built_ms).toBe(NOW.getTime())
  })

  test('a newer view the cron stored while the request was building is the one served', async () => {
    const db = platform(5)
    const h = harness(() => NOW, { statsCache: () => null })
    h.env.DB = db
    await refreshStatsView(db, new Date(NOW.getTime() - (STORED_TTL_S + 60) * 1000))
    // The cron's newer build lands after the request read the stale row and before it stores its own.
    const prepare = db.prepare.bind(db)
    let reads = 0
    db.prepare = ((sql: string) => {
      if (sql.startsWith('SELECT view_json') && ++reads === 1) {
        const stmt = prepare(sql)
        return { ...stmt, bind: stmt.bind.bind(stmt), first: async () => {
          const row = await stmt.first()
          db.raw.exec(`INSERT INTO stats_view (id, view_json, built_ms) VALUES (1, '{"dataAsOf":null,"snapshots":{},"distributions":{},"series":{}}', ${NOW.getTime() + 1000}) ON CONFLICT (id) DO UPDATE SET view_json = excluded.view_json, built_ms = excluded.built_ms`)
          return row
        } }
      }
      return prepare(sql)
    }) as typeof db.prepare
    const v = (await (await h.request('/api/stats')).json()) as StatsView
    expect(v.snapshots.totalDeposits).toBeUndefined()
  })
})
