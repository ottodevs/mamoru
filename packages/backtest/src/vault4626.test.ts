import { describe, expect, test } from 'bun:test'
import { syntheticDataset } from './fixtures.ts'
import { DEFAULT_GAS } from './run.ts'
import { breakEvenDays, breakEvenDeposit, effectiveApyPct, growthFromPrice, growthFromRates, opGasRaw, priceAt, vaultGrowth, vaultRun, type RatePoint } from './vault4626.ts'

const DAY = 86_400
const YEAR = 365 * DAY

describe('growth from a daily rate series', () => {
  const flat = (pct: number, n = 400): RatePoint[] => Array.from({ length: n }, (_, i) => ({ time: i * DAY, ratePct: pct }))

  test('a flat APY compounds to itself over a year; an APR read daily compounds daily', () => {
    expect(growthFromRates(flat(5), 0, YEAR, 'apy')!).toBeCloseTo(1.05, 10)
    expect(growthFromRates(flat(5), 0, YEAR, 'apr')!).toBeCloseTo((1 + 0.05 / 365) ** 365, 10)
    expect(growthFromRates(flat(5), 10 * DAY, 10 * DAY, 'apy')!).toBe(1)
  })

  test('review #186 (2): each reading applies forward from its own time', () => {
    const pts: RatePoint[] = [
      { time: 0, ratePct: 10 },
      { time: DAY, ratePct: 0 },
      { time: 2 * DAY, ratePct: 0 },
    ]
    // Day 0-1 at 10% (the reading of day 0), day 1-2 at 0%.
    expect(growthFromRates(pts, 0, 2 * DAY, 'apy')!).toBeCloseTo(1.1 ** (1 / 365), 12)
    expect(growthFromRates(pts, DAY / 2, 2 * DAY, 'apy')!).toBeCloseTo(1.1 ** (0.5 / 365), 12)
    // APR: linear inside the reading's day.
    expect(growthFromRates(pts, 0, DAY, 'apr')!).toBeCloseTo(1 + 0.1 / 365, 12)
  })

  test('review #186 (4): a missing base rate is a gap, not zero', () => {
    const pts: RatePoint[] = [
      { time: 0, ratePct: 4 },
      { time: DAY, ratePct: null },
      { time: 2 * DAY, ratePct: 4 },
      { time: 3 * DAY, ratePct: 4 },
    ]
    expect(growthFromRates(pts, 0, 3 * DAY, 'apy')).toBeNull()
    expect(growthFromRates(pts, 2 * DAY, 3 * DAY, 'apy')).not.toBeNull()
  })

  test('review #186 (6): the series must cover the whole window', () => {
    const pts: RatePoint[] = [{ time: 100, ratePct: 4 }]
    // Before the first reading: unavailable.
    expect(growthFromRates(pts, 99, 200, 'apy')).toBeNull()
    expect(growthFromRates([], 0, 1, 'apy')).toBeNull()
    // The last reading is not carried past the gap limit.
    expect(growthFromRates(pts, 100, 100 + DAY, 'apy')).not.toBeNull()
    expect(growthFromRates(pts, 100, 100 + 3 * DAY, 'apy')).toBeNull()
    // A gap of 3 days inside the window.
    const gappy: RatePoint[] = [{ time: 0, ratePct: 4 }, { time: 3 * DAY, ratePct: 4 }, { time: 4 * DAY, ratePct: 4 }]
    expect(growthFromRates(gappy, 0, 4 * DAY, 'apy')).toBeNull()
    expect(growthFromRates(gappy, 3 * DAY, 4 * DAY, 'apy')).not.toBeNull()
    // A stale reading before the window's start counts as a gap too.
    expect(growthFromRates(gappy, 2.5 * DAY, 4 * DAY, 'apy')).toBeNull()
  })

  test('refuses an interval that runs backwards', () => {
    expect(() => growthFromRates([{ time: 0, ratePct: 1 }], 5, 1, 'apy')).toThrow()
  })
})

describe('growth from the share price', () => {
  const pts = [
    { time: 0, price: 1 },
    { time: DAY, price: 1.01 },
    { time: 2 * DAY, price: 1.0201 },
    { time: 5 * DAY, price: 1.03 },
  ]
  test('geometric between readings, null outside or across a gap', () => {
    expect(priceAt(pts, DAY)).toBe(1.01)
    expect(priceAt(pts, DAY / 2)!).toBeCloseTo(Math.sqrt(1.01), 12)
    expect(priceAt(pts, 6 * DAY)).toBeNull()
    expect(priceAt(pts, 3 * DAY)).toBeNull()
    expect(growthFromPrice(pts, DAY / 2, 2 * DAY)!).toBeCloseTo(1.0201 / Math.sqrt(1.01), 12)
    expect(growthFromPrice(pts, -1, DAY)).toBeNull()
  })
})

describe('review #186 (1, 5): which growth a window gets', () => {
  const rates: RatePoint[] = Array.from({ length: 40 }, (_, i) => ({ time: i * DAY, ratePct: 5 }))
  const prices = Array.from({ length: 40 }, (_, i) => ({ time: i * DAY, price: 1 + i * 0.001 }))
  test('a window before the vault contract existed is unavailable, whatever the reserve history', () => {
    const g = vaultGrowth({ created: 10 * DAY, rates, convention: 'apr' }, 5 * DAY, 12 * DAY)
    expect(g.status).toBe('predates')
    expect(g.growth).toBeNull()
    expect(vaultGrowth({ created: 10 * DAY, rates, convention: 'apr' }, 10 * DAY, 12 * DAY).status).toBe('ok')
  })
  test('the observed share price wins over the rate model, which is kept for the discrepancy', () => {
    const g = vaultGrowth({ created: 0, rates, convention: 'apy', prices }, 2 * DAY, 12 * DAY)
    expect(g.source).toBe('price')
    expect(g.growth!).toBeCloseTo(1.012 / 1.002, 12)
    expect(g.model!).toBeCloseTo(1.05 ** (10 / 365), 12)
    expect(vaultGrowth({ created: 0, rates, convention: 'apy' }, 2 * DAY, 12 * DAY).source).toBe('rates')
  })
  test('a price series that does not cover the window is a gap, not a fallback to the model', () => {
    const g = vaultGrowth({ created: 0, rates, convention: 'apy', prices: prices.slice(0, 5) }, 2 * DAY, 12 * DAY)
    expect(g.status).toBe('gap')
    expect(g.model).not.toBeNull()
  })
})

describe('the vault arm', () => {
  test('interest minus both operations, against holding USDC', () => {
    const r = vaultRun(1000, 1.004, 0.02, 0.03)
    expect(r.interest).toBeCloseTo(4, 10)
    expect(r.gas).toBeCloseTo(0.05, 10)
    expect(r.end).toBeCloseTo(1003.95, 10)
    expect(r.net).toBeCloseTo(3.95, 10)
    expect(r.returnPct).toBeCloseTo(0.395, 10)
    expect(() => vaultRun(0, 1, 0, 0)).toThrow()
  })

  test('break-even time and deposit are each other inverse', () => {
    const days = breakEvenDays(50, 4.5, 0.1)
    expect(days).toBeGreaterThan(16)
    expect(days).toBeLessThan(17)
    expect(breakEvenDeposit(days, 4.5, 0.1)).toBeCloseTo(50, 6)
    expect(breakEvenDays(50, 0, 0.1)).toBe(Number.POSITIVE_INFINITY)
    expect(breakEvenDays(50, 4, 0)).toBe(0)
    expect(breakEvenDeposit(0, 4, 0.1)).toBe(Number.POSITIVE_INFINITY)
    expect(effectiveApyPct(4, 'apy')).toBe(4)
    expect(effectiveApyPct(4, 'apr')).toBeCloseTo(4.0808, 3)
  })
})

describe('gas of a vault operation', () => {
  test('the simulator formula, priced through WETH/USDC, grows with the units', () => {
    const ds = syntheticDataset({ samples: 2 })
    const s = ds.samples[0]!
    const a = opGasRaw(ds, s, 600_000n)
    const b = opGasRaw(ds, s, 1_200_000n)
    // 600k x (0.005 + 0.001 gwei) + 3.1e9 wei = 3.6e-6 ETH, about a cent at the fixture's ETH price.
    expect(a).toBeGreaterThan(5_000n)
    expect(a).toBeLessThan(20_000n)
    expect(b).toBeGreaterThan(a)
    // The L1 fee is paid once per operation whatever the units: twice the units costs less than twice.
    expect(b).toBeLessThan(2n * a + 1n)
    expect(opGasRaw(ds, s, 0n, { ...DEFAULT_GAS, l1FeeWei: 0n })).toBe(0n)
  })
})
