import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2 } from '@mamoru/policy'
import { approvalSpend, bandScan, lossBound, refuses, sideOf, spendOf, spotTwapDeviation, waitFor } from './action-policy.ts'
import { POOLS, syntheticDataset } from './fixtures.ts'
import { runBacktest } from './run.ts'

// otto/mamoru#151 T5: the Lab's band-wait and budget accounting.
describe('action policy Lab measurement (spec 007 T5)', () => {
  // Pool 1 jumps 300 ticks at sample 10 and stays there: spot leaves the 30-min TWAP, which catches up 30 min later.
  const ds = syntheticDataset({ samples: 40, step: 300, tick: (k, i) => (k === 1 && i >= 10 ? 300 : 0) })

  test('deviation is spot minus the trailing TWAP and closes once the window has passed the jump', () => {
    expect(spotTwapDeviation(ds, 1, 9, 1_800)).toBe(0)
    expect(spotTwapDeviation(ds, 1, 10, 1_800)).toBe(250) // 5 of the 6 samples in the window are still at the old tick
    expect(spotTwapDeviation(ds, 1, 16, 1_800)).toBe(0)
  })

  test('refuses: symmetric for mints, by direction for swaps', () => {
    expect(refuses(150, 100, 'symmetric')).toBe(true)
    expect(refuses(-150, 100, 'symmetric')).toBe(true)
    expect(refuses(150, 100, 'down')).toBe(false)
    expect(refuses(-150, 100, 'down')).toBe(true)
    expect(refuses(150, 100, 'up')).toBe(true)
    expect(sideOf({ kind: 'enter_mint', pool: POOLS[1], spend: [] })).toBe('symmetric')
    expect(sideOf({ kind: 'enter_swap', pool: POOLS[1], spend: [{ token: 'USDC', amount: 1n }] })).toBe('down') // USDC is token0
    expect(sideOf({ kind: 'enter_swap', pool: POOLS[1], spend: [{ token: 'cbBTC', amount: 1n }] })).toBe('up')
  })

  test('an op proposed inside the gap waits until the band accepts it', () => {
    const w = waitFor(ds, 1, 1_800, 100, 'symmetric', { i: 10, kind: 'rerange' })
    expect(w).toMatchObject({ refused: true, cleared: true, dev: 250 })
    // dev at sample i (10 + n) is 300 x (5 - n) / 6 for n < 5: 250, 200, 150, 100 -> accepted at n = 3.
    expect(w.waitSeconds).toBe(3 * 300)
    expect(waitFor(ds, 1, 1_800, 300, 'symmetric', { i: 10, kind: 'rerange' })).toMatchObject({ refused: false, waitSeconds: 0 })
    // A swap the jump favours is never refused.
    expect(waitFor(ds, 1, 1_800, 100, 'down', { i: 10, kind: 'enter_swap' }).refused).toBe(false)
  })

  test('bandScan counts refusing samples and the episode length', () => {
    const m = bandScan(ds, 1, 1_800, 100)
    expect(m).toMatchObject({ refused: 3, episodes: 1, longestSeconds: 900 })
    expect(bandScan(ds, 0, 1_800, 1).refused).toBe(0)
  })

  test('approvalSpend sums per fixed window from activation and over the approval', () => {
    const spend = [
      { time: 100, token: 'USDC', amount: 5n },
      { time: 86_400 + 1, token: 'USDC', amount: 7n },
      { time: 86_400 + 2, token: 'USDC', amount: 1n },
      { time: 86_400 + 3, token: 'USDT', amount: 9n },
      { time: 3 * 86_400, token: 'USDC', amount: 100n }, // outside a 2-day approval
    ]
    expect(approvalSpend(spend, 'USDC', 0, 2 * 86_400, 86_400)).toEqual({ total: 13n, perWindow: [5n, 8n] })
  })

  test('the spend of a real run is swaps amountIn and both mint amounts, never a decrease', () => {
    const r = runBacktest(syntheticDataset({ samples: 30, step: 600 }), conservadorLiveV2, { deposit: 1_000_000_000n })
    const ok = r.ops.filter((o) => o.ok)
    expect(ok.length).toBeGreaterThan(0)
    for (const o of ok) {
      if (o.kind === 'enter_swap' || o.kind === 'enter_mint') expect(o.spend!.length).toBeGreaterThan(0)
      if (o.kind === 'rerange' || o.kind === 'reduce') expect(o.spend).toEqual([])
    }
    const swaps = ok.filter((o) => o.kind === 'enter_swap' && o.pool === POOLS[1])
    expect(spendOf(r.ops, POOLS[1]).length).toBeGreaterThanOrEqual(swaps.length)
  })

  test('lossBound reproduces the spec 007 worked example (v3 weights, 1C/day, 3C/approval)', () => {
    const pools = [
      { share: 0.5, bandTicks: 10, feeBps: 1, w: 1, t: 3 },
      { share: 0.35, bandTicks: 100, feeBps: 5, w: 1, t: 3 },
      { share: 0.15, bandTicks: 100, feeBps: 30, w: 1, t: 3 },
    ]
    // Spec: 18.5 (1.85%) revoked within a day, 43.2 (4.3%) never; the spec rounds a tick to 1 bp.
    expect(lossBound(pools, 1)).toBeCloseTo(0.0185, 3)
    expect(lossBound(pools, 365)).toBeCloseTo(0.0432, 3)
  })
})
