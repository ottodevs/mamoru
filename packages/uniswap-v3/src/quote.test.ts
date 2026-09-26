import { describe, expect, test } from 'bun:test'
import { amountsForLiquidity, minOut, quoteMint, rangeAround, sqrtRatioAtTick, token0InToken1, token1InToken0 } from './quote.ts'

describe('sqrtRatioAtTick', () => {
  test('matches TickMath at the reference ticks', () => {
    expect(sqrtRatioAtTick(0)).toBe(1n << 96n)
    expect(sqrtRatioAtTick(-887272)).toBe(4295128739n)
    expect(sqrtRatioAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n)
  })

  test('is monotonic', () => {
    expect(sqrtRatioAtTick(-10)).toBeLessThan(sqrtRatioAtTick(0))
    expect(sqrtRatioAtTick(10)).toBeGreaterThan(sqrtRatioAtTick(0))
  })
})

describe('minOut', () => {
  test('applies the tolerance', () => {
    expect(minOut(10_000n, 50)).toBe(9_950n)
  })

  test('refuses a zero minimum', () => {
    expect(() => minOut(1n, 50)).toThrow('EHG_QUOTE_UNAVAILABLE')
  })
})

describe('quoteMint', () => {
  test('in range, takes both tokens and keeps positive minimums', () => {
    const q = quoteMint({ sqrtPriceX96: sqrtRatioAtTick(0), tickLower: -100, tickUpper: 100, amount0Desired: 10n ** 12n, amount1Desired: 10n ** 12n, slippageBps: 50 })
    expect(q.liquidity).toBeGreaterThan(0n)
    expect(q.amount0).toBeLessThanOrEqual(10n ** 12n)
    expect(q.amount1).toBeLessThanOrEqual(10n ** 12n)
    expect(q.amount0Min).toBeGreaterThan(0n)
    expect(q.amount0Min).toBeLessThan(q.amount0)
  })

  test('out of range on one side leaves a zero minimum and is refused', () => {
    expect(() =>
      quoteMint({ sqrtPriceX96: sqrtRatioAtTick(-200), tickLower: -100, tickUpper: 100, amount0Desired: 10n ** 12n, amount1Desired: 10n ** 12n, slippageBps: 50 }),
    ).toThrow('EHG_QUOTE_UNAVAILABLE')
  })
})

describe('amountsForLiquidity', () => {
  const q = quoteMint({ sqrtPriceX96: sqrtRatioAtTick(0), tickLower: -100, tickUpper: 100, amount0Desired: 10n ** 12n, amount1Desired: 10n ** 12n, slippageBps: 50 })

  test('in range, gives back what the mint took', () => {
    expect(amountsForLiquidity(sqrtRatioAtTick(0), -100, 100, q.liquidity)).toEqual({ amount0: q.amount0, amount1: q.amount1 })
  })

  test('below the range is all token0, above is all token1', () => {
    expect(amountsForLiquidity(sqrtRatioAtTick(-200), -100, 100, q.liquidity).amount1).toBe(0n)
    expect(amountsForLiquidity(sqrtRatioAtTick(200), -100, 100, q.liquidity).amount0).toBe(0n)
  })
})

describe('price conversions', () => {
  test('round trip at tick 0 is the identity', () => {
    const s = sqrtRatioAtTick(0)
    expect(token1InToken0(1_000n, s)).toBe(1_000n)
    expect(token0InToken1(1_000n, s)).toBe(1_000n)
  })
})

describe('rangeAround', () => {
  test('ticks sit on the spacing', () => {
    const r = rangeAround(-67_433, 3000, 60)
    expect(Math.abs(r.tickLower % 60)).toBe(0)
    expect(Math.abs(r.tickUpper % 60)).toBe(0)
    expect(r.tickLower).toBeLessThan(-67_433)
    expect(r.tickUpper).toBeGreaterThan(-67_433)
  })
})
