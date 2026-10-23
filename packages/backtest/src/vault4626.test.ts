import { describe, expect, test } from 'bun:test'
import { syntheticDataset } from './fixtures.ts'
import { DEFAULT_GAS } from './run.ts'
import { breakEvenDays, breakEvenDeposit, growthFromApy, growthFromPrice, opGasRaw, priceAt, vaultRun, type RatePoint } from './vault4626.ts'

const DAY = 86_400
const YEAR = 365 * DAY

describe('growth from a daily APY series', () => {
  test('a flat rate compounds to the APY over a year', () => {
    const pts: RatePoint[] = Array.from({ length: 400 }, (_, i) => ({ time: i * DAY, apyPct: 5 }))
    expect(growthFromApy(pts, 0, YEAR)!).toBeCloseTo(1.05, 10)
    expect(growthFromApy(pts, 10 * DAY, 10 * DAY)!).toBe(1)
  })

  test('the rate between two readings is the later one (trailing)', () => {
    const pts: RatePoint[] = [
      { time: 0, apyPct: 0 },
      { time: DAY, apyPct: 10 },
      { time: 2 * DAY, apyPct: 0 },
    ]
    // Day 0-1 at 10%, day 1-2 at 0%.
    expect(growthFromApy(pts, 0, 2 * DAY)!).toBeCloseTo(1.1 ** (1 / 365), 12)
    // Half of the first day only.
    expect(growthFromApy(pts, DAY / 2, DAY)!).toBeCloseTo(1.1 ** (0.5 / 365), 12)
  })

  test('after the last reading its rate goes on; before the first there is no vault', () => {
    const pts: RatePoint[] = [{ time: 100, apyPct: 4 }]
    expect(growthFromApy(pts, 100, 100 + YEAR)!).toBeCloseTo(1.04, 10)
    expect(growthFromApy(pts, 99, 200)).toBeNull()
    expect(growthFromApy([], 0, 1)).toBeNull()
  })

  test('refuses an interval that runs backwards', () => {
    expect(() => growthFromApy([{ time: 0, apyPct: 1 }], 5, 1)).toThrow()
  })
})

describe('growth from the share price', () => {
  const pts = [
    { time: 0, price: 1 },
    { time: DAY, price: 1.01 },
    { time: 2 * DAY, price: 1.0201 },
  ]
  test('geometric between readings, null outside', () => {
    expect(priceAt(pts, DAY)).toBe(1.01)
    expect(priceAt(pts, DAY / 2)!).toBeCloseTo(Math.sqrt(1.01), 12)
    expect(priceAt(pts, 3 * DAY)).toBeNull()
    expect(growthFromPrice(pts, DAY / 2, 2 * DAY)!).toBeCloseTo(1.0201 / Math.sqrt(1.01), 12)
    expect(growthFromPrice(pts, -1, DAY)).toBeNull()
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
