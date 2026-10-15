import { describe, expect, test } from 'bun:test'
import { feeGrowthInside, uncollectedFees } from './fees.ts'
import fixture from './fees.fixture.json'

const Q128 = 1n << 128n
const MOD = 1n << 256n
const t = (o0: bigint, o1: bigint) => ({ feeGrowthOutside0X128: o0, feeGrowthOutside1X128: o1 })

describe('feeGrowthInside', () => {
  test('price inside the range: global minus both outsides', () => {
    expect(feeGrowthInside(0, -10, 10, 1000n, 2000n, t(100n, 200n), t(300n, 400n))).toEqual({ inside0: 600n, inside1: 1400n })
  })

  test('price below the range: the lower tick is crossed the other way', () => {
    // below = global - lowerOutside; above = upperOutside. inside = global - (global - lower) - upper = lower - upper.
    expect(feeGrowthInside(-20, -10, 10, 1000n, 2000n, t(500n, 900n), t(300n, 400n))).toEqual({ inside0: 200n, inside1: 500n })
  })

  test('price above the range: the upper tick is crossed the other way', () => {
    // below = lowerOutside; above = global - upperOutside. inside = upper - lower.
    expect(feeGrowthInside(20, -10, 10, 1000n, 2000n, t(100n, 200n), t(700n, 900n))).toEqual({ inside0: 600n, inside1: 700n })
  })

  test('wraps modulo 2^256 like the pool', () => {
    const r = feeGrowthInside(0, -10, 10, 5n, 5n, t(10n, 0n), t(0n, 10n))
    expect(r.inside0).toBe(MOD - 5n)
    expect(r.inside1).toBe(MOD - 5n)
  })
})

describe('uncollectedFees', () => {
  test('owed plus growth since the checkpoint times liquidity, floored', () => {
    const r = uncollectedFees({ liquidity: 3n, feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n, tokensOwed0: 7n, tokensOwed1: 0n }, { inside0: Q128, inside1: Q128 / 2n })
    expect(r).toEqual({ fees0: 10n, fees1: 1n })
  })

  test('a checkpoint above the current growth (wrapped) still gives the right difference', () => {
    const r = uncollectedFees({ liquidity: 1n, feeGrowthInside0LastX128: MOD - Q128, feeGrowthInside1LastX128: 0n, tokensOwed0: 0n, tokensOwed1: 0n }, { inside0: Q128, inside1: 0n })
    expect(r.fees0).toBe(2n)
  })
})

describe('live Base positions match a simulated collect at the same block', () => {
  for (const c of fixture.cases) {
    test(`#${c.tokenId} ${c.pool} at block ${fixture.block}`, () => {
      const inside = feeGrowthInside(c.tick, c.tickLower, c.tickUpper, BigInt(c.g0), BigInt(c.g1), t(BigInt(c.lo0), BigInt(c.lo1)), t(BigInt(c.up0), BigInt(c.up1)))
      const fees = uncollectedFees({ liquidity: BigInt(c.liquidity), feeGrowthInside0LastX128: BigInt(c.in0), feeGrowthInside1LastX128: BigInt(c.in1), tokensOwed0: BigInt(c.owed0), tokensOwed1: BigInt(c.owed1) }, inside)
      expect(fees).toEqual({ fees0: BigInt(c.collect0), fees1: BigInt(c.collect1) })
    })
  }
})
