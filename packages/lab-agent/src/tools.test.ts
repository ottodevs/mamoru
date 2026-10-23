import { describe, expect, test } from 'bun:test'
import { newCostMeter } from './cost-meter.ts'
import { compareTool, COMPARE_MAX_RUNS, KNOWN_OVERRIDE_KEYS, LabBenchRunner, LAB_TOOL_UNAVAILABLE, runBacktestTool, sweepTool, type RunStore } from './tools.ts'

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

describe('sweepTool (AL-12, v1 stub)', () => {
  test('always answers LAB_TOOL_UNAVAILABLE — no runner call, no budget spent', () => {
    const outcome = sweepTool()
    expect(outcome).toEqual({ ok: false, error: { code: LAB_TOOL_UNAVAILABLE, message: expect.any(String) } })
  })
})
