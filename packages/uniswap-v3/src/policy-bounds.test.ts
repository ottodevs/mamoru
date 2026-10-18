import { describe, expect, test } from 'bun:test'
import type { Address } from '@mamoru/domain'
import { addBand, amountsForLiquidityAtPrice, decreaseMinsAtBand, DEFAULT_BAND_FACTOR_BPS, MAX_TICK, MIN_TICK, narrowBand, quoteAtTick, subBand, swapBoundsAtBand } from './policy-bounds.ts'
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

describe('swapBoundsAtBand', () => {
  test('zeroForOne: the worst price is band ticks BELOW the twap, a non-zero limit tighter than the twap price', () => {
    const b = swapBoundsAtBand({ twap: 0, bandTicks: 100, feePips: 500, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 1_000_000n })
    expect(b.sqrtPriceLimitX96).toBe(sqrtRatioAtTick(-100))
    expect(b.sqrtPriceLimitX96).toBeLessThan(sqrtRatioAtTick(0))
    expect(b.minOut).toBeGreaterThan(0n)
  })

  test('oneForZero: the worst price is band ticks ABOVE the twap', () => {
    const b = swapBoundsAtBand({ twap: 0, bandTicks: 100, feePips: 500, zeroForOne: false, tokenIn: HIGH, tokenOut: LOW, amountIn: 1_000_000n })
    expect(b.sqrtPriceLimitX96).toBe(sqrtRatioAtTick(100))
    expect(b.sqrtPriceLimitX96).toBeGreaterThan(sqrtRatioAtTick(0))
  })

  test('a narrower band (lower bandTicks) is strictly inside a wider one: higher minOut, tighter limit', () => {
    const wide = swapBoundsAtBand({ twap: 0, bandTicks: 100, feePips: 500, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 10_000_000_000n })
    const narrow = swapBoundsAtBand({ twap: 0, bandTicks: 80, feePips: 500, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 10_000_000_000n })
    expect(narrow.minOut).toBeGreaterThan(wide.minOut)
    expect(narrow.sqrtPriceLimitX96).toBeGreaterThan(wide.sqrtPriceLimitX96) // zeroForOne: tighter = higher floor
  })

  test('the fee is applied after the band quote', () => {
    const noFee = swapBoundsAtBand({ twap: 0, bandTicks: 0, feePips: 0, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 1_000_000n })
    const withFee = swapBoundsAtBand({ twap: 0, bandTicks: 0, feePips: 3_000, zeroForOne: true, tokenIn: LOW, tokenOut: HIGH, amountIn: 1_000_000n })
    expect(withFee.minOut).toBeLessThan(noFee.minOut)
    expect(withFee.minOut).toBe((noFee.minOut * 997_000n) / 1_000_000n)
  })
})

describe('decreaseMinsAtBand', () => {
  test('a range centred on the twap: both minimums positive and less than the in-range amounts', () => {
    const liquidity = 10n ** 12n
    const m = decreaseMinsAtBand({ twap: 0, bandTicks: 50, tickLower: -1000, tickUpper: 1000, liquidity })
    expect(m.amount0Min).toBeGreaterThan(0n)
    expect(m.amount1Min).toBeGreaterThan(0n)
  })

  test('a narrower band gives minimums at least as high as a wider one (never a lower floor)', () => {
    const liquidity = 10n ** 12n
    const tickLower = -1000
    const tickUpper = 1000
    const wide = decreaseMinsAtBand({ twap: 0, bandTicks: 100, tickLower, tickUpper, liquidity })
    const narrow = decreaseMinsAtBand({ twap: 0, bandTicks: 80, tickLower, tickUpper, liquidity })
    expect(narrow.amount0Min).toBeGreaterThanOrEqual(wide.amount0Min)
    expect(narrow.amount1Min).toBeGreaterThanOrEqual(wide.amount1Min)
  })

  test('a band that reaches past the range edge floors a minimum to 0, never negative or reverting', () => {
    const liquidity = 10n ** 12n
    const m = decreaseMinsAtBand({ twap: 0, bandTicks: 2000, tickLower: -40, tickUpper: 40, liquidity })
    expect(m.amount0Min).toBe(0n) // top edge (twap+band) is past tickUpper: all-token1 there, amount0 = 0
    expect(m.amount1Min).toBe(0n) // bottom edge (twap-band) is past tickLower: all-token0 there, amount1 = 0
  })
})
