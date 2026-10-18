import { describe, expect, test } from 'bun:test'
import type { Address } from '@mamoru/domain'
import {
  addBand,
  amountsForLiquidityAtPrice,
  bucketNow,
  budgetAllows,
  budgetValue,
  decreaseMinsInRange,
  DEFAULT_BAND_FACTOR_BPS,
  MAX_TICK,
  meanTick,
  MIN_TICK,
  narrowBand,
  oracleFromObserve,
  priceRange,
  quoteAtTick,
  subBand,
  swapBoundsInRange,
  type PriceRange,
} from './policy-bounds.ts'
import { sqrtRatioAtTick } from './quote.ts'

// Base USDC/cbBTC: USDC < cbBTC numerically is not guaranteed in general, but these two fixed addresses give a
// stable, arbitrary ordering to exercise both branches of quoteAtTick's `baseToken < quoteToken` comparison.
const LOW: Address = '0x0000000000000000000000000000000000000001'
const HIGH: Address = '0xffffffffffffffffffffffffffffffffffffffff'

describe('addBand / subBand', () => {
  test('clamp to TickMath bounds instead of overflowing past them', () => {
    expect(addBand(MAX_TICK - 5, 100)).toBe(MAX_TICK)
    expect(subBand(MIN_TICK + 5, 100)).toBe(MIN_TICK)
  })

  test('ordinary ticks are untouched', () => {
    expect(addBand(0, 100)).toBe(100)
    expect(subBand(0, 100)).toBe(-100)
  })
})

describe('narrowBand', () => {
  test('defaults to 0.8x, floored toward 0 (never wider than the real band)', () => {
    expect(narrowBand(100)).toBe(80)
    expect(narrowBand(10)).toBe(8)
    expect(narrowBand(1)).toBe(0) // floor(1 * 0.8) = 0: still never wider, even if it degenerates to no band at all
  })

  test('a custom factor scales the same way', () => {
    expect(narrowBand(100, 5_000)).toBe(50)
    expect(narrowBand(100, 10_000)).toBe(100)
    expect(DEFAULT_BAND_FACTOR_BPS).toBe(8_000)
  })
})

describe('quoteAtTick', () => {
  test('at tick 0 (price 1:1) a quote returns the same amount either direction', () => {
    expect(quoteAtTick(0, 1_000_000n, LOW, HIGH)).toBe(1_000_000n)
    expect(quoteAtTick(0, 1_000_000n, HIGH, LOW)).toBe(1_000_000n)
  })

  test('both ordering branches agree with the sqrt-price identity at a non-zero tick', () => {
    // price(tick) = (sqrtRatioAtTick(tick) / 2^96)^2 = quote-per-base when base < quote; its reciprocal otherwise.
    const tick = 1000
    const sqrt = sqrtRatioAtTick(tick)
    const priceNum = sqrt * sqrt
    const priceDen = 1n << 192n
    const amount = 10n ** 12n
    const lowBase = quoteAtTick(tick, amount, LOW, HIGH) // LOW < HIGH: base < quote branch
    const highBase = quoteAtTick(tick, amount, HIGH, LOW) // HIGH < LOW is false: the reciprocal branch
    expect(lowBase).toBe((priceNum * amount) / priceDen)
    expect(highBase).toBe((priceDen * amount) / priceNum)
  })

  test('refuses an amount over uint128', () => {
    expect(() => quoteAtTick(0, (1n << 128n) + 1n, LOW, HIGH)).toThrow('uint128')
  })
})

describe('amountsForLiquidityAtPrice', () => {
  test('price at or below the range: all amount0, no amount1', () => {
    const a = amountsForLiquidityAtPrice(sqrtRatioAtTick(-200), -100, 100, 10n ** 12n)
    expect(a.amount0).toBeGreaterThan(0n)
    expect(a.amount1).toBe(0n)
  })

  test('price at or above the range: all amount1, no amount0', () => {
    const a = amountsForLiquidityAtPrice(sqrtRatioAtTick(200), -100, 100, 10n ** 12n)
    expect(a.amount0).toBe(0n)
    expect(a.amount1).toBeGreaterThan(0n)
  })

  test('price inside the range: both positive', () => {
    const a = amountsForLiquidityAtPrice(sqrtRatioAtTick(0), -100, 100, 10n ** 12n)
    expect(a.amount0).toBeGreaterThan(0n)
    expect(a.amount1).toBeGreaterThan(0n)
  })
})

/** The range a single, unshifted TWAP `t` gives at `band` (both windows equal, no anchor). */
function at(t: number, band: number): PriceRange {
  return priceRange({ twapLong: t, twapShort: t }, band)!
}

describe('meanTick / oracleFromObserve (MamoruActionPolicy._oracle)', () => {
  test('meanTick floors toward -infinity like OracleLibrary.consult', () => {
    expect(meanTick(3_601n, 1800)).toBe(2)
    expect(meanTick(-3_601n, 1800)).toBe(-3)
    expect(meanTick(-3_600n, 1800)).toBe(-2)
  })

  test('oracleFromObserve folds observe([long, short, 0]) into both TWAPs', () => {
    const o = oracleFromObserve([0n, 1500n * 10n, 1500n * 10n + 300n * 40n], 1800, 300)
    expect(o.twapShort).toBe(40)
    expect(o.twapLong).toBe(Math.floor((1500 * 10 + 300 * 40) / 1800))
  })
})

describe('priceRange (MamoruActionPolicy._range)', () => {
  test('lo = max(long, short) - band + 1, hi = min(long, short) + band', () => {
    expect(priceRange({ twapLong: 0, twapShort: 30 }, 100)).toEqual({ lo: -69, hi: 100 })
    expect(priceRange({ twapLong: 30, twapShort: 0 }, 100)).toEqual({ lo: -69, hi: 100 })
  })

  test('TWAPs 2 x band apart leave an empty range: refused (null)', () => {
    expect(priceRange({ twapLong: 0, twapShort: 199 }, 100)).toEqual({ lo: 100, hi: 100 })
    expect(priceRange({ twapLong: 0, twapShort: 200 }, 100)).toBeNull()
  })

  test('T6 H-1: the anchor clips the range, and a range entirely outside it is refused', () => {
    const parity = { tick: 0, band: 40 }
    expect(priceRange({ twapLong: 14, twapShort: 14 }, 10, parity)).toEqual({ lo: 5, hi: 24 })
    expect(priceRange({ twapLong: -36, twapShort: -36 }, 10, parity)).toEqual({ lo: -40, hi: -26 })
    expect(priceRange({ twapLong: -86, twapShort: -86 }, 10, parity)).toBeNull()
    expect(priceRange({ twapLong: -86, twapShort: -86 }, 10, { tick: 0, band: 0 })).toEqual({ lo: -95, hi: -76 })
  })

  test('edges clamp to the tick space', () => {
    expect(at(MAX_TICK, 100).hi).toBe(MAX_TICK)
    expect(at(MIN_TICK, 100).lo).toBe(MIN_TICK)
  })
})

describe('swapBoundsInRange', () => {
  test('zeroForOne: the worst price is the lo edge (band - 1 ticks below the twap), a non-zero limit', () => {
    const b = swapBoundsInRange({ range: at(0, 100), feePips: 500, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 1_000_000n })
    expect(b.sqrtPriceLimitX96).toBe(sqrtRatioAtTick(-99))
    expect(b.sqrtPriceLimitX96).toBeLessThan(sqrtRatioAtTick(0))
    expect(b.minOut).toBeGreaterThan(0n)
  })

  test('oneForZero: the worst price is the hi edge, band ticks above the twap', () => {
    const b = swapBoundsInRange({ range: at(0, 100), feePips: 500, zeroForOne: false, tokenIn: HIGH, tokenOut: LOW, amountIn: 1_000_000n })
    expect(b.sqrtPriceLimitX96).toBe(sqrtRatioAtTick(100))
    expect(b.sqrtPriceLimitX96).toBeGreaterThan(sqrtRatioAtTick(0))
  })

  test('a narrower band (lower bandTicks) is strictly inside a wider one: higher minOut, tighter limit', () => {
    const wide = swapBoundsInRange({ range: at(0, 100), feePips: 500, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 10_000_000_000n })
    const narrow = swapBoundsInRange({ range: at(0, 80), feePips: 500, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 10_000_000_000n })
    expect(narrow.minOut).toBeGreaterThan(wide.minOut)
    expect(narrow.sqrtPriceLimitX96).toBeGreaterThan(wide.sqrtPriceLimitX96) // zeroForOne: tighter = higher floor
  })

  test('the fee is applied after the edge quote', () => {
    const noFee = swapBoundsInRange({ range: { lo: 0, hi: 0 }, feePips: 0, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 1_000_000n })
    const withFee = swapBoundsInRange({ range: { lo: 0, hi: 0 }, feePips: 3_000, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 1_000_000n })
    expect(withFee.minOut).toBeLessThan(noFee.minOut)
    expect(withFee.minOut).toBe((noFee.minOut * 997_000n) / 1_000_000n)
  })
})

describe('decreaseMinsInRange', () => {
  test('a range centred on the twap: both minimums positive and less than the in-range amounts', () => {
    const liquidity = 10n ** 12n
    const m = decreaseMinsInRange({ range: at(0, 50), tickLower: -1000, tickUpper: 1000, liquidity })
    expect(m.amount0Min).toBeGreaterThan(0n)
    expect(m.amount1Min).toBeGreaterThan(0n)
  })

  test('a narrower band gives minimums at least as high as a wider one (never a lower floor)', () => {
    const liquidity = 10n ** 12n
    const wide = decreaseMinsInRange({ range: at(0, 100), tickLower: -1000, tickUpper: 1000, liquidity })
    const narrow = decreaseMinsInRange({ range: at(0, 80), tickLower: -1000, tickUpper: 1000, liquidity })
    expect(narrow.amount0Min).toBeGreaterThanOrEqual(wide.amount0Min)
    expect(narrow.amount1Min).toBeGreaterThanOrEqual(wide.amount1Min)
  })

  test('a band that reaches past the range edge floors a minimum to 0, never negative or reverting', () => {
    const m = decreaseMinsInRange({ range: at(0, 2000), tickLower: -40, tickUpper: 40, liquidity: 10n ** 12n })
    expect(m.amount0Min).toBe(0n) // top edge is past tickUpper: all-token1 there, amount0 = 0
    expect(m.amount1Min).toBe(0n) // bottom edge is past tickLower: all-token0 there, amount1 = 0
  })
})

describe('budget (MamoruActionPolicy._value / _bucket / _charge)', () => {
  test('budgetValue: the other token converts at the edge that values it highest', () => {
    const r = { lo: -100, hi: 100 }
    // token1 -> token0 at lo: price of token0 in token1 is lowest there, so token1 buys the most token0.
    expect(budgetValue({ range: r, in1: false, token0: LOW, token1: HIGH, amount0: 5n, amount1: 1_000_000n })).toBe(5n + quoteAtTick(-100, 1_000_000n, HIGH, LOW))
    expect(quoteAtTick(-100, 1_000_000n, HIGH, LOW)).toBeGreaterThan(1_000_000n)
    // token0 -> token1 at hi.
    expect(budgetValue({ range: r, in1: true, token0: LOW, token1: HIGH, amount0: 1_000_000n, amount1: 5n })).toBe(5n + quoteAtTick(100, 1_000_000n, LOW, HIGH))
  })

  test('bucketNow refills perWindow/window per second (floored) and resets the total on a new generation only', () => {
    const budget = { generation: 2n, windowSeconds: 86_400, perWindow: 86_400_000n, total: 10n ** 12n }
    const spend = { generation: 2n, updatedAt: 100n, in1: false, debt: 50_000_000n, total: 70_000_000n }
    expect(bucketNow(spend, budget, 100n)).toEqual({ debt: 50_000_000n, spent: 70_000_000n })
    expect(bucketNow(spend, budget, 110n)).toEqual({ debt: 50_000_000n - 10_000n, spent: 70_000_000n })
    expect(bucketNow(spend, budget, 100n + 86_400n)).toEqual({ debt: 0n, spent: 70_000_000n })
    expect(bucketNow({ ...spend, generation: 1n }, budget, 100n)).toEqual({ debt: 50_000_000n, spent: 0n })
  })

  test('budgetAllows: within both the bucket and the total, never past either', () => {
    const budget = { generation: 1n, windowSeconds: 86_400, perWindow: 100n, total: 150n }
    const spend = { generation: 1n, updatedAt: 0n, in1: false, debt: 0n, total: 0n }
    expect(budgetAllows(spend, budget, 0n, 100n).ok).toBe(true)
    expect(budgetAllows(spend, budget, 0n, 101n).ok).toBe(false)
    expect(budgetAllows({ ...spend, total: 100n }, budget, 0n, 51n).ok).toBe(false)
  })
})
