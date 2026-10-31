import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, conservadorLiveV2, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { canonicalJson, decide, poolStatsShadowRisk, type Observation, type PoolObs, type PoolStatsObs } from './index.ts'

const STABLES = 'pool:USDC/USDT/100'
const BTC = 'pool:USDC/cbBTC/500'
const RISK = 'pool:WETH/USDC/3000'
const TICK = 69_000
const M = 1_000_000

function pool(): PoolObs {
  const e = entry(BTC, baseRegistry)
  return {
    name: BTC, address: e.address, token0: 'USDC', token1: 'cbBTC', fee: 500, tickSpacing: 10,
    sqrtPriceX96: sqrtRatioAtTick(TICK), tick: TICK, liquidity: 10n ** 18n, twapTick: TICK,
    identity: { factoryPool: e.address, token0: address('USDC', baseRegistry), token1: address('cbBTC', baseRegistry), fee: 500, tickSpacing: 10 },
  }
}

function obs(poolStats?: Record<string, PoolStatsObs>): Observation {
  return {
    chainId: 31337,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: [], native: 10n ** 17n, balances: { USDC: 0n, cbBTC: 0n, WETH: 0n }, positions: [], pools: [pool()],
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-197_000), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [], intents: { paused: false, exitRequested: false }, slot: null,
    ...(poolStats ? { poolStats } : {}),
  }
}

/** Healthy numbers for a 5M pool: nothing fires. */
const healthy = (over: Partial<PoolStatsObs> = {}): PoolStatsObs => ({
  tvlUsd: 5 * M, tvl1dAgoUsd: 5 * M, tvl7dAgoUsd: 5 * M, tvl30dAgoUsd: 5 * M,
  volume7dUsd: 10 * M, volumeLastDayUsd: 1.5 * M, volume28dAvgUsd: 1.5 * M, asOf: 1,
  ...over,
})

const live: PolicyVersion = { ...conservadorLiveV2, shadow: [...new Set([...conservadorLiveV2.shadow, 'packaging:tvl'])] }
const POOLS = new Set([STABLES, BTC, RISK])
const rules = (s: Record<string, PoolStatsObs>, policy = live) => poolStatsShadowRisk(obs(s), policy, POOLS)
const only = (name: string, s: PoolStatsObs) => rules({ [STABLES]: healthy(), [BTC]: healthy(), [RISK]: healthy(), [name]: s })

describe('packaging:tvl pool stats shadow (otto/mamoru#101 phase 1b)', () => {
  test('healthy pools: nothing', () => {
    expect(rules({ [STABLES]: healthy(), [BTC]: healthy(), [RISK]: healthy() })).toEqual([])
  })

  test('TVL change 1d: at -12% fires, just above does not', () => {
    const at = only(BTC, healthy({ tvlUsd: 0.88 * 5 * M }))
    expect(at.map((r) => [r.code, r.window, r.pool])).toEqual([['RISK_POOL_TVL_DROP', '1d', BTC]])
    expect(at[0]).toMatchObject({ threshold: '-1200', metric: '-1200' })
    expect(only(BTC, healthy({ tvlUsd: 0.881 * 5 * M }))).toEqual([])
  })

  test('TVL change 7d at -20% and 30d at -30%, each its own horizon', () => {
    expect(only(BTC, healthy({ tvlUsd: 4 * M, tvl1dAgoUsd: 4 * M, tvl30dAgoUsd: 4 * M })).map((r) => r.window)).toEqual(['7d'])
    expect(only(BTC, healthy({ tvlUsd: 3.5 * M, tvl1dAgoUsd: 3.5 * M, tvl7dAgoUsd: 3.5 * M })).map((r) => r.window)).toEqual(['30d'])
    expect(only(BTC, healthy({ tvlUsd: 4.0001 * M, tvl1dAgoUsd: 4.0001 * M, tvl30dAgoUsd: 4.0001 * M }))).toEqual([])
    expect(only(BTC, healthy({ tvlUsd: 3.4999 * M, tvl1dAgoUsd: 3.4999 * M, tvl7dAgoUsd: 3.4999 * M })).map((r) => r.window)).toEqual(['30d'])
  })

  test('a fall past all three horizons gives three entries', () => {
    expect(only(BTC, healthy({ tvlUsd: 1 * M })).map((r) => r.window)).toEqual(['1d', '7d', '30d'])
  })

  test('volume per bucket: ratio threshold vs floor, the larger wins', () => {
    // stables 0.35x on 5M TVL = 1.75M (above the 1M floor)
    expect(only(STABLES, healthy({ volume7dUsd: 1.75 * M })).filter((r) => r.code === 'RISK_POOL_VOLUME_LOW')).toEqual([])
    const s = only(STABLES, healthy({ volume7dUsd: 1.7499 * M })).filter((r) => r.window === '7d')
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ code: 'RISK_POOL_VOLUME_LOW', threshold: String(1.75 * M * M), pool: STABLES })
    // btc-usdc 0.25x on 5M = 1.25M
    expect(only(BTC, healthy({ volume7dUsd: 1.25 * M }))).toEqual([])
    expect(only(BTC, healthy({ volume7dUsd: 1.2499 * M })).map((r) => r.code)).toEqual(['RISK_POOL_VOLUME_LOW'])
    // risk 0.05x on 5M = 250k
    expect(only(RISK, healthy({ volume7dUsd: 250_000 }))).toEqual([])
    expect(only(RISK, healthy({ volume7dUsd: 249_999 })).map((r) => r.code)).toEqual(['RISK_POOL_VOLUME_LOW'])
  })

  test('absolute floors win when the pool is small', () => {
    const small = { tvlUsd: 2 * M, tvl1dAgoUsd: 2 * M, tvl7dAgoUsd: 2 * M, tvl30dAgoUsd: 2 * M }
    // stables: 0.35x2M = 700k < floor 1M
    expect(only(STABLES, healthy({ ...small, volume7dUsd: 1_000_000 })).filter((r) => r.window === '7d')).toEqual([])
    expect(only(STABLES, healthy({ ...small, volume7dUsd: 999_999 })).filter((r) => r.window === '7d')[0]).toMatchObject({ threshold: String(M * M) })
    // btc-usdc: 0.25x2M = 500k > floor 300k; use 1M TVL -> 250k < floor 300k
    const tiny = { tvlUsd: 1 * M, tvl1dAgoUsd: 1 * M, tvl7dAgoUsd: 1 * M, tvl30dAgoUsd: 1 * M }
    expect(only(BTC, healthy({ ...tiny, volume7dUsd: 300_000 }))).toEqual([])
    expect(only(BTC, healthy({ ...tiny, volume7dUsd: 299_999 }))[0]).toMatchObject({ threshold: String(300_000 * M) })
    // risk: floor 20k at 100k TVL (5k by ratio)
    const t2 = { tvlUsd: 1e5, tvl1dAgoUsd: 1e5, tvl7dAgoUsd: 1e5, tvl30dAgoUsd: 1e5 }
    expect(only(RISK, healthy({ ...t2, volume7dUsd: 20_000 }))).toEqual([])
    expect(only(RISK, healthy({ ...t2, volume7dUsd: 19_999 })).map((r) => r.code)).toEqual(['RISK_POOL_VOLUME_LOW'])
  })

  test('stables only: last day under 30% of the 28 day average', () => {
    expect(only(STABLES, healthy({ volumeLastDayUsd: 0.45 * M, volume28dAvgUsd: 1.5 * M }))).toEqual([])
    const r = only(STABLES, healthy({ volumeLastDayUsd: 0.4499 * M, volume28dAvgUsd: 1.5 * M }))
    expect(r.map((x) => [x.code, x.window])).toEqual([['RISK_POOL_VOLUME_LOW', '28d']])
    // not for the other buckets
    expect(only(BTC, healthy({ volumeLastDayUsd: 1, volume28dAvgUsd: 1.5 * M }))).toEqual([])
    expect(only(RISK, healthy({ volumeLastDayUsd: 1, volume28dAvgUsd: 1.5 * M }))).toEqual([])
  })

  test('unread: any missing input is RISK_POOL_STATS_UNREAD, never a drop or low-volume entry', () => {
    const nothing = { tvlUsd: null, tvl1dAgoUsd: null, tvl7dAgoUsd: null, tvl30dAgoUsd: null, volume7dUsd: null, volumeLastDayUsd: null, volume28dAvgUsd: null }
    const r = only(STABLES, healthy(nothing))
    expect(r.map((x) => x.code)).toEqual(['RISK_POOL_STATS_UNREAD'])
    expect(only(BTC, healthy({ tvl30dAgoUsd: null })).map((x) => x.code)).toEqual(['RISK_POOL_STATS_UNREAD'])
    // the rules that can be evaluated still are
    expect(only(BTC, healthy({ tvl30dAgoUsd: null, tvlUsd: 4 * M, tvl1dAgoUsd: 4 * M })).map((x) => x.code)).toEqual(['RISK_POOL_TVL_DROP', 'RISK_POOL_STATS_UNREAD'])
    // stables need the daily figures, the others do not
    expect(only(STABLES, healthy({ volume28dAvgUsd: null })).map((x) => x.code)).toEqual(['RISK_POOL_STATS_UNREAD'])
    expect(only(BTC, healthy({ volume28dAvgUsd: null, volumeLastDayUsd: null }))).toEqual([])
    // a pool with no entry at all
    expect(rules({ [STABLES]: healthy(), [BTC]: healthy() }).map((x) => [x.code, x.pool])).toEqual([['RISK_POOL_STATS_UNREAD', RISK]])
    expect(only(BTC, healthy({ tvlUsd: Number.NaN })).map((x) => x.code)).toEqual(['RISK_POOL_STATS_UNREAD'])
  })

  test('no poolStats in the observation, or a policy without packaging:tvl: nothing', () => {
    expect(poolStatsShadowRisk(obs(), live, POOLS)).toEqual([])
    const bad = { [STABLES]: healthy({ tvlUsd: 1 }), [BTC]: healthy({ tvlUsd: 1 }), [RISK]: healthy({ tvlUsd: 1 }) }
    const plain: PolicyVersion = { ...live, shadow: live.shadow.filter((s) => s !== 'packaging:tvl') }
    expect(decide(obs(bad), plain).shadowRisk).toBeUndefined()
    expect(canonicalJson(decide(obs(bad), plain))).toBe(canonicalJson(decide(obs(), plain)))
  })

  test('decide: entries reach Decision.shadowRisk and the premise and decisionId never move with any stats value', () => {
    const lab: PolicyVersion = { ...conservadorLabV1, shadow: [...new Set([...conservadorLabV1.shadow, 'packaging:tvl'])] }
    const ref = decide(obs(), lab)
    const variants: (Record<string, PoolStatsObs> | undefined)[] = [
      { [BTC]: healthy() },
      { [BTC]: healthy({ tvlUsd: 1 }) },
      { [BTC]: healthy({ volume7dUsd: 0 }) },
      { [BTC]: healthy({ tvlUsd: null, volume7dUsd: null }) },
      {},
    ]
    for (const v of variants) {
      const d = decide(obs(v), lab)
      expect(d.premiseHash).toBe(ref.premiseHash)
      expect(d.decisionId).toBe(ref.decisionId)
      const { shadowRisk: _r, ...rest } = d
      expect(canonicalJson(rest)).toBe(canonicalJson(ref))
    }
    expect(decide(obs({ [BTC]: healthy({ tvlUsd: 1 }) }), lab).shadowRisk?.map((r) => r.code)).toContain('RISK_POOL_TVL_DROP')
    expect(decide(obs({ [BTC]: healthy() }), lab).shadowRisk).toBeUndefined()
  })
})
