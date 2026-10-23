// Agent Lab agent (008 task 4, otto/mamoru#200): the tools the model can call (AL-10...AL-13, AL-12a).
// `run_backtest` and `compare` run over a `BenchRunner`; `sweep` is a named stub for v1 (AL-12 exists as a tool
// the catalog advertises, but it always answers `LAB_TOOL_UNAVAILABLE` — a real sweep tool is later work, flagged
// in the PR, not one of spec 008's named reason codes). Every run a tool returns successfully is recorded into
// the job's `RunStore` by its `resultHash` (AL-21: only a run the job itself produced or fetched is citable).
import { ReasonError, type ReasonCode } from '@mamoru/domain'
import { DEPOSIT_MAX_USDC, DEPOSIT_MIN_USDC, runBench, WIDTH_TICKS_MAX, WIDTH_TICKS_MIN, WIDTH_TICKS_STEP, type Base } from '@mamoru/lab-bench'
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

function parseRunBacktestArgs(raw: unknown): RunBacktestArgs | ToolError {
  if (typeof raw !== 'object' || raw === null) return { code: 'LAB_SPEC_INVALID', message: 'run_backtest args must be an object' }
  const a = raw as Record<string, unknown>
  if (typeof a.windowId !== 'string' || a.windowId.length === 0) return { code: 'LAB_SPEC_INVALID', message: 'windowId must be a non-empty string' }
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
  return { windowId: a.windowId, base: a.base, deposit: a.deposit, overrides: a.overrides as RunBacktestArgs['overrides'] }
}

/** B-01's default width (the base policy's own `range.widthTicks`, 2000) when no override is given. */
const DEFAULT_WIDTH_TICKS = 2000

export function runBacktestTool(raw: unknown, runner: BenchRunner, runStore: RunStore, meter?: CostMeter): ToolOutcome<RunPublicView> {
  const parsed = parseRunBacktestArgs(raw)
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
    description: 'Replay one TRAIN window through one base policy and return its metrics, window and op count.',
    parameters: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'A TRAIN window id from the catalog in the system prompt.' },
        base: { type: 'string', enum: ['live', 'guard'], description: '"live" (conservador-live-v2) or "guard" (conservador-lab-guards-v1).' },
        deposit: { type: 'number', description: `Whole USDC, ${DEPOSIT_MIN_USDC}..${DEPOSIT_MAX_USDC}.` },
        overrides: {
          type: 'object',
          properties: { widthTicks: { type: 'number', description: `${WIDTH_TICKS_MIN}..${WIDTH_TICKS_MAX}, step ${WIDTH_TICKS_STEP}.` } },
          additionalProperties: false,
          description: 'Optional. The only known override key is widthTicks; any other key is a tool error.',
        },
      },
      required: ['windowId', 'base', 'deposit'],
      additionalProperties: false,
    },
  },
}

// ---------------------------------------------------------------------------
// compare (AL-11): up to 8 runs, same args shape as run_backtest, one per leg. The agent must use this instead
// of several run_backtest calls when the user wants scenarios side by side (AL-14, no list_* tools either way).
// ---------------------------------------------------------------------------

export const COMPARE_MAX_RUNS = 8

export function compareTool(raw: unknown, runner: BenchRunner, runStore: RunStore, meter?: CostMeter): ToolOutcome<RunPublicView[]> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: { code: 'LAB_SPEC_INVALID', message: 'compare args must be an object' } }
  const runs = (raw as Record<string, unknown>).runs
  if (!Array.isArray(runs) || runs.length === 0) return { ok: false, error: { code: 'LAB_SPEC_INVALID', message: 'compare.runs must be a non-empty array' } }
  if (runs.length > COMPARE_MAX_RUNS) return { ok: false, error: { code: 'LAB_SPEC_INVALID', message: `compare.runs must be at most ${COMPARE_MAX_RUNS}, got ${runs.length}` } }

  const out: RunPublicView[] = []
  for (const leg of runs) {
    const outcome = runBacktestTool(leg, runner, runStore, meter)
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
// sweep (AL-12): named stub in v1. Always a tool error — never calls the runner, never spends a budget.
// ---------------------------------------------------------------------------

export const LAB_TOOL_UNAVAILABLE = 'LAB_TOOL_UNAVAILABLE'

export function sweepTool(): ToolOutcome<never> {
  return {
    ok: false,
    error: {
      code: LAB_TOOL_UNAVAILABLE,
      message: 'sweep is not implemented in v1 (otto/mamoru#200, task 4): use run_backtest or compare for individual TRAIN windows instead.',
    },
  }
}

export const SWEEP_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'sweep',
    description: 'NOT AVAILABLE in v1 — calling this always returns a tool error. Use run_backtest/compare instead.',
    parameters: {
      type: 'object',
      properties: {
        policyId: { type: 'string' },
        overrides: { type: 'array', items: { type: 'object' } },
        windows: { type: 'array', items: { type: 'string' } },
      },
      required: ['policyId', 'overrides'],
      additionalProperties: false,
    },
  },
}

export const AGENT_TOOL_SCHEMAS: ToolSchema[] = [RUN_BACKTEST_SCHEMA, COMPARE_SCHEMA, SWEEP_SCHEMA]

/** Every reason code a tool call can surface to the model, besides the v1-only `LAB_TOOL_UNAVAILABLE` stub. */
export const TOOL_REASON_CODES: readonly ReasonCode[] = ['LAB_SPEC_INVALID', 'LAB_HOLDOUT_DENIED', 'LAB_DATASET_MISSING', 'LAB_OVERRIDE_UNKNOWN']
