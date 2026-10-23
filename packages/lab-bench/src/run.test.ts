import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ReasonError } from '@mamoru/domain'
import { basesForWindow, downsampleIndices, MAX_SERIES_POINTS, runBench } from './run.ts'
import { defaultDatasetsDir, type BenchSpec } from './spec.ts'

/** Slow: a real backtest. */
const SLOW = 30_000

/**
 * Committed, synthetic, tiny (review of #117 round 2: CI has no `~/.local/share/mamoru-lab/datasets`, so a test
 * that reaches the filesystem through the default `datasetsDir` throws ENOENT on a fresh box). `fix-full` has all
 * three pools over 24 flat synthetic samples; `fix-nobtc` is the same window with every `pool:USDC/cbBTC/500`
 * sample null, aug2024-shaped; `fix-test` (same dataset as `fix-full`) is TEST split. Generated once from
 * `@mamoru/backtest`'s `makeDataset`/`encodeDataset` and `@mamoru/uniswap-v3`'s `sqrtRatioAtTick` — see
 * `__fixtures__/manifest.json`.
 */
const FIXTURE_DIR = `${import.meta.dir}/__fixtures__`
const HAS_REAL_DATASETS = existsSync(join(defaultDatasetsDir(), 'manifest.json'))

function assertWellFormed(idx: number[], n: number, max: number): void {
  expect(idx.length).toBeLessThanOrEqual(max)
  expect(idx.length).toBeGreaterThan(0)
  expect(idx[0]).toBe(0)
  expect(idx.at(-1)).toBe(n - 1)
  for (let i = 1; i < idx.length; i++) expect(idx[i]!).toBeGreaterThan(idx[i - 1]!) // strictly increasing
}

describe('downsampleIndices (review of #117 P3: must never exceed max, including the forced last point)', () => {
  test('n <= max: every index, unchanged', () => {
    expect(downsampleIndices(5, MAX_SERIES_POINTS)).toEqual([0, 1, 2, 3, 4])
    expect(downsampleIndices(MAX_SERIES_POINTS, MAX_SERIES_POINTS)).toHaveLength(MAX_SERIES_POINTS)
  })

  test('exactly at the boundary, one past it, and the off-by-one bug\'s own numbers (800, 801)', () => {
    for (const n of [MAX_SERIES_POINTS - 1, MAX_SERIES_POINTS, MAX_SERIES_POINTS + 1, MAX_SERIES_POINTS + 2, 799, 800, 801, 802, 8641])
      assertWellFormed(downsampleIndices(n, MAX_SERIES_POINTS), n, MAX_SERIES_POINTS)
  })

  test('the regression this was caught by: n=800 used to come back as 401, not <= 400', () => {
    const idx = downsampleIndices(800, MAX_SERIES_POINTS)
    expect(idx.length).toBeLessThanOrEqual(MAX_SERIES_POINTS)
    expect(idx.at(-1)).toBe(799)
  })

  test('zero samples is empty; one sample is just index 0', () => {
    expect(downsampleIndices(0, MAX_SERIES_POINTS)).toEqual([])
    expect(downsampleIndices(1, MAX_SERIES_POINTS)).toEqual([0])
  })
})

describe('basesForWindow (B-03)', () => {
  test('a window missing a bucket pool (fixture, aug2024-shaped) has no base that can run', () => {
    expect(basesForWindow('fix-nobtc', FIXTURE_DIR)).toEqual([])
  })

  test('a window with every pool offers both bases', () => {
    expect(basesForWindow('fix-full', FIXTURE_DIR)).toEqual(['live', 'guard'])
  })
})

describe('runBench', () => {
  test('a spec on a dataset missing a bucket pool is LAB_DATASET_MISSING for either base', () => {
    for (const base of ['live', 'guard'] as const) {
      try {
        runBench({ windowId: 'fix-nobtc', base, widthTicks: 2000, deposit: 1000 }, FIXTURE_DIR)
        throw new Error(`expected runBench(fix-nobtc, ${base}) to throw`)
      } catch (e) {
        expect(e).toBeInstanceOf(ReasonError)
        expect((e as ReasonError).code).toBe('LAB_DATASET_MISSING')
      }
    }
  })

  test('refuses a spec validateSpec itself refuses, before touching any dataset', () => {
    try {
      runBench({ windowId: 'fix-test', base: 'live', widthTicks: 2000, deposit: 1000 }, FIXTURE_DIR) // TEST window
      throw new Error('expected runBench to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ReasonError)
      expect((e as ReasonError).code).toBe('LAB_HOLDOUT_DENIED')
    }
  })

  test('a TRAIN window gives the exact B-02 shape', () => {
    const spec: BenchSpec = { windowId: 'fix-full', base: 'live', widthTicks: 2000, deposit: 1000 }
    const r = runBench(spec, FIXTURE_DIR)

    expect(r.specKey).toBe('fix-full|live|2000|1000')
    expect(r.spec).toEqual(spec)
    expect(r.variantLabel).toBe('Política actual')
    expect(r.policyId).toBe('conservador-live-v2')
    expect(typeof r.resultHash).toBe('string')
    expect(r.resultHash.startsWith('0x')).toBe(true)
    expect(r.simVersion).toBe('backtest-1')
    expect(r.window).toEqual({
      id: 'fix-full',
      label: expect.any(String),
      regime: 'calm',
      split: 'train',
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-02T00:00:00Z',
      market: expect.anything(),
    })
    expect(r.deposit).toBe(1000)
    expect(r.pools.sort()).toEqual(['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'].sort())

    expect(r.metrics).toEqual({
      days: expect.any(Number),
      end: expect.any(Number),
      net: expect.any(Number),
      hodl: expect.any(Number),
      vsHodl: expect.any(Number),
      fees: expect.any(Number),
      gas: expect.any(Number),
      timeInRangeBps: expect.any(Number),
      maxDrawdownBps: expect.any(Number),
      returnBps: expect.any(Number),
      operations: expect.any(Object),
    })
    expect(r.reasons).toEqual(expect.any(Object))

    expect(r.series.length).toBeGreaterThan(0)
    expect(r.series.length).toBeLessThanOrEqual(MAX_SERIES_POINTS)
    const first = r.series[0]!
    expect(first).toEqual({ t: expect.any(Number), v: expect.any(Number), h: expect.any(Number), price: expect.any(Object), band: expect.any(Object) })
    for (const p of r.pools) {
      expect(typeof first.price[p]).toBe('number')
      expect(p in first.band).toBe(true)
    }
    // USDC numbers rounded to 4 decimals.
    expect(Number(first.v.toFixed(4))).toBe(first.v)
    expect(Number(r.metrics.end.toFixed(4))).toBe(r.metrics.end)

    for (const op of r.ops) expect(op).toEqual({ t: expect.any(Number), kind: expect.any(String), pool: expect.any(String), gas: expect.any(Number), fees: expect.any(Number), code: expect.any(String), reason: expect.any(String) })

    // Same spec, same hash: a second run is the same simulation.
    expect(runBench(spec, FIXTURE_DIR).resultHash).toBe(r.resultHash)
  }, SLOW)

  test.skipIf(!HAS_REAL_DATASETS)('needs local Lab datasets: feb2025, live, width 4000, 1000 USDC — vsHodl matches the proven visual PoC (otto/mamoru#175)', () => {
    const r = runBench({ windowId: 'feb2025', base: 'live', widthTicks: 4000, deposit: 1000 })
    expect(r.metrics.vsHodl).toBeCloseTo(-3.26, 1)
    expect(r.policyId).toBe('conservador-live-v2+w4000')
    expect(r.variantLabel).toBe('Rango 4.000 ticks')
  }, SLOW)

  test.skipIf(!HAS_REAL_DATASETS)('needs local Lab datasets: aug2024 (no cbBTC on Base yet) is LAB_DATASET_MISSING for either base, against the real manifest too', () => {
    expect(basesForWindow('aug2024')).toEqual([])
    for (const base of ['live', 'guard'] as const) {
      try {
        runBench({ windowId: 'aug2024', base, widthTicks: 2000, deposit: 1000 })
        throw new Error(`expected runBench(aug2024, ${base}) to throw`)
      } catch (e) {
        expect(e).toBeInstanceOf(ReasonError)
        expect((e as ReasonError).code).toBe('LAB_DATASET_MISSING')
      }
    }
  })
})
