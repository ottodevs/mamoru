import { describe, expect, test } from 'bun:test'
import { conservadorLiveV1, conservadorLiveV2, grantKey, type PolicyVersion } from '@mamoru/policy'
import { baseRegistry, address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, outOfRangeSinceOf, rerangeWorth, weightTargets, withOutOfRangeSince, type Observation, type PoolObs, type PositionObs } from '../index.ts'
import { levelOf } from './weights.ts'

const USDC = 1_000_000n
const BTC_POOL = 'pool:USDC/cbBTC/500'
const ETH_POOL = 'pool:WETH/USDC/3000'
const STABLE_POOL = 'pool:USDC/USDT/100'
const TICK = 69_000
const ETH_TICK = -193_380

function pool(name: string, tick: number): PoolObs {
  const e = entry(name, baseRegistry)
  return {
    name, address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!, tickSpacing: e.tickSpacing!,
    sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick,
    identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}

function obs(policy: PolicyVersion, over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 100_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: policy.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000_000, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 0n, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: [pool(BTC_POOL, TICK)],
    ethPrice: { pool: ETH_POOL, sqrtPriceX96: sqrtRatioAtTick(ETH_TICK), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

/** Range 68000..70000 on the cbBTC pool. */
function position(over: Partial<PositionObs> = {}): PositionObs {
  return { tokenId: 7n, pool: BTC_POOL, tickLower: TICK - 1000, tickUpper: TICK + 1000, liquidity: 10n ** 12n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: false, ...over }
}

const BALANCED = { USDC: 4_645_000_000n, cbBTC: 0n, WETH: 0n }
const lazy = (o: Partial<NonNullable<PolicyVersion['range']['lazy']>> = {}): PolicyVersion => ({
  ...conservadorLiveV1,
  range: { ...conservadorLiveV1.range, lazy: { edgeBufferTicks: 0, minDwellSeconds: 0, horizonSeconds: 86_400, lvrWeightBps: 10_000, ...o } },
})
const market = (feeGrowth: bigint, vol = 4000) => ({ pools: { [BTC_POOL]: { twap24hAgoTick: TICK, realizedVol24hBps: vol, feeGrowth24h: { growth0X128: feeGrowth, growth1X128: 0n, seconds: 86_400 } } } })

describe('lazy re-range (#101 experiment 4)', () => {
  test('no near-edge trigger: in range 15% from the edge, live re-ranges and lazy holds', () => {
    const o = obs(conservadorLiveV1, { balances: BALANCED, positions: [position()], pools: [pool(BTC_POOL, TICK + 850)] })
    expect(decide(o, conservadorLiveV1).kind).toBe('rerange')
    expect(decide(o, lazy()).kind).toBe('hold')
  })

  test('edge buffer: out by less than the buffer holds, past it re-ranges (no fee history: the cost test abstains)', () => {
    const p = lazy({ edgeBufferTicks: 200 })
    expect(decide(obs(p, { balances: BALANCED, positions: [position()], pools: [pool(BTC_POOL, TICK + 1100)] }), p).kind).toBe('hold')
    expect(decide(obs(p, { balances: BALANCED, positions: [position()], pools: [pool(BTC_POOL, TICK + 1300)] }), p).kind).toBe('rerange')
    // Below the range the same buffer holds.
    expect(decide(obs(p, { balances: BALANCED, positions: [position()], pools: [pool(BTC_POOL, TICK - 1150)] }), p).kind).toBe('hold')
    expect(decide(obs(p, { balances: BALANCED, positions: [position()], pools: [pool(BTC_POOL, TICK - 1250)] }), p).kind).toBe('rerange')
  })

  test('minimum dwell: out for less than the dwell waits with DECIDE_RANGE_COOLDOWN; longer re-ranges; unknown waits', () => {
    const p = lazy({ minDwellSeconds: 1800 })
    const at = (since: bigint | null) => decide(obs(p, { balances: BALANCED, positions: [position({ outOfRangeSince: since })], pools: [pool(BTC_POOL, TICK + 1500)] }), p)
    const short = at(100_000n - 600n)
    expect(short.kind).toBe('hold')
    expect(short.positions[0]!.codes).toContain('DECIDE_RANGE_COOLDOWN')
    expect(at(100_000n - 1800n).kind).toBe('rerange')
    expect(at(null).kind).toBe('hold')
  })

  test('cost: fees over the horizon under gas + swap + LVR hold with DECIDE_RANGE_BELOW_COST; above re-range', () => {
    const p = lazy()
    const make = (g: bigint) => obs(p, { balances: BALANCED, positions: [position()], pools: [pool(BTC_POOL, TICK + 1500)], guard: market(g) })
    const poor = decide(make(1n), p)
    expect(poor.kind).toBe('hold')
    expect(poor.positions[0]!.codes).toContain('DECIDE_RANGE_BELOW_COST')
    const rich = decide(make(1n << 120n), p)
    expect(rich.kind).toBe('rerange')
  })

  test('a position in range in a pool without its own manage-any grant does not throw', () => {
    const p: PolicyVersion = { ...V2, range: { ...V2.range, lazy: { edgeBufferTicks: 0, minDwellSeconds: 0, horizonSeconds: 86_400, lvrWeightBps: 10_000 } }, session: { ...V2.session, grants: V2.session.grants.filter((g) => !(g.name === 'manage-any' && g.pool === BTC_POOL)) } }
    const o = obs(p, { balances: BALANCED, positions: [position()], pools: [pool(BTC_POOL, TICK)] })
    expect(() => decide(o, p)).not.toThrow()
  })

  test('rerangeWorth: costs are positive, LVR scales with the horizon and its weight, fees with the horizon', () => {
    const p = lazy()
    const o = obs(p, { positions: [position()], pools: [pool(BTC_POOL, TICK + 1500)], guard: market(1n << 100n, 6000) })
    const pos = o.positions[0]!
    const w24 = rerangeWorth(o, p, pos, o.pools[0]!, p.range.lazy!)!
    const w6 = rerangeWorth(o, p, pos, o.pools[0]!, { ...p.range.lazy!, horizonSeconds: 21_600 })!
    const noLvr = rerangeWorth(o, p, pos, o.pools[0]!, { ...p.range.lazy!, lvrWeightBps: 0 })!
    expect(w24.gas).toBeGreaterThan(0n)
    expect(w24.swap).toBeGreaterThan(0n)
    expect(w24.lvr).toBeGreaterThan(0n)
    expect(noLvr.lvr).toBe(0n)
    // Integer rounding aside, a quarter of the horizon is a quarter of the fees and of the LVR.
    expect(Number(w24.lvr) / Number(w6.lvr)).toBeCloseTo(4, 1)
    expect(Number(w24.fees) / Number(w6.fees)).toBeCloseTo(4, 1)
    expect(rerangeWorth(o, p, pos, o.pools[0]!, p.range.lazy!)).toEqual(w24)
    // Missing history: abstain.
    expect(rerangeWorth(obs(p, { positions: [position()] }), p, pos, o.pools[0]!, p.range.lazy!)).toBeNull()
  })
})

const V2 = conservadorLiveV2
const V2_POOLS = [pool(STABLE_POOL, 1), pool(BTC_POOL, -69_080), pool(ETH_POOL, ETH_TICK)]
const vols = (btc: number | null, eth: number | null) => ({ pools: { [BTC_POOL]: { twap24hAgoTick: null, realizedVol24hBps: btc }, [ETH_POOL]: { twap24hAgoTick: null, realizedVol24hBps: eth } } })
const prefs = (b: PolicyVersion['buckets'] | null) => Object.fromEntries((b ?? []).map((x) => [x.id, x.preference]))

describe('volatility-targeted weights (#101 experiment 6)', () => {
  const vt: PolicyVersion = { ...V2, volTarget: { targetVolBps: 4500, bandBps: 2500, stepBps: 2500 } }
  const empty = (guard: Observation['guard']) => obs(vt, { balances: { USDC: 1000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n }, pools: V2_POOLS, guard })

  test('absent: no targets, and the decision is the one of today', () => {
    expect(weightTargets(empty(vols(9000, 9000)), V2)).toBeNull()
    const d = decide(empty(vols(9000, 9000)), V2)
    expect(d.targets).toBeUndefined()
  })

  test('vol at the target keeps the preferences; twice the target halves them on the grid; stables take the rest', () => {
    expect(prefs(weightTargets(empty(vols(4500, 4000)), vt))).toEqual({ stables: 5000, 'btc-usdc': 4000, risk: 1000 })
    // 90%: the scale 0.5 lies in [0.4, 0.625].
    expect(prefs(weightTargets(empty(vols(9000, 9000)), vt))).toEqual({ stables: 7500, 'btc-usdc': 2000, risk: 500 })
    // 180%: 0.25 lies in [0.2, 0.3125].
    expect(prefs(weightTargets(empty(vols(18000, 4500)), vt))).toEqual({ stables: 8000, 'btc-usdc': 1000, risk: 1000 })
  })

  test('missing volatility: that bucket keeps its preference', () => {
    expect(prefs(weightTargets(empty(vols(null, 9000)), vt))).toEqual({ stables: 5500, 'btc-usdc': 4000, risk: 500 })
  })

  test('the decision reports the targets and still names the policy as given', () => {
    const d = decide(empty(vols(9000, 9000)), vt)
    expect(d.targets).toEqual([{ bucket: 'stables', preference: 7500 }, { bucket: 'btc-usdc', preference: 2000 }, { bucket: 'risk', preference: 500 }])
    expect(d.policyRef.policyId).toBe(V2.policyId)
    expect(d.policyRef.hash).toBe(decide(empty(vols(9000, 9000)), vt).policyRef.hash)
  })

  test('levelOf: nearest grid level to the holdings inside the band, the middle of the band otherwise', () => {
    const S = 1_000_000
    expect(levelOf(0.4 * S, 0.9 * S, 0.8 * S, 0.25 * S)).toBe(0.75 * S)
    expect(levelOf(0.4 * S, 0.9 * S, 0.45 * S, 0.25 * S)).toBe(0.5 * S)
    // Holdings drift between two levels inside the band: the nearer one, so a small price move keeps the target.
    expect(levelOf(0.4 * S, 0.9 * S, 0.74 * S, 0.25 * S)).toBe(0.75 * S)
    expect(levelOf(0.55 * S, 0.7 * S, 0.1 * S, 0.5 * S)).toBe(0.5 * S)
    expect(levelOf(0.8 * S, S, 0, 0.25 * S)).toBe(S)
  })
})

describe('CPPI weights (#101 experiment 6)', () => {
  const cppi = (floorBps: number, multiplier: number): PolicyVersion => ({ ...V2, cppi: { floorBps, multiplier } })
  const at = (p: PolicyVersion, peak?: bigint) => obs(p, { balances: { USDC: 1000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n }, pools: V2_POOLS, guard: { pools: {}, ...(peak !== undefined ? { peakValue: peak } : {}) } })

  test('at the peak: volatile share = min(preference, m x cushion)', () => {
    // Floor 90%, m 3: 30% of the account may be volatile, of the 50% preferred: scale 0.6.
    expect(prefs(weightTargets(at(cppi(9000, 3)), cppi(9000, 3)))).toEqual({ stables: 7000, 'btc-usdc': 2400, risk: 600 })
    // Floor 85%, m 5: 75% allowed, capped at the preferences.
    expect(prefs(weightTargets(at(cppi(8500, 5)), cppi(8500, 5)))).toEqual({ stables: 5000, 'btc-usdc': 4000, risk: 1000 })
  })

  test('under the peak the cushion shrinks; at or under the floor nothing is volatile', () => {
    // Value 1000, peak 1050: floor 945, cushion 55, room 165 of the 500 preferred: scale 0.33.
    expect(prefs(weightTargets(at(cppi(9000, 3), 1050n * USDC), cppi(9000, 3)))).toEqual({ stables: 8350, 'btc-usdc': 1320, risk: 330 })
    expect(prefs(weightTargets(at(cppi(9000, 3), 1200n * USDC), cppi(9000, 3)))).toEqual({ stables: 10000, 'btc-usdc': 0, risk: 0 })
  })

  test('with a volatility target too, each bucket takes the smaller scale', () => {
    const both: PolicyVersion = { ...V2, cppi: { floorBps: 9000, multiplier: 3 }, volTarget: { targetVolBps: 4500, bandBps: 2500, stepBps: 2500 } }
    const o = obs(both, { balances: { USDC: 1000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n }, pools: V2_POOLS, guard: vols(18000, 4500) })
    expect(prefs(weightTargets(o, both))).toEqual({ stables: 8400, 'btc-usdc': 1000, risk: 600 })
  })
})

describe('lazy re-range from the engine settings (otto/mamoru#172)', () => {
  // The knob's overlay, as `withEngineSettings` builds it from the template `conservador-live-v2 + lazy-h24h-b100-d30`.
  const LAZY_V2: PolicyVersion = { ...V2, range: { ...V2.range, lazy: { edgeBufferTicks: 100, minDwellSeconds: 1800, horizonSeconds: 86_400, lvrWeightBps: 10_000 } } }
  // c23e94e1, 17 Oct: NFT 6148685 on WETH/USDC 0.3% [-198180, -196200], the pool below it (all WETH).
  const nft = position({ tokenId: 6_148_685n, pool: ETH_POOL, tickLower: -198_180, tickUpper: -196_200, liquidity: 10n ** 15n, managed: true })
  const below = -198_600
  const ethMarket = (growth: bigint) => ({ pools: { [ETH_POOL]: { twap24hAgoTick: below, realizedVol24hBps: 4000, feeGrowth24h: { growth0X128: growth, growth1X128: growth, seconds: 86_400 } } } })
  const at = (p: PolicyVersion, t: bigint, guard?: Observation['guard']) =>
    obs(p, { block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: t }, positions: [nft], pools: [pool(STABLE_POOL, 1), pool(BTC_POOL, -69_080), pool(ETH_POOL, below)], ...(guard ? { guard } : {}) })
  // Inside the fixture sessions' validity (validUntil 10,000,000).
  const T0 = 1_000_000n

  test('eager (today): the first review with a session re-ranges the out-of-range position at once', () => {
    const d = decide(at(V2, T0), V2)
    expect(d.kind).toBe('rerange')
  })

  test('lazy: the review that regains the session holds; after the dwell, only a re-range that pays goes through', () => {
    // The engine just started: it has never seen this position, so its out-of-range clock starts now.
    const first = at(LAZY_V2, T0, ethMarket(1n << 120n))
    const since0 = outOfRangeSinceOf(new Map(), first)
    expect(since0.get(nft.tokenId)).toBe(T0)
    const d0 = decide(withOutOfRangeSince(first, since0), LAZY_V2)
    expect(d0.kind).not.toBe('rerange')
    expect(d0.positions.find((p) => p.tokenId === nft.tokenId)!.codes).toContain('DECIDE_RANGE_COOLDOWN')
    // 29 minutes later: still inside the dwell.
    const early = at(LAZY_V2, T0 + 1740n, ethMarket(1n << 120n))
    expect(decide(withOutOfRangeSince(early, outOfRangeSinceOf(since0, early)), LAZY_V2).kind).not.toBe('rerange')
    // Past the dwell: the cost test decides. Fees that do not cover gas + swap + LVR hold with DECIDE_RANGE_BELOW_COST.
    const poor = at(LAZY_V2, T0 + 1800n, ethMarket(1n))
    const dp = decide(withOutOfRangeSince(poor, outOfRangeSinceOf(since0, poor)), LAZY_V2)
    expect(dp.kind).not.toBe('rerange')
    expect(dp.positions.find((p) => p.tokenId === nft.tokenId)!.codes).toContain('DECIDE_RANGE_BELOW_COST')
    const rich = at(LAZY_V2, T0 + 1800n, ethMarket(1n << 120n))
    const dr = decide(withOutOfRangeSince(rich, outOfRangeSinceOf(since0, rich)), LAZY_V2)
    expect(dr.kind).toBe('rerange')
    expect(dr.proposal).toMatchObject({ kind: 'rerange', tokenId: nft.tokenId, pool: ETH_POOL })
  })

  test('out-of-range clock: kept while out, cleared when the price comes back, dropped with the position', () => {
    const out = at(LAZY_V2, T0)
    const s1 = outOfRangeSinceOf(new Map(), out)
    const later = at(LAZY_V2, T0 + 600n)
    expect(outOfRangeSinceOf(s1, later).get(nft.tokenId)).toBe(T0)
    const back = obs(LAZY_V2, { block: { number: 101n, hash: `0x${'11'.repeat(32)}`, timestamp: T0 + 1200n }, positions: [nft], pools: [pool(ETH_POOL, -197_000)] })
    const s2 = outOfRangeSinceOf(s1, back)
    expect(s2.has(nft.tokenId)).toBe(false)
    expect(withOutOfRangeSince(back, s2).positions[0]!.outOfRangeSince).toBeNull()
    expect(outOfRangeSinceOf(s1, obs(LAZY_V2, { positions: [], pools: [pool(ETH_POOL, below)] })).size).toBe(0)
    expect(outOfRangeSinceOf(new Map(), at(LAZY_V2, T0)).size).toBe(1)
    expect(outOfRangeSinceOf(new Map(), obs(LAZY_V2, { positions: [{ ...nft, liquidity: 0n }], pools: [pool(ETH_POOL, below)] })).size).toBe(0)
  })
})
