import { describe, expect, test } from 'bun:test'
import { guardStats, ownersBand, type GuardInput } from '../../src/api/stats/privacy.ts'

const AS_OF = '2026-11-06T16:50:00.000Z'
const fig = (usd: number | null, owners: number) => ({ usd, owners, dataAsOf: AS_OF })

function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    tvlNow: fig(3874.4, 9),
    tvl: [{ day: '2026-11-05', usd: 350.6, owners: 2 }, { day: '2026-11-06', usd: 3927.8, owners: 3 }],
    monadFrom: null,
    volume: [{ day: '2026-11-06', usd: null, owners: 0, reason: 'NOT_COUNTED' }],
    earned24h: { ...fig(0.3, 4), vaultYield: 'not_counted' },
    earnedTotal: { ...fig(1.44, 9), since: '2026-10-12', vaultYield: 'not_counted' },
    fundedAccounts: { count: 9, owners: 9, dataAsOf: AS_OF },
    sources: { tvl: 'account_daily', volume: 'yield_ledger_ops', earned: 'yield_ledger_income' },
    ...over,
  }
}

describe('guardStats: k >= 3 on every published figure (STATS-R9)', () => {
  test('STATS-S03: a day backed by 2 owners is withheld, the next with 3 goes out as a band', () => {
    const v = guardStats(input())
    expect(v.tvl[0]).toEqual({ day: '2026-11-05', usd: null, reason: 'TOO_FEW_ACCOUNTS' })
    expect(v.tvl[1]).toEqual({ day: '2026-11-06', usd: 3928, owners: '3+' })
  })

  test('G3: every headline scalar backed by 2 owners is null with TOO_FEW_ACCOUNTS', () => {
    const v = guardStats(input({
      tvlNow: fig(100, 2),
      earned24h: { ...fig(1, 2), vaultYield: 'counted' },
      earnedTotal: { ...fig(5, 2), since: '2026-10-12', vaultYield: 'counted' },
      fundedAccounts: { count: 2, owners: 2, dataAsOf: AS_OF },
    }))
    expect(v.tvlNow).toEqual({ usd: null, reason: 'TOO_FEW_ACCOUNTS', dataAsOf: AS_OF })
    expect(v.earned24h.usd).toBeNull()
    expect(v.earned24h.reason).toBe('TOO_FEW_ACCOUNTS')
    expect(v.earnedTotal.usd).toBeNull()
    expect(v.earnedTotal.reason).toBe('TOO_FEW_ACCOUNTS')
    expect(v.fundedAccounts).toEqual({ count: null, reason: 'TOO_FEW_ACCOUNTS', dataAsOf: AS_OF })
  })

  test('a chain split goes out only when every point passes', () => {
    const v = guardStats(input({
      chains: [
        { chainId: 8453, tvl: [{ day: '2026-11-05', usd: 300, owners: 5 }, { day: '2026-11-06', usd: 3800, owners: 7 }] },
        { chainId: 143, tvl: [{ day: '2026-11-05', usd: 20, owners: 1 }, { day: '2026-11-06', usd: 37, owners: 3 }] },
      ],
    }))
    expect(v.chains?.map((c) => c.chainId)).toEqual([8453])
    const none = guardStats(input({ chains: [{ chainId: 143, tvl: [{ day: '2026-11-06', usd: 37, owners: 2 }] }] }))
    expect(none.chains).toBeUndefined()
  })

  test('not counted keeps its reason (G4), never shown as too few or as 0', () => {
    const v = guardStats(input())
    expect(v.volume[0]).toEqual({ day: '2026-11-06', usd: null, reason: 'NOT_COUNTED' })
  })

  test('every USD figure is rounded to whole dollars; partial keeps its reason', () => {
    const v = guardStats(input({ tvl: [{ day: '2026-11-06', usd: 3927.5, owners: 12, reason: 'PARTIAL' }] }))
    expect(v.tvlNow.usd).toBe(3874)
    expect(v.tvl[0]).toEqual({ day: '2026-11-06', usd: 3928, owners: '10+', reason: 'PARTIAL' })
    expect(v.earnedTotal.usd).toBe(1)
  })

  test('owner counts leave only as bands, never exact', () => {
    expect([2, 3, 9, 10, 24, 25, 49, 50, 500].map(ownersBand)).toEqual([undefined, '3+', '3+', '10+', '10+', '25+', '25+', '50+', '50+'])
    const raw = JSON.stringify(guardStats(input()))
    expect(raw).not.toContain('"owners":9')
    expect(raw).not.toContain('"owners":3,')
  })
})
