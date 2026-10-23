// Agent Lab agent (008 task 4, otto/mamoru#200): the tools the model can call (AL-10...AL-13, AL-12a).
// `run_backtest`, `compare` and `sweep` all run over a `BenchRunner`. Every run a tool returns successfully is
// recorded into the job's `RunStore` by its `resultHash` (AL-21: only a run the job itself produced or fetched
// is citable).
import { ReasonError, type ReasonCode } from '@mamoru/domain'
import {
  basesForWindow,
  DEPOSIT_MAX_USDC,
  DEPOSIT_MIN_USDC,
  manifestWindow,
  manifestWindowByDatasetId,
  runBench,
  trainWindows,
  WIDTH_TICKS_MAX,
  WIDTH_TICKS_MIN,
  WIDTH_TICKS_STEP,
  type Base,
} from '@mamoru/lab-bench'
import { measureCpuMs, recordRun, type CostMeter } from './cost-meter.ts'
import type { BenchRunner, RunResult, ToolSchema } from './types.ts'

export type RunStore = Map<string, RunResult>

/**
 * Production `BenchRunner`: a thin wrapper over `@mamoru/lab-bench`'s `runBench`. Tests point `datasetsDir` at
 * `packages/lab-bench/src/__fixtures__` (the same tiny synthetic manifest `lab-bench` itself tests against —
 * CI has no real Lab datasets); the runner (task 5) constructs this with no argument, over the real datasets dir.
 */
export class LabBenchRunner implements BenchRunner {
  readonly #datasetsDir: string | undefined
  constructor(datasetsDir?: string) {
    this.#datasetsDir = datasetsDir
  }
  run(spec: { windowId: string; base: Base; widthTicks: number; deposit: number }): RunResult {
    return this.#datasetsDir === undefined ? runBench(spec) : runBench(spec, this.#datasetsDir)
  }
}

// ---------------------------------------------------------------------------
// run_backtest args (AL-10): `window`, `policyId` ('live' | 'guard', the only bases B-01 defines) and `deposit`
// are required; the only known override key in v1 is `widthTicks` (B-01's own override surface) — an unknown
// override key is `LAB_OVERRIDE_UNKNOWN` (AL-13), never ignored.
// ---------------------------------------------------------------------------

export type RunBacktestArgs = { windowId: string; base: Base; deposit: number; overrides?: { widthTicks?: number } }
export const KNOWN_OVERRIDE_KEYS = ['widthTicks'] as const

export type ToolError = { code: string; message: string }
export type ToolOutcome<T> = { ok: true; result: T } | { ok: false; error: ToolError }

/** The public, token-frugal view a tool call hands back to the model — never the ~400-point series (AL-10). */
export type RunPublicView = { runId: string; metrics: RunResult['metrics']; window: RunResult['window']; opsCount: number }

function toPublicView(r: RunResult): RunPublicView {
  return { runId: r.resultHash, metrics: r.metrics, window: r.window, opsCount: r.ops.length }
}

function reasonToolError(e: unknown): ToolError {
  if (e instanceof ReasonError) return { code: e.code, message: e.message }
  return { code: 'LAB_SPEC_INVALID', message: e instanceof Error ? e.message : String(e) }
}

function manifestWindowByDatasetIdIn(datasetId: string, datasetsDir?: string) {
  return datasetsDir === undefined ? manifestWindowByDatasetId(datasetId) : manifestWindowByDatasetId(datasetId, datasetsDir)
}

/**
 * AL-10: `run_backtest`'s window may be named by `windowId` OR by `datasetId` (the dataset the window is backed
 * by) — resolved against the manifest before anything else. A TEST dataset is `LAB_HOLDOUT_DENIED` right here,
 * before any data loads (AL-12a) — the same guarantee `windowId` already got from `runner.run`'s own
 * `validateSpec`, just reached one step earlier since resolving `datasetId` needs the manifest anyway.
 */
function resolveWindowId(a: Record<string, unknown>, datasetsDir: string | undefined): string | ToolError {
  if (typeof a.datasetId === 'string' && a.datasetId.length > 0) {
    try {
      const w = manifestWindowByDatasetIdIn(a.datasetId, datasetsDir)
      if (w.split !== 'train') return { code: 'LAB_HOLDOUT_DENIED', message: `datasetId ${a.datasetId} is a TEST dataset; the Lab never reaches the release gate's holdout` }
      return w.id
    } catch (e) {
      return reasonToolError(e)
    }
  }
  if (typeof a.windowId === 'string' && a.windowId.length > 0) return a.windowId
  return { code: 'LAB_SPEC_INVALID', message: 'windowId or datasetId is required' }
}

function parseRunBacktestArgs(raw: unknown, datasetsDir: string | undefined): RunBacktestArgs | ToolError {
  if (typeof raw !== 'object' || raw === null) return { code: 'LAB_SPEC_INVALID', message: 'run_backtest args must be an object' }
  const a = raw as Record<string, unknown>
  const windowId = resolveWindowId(a, datasetsDir)
  if (typeof windowId !== 'string') return windowId
  if (a.base !== 'live' && a.base !== 'guard') return { code: 'LAB_SPEC_INVALID', message: `base must be "live" or "guard", got ${JSON.stringify(a.base)}` }
  if (typeof a.deposit !== 'number') return { code: 'LAB_SPEC_INVALID', message: 'deposit must be a number' }
  if (a.overrides !== undefined) {
    if (typeof a.overrides !== 'object' || a.overrides === null) return { code: 'LAB_SPEC_INVALID', message: 'overrides must be an object' }
    const unknown = Object.keys(a.overrides).find((k) => !(KNOWN_OVERRIDE_KEYS as readonly string[]).includes(k))
    if (unknown !== undefined) {
      return { code: 'LAB_OVERRIDE_UNKNOWN', message: `unknown override key "${unknown}"; known override keys: ${KNOWN_OVERRIDE_KEYS.join(', ')}` }
    }
    const wt = (a.overrides as Record<string, unknown>).widthTicks
    if (wt !== undefined && typeof wt !== 'number') return { code: 'LAB_SPEC_INVALID', message: 'overrides.widthTicks must be a number' }
  }
  return { windowId, base: a.base, deposit: a.deposit, overrides: a.overrides as RunBacktestArgs['overrides'] }
}

/** B-01's default width (the base policy's own `range.widthTicks`, 2000) when no override is given. */
const DEFAULT_WIDTH_TICKS = 2000

export function runBacktestTool(raw: unknown, runner: BenchRunner, runStore: RunStore, meter?: CostMeter, datasetsDir?: string): ToolOutcome<RunPublicView> {
  const parsed = parseRunBacktestArgs(raw, datasetsDir)
  if ('code' in parsed) return { ok: false, error: parsed }
  const widthTicks = parsed.overrides?.widthTicks ?? DEFAULT_WIDTH_TICKS
  try {
    const { result: r, cpuMs } = measureCpuMs(() => runner.run({ windowId: parsed.windowId, base: parsed.base, widthTicks, deposit: parsed.deposit }))
    runStore.set(r.resultHash, r)
    if (meter) recordRun(meter, r.resultHash, cpuMs)
    return { ok: true, result: toPublicView(r) }
  } catch (e) {
    return { ok: false, error: reasonToolError(e) }
  }
}

export const RUN_BACKTEST_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'run_backtest',
    description: 'Replay one TRAIN window through one base policy and return its metrics, window and op count. Name the window by windowId OR by datasetId — exactly one of the two is required.',
    parameters: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'A TRAIN window id from the catalog in the system prompt. Alternative to datasetId; give exactly one.' },
        datasetId: { type: 'string', description: 'A TRAIN window\'s dataset id, as an alternative to windowId. Give exactly one.' },
        base: { type: 'string', enum: ['live', 'guard'], description: '"live" (conservador-live-v2) or "guard" (conservador-lab-guards-v1).' },
        deposit: { type: 'number', description: `Whole USDC, ${DEPOSIT_MIN_USDC}..${DEPOSIT_MAX_USDC}.` },
        overrides: {
          type: 'object',
          properties: { widthTicks: { type: 'number', description: `${WIDTH_TICKS_MIN}..${WIDTH_TICKS_MAX}, step ${WIDTH_TICKS_STEP}.` } },
          additionalProperties: false,
          description: 'Optional. The only known override key is widthTicks; any other key is a tool error.',
        },
      },
      required: ['base', 'deposit'],
      additionalProperties: false,
    },
  },
}

// ---------------------------------------------------------------------------
// compare (AL-11): up to 8 runs, same args shape as run_backtest, one per leg. The agent must use this instead
// of several run_backtest calls when the user wants scenarios side by side (AL-14, no list_* tools either way).
// ---------------------------------------------------------------------------

export const COMPARE_MAX_RUNS = 8

export function compareTool(raw: unknown, runner: BenchRunner, runStore: RunStore, meter?: CostMeter, datasetsDir?: string): ToolOutcome<RunPublicView[]> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: { code: 'LAB_SPEC_INVALID', message: 'compare args must be an object' } }
  const runs = (raw as Record<string, unknown>).runs
  if (!Array.isArray(runs) || runs.length === 0) return { ok: false, error: { code: 'LAB_SPEC_INVALID', message: 'compare.runs must be a non-empty array' } }
  if (runs.length > COMPARE_MAX_RUNS) return { ok: false, error: { code: 'LAB_SPEC_INVALID', message: `compare.runs must be at most ${COMPARE_MAX_RUNS}, got ${runs.length}` } }

  const out: RunPublicView[] = []
  for (const leg of runs) {
    const outcome = runBacktestTool(leg, runner, runStore, meter, datasetsDir)
    if (!outcome.ok) return { ok: false, error: outcome.error }
    out.push(outcome.result)
  }
  return { ok: true, result: out }
}

export const COMPARE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'compare',
    description: `Run 2+ (max ${COMPARE_MAX_RUNS}) scenarios and return their metrics side by side. Use this instead of several run_backtest calls when the user wants scenarios compared.`,
    parameters: {
      type: 'object',
      properties: {
        runs: {
          type: 'array',
          minItems: 1,
          maxItems: COMPARE_MAX_RUNS,
          items: RUN_BACKTEST_SCHEMA.function.parameters,
        },
      },
      required: ['runs'],
      additionalProperties: false,
    },
  },
}

// ---------------------------------------------------------------------------
// sweep (AL-12, LAB-AL-07): one base, up to SWEEP_MAX_WIDTHS widthTicks values, one deposit, over TRAIN windows
// (named explicitly, or every TRAIN window that can run that base by default) — a per (window, widthTicks) row
// table, each successful row with its own citable `runId`. Sequential: each row is one `runBacktestTool` call,
// so every run lands in the job's run list and its CPU ms in the meter exactly like a plain `run_backtest` call.
// ---------------------------------------------------------------------------

/** Not one of spec 008's named reason codes — a tool-local protocol code, never thrown as a `ReasonError`. */
export const LAB_TOOL_UNAVAILABLE = 'LAB_TOOL_UNAVAILABLE'

export const SWEEP_MAX_WIDTHS = 6
export const SWEEP_MAX_ROWS = 24

export type SweepArgs = { base: Base; widthTicks: number[]; deposit: number; windows?: string[] }

export type SweepRowMetrics = { end: number; vsHodl: number; fees: number; gas: number; returnBps: number; maxDrawdownBps: number }
export type SweepRow = { windowId: string; widthTicks: number } & ({ runId: string; metrics: SweepRowMetrics } | { error: ToolError })
export type SweepResult = { rows: SweepRow[] }

function isValidWidthTicks(w: unknown): w is number {
  return typeof w === 'number' && Number.isInteger(w) && w >= WIDTH_TICKS_MIN && w <= WIDTH_TICKS_MAX && w % WIDTH_TICKS_STEP === 0
}

function parseSweepArgs(raw: unknown): SweepArgs | ToolError {
  if (typeof raw !== 'object' || raw === null) return { code: 'LAB_SPEC_INVALID', message: 'sweep args must be an object' }
  const a = raw as Record<string, unknown>
  if (a.base !== 'live' && a.base !== 'guard') return { code: 'LAB_SPEC_INVALID', message: `base must be "live" or "guard", got ${JSON.stringify(a.base)}` }
  if (!Array.isArray(a.widthTicks) || a.widthTicks.length === 0) return { code: 'LAB_SPEC_INVALID', message: 'widthTicks must be a non-empty array of numbers' }
  if (a.widthTicks.length > SWEEP_MAX_WIDTHS) return { code: 'LAB_SPEC_INVALID', message: `widthTicks must have at most ${SWEEP_MAX_WIDTHS} values, got ${a.widthTicks.length}` }
  for (const w of a.widthTicks) {
    if (!isValidWidthTicks(w)) return { code: 'LAB_SPEC_INVALID', message: `widthTicks values must be integers ${WIDTH_TICKS_MIN}..${WIDTH_TICKS_MAX} in steps of ${WIDTH_TICKS_STEP}, got ${JSON.stringify(w)}` }
  }
  if (typeof a.deposit !== 'number' || !Number.isInteger(a.deposit) || a.deposit < DEPOSIT_MIN_USDC || a.deposit > DEPOSIT_MAX_USDC) {
    return { code: 'LAB_SPEC_INVALID', message: `deposit must be a whole USDC amount ${DEPOSIT_MIN_USDC}..${DEPOSIT_MAX_USDC}, got ${JSON.stringify(a.deposit)}` }
  }
  if (a.windows !== undefined) {
    if (!Array.isArray(a.windows) || !a.windows.every((w) => typeof w === 'string')) {
      return { code: 'LAB_SPEC_INVALID', message: 'windows must be an array of window ids' }
    }
    if (a.windows.length === 0) return { code: 'LAB_SPEC_INVALID', message: 'windows must not be empty when provided — omit it instead to sweep every runnable TRAIN window' }
  }
  return { base: a.base, widthTicks: a.widthTicks, deposit: a.deposit, windows: a.windows as string[] | undefined }
}

function trainWindowsIn(datasetsDir?: string) {
  return datasetsDir === undefined ? trainWindows() : trainWindows(datasetsDir)
}
function basesForWindowIn(windowId: string, datasetsDir?: string) {
  return datasetsDir === undefined ? basesForWindow(windowId) : basesForWindow(windowId, datasetsDir)
}
function manifestWindowIn(id: string, datasetsDir?: string) {
  return datasetsDir === undefined ? manifestWindow(id) : manifestWindow(id, datasetsDir)
}

function subsetOf(m: RunResult['metrics']): SweepRowMetrics {
  return { end: m.end, vsHodl: m.vsHodl, fees: m.fees, gas: m.gas, returnBps: m.returnBps, maxDrawdownBps: m.maxDrawdownBps }
}

export function sweepTool(raw: unknown, runner: BenchRunner, runStore: RunStore, meter?: CostMeter, datasetsDir?: string): ToolOutcome<SweepResult> {
  const parsed = parseSweepArgs(raw)
  if ('code' in parsed) return { ok: false, error: parsed }

  let windowIds: string[]
  if (parsed.windows) {
    // AL-12a: every named window is resolved against the manifest BEFORE any run — a TEST window (or an id the
    // manifest doesn't have at all) refuses the WHOLE sweep up front. This is deliberately not a per-row
    // degradation the way LAB_DATASET_MISSING is: the holdout must never be reachable even partially.
    for (const id of parsed.windows) {
      try {
        const w = manifestWindowIn(id, datasetsDir)
        if (w.split !== 'train') return { ok: false, error: { code: 'LAB_HOLDOUT_DENIED', message: `${id} is a TEST window; the Lab never reaches the release gate's holdout` } }
      } catch (e) {
        return { ok: false, error: reasonToolError(e) }
      }
    }
    windowIds = parsed.windows
  } else {
    windowIds = trainWindowsIn(datasetsDir)
      .filter((w) => basesForWindowIn(w.id, datasetsDir).includes(parsed.base))
      .map((w) => w.id)
  }

  const totalRows = windowIds.length * parsed.widthTicks.length
  if (totalRows > SWEEP_MAX_ROWS) {
    return { ok: false, error: { code: 'LAB_SPEC_INVALID', message: `sweep would run ${totalRows} (window x widthTicks) combinations, over the cap of ${SWEEP_MAX_ROWS}` } }
  }
  if (totalRows === 0) {
    return { ok: false, error: { code: 'LAB_DATASET_MISSING', message: `no TRAIN window can run base "${parsed.base}"` } }
  }

  const rows: SweepRow[] = []
  for (const windowId of windowIds) {
    for (const widthTicks of parsed.widthTicks) {
      const outcome = runBacktestTool({ windowId, base: parsed.base, deposit: parsed.deposit, overrides: { widthTicks } }, runner, runStore, meter)
      rows.push(outcome.ok ? { windowId, widthTicks, runId: outcome.result.runId, metrics: subsetOf(outcome.result.metrics) } : { windowId, widthTicks, error: outcome.error })
    }
  }
  return { ok: true, result: { rows } }
}

export const SWEEP_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'sweep',
    description: `Run one base across up to ${SWEEP_MAX_WIDTHS} widthTicks values, one deposit, over TRAIN windows (omit "windows" to sweep every TRAIN window that can run this base). Returns a per (window, widthTicks) row table — a window/width combo that can't run appears as a row with an error, never silently dropped. Max ${SWEEP_MAX_ROWS} total runs.`,
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'string', enum: ['live', 'guard'] },
        widthTicks: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: SWEEP_MAX_WIDTHS, description: `${WIDTH_TICKS_MIN}..${WIDTH_TICKS_MAX}, step ${WIDTH_TICKS_STEP}.` },
        deposit: { type: 'number', description: `Whole USDC, ${DEPOSIT_MIN_USDC}..${DEPOSIT_MAX_USDC}.` },
        windows: { type: 'array', items: { type: 'string' }, description: 'Optional. TRAIN window ids from the catalog. Omit to sweep every TRAIN window that can run this base.' },
      },
      required: ['base', 'widthTicks', 'deposit'],
      additionalProperties: false,
    },
  },
}

export const AGENT_TOOL_SCHEMAS: ToolSchema[] = [RUN_BACKTEST_SCHEMA, COMPARE_SCHEMA, SWEEP_SCHEMA]

/** Every reason code a tool call can surface to the model. */
export const TOOL_REASON_CODES: readonly ReasonCode[] = ['LAB_SPEC_INVALID', 'LAB_HOLDOUT_DENIED', 'LAB_DATASET_MISSING', 'LAB_OVERRIDE_UNKNOWN']
