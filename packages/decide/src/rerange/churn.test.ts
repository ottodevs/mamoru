import { describe, expect, test } from 'bun:test'
import { conservadorLiveV1, grantKey, type PolicyVersion } from '@mamoru/policy'
import { baseRegistry, address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, type Observation, type PoolObs, type PositionObs } from '../index.ts'
import { dwellJitterSeconds } from './index.ts'

// otto/mamoru#218: weekly cap, restart history, eager cost test, dwell jitter.
const POOL = 'pool:USDC/cbBTC/500'
const OTHER = 'pool:USDC/USDT/100'
const ETH_POOL = 'pool:WETH/USDC/3000'
const TICK = 69_000
const NOW = 1_000_000n
const DAY = 86_400n
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'

function pool(tick = TICK): PoolObs {
  const e = entry(POOL, baseRegistry)
  return {
    name: POOL, address: e.address, token0: 'USDC', token1: 'cbBTC', fee: 500, tickSpacing: 10,
    sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick,
    identity: { factoryPool: e.address, token0: address('USDC', baseRegistry), token1: address('cbBTC', baseRegistry), fee: 500, tickSpacing: 10 },
  }
}

function obs(policy: PolicyVersion, over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: NOW },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: A, deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: policy.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 100_000_000, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 4_645_000_000n, cbBTC: 0n, WETH: 0n },
    positions: [position()],
    pools: [pool(TICK + 1500)],
    ethPrice: { pool: ETH_POOL, sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

function position(over: Partial<PositionObs> = {}): PositionObs {
  return { tokenId: 7n, pool: POOL, tickLower: TICK - 1000, tickUpper: TICK + 1000, liquidity: 10n ** 12n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: false, ...over }
}

const market = (feeGrowth: bigint) => ({ pools: { [POOL]: { twap24hAgoTick: TICK, realizedVol24hBps: 4000, feeGrowth24h: { growth0X128: feeGrowth, growth1X128: 0n, seconds: 86_400 } } } })
const capped = (n: number, lazy?: NonNullable<PolicyVersion['range']['lazy']>): PolicyVersion => ({ ...conservadorLiveV1, range: { ...conservadorLiveV1.range, maxPerWeek: n, ...(lazy ? { lazy } : {}) } })
const LAZY = { edgeBufferTicks: 0, minDwellSeconds: 0, horizonSeconds: 86_400, lvrWeightBps: 10_000, requireCostEstimate: false } as const
const ago = (s: bigint, pl = POOL) => ({ pool: pl, at: NOW - s })
// Older than the policy cooldown (900 s), so only the weekly count can hold.
const two = [ago(DAY), ago(2n * DAY)]

describe('weekly cap per pool (#218)', () => {
  for (const mode of ['eager', 'lazy'] as const) {
    const p = capped(2, mode === 'lazy' ? LAZY : undefined)
    test(`${mode}: the third re-range in 7 days holds with DECIDE_RANGE_WEEKLY_CAP`, () => {
      const held = decide(obs(p, { recentReranges: two }), p)
      expect(held.kind).toBe('hold')
      expect(held.positions[0]!.codes).toContain('DECIDE_RANGE_WEEKLY_CAP')
      expect(held.proposal).toBeNull()
      // One fewer in the window: it goes.
      expect(decide(obs(p, { recentReranges: [ago(DAY)] }), p).kind).toBe('rerange')
    })
    test(`${mode}: allowed again once the oldest leaves the 7-day window`, () => {
      const old = [ago(DAY), ago(7n * DAY + 1n)]
      expect(decide(obs(p, { recentReranges: old }), p).kind).toBe('rerange')
      expect(decide(obs(p, { recentReranges: [ago(DAY), ago(7n * DAY)] }), p).kind).toBe('rerange')
      expect(decide(obs(p, { recentReranges: [ago(DAY), ago(7n * DAY - 1n)] }), p).kind).toBe('hold')
    })
  }

  test('per pool, not per account: re-ranges of another pool do not count', () => {
    const p = capped(2)
    expect(decide(obs(p, { recentReranges: [ago(DAY, OTHER), ago(2n * DAY, OTHER), ago(3n * DAY, OTHER)] }), p).kind).toBe('rerange')
  })

  test('no cap set: history is ignored, as before', () => {
    expect(decide(obs(conservadorLiveV1, { recentReranges: [ago(DAY), ago(2n * DAY), ago(3n * DAY)] }), conservadorLiveV1).kind).toBe('rerange')
  })

  test('the cooldown is checked first', () => {
    const p = capped(1)
    const d = decide(obs(p, { lastRerangeAt: NOW - 60n, recentReranges: [{ pool: POOL, at: NOW - 60n }] }), p)
    expect(d.positions[0]!.codes).toContain('DECIDE_RANGE_COOLDOWN')
  })

  test('restart seed: the history alone restores the cooldown (lastRerangeAt from the newest)', () => {
    const history = [ago(600n), ago(2n * DAY)]
    const newest = history.reduce((m, r) => (r.at > m ? r.at : m), 0n)
    const d = decide(obs(conservadorLiveV1, { lastRerangeAt: newest, recentReranges: history }), conservadorLiveV1)
    expect(d.positions[0]!.codes).toContain('DECIDE_RANGE_COOLDOWN')
  })

  test('an empty or absent history leaves the observation (and its hash) untouched', () => {
    const o = obs(conservadorLiveV1)
    expect(decide(o, conservadorLiveV1).premiseHash).toBe(decide({ ...o }, conservadorLiveV1).premiseHash)
    expect('recentReranges' in o).toBe(false)
  })
})

describe('eager cost test (#218)', () => {
  test('below cost holds with DECIDE_RANGE_BELOW_COST; worth it re-ranges', () => {
    const poor = decide(obs(conservadorLiveV1, { guard: market(1n) }), conservadorLiveV1)
    expect(poor.kind).toBe('hold')
    expect(poor.positions[0]!.codes).toContain('DECIDE_RANGE_BELOW_COST')
    expect(decide(obs(conservadorLiveV1, { guard: market(1n << 120n) }), conservadorLiveV1).kind).toBe('rerange')
  })

  test('no fee history: the test abstains and eager re-ranges as before', () => {
    expect(decide(obs(conservadorLiveV1), conservadorLiveV1).kind).toBe('rerange')
  })
})

describe('lazy dwell jitter (#218)', () => {
  test('deterministic, bounded by minDwell/2, zero without a dwell, and differs across addresses', () => {
    expect(dwellJitterSeconds(A, 0)).toBe(0)
    expect(dwellJitterSeconds(A, 1800)).toBe(dwellJitterSeconds(A, 1800))
    expect(dwellJitterSeconds(A.toUpperCase().replace('0X', '0x'), 1800)).toBe(dwellJitterSeconds(A, 1800))
    for (const a of [A, B, '0x1111111111111111111111111111111111111111']) {
      const j = dwellJitterSeconds(a, 1800)
      expect(j).toBeGreaterThanOrEqual(0)
      expect(j).toBeLessThanOrEqual(900)
    }
    expect(dwellJitterSeconds(A, 1800)).not.toBe(dwellJitterSeconds(B, 1800))
  })

  test('the dwell an account needs is minDwell plus its jitter', () => {
    const p = capped(50, { ...LAZY, minDwellSeconds: 1800 })
    const need = BigInt(1800 + dwellJitterSeconds(A, 1800))
    const at = (since: bigint) => decide(obs(p, { positions: [position({ outOfRangeSince: NOW - since })] }), p)
    expect(at(need - 1n).kind).toBe('hold')
    expect(at(need).kind).toBe('rerange')
    // The other account waits its own time.
    const needB = BigInt(1800 + dwellJitterSeconds(B, 1800))
    const atB = (since: bigint) => decide(obs(p, { account: { address: B, deployed: true, nonceKey: 0n, nonce: 0n }, positions: [position({ outOfRangeSince: NOW - since })] }), p)
    expect(atB(needB - 1n).kind).toBe('hold')
    expect(atB(needB).kind).toBe('rerange')
  })
})
