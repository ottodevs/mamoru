/**
 * Agent Lab runner (spec 008 phase 2, task 5, otto/mamoru#204): Bun Worker entry for an AGENT job — the whole
 * `packages/lab-agent` loop (model calls AND tool calls) runs off the CLI's main thread, same reasoning as
 * `run-worker.ts`'s bench job: a tool call (`run_backtest`/`compare`/`sweep`, `runBench` underneath) is long and
 * synchronous, and a `sweep` can chain up to `SWEEP_MAX_ROWS` of them inside ONE tool round — on the main thread
 * that would starve the heartbeat's timer for the whole round (the exact bug `run-worker.ts` was built to avoid
 * for bench jobs, #117 P1). Model calls happen here too (CONTRACT: "heartbeat every 30s through the whole job
 * including model calls") — Bun workers have their own `fetch`, so network I/O inside this thread never blocks
 * the main thread's heartbeat either way; this is purely about not starving this worker's OWN event loop with a
 * synchronous compute burst, exactly as for bench jobs.
 *
 * Holds no landing credential: `LAB_RUNNER_SECRET` and all network to the landing stay on the main thread
 * (`cli.ts`). This worker only talks to model-plane (loopback, no auth) and reads local dataset files.
 */
import { ReasonError } from '@mamoru/domain'
import { buildCatalogPrompt, LabBenchRunner, runAgentJob, type Answer, type BenchRunner, type BenchSpec, type CostMeter, type JobContext, type PriorTurn, type RunResult, type VerifierOutcome, type VerifyError } from '@mamoru/lab-agent'
import { ModelPlaneClient } from './model-plane-client.ts'
import type { WorkerBudgetControl, WorkerRunsProgress } from './run-in-worker.ts'

export type AgentWorkerPayload = {
  question: string
  priorTurns: PriorTurn[]
  datasetsDir: string
  modelPlaneUrl: string
  models: string[]
}

export type AgentWorkerResult =
  | {
      kind: 'ok'
      answer: Answer
      verifierOutcome: VerifierOutcome
      verifierErrors: VerifyError[]
      flagged: 'LAB_ANSWER_PARTIAL' | null
      runHashes: string[]
      meter: CostMeter
    }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'bug'; message: string }

declare const self: Worker

/** AL-04: "15 min when it starts a sweep". Re-armed from the moment `sweep` is first dispatched, not from job
 * start — simpler to implement than tracking job-start-relative deadlines across the worker/main-thread
 * boundary, and never LESS generous than the spec's own wording. */
const SWEEP_BUDGET_MS = 15 * 60_000

function sendRunsProduced(runs: RunResult[]): void {
  if (runs.length === 0) return
  const msg: WorkerRunsProgress = { __labControl: 'runs-produced', runs }
  postMessage(msg)
}

/** Publishes each run to the main thread AS SOON AS it is produced (AL-04: "keeping any finished runs" — see
 * `run-in-worker.ts`'s `WorkerRunsProgress` doc for why this survives a later timeout even though the worker
 * that produced it gets killed). Wraps `LabBenchRunner` rather than touching it: `run()` stays synchronous. */
function progressReportingRunner(inner: BenchRunner): BenchRunner {
  const seen = new Set<string>()
  return {
    run(spec: BenchSpec): RunResult {
      const result = inner.run(spec)
      if (!seen.has(result.resultHash)) {
        seen.add(result.resultHash)
        sendRunsProduced([result])
      }
      return result
    },
  }
}

self.onmessage = async (ev: MessageEvent<AgentWorkerPayload>): Promise<void> => {
  const { question, priorTurns, datasetsDir, modelPlaneUrl, models } = ev.data
  try {
    const catalog = buildCatalogPrompt(datasetsDir)
    const runner = progressReportingRunner(new LabBenchRunner(datasetsDir))
    const model = new ModelPlaneClient({ baseUrl: modelPlaneUrl, models })

    let sweepBudgetSent = false
    const ctx: JobContext = {
      model,
      runner,
      systemPrompt: catalog.systemPrompt,
      catalogIds: catalog.catalogIds,
      catalogYears: catalog.years,
      datasetsDir,
      onToolCall: (name) => {
        if (name === 'sweep' && !sweepBudgetSent) {
          sweepBudgetSent = true
          const control: WorkerBudgetControl = { __labControl: 'extend-budget', ms: SWEEP_BUDGET_MS }
          postMessage(control)
        }
      },
    }

    const result = await runAgentJob({ question, priorTurns }, ctx)
    const out: AgentWorkerResult = {
      kind: 'ok',
      answer: result.answer,
      verifierOutcome: result.verifierOutcome,
      verifierErrors: result.verifierErrors,
      flagged: result.flagged,
      runHashes: result.runs.map((r) => r.resultHash),
      meter: result.meter,
    }
    postMessage(out)
  } catch (e) {
    // `ModelPlaneClient.complete()` throws `ReasonError('LAB_MODEL_UNAVAILABLE', ...)` when every configured
    // resource fails this job (AL-30) — that is a business outcome, not a bug, so it gets its own code instead
    // of falling into the generic branch `cli.ts` treats as "unexpected, leave it to lease expiry".
    // Only a ReasonError is a business outcome to post (e.g. LAB_MODEL_UNAVAILABLE). Anything else (ENOENT, a
    // bug) is left to lease expiry like the bench path does, so a system error code never reaches /result.
    const out: AgentWorkerResult =
      e instanceof ReasonError
        ? { kind: 'error', code: e.code, message: e.message }
        : { kind: 'bug', message: e instanceof Error ? e.message : String(e) }
    postMessage(out)
  }
}
