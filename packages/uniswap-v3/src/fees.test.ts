import { describe, expect, test } from 'bun:test'
import { feeGrowthInside, positionFees } from './fees.ts'
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

describe('positionFees', () => {
  const pos = (o: Partial<{ liquidity: bigint; in0: bigint; in1: bigint; owed0: bigint; owed1: bigint }>) => ({
    liquidity: o.liquidity ?? 1n,
    feeGrowthInside0LastX128: o.in0 ?? 0n,
    feeGrowthInside1LastX128: o.in1 ?? 0n,
    tokensOwed0: o.owed0 ?? 0n,
    tokensOwed1: o.owed1 ?? 0n,
  })

  test('accrued is growth since the checkpoint times liquidity, floored; collectable adds what is owed', () => {
    const r = positionFees(pos({ liquidity: 3n, owed0: 7n }), { inside0: Q128, inside1: Q128 / 2n })
    expect(r).toEqual({ accrued0: 3n, accrued1: 1n, collectable0: 10n, collectable1: 1n })
  })

  test('owed principal is collectable but never counted as accrued fees', () => {
    const r = positionFees(pos({ liquidity: 0n, owed0: 5_000_000n, owed1: 0n }), { inside0: 0n, inside1: 0n })
    expect(r.accrued0).toBe(0n)
    expect(r.collectable0).toBe(5_000_000n)
  })

  test('a checkpoint above the current growth (wrapped) still gives the right difference', () => {
    const r = positionFees(pos({ in0: MOD - Q128 }), { inside0: Q128, inside1: 0n })
    expect(r.accrued0).toBe(2n)
  })

  test('the uint128 cast of the accrued amount wraps like the contract, it does not clamp', () => {
    // liquidity * diff / 2^128 = 2^128 + 5 -> uint128 keeps 5.
    const r = positionFees(pos({ liquidity: Q128 + 5n }), { inside0: Q128, inside1: 0n })
    expect(r.accrued0).toBe(5n)
  })

  test('tokensOwed + accrued wraps at 2^128 like the unchecked addition', () => {
    const r = positionFees(pos({ liquidity: 3n, owed0: Q128 - 1n }), { inside0: Q128, inside1: 0n })
    expect(r.collectable0).toBe(2n)
  })
})

describe('live Base positions match a simulated collect at the same block', () => {
  for (const c of fixture.cases) {
    test(`#${c.tokenId} ${c.pool} at block ${fixture.block}`, () => {
      const inside = feeGrowthInside(c.tick, c.tickLower, c.tickUpper, BigInt(c.g0), BigInt(c.g1), t(BigInt(c.lo0), BigInt(c.lo1)), t(BigInt(c.up0), BigInt(c.up1)))
      const fees = positionFees({ liquidity: BigInt(c.liquidity), feeGrowthInside0LastX128: BigInt(c.in0), feeGrowthInside1LastX128: BigInt(c.in1), tokensOwed0: BigInt(c.owed0), tokensOwed1: BigInt(c.owed1) }, inside)
      expect({ c0: fees.collectable0, c1: fees.collectable1 }).toEqual({ c0: BigInt(c.collect0), c1: BigInt(c.collect1) })
      // Nothing owed on these positions: everything collectable is accrued fees.
      expect({ a0: fees.accrued0, a1: fees.accrued1 }).toEqual({ a0: BigInt(c.collect0), a1: BigInt(c.collect1) })
    })
  }
})
