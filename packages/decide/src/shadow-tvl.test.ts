import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { canonicalJson, decide, PACKAGING_TVL_FLOOR_USDC, poolTvlInSavings, type Observation, type PoolObs } from './index.ts'

const POOL = 'pool:USDC/cbBTC/500'
const TICK = 69_000
const USDC = 10n ** 6n
const FLOOR = PACKAGING_TVL_FLOOR_USDC * USDC

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
const withoutTvl: PolicyVersion = { ...conservadorLabV1, shadow: conservadorLabV1.shadow.filter((s) => s !== 'packaging:tvl') }
const tvlNotes = (o: Observation, policy = withTvl) => decide(o, policy).shadow.filter((s) => s.code !== 'ENY_SHADOW')

describe('packaging:tvl shadow (otto/mamoru#101)', () => {
  test('below the floor: a RISK_POOL_TVL_FLOOR note naming the pool, the value and the floor', () => {
    const tvl = 1_430_000n * USDC
    expect(tvlNotes(obs(pool({ tvlSavings: tvl })))).toEqual([
      { code: 'RISK_POOL_TVL_FLOOR', note: `${POOL} TVL under the 2M floor: Packaging would exit`, pool: POOL, threshold: FLOOR.toString() },
    ])
    expect(decide(obs(pool({ tvlSavings: tvl })), withTvl).shadowMetrics).toEqual([{ code: 'RISK_POOL_TVL_FLOOR', pool: POOL, metric: tvl.toString(), label: '1.43M' }])
  })

  test('a TVL that moves under the floor keeps the premise: dedupe and backoff key on it (engine.ts)', () => {
    const a = decide(obs(pool({ tvlSavings: 1_430_000n * USDC })), withTvl)
    const b = decide(obs(pool({ tvlSavings: 1_212_345n * USDC })), withTvl)
    expect(b.premiseHash).toBe(a.premiseHash)
    expect(b.shadowMetrics?.[0]?.metric).not.toBe(a.shadowMetrics?.[0]?.metric)
  })

  test('at or above the floor: no note', () => {
    expect(tvlNotes(obs(pool({ tvlSavings: FLOOR })))).toEqual([])
    expect(tvlNotes(obs(pool({ tvlSavings: FLOOR * 3n })))).toEqual([])
  })

  test('unread (null): RISK_DATA_INSUFFICIENT', () => {
    expect(tvlNotes(obs(pool({ tvlSavings: null })))).toEqual([
      { code: 'RISK_DATA_INSUFFICIENT', note: `${POOL} TVL unread`, pool: POOL, threshold: FLOOR.toString() },
    ])
  })

  test('not asked for by the observation (absent): no note', () => {
    expect(tvlNotes(obs(pool()))).toEqual([])
  })

  test('a policy without packaging:tvl: no note, and the decision is the one it was', () => {
    const o = obs(pool({ tvlSavings: 1n }))
    const plain = decide(obs(pool()), withoutTvl)
    const d = decide(o, withoutTvl)
    expect(d.shadow.map((s) => s.code)).toEqual([])
    expect(canonicalJson(d)).toBe(canonicalJson(plain))
  })

  test('shadow only: proposal, code, reason, buckets and trail do not move', () => {
    const base = obs(pool())
    base.balances = { USDC: 10_000_000_000n, cbBTC: 0n }
    base.deposits = [{ token: 'USDC', amount: 10_000_000_000n, block: 99n, txHash: `0x${'33'.repeat(32)}`, logIndex: 0, safe: true }]
    base.sessions = [
      { grant: 'enter-swap', permissionId: `0x${'01'.repeat(32)}`, validUntil: 10_000, active: true },
      { grant: 'enter-mint', permissionId: `0x${'02'.repeat(32)}`, validUntil: 10_000, active: true },
    ]
    const low = { ...base, pools: [pool({ tvlSavings: 1n })] }
    const a = decide(base, withTvl)
    const b = decide(low, withTvl)
    expect(b.shadow.map((s) => s.code)).toContain('RISK_POOL_TVL_FLOOR')
    const { shadow: _s, premiseHash: _p, decisionId: _d, ...restA } = a
    const { shadow: _s2, premiseHash: _p2, decisionId: _d2, shadowMetrics: _m2, ...restB } = b
    expect(canonicalJson(restB)).toBe(canonicalJson(restA))
    expect(b.proposal).not.toBeNull()
    // The notes are part of the premise, as ENY_SHADOW is: the same notes give the same hashes.
    expect(decide(structuredClone(low), withTvl).premiseHash).toBe(b.premiseHash)
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
