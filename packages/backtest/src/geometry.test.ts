import { describe, expect, test } from 'bun:test'
import { conservadorLabGeometryV1, conservadorLiveV2, type PolicyVersion } from '@mamoru/policy'
import { POOLS, syntheticDataset } from './fixtures.ts'
import { geometryOf } from './observe.ts'
import { runBacktest } from './run.ts'
import { applyOverrides } from './sweep.ts'

const DEPOSIT = 1_000n * 1_000_000n
const SLOW = 60_000
const STEP = 600
const DAY = 86_400 / STEP
const GROWTH = [1n << 103n, 1n << 104n, 1n << 96n] as const
const zig = (i: number) => (((i * 2_654_435_761) >>> 0) % 401) - 200
// cbBTC (token1) falls when the tick rises; WETH (token0) when it falls. From day 2, 12% in 12 h.
const fall = (i: number) => (i < 2 * DAY ? 0 : Math.min(i - 2 * DAY, DAY / 2) * Math.round(1_280 / (DAY / 2)))
const crash = syntheticDataset({ samples: 4 * DAY, step: STEP, growth: GROWTH, tick: (k, i) => (k === 0 ? 0 : k === 1 ? zig(i) + fall(i) : zig(i) - fall(i)) })
const calm = syntheticDataset({ samples: 4 * DAY, step: STEP, growth: GROWTH, tick: (k, i) => (k === 0 ? 0 : zig(i)) })

const SKEW = { belowShareBps: 8_000, regime: 'ret24h', fallBps: 400, mirror: false } as const
const skewed: PolicyVersion = { ...conservadorLabGeometryV1, policyId: 'test-skew', geometry: { skew: { ...SKEW } } }
const volWide: PolicyVersion = { ...conservadorLabGeometryV1, policyId: 'test-vol', geometry: { volWidth: { k: 2, horizonSeconds: 86_400, minTicks: 600, maxTicks: 6_000, earlyRatio: 2 } } }
const strip = (r: ReturnType<typeof runBacktest>) => r.ops.map(({ trail: _t, ...o }) => o)

describe('Lab regression: range geometry (#101)', () => {
  test('observe builds geometry history only once a day of samples exists', () => {
    const early = geometryOf(crash, 10, 1_800).pools[POOLS[1]]!
    expect(early.twap24hAgoTick).toBeNull()
    expect(early.vol24hBps).toBeNull()
    expect(early.vol7dBps).toBeNull()
    expect(early.emaTick).toBeNull()
    expect(early.vol1hBps).not.toBeNull()
    const later = geometryOf(crash, 3 * DAY, 1_800).pools[POOLS[1]]!
    for (const v of Object.values(later)) expect(v).not.toBeNull()
    // In the fall the 24 h-ago TWAP is far from now, and the EMA lags behind the price.
    expect(later.twap24hAgoTick!).toBeLessThan(crash.samples[3 * DAY]!.pools[1]!.tick - 1_000)
  })

  test('the lab policy without a rule trades exactly as conservador-live-v2', () => {
    const a = runBacktest(crash, conservadorLiveV2, { deposit: DEPOSIT })
    const b = runBacktest(crash, conservadorLabGeometryV1, { deposit: DEPOSIT })
    expect(b.metrics).toEqual(a.metrics)
    expect(strip(b)).toEqual(strip(a))
  }, SLOW)

  test('calm (no 4% move in 24 h): the skew rule never fires, the run is the baseline one', () => {
    const a = runBacktest(calm, conservadorLabGeometryV1, { deposit: DEPOSIT })
    const b = runBacktest(calm, skewed, { deposit: DEPOSIT })
    expect(b.metrics).toEqual(a.metrics)
    expect(strip(b)).toEqual(strip(a))
  }, SLOW)

  test('fall: re-mints in the falling pools are skewed, so the run differs', () => {
    const a = runBacktest(crash, conservadorLabGeometryV1, { deposit: DEPOSIT })
    const b = runBacktest(crash, skewed, { deposit: DEPOSIT })
    expect(strip(b)).not.toEqual(strip(a))
  }, SLOW)

  test('volatility width: re-mints once history exists are not the fixed 2,000 ticks, so the run differs', () => {
    const a = runBacktest(crash, conservadorLabGeometryV1, { deposit: DEPOSIT })
    const b = runBacktest(crash, volWide, { deposit: DEPOSIT })
    expect(strip(b)).not.toEqual(strip(a))
  }, SLOW)
})

describe('sweep overrides for the geometry rules', () => {
  test('a rule is given whole; the group need not hold both', () => {
    const p = applyOverrides(conservadorLabGeometryV1, { geometry: { skew: { ...SKEW } } })
    expect(p.geometry).toEqual({ skew: SKEW })
    expect(() => applyOverrides(conservadorLabGeometryV1, { geometry: { skew: { belowShareBps: 8_000 } } })).toThrow(/give/)
    expect(() => applyOverrides(conservadorLabGeometryV1, { geometry: { skew: { ...SKEW, regime: 'ema30d' } } })).toThrow(/ret24h \| ema7d/)
    expect(() => applyOverrides(conservadorLabGeometryV1, { geometry: { skew: { ...SKEW, mirror: 1 } } })).toThrow(/boolean/)
    expect(() => applyOverrides(conservadorLabGeometryV1, { geometry: { skwe: {} } })).toThrow(/no such parameter/)
  })
})
