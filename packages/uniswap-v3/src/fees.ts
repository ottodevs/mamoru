// Uncollected fees of a Uniswap v3 position, computed from state reads instead of a simulated collect
// (otto/mamoru#136). Same arithmetic as the pool and the NonfungiblePositionManager: fee growth is a
// uint256 that wraps, so every subtraction is taken modulo 2^256, and owed amounts are floored.

const Q128 = 1n << 128n
const MOD = 1n << 256n

const sub256 = (a: bigint, b: bigint): bigint => (((a - b) % MOD) + MOD) % MOD

export type TickFees = { feeGrowthOutside0X128: bigint; feeGrowthOutside1X128: bigint }

/** Pool.getFeeGrowthInside: growth per unit of liquidity between two ticks, at the pool's current tick. */
export function feeGrowthInside(
  tickCurrent: number,
  tickLower: number,
  tickUpper: number,
  feeGrowthGlobal0X128: bigint,
  feeGrowthGlobal1X128: bigint,
  lower: TickFees,
  upper: TickFees,
): { inside0: bigint; inside1: bigint } {
  const below0 = tickCurrent >= tickLower ? lower.feeGrowthOutside0X128 : sub256(feeGrowthGlobal0X128, lower.feeGrowthOutside0X128)
  const below1 = tickCurrent >= tickLower ? lower.feeGrowthOutside1X128 : sub256(feeGrowthGlobal1X128, lower.feeGrowthOutside1X128)
  const above0 = tickCurrent < tickUpper ? upper.feeGrowthOutside0X128 : sub256(feeGrowthGlobal0X128, upper.feeGrowthOutside0X128)
  const above1 = tickCurrent < tickUpper ? upper.feeGrowthOutside1X128 : sub256(feeGrowthGlobal1X128, upper.feeGrowthOutside1X128)
  return {
    inside0: sub256(sub256(feeGrowthGlobal0X128, below0), above0),
    inside1: sub256(sub256(feeGrowthGlobal1X128, below1), above1),
  }
}

export type PositionFeeState = {
  liquidity: bigint
  feeGrowthInside0LastX128: bigint
  feeGrowthInside1LastX128: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}

const MAX128 = Q128 - 1n

/**
 * Fees the position has earned since its last checkpoint, and what `collect` would pay right now, with the
 * NonfungiblePositionManager's arithmetic: `uint128(mulDiv(inside - insideLast, liquidity, 2^128))`, then
 * `tokensOwed += that`, both wrapping like the 0.7 contract does (no checked math).
 *
 * `accrued` is fee income only. `collectable` adds `tokensOwed`, which also holds principal left by a
 * decreaseLiquidity that was not collected in the same transaction: it is the user's money, but not all of it is
 * yield. The pool rounds each position's owed amount on its own, so `collect` can pay a few units less than
 * `collectable`: treat it as an estimate.
 */
export function positionFees(position: PositionFeeState, inside: { inside0: bigint; inside1: bigint }): { accrued0: bigint; accrued1: bigint; collectable0: bigint; collectable1: bigint } {
  const accrued0 = ((position.liquidity * sub256(inside.inside0, position.feeGrowthInside0LastX128)) / Q128) & MAX128
  const accrued1 = ((position.liquidity * sub256(inside.inside1, position.feeGrowthInside1LastX128)) / Q128) & MAX128
  return {
    accrued0,
    accrued1,
    collectable0: (position.tokensOwed0 + accrued0) & MAX128,
    collectable1: (position.tokensOwed1 + accrued1) & MAX128,
  }
}
