// otto/mamoru#413: the vault sink, the switch arm and the engine order of a harvest arm's operation.
import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2 } from '@mamoru/policy'
import { syntheticDataset } from './fixtures.ts'
import { aprBps, armName, newLedger, recordInterval, stepModes, type HarvestArm } from './harvest.ts'
import { runBacktest } from './run.ts'

const USDC = 1_000_000n
const SLOW = 60_000
const DEPOSIT = 1_000n * USDC
const GROWTH = [1n << 103n, 1n << 104n, 1n << 96n] as const
const T0 = 1_790_900_000
/** A vault whose share price grows 10 % a year, over the fixtures' time span and more. */
const PRICES = Array.from({ length: 60 }, (_, d) => ({ time: T0 - 86_400 + d * 86_400, price: 1.1 ** ((d * 86_400) / (365 * 86_400)) }))
const VAULT: HarvestArm = { kind: 'savings', k: 3, sink: { kind: 'vault', sweepK: 0 } }

describe('names', () => {
  test('vault sink and switch arms', () => {
    expect(armName(VAULT)).toBe('A-k3-vault-s0')
    expect(armName({ kind: 'switch', k: 20, capSeconds: 7 * 86_400, sink: { kind: 'vault', sweepK: 100 }, aprSeconds: 3 * 86_400, exitBps: 4000, enterBps: 8000 })).toBe('D-k20-T7d-s100-apr4000-8000-3d')
  })
})

describe('vault sink', () => {
  test('savings wait as USDC, go in by deposits of at least 1 USDC, then grow with the share price; nothing is lost', () => {
    const ds = syntheticDataset({ samples: 600, growth: GROWTH })
    const r = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: VAULT, vaultPrices: PRICES })
    const h = r.harvest!
    expect(h.vault!.sweeps).toBeGreaterThan(0)
    expect(r.ops.filter((o) => o.kind === 'vault_deposit')).toHaveLength(h.vault!.sweeps)
    expect(r.metrics.operations.vault_deposit).toBe(h.vault!.sweeps)
    expect(h.yieldEarned).toBeGreaterThan(0n)
    // The layer is what the pools put in plus the vault's growth; its gas is in the cost and out of what was captured.
    const put = h.pools.reduce((n, p) => n + p.captured + p.gas, 0n)
    expect(h.savings).toBe(put + h.yieldEarned)
    expect(h.captured).toBe(put - h.pools.reduce((n, p) => n + p.gas, 0n) - h.vault!.gas + h.yieldEarned)
    expect(h.cost).toBe(h.pools.reduce((n, p) => n + p.gas + p.swapLoss, 0n) + h.vault!.gas)
    // Realized yield: every collect plus the vault's growth.
    expect(h.realized).toBeGreaterThanOrEqual(h.savings)
  }, SLOW)

  test('a higher sweep floor makes fewer deposits', () => {
    const ds = syntheticDataset({ samples: 600, growth: GROWTH })
    const s0 = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: VAULT, vaultPrices: PRICES }).harvest!
    const s500 = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'savings', k: 3, sink: { kind: 'vault', sweepK: 500 } }, vaultPrices: PRICES }).harvest!
    expect(s500.vault!.sweeps).toBeLessThan(s0.vault!.sweeps)
  }, SLOW)

  test('refuses to run without a share price over the window', () => {
    const ds = syntheticDataset({ samples: 50, growth: GROWTH })
    expect(() => runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: VAULT })).toThrow(/vault share price/)
  })
})

describe('switch arm', () => {
  test('APR over the trailing window, null before it is full; hysteresis between the two thresholds', () => {
    const l = newLedger({ kind: 'switch', k: 20, sink: { kind: 'vault', sweepK: 0 }, aprSeconds: 86_400, exitBps: 1000, enterBps: 2000 })
    const pool = 'pool:WETH/USDC/3000'
    // 30 % a year on 1,000: fees per hour = 1000 * 0.30 / 8760.
    const hourly = (apr: number) => BigInt(Math.round((1000e6 * apr) / 8760))
    for (let h = 1; h <= 23; h++) recordInterval(l, pool, h * 3600, hourly(0.3), 1000n * USDC, 3600)
    expect(aprBps(l, pool, 23 * 3600)).toBeNull()
    recordInterval(l, pool, 24 * 3600, hourly(0.3), 1000n * USDC, 3600)
    expect(Math.round(aprBps(l, pool, 24 * 3600)!)).toBe(3000)
    stepModes(l, 24 * 3600)
    expect(l.mode.get(pool) ?? 'compound').toBe('compound')
    // A day at 5 %: under exit, to savings.
    for (let h = 25; h <= 48; h++) recordInterval(l, pool, h * 3600, hourly(0.05), 1000n * USDC, 3600)
    stepModes(l, 48 * 3600)
    expect(l.mode.get(pool)).toBe('savings')
    // A day at 15 %: between the thresholds, stays.
    for (let h = 49; h <= 72; h++) recordInterval(l, pool, h * 3600, hourly(0.15), 1000n * USDC, 3600)
    stepModes(l, 72 * 3600)
    expect(l.mode.get(pool)).toBe('savings')
    // A day at 25 %: over enter, back to compounding.
    for (let h = 73; h <= 96; h++) recordInterval(l, pool, h * 3600, hourly(0.25), 1000n * USDC, 3600)
    stepModes(l, 96 * 3600)
    expect(l.mode.get(pool)).toBe('compound')
    expect(l.switches).toBe(2)
  })

  test('an exit threshold no pool reaches is the compound arm, operation for operation', () => {
    const ds = syntheticDataset({ samples: 600, growth: GROWTH })
    const c = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'compound', k: 3 }, vaultPrices: PRICES })
    const d = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'switch', k: 3, sink: { kind: 'vault', sweepK: 0 }, aprSeconds: 3600, exitBps: 0, enterBps: 1 }, vaultPrices: PRICES })
    expect(d.ops.map((o) => [o.i, o.kind, o.gasCost])).toEqual(c.ops.map((o) => [o.i, o.kind, o.gasCost]))
    expect(d.series.value).toEqual(c.series.value)
    expect(d.harvest!.switches!.count).toBe(0)
    expect(d.harvest!.savings).toBe(0n)
  }, SLOW)

  test('an exit threshold every pool is under moves every pool to savings after the APR window', () => {
    const ds = syntheticDataset({ samples: 600, growth: GROWTH })
    const d = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'switch', k: 3, sink: { kind: 'vault', sweepK: 0 }, aprSeconds: 3600, exitBps: 1e9, enterBps: 2e9 }, vaultPrices: PRICES }).harvest!
    expect(d.switches!.count).toBeGreaterThan(0)
    expect(Object.values(d.switches!.endModes).every((m) => m === 'savings')).toBe(true)
    expect(d.savings).toBeGreaterThan(0n)
  }, SLOW)
})

describe('engine order', () => {
  test('default order is unchanged; under engine order a re-range the arm used to push back goes on its review', () => {
    // A fall that walks positions out of range, so re-ranges happen while fees are due.
    const fall = (k: number, i: number) => (k === 2 ? -Math.round(i * 4) : k === 1 ? Math.round(i * 4) : 0)
    const ds = syntheticDataset({ samples: 600, growth: GROWTH, tick: fall })
    const first = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'compound', k: 3 } })
    const first2 = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'compound', k: 3 }, labHarvestOrder: 'first' })
    expect(first2.resultHash).toBe(first.resultHash)
    const engine = runBacktest(ds, conservadorLiveV2, { deposit: DEPOSIT, harvest: { kind: 'compound', k: 3 }, labHarvestOrder: 'engine' })
    // A review where the default order ran the arm's harvest while decide wanted a re-range: engine order re-ranges there.
    const firstLab = new Set(first.ops.filter((o) => o.grant.startsWith('lab:')).map((o) => o.i))
    const firstRerange = new Set(first.ops.filter((o) => o.kind === 'rerange').map((o) => o.i))
    const pushed = engine.ops.filter((o) => o.kind === 'rerange' && firstLab.has(o.i) && !firstRerange.has(o.i))
    expect(pushed.length).toBeGreaterThan(0)
    expect(engine.resultHash).not.toBe(first.resultHash)
  }, SLOW)
})

describe('switch APR coverage', () => {
  test('a pool held over less than half the window has no APR, so its mode stays', () => {
    const l = newLedger({ kind: 'switch', k: 20, sink: { kind: 'vault', sweepK: 0 }, aprSeconds: 86_400, exitBps: 1000, enterBps: 2000 })
    const pool = 'pool:WETH/USDC/3000'
    // Held for the first hour, then 20 hours with no position, then 2 hours at 1 %.
    recordInterval(l, pool, 3600, 100_000n, 1000n * USDC, 3600)
    recordInterval(l, pool, 23 * 3600, 1_000n, 1000n * USDC, 3600)
    recordInterval(l, pool, 24 * 3600, 1_000n, 1000n * USDC, 3600)
    expect(aprBps(l, pool, 24 * 3600)).toBeNull()
    stepModes(l, 24 * 3600)
    expect(l.mode.get(pool)).toBeUndefined()
  })
})
