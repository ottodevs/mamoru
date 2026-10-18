import { sqrtRatioAtTick } from './quote.ts'

/**
 * Spec 007 (otto/mamoru#151) T3: MamoruActionPolicy's bound math off chain, so the engine builds calls the policy
 * accepts. Exact ports of `_swapBounds` and `_decreaseMins` in contracts/action-policy/src/MamoruActionPolicy.sol and
 * of the Uniswap libraries they call (OracleLibrary.getQuoteAtTick, LiquidityAmounts.getAmountsForLiquidity, TickMath
 * through `sqrtRatioAtTick`), rounding for rounding. contracts/action-policy/test/BoundsVector.t.sol asserts the same
 * vectors as action-policy.test.ts against the Solidity code.
 *
 * The policy reads the TWAP when the userOp validates, a few blocks after the engine read it. The engine therefore
 * computes its bounds at `engineBand(band)` (0.8 x band, rounded down): higher minimums and a tighter price limit than
 * the policy's own, which the policy still accepts after the TWAP drifts by up to the remaining 0.2 x band.
 */

export const MIN_TICK = -887272
export const MAX_TICK = 887272
const Q128 = 1n << 128n
const Q192 = 1n << 192n
const MAX_UINT128 = (1n << 128n) - 1n

/** Share of the policy's band the engine builds its calls at (spec 007 T3), in bps. One place to change it. */
export const ENGINE_BAND_BPS = 8_000

/** The band the engine builds at: ENGINE_BAND_BPS of the policy's, rounded down (never wider than the policy's). */
export function engineBand(bandTicks: number): number {
  if (!Number.isInteger(bandTicks) || bandTicks < 0) throw new Error(`band ${bandTicks} is not a tick count`)
  return Math.floor((bandTicks * ENGINE_BAND_BPS) / 10_000)
}

/** MamoruActionPolicy._add / _sub: tick plus or minus the band, clamped to TickMath's range. */
export function bandEdge(tick: number, band: number, side: 1 | -1): number {
  const t = tick + side * band
  return t > MAX_TICK ? MAX_TICK : t < MIN_TICK ? MIN_TICK : t
}

/** OracleLibrary.getQuoteAtTick: `baseAmount` of base token in quote token at `tick`; `baseIsToken0` = base < quote. */
export function quoteAtTick(tick: number, baseAmount: bigint, baseIsToken0: boolean): bigint {
  if (baseAmount < 0n || baseAmount > MAX_UINT128) throw new Error('amount') // the policy's _u128
  const sqrt = sqrtRatioAtTick(tick)
  if (sqrt <= MAX_UINT128) {
    const ratioX192 = sqrt * sqrt
    return baseIsToken0 ? (ratioX192 * baseAmount) / Q192 : (Q192 * baseAmount) / ratioX192
  }
  const ratioX128 = (sqrt * sqrt) / (1n << 64n)
  return baseIsToken0 ? (ratioX128 * baseAmount) / Q128 : (Q128 * baseAmount) / ratioX128
}

/**
 * MamoruActionPolicy._swapBounds: the smallest amountOutMinimum and the farthest sqrtPriceLimitX96 accepted for a swap
 * of `amountIn` at `twapTick` and `band`. Selling token0 moves the price down, so its limit is a floor; selling token1,
 * a ceiling. `fee` in hundredths of a bp (pool fee units).
 */
export function swapBounds(p: { twapTick: number; band: number; fee: number; tokenInIsToken0: boolean; amountIn: bigint }): { minOut: bigint; sqrtPriceLimitX96: bigint } {
  const worst = bandEdge(p.twapTick, p.band, p.tokenInIsToken0 ? -1 : 1)
  const quote = quoteAtTick(worst, p.amountIn, p.tokenInIsToken0)
  return { minOut: (quote * BigInt(1_000_000 - p.fee)) / 1_000_000n, sqrtPriceLimitX96: sqrtRatioAtTick(worst) }
}

/** LiquidityAmounts.getAmountsForLiquidity at `sqrtPriceX96` for a range of `tickLower`..`tickUpper`. */
export function amountsForLiquidity(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  let a = sqrtRatioAtTick(tickLower)
  let b = sqrtRatioAtTick(tickUpper)
  if (a > b) [a, b] = [b, a]
  const amount0Of = (x: bigint, y: bigint) => ((liquidity << 96n) * (y - x)) / y / x
  const amount1Of = (x: bigint, y: bigint) => (liquidity * (y - x)) / (1n << 96n)
  if (sqrtPriceX96 <= a) return { amount0: amount0Of(a, b), amount1: 0n }
  if (sqrtPriceX96 < b) return { amount0: amount0Of(sqrtPriceX96, b), amount1: amount1Of(a, sqrtPriceX96) }
  return { amount0: 0n, amount1: amount1Of(a, b) }
}

/**
 * MamoruActionPolicy._decreaseMins: the least amount0Min / amount1Min accepted for decreasing `liquidity` of a range:
 * token0 at the band's top edge (`twap + band`), token1 at its bottom edge (`twap - band`).
 */
export function decreaseMins(p: { twapTick: number; band: number; tickLower: number; tickUpper: number; liquidity: bigint }): { amount0Min: bigint; amount1Min: bigint } {
  const top = amountsForLiquidity(sqrtRatioAtTick(bandEdge(p.twapTick, p.band, 1)), p.tickLower, p.tickUpper, p.liquidity)
  const bottom = amountsForLiquidity(sqrtRatioAtTick(bandEdge(p.twapTick, p.band, -1)), p.tickLower, p.tickUpper, p.liquidity)
  return { amount0Min: top.amount0, amount1Min: bottom.amount1 }
}
