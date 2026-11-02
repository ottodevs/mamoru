import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { canonicalJson, decide, poolTvlInSavings, type Observation, type PoolObs } from './index.ts'

const POOL = 'pool:USDC/cbBTC/500'
const TICK = 69_000
const USDC = 10n ** 6n

function pool(over: Partial<PoolObs> = {}): PoolObs {
  const e = entry(POOL, baseRegistry)
  return {
    name: POOL, address: e.address, token0: 'USDC', token1: 'cbBTC', fee: 500, tickSpacing: 10,
    sqrtPriceX96: sqrtRatioAtTick(TICK), tick: TICK, liquidity: 10n ** 18n, twapTick: TICK,
    identity: { factoryPool: e.address, token0: address('USDC', baseRegistry), token1: address('cbBTC', baseRegistry), fee: 500, tickSpacing: 10 },
    ...over,
  }
}

function obs(p: PoolObs): Observation {
  return {
    chainId: 31337,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: [],
    native: 10n ** 17n,
    balances: { USDC: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: [p],
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-197_000), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
  }
}

const withTvl: PolicyVersion = { ...conservadorLabV1, shadow: [...new Set([...conservadorLabV1.shadow, 'packaging:tvl'])] }

describe('no TVL floor on policy pools (otto/mamoru#101 D15)', () => {
  test('a policy pool far under the old 2M floor, or with its TVL unread, gives no floor or unread row and the same decision', () => {
    const ref = decide(obs(pool()), withTvl)
    for (const tvlSavings of [1n, 1_036_354n * USDC, 1_999_999n * USDC, null]) {
      const d = decide(obs(pool({ tvlSavings })), withTvl)
      expect((d.shadowRisk ?? []).map((r) => r.code).filter((c) => c === 'RISK_POOL_TVL_FLOOR' || c === 'RISK_POOL_TVL_UNREAD')).toEqual([])
      expect(canonicalJson(d)).toBe(canonicalJson(ref))
    }
  })
})

describe('poolTvlInSavings', () => {
  test('stable side counts as is, the other side is priced at the TWAP and not at spot', () => {
    // USDC is token0 (6 decimals), cbBTC token1 (8): price tick 69,000 prices 1 cbBTC-unit in USDC-units at 1/1.0001^69000.
    const spotOnly = pool({ twapTick: null, sqrtPriceX96: sqrtRatioAtTick(TICK + 5_000) })
    const twap = pool({ twapTick: TICK, sqrtPriceX96: sqrtRatioAtTick(TICK + 5_000) })
    const usdc = 1_000_000n * USDC
    const btc = 10n * 10n ** 8n
    const priced = poolTvlInSavings(twap, usdc, btc, 'USDC')!
    const atSpot = poolTvlInSavings(spotOnly, usdc, btc, 'USDC')!
    const plain = poolTvlInSavings(pool({ twapTick: TICK }), usdc, btc, 'USDC')!
    expect(priced).toBe(plain)
    expect(priced).toBeGreaterThan(usdc)
    // 10 cbBTC at tick 69,000 is about 10 * 1e8 * 1.0001^-69000... as USDC raw units; sanity: the spot read differs.
    expect(atSpot).not.toBe(priced)
    expect(poolTvlInSavings(twap, usdc, 0n, 'USDC')).toBe(usdc)
  })

  test('a pool that does not pair the savings asset has no TVL in it', () => {
    expect(poolTvlInSavings(pool(), 1n, 1n, 'WETH')).toBeNull()
  })
})
