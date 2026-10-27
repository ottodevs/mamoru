import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { canonicalJson, decide, PACKAGING_TVL_FLOOR_USDC, poolTvlInSavings, tvlShadowRisk, type Observation, type PoolObs } from './index.ts'

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
const risk = (o: Observation, policy = withTvl) => decide(o, policy).shadowRisk ?? []

describe('packaging:tvl shadow (otto/mamoru#101)', () => {
  test('below the floor: a RISK_POOL_TVL_FLOOR entry naming the pool, the value and the floor', () => {
    const tvl = 1_430_000n * USDC
    expect(risk(obs(pool({ tvlSavings: tvl })))).toEqual([{ code: 'RISK_POOL_TVL_FLOOR', pool: POOL, threshold: FLOOR.toString(), metric: tvl.toString(), label: '1.43M' }])
  })

  test('at or above the floor, or not asked for (absent): nothing', () => {
    expect(risk(obs(pool({ tvlSavings: FLOOR })))).toEqual([])
    expect(risk(obs(pool({ tvlSavings: FLOOR * 3n })))).toEqual([])
    expect(risk(obs(pool()))).toEqual([])
    expect(decide(obs(pool()), withTvl).shadowRisk).toBeUndefined()
  })

  test('unread (null): RISK_POOL_TVL_UNREAD, its own code (RISK_DATA_INSUFFICIENT stays for live guards)', () => {
    expect(risk(obs(pool({ tvlSavings: null })))).toEqual([{ code: 'RISK_POOL_TVL_UNREAD', pool: POOL, threshold: FLOOR.toString() }])
  })

  test('a policy whose savings asset is not USDC: nothing (the floor is in dollars)', () => {
    const o = obs(pool({ tvlSavings: 1n }))
    expect(tvlShadowRisk(o, { ...withTvl, savingsAsset: 'WETH' } as PolicyVersion, new Set([POOL]))).toEqual([])
    expect(tvlShadowRisk(o, withTvl, new Set([POOL])).map((r) => r.code)).toEqual(['RISK_POOL_TVL_FLOOR'])
  })

  test('a policy without packaging:tvl: nothing, and the decision is the one it was', () => {
    const plain = decide(obs(pool()), withoutTvl)
    const d = decide(obs(pool({ tvlSavings: 1n })), withoutTvl)
    expect(d.shadowRisk).toBeUndefined()
    expect(canonicalJson(d)).toBe(canonicalJson(plain))
  })

  test('the premise never moves with the TVL: below, hovering across the floor, unread (dedupe and bundler backoff key on it)', () => {
    const at = (tvlSavings: bigint | null | undefined) => decide(obs(pool(tvlSavings === undefined ? {} : { tvlSavings })), withTvl)
    const ref = at(undefined)
    for (const v of [1_430_000n * USDC, 1_212_345n * USDC, FLOOR - 1n, FLOOR, FLOOR + 1n, null]) {
      const d = at(v)
      expect(d.premiseHash).toBe(ref.premiseHash)
      expect(d.decisionId).toBe(ref.decisionId)
      const { shadowRisk: _r, ...rest } = d
      expect(canonicalJson(rest)).toBe(canonicalJson(ref))
    }
  })

  test('shadow only: with a proposal on the table nothing but shadowRisk differs', () => {
    const base = obs(pool())
    base.balances = { USDC: 10_000_000_000n, cbBTC: 0n }
    base.deposits = [{ token: 'USDC', amount: 10_000_000_000n, block: 99n, txHash: `0x${'33'.repeat(32)}`, logIndex: 0, safe: true }]
    base.sessions = [
      { grant: 'enter-swap', permissionId: `0x${'01'.repeat(32)}`, validUntil: 10_000, active: true },
      { grant: 'enter-mint', permissionId: `0x${'02'.repeat(32)}`, validUntil: 10_000, active: true },
    ]
    const a = decide(base, withTvl)
    const b = decide({ ...base, pools: [pool({ tvlSavings: 1n })] }, withTvl)
    expect(b.shadowRisk?.map((r) => r.code)).toEqual(['RISK_POOL_TVL_FLOOR'])
    const { shadowRisk: _r, ...rest } = b
    expect(canonicalJson(rest)).toBe(canonicalJson(a))
    expect(b.proposal).not.toBeNull()
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
