import { parseAbi, type PublicClient } from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import { minOut, sqrtRatioAtTick, token0InToken1, token1InToken0 } from './quote.ts'

export const poolObserveAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])

/** FR-UNI-009: the mean tick over `windowSeconds` from `observe([window, 0])`, rounded toward negative infinity as OracleLibrary does. */
export function twapTickOf(cumulatives: readonly bigint[] | null | undefined, windowSeconds: number): number | null {
  if (!cumulatives || cumulatives[0] === undefined || cumulatives[1] === undefined) return null
  const delta = cumulatives[1] - cumulatives[0]
  const w = BigInt(windowSeconds)
  let t = delta / w
  if (delta < 0n && delta % w !== 0n) t -= 1n
  return Number(t)
}

/** The pool's TWAP tick at `blockNumber`. A pool that cannot answer for the window refuses the operation. */
export async function twapTickAt(client: PublicClient, pool: Address, windowSeconds: number, blockNumber: bigint): Promise<number> {
  let tick: number | null = null
  try {
    const [cumulatives] = await client.readContract({ address: pool, abi: poolObserveAbi, functionName: 'observe', args: [[windowSeconds, 0]], blockNumber })
    tick = twapTickOf(cumulatives, windowSeconds)
  } catch {
    // reported below
  }
  if (tick === null) throw new ReasonError('EHG_TWAP_UNAVAILABLE', `${pool}: observe(${windowSeconds}) did not answer at ${blockNumber}`)
  return tick
}

/** Spot and TWAP more than `maxTicks` apart: slot0 may have been moved inside the block (otto/mamoru#140). */
export function diverges(spotTick: number, twapTick: number, maxTicks: number): boolean {
  return Math.abs(spotTick - twapTick) > maxTicks
}

/**
 * otto/mamoru#140: the least a swap of `amountIn` may return, judged at the TWAP and never at the spot: what the input
 * buys at the TWAP tick moved `deviationTicks` against the swap (the most the engine lets spot stray from the TWAP),
 * after the pool fee, less `slippageBps`. Slot0 and QuoterV2 at one block can both be moved by a swap in that block;
 * the TWAP over the policy window cannot, short of holding the price for most of the window.
 */
export function twapFloor(p: { amountIn: bigint; fee: number; twapTick: number; tokenInIsToken0: boolean; deviationTicks: number; slippageBps: number }): bigint {
  const afterFee = (p.amountIn * BigInt(1_000_000 - p.fee)) / 1_000_000n
  // Selling token0 gets less token1 at a lower tick; selling token1 gets less token0 at a higher one.
  const tick = p.tokenInIsToken0 ? p.twapTick - p.deviationTicks : p.twapTick + p.deviationTicks
  const sqrt = sqrtRatioAtTick(tick)
  const ideal = p.tokenInIsToken0 ? token0InToken1(afterFee, sqrt) : token1InToken0(afterFee, sqrt)
  return (ideal * BigInt(10_000 - p.slippageBps)) / 10_000n
}

/**
 * The router minimum of a swap: the larger of the usual minimum on the fresh quote and the TWAP floor, or null when
 * the quote itself is under the floor (the price at the prepare block is worse than the TWAP allows).
 */
export function swapMinimum(quote: bigint, slippageBps: number, floor: bigint): bigint | null {
  if (quote < floor) return null
  const usual = minOut(quote, slippageBps)
  return usual > floor ? usual : floor
}
