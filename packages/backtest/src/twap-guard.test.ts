import { describe, expect, test } from 'bun:test'
import { twapTick } from './observe.ts'
import type { Dataset, PoolSample } from './types.ts'

// otto/mamoru#127: a backfill that reads public pools through rotating providers once got two samples whose oracle
// cumulatives disagree (Base, WETH/USDC/500, 22 Nov), a mean tick of -482 billion. The window is unread then.
const pool = (tick: number, tickCumulative: bigint): PoolSample => ({ sqrtPriceX96: 1n << 96n, tick, liquidity: 1n, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n, tickCumulative })
const ds = (cums: bigint[], ticks: number[]): Dataset => ({
  id: '0x00',
  chainId: 8453,
  pools: ['pool:WETH/USDC/500'],
  samples: cums.map((c, i) => ({ block: i, hash: '0x00', time: i * 30, baseFeeWei: 0n, pools: [pool(ticks[i]!, c)] })),
})

describe('twapTick on a bad read (#127)', () => {
  test('consistent cumulatives give their mean', () => {
    expect(twapTick(ds([0n, -6_000_000n], [-200_000, -200_000]), 0, 1, 1800)).toBe(-200_000)
  })
  test('cumulatives from two disagreeing reads give the spot tick, never a tick no pool can have', () => {
    expect(twapTick(ds([-20_009_550_446_612n, -888_838_110_378_770n], [-202_224, -202_290]), 0, 1, 1800)).toBe(-202_290)
  })
})
