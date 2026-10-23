import { describe, expect, test } from 'bun:test'
import { newCostMeter } from './cost-meter.ts'
import { compareTool, COMPARE_MAX_RUNS, KNOWN_OVERRIDE_KEYS, LabBenchRunner, runBacktestTool, sweepTool, type RunStore } from './tools.ts'

const FIXTURE_DIR = `${import.meta.dir}/../../lab-bench/src/__fixtures__`

describe('runBacktestTool (AL-10, AL-13)', () => {
  test('a well-formed TRAIN spec runs, is recorded in the run store, and returns the public view', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const meter = newCostMeter()
    const outcome = runBacktestTool({ windowId: 'fix-full', base: 'live', deposit: 1000 }, runner, runStore, meter)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.runId.startsWith('0x')).toBe(true)
    expect(outcome.result.opsCount).toBeGreaterThan(0)
    expect(runStore.has(outcome.result.runId)).toBe(true)
    expect(meter.runs).toHaveLength(1)
    expect(meter.runs[0]!.resultHash).toBe(outcome.result.runId)
  })

  test('the only known override key is widthTicks; any other key is LAB_OVERRIDE_UNKNOWN (AL-13), never ignored', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const outcome = runBacktestTool({ windowId: 'fix-full', base: 'live', deposit: 1000, overrides: { notAKnob: 1 } }, runner, runStore)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('LAB_OVERRIDE_UNKNOWN')
    expect(runStore.size).toBe(0)
    expect(KNOWN_OVERRIDE_KEYS).toEqual(['widthTicks'])
  })

  test('widthTicks out of bounds is LAB_SPEC_INVALID (bounds re-checked in code, not just the schema)', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const outcome = runBacktestTool({ windowId: 'fix-full', base: 'live', deposit: 1000, overrides: { widthTicks: 123 } }, runner, runStore)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('LAB_SPEC_INVALID')
  })

  test('a TEST window is LAB_HOLDOUT_DENIED (AL-12a) — the tool refuses it before the model can retry anything', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const outcome = runBacktestTool({ windowId: 'fix-test', base: 'live', deposit: 1000 }, runner, runStore)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('LAB_HOLDOUT_DENIED')
  })

  test('a window whose dataset is missing a bucket pool is LAB_DATASET_MISSING (B-03)', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const outcome = runBacktestTool({ windowId: 'fix-nobtc', base: 'live', deposit: 1000 }, runner, runStore)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('LAB_DATASET_MISSING')
  })

  test('a malformed args shape is LAB_SPEC_INVALID, not a thrown exception', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    expect(runBacktestTool(null, runner, runStore)).toEqual({ ok: false, error: { code: 'LAB_SPEC_INVALID', message: expect.any(String) } })
    expect(runBacktestTool({ windowId: 'fix-full', base: 'neither', deposit: 1000 }, runner, runStore).ok).toBe(false)
  })

  test('the same spec gives the same resultHash (AL-16, LAB-AL-09)', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const a = runBacktestTool({ windowId: 'fix-full', base: 'live', deposit: 1000 }, runner, new Map())
    const b = runBacktestTool({ windowId: 'fix-full', base: 'live', deposit: 1000 }, runner, new Map())
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.result.runId).toBe(b.result.runId)
  })

  describe('datasetId as an alternative to windowId (review finding, AL-10)', () => {
    const FIX_FULL_DATASET_ID = '0x852bf32acfea20911aaa2572caf1fe3d759b94ff543593b6a9ee49673e29f828'
    const FIX_TEST_DATASET_ID = '0x6669782d746573742d686f6c646f75742d666978747572652d6f6e6c792d3030' // manifest-fixture-only, see __fixtures__/manifest.json

    test('a TRAIN dataset id resolves and runs as its window', () => {
      const runner = new LabBenchRunner(FIXTURE_DIR)
      const runStore: RunStore = new Map()
      const outcome = runBacktestTool({ datasetId: FIX_FULL_DATASET_ID, base: 'live', deposit: 1000 }, runner, runStore, undefined, FIXTURE_DIR)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.result.window.id).toBe('fix-full')
      // same resolved window, same spec -> identical resultHash to naming it by windowId directly.
      const byWindow = runBacktestTool({ windowId: 'fix-full', base: 'live', deposit: 1000 }, runner, new Map(), undefined, FIXTURE_DIR)
      expect(byWindow.ok && outcome.result.runId === byWindow.result.runId).toBe(true)
    })

    test('a TEST dataset id is LAB_HOLDOUT_DENIED before any data loads', () => {
      const runner = new LabBenchRunner(FIXTURE_DIR)
      const runStore: RunStore = new Map()
      const outcome = runBacktestTool({ datasetId: FIX_TEST_DATASET_ID, base: 'live', deposit: 1000 }, runner, runStore, undefined, FIXTURE_DIR)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.error.code).toBe('LAB_HOLDOUT_DENIED')
      expect(runStore.size).toBe(0)
    })

    test('an unknown dataset id is LAB_SPEC_INVALID', () => {
      const runner = new LabBenchRunner(FIXTURE_DIR)
      const outcome = runBacktestTool({ datasetId: '0xnot-a-real-dataset', base: 'live', deposit: 1000 }, runner, new Map(), undefined, FIXTURE_DIR)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.error.code).toBe('LAB_SPEC_INVALID')
    })

    test('neither windowId nor datasetId is LAB_SPEC_INVALID', () => {
      const runner = new LabBenchRunner(FIXTURE_DIR)
      const outcome = runBacktestTool({ base: 'live', deposit: 1000 }, runner, new Map(), undefined, FIXTURE_DIR)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.error.code).toBe('LAB_SPEC_INVALID')
    })

    test('datasetId takes precedence when both it and windowId are given', () => {
      const runner = new LabBenchRunner(FIXTURE_DIR)
      const outcome = runBacktestTool({ datasetId: FIX_FULL_DATASET_ID, windowId: 'fix-nobtc', base: 'live', deposit: 1000 }, runner, new Map(), undefined, FIXTURE_DIR)
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.result.window.id).toBe('fix-full')
    })
  })
})

describe('compareTool (AL-11)', () => {
  test('runs every leg and records each in the run store', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const outcome = compareTool(
      {
        runs: [
          { windowId: 'fix-full', base: 'live', deposit: 1000 },
          { windowId: 'fix-full', base: 'live', deposit: 1000, overrides: { widthTicks: 4000 } },
          { windowId: 'fix-full', base: 'guard', deposit: 1000 },
        ],
      },
      runner,
      runStore,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toHaveLength(3)
    expect(runStore.size).toBe(3)
    expect(new Set(outcome.result.map((r) => r.runId)).size).toBe(3) // three distinct variants, three distinct hashes
  })

  test('more than 8 runs is a tool error, never truncated silently', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runs = Array.from({ length: COMPARE_MAX_RUNS + 1 }, () => ({ windowId: 'fix-full', base: 'live' as const, deposit: 1000 }))
    const outcome = compareTool({ runs }, runner, new Map())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('LAB_SPEC_INVALID')
  })

  test('aborts on the first failing leg and reports that error, never tries another policy for it', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const outcome = compareTool(
      { runs: [{ windowId: 'fix-full', base: 'live', deposit: 1000 }, { windowId: 'fix-test', base: 'live', deposit: 1000 }] },
      runner,
      runStore,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('LAB_HOLDOUT_DENIED')
    expect(runStore.size).toBe(1) // the first (good) leg still ran and was recorded before the second failed
  })
})

describe('sweepTool (AL-12, LAB-AL-07)', () => {
  test('default windows: every TRAIN window that can run the base — one row per (window, widthTicks)', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const outcome = sweepTool({ base: 'live', widthTicks: [2000, 4000], deposit: 1000 }, runner, runStore, undefined, FIXTURE_DIR)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // fix-nobtc has no runnable base at all (B-03) and is never defaulted in; only fix-full x {2000,4000}.
    expect(outcome.result.rows).toHaveLength(2)
    expect(outcome.result.rows.every((r) => r.windowId === 'fix-full')).toBe(true)
    for (const row of outcome.result.rows) {
      expect('runId' in row).toBe(true)
      if ('runId' in row) expect(runStore.has(row.runId)).toBe(true)
    }
    expect(runStore.size).toBe(2)
  })

  test('a named TEST window is LAB_HOLDOUT_DENIED for the WHOLE sweep, before any row runs', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const outcome = sweepTool({ base: 'live', widthTicks: [2000], deposit: 1000, windows: ['fix-full', 'fix-test'] }, runner, runStore, undefined, FIXTURE_DIR)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('LAB_HOLDOUT_DENIED')
    expect(runStore.size).toBe(0) // not even fix-full ran — the holdout check happens before any run (AL-12a)
  })

  test('a named window with no data for the base is a per-row LAB_DATASET_MISSING error, alongside good rows', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const outcome = sweepTool({ base: 'live', widthTicks: [2000], deposit: 1000, windows: ['fix-full', 'fix-nobtc'] }, runner, runStore, undefined, FIXTURE_DIR)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.rows).toHaveLength(2)
    const full = outcome.result.rows.find((r) => r.windowId === 'fix-full')!
    const nobtc = outcome.result.rows.find((r) => r.windowId === 'fix-nobtc')!
    expect('runId' in full).toBe(true)
    expect('error' in nobtc && nobtc.error.code === 'LAB_DATASET_MISSING').toBe(true)
    expect(runStore.size).toBe(1) // only the good row was recorded
  })

  test('more than 6 widthTicks values, or more than 24 total (window x width) rows, is a tool error', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const tooManyWidths = sweepTool({ base: 'live', widthTicks: [500, 1000, 1500, 2000, 2500, 3000, 3500], deposit: 1000 }, runner, new Map(), undefined, FIXTURE_DIR)
    expect(tooManyWidths.ok).toBe(false)
    const tooManyRows = sweepTool(
      { base: 'live', widthTicks: [500, 1000, 1500, 2000, 2500, 3000], deposit: 1000, windows: Array.from({ length: 5 }, () => 'fix-full') },
      runner,
      new Map(),
      undefined,
      FIXTURE_DIR,
    )
    expect(tooManyRows.ok).toBe(false)
    if (tooManyRows.ok) return
    expect(tooManyRows.error.code).toBe('LAB_SPEC_INVALID')
  })

  test('an out-of-bounds widthTicks value, or deposit, is LAB_SPEC_INVALID before any run', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    expect(sweepTool({ base: 'live', widthTicks: [123], deposit: 1000 }, runner, new Map(), undefined, FIXTURE_DIR).ok).toBe(false)
    expect(sweepTool({ base: 'live', widthTicks: [2000], deposit: 99 }, runner, new Map(), undefined, FIXTURE_DIR).ok).toBe(false)
    expect(sweepTool({ base: 'live', widthTicks: [], deposit: 1000 }, runner, new Map(), undefined, FIXTURE_DIR).ok).toBe(false)
  })

  test('every successful row is recorded in the run store and meter, just like run_backtest', () => {
    const runner = new LabBenchRunner(FIXTURE_DIR)
    const runStore: RunStore = new Map()
    const meter = newCostMeter()
    const outcome = sweepTool({ base: 'live', widthTicks: [2000], deposit: 1000 }, runner, runStore, meter, FIXTURE_DIR)
    expect(outcome.ok).toBe(true)
    expect(meter.runs).toHaveLength(1)
  })
})
