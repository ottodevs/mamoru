import { describe, expect, test } from 'bun:test'
import { sqrtRatioAtTick } from './quote.ts'
import { amountsForLiquidity, bandEdge, decreaseMins, engineBand, ENGINE_BAND_BPS, MAX_TICK, MIN_TICK, swapBounds } from './action-policy.ts'

// Spec 007 T3. The same vectors are asserted against MamoruActionPolicy's own code in
// contracts/action-policy/test/BoundsVector.t.sol: a change to either side breaks one of the two.
const SWAP_VECTORS = [
  // USDC/cbBTC 0.05%: sell USDC at the policy band, sell cbBTC at the engine band.
  { in: { twapTick: -69080, band: 100, fee: 500, tokenInIsToken0: true, amountIn: 10_000_000_000n }, minOut: 9896548n, limit: 2493044766816419681857569732n },
  { in: { twapTick: -69080, band: 80, fee: 500, tokenInIsToken0: false, amountIn: 10_000_000n }, minOut: 9914364963n, limit: 2515582309681695196964350041n },
  // WETH/USDC 0.3%
  { in: { twapTick: -193380, band: 100, fee: 3000, tokenInIsToken0: true, amountIn: 10n ** 18n }, minOut: 3948077151n, limit: 4985684817738764271800177n },
  { in: { twapTick: -193380, band: 80, fee: 3000, tokenInIsToken0: false, amountIn: 3_000_000_000n }, minOut: 741837922569059691n, limit: 5030756244769747454520634n },
  // USDC/USDT 0.01%
  { in: { twapTick: 1, band: 10, fee: 100, tokenInIsToken0: true, amountIn: 50_000_000_000n }, minOut: 49950026988n, limit: 79192519643494122913931054475n },
  { in: { twapTick: 1, band: 8, fee: 100, tokenInIsToken0: false, amountIn: 50_000_000_000n }, minOut: 49950026988n, limit: 79263821427133508858028082997n },
  // Extreme ticks: getQuoteAtTick's sqrtRatio > uint128 branch, and the clamp at MIN_TICK.
  { in: { twapTick: 887000, band: 100, fee: 3000, tokenInIsToken0: true, amountIn: 1_000_000n }, minOut: 326848885033688930083888074281879948672662010n, limit: 1434516369756535367959378355651734405467902527303n },
  { in: { twapTick: -887000, band: 1000, fee: 3000, tokenInIsToken0: false, amountIn: 1_000_000n }, minOut: 298718732998015469598875560024265055078636277n, limit: 4577158310n },
] as const

const DECREASE_VECTORS = [
  { in: { twapTick: -69080, band: 100, tickLower: -69600, tickUpper: -68600, liquidity: 10n ** 15n }, amount0Min: 592133465427250n, amount1Min: 653877192857n },
  { in: { twapTick: -69080, band: 80, tickLower: -69600, tickUpper: -68600, liquidity: 10n ** 15n }, amount0Min: 623611109448142n, amount1Min: 685358005450n },
  // A range below the band: token1 only, all of it.
  { in: { twapTick: -69080, band: 100, tickLower: -70000, tickUpper: -69500, liquidity: 10n ** 15n }, amount0Min: 0n, amount1Min: 764545476004n },
  { in: { twapTick: 1, band: 10, tickLower: -19, tickUpper: 22, liquidity: 10n ** 12n }, amount0Min: 549518991n, amount1Min: 499625164n },
  // A range inside the band: both minimums zero (spec 007, "Decrease has no spot check of its own").
  { in: { twapTick: -193380, band: 100, tickLower: -193440, tickUpper: -193320, liquidity: 10n ** 18n }, amount0Min: 0n, amount1Min: 0n },
] as const

describe('MamoruActionPolicy bounds off chain (spec 007 T3)', () => {
  test('swap bounds match the Solidity vectors', () => {
    for (const v of SWAP_VECTORS) expect(swapBounds(v.in)).toEqual({ minOut: v.minOut, sqrtPriceLimitX96: v.limit })
  })

  test('decrease minimums match the Solidity vectors', () => {
    for (const v of DECREASE_VECTORS) expect(decreaseMins(v.in)).toEqual({ amount0Min: v.amount0Min, amount1Min: v.amount1Min })
  })

  test('the engine band is 0.8 of the policy band, rounded down', () => {
    expect(ENGINE_BAND_BPS).toBe(8_000)
    expect([10, 100, 1, 0, 13].map(engineBand)).toEqual([8, 80, 0, 0, 10])
    expect(() => engineBand(-1)).toThrow()
    expect(() => engineBand(1.5)).toThrow()
  })

  test('at the engine band the minimums are higher and the limit tighter, so the policy still accepts them', () => {
    for (const [twapTick, fee] of [[-69080, 500], [-193380, 3000], [1, 100]] as const) {
      for (const tokenInIsToken0 of [true, false]) {
        for (const band of [10, 100]) {
          const policy = swapBounds({ twapTick, band, fee, tokenInIsToken0, amountIn: 10n ** 12n })
          const engine = swapBounds({ twapTick, band: engineBand(band), fee, tokenInIsToken0, amountIn: 10n ** 12n })
          expect(engine.minOut).toBeGreaterThanOrEqual(policy.minOut)
          // zeroForOne: the limit is a floor (the policy wants limit >= its own); otherwise a ceiling.
          if (tokenInIsToken0) expect(engine.sqrtPriceLimitX96).toBeGreaterThan(policy.sqrtPriceLimitX96)
          else expect(engine.sqrtPriceLimitX96).toBeLessThan(policy.sqrtPriceLimitX96)
          // A TWAP that moved by the 0.2 band the engine left between its read and the validation: still accepted.
          const drift = band - engineBand(band)
          const later = swapBounds({ twapTick: twapTick + (tokenInIsToken0 ? drift : -drift), band, fee, tokenInIsToken0, amountIn: 10n ** 12n })
          expect(engine.minOut).toBeGreaterThanOrEqual(later.minOut)
        }
      }
    }
    for (const v of DECREASE_VECTORS) {
      const narrow = decreaseMins({ ...v.in, band: engineBand(v.in.band) })
      expect(narrow.amount0Min).toBeGreaterThanOrEqual(v.amount0Min)
      expect(narrow.amount1Min).toBeGreaterThanOrEqual(v.amount1Min)
    }
  })

  test('band edges clamp to TickMath, amounts follow LiquidityAmounts at and past the range edges', () => {
    expect(bandEdge(MAX_TICK - 5, 100, 1)).toBe(MAX_TICK)
    expect(bandEdge(MIN_TICK + 5, 100, -1)).toBe(MIN_TICK)
    expect(bandEdge(0, 100, -1)).toBe(-100)
    const L = 10n ** 15n
    const [lo, hi] = [-600, 600]
    expect(amountsForLiquidity(sqrtRatioAtTick(lo), lo, hi, L).amount1).toBe(0n)
    expect(amountsForLiquidity(sqrtRatioAtTick(hi), lo, hi, L).amount0).toBe(0n)
    expect(amountsForLiquidity(sqrtRatioAtTick(-5000), lo, hi, L)).toEqual(amountsForLiquidity(sqrtRatioAtTick(lo), lo, hi, L))
    // Ticks given in either order, as the library sorts them.
    expect(amountsForLiquidity(sqrtRatioAtTick(0), hi, lo, L)).toEqual(amountsForLiquidity(sqrtRatioAtTick(0), lo, hi, L))
  })
})
