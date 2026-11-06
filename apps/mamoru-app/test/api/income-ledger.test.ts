import { beforeEach, describe, expect, test } from 'bun:test'
import { memoryD1 } from './d1.ts'
import { vaultYield, writeDayBackfill, writeIncome, type VaultFlowWire } from '../../src/api/income-ledger.ts'
import { earnedFrom, loadEarned } from '../../src/api/earned.ts'
import type { SnapshotWire } from '../../src/api/yield-ledger.ts'

const CHAIN = 8453
const KEY = 'acct-income-1'
const SAFE = '0x1111111111111111111111111111111111111111'
const E18 = 10n ** 18n
const resolve = async () => ({ accountKey: KEY, env: 'prod' as const })
const T0 = Date.parse('2026-11-06T12:00:00.000Z') / 1000

const flow = (kind: 'deposit' | 'withdraw', assets: bigint, shares: bigint, t: number, logIndex = 1): VaultFlowWire => ({ vault: 'vault:gtUSDCp', kind, assets: assets.toString(), shares: shares.toString(), logIndex, id: `0x${t}:${logIndex}`, t })

describe('vaultYield (spec 012 HRV-R5): explained shares only, split at every flow', () => {
  test('HRV-S28: 100 explained shares at 1.00, 50 redeemed at 1.01, next sample at 1.02 → 1.5, not 2.0', () => {
    const usd = vaultYield({ t: 0, shares: 100n * E18, value: 100_000_000n, explained: 100n * E18 }, { t: 20, shares: 50n * E18, value: 51_000_000n, explained: 50n * E18 }, [flow('withdraw', 50_500_000n, 50n * E18, 10)])
    expect(usd).toBe(1_500_000n)
  })

  test('a deposit mid-interval earns only from its own price on', () => {
    const usd = vaultYield({ t: 0, shares: 100n * E18, value: 100_000_000n, explained: 100n * E18 }, { t: 20, shares: 150n * E18, value: 153_000_000n, explained: 150n * E18 }, [flow('deposit', 50_500_000n, 50n * E18, 10)])
    // 100 × 0.01 before the deposit, 150 × 0.01 after it.
    expect(usd).toBe(2_500_000n)
  })

  test('HRV-S27: 999 of 1,000 shares explained, price up 1 % → yield on the 999 only', () => {
    const usd = vaultYield({ t: 0, shares: 1000n * E18, value: 1_000_000_000n, explained: 999n * E18 }, { t: 10, shares: 1000n * E18, value: 1_010_000_000n, explained: 999n * E18 }, [])
    expect(usd).toBe(9_990_000n)
  })

  test('a share change no flow explains (a full withdrawal whose receipt is unread) → not counted, never 0', () => {
    expect(vaultYield({ t: 0, shares: 100n * E18, value: 100_000_000n, explained: 100n * E18 }, { t: 20, shares: 0n, value: 0n, explained: null }, [])).toBeNull()
  })

  test('unknown explained shares at the previous sample → not counted (null), never 0', () => {
    expect(vaultYield({ t: 0, shares: 1n, value: 1n, explained: null }, { t: 1, shares: 1n, value: 2n, explained: 1n }, [])).toBeNull()
  })
})

describe('writeIncome and writeDayBackfill', () => {
  let db: ReturnType<typeof memoryD1>
  beforeEach(() => {
    db = memoryD1()
  })
  const snap = (t: number, vaults: { shares: bigint; value: bigint }[] | null, receipts: NonNullable<SnapshotWire['receipts']>): SnapshotWire => ({
    chainId: CHAIN, block: '1', readAt: new Date(t * 1000).toISOString(), pools: {}, calls: 0, lastError: null, receipts,
    safes: [{ accountKey: KEY.slice(0, 8), safe: SAFE, active: true, armed: true, deployed: true, eth: '0', tokens: {}, positions: [], idleUsdc: '0', lpUsdc: '0', feesUsdc: '0', owedUsdc: '0', totalUsdc: '0', ...(vaults ? { vaults: vaults.map((v) => ({ name: 'vault:gtUSDCp', shares: v.shares.toString(), valueUsdc: v.value.toString() })) } : {}) }],
  })
  const income = () => db.raw.query('SELECT event_id, source, t_s, from_s, usd FROM yield_ledger_income ORDER BY event_id').all() as { event_id: string; source: string; t_s: number; from_s: number | null; usd: number | null }[]

  test('fee events are inserted once; an unpriced one is filled by a later pull and never overwritten', async () => {
    await writeIncome(db, snap(T0, null, [{ safe: SAFE, days: [], events: [{ id: '0xaa:4', t: T0 - 60, source: 'harvest' }, { id: '0xaa:9', t: T0 - 60, source: 'harvest', usdc: '7' }] }]), new Date(), resolve)
    await writeIncome(db, snap(T0 + 60, null, [{ safe: SAFE, days: [], events: [{ id: '0xaa:4', t: T0 - 60, source: 'harvest', usdc: '5' }, { id: '0xaa:9', t: T0 - 60, source: 'harvest', usdc: '999' }] }]), new Date(), resolve)
    expect(income().map((r) => [r.event_id, r.usd])).toEqual([['0xaa:4', 5], ['0xaa:9', 7]])
  })

  test('a vault: first sample backfills explained value minus net deposits, the next ones write vault-yield over their interval', async () => {
    const vault = (explained: string | null) => ({ flows: [flow('deposit', 100_000_000n, 100n * E18, T0 - 3600)], explained: explained === null ? null : { 'vault:gtUSDCp': explained } })
    await writeIncome(db, snap(T0, [{ shares: 100n * E18, value: 101_000_000n }], [{ safe: SAFE, days: [], vault: vault((100n * E18).toString()) }]), new Date(), resolve)
    await writeIncome(db, snap(T0 + 600, [{ shares: 100n * E18, value: 101_500_000n }], [{ safe: SAFE, days: [], vault: vault((100n * E18).toString()) }]), new Date(), resolve)
    expect(income()).toEqual([
      { event_id: `vault-backfill:${CHAIN}:${KEY}:vault:gtUSDCp`, source: 'backfill', t_s: T0, from_s: null, usd: 1_000_000 },
      { event_id: `vault:${CHAIN}:${KEY}:vault:gtUSDCp:${T0 + 600}`, source: 'vault-yield', t_s: T0 + 600, from_s: T0, usd: 500_000 },
    ])
  })

  test('a vault left before any sample: income is what came out above what went in', async () => {
    const flows = [flow('deposit', 100_000_000n, 100n * E18, T0 - 7200, 1), flow('withdraw', 101_000_000n, 100n * E18, T0 - 3600, 2)]
    await writeIncome(db, snap(T0, [], [{ safe: SAFE, days: [], vault: { flows, explained: { 'vault:gtUSDCp': '0' } } }]), new Date(), resolve)
    expect(income()).toEqual([{ event_id: `vault-backfill:${CHAIN}:${KEY}:vault:gtUSDCp`, source: 'backfill', t_s: T0, from_s: null, usd: 1_000_000 }])
  })

  test('rows not counted while a receipt was unread are measured again once every flow is known', async () => {
    const dep = flow('deposit', 100_000_000n, 100n * E18, T0 - 3600)
    await writeIncome(db, snap(T0, [{ shares: 100n * E18, value: 101_000_000n }], [{ safe: SAFE, days: [], vault: { flows: [], explained: null } }]), new Date(), resolve)
    await writeIncome(db, snap(T0 + 600, [{ shares: 100n * E18, value: 101_500_000n }], [{ safe: SAFE, days: [], vault: { flows: [], explained: null } }]), new Date(), resolve)
    expect(income().map((r) => r.usd)).toEqual([null, null, null])
    await writeIncome(db, snap(T0 + 1200, [{ shares: 100n * E18, value: 102_000_000n }], [{ safe: SAFE, days: [], vault: { flows: [dep], explained: { 'vault:gtUSDCp': (100n * E18).toString() } } }]), new Date(), resolve)
    expect(income().map((r) => [r.source, r.from_s, r.usd])).toEqual([['backfill', null, 1_000_000], ['backfill', null, 0], ['vault-yield', T0, 500_000], ['vault-yield', T0 + 600, 500_000]])
  })

  test('while a receipt is unread a not-counted row stands for vaults this pull cannot see, closed at 0 once flows are known', async () => {
    await writeIncome(db, snap(T0, [], [{ safe: SAFE, days: [], vault: { flows: [], explained: null } }]), new Date(), resolve)
    expect(income()).toEqual([{ event_id: `vault-pending:${CHAIN}:${KEY}`, source: 'backfill', t_s: T0, from_s: null, usd: null }])
    const flows = [flow('deposit', 100_000_000n, 100n * E18, T0 - 7200, 1), flow('withdraw', 101_000_000n, 100n * E18, T0 - 3600, 2)]
    await writeIncome(db, snap(T0 + 600, [], [{ safe: SAFE, days: [], vault: { flows, explained: { 'vault:gtUSDCp': '0' } } }]), new Date(), resolve)
    expect(income().map((r) => [r.event_id.split(':')[0], r.usd])).toEqual([['vault-backfill', 1_000_000], ['vault-pending', 0]])
    // A new unread period opens it again.
    await writeIncome(db, snap(T0 + 1200, [], [{ safe: SAFE, days: [], vault: { flows: [], explained: null } }]), new Date(), resolve)
    expect(income().find((r) => r.event_id.startsWith('vault-pending'))!.usd).toBeNull()
  })

  test('explained shares unknown at the first sample → the backfill is not counted (null)', async () => {
    await writeIncome(db, snap(T0, [{ shares: 100n * E18, value: 101_000_000n }], [{ safe: SAFE, days: [], vault: { flows: [], explained: null } }]), new Date(), resolve)
    expect(income()[0]).toMatchObject({ source: 'backfill', usd: null })
  })

  test('HRV-S22: a day known only as a total keeps every dollar as backfill, and drops to 0 once its events cover it', async () => {
    const day = '2026-11-01'
    const dayT = Date.parse(`${day}T00:00:00.000Z`) / 1000
    db.raw.exec(`INSERT INTO yield_ledger_account_receipts (day, chain_id, address, account_key, env, gas_paid_wei, collected_usdc, digest, updated_at) VALUES ('${day}', ${CHAIN}, '${SAFE}', '${KEY}', 'prod', '0', 100, 'x', 'x')`)
    await writeDayBackfill(db, CHAIN, 'now')
    expect(income()).toEqual([{ event_id: `backfill:${CHAIN}:${KEY}:${day}`, source: 'backfill', t_s: dayT, from_s: null, usd: 100 }])
    db.raw.exec(`INSERT INTO yield_ledger_income (event_id, chain_id, account_key, env, source, t_s, from_s, usd, updated_at) VALUES ('0xbb:1', ${CHAIN}, '${KEY}', 'prod', 'harvest', ${dayT + 3600}, NULL, NULL, 'x')`)
    await writeDayBackfill(db, CHAIN, 'now')
    // An unpriced event that day: the backfill is left as it was, never recomputed short.
    expect(income().find((r) => r.source === 'backfill')!.usd).toBe(100)
    db.raw.exec(`UPDATE yield_ledger_income SET usd = 100 WHERE event_id = '0xbb:1'`)
    await writeDayBackfill(db, CHAIN, 'now')
    expect(income().find((r) => r.source === 'backfill')!.usd).toBe(0)
  })
})

describe('earned (spec 012 HRV-R9): income up to the snapshot plus accrued at it', () => {
  const tA = T0
  const row = (event_id: string, source: string, t_s: number, usd: number | null, from_s: number | null = null) => ({ event_id, source, t_s, from_s, usd })

  test('HRV-S09: two harvests the same day both count; total = income + accrued; a collect after t_a waits', () => {
    const v = earnedFrom([row('0x1:1', 'harvest', tA - 7200, 10), row('0x2:1', 'harvest', tA - 3600, 15), row('0x3:1', 'harvest', tA + 60, 99)], tA, 5n, false)
    expect(v.totalUsd).toBe('30')
    expect(v.last24hUsd).toBe('25')
    expect(v.status).toBe('complete')
  })

  test('HRV-S24: a 48 h vault interval with 4 USDC, window covering its last 24 h → 2 counted, 24 h figure partial', () => {
    const v = earnedFrom([row('vault:x', 'vault-yield', tA, 4_000_000, tA - 2 * 86_400)], tA, 0n, false)
    expect(v.totalUsd).toBe('4000000')
    expect(v.last24hUsd).toBe('2000000')
    expect(v.last24hNotCounted).toContain('vault-yield')
  })

  test('a day backfill of t_a\'s own day is left out of the total and named; an older one counts but never in 24 h', () => {
    const today = tA - (tA % 86_400)
    const v = earnedFrom([row('backfill:8453:k:today', 'backfill', today, 50), row('backfill:8453:k:old', 'backfill', today - 86_400, 70)], tA, 0n, false)
    expect(v.totalUsd).toBe('70')
    expect(v.notCounted).toEqual(['history'])
    expect(v.last24hUsd).toBe('0')
  })

  test('an unpriced fee or an unexplained vault makes the total partial, named, never 0 folded in silently', () => {
    expect(earnedFrom([row('0x1:1', 'harvest', tA - 10, null)], tA, 1n, false)).toMatchObject({ totalUsd: '1', status: 'partial', notCounted: ['fees'] })
    expect(earnedFrom([], tA, 1n, true)).toMatchObject({ status: 'partial', notCounted: ['vault-yield'] })
  })

  test('receipts holding more collected fees than the income rows (no pull since the migration) → partial, history', async () => {
    const db = memoryD1()
    db.raw.exec(
      `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
       VALUES (${CHAIN}, '${SAFE}', '${KEY}', 'prod', 1, '${new Date(tA * 1000).toISOString()}', 1, 0, 0, 0, 0, 0, '[]', 'x')`,
    )
    db.raw.exec(`INSERT INTO yield_ledger_account_receipts (day, chain_id, address, account_key, env, gas_paid_wei, collected_usdc, digest, updated_at) VALUES ('2026-11-01', ${CHAIN}, '${SAFE}', '${KEY}', 'prod', '0', 100000000, 'x', 'x')`)
    expect(await loadEarned(db, CHAIN, KEY)).toMatchObject({ totalUsd: '0', status: 'partial', notCounted: ['history'] })
  })

  test('a held vault whose last sample is well before the snapshot (a failed income write) → partial', async () => {
    const db = memoryD1()
    db.raw.exec(
      `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
       VALUES (${CHAIN}, '${SAFE}', '${KEY}', 'prod', 1, '${new Date(tA * 1000).toISOString()}', 1, 0, 0, 0, 0, 0, '[]', 'x')`,
    )
    db.raw.exec(`INSERT INTO yield_ledger_vault_samples (chain_id, account_key, vault, t_s, shares, value_usdc, explained_shares, explained) VALUES (${CHAIN}, '${KEY}', 'vault:gtUSDCp', ${tA - 3600}, '100', 100, '100', 1)`)
    expect(await loadEarned(db, CHAIN, KEY)).toMatchObject({ status: 'partial', notCounted: ['vault-yield'] })
  })

  test('loadEarned reads the cutoff from the latest snapshot and is null without one', async () => {
    const db = memoryD1()
    expect(await loadEarned(db, CHAIN, KEY)).toBeNull()
    db.raw.exec(
      `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
       VALUES (${CHAIN}, '${SAFE}', '${KEY}', 'prod', 1, '${new Date(tA * 1000).toISOString()}', 1, 0, 0, 3, 0, 3, '[]', 'x')`,
    )
    db.raw.exec(`INSERT INTO yield_ledger_income (event_id, chain_id, account_key, env, source, t_s, from_s, usd, updated_at) VALUES ('0x1:1', ${CHAIN}, '${KEY}', 'prod', 'harvest', ${tA - 10}, NULL, 7, 'x')`)
    expect(await loadEarned(db, CHAIN, KEY)).toMatchObject({ totalUsd: '10', status: 'complete' })
  })
})
