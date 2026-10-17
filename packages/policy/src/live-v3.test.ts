import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, conservadorLiveV3, grantKey, POLICIES } from './index.ts'

const caps = (p: typeof conservadorLiveV2) => Object.fromEntries(p.session.caps.map((c) => [c.name, c.bpsOfDeposit]))

describe('conservador-live-v3: 50 / 35 / 15 (owner decision 2026-10-16)', () => {
  test('registered, with the weights of the offer', () => {
    expect(POLICIES['conservador-live-v3']).toBe(conservadorLiveV3)
    expect(conservadorLiveV3.buckets.map((b) => [b.id, b.preference])).toEqual([['stables', 5000], ['btc-usdc', 3500], ['risk', 1500]])
    expect(conservadorLiveV3.buckets.reduce((s, b) => s + b.preference, 0)).toBe(10_000)
  })

  test('only the btc and risk caps move, with their weights', () => {
    const v2 = caps(conservadorLiveV2)
    const v3 = caps(conservadorLiveV3)
    expect(Object.keys(v3)).toEqual(Object.keys(v2))
    for (const n of Object.keys(v2).filter((n) => n.startsWith('stables'))) expect(v3[n]).toBe(v2[n])
    expect(v3.btcSwapPerCall).toBe(3500)
    expect(v3.btcMint0).toBe(7000)
    expect(v3.riskSwapPerCall).toBe(3000)
    expect(v3.riskMint0).toBe(6000)
  })

  test('same pools, grants, ranges and re-balance rules as v2', () => {
    expect(conservadorLiveV3.session.grants.map(grantKey)).toEqual(conservadorLiveV2.session.grants.map(grantKey))
    expect(conservadorLiveV3.range).toEqual(conservadorLiveV2.range)
    expect(conservadorLiveV3.allocation).toBe(conservadorLiveV2.allocation)
    expect(conservadorLiveV3.rebalanceBandBps).toBe(conservadorLiveV2.rebalanceBandBps)
    expect(conservadorLiveV3.minEntry).toBe(conservadorLiveV2.minEntry)
  })
})
