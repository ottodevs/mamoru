import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, FALL_FREEZE_DEFAULTS, grantKey, type PolicyVersion } from '@mamoru/policy'
import { baseRegistry, address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { keccak256, stringToHex } from 'viem'
import { canonicalJson, decide, fallBpsOf, marketOf, type Observation, type PoolObs } from '../index.ts'

const V2 = conservadorLiveV2
const USDC = 1_000_000n
const BTC_POOL = 'pool:USDC/cbBTC/500'
const ETH_POOL = 'pool:WETH/USDC/3000'
const BTC_TICK = -69_080
const ETH_TICK = -193_380

function pool(name: string, tick: number): PoolObs {
  const e = entry(name, baseRegistry)
  return {
    name, address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!, tickSpacing: e.tickSpacing!,
    sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick,
    identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}

const POOLS = [pool('pool:USDC/USDT/100', 1), pool(BTC_POOL, BTC_TICK), pool(ETH_POOL, ETH_TICK)]

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: V2.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 20n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: POOLS,
    ethPrice: { pool: ETH_POOL, sqrtPriceX96: sqrtRatioAtTick(ETH_TICK), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

// The stables bucket has no pool here, so a fresh account's next entry goes to btc-usdc, then risk.
const guarded: PolicyVersion = {
  ...V2,
  policyId: 'test-guards',
  buckets: V2.buckets.map((b) => (b.id === 'stables' ? { ...b, pools: [] } : b)),
  guards: { byBucket: { 'btc-usdc': { fallFreeze: { ...FALL_FREEZE_DEFAULTS['btc-usdc'] } }, risk: { fallFreeze: { ...FALL_FREEZE_DEFAULTS.risk } } } },
}
const unguarded: PolicyVersion = { ...guarded, guards: undefined }

// cbBTC is token1 (it falls when the tick rises), WETH token0 (it falls with the tick).
const btcFall = (ticks: number, vol: number) => ({ twap24hAgoTick: BTC_TICK - ticks, realizedVol24hBps: vol })
const ethFall = (ticks: number, vol: number) => ({ twap24hAgoTick: ETH_TICK + ticks, realizedVol24hBps: vol })
const calm = { twap24hAgoTick: BTC_TICK, realizedVol24hBps: 3_000 }

describe('marketOf: 24 h history from TWAP cumulatives', () => {
  const W = 1_800
  const now = 200_000
  test('a flat tick: no volatility, the 24 h-ago TWAP is that tick', () => {
    expect(marketOf(now, W, (t) => ({ time: t, tickCumulative: BigInt(t) * 100n }))).toEqual({ twap24hAgoTick: 100, realizedVol24hBps: 0 })
  })
  test('the mean tick moves 10 ticks per window: annualized vol of that step', () => {
    // Mean of window ending at t is 10 * t / W: cumulative = 10 * t^2 / (2W) integrates it.
    const at = (t: number) => ({ time: t, tickCumulative: BigInt(Math.round((10 * t * t) / (2 * W))) })
    const m = marketOf(now, W, at)
    const expected = Math.round(10 * Math.log(1.0001) * Math.sqrt((365 * 86_400) / W) * 10_000)
    expect(Math.abs(m.realizedVol24hBps! - expected)).toBeLessThanOrEqual(1)
  })
  test('irregular samples: a point half a window or more before its time abstains', () => {
    const flat = (t: number) => ({ time: t, tickCumulative: BigInt(t) * 100n })
    // 10-minute samples (up to 599 s old): fine.
    expect(marketOf(now, W, (t) => flat(t - (t % 600))).realizedVol24hBps).toBe(0)
    // One point 900 s old would make a 900 s and a 2,700 s interval: abstain.
    expect(marketOf(now, W, (t) => flat(t === now - 10 * W ? t - 900 : t))).toEqual({ twap24hAgoTick: null, realizedVol24hBps: null })
    // A point after the time asked is not a reading of that time.
    expect(marketOf(now, W, (t) => flat(t === now - 10 * W ? t + 1 : t))).toEqual({ twap24hAgoTick: null, realizedVol24hBps: null })
  })
  test('a window that does not divide 24 h abstains', () => {
    expect(marketOf(now, 700, (t) => ({ time: t, tickCumulative: 0n }))).toEqual({ twap24hAgoTick: null, realizedVol24hBps: null })
  })
  test('any missing point: both null, never a partial history', () => {
    expect(marketOf(now, W, (t) => (t < now - 3_600 ? null : { time: t, tickCumulative: 0n }))).toEqual({ twap24hAgoTick: null, realizedVol24hBps: null })
  })
})

describe('fallBpsOf', () => {
  test('the volatile token falls whichever side of the pool it is', () => {
    expect(fallBpsOf(pool(BTC_POOL, BTC_TICK), 'USDC', BTC_TICK - 800, BTC_TICK)).toBe(769)
    expect(fallBpsOf(pool(ETH_POOL, ETH_TICK), 'USDC', ETH_TICK + 1_000, ETH_TICK)).toBe(952)
    expect(fallBpsOf(pool(ETH_POOL, ETH_TICK), 'USDC', ETH_TICK - 1_000, ETH_TICK)).toBeLessThan(0)
  })
})

describe('decide with the fall freeze (spec 004, #101)', () => {
  test('FR-LC-001: without policy.guards the decision is the one of today, guard history or not', () => {
    const plain = decide(obs(), unguarded)
    const withHistory = decide(obs({ guard: { pools: { [BTC_POOL]: btcFall(800, 9_000) } } }), unguarded)
    expect(withHistory).toEqual(plain)
    expect('guards' in plain).toBe(false)
  })

  test('FR-LC-001: conservador-live-v2 hashes as on main before this change', () => {
    // Pinned from origin/main 0bf828a: a fresh 20 USDC account on the three live pools. #149 moved the policy to 2.1.0
    // (usage limits and swap totals): with the 2.0.0 reference put back, the body hashes exactly as it did.
    const d = decide(obs({ pools: [pool('pool:USDC/USDT/100', 1), pool(BTC_POOL, BTC_TICK), pool(ETH_POOL, ETH_TICK)] }), V2)
    const { decisionId: _id, premiseHash: _p, observationRef, waiting: _w, ...body } = d
    const v200 = { policyId: 'conservador-live-v2', version: '2.0.0', hash: '0x8ebbf57ba5bf3abc863df041f5d19c62bc8123a799558b5ad499d441cd11158f' }
    const premiseHash = keccak256(stringToHex(canonicalJson({ ...body, policyRef: v200 })))
    expect(premiseHash).toBe('0xba0154c8654402a8894a96446348fde417120234a0cbd39c7d3350aad927705b')
    expect(keccak256(stringToHex(canonicalJson({ observationRef, premiseHash })))).toBe('0xdfbdfb7a9da7dd24de458c414e0a2bae0fac9500e57ae74dcc6f34eaae1aa1cf')
  })

  test('a frozen bucket keeps its idle volatile token: no sell-back caused by the guard', () => {
    // btc-usdc alone, at target with an in-range position plus idle cbBTC: without the guard the idle token is converted.
    const btcOnly: PolicyVersion = { ...guarded, buckets: guarded.buckets.filter((b) => b.id === 'btc-usdc') }
    const p = { tokenId: 9n, pool: BTC_POOL, tickLower: BTC_TICK - 500, tickUpper: BTC_TICK + 500, liquidity: 10n ** 10n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
    const o = (over: Partial<Observation>) => obs({ positions: [p], balances: { USDC: 0n, USDT: 0n, cbBTC: 1_000n, WETH: 0n }, ...over })
    const sold = decide(o({ guard: { pools: { [BTC_POOL]: calm } } }), btcOnly)
    expect(sold.proposal).toMatchObject({ kind: 'enter_swap', pool: BTC_POOL, tokenIn: 'cbBTC', tokenOut: 'USDC' })
    const held = decide(o({ guard: { pools: { [BTC_POOL]: btcFall(800, 9_000) } } }), btcOnly)
    expect(held.proposal).toBeNull()
    expect(held.reason).toBe('DECIDE_ENTRY_PAUSED_FALL')
  })

  test('btc-usdc in a fast fall: no entry there, the next bucket gets it, the note carries metric and threshold', () => {
    expect(decide(obs(), guarded).proposal?.pool).toBe(BTC_POOL)
    const d = decide(obs({ guard: { pools: { [BTC_POOL]: btcFall(800, 9_000), [ETH_POOL]: calm } } }), guarded)
    expect(d.proposal?.pool).toBe(ETH_POOL)
    expect(d.buckets.find((b) => b.bucket === 'btc-usdc')?.code).toBe('DECIDE_ENTRY_PAUSED_FALL')
    expect(d.guards).toEqual([{ bucket: 'btc-usdc', pool: BTC_POOL, code: 'DECIDE_ENTRY_PAUSED_FALL', metric: { fallBps: 769, volBps: 9_000 }, threshold: { fallBps: 700, volBps: 8_000 } }])
  })

  test('both volatile buckets frozen: hold with DECIDE_ENTRY_PAUSED_FALL; the USDC waits', () => {
    const d = decide(obs({ guard: { pools: { [BTC_POOL]: btcFall(800, 9_000), [ETH_POOL]: ethFall(1_000, 12_000) } } }), guarded)
    expect(d.kind).toBe('hold')
    expect(d.reason).toBe('DECIDE_ENTRY_PAUSED_FALL')
  })

  test('resumes by itself: a fall under the threshold, or volatility under it, lets the entry go', () => {
    expect(decide(obs({ guard: { pools: { [BTC_POOL]: btcFall(600, 9_000) } } }), guarded).proposal?.pool).toBe(BTC_POOL)
    expect(decide(obs({ guard: { pools: { [BTC_POOL]: btcFall(800, 7_000) } } }), guarded).proposal?.pool).toBe(BTC_POOL)
  })

  test('FR-LC-007: missing history abstains (RISK_DATA_INSUFFICIENT), the entry goes', () => {
    const d = decide(obs(), guarded)
    expect(d.proposal?.pool).toBe(BTC_POOL)
    expect(d.guards?.map((g) => g.code)).toEqual(['RISK_DATA_INSUFFICIENT', 'RISK_DATA_INSUFFICIENT'])
  })

  test('re-ranges keep running in a frozen bucket', () => {
    // A cbBTC position the price has left: the re-range is proposed as without the guard.
    const p = { tokenId: 7n, pool: BTC_POOL, tickLower: BTC_TICK - 1_000, tickUpper: BTC_TICK - 500, liquidity: 10n ** 12n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
    const d = decide(obs({ positions: [p], guard: { pools: { [BTC_POOL]: btcFall(800, 9_000) } } }), guarded)
    expect(d.proposal).toMatchObject({ kind: 'rerange', pool: BTC_POOL, tokenId: 7n })
  })
})
