// Spec 007 (otto/mamoru#151), tasks T3 and T6: `contracts/action-policy/src/MamoruActionPolicy.sol`'s own bound
// math (`_oracle`, `_range`, `_swapBounds`, `_decreaseMins`, `_value`, `_bucket`, and the Uniswap v3-periphery
// library calls they make — `OracleLibrary.getQuoteAtTick`, `LiquidityAmounts.getAmountsForLiquidity`), ported to
// TS so the engine and precheck compute the same bounds off chain. The engine builds its calls at a narrower band
// than the deployed config (spec 007 T3: "the engine computes its bounds at a narrower band (e.g. 0.8 x band):
// higher minimums, a tighter limit, still inside what the policy accepts a few blocks later"); precheck mirrors
// the full band. Every function here is a pure, pinned port: no RPC, no registry, no policy types — consumed by
// `packages/scenarios/driver/engine.ts` (`prepareCalls`) and `@mamoru/account/precheck` directly, so this
// package's dependency graph stays one layer below `@mamoru/policy`/`@mamoru/decide` (both of which already import
// FROM `@mamoru/uniswap-v3/quote`, never the other way — same discipline as `packages/policy/src/v4-grants.ts`).
//
// T6 (audit H-1, M-1, M-2, M-3, L-7): the contract no longer prices off one TWAP. It reads two (long, short) and
// their harmonic-mean liquidity (`oracleFromObserve`), refuses when either liquidity is under the Init's floor,
// and bounds every priced action by one range [lo, hi] (`priceRange`). The budget is one value per pool in the
// pool's stable token (`budgetValue`), charged against a token bucket and a per-approval total (`bucketNow`).
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
const MAX_UINT160 = (1n << 160n) - 1n

function clampTick(t: number): number {
  return t > MAX_TICK ? MAX_TICK : t < MIN_TICK ? MIN_TICK : t
}

/** `twap + band`, clamped to TickMath.MAX_TICK. */
export function addBand(tick: number, bandTicks: number): number {
  return clampTick(tick + bandTicks)
}

/** `twap - band`, clamped to TickMath.MIN_TICK. */
export function subBand(tick: number, bandTicks: number): number {
  return clampTick(tick - bandTicks)
}

/** Mirrors MamoruActionPolicy._u128: the contract's `OracleLibrary.getQuoteAtTick` takes a `uint128` base amount. */
function u128(amount: bigint): bigint {
  if (amount > MAX_UINT128) throw new Error(`amount ${amount} exceeds uint128`)
  return amount
}

// ---------------------------------------------------------------- the oracle read (T6 H-1, M-1)

/**
 * What MamoruActionPolicy._oracle reads from one `observe([twapWindow, twapShortWindow, 0])`: the long and short
 * TWAP ticks and each window's harmonic-mean in-range liquidity. Build it with `oracleFromObserve`.
 */
export type OracleRead = { twapLong: number; twapShort: number; hmLong: bigint; hmShort: bigint }

/** Mirrors MamoruActionPolicy._meanTick (= OracleLibrary.consult's tick): floor, also for a negative delta. */
export function meanTick(tickCumulativeDelta: bigint, windowSeconds: number): number {
  const w = BigInt(windowSeconds)
  let t = tickCumulativeDelta / w
  if (tickCumulativeDelta < 0n && tickCumulativeDelta % w !== 0n) t -= 1n
  return Number(t)
}

/** Mirrors MamoruActionPolicy._harmonicMean (= OracleLibrary.consult's harmonicMeanLiquidity, uint128-truncated). */
export function harmonicMeanLiquidity(secondsPerLiquidityDelta: bigint, windowSeconds: number): bigint {
  if (secondsPerLiquidityDelta === 0n) return MAX_UINT128
  const x = (BigInt(windowSeconds) * MAX_UINT160) / (secondsPerLiquidityDelta << 32n)
  return x & MAX_UINT128
}

/** `observe([long, short, 0])`'s two arrays -> OracleRead, exactly as the contract folds them. */
export function oracleFromObserve(tickCumulatives: readonly bigint[], secondsPerLiquidityX128: readonly bigint[], longSeconds: number, shortSeconds: number): OracleRead {
  const [t0, t1, t2] = tickCumulatives as [bigint, bigint, bigint]
  const [s0, s1, s2] = secondsPerLiquidityX128 as [bigint, bigint, bigint]
  // uint160 arithmetic in the contract: the cumulative wraps, the checked 0.8 subtraction never sees it in practice.
  return {
    twapLong: meanTick(t2 - t0, longSeconds),
    twapShort: meanTick(t2 - t1, shortSeconds),
    hmLong: harmonicMeanLiquidity((s2 - s0) & MAX_UINT160, longSeconds),
    hmShort: harmonicMeanLiquidity((s2 - s1) & MAX_UINT160, shortSeconds),
  }
}

/** The price range every priced action must stay inside, in ticks: [lo, hi]. */
export type PriceRange = { lo: number; hi: number }

/**
 * Mirrors MamoruActionPolicy._range: lo = max(long, short) - band + 1, hi = min(long, short) + band (both clamped
 * to the tick space). `null` (the contract refuses) when either window's harmonic-mean liquidity is under
 * `minLiquidity`, or the range is empty (the two TWAPs disagree by more than about 2 x band).
 */
export function priceRange(o: OracleRead, bandTicks: number, minLiquidity: bigint): PriceRange | null {
  if (o.hmLong < minLiquidity || o.hmShort < minLiquidity) return null
  const top = Math.max(o.twapLong, o.twapShort)
  const bottom = Math.min(o.twapLong, o.twapShort)
  const lo = clampTick(top - bandTicks + 1)
  const hi = clampTick(bottom + bandTicks)
  return lo <= hi ? { lo, hi } : null
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
 * Mirrors `MamoruActionPolicy._swapBounds`: the worst acceptable price is the range edge against the swapper (`lo`
 * selling token0, `hi` buying it), and the minimum out after the pool fee at that price. `feePips` is the pool fee
 * out of 1e6 (e.g. 3000 = 0.3%), the same units `@mamoru/decide`'s `twapFloor` and the engine's `Proposal.fee` use.
 */
export function swapBoundsInRange(args: {
  range: PriceRange
  feePips: number
  zeroForOne: boolean
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
}): { minOut: bigint; sqrtPriceLimitX96: bigint } {
  const worst = args.zeroForOne ? args.range.lo : args.range.hi
  const quote = quoteAtTick(worst, args.amountIn, args.tokenIn, args.tokenOut)
  const minOut = (quote * BigInt(1_000_000 - args.feePips)) / 1_000_000n
  return { minOut, sqrtPriceLimitX96: sqrtRatioAtTick(worst) }
}

/**
 * Mirrors `MamoruActionPolicy._decreaseMins`: token0 is smallest at the range's top edge (`hi`), token1 at the
 * bottom edge (`lo`). A spot anywhere inside the range returns at least these from a decrease of `liquidity`.
 */
export function decreaseMinsInRange(args: { range: PriceRange; tickLower: number; tickUpper: number; liquidity: bigint }): { amount0Min: bigint; amount1Min: bigint } {
  const top = amountsForLiquidityAtPrice(sqrtRatioAtTick(args.range.hi), args.tickLower, args.tickUpper, args.liquidity)
  const bottom = amountsForLiquidityAtPrice(sqrtRatioAtTick(args.range.lo), args.tickLower, args.tickUpper, args.liquidity)
  return { amount0Min: top.amount0, amount1Min: bottom.amount1 }
}

// ---------------------------------------------------------------- the budget (T6 M-2, M-3, L-5)

/**
 * Mirrors `MamoruActionPolicy._value`: (amount0, amount1) in the budget unit (token1 when `in1`, else token0), the
 * other token converted at the range edge that values it highest (token0 -> token1 at `hi`, token1 -> token0 at
 * `lo`).
 */
export function budgetValue(args: { range: PriceRange; in1: boolean; token0: Address; token1: Address; amount0: bigint; amount1: bigint }): bigint {
  if (args.in1) return args.amount1 + (args.amount0 === 0n ? 0n : quoteAtTick(args.range.hi, args.amount0, args.token0, args.token1))
  return args.amount0 + (args.amount1 === 0n ? 0n : quoteAtTick(args.range.lo, args.amount1, args.token1, args.token0))
}

/** `MamoruActionPolicy.Spend`, as `spendOf` returns it. */
export type PolicySpend = { generation: bigint; updatedAt: bigint; in1: boolean; debt: bigint; total: bigint }

/** The budget half of `MamoruActionPolicy.Config` (what `Init` signed). */
export type PolicyBudget = { generation: bigint; windowSeconds: number; perWindow: bigint; total: bigint }

/**
 * Mirrors `MamoruActionPolicy._bucket`: the bucket debt after refilling `perWindow / windowSeconds` per second
 * since the last charge (floored, as the contract does), and the spend of the CURRENT generation (a renewal resets
 * the total, never the bucket).
 */
export function bucketNow(spend: PolicySpend, budget: PolicyBudget, now: bigint): { debt: bigint; spent: bigint } {
  let debt = spend.debt
  if (debt !== 0n && now > spend.updatedAt) {
    const refill = (budget.perWindow * (now - spend.updatedAt)) / BigInt(budget.windowSeconds)
    debt = refill >= debt ? 0n : debt - refill
  }
  return { debt, spent: spend.generation === budget.generation ? spend.total : 0n }
}

/** Mirrors `MamoruActionPolicy._charge`'s test: would charging `value` now stay within the bucket and the total? */
export function budgetAllows(spend: PolicySpend, budget: PolicyBudget, now: bigint, value: bigint): { ok: boolean; debt: bigint; spent: bigint } {
  const b = bucketNow(spend, budget, now)
  const debt = b.debt + value
  const spent = b.spent + value
  return { ok: debt <= budget.perWindow && spent <= budget.total, debt, spent }
}
