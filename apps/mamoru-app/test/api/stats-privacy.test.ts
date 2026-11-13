import { describe, expect, test } from 'bun:test'
import { guardApr, guardSplit, aprRun, guardStats, validRun, validSuffix, type GuardAprDay, type GuardInput } from '../../src/api/stats/privacy.ts'

// Spec 013 STATS-R9 with amendment A1: k >= 3 allow-if; withheld = absent; slices below k merged into "Other".

const NOW = new Date('2026-11-06T19:00:00.000Z')
const AS_OF = '2026-11-06T18:55:00.000Z'
const users = (n: number) => new Set(Array.from({ length: n }, (_, i) => `u${i}`))
const fig = (value: number, n: number, complete = true, at: string | null = AS_OF) => ({ value, owners: users(n), complete, dataAsOf: at })
const empty = (): GuardInput => ({ now: NOW, snapshots: {}, distributions: {}, apr: { all: [] }, earnedPerDay: [], totalDeposits: [] })

describe('figures', () => {
  test('published only when complete, fresh, finite and backed by 3 owners; rounding per figure', () => {
    const v = guardStats({ ...empty(), snapshots: {
      totalDeposits: fig(4363.34, 15), earned24h: fig(0.984, 9), apr7d: fig(27.64, 12), totalAccounts: fig(65, 65),
      moneyWorking: fig(100, 2), idleCapital: fig(100, 9, false), largestAccount: fig(1728.27, 15, true, '2026-11-06T17:00:00.000Z'), inStablecoins: fig(Number.NaN, 9),
    } })
    expect(v.snapshots).toEqual({
      totalDeposits: { value: 4363, dataAsOf: AS_OF }, earned24h: { value: 0.98, dataAsOf: AS_OF }, apr7d: { value: 27.6, dataAsOf: AS_OF }, totalAccounts: { value: 65, dataAsOf: AS_OF },
    })
    expect(JSON.stringify(v)).not.toMatch(/not counted|NOT_COUNTED|owners/i)
  })
})

describe('distributions (complementary rule)', () => {
  const slice = (key: string, usd: number, n: number, offset = 0) => ({ key, usd, owners: new Set(Array.from({ length: n }, (_, i) => `u${i + offset}`)) })
  test('small slices merge into Other when Other itself has 3 owners', () => {
    const d = guardSplit({ complete: true, dataAsOf: AS_OF, slices: [slice('USDC', 3452.97, 15), slice('WETH', 740.2, 6), slice('cbBTC', 100, 1, 20), slice('USDT', 50, 1, 21), slice('WMON', 20.17, 1, 22)] }, NOW)
    expect(d).toEqual([{ key: 'USDC', usd: 3453, pct: 79.1 }, { key: 'WETH', usd: 740, pct: 17 }, { key: 'Other', usd: 170, pct: 3.9 }])
  })
  test('an Other under 3 owners takes the smallest shown slice; with none left the whole split is withheld', () => {
    // Monad hidden alone would be Base's complement: Base joins it, and a split of one slice is withheld.
    expect(guardSplit({ complete: true, dataAsOf: AS_OF, slices: [slice('Base', 3972.86, 14), slice('Monad', 390.48, 2)] }, NOW)).toBeUndefined()
    expect(guardSplit({ complete: true, dataAsOf: AS_OF, slices: [slice('Idle', 1468, 15), slice('Vaults', 1626, 7, 20), slice('Volatile', 1268, 12, 30), slice('Stable pairs', 0.4, 1, 50)] }, NOW)).toEqual([
      { key: 'Vaults', usd: 1626, pct: 37.3 }, { key: 'Idle', usd: 1468, pct: 33.7 }, { key: 'Other', usd: 1268, pct: 29.1 },
    ])
    expect(guardSplit({ complete: true, dataAsOf: AS_OF, slices: [slice('B', 1, 1, 9), slice('C', 1, 1, 9)] }, NOW)).toBeUndefined()
    expect(guardSplit({ complete: false, dataAsOf: AS_OF, slices: [slice('A', 10, 5)] }, NOW)).toBeUndefined()
  })
})

describe('series', () => {
  const day = (d: number, earned: number, capital: number, n = 5, complete = true): GuardAprDay => ({ day: `2026-11-${String(d).padStart(2, '0')}`, earned, capital, owners: users(n), complete })
  test('the longest valid run ending at the last day; 7-day APR from 7-day sums once 7 days exist', () => {
    const days = [day(1, 1, 100, 5, false), ...Array.from({ length: 8 }, (_, i) => day(i + 2, 0.1, 365))]
    const a = guardApr(days)!
    expect(a.map((p) => p.day)).toEqual(days.slice(1).map((d) => d.day))
    expect(a[0]).toEqual({ day: '2026-11-02', apr: 10 })
    expect(a[6]).toEqual({ day: '2026-11-08', apr: 10, apr7d: 10 })
  })
  test('a last day under 3 owners withholds the whole series', () => {
    expect(guardApr([day(1, 1, 100), day(2, 1, 100, 2)])).toBeUndefined()
    expect(validSuffix([1, 2, 3], (x) => x !== 2)).toEqual([3])
  })
  test('the 7-day window applies the series rule: a 2-owner day inside it is not published', () => {
    const days = [...Array.from({ length: 6 }, (_, i) => day(i + 2, 0.1, 365, 3)), day(8, 0.1, 365, 2), day(9, 0.1, 365, 5, false)]
    expect(guardApr(days)).toBeUndefined()
    expect(aprRun(days)).toEqual([])
  })
  test('validRun drops up to 3 invalid trailing points, then keeps the run; a hole inside cuts the run; a longer tail is stale', () => {
    const ok = (x: number) => x > 0
    expect(validRun([1, 1, 0, 1, 1, 0], ok)).toEqual([1, 1])
    expect(validRun([1, 1, 1, 0, 0, 0], ok)).toEqual([1, 1, 1])
    expect(validRun([1, 1, 1, 0, 0, 0, 0], ok)).toEqual([])
    expect(validRun([1, 1], ok)).toEqual([1, 1])
    expect(guardApr([day(1, 1, 100), day(2, 1, 100, 5, false)])?.map((p) => p.day)).toEqual(['2026-11-01'])
  })
})
