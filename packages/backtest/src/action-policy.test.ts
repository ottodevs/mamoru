// Spec 007 (otto/mamoru#151), task T5.
import { describe, expect, test } from 'bun:test'
import { keccak256, toHex } from 'viem'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { bandGrid, exitWaits, scanBand, scanBudget, spendOf, spotTwapDeviation, waitStats, type PoolTokenSpend } from './action-policy.ts'
import { makeDataset } from './dataset.ts'
import type { Dataset, OpEntry, PoolSample, Sample } from './types.ts'

const STEP = 300
const POOL = 'pool:USDC/USDT/100' as const

/**
 * A one-pool dataset where `tickCumulative` is pinned to 0 at every sample: `twapTick` then always answers 0 (the
 * delta over any window is 0), so `spot - twap === tick` exactly. This lets the tests drive the deviation directly
 * through `tick`, instead of reproducing the TWAP's own averaging (already exercised by `observe.ts`'s tests).
 */
function pinnedTwapDataset(ticks: readonly (number | null)[]): Dataset {
  const samples: Sample[] = ticks.map((tick, i) => ({
    block: 1_000_000 + i * (STEP / 2),
    hash: keccak256(toHex(`b${i}`)),
    time: 1_800_000_000 + i * STEP,
    baseFeeWei: 1_000_000n,
    pools: [tick === null ? null : ({ sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 1_000_000n, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n, tickCumulative: 0n } satisfies PoolSample)],
  }))
  return makeDataset(8453, [POOL], samples)
}

describe('scanBand', () => {
  test('counts breach samples and folds consecutive ones into one episode', () => {
    // 0,0,0 (calm) then 150,150,150 (breach, 3 samples = 600s) then 0,0 (calm again).
    const ds = pinnedTwapDataset([0, 0, 0, 150, 150, 150, 0, 0])
    const scan = scanBand(ds, 0, 1_800, 100)
    expect(scan.samples).toBe(8)
    expect(scan.breachSamples).toBe(3)
    expect(scan.breachRatePct).toBeCloseTo(37.5, 6)
    expect(scan.episodes).toHaveLength(1)
    expect(scan.episodes[0]).toMatchObject({ seconds: 2 * STEP, peakDeviation: 150 })
    expect(scan.maxEpisodeSeconds).toBe(2 * STEP)
  })

  test('two separated breaches are two episodes', () => {
    // A 7-sample calm warm-up before each breach, so `twapTick` has real window history by the time it is asked
    // (at sample 0 it has none and falls back to the spot itself, spuriously reading a zero deviation there).
    const ds = pinnedTwapDataset([0, 0, 0, 0, 0, 0, 0, 150, 0, 0, 0, 0, 0, 0, 150, 0, 0])
    const scan = scanBand(ds, 0, 1_800, 100)
    expect(scan.breachSamples).toBe(2)
    expect(scan.episodes).toHaveLength(2)
    expect(scan.episodes.every((e) => e.seconds === 0)).toBe(true)
  })

  test('a pool unread (null) is excluded from the sample count and does not bridge an episode across a long gap', () => {
    const warmup = [0, 0, 0, 0, 0, 0, 0]
    const gap = new Array<null>(10).fill(null)
    const ticks: (number | null)[] = [...warmup, 150, ...gap, ...warmup, 150]
    const ds = pinnedTwapDataset(ticks)
    const scan = scanBand(ds, 0, 1_800, 100)
    // 16 real samples (7 + 1 + 7 + 1), 10 null ones excluded from the count entirely.
    expect(scan.samples).toBe(16)
    expect(scan.breachSamples).toBe(2)
    // The gap (10 * 300s = 3,000s) exceeds the TWAP window (1,800s): two episodes, not one spanning the gap.
    expect(scan.episodes).toHaveLength(2)
  })

  test('never exceeding the band: no episodes, zero rate', () => {
    const ds = pinnedTwapDataset([0, 10, -10, 20, -20])
    const scan = scanBand(ds, 0, 1_800, 100)
    expect(scan.breachSamples).toBe(0)
    expect(scan.episodes).toHaveLength(0)
    expect(scan.breachRatePct).toBe(0)
  })
})

describe('bandGrid', () => {
  test('one row per band x factor, threshold floored like narrowBand', () => {
    const ds = pinnedTwapDataset([0, 85, 0])
    const rows = bandGrid(ds, 0, 1_800, [100, 50], [0.8, 0.9])
    expect(rows).toHaveLength(4)
    // band 100 x 0.8 -> threshold 80: 85 breaches it. band 100 x 0.9 -> threshold 90: 85 does not.
    const r1 = rows.find((r) => r.band === 100 && r.factor === 0.8)!
    const r2 = rows.find((r) => r.band === 100 && r.factor === 0.9)!
    expect(r1.thresholdTicks).toBe(80)
    expect(r1.breachSamples).toBe(1)
    expect(r2.thresholdTicks).toBe(90)
    expect(r2.breachSamples).toBe(0)
  })
})

describe('spotTwapDeviation', () => {
  test('null where the pool was not read', () => {
    const ds = pinnedTwapDataset([0, null])
    expect(spotTwapDeviation(ds, 0, 0, 1_800)).toBe(0)
    expect(spotTwapDeviation(ds, 0, 1, 1_800)).toBeNull()
  })
})

describe('exitWaits', () => {
  test('an exit proposed inside the band waits nothing', () => {
    const ds = pinnedTwapDataset([0, 0, 0])
    const [w] = exitWaits(ds, 0, 1_800, 100, [{ i: 1, kind: 'reduce' }])
    expect(w).toMatchObject({ breached: false, waitSeconds: 0, cleared: true, priceMoveBps: 0 })
  })

  test('an exit proposed outside the band waits until the deviation clears, and measures the price move over the wait', () => {
    // Breach at i=1 (tick 150), clears at i=4 (tick 50, inside the 100-tick band).
    const ds = pinnedTwapDataset([0, 150, 140, 120, 50, 0])
    const [w] = exitWaits(ds, 0, 1_800, 100, [{ i: 1, kind: 'rerange' }])
    expect(w!.breached).toBe(true)
    expect(w!.cleared).toBe(true)
    expect(w!.waitSeconds).toBe(3 * STEP)
    // token0 tick fell from 150 to 50: its price fell (a loss for an exit that was waiting to sell it).
    expect(w!.priceMoveBps).toBeLessThan(0)
  })

  test('a breach that never clears before the window ends is censored, not silently dropped', () => {
    const ds = pinnedTwapDataset([0, 150, 160, 170])
    const [w] = exitWaits(ds, 0, 1_800, 100, [{ i: 1, kind: 'reduce' }])
    expect(w!.breached).toBe(true)
    expect(w!.cleared).toBe(false)
    expect(w!.waitSeconds).toBe(2 * STEP)
  })
})

describe('waitStats', () => {
  test('median, p95 and max over breached exits only; an all-clear set has zero breached', () => {
    const waits = [0, 100, 200, 300, 1_000].map((waitSeconds) => ({ time: 0, i: 0, kind: 'reduce' as const, deviationAtProposal: 150, breached: true, waitSeconds, cleared: true, priceMoveBps: 0 }))
    const s = waitStats(waits)
    expect(s.breached).toBe(5)
    expect(s.of).toBe(5)
    expect(s.maxSeconds).toBe(1_000)
    expect(s.medianSeconds).toBe(200)
    expect(s.censored).toBe(0)
  })

  test('un-breached exits do not count toward the breached stats', () => {
    const clear = { time: 0, i: 0, kind: 'reduce' as const, deviationAtProposal: 10, breached: false, waitSeconds: 0, cleared: true, priceMoveBps: 0 }
    const breach = { ...clear, breached: true, deviationAtProposal: 150, waitSeconds: 500, cleared: false }
    const s = waitStats([clear, clear, breach])
    expect(s.of).toBe(3)
    expect(s.breached).toBe(1)
    expect(s.censored).toBe(1)
    expect(s.maxSeconds).toBe(500)
  })
})

describe('spendOf', () => {
  function op(over: Partial<OpEntry>): OpEntry {
    return { i: 0, block: 0, time: 0, kind: 'enter_swap', pool: POOL, grant: 'enter-swap', code: 'DECIDE_ENTER', reason: 'DECIDE_ENTER', trail: [], ok: true, gasCost: 0n, feesValue: 0n, ...over }
  }

  test('only reads ok ops of the named pool, and drops zero amounts', () => {
    const other = 'pool:USDC/cbBTC/500' as const
    const ops: OpEntry[] = [
      op({ time: 10, spend: [{ token: 'USDC', amount: 100n }] }),
      op({ time: 20, pool: other, spend: [{ token: 'USDC', amount: 999n }] }),
      op({ time: 30, ok: false, detail: 'x' }),
      op({ time: 5, spend: [{ token: 'USDC', amount: 0n }, { token: 'USDT', amount: 50n }] }),
    ]
    const spend = spendOf(ops, POOL)
    expect(spend).toEqual([
      { time: 5, token: 'USDT', amount: 50n },
      { time: 10, token: 'USDC', amount: 100n },
    ])
  })
})

describe('scanBudget', () => {
  const DAY = 86_400

  test('a window spend under the cap, and a total under its cap, breach neither', () => {
    const spend: PoolTokenSpend[] = [
      { time: 0, token: 'USDC', amount: 40n },
      { time: DAY + 10, token: 'USDC', amount: 30n },
    ]
    const r = scanBudget(spend, 'USDC', 0, 2 * DAY, DAY, 100n, 300n)
    expect(r.windowsScanned).toBe(3)
    expect(r.peakWindowSpend).toBe(40n)
    expect(r.windowBreaches).toBe(0)
    expect(r.totalSpend).toBe(70n)
    expect(r.totalBreached).toBe(false)
  })

  test('one day over W_p is counted even when the running total stays under T_p', () => {
    const spend: PoolTokenSpend[] = [{ time: 10, token: 'USDC', amount: 150n }]
    const r = scanBudget(spend, 'USDC', 0, DAY, DAY, 100n, 300n)
    expect(r.windowBreaches).toBe(1)
    expect(r.peakWindowSpendPct).toBeCloseTo(150, 6)
    expect(r.totalBreached).toBe(false)
  })

  test('the running total can breach T_p without any single window breaching W_p', () => {
    const spend: PoolTokenSpend[] = Array.from({ length: 4 }, (_, k) => ({ time: k * DAY + 10, token: 'USDC', amount: 90n }))
    const r = scanBudget(spend, 'USDC', 0, 3 * DAY, DAY, 100n, 300n)
    expect(r.windowBreaches).toBe(0)
    expect(r.totalSpend).toBe(360n)
    expect(r.totalBreached).toBe(true)
  })

  test('a zero cap never counts as breached (an unconfigured budget, not an impossible one)', () => {
    const r = scanBudget([{ time: 0, token: 'USDC', amount: 1n }], 'USDC', 0, DAY, DAY, 0n, 0n)
    expect(r.windowBreaches).toBe(0)
    expect(r.totalBreached).toBe(false)
  })
})
