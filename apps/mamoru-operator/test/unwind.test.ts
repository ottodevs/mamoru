import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2 } from '@mamoru/policy'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import type { PoolPosition, PoolPrice } from '../src/chain.ts'
import { planReduce, reduceOrder, routeOf } from '../src/unwind.ts'

const ORDER = conservadorLiveV2.buckets.flatMap((b) => b.pools)
const PRICES: Record<string, PoolPrice> = {
  'pool:USDC/USDT/100': { sqrtPriceX96: sqrtRatioAtTick(0), tick: 0 },
  'pool:USDC/cbBTC/500': { sqrtPriceX96: sqrtRatioAtTick(-69_080), tick: -69_080 },
  'pool:WETH/USDC/3000': { sqrtPriceX96: sqrtRatioAtTick(-193_380), tick: -193_380 },
}
// Out-of-range positions hold only USDC, so their value is exact: stables 10, btc 8, risk 2 USDC.
const pos = (tokenId: bigint, pool: string, usdc: bigint, usdcIs0: boolean): PoolPosition => ({
  tokenId,
  pool,
  token0: usdcIs0 ? 'USDC' : pool.includes('WETH') ? 'WETH' : 'X',
  token1: usdcIs0 ? pool.split('/')[1]! : 'USDC',
  fee: 0,
  liquidity: 1n,
  tickLower: 0,
  tickUpper: 1,
  inRange: false,
  amount0: usdcIs0 ? usdc : 0n,
  amount1: usdcIs0 ? 0n : usdc,
})
const risk = pos(3n, 'pool:WETH/USDC/3000', 2_000_000n, false)
const btc = pos(2n, 'pool:USDC/cbBTC/500', 8_000_000n, true)
const stables = pos(1n, 'pool:USDC/USDT/100', 10_000_000n, true)

describe('withdraw reduce order', () => {
  test('stables first, then BTC, then risk', () => {
    expect(reduceOrder([risk, btc, stables], ORDER).map((p) => p.tokenId)).toEqual([1n, 2n, 3n])
  })

  test('a withdraw the stables bucket covers only touches stables, partially', () => {
    const plan = planReduce([risk, btc, stables], PRICES, 4_000_000n, ORDER)
    expect(plan.map((x) => x.pos.tokenId)).toEqual([1n])
    expect(plan[0]!.bps).toBe(4001)
  })

  test('past stables: all of stables, then BTC as far as needed, risk untouched', () => {
    const plan = planReduce([risk, btc, stables], PRICES, 14_000_000n, ORDER)
    expect(plan.map((x) => [x.pos.tokenId, x.bps])).toEqual([
      [1n, 10_000],
      [2n, 5001],
    ])
  })

  test('risk only when stables and BTC are not enough', () => {
    const plan = planReduce([risk, btc, stables], PRICES, 19_000_000n, ORDER)
    expect(plan.map((x) => [x.pos.tokenId, x.bps])).toEqual([
      [1n, 10_000],
      [2n, 10_000],
      [3n, 5001],
    ])
  })

  test('volatile tokens swap back on the policy pool', () => {
    expect(routeOf('USDT', ORDER, [])).toBe('pool:USDC/USDT/100')
    expect(routeOf('WETH', ORDER, ['pool:WETH/USDC/500'])).toBe('pool:WETH/USDC/3000')
    expect(routeOf('EURC', ORDER, ['pool:EURC/USDC/500'])).toBe('pool:EURC/USDC/500')
  })
})
