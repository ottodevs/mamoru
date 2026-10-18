// Spec 007 (otto/mamoru#151), task T3: `contracts/action-policy/src/MamoruActionPolicy.sol`'s own bound math
// (`_swapBounds`, `_decreaseMins`, and the Uniswap v3-periphery library calls they make — `OracleLibrary.
// getQuoteAtTick`, `LiquidityAmounts.getAmountsForLiquidity`), ported to TS so the engine can compute the same
// bounds off chain, at a narrower band than the deployed config (spec 007 T3: "the engine computes its bounds at
// a narrower band (e.g. 0.8 x band): higher minimums, a tighter limit, still inside what the policy accepts a few
// blocks later"). Every function here is a pure, pinned port: no RPC, no registry, no policy types — consumed by
// `packages/scenarios/driver/engine.ts` (`prepareCalls`) directly, so this package's dependency graph stays one
// layer below `@mamoru/policy`/`@mamoru/decide` (both of which already import FROM `@mamoru/uniswap-v3/quote`,
// never the other way — same discipline as `packages/policy/src/v4-grants.ts`'s file header).
//
// `amountsForLiquidityAtPrice` below duplicates a formula that already exists twice in `@mamoru/decide`
// (`value.ts`, `rerange/index.ts`): duplicated once more here, not imported, for that same one-way-dependency
// reason — `@mamoru/decide` imports from `@mamoru/uniswap-v3`, not the other way.
import type { Address } from '@mamoru/domain'
import { sqrtRatioAtTick } from './quote.ts'

/** Uniswap v3-core TickMath.MIN_TICK / MAX_TICK. */
export const MIN_TICK = -887272
export const MAX_TICK = 887272

const Q96 = 1n << 96n
const Q128 = 1n << 128n
const Q192 = 1n << 192n
const MAX_UINT128 = (1n << 128n) - 1n

function clampTick(t: number): number {
  return t > MAX_TICK ? MAX_TICK : t < MIN_TICK ? MIN_TICK : t
}

/** Mirrors MamoruActionPolicy._add: `twap + band`, clamped to TickMath.MAX_TICK. */
export function addBand(tick: number, bandTicks: number): number {
  return clampTick(tick + bandTicks)
}

/** Mirrors MamoruActionPolicy._sub: `twap - band`, clamped to TickMath.MIN_TICK. */
export function subBand(tick: number, bandTicks: number): number {
  return clampTick(tick - bandTicks)
}

/** Mirrors MamoruActionPolicy._u128: the contract's `OracleLibrary.getQuoteAtTick` takes a `uint128` base amount. */
function u128(amount: bigint): bigint {
  if (amount > MAX_UINT128) throw new Error(`amount ${amount} exceeds uint128`)
  return amount
}

/**
 * Mirrors Uniswap v3-periphery `OracleLibrary.getQuoteAtTick`, branch for branch. BigInt has no 256-bit overflow,
 * but the contract picks one of two algebraically-different roundings depending on `sqrtRatioX96`'s magnitude (to
 * stay inside `FullMath.mulDiv`'s 512-bit intermediate); matching that branch, not just the limit as precision
 * goes to infinity, is what makes this bit-identical to the contract at every tick, including the extreme ones
 * near `MAX_TICK` this port is unlikely to ever see in practice.
 */
export function quoteAtTick(tick: number, baseAmount: bigint, baseToken: Address, quoteToken: Address): bigint {
  const sqrtRatioX96 = sqrtRatioAtTick(tick)
  const amount = u128(baseAmount)
  const base = BigInt(baseToken)
  const quote = BigInt(quoteToken)
  if (sqrtRatioX96 <= MAX_UINT128) {
    const ratioX192 = sqrtRatioX96 * sqrtRatioX96
    return base < quote ? (ratioX192 * amount) / Q192 : (Q192 * amount) / ratioX192
  }
  const ratioX128 = (sqrtRatioX96 * sqrtRatioX96) / (1n << 64n)
  return base < quote ? (ratioX128 * amount) / Q128 : (Q128 * amount) / ratioX128
}

/**
 * Mirrors Uniswap v3-periphery `LiquidityAmounts.getAmountsForLiquidity`: the (amount0, amount1) a position of
 * `tickLower`-`tickUpper` and `liquidity` holds if the pool were at `sqrtPriceX96` (clamped to the range's own
 * edges, exactly as the library does with its three-branch `if`).
 */
export function amountsForLiquidityAtPrice(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const a = sqrtRatioAtTick(tickLower)
  const b = sqrtRatioAtTick(tickUpper)
  const s = sqrtPriceX96 < a ? a : sqrtPriceX96 > b ? b : sqrtPriceX96
  const amount0 = s < b ? ((liquidity << 96n) * (b - s)) / b / s : 0n
  const amount1 = s > a ? (liquidity * (s - a)) / Q96 : 0n
  return { amount0, amount1 }
}

/** Spec 007 T3: "the engine computes its bounds at a narrower band (e.g. 0.8 x band)". */
export const DEFAULT_BAND_FACTOR_BPS = 8_000

/** The deployed `bandTicks` scaled by `bandFactorBps`, floored toward 0 — never wider than the real band (the
 * conservative direction: a narrower band means a higher minimum and a tighter price limit). */
export function narrowBand(bandTicks: number, bandFactorBps: number = DEFAULT_BAND_FACTOR_BPS): number {
  return Math.floor((bandTicks * bandFactorBps) / 10_000)
}

/**
 * Mirrors `MamoruActionPolicy._swapBounds`: the worst acceptable price `bandTicks` against the swapper from the
 * TWAP tick, and the minimum out after the pool fee at that price. `feePips` is the pool fee out of 1e6 (e.g. 3000
 * = 0.3%), the same units `@mamoru/decide`'s `twapFloor` and the engine's `Proposal.fee` already use.
 */
export function swapBoundsAtBand(args: {
  twap: number
  bandTicks: number
  feePips: number
  zeroForOne: boolean
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
}): { minOut: bigint; sqrtPriceLimitX96: bigint } {
  const worst = args.zeroForOne ? subBand(args.twap, args.bandTicks) : addBand(args.twap, args.bandTicks)
  const quote = quoteAtTick(worst, args.amountIn, args.tokenIn, args.tokenOut)
  const minOut = (quote * BigInt(1_000_000 - args.feePips)) / 1_000_000n
  return { minOut, sqrtPriceLimitX96: sqrtRatioAtTick(worst) }
}

/**
 * Mirrors `MamoruActionPolicy._decreaseMins`: token0 is smallest at the band's top edge (`twap + band`), token1 at
 * the bottom edge (`twap - band`). A spot anywhere inside the band returns at least these from a decrease of
 * `liquidity`.
 */
export function decreaseMinsAtBand(args: { twap: number; bandTicks: number; tickLower: number; tickUpper: number; liquidity: bigint }): { amount0Min: bigint; amount1Min: bigint } {
  const top = amountsForLiquidityAtPrice(sqrtRatioAtTick(addBand(args.twap, args.bandTicks)), args.tickLower, args.tickUpper, args.liquidity)
  const bottom = amountsForLiquidityAtPrice(sqrtRatioAtTick(subBand(args.twap, args.bandTicks)), args.tickLower, args.tickUpper, args.liquidity)
  return { amount0Min: top.amount0, amount1Min: bottom.amount1 }
}
