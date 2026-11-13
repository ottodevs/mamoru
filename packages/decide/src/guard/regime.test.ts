import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, grantKey, type PolicyVersion, type RegimeShift } from '@mamoru/policy'
import { baseRegistry, address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, regimeStep, REGIME_NORMAL, weightTargets, type Observation, type PoolObs, type PositionObs, type RegimeInput, type RegimeState } from '../index.ts'

// otto/mamoru#409: regime shift of the risk bucket. Off unless the policy sets `regimeShift`.

const USDC = 1_000_000n
const DAY = 86_400
const ETH_POOL = 'pool:WETH/USDC/3000'
const STABLE_POOL = 'pool:USDC/USDT/100'
const ETH_TICK = -193_380
const RULE: RegimeShift = { fall7dBps: 1000, fall24hBps: 400, belowMeanBps: 0, defensivePreference: 1500, exitOnMean: true, exitNoLowSeconds: 3 * DAY, minDwellSeconds: DAY }
/** Up ticks `bps` below `up`. */
const down = (up: number, bps: number) => Math.round(up + Math.log(1 - bps / 10_000) / Math.log(1.0001))
const H = 100_000
const at = (now: number, price: number, ago24h: number | null, ago7d: number | null, mean7d: number | null): RegimeInput => ({ now, price, ago24h, ago7d, mean7d })

describe('regime state (regimeStep)', () => {
  test('enters only with both the 7-day and the 24-hour fall; missing history never enters', () => {
    const p = down(H, 1200)
    expect(regimeStep(undefined, at(0, p, down(H, 700), H, H), RULE)).toEqual({ defensive: true, since: 0, low: p, lowAt: 0 })
    // 24 h fall too small (3%), 7-day fall too small (9%), either side missing.
    expect(regimeStep(undefined, at(0, p, down(H, 900), H, H), RULE).defensive).toBe(false)
    expect(regimeStep(undefined, at(0, p, down(H, 700), down(H, 300), H), RULE).defensive).toBe(false)
    expect(regimeStep(undefined, at(0, p, null, H, H), RULE).defensive).toBe(false)
    expect(regimeStep(undefined, at(0, p, down(H, 700), null, H), RULE).defensive).toBe(false)
  })

  test('the gap under the 7-day mean replaces the 7-day fall when belowMeanBps is set', () => {
    const rule = { ...RULE, belowMeanBps: 800 }
    const p = down(H, 1000)
    // 7-day fall 0 but 10% under the mean: enters; 5% under the mean: does not.
    expect(regimeStep(undefined, at(0, p, down(H, 500), p, H), rule).defensive).toBe(true)
    expect(regimeStep(undefined, at(0, p, down(H, 500), p, down(H, 500)), rule).defensive).toBe(false)
  })

  test('leaves on a recovery over the 7-day mean, not before the minimum time in the state', () => {
    let s: RegimeState = regimeStep(undefined, at(0, down(H, 1200), down(H, 700), H, H), RULE)
    s = regimeStep(s, at(DAY - 1, H + 10, null, null, H), RULE)
    expect(s.defensive).toBe(true)
    s = regimeStep(s, at(DAY, H + 10, null, null, H), RULE)
    expect(s).toEqual({ defensive: false, since: DAY, low: 0, lowAt: 0 })
    // And cannot re-enter within the minimum time either, whatever the market says.
    expect(regimeStep(s, at(2 * DAY - 1, down(H, 2000), down(H, 900), H, H), RULE).defensive).toBe(false)
    expect(regimeStep(s, at(2 * DAY, down(H, 2000), down(H, 900), H, H), RULE).defensive).toBe(true)
  })

  test('leaves after the quiet spell with no new low; a new low restarts it', () => {
    const p = down(H, 1200)
    let s = regimeStep(undefined, at(0, p, down(H, 700), H, H), RULE)
    s = regimeStep(s, at(2 * DAY, p - 50, null, null, null), RULE)
    expect(s).toMatchObject({ defensive: true, low: p - 50, lowAt: 2 * DAY })
    expect(regimeStep(s, at(5 * DAY - 1, p, null, null, null), RULE).defensive).toBe(true)
    expect(regimeStep(s, at(5 * DAY, p, null, null, null), RULE).defensive).toBe(false)
    // exitOnMean off: back over the mean is not enough.
    const noMean = { ...RULE, exitOnMean: false }
    expect(regimeStep(s, at(3 * DAY, H + 10, null, null, H), noMean).defensive).toBe(true)
  })

  test('the normal state is the zero state', () => {
    expect(REGIME_NORMAL).toEqual({ defensive: false, since: 0, low: 0, lowAt: 0 })
  })
})

function pool(name: string, tick: number): PoolObs {
  const e = entry(name, baseRegistry)
  return {
    name, address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!, tickSpacing: e.tickSpacing!,
    sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick, twapLiquidity: 10n ** 18n,
    identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}

/** v7-like: stables 65% (the stand-in for the vault share) and WETH/USDC 35%. */
const V7LIKE: PolicyVersion = { ...conservadorLiveV2, buckets: [{ id: 'stables', preference: 6500, pools: [STABLE_POOL] }, { id: 'risk', preference: 3500, pools: [ETH_POOL] }] }
const SHIFT: PolicyVersion = { ...V7LIKE, regimeShift: RULE }

function obs(policy: PolicyVersion, over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 100_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: policy.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000_000, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 650n * USDC, USDT: 0n, WETH: 0n },
    positions: [],
    pools: [pool(STABLE_POOL, 0), pool(ETH_POOL, ETH_TICK)],
    ethPrice: { pool: ETH_POOL, sqrtPriceX96: sqrtRatioAtTick(ETH_TICK), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

describe('regime shift in decide (#409)', () => {
  const prefs = (b: PolicyVersion['buckets'] | null) => Object.fromEntries((b ?? []).map((x) => [x.id, x.preference]))
  // About 350 USDC in a centred WETH/USDC position, 650 USDC idle: the 65/35 account at its weights.
  const pos: PositionObs = { tokenId: 9n, pool: ETH_POOL, tickLower: ETH_TICK - 1020, tickUpper: ETH_TICK + 1020, liquidity: 55_650_000_000_000n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
  const defensive: Observation['guard'] = { pools: {}, regime: { risk: true } }

  test('defensive lowers the risk preference to the rule and gives the rest to stables; otherwise the preferences hold', () => {
    expect(prefs(weightTargets(obs(SHIFT), SHIFT))).toEqual({ stables: 6500, risk: 3500 })
    expect(prefs(weightTargets(obs(SHIFT, { guard: defensive }), SHIFT))).toEqual({ stables: 8500, risk: 1500 })
    expect(prefs(weightTargets(obs({ ...V7LIKE, regimeShift: { ...RULE, defensivePreference: 0 } }, { guard: defensive }), { ...V7LIKE, regimeShift: { ...RULE, defensivePreference: 0 } }))).toEqual({ stables: 10_000, risk: 0 })
    // Never above the bucket's own preference.
    expect(prefs(weightTargets(obs(SHIFT, { guard: defensive }), { ...SHIFT, regimeShift: { ...RULE, defensivePreference: 5000 } }))).toEqual({ stables: 6500, risk: 3500 })
  })

  test('a held risk position over its defensive target is reduced through the ordinary reduce', () => {
    const base = obs(SHIFT, { positions: [pos] })
    expect(decide(base, SHIFT).proposal?.kind === 'reduce').toBe(false)
    const d = decide({ ...base, guard: defensive }, SHIFT)
    expect(d.proposal).toMatchObject({ kind: 'reduce', pool: ETH_POOL, tokenId: 9n })
    expect(d.targets).toEqual([{ bucket: 'stables', preference: 8500 }, { bucket: 'risk', preference: 1500 }])
  })

  test('without the rule a defensive flag changes nothing: same decision, byte for byte', () => {
    const base = obs(V7LIKE, { positions: [pos] })
    expect(weightTargets({ ...base, guard: defensive }, V7LIKE)).toBeNull()
    expect(decide({ ...base, guard: defensive }, V7LIKE)).toEqual(decide({ ...base, guard: { pools: {} } }, V7LIKE))
    expect(decide({ ...base, guard: defensive }, conservadorLiveV2)).toEqual(decide(base, conservadorLiveV2))
  })
})
