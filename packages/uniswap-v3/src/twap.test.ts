import { describe, expect, test } from 'bun:test'
import { sqrtRatioAtTick } from './quote.ts'
import { diverges, swapMinimum, twapFloor, twapTickOf } from './twap.ts'

describe('twapTickOf', () => {
  test('rounds a negative mean toward negative infinity, as OracleLibrary does', () => {
    expect(twapTickOf([0n, 3600n], 1800)).toBe(2)
    expect(twapTickOf([0n, -3601n], 1800)).toBe(-3)
    expect(twapTickOf([0n, -3600n], 1800)).toBe(-2)
    expect(twapTickOf(null, 1800)).toBeNull()
  })
})

describe('diverges', () => {
  test('more than the policy ticks apart, either way', () => {
    expect(diverges(100, 0, 100)).toBe(false)
    expect(diverges(-101, 0, 100)).toBe(true)
    expect(diverges(101, 0, 100)).toBe(true)
  })
})

describe('twapFloor and swapMinimum (otto/mamoru#140)', () => {
  // At tick 0 one raw unit of token0 is one raw unit of token1.
  const base = { amountIn: 1_000_000n, fee: 500, twapTick: 0, deviationTicks: 100, slippageBps: 50 }

  test('the floor is the TWAP value after fee, moved by the deviation against the swap, less slippage', () => {
    const f0 = twapFloor({ ...base, tokenInIsToken0: true })
    const f1 = twapFloor({ ...base, tokenInIsToken0: false })
    // 999_500 after the 0.05% fee, about 1% for 100 ticks, 0.5% slippage: ~984_570 either way.
    for (const f of [f0, f1]) {
      expect(f).toBeGreaterThan(984_000n)
      expect(f).toBeLessThan(985_000n)
    }
  })

  test('a quote at the TWAP keeps the usual minimum; the floor never lowers it', () => {
    const floor = twapFloor({ ...base, tokenInIsToken0: true })
    expect(swapMinimum(999_500n, 50, floor)).toBe(994_502n)
  })

  test('a quote a little under the TWAP, within the deviation, is held at the floor', () => {
    const floor = twapFloor({ ...base, tokenInIsToken0: true })
    expect(swapMinimum(989_000n, 50, floor)).toBe(floor)
  })

  test('a quote from a moved pool (or a 1-wei expectation) is refused', () => {
    const floor = twapFloor({ ...base, tokenInIsToken0: true })
    expect(swapMinimum(900_000n, 50, floor)).toBeNull()
    expect(swapMinimum(1n, 50, floor)).toBeNull()
  })

  test('away from tick 0 the deviation moves the price against each side, across decimals', () => {
    // USDC (6 dp) / cbBTC (8 dp) near tick -67090: 1 USDC buys about 1218 sats.
    const t = -67_090
    const at = (tick: number) => Number(sqrtRatioAtTick(tick)) ** 2 / 2 ** 192
    const usdcIn = twapFloor({ amountIn: 100_000_000n, fee: 500, twapTick: t, tokenInIsToken0: true, deviationTicks: 100, slippageBps: 50 })
    const btcIn = twapFloor({ amountIn: 121_800n, fee: 500, twapTick: t, tokenInIsToken0: false, deviationTicks: 100, slippageBps: 50 })
    // Selling USDC is judged at the lower tick (fewer sats), selling sats at the higher one (fewer USDC).
    expect(Number(usdcIn)).toBeCloseTo(99_950_000 * at(t - 100) * 0.995, -3)
    expect(Number(btcIn)).toBeCloseTo((121_739.1 / at(t + 100)) * 0.995, -3)
    expect(Number(usdcIn)).toBeLessThan(99_950_000 * at(t) * 0.995)
    expect(Number(btcIn)).toBeLessThan((121_739.1 / at(t)) * 0.995)
  })
})

