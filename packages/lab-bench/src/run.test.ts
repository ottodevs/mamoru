import { describe, expect, test } from 'bun:test'
import { ReasonError } from '@mamoru/domain'
import { basesForWindow, runBench } from './run.ts'
import type { BenchSpec } from './spec.ts'

/** Slow: a real backtest over a real dataset file. */
const SLOW = 30_000

describe('basesForWindow (B-03)', () => {
  test('aug2024 (no cbBTC on Base yet) has no base that can run', () => {
    expect(basesForWindow('aug2024')).toEqual([])
  })

  test('a window with every pool offers both bases', () => {
    expect(basesForWindow('feb2025')).toEqual(['live', 'guard'])
  })
})

describe('runBench', () => {
  test('a spec on aug2024 is LAB_DATASET_MISSING for either base', () => {
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

  test('refuses a spec validateSpec itself refuses, before touching any dataset', () => {
    try {
      runBench({ windowId: 'may2025', base: 'live', widthTicks: 2000, deposit: 1000 }) // TEST window
      throw new Error('expected runBench to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ReasonError)
      expect((e as ReasonError).code).toBe('LAB_HOLDOUT_DENIED')
    }
  })

  test('the smallest usable TRAIN window (mar2025) gives the exact B-02 shape', () => {
    const spec: BenchSpec = { windowId: 'mar2025', base: 'live', widthTicks: 2000, deposit: 1000 }
    const r = runBench(spec)

    expect(r.specKey).toBe('mar2025|live|2000|1000')
    expect(r.spec).toEqual(spec)
    expect(r.variantLabel).toBe('Política actual')
    expect(r.policyId).toBe('conservador-live-v2')
    expect(typeof r.resultHash).toBe('string')
    expect(r.resultHash.startsWith('0x')).toBe(true)
    expect(r.simVersion).toBe('backtest-1')
    expect(r.window).toEqual({
      id: 'mar2025',
      label: expect.any(String),
      regime: 'crash',
      split: 'train',
      from: '2025-03-03T00:00:00Z',
      to: '2025-03-10T00:00:00Z',
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
    expect(r.series.length).toBeLessThanOrEqual(400)
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
    expect(runBench(spec).resultHash).toBe(r.resultHash)
  }, SLOW)

  test('feb2025, live, width 4000, 1000 USDC: vsHodl matches the proven visual PoC (otto/mamoru#175)', () => {
    const r = runBench({ windowId: 'feb2025', base: 'live', widthTicks: 4000, deposit: 1000 })
    expect(r.metrics.vsHodl).toBeCloseTo(-3.26, 1)
    expect(r.policyId).toBe('conservador-live-v2+w4000')
    expect(r.variantLabel).toBe('Rango 4.000 ticks')
  }, SLOW)
})
