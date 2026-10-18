import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, conservadorLiveV4 } from '@mamoru/policy'
import { syntheticDataset } from './fixtures.ts'
import { runBacktest } from './run.ts'

// otto/mamoru#171: top-ups into a calm market, where every bucket already holds a position around the price.
const USDC = 1_000_000n
const STEP = 600
const DAY = 86_400 / STEP
const GROWTH = [1n << 103n, 1n << 104n, 1n << 96n] as const
const calm = syntheticDataset({ samples: 2 * DAY, step: STEP, growth: GROWTH })
const config = { deposit: 1_000n * USDC, topUps: [{ at: DAY / 2, amount: 500n * USDC }, { at: DAY, amount: 500n * USDC }] }

describe('Lab: increase instead of a second mint (otto/mamoru#171)', () => {
  const live = runBacktest(calm, conservadorLiveV2, config)
  const lab = runBacktest(calm, conservadorLiveV4, config)
  const nfts = (r: typeof live) => r.ops.filter((o) => o.ok && o.kind === 'enter_mint').length

  test('conservador-live-v2 mints a new NFT for each top-up; v4 mints one per pool and adds to it', () => {
    expect(live.metrics.operations.increase_liquidity).toBe(0)
    expect(nfts(lab)).toBe(3)
    expect(nfts(live)).toBeGreaterThan(3)
    expect(lab.metrics.operations.increase_liquidity).toBe(nfts(live) - nfts(lab))
    for (const o of lab.ops.filter((o) => o.kind === 'increase_liquidity')) expect(o.grant).toMatch(/^engine:pool:/)
  })

  test('the same money goes in, for less entry gas', () => {
    // Entry gas only: harvests follow fees per position, and one larger position crosses the harvest cost sooner than
    // three small ones, so over two days the total can go either way (the Lab replay measures it on real windows).
    const entryGas = (r: typeof live) => r.ops.filter((o) => o.ok && (o.kind === 'enter_mint' || o.kind === 'increase_liquidity')).reduce((s, o) => s + o.gasCost, 0n)
    expect(entryGas(lab)).toBeLessThan(entryGas(live))
    // Within 0.1% of the same end value before gas: the same entries, into one position per pool instead of several.
    const before = (r: typeof live) => r.metrics.end + r.metrics.gas
    const diff = before(lab) - before(live)
    expect((diff < 0n ? -diff : diff) * 1_000n).toBeLessThan(before(live))
  })
})
