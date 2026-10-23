import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2 } from '@mamoru/policy'
import { baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { POOLS, syntheticDataset } from './fixtures.ts'
import { amountsOf, type Observation } from '@mamoru/decide'
import { accrueYield, armName, divertFees, driftStep, estimate, harvestReport, labHarvest, newLedger, poolLedger, recordEarned, triggers, type HarvestArm } from './harvest.ts'
import { runBacktest } from './run.ts'
import { policyOf } from './sweep.ts'
import type { PoolSample } from './types.ts'
import { newWorld, type SimPosition } from './world.ts'

const USDC = 1_000_000n
const SLOW = 60_000
const DEPOSIT = 1_000n * USDC
const Q128 = 1n << 128n
/** About a cent per position per hour on a 1,000 USDC account, as backtest.test.ts. */
const GROWTH = [1n << 103n, 1n << 104n, 1n << 96n] as const
const SAVINGS: HarvestArm = { kind: 'savings', k: 3 }
const COMPOUND: HarvestArm = { kind: 'compound', k: 3 }

describe('arm names', () => {
  test('name the rule and its parameters', () => {
    expect(armName({ kind: 'live' })).toBe('live')
    expect(armName({ kind: 'savings', k: 5 })).toBe('A-k5')
    expect(armName({ kind: 'savings', k: 10, capSeconds: 7 * 86_400 })).toBe('A-k10-T7d')
    expect(armName({ kind: 'compound', k: 2 })).toBe('B-k2')
  })
})

describe('trigger', () => {
  const est = (feesValue: bigint, cost: bigint) => ({ feesValue, cost, volatile: 'WETH', volatileAmount: 0n, out: 0n, loss: 0n })
  test('fees at k times the cost harvest, below do not', () => {
    expect(triggers({ kind: 'savings', k: 3 }, est(300n, 100n), 0, 0)).toBe(true)
    expect(triggers({ kind: 'savings', k: 3 }, est(299n, 100n), 0, 0)).toBe(false)
    expect(triggers({ kind: 'savings', k: 2.5 }, est(250n, 100n), 0, 0)).toBe(true)
    expect(triggers({ kind: 'compound', k: 10 }, est(999n, 100n), 0, 0)).toBe(false)
  })
  test('past the time cap, fees that cover the cost once are enough; below the cost never', () => {
    const arm: HarvestArm = { kind: 'savings', k: 10, capSeconds: 7 * 86_400 }
    expect(triggers(arm, est(150n, 100n), 7 * 86_400 - 1, 0)).toBe(false)
    expect(triggers(arm, est(150n, 100n), 7 * 86_400, 0)).toBe(true)
    expect(triggers(arm, est(99n, 100n), 30 * 86_400, 0)).toBe(false)
  })
  test('live never triggers the Lab harvest; nothing to harvest never does', () => {
    expect(triggers({ kind: 'live' }, est(10n ** 12n, 1n), 0, 0)).toBe(false)
    expect(triggers(SAVINGS, est(0n, 0n), 0, 0)).toBe(false)
  })
})

describe('cost estimate', () => {
  const e = entry(POOLS[2], baseRegistry) // WETH/USDC: WETH is token0
  const ps: PoolSample = { sqrtPriceX96: sqrtRatioAtTick(-197_323), tick: -197_323, liquidity: 46_960_404_211_274_752_978n, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n, tickCumulative: 0n }
  const pos: SimPosition = { tokenId: 1n, pool: POOLS[2], tickLower: -197_400, tickUpper: -197_200, liquidity: 1n, owed0: 10n ** 15n, owed1: 2n * USDC }
  const gasOf = (k: string) => (k === 'harvest' ? 10_000n : k === 'enter_swap' ? 7_000n : 9_000n)
  test('savings: collect, one swap, and the swap fee on the volatile part; the USDC part needs no swap', () => {
    const x = estimate(SAVINGS, undefined, pos, e, ps, 'USDC', gasOf)
    expect(x.volatile).toBe('WETH')
    expect(x.volatileAmount).toBe(10n ** 15n)
    // 0.3% pool fee on the WETH part (about 2.7 USDC at tick -197,323) is about 8,000 raw units.
    expect(x.loss).toBeGreaterThan(7_000n)
    expect(x.loss).toBeLessThan(9_000n)
    expect(x.cost).toBe(10_000n + 7_000n + x.loss)
    expect(x.feesValue).toBe(2n * USDC + x.out + x.loss)
    // No volatile fees: no swap in the cost.
    expect(estimate(SAVINGS, undefined, { ...pos, owed0: 0n }, e, ps, 'USDC', gasOf).cost).toBe(10_000n)
  })
  test('compound: collect and increase, no swap', () => {
    expect(estimate(COMPOUND, undefined, pos, e, ps, 'USDC', gasOf).cost).toBe(19_000n)
  })
})

describe('savings yield', () => {
  test('earns the stable position return per interval, fractions carried', () => {
    const l = newLedger(SAVINGS)
    l.savings = 1_000n
    // A third of a unit per interval: one unit every three.
    for (let i = 0; i < 9; i++) accrueYield(l, 1n, 3_000n)
    expect(l.yieldEarned).toBe(3n)
    expect(l.savings).toBe(1_003n)
    expect(l.savingsRemX128).toBeLessThan(Q128)
  })
})

describe('arms in a run', () => {
  test('live measures and changes nothing: same operations and value as no arm; the hash names the arm', () => {
    const ds = syntheticDataset({ samples: 400, growth: GROWTH })
    const none = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT })
    const live = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'live' } })
    expect(none.harvest).toBeUndefined()
    expect(live.ops.map((o) => [o.i, o.kind, o.gasCost])).toEqual(none.ops.map((o) => [o.i, o.kind, o.gasCost]))
    expect(live.series.value).toEqual(none.series.value)
    expect(live.resultHash).not.toBe(none.resultHash)
    expect(live.harvest!.harvests).toBe(none.metrics.operations.harvest)
    expect(live.harvest!.savings).toBe(0n)
  }, SLOW)

  test('savings: the engine harvests nothing itself; fees land in the savings layer, outside the account', () => {
    const ds = syntheticDataset({ samples: 400, growth: GROWTH })
    const r = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: SAVINGS })
    const h = r.harvest!
    expect(h.arm).toBe('A-k3')
    expect(h.harvests).toBeGreaterThan(0)
    // Every harvest is the arm's own, and each one with volatile fees is followed by its swap.
    expect(r.ops.filter((o) => o.kind === 'harvest').every((o) => o.grant === 'lab:harvest')).toBe(true)
    expect(r.ops.filter((o) => o.grant === 'lab:harvest-swap')).toHaveLength(h.swaps)
    expect(h.savings).toBeGreaterThan(0n)
    expect(h.cost).toBeGreaterThan(0n)
    // What the layer holds, less the gas of getting it there: what was captured (no price move, nothing pending).
    const gas = h.pools.reduce((n, p) => n + p.gas, 0n)
    expect(h.captured).toBe(h.savings - gas)
    // The layer is part of the account's value.
    expect(r.metrics.end).toBeGreaterThan(h.savings)
    expect(r.resultHash).not.toBe(runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'savings', k: 5 } }).resultHash)
  }, SLOW)

  test('savings: a higher k harvests less often and pays less per fee', () => {
    const ds = syntheticDataset({ samples: 400, growth: GROWTH })
    const k2 = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'savings', k: 2 } }).harvest!
    const k10 = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'savings', k: 10 } }).harvest!
    expect(k10.harvests).toBeLessThan(k2.harvests)
    expect(Number(k10.cost) / Number(k10.fees)).toBeLessThan(Number(k2.cost) / Number(k2.fees))
  }, SLOW)

  test('savings: volatile fees sold before a fall are exposure removed', () => {
    // WETH (token0 of WETH/USDC) and cbBTC (token1 of USDC/cbBTC) fall by about 5% over the second half.
    const fall = (k: number, i: number) => (i < 200 ? 0 : k === 2 ? -Math.round((i - 200) * 2.5) : k === 1 ? Math.round((i - 200) * 2.5) : 0)
    const ds = syntheticDataset({ samples: 400, growth: GROWTH, tick: fall })
    const h = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: SAVINGS }).harvest!
    expect(h.exposureRemoved).toBeGreaterThan(0n)
    expect(runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: COMPOUND }).harvest!.exposureRemoved).toBe(0n)
  }, SLOW)

  test('compound: fees go back into the same position, nothing to the savings layer', () => {
    const ds = syntheticDataset({ samples: 400, growth: GROWTH })
    const r = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: COMPOUND })
    const h = r.harvest!
    expect(h.arm).toBe('B-k3')
    expect(h.increases).toBeGreaterThan(0)
    expect(h.savings).toBe(0n)
    expect(h.swaps).toBe(0)
    const inc = r.ops.filter((o) => o.kind === 'increase_liquidity')
    expect(inc.every((o) => o.grant === 'lab:compound')).toBe(true)
    expect(inc).toHaveLength(h.increases)
  }, SLOW)

  test('#150: the lowest value net of gas is reported', () => {
    const r = runBacktest(syntheticDataset({ samples: 100, growth: GROWTH }), conservadorLiveV2, { deposit: DEPOSIT, harvest: SAVINGS })
    const min = r.series.value.reduce((a, b) => (b < a ? b : a))
    expect(r.harvest!.minValue).toBe(min)
  }, SLOW)
})

describe('sweep variants', () => {
  test('a harvest arm without overrides runs the base policy unchanged', () => {
    expect(policyOf({ name: 'A-k3', policy: 'conservador-live-v2', harvest: SAVINGS })).toBe(conservadorLiveV2)
    expect(policyOf({ name: 'x', policy: 'conservador-live-v2' }).policyId).toBe('conservador-live-v2+x')
  })
})

// Review of a1637b0 (GPT-6 Sol), one test per finding.
describe('review fixes', () => {
  const ds = syntheticDataset({ samples: 2 })
  const s0 = ds.samples[0]!
  const eth = entry(POOLS[2], baseRegistry)
  const ps = s0.pools[2]!
  const price = (_s: unknown, token: string, amount: bigint) => (token === 'USDC' ? amount : amount === 0n ? 0n : (amount * 2_700n) / 10n ** 12n)
  const gasOf = () => 10_000n

  test('1: fees of a re-range or reduce are diverted only from what its collect credited to the account', () => {
    const l = newLedger(SAVINGS)
    const w = newWorld('USDC', 0n)
    // Nothing collected (an operation that did not go through credits nothing): nothing can be diverted.
    expect(() => divertFees(l, w, eth, ps, 10n ** 15n, 2n * USDC, 'USDC')).toThrow()
    expect(l.savings).toBe(0n)
    w.balances.WETH = 10n ** 15n
    w.balances.USDC = 2n * USDC
    divertFees(l, w, eth, ps, 10n ** 15n, 2n * USDC, 'USDC')
    expect(w.balances).toMatchObject({ WETH: 0n, USDC: 0n })
    expect(l.savings).toBe(2n * USDC)
    expect(poolLedger(l, POOLS[2]).pending.WETH).toBe(10n ** 15n)
  })

  test('1: every fee a run earns is collected or still owed, token by token, with re-ranges on the way', () => {
    // Prices that leave the ranges, so the run re-ranges and collects through them.
    const path = (k: number, i: number) => (k === 0 ? 0 : Math.round(Math.sin(i / 25) * 2_500))
    const busy = syntheticDataset({ samples: 400, growth: GROWTH, tick: path })
    for (const arm of [SAVINGS, COMPOUND, { kind: 'live' } as const]) {
      const r = runBacktest(busy, conservadorLiveV2, { deposit: DEPOSIT, harvest: arm })
      expect(r.metrics.operations.rerange).toBeGreaterThan(0)
      expect(r.harvest).toBeDefined()
    }
    // A ledger that does not balance stops the report.
    const l = newLedger(SAVINGS)
    recordEarned(l, eth, 5n, 0n, 5n)
    expect(() => harvestReport(l, newWorld('USDC', 0n), ds, s0, price, 0n)).toThrow(/earned 5/)
  }, SLOW)

  test('2: volatile fees left waiting in a pool with no position are sold on their own, and never counted as savings before', () => {
    const l = newLedger(SAVINGS)
    const w = newWorld('USDC', 0n)
    const pl = poolLedger(l, POOLS[2])
    recordEarned(l, eth, 10n ** 15n, 0n, 0n)
    pl.collected.WETH = 10n ** 15n
    pl.pending.WETH = 10n ** 15n
    const before = harvestReport(l, w, ds, s0, price, 0n)
    expect(before.captured).toBe(0n)
    expect(before.unconverted).toBeGreaterThan(0n)
    const ops = labHarvest(l, w, ds, s0, 'USDC', 50, gasOf)
    expect(ops).toEqual([{ kind: 'enter_swap', pool: POOLS[2], tokenId: 0n, grant: 'lab:harvest-swap', gasCost: 10_000n, feesValue: 0n }])
    expect(pl.pending.WETH).toBe(0n)
    const after = harvestReport(l, w, ds, s0, price, 0n)
    expect(after.unconverted).toBe(0n)
    expect(after.captured).toBe(l.savings - 10_000n)
    expect(after.swaps).toBe(1)
  })

  /** An observation with what `driftStep` reads: pools at their tick, positions, balances. */
  function obsOf(positions: { pool: string; liquidity: bigint; tickLower: number; tickUpper: number }[], balances: Record<string, bigint>): Observation {
    const pools = POOLS.map((name, k) => {
      const e = entry(name, baseRegistry)
      return { name, token0: e.token0!, token1: e.token1!, sqrtPriceX96: s0.pools[k]!.sqrtPriceX96, tick: s0.pools[k]!.tick, twapTick: s0.pools[k]!.tick }
    })
    return { pools, balances, positions: positions.map((p, i) => ({ tokenId: BigInt(i + 1), ...p, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true })) } as unknown as Observation
  }

  test('3: a bucket held in its second pool counts as entered and is measured', () => {
    // The stables bucket may also use WETH/USDC here: holding only that pool still enters it.
    const policy = { ...conservadorLiveV2, buckets: conservadorLiveV2.buckets.map((b) => (b.id === 'stables' ? { ...b, pools: ['pool:USDC/DAI/100', POOLS[0]] } : b)) }
    const l = newLedger(SAVINGS)
    const pos = (k: number) => ({ pool: POOLS[k]!, liquidity: 10n ** 12n, tickLower: s0.pools[k]!.tick - 600, tickUpper: s0.pools[k]!.tick + 600 })
    driftStep(l, obsOf([pos(0), pos(1), pos(2)], { USDC: 0n }), policy)
    expect(l.drift.entered).toBe(true)
    expect(l.drift.samples).toBe(1)
  })

  test('4: a portfolio that never comes within the band is measured from entry, not reported as zero drift', () => {
    const l = newLedger(SAVINGS)
    const pos = (k: number) => ({ pool: POOLS[k]!, liquidity: 10n ** 12n, tickLower: s0.pools[k]!.tick - 600, tickUpper: s0.pools[k]!.tick + 600 })
    // Every bucket entered, then most of the account idle in USDC: far off the 50/40/10 target.
    for (let i = 0; i < 3; i++) driftStep(l, obsOf([pos(0), pos(1), pos(2)], { USDC: 10n ** 15n }), conservadorLiveV2)
    expect(l.drift.samples).toBe(3)
    expect(l.drift.maxBps).toBeGreaterThan(3_000)
    expect(l.drift.sumBps / l.drift.samples).toBeGreaterThan(3_000)
  })

  test('5: compounded fees are valued as the share of the position they bought, fees owed on it included', () => {
    const l = newLedger(COMPOUND)
    const w = newWorld('USDC', 0n)
    const tick = s0.pools[2]!.tick
    w.positions.push({ tokenId: 7n, pool: POOLS[2], tickLower: tick - 600, tickUpper: tick + 600, liquidity: 4n * 10n ** 15n, owed0: 4n * 10n ** 12n, owed1: 4_000n })
    recordEarned(l, eth, 4n * 10n ** 12n, 4_000n, 0n)
    // A quarter of the liquidity came from compounding.
    l.compounded.set(7n, 10n ** 15n)
    const r = harvestReport(l, w, ds, s0, price, 0n)
    const a = amountsOf(ps.sqrtPriceX96, tick - 600, tick + 600, 4n * 10n ** 15n)
    const whole = price(s0, 'WETH', a.amount0 + 4n * 10n ** 12n) + price(s0, 'USDC', a.amount1 + 4_000n)
    expect(r.captured).toBe(whole / 4n)
    // In a run, B's compounded liquidity is what it reports, not the fees at the end price as if held.
    const run = runBacktest(syntheticDataset({ samples: 400, growth: GROWTH }), conservadorLiveV2, { deposit: DEPOSIT, harvest: COMPOUND }).harvest!
    expect(run.increases).toBeGreaterThan(0)
    expect(run.captured).toBeGreaterThan(0n)
  }, SLOW)
})
