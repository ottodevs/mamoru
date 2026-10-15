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

/**
 * What `collect` would pay out of fees right now: tokens already owed plus growth since the position's last
 * checkpoint times its liquidity. Matches a simulated collect of a position with no principal owed
 * (principal from a decrease sits in tokensOwed too and is included, as collect would).
 */
export function uncollectedFees(position: PositionFeeState, inside: { inside0: bigint; inside1: bigint }): { fees0: bigint; fees1: bigint } {
  const fees0 = position.tokensOwed0 + (position.liquidity * sub256(inside.inside0, position.feeGrowthInside0LastX128)) / Q128
  const fees1 = position.tokensOwed1 + (position.liquidity * sub256(inside.inside1, position.feeGrowthInside1LastX128)) / Q128
  // collect pays at most uint128 per token.
  const MAX128 = Q128 - 1n
  return { fees0: fees0 > MAX128 ? MAX128 : fees0, fees1: fees1 > MAX128 ? MAX128 : fees1 }
}
