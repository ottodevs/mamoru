import { keccak256, toHex } from 'viem'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { makeDataset } from './dataset.ts'
import type { Dataset, PoolSample, Sample } from './types.ts'

/** The three pools of conservador-live-v2, with the tick and active liquidity Base had on 2026-10-01. */
export const POOLS = ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'] as const
const START = [
  { tick: 9, liquidity: 166_051_376_970_296n },
  { tick: -67_420, liquidity: 2_225_251_034_900n },
  { tick: -197_323, liquidity: 46_960_404_211_274_752_978n },
] as const

export type Path = {
  samples: number
  /** Seconds between samples. Default 300. */
  step?: number
  /** Tick of pool `k` at sample `i`, as an offset from its start tick. Default: flat. */
  tick?: (k: number, i: number) => number
  /** Fee growth both counters gain per sample, per pool. Default: none. */
  growth?: readonly [bigint, bigint, bigint]
}

/** A synthetic chain history: every pool follows `tick`, its oracle cumulative integrates it, and fee growth is linear. */
export function syntheticDataset(path: Path): Dataset {
  const step = path.step ?? 300
  const cumulative = [0n, 0n, 0n]
  const samples: Sample[] = []
  for (let i = 0; i < path.samples; i++) {
    const pools: PoolSample[] = START.map((p, k) => {
      const tick = p.tick + (path.tick?.(k, i) ?? 0)
      if (i > 0) cumulative[k] = cumulative[k]! + BigInt(tick) * BigInt(step)
      const g = (path.growth?.[k] ?? 0n) * BigInt(i)
      return { sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: p.liquidity, feeGrowthGlobal0X128: g, feeGrowthGlobal1X128: g, tickCumulative: cumulative[k]! }
    })
    samples.push({ block: 52_000_000 + (i * step) / 2, hash: keccak256(toHex(`block-${i}`)), time: 1_790_900_000 + i * step, baseFeeWei: 5_000_000n, pools })
  }
  return makeDataset(8453, [...POOLS], samples)
}
