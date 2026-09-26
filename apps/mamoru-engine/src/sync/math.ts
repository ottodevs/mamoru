// Price and TWAP arithmetic in integers. Amounts stay in token base units (dashboard.md §2 rule 11).

const Q192 = 2n ** 192n

/** Exchange rate as a fraction: quote base units per one base unit of the token. */
export type Rate = { num: bigint; den: bigint }

export const UNIT_RATE: Rate = { num: 1n, den: 1n }

/** Rate of `token` in the other token of the pool, from slot0.sqrtPriceX96. */
export function rateFromSqrtPrice(sqrtPriceX96: bigint, tokenIsToken0: boolean): Rate {
  const sq = sqrtPriceX96 * sqrtPriceX96
  // raw token1 per raw token0 = sq / Q192
  return tokenIsToken0 ? { num: sq, den: Q192 } : { num: Q192, den: sq }
}

/** Value of `amount` base units at `rate`, floored, in quote base units. */
export function valueAt(amount: bigint, rate: Rate): bigint {
  return (amount * rate.num) / rate.den
}

/** Quote base units for one whole token (10^decimals base units). */
export function pricePerWhole(rate: Rate, decimals: number): bigint {
  return valueAt(10n ** BigInt(decimals), rate)
}

/** Arithmetic mean tick over the window, rounded toward negative infinity (Uniswap OracleLibrary.consult). */
export function twapTick(tickCumulativeOld: bigint, tickCumulativeNow: bigint, windowSeconds: number): number {
  const delta = tickCumulativeNow - tickCumulativeOld
  const secs = BigInt(windowSeconds)
  let tick = delta / secs
  if (delta < 0n && delta % secs !== 0n) tick -= 1n
  return Number(tick)
}

/** Swap fee paid on an input amount, floored. `fee` is in hundredths of a basis point. */
export function feeOn(amountIn: bigint, fee: number): bigint {
  return (amountIn * BigInt(fee)) / 1_000_000n
}
