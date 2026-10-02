import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, policyHash } from '@mamoru/policy'
import { entry } from '@mamoru/registry'
import { sqrtRatioAtTick, token0InToken1 } from '@mamoru/uniswap-v3/quote'
import { decodeDataset, encodeDataset } from './dataset.ts'
import { POOLS, syntheticDataset } from './fixtures.ts'
import { twapTick } from './observe.ts'
import { runBacktest } from './run.ts'
import type { PoolSample } from './types.ts'
import { accrue, accrued, swapOut, type SimPosition } from './world.ts'

const USDC = 1_000_000n
const Q128 = 1n << 128n
/** A replay is CPU bound: on a busy machine a run can take several times its usual second. */
const SLOW = 60_000
const DEPOSIT = 1_000n * USDC
/** Fee growth per sample sized so the three positions of a 1,000 USDC account earn about a cent each per hour. */
const GROWTH = [1n << 103n, 1n << 104n, 1n << 96n] as const

function sample(over: Partial<PoolSample> = {}): PoolSample {
  return { sqrtPriceX96: sqrtRatioAtTick(0), tick: 0, liquidity: 1_000_000n, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n, tickCumulative: 0n, ...over }
}

function position(over: Partial<SimPosition> = {}): SimPosition {
  return { tokenId: 1n, pool: POOLS[0], tickLower: -100, tickUpper: 100, liquidity: 1_000_000n, owed0: 0n, owed1: 0n, ...over }
}

describe('fee accrual', () => {
  const a = sample()
  const b = sample({ feeGrowthGlobal0X128: 4n * Q128, feeGrowthGlobal1X128: 10n * Q128 })

  test('in range at both ends: the position takes its share of the growth, diluted by itself', () => {
    // Same liquidity as the pool: half of what the pool paid per unit.
    expect(accrued(position(), a, b)).toEqual({ fees0: 2_000_000n, fees1: 5_000_000n })
    // A position that is a thousandth of the pool barely dilutes: almost the full growth per unit.
    expect(accrued(position({ liquidity: 1_000n }), a, b)).toEqual({ fees0: 3_996n, fees1: 9_990n })
  })

  test('in range at one end earns half, at neither end nothing', () => {
    expect(accrued(position(), a, { ...b, tick: 100 })).toEqual({ fees0: 1_000_000n, fees1: 2_500_000n })
    expect(accrued(position(), { ...a, tick: -101 }, { ...b, tick: 100 })).toEqual({ fees0: 0n, fees1: 0n })
  })

  test('fractions of a unit carry over, so a small position earns what the sum of its intervals is worth', () => {
    // A third of a raw unit per interval: nothing in any single one, one unit every three.
    const p = position({ liquidity: 1n })
    const big = sample({ liquidity: 10n ** 30n })
    const step = Q128 / 3n
    let last = big
    let earned = 0n
    for (let i = 1; i <= 9; i++) {
      const next = { ...big, feeGrowthGlobal0X128: step * BigInt(i) }
      expect(accrued(p, last, next).fees0).toBe(0n)
      earned += accrue(p, last, next).fees0
      last = next
    }
    expect(earned).toBe(2n)
    expect(p.owed0).toBe(2n)
  })

  test('the counters wrap like the chain uint256', () => {
    const top = (1n << 256n) - Q128
    expect(accrued(position(), sample({ feeGrowthGlobal0X128: top }), sample({ feeGrowthGlobal0X128: Q128 }))).toEqual({ fees0: 1_000_000n, fees1: 0n })
  })
})

describe('swap model', () => {
  const e = entry('pool:USDC/cbBTC/500')
  const s = sample({ sqrtPriceX96: sqrtRatioAtTick(-67_420), tick: -67_420, liquidity: 2_225_251_034_900n })

  test('a small swap pays the pool fee and almost no impact', () => {
    const out = swapOut(e, s, 'USDC', 100n * USDC)
    const spot = token0InToken1(100n * USDC, s.sqrtPriceX96)
    expect(out).toBeLessThan(spot)
    // 0.05% fee; impact stays under one basis point at this size.
    expect((spot - out) * 10_000n / spot).toBeLessThanOrEqual(5n)
  })

  test('the output matches the pool arithmetic for one range, to the unit', () => {
    // SwapMath for an exact input inside one range, written out with its own rounding: fee off the input, next
    // price rounded up for token0 in and down for token1 in, output rounded down.
    const Q96 = 1n << 96n
    const L = s.liquidity
    const sp = s.sqrtPriceX96
    const net0 = (250n * USDC * 999_500n) / 1_000_000n
    const den = (L << 96n) + net0 * sp
    const next0 = ((L << 96n) * sp + den - 1n) / den
    expect(swapOut(e, s, 'USDC', 250n * USDC)).toBe((L * (sp - next0)) / Q96)
    const btc = 250_000n
    const net1 = (btc * 999_500n) / 1_000_000n
    const next1 = sp + (net1 * Q96) / L
    expect(swapOut(e, s, 'cbBTC', btc)).toBe(((L << 96n) * (next1 - sp)) / next1 / sp)
    expect(swapOut(e, s, 'USDC', 0n)).toBe(0n)
  })

  test('a large swap moves the price against itself, in both directions', () => {
    const big = swapOut(e, s, 'USDC', 1_000_000n * USDC)
    const small = swapOut(e, s, 'USDC', 1_000n * USDC)
    expect(big * 1_000n).toBeLessThan(small * 1_000_000n)
    const back = swapOut(e, s, 'cbBTC', small)
    expect(back).toBeLessThan(1_000n * USDC)
    expect(back).toBeGreaterThan(998n * USDC)
  })
})

describe('dataset', () => {
  test('round trips through its file form and refuses changed content', () => {
    const ds = syntheticDataset({ samples: 5, growth: [3n, 5n, 7n] })
    const file = JSON.parse(JSON.stringify(encodeDataset(ds)))
    expect(decodeDataset(file)).toEqual(ds)
    file.samples[2].p[1][1] += 1
    expect(() => decodeDataset(file)).toThrow(/hashes to/)
  })

  test('the TWAP is the mean tick over the policy window', () => {
    const ds = syntheticDataset({ samples: 20, tick: (_k, i) => (i < 10 ? 0 : 100) })
    expect(twapTick(ds, 1, 5, 1800)).toBe(-67_420)
    // Six samples back covers 1800 s: three flat, three at +100 after the jump at sample 10.
    expect(twapTick(ds, 1, 12, 1800)).toBe(-67_420 + 50)
    expect(twapTick(ds, 1, 19, 1800)).toBe(-67_420 + 100)
  })

  test('a mean tick that is not whole rounds toward negative infinity, as the pool oracle does', () => {
    // Stable pool at tick 9, then one sample at 8 inside a 1800 s window: mean 8.83, and -0.17 when shifted below zero.
    const up = syntheticDataset({ samples: 20, tick: (_k, i) => (i === 12 ? -1 : 0) })
    expect(twapTick(up, 0, 14, 1800)).toBe(8)
    const down = syntheticDataset({ samples: 20, tick: (_k, i) => (i === 12 ? -10 : -9) })
    expect(twapTick(down, 0, 14, 1800)).toBe(-1)
  })
})

describe('run', () => {
  test('a flat market: the live policy enters its three buckets and keeps the deposit', () => {
    const r = runBacktest(syntheticDataset({ samples: 60 }), conservadorLiveV2, { deposit: DEPOSIT })
    expect(r.policyHash).toBe(policyHash(conservadorLiveV2))
    expect(r.metrics.operations.enter_mint).toBe(3)
    expect(r.metrics.operations.enter_swap).toBe(3)
    expect(r.metrics.operations.rerange).toBe(0)
    expect(r.metrics.discarded).toBe(0)
    expect(r.metrics.timeInRangeBps).toBe(10_000)
    // No fees and no price move: the cost is swap fees and gas, under 0.2% of the deposit.
    expect(r.metrics.fees).toBe(0n)
    expect(r.metrics.net).toBeLessThan(0n)
    expect(-r.metrics.net).toBeLessThan(DEPOSIT / 500n)
    expect(r.reasons.DECIDE_IN_RANGE).toBeGreaterThan(40)
    expect(r.series.value).toHaveLength(60)
  }, SLOW)

  test('fee growth is earned, harvested once it beats the cost, and counted', () => {
    const growth = GROWTH
    const flat = runBacktest(syntheticDataset({ samples: 400 }), conservadorLiveV2, { deposit: DEPOSIT })
    const paid = runBacktest(syntheticDataset({ samples: 400, growth }), conservadorLiveV2, { deposit: DEPOSIT })
    expect(paid.metrics.fees).toBeGreaterThan(0n)
    expect(paid.metrics.end).toBeGreaterThan(flat.metrics.end)
    expect(paid.metrics.operations.harvest).toBeGreaterThan(0)
    const harvested = paid.ops.filter((o) => o.kind === 'harvest').reduce((n, o) => n + o.feesValue, 0n)
    expect(harvested).toBeGreaterThan(0n)
    expect(harvested).toBeLessThanOrEqual(paid.metrics.fees)
    for (const s of paid.sessions) expect(s.exhausted).toBe(false)
  }, SLOW)

  test('a strategy that harvests more often than its grant allows is flagged', () => {
    // Fees that clear the bar at every review: more harvests in one session window than the convert-any limit of 64.
    const ds = syntheticDataset({ samples: 300, growth: [1n << 110n, 1n << 126n, 1n << 100n] })
    const r = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, sessions: 'report' })
    const s = r.sessions.find((x) => x.grant === 'convert-any:pool:USDC/USDT/100')!
    expect(s.limit).toBe(64)
    expect(s.peakPerWindow).toBeGreaterThan(64)
    expect(s.exhausted).toBe(true)
    // Enforced, as on chain: the grant stops at its limit and the rest are refused.
    const e = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT })
    expect(e.sessions.find((x) => x.grant === 'convert-any:pool:USDC/USDT/100')).toMatchObject({ peakPerWindow: 64, exhausted: false })
    expect(e.metrics.refused).toBeGreaterThan(0)
    expect(e.reasons.SESSION_USAGE_SPENT).toBe(e.metrics.refused)
  }, SLOW)

  test('a price that walks out of the range is re-ranged after the cooldown, and that costs against holding', () => {
    // cbBTC pool drifts 4 ticks per sample: out of a 2000-tick range in about 250 samples.
    const ds = syntheticDataset({ samples: 700, tick: (k, i) => (k === 1 ? 4 * i : 0) })
    const r = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT })
    expect(r.metrics.operations.rerange).toBeGreaterThan(0)
    expect(r.ops.find((o) => o.kind === 'rerange')).toMatchObject({ pool: 'pool:USDC/cbBTC/500', code: 'DECIDE_RANGE_ADJUST' })
    expect(r.metrics.timeInRangeBps).toBeGreaterThan(9_000)
    // A one-way drift is the textbook loss against holding the entry mix.
    expect(r.metrics.vsHodl).toBeLessThan(0n)
  }, SLOW)

  test('same dataset, policy and config give the same hash; a change in any of them does not', () => {
    const ds = syntheticDataset({ samples: 80, growth: GROWTH })
    const a = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT })
    expect(runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT }).resultHash).toBe(a.resultHash)
    expect(runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT + 1n }).resultHash).not.toBe(a.resultHash)
    const wider = { ...conservadorLiveV2, range: { ...conservadorLiveV2.range, widthTicks: 4000 } }
    expect(runBacktest(ds, wider, { deposit: DEPOSIT }).resultHash).not.toBe(a.resultHash)
  }, SLOW)

  test('a later deposit is counted as money in, for the run and for the benchmark alike', () => {
    const ds = syntheticDataset({ samples: 120 })
    const r = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, topUps: [{ at: 40, amount: DEPOSIT / 2n }] })
    expect(r.metrics.start).toBe(DEPOSIT + DEPOSIT / 2n)
    expect(r.series.value[39]! < DEPOSIT).toBe(true)
    expect(r.series.value[40]! > DEPOSIT + DEPOSIT / 3n).toBe(true)
    // Flat market: the benchmark holds exactly what went in.
    const drift = r.series.hodl.at(-1)! - r.metrics.start
    expect((drift < 0n ? -drift : drift) < r.metrics.start / 10_000n).toBe(true)
    expect(-r.metrics.net).toBeLessThan(r.metrics.start / 300n)
  }, SLOW)

  test('a deposit due at a sample the run steps over lands at the next one', () => {
    const ds = syntheticDataset({ samples: 60 })
    const holed = { ...ds, samples: ds.samples.map((x, i) => (i === 40 ? { ...x, pools: x.pools.map((p, k) => (k === 2 ? null : p)) } : x)) }
    const r = runBacktest(holed, conservadorLiveV2, { deposit: DEPOSIT, topUps: [{ at: 40, amount: DEPOSIT }] })
    expect(r.window.gaps).toBe(1)
    expect(r.metrics.start).toBe(2n * DEPOSIT)
    expect(r.series.value.at(-1)! > DEPOSIT + DEPOSIT / 2n).toBe(true)
  }, SLOW)

  test('drawdown and worst week follow the value of the account', () => {
    // cbBTC falls 6% (600 ticks) over a day, flat before and after; 40% of the account sits in that bucket.
    const ds = syntheticDataset({ samples: 3 * 288, tick: (k, i) => (k === 1 ? 2 * Math.max(0, Math.min(300, i - 288)) : 0) })
    const r = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT })
    expect(r.metrics.maxDrawdownBps).toBeGreaterThan(50)
    expect(r.metrics.maxDrawdownBps).toBeLessThan(400)
    // The whole run is shorter than a week: the worst week is the same fall.
    expect(r.metrics.worstWeekBps).toBeGreaterThan(50)
    expect(r.metrics.worstWeekBps).toBeLessThanOrEqual(r.metrics.maxDrawdownBps)
  }, SLOW)

  test('sessions nobody renews refuse everything after their first window', () => {
    // 31 days of samples one hour apart; the price walks out of the cbBTC range in the second month.
    const ds = syntheticDataset({ samples: 31 * 24 + 48, step: 3600, tick: (k, i) => (k === 1 && i > 30 * 24 ? 60 * (i - 30 * 24) : 0) })
    const renewed = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT })
    const once = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, sessionRenewal: 'once' })
    expect(renewed.metrics.operations.rerange).toBeGreaterThan(0)
    expect(once.metrics.operations.rerange).toBe(0)
    expect(once.reasons.SESSION_EXPIRED).toBeGreaterThan(0)
    expect(once.resultHash).not.toBe(renewed.resultHash)
  }, SLOW)

  test('a policy pool the dataset lacks is refused before the run', () => {
    const ds = syntheticDataset({ samples: 3 })
    expect(() => runBacktest({ ...ds, pools: ['x', ...ds.pools.slice(1)] }, conservadorLiveV2, { deposit: DEPOSIT })).toThrow(/has no pool:USDC\/USDT\/100/)
  })
})
