import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, grantKey, type DepegGuard, type PolicyVersion, type StagedExit } from '@mamoru/policy'
import { baseRegistry, address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, fallFromBps, pegDeviationBps, pegStep, PEG_CLEAR, stageStep, thirdsOut, weightTargets, type Observation, type PoolObs, type PegState, type PositionObs, type StageState } from '../index.ts'

// Lab #101 round 3: stables depeg guard and staged exits. Both off unless the policy sets them.

const USDC = 1_000_000n
const BTC_POOL = 'pool:USDC/cbBTC/500'
const ETH_POOL = 'pool:WETH/USDC/3000'
const STABLE_POOL = 'pool:USDC/USDT/100'
const ETH_TICK = -193_380
const V2 = conservadorLiveV2

function pool(name: string, tick: number): PoolObs {
  const e = entry(name, baseRegistry)
  return {
    name, address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!, tickSpacing: e.tickSpacing!,
    sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick, twapLiquidity: 10n ** 18n,
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
    balances: { USDC: 1000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: [pool(STABLE_POOL, 0), pool(BTC_POOL, -69_080), pool(ETH_POOL, ETH_TICK)],
    ethPrice: { pool: ETH_POOL, sqrtPriceX96: sqrtRatioAtTick(ETH_TICK), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

const RULE: DepegGuard = { thresholdBps: 50, holdSeconds: 1800, action: 'freeze', releaseBps: 20, releaseSeconds: 72 * 3600, exitImpactBps: 20 }
const guarded = (action: DepegGuard['action'] = 'freeze'): PolicyVersion => ({ ...V2, depegGuard: { ...RULE, action } })
const tripped = (deviationBps = 90): Observation['guard'] => ({ pools: {}, peg: { tripped: true, deviationBps } })
/** A 40-tick stables range around parity, left behind by a depeg to tick 90. */
const stablePos = (over: Partial<PositionObs> = {}): PositionObs => ({ tokenId: 3n, pool: STABLE_POOL, tickLower: -20, tickUpper: 20, liquidity: 10n ** 14n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true, ...over })
const depegPools = () => [pool(STABLE_POOL, 90), pool(BTC_POOL, -69_080), pool(ETH_POOL, ETH_TICK)]

describe('depeg guard state (pegStep)', () => {
  test('deviation from 1.0 in bps, either side', () => {
    expect(pegDeviationBps(0)).toBe(0)
    expect(pegDeviationBps(84)).toBe(84)
    expect(pegDeviationBps(-84)).toBe(84)
  })

  test('trips after the hold without a break; a break restarts the clock; missing data holds the state', () => {
    let s = pegStep(PEG_CLEAR, 0, 60, RULE)
    expect(s).toEqual({ tripped: false, beyondSince: 0, withinSince: null })
    s = pegStep(s, 1200, 55, RULE)
    expect(s.tripped).toBe(false)
    expect(pegStep(pegStep(s, 1500, 40, RULE), 1800, 60, RULE).tripped).toBe(false)
    expect(pegStep(s, 1800, null, RULE)).toEqual(s)
    s = pegStep(s, 1800, 70, RULE)
    expect(s.tripped).toBe(true)
  })

  test('releases only after the deviation stayed under the release level for the release time', () => {
    let s: PegState = { tripped: true, beyondSince: null, withinSince: null }
    s = pegStep(s, 0, 10, RULE)
    expect(s).toEqual({ tripped: true, beyondSince: null, withinSince: 0 })
    expect(pegStep(s, 72 * 3600 - 1, 10, RULE).tripped).toBe(true)
    // Between release and threshold: neither within nor beyond; the clock restarts.
    expect(pegStep(pegStep(s, 3600, 30, RULE), 72 * 3600, 10, RULE).tripped).toBe(true)
    expect(pegStep(s, 72 * 3600, 10, RULE).tripped).toBe(false)
  })
})

describe('depeg guard in decide (#101 round 3)', () => {
  test('absent, or set and not tripped: the same proposal as the live policy', () => {
    const o = obs(V2, { positions: [stablePos()], pools: depegPools() })
    const live = decide(o, V2)
    expect(live.kind).toBe('rerange')
    const d = decide({ ...o, guard: { pools: {}, peg: { tripped: false, deviationBps: 90 } } }, guarded())
    expect(d.proposal).toEqual(live.proposal)
    expect(d.labGuards).toBeUndefined()
  })

  test('freeze: the out-of-range stables position is not re-ranged and nothing else moves in that pool', () => {
    const d = decide(obs(V2, { positions: [stablePos()], pools: depegPools(), guard: tripped(), balances: { USDC: 0n, USDT: 0n, cbBTC: 0n, WETH: 0n } }), guarded())
    expect(d.kind).toBe('hold')
    expect(d.reason).toBe('RISK_DEPEG_PAIRED')
    expect(d.positions[0]!.codes).toContain('RISK_DEPEG_PAIRED')
    expect(d.labGuards).toEqual([{ bucket: 'stables', code: 'RISK_DEPEG_PAIRED', value: 90 }])
  })

  test('freeze: no entry to stables; the next bucket gets the savings', () => {
    const live = decide(obs(V2, { pools: depegPools() }), V2)
    expect(live.proposal?.pool).toBe(STABLE_POOL)
    const d = decide(obs(V2, { pools: depegPools(), guard: tripped() }), guarded())
    expect(d.proposal).not.toBeNull()
    expect(d.proposal!.pool).not.toBe(STABLE_POOL)
    expect(d.buckets.find((b) => b.bucket === 'stables')!.code).toBe('RISK_DEPEG_PAIRED')
  })

  test('freeze: idle USDT is not sold back while tripped', () => {
    const p = guarded()
    const o = obs(V2, { positions: [stablePos({ tickLower: 80, tickUpper: 120 })], pools: depegPools(), guard: tripped(), balances: { USDC: 0n, USDT: 400n * USDC, cbBTC: 0n, WETH: 0n } })
    const d = decide(o, p)
    expect(d.proposal?.pool === STABLE_POOL).toBe(false)
  })

  test('exit: closes the stables position first, then sells USDT within the impact limit', () => {
    const p = guarded('exit')
    const d = decide(obs(V2, { positions: [stablePos()], pools: depegPools(), guard: tripped() }), p)
    expect(d.proposal).toMatchObject({ kind: 'reduce', pool: STABLE_POOL, tokenId: 3n, liquidity: 10n ** 14n })
    const thin = depegPools().map((x) => (x.name === STABLE_POOL ? { ...x, liquidity: 10n ** 13n, twapLiquidity: 10n ** 13n } : x))
    const s = decide(obs(V2, { pools: thin, guard: tripped(), balances: { USDC: 0n, USDT: 500n * USDC, cbBTC: 0n, WETH: 0n } }), p)
    expect(s.proposal).toMatchObject({ kind: 'enter_swap', pool: STABLE_POOL, tokenIn: 'USDT', tokenOut: 'USDC' })
    // 20 bps of impact, half of it for sizing, against L = 1e13 at parity: about 1e13 * 0.001 = 1e10 raw = 10,000 USDT is
    // more than held, so it sells all; on a thinner pool the sale is capped.
    expect((s.proposal as { amountIn: bigint }).amountIn).toBe(500n * USDC)
    const thinner = thin.map((x) => (x.name === STABLE_POOL ? { ...x, liquidity: 10n ** 11n, twapLiquidity: 10n ** 11n } : x))
    const c = decide(obs(V2, { pools: thinner, guard: tripped(), balances: { USDC: 0n, USDT: 500n * USDC, cbBTC: 0n, WETH: 0n } }), p)
    const amountIn = (c.proposal as { amountIn: bigint }).amountIn
    expect(amountIn).toBeGreaterThan(0n)
    expect(amountIn).toBeLessThan(500n * USDC)
  })
})

const STAGES: StagedExit = { step1Bps: 300, step2Bps: 600, step3Bps: 1000, reentry: 'ema', ladderGapBps: 1000 }
/** Up ticks: a fall of b bps from `high` is high + ln(1 - b/1e4) / ln(1.0001). */
const down = (high: number, bps: number) => Math.round(high + Math.log(1 - bps / 10_000) / Math.log(1.0001))

describe('staged exits (stageStep)', () => {
  const H = 100_000
  const step = (s: StageState | undefined, now: number, price: number, ema: number | null = null, rule = STAGES) => stageStep(s, { now, price, high7d: H, ema }, rule)

  test('fall from the high in bps', () => {
    expect(fallFromBps(H, H + 5)).toBe(0)
    expect(fallFromBps(H, down(H, 300))).toBe(300)
  })

  test('steps fire in order, a gap fires several at once, each once', () => {
    let s = step(undefined, 0, H)
    expect(thirdsOut(s)).toBe(0)
    s = step(s, 600, down(H, 299))
    expect(thirdsOut(s)).toBe(0)
    s = step(s, 1200, down(H, 310))
    expect(thirdsOut(s)).toBe(1)
    s = step(s, 1800, down(H, 1100))
    expect(thirdsOut(s)).toBe(3)
    expect(thirdsOut(step(s, 2400, down(H, 2000)))).toBe(3)
  })

  test('ema re-entry: all thirds back once the TWAP, having been under its EMA, crosses over it; no re-sale at once', () => {
    let s = step(undefined, 0, H)
    s = step(s, 600, down(H, 700), H)
    expect(thirdsOut(s)).toBe(2)
    expect(s.belowEma).toBe(true)
    s = step(s, 1200, down(H, 500), down(H, 600))
    expect(thirdsOut(s)).toBe(0)
    // The high is re-anchored: still 5% under the old high, but not under the new one.
    s = step(s, 1800, down(H, 520), down(H, 600))
    expect(thirdsOut(s)).toBe(0)
  })

  test('ladder re-entry: each third comes back ladderGap under the price it was sold at; all of them near the high', () => {
    const lad = { ...STAGES, reentry: 'ladder' as const }
    let s = step(undefined, 0, H, null, lad)
    s = step(s, 600, down(H, 650), null, lad)
    expect(thirdsOut(s)).toBe(2)
    s = step(s, 1200, down(H, 1050), null, lad)
    expect(thirdsOut(s)).toBe(3)
    // Two thirds sold at -6.5% come back at about -15.85%; the last, sold at -10.5%, at about -19.45%.
    s = step(s, 1800, down(H, 1600), null, lad)
    expect(thirdsOut(s)).toBe(1)
    s = step(s, 2400, down(H, 1900), null, lad)
    expect(thirdsOut(s)).toBe(1)
    s = step(s, 3000, down(H, 1960), null, lad)
    expect(thirdsOut(s)).toBe(0)
    // A bounce: nothing is sold again until the re-anchor; back within 3% of the high resets.
    s = step(s, 3600, down(H, 700), null, lad)
    expect(thirdsOut(s)).toBe(0)
    s = step(s, 4200, down(H, 200), null, lad)
    expect(s.sold).toEqual([])
  })
})

describe('staged exits in decide (#101 round 3)', () => {
  const staged: PolicyVersion = { ...V2, stagedExit: STAGES }
  const prefs = (b: PolicyVersion['buckets'] | null) => Object.fromEntries((b ?? []).map((x) => [x.id, x.preference]))

  test('a third out cuts the bucket by a third; stables take it; none out keeps the preferences', () => {
    expect(prefs(weightTargets(obs(staged), staged))).toEqual({ stables: 5000, 'btc-usdc': 4000, risk: 1000 })
    const o = obs(staged, { guard: { pools: {}, stages: { 'btc-usdc': 1, risk: 3 } } })
    expect(prefs(weightTargets(o, staged))).toEqual({ stables: 7334, 'btc-usdc': 2666, risk: 0 })
    expect(decide(o, staged).labGuards).toEqual([{ bucket: 'btc-usdc', code: 'RISK_STAGED_EXIT', value: 1 }, { bucket: 'risk', code: 'RISK_STAGED_EXIT', value: 3 }])
  })

  test('the risk bucket a third over its new target is reduced (inside the 5-point live band, outside the 1-point staged one)', () => {
    // 10% of 1000 in WETH/USDC as a centred position; stables and btc at target as idle savings in the account.
    const eth = pool(ETH_POOL, ETH_TICK)
    const liquidity = 15_900_000_000_000n // about 100 USDC
    const pos: PositionObs = { tokenId: 9n, pool: ETH_POOL, tickLower: ETH_TICK - 1020, tickUpper: ETH_TICK + 1020, liquidity, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
    const base = obs(staged, { positions: [pos], pools: [pool(STABLE_POOL, 0), pool(BTC_POOL, -69_080), eth], balances: { USDC: 900n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n } })
    const none = decide({ ...base, guard: { pools: {}, stages: { risk: 0 } } }, staged)
    expect(none.proposal?.kind === 'reduce').toBe(false)
    const one = decide({ ...base, guard: { pools: {}, stages: { risk: 1 } } }, staged)
    expect(one.proposal).toMatchObject({ kind: 'reduce', pool: ETH_POOL, tokenId: 9n })
  })
})
