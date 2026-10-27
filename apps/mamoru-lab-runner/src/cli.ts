#!/usr/bin/env bun
/**
 * Agent Lab bench + agent runner (spec 008, B-03/B-12, task 5 otto/mamoru#204). Claims jobs from the landing
 * Worker's signed runner API, computes them with the production engine (`@mamoru/lab-bench`, over local dataset
 * files) or the Agent Lab agent (`@mamoru/lab-agent`, over a model-plane client), and posts results back. Holds
 * no wallet key, no RPC key and no D1 credential — only `LAB_RUNNER_SECRET` (B-05 signing), the dataset files on
 * disk (Architecture), and a loopback call to model-plane for agent jobs (no auth needed there — see
 * `model-plane-client.ts`).
 *
 * Commands:
 *   run             claim / heartbeat / result loop — what the systemd unit runs (bench AND agent jobs)
 *   seed            the B-03 catalog matrix, published without a job
 *   once <specKey>  compute one bench spec locally and print a summary — no network, no env beyond LAB_DATASETS
 *   ask "<q>" [--window <id>]
 *                   run the agent loop locally against the real model-plane client and real datasets, print the
 *                   answer + cost — no network to the landing at all (smoke test, task 5's own deliverable)
 *
 * Env: LAB_RUNNER_URL (e.g. https://mamoru.lol), LAB_RUNNER_SECRET, LAB_DATASETS (default
 * ~/.local/share/mamoru-lab/datasets), MODEL_PLANE_URL (default http://127.0.0.1:3500), LAB_AGENT_MODELS
 * (comma-separated model-plane aliases, ordered — AL-30), LAB_AGENT_DAILY_BUDGET (default 30, AL-04/contract).
 * `run` and `seed` need the landing env; `once` and `ask` need neither.
 */
import { ReasonError } from '@mamoru/domain'
import type { Answer, PriorTurn, RunResult as AgentRunResult } from '@mamoru/lab-agent'
import { basesForWindow, defaultDatasetsDir, parseSpecKey, runBench, specKey, trainWindows, type Base, type BenchSpec, type RunResult } from '@mamoru/lab-bench'
import { checkAndIncrementAgentBudget, LAB_AGENT_BUDGET } from './agent-budget.ts'
import { labAgentModelsFromEnv, MODEL_PLANE_DEFAULT_URL } from './model-plane-client.ts'
import { runInWorker } from './run-in-worker.ts'
import type { AgentWorkerPayload, AgentWorkerResult } from './run-agent-worker.ts'
import type { RunWorkerPayload, RunWorkerResult } from './run-worker.ts'
import { signRequest } from './sign.ts'

const RUN_WORKER_URL = new URL('./run-worker.ts', import.meta.url)
const AGENT_WORKER_URL = new URL('./run-agent-worker.ts', import.meta.url)
/** AL-02's lease expiry is 120s ahead and renews every 30s; this matches the renewal cadence. Also what an
 * agent job's heartbeat uses — the CONTRACT's "heartbeat every 30s through the whole job including model
 * calls" is the same cadence, not a second number. `LAB_HEARTBEAT_INTERVAL_MS` overrides it (test seam only —
 * a real run always wants the AL-02 default; a fast unit test can't wait out a real 30s tick to prove heartbeats
 * fire during a slow model call, the way run-in-worker.test.ts's fixtures already prove it for a slow tool call). */
function heartbeatIntervalMs(): number {
  const v = Number(process.env.LAB_HEARTBEAT_INTERVAL_MS)
  return Number.isFinite(v) && v > 0 ? v : 30_000
}
/** AL-04: "120s for chat tools" — the agent job's initial wall-clock budget, extended to 15 min the moment a
 * `sweep` tool call starts (see `run-agent-worker.ts`'s `SWEEP_BUDGET_MS`). */
const AGENT_JOB_BUDGET_MS = 120_000

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

function datasetsDir(): string {
  return process.env.LAB_DATASETS ?? defaultDatasetsDir()
}

function modelPlaneUrl(): string {
  return process.env.MODEL_PLANE_URL ?? MODEL_PLANE_DEFAULT_URL
}

/** The seed matrix (B-03): every TRAIN window x {live 2000, live 4000, guard 2000} x 1000 USDC. */
const SEED_VARIANTS: readonly { base: Base; widthTicks: number }[] = [
  { base: 'live', widthTicks: 2000 },
  { base: 'live', widthTicks: 4000 },
  { base: 'guard', widthTicks: 2000 },
]
const SEED_DEPOSIT = 1000

async function signedPost(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const url = new URL(path, requireEnv('LAB_RUNNER_URL')).toString()
  const text = JSON.stringify(body ?? {})
  const headers = await signRequest(requireEnv('LAB_RUNNER_SECRET'), 'POST', path, text)
  const res = await fetch(url, { method: 'POST', headers, body: text })
  const json = res.status === 204 || res.status === 404 ? null : await res.json().catch(() => null)
  return { status: res.status, json }
}

// ---------------------------------------------------------------------------
// Claim: bench jobs keep their existing shape; an agent job is a new `kind` (CONTRACT, otto/mamoru#204, shared
// with the landing session building task 6). `kind` missing or `'bench'` is read as a bench job, so this runner
// stays compatible with the landing's current claim response (no `kind` field at all yet) as well as the one
// task 6 ships.
// ---------------------------------------------------------------------------

type BenchClaimedJob = { kind: 'bench'; id: string; spec: BenchSpec; leaseId: string }
type AgentHistoryTurn = { question: string; answer: Answer }
type AgentClaimedJob = { kind: 'agent'; id: string; leaseId: string; threadId: string; question: string; history: AgentHistoryTurn[] }
type ClaimedJob = BenchClaimedJob | AgentClaimedJob

type Outcome = { run: RunResult } | { error: string }

async function claim(): Promise<ClaimedJob | null> {
  const { status, json } = await signedPost('/ops/lab/runner/claim', {})
  if (status === 204) return null
  if (status !== 200) throw new Error(`claim: unexpected status ${status}`)
  const job = (json as { job: Record<string, unknown> }).job
  if (job.kind === 'agent') {
    return {
      kind: 'agent',
      id: job.id as string,
      leaseId: job.leaseId as string,
      threadId: job.threadId as string,
      question: job.question as string,
      history: Array.isArray(job.history) ? (job.history as AgentHistoryTurn[]) : [],
    }
  }
  return { kind: 'bench', id: job.id as string, spec: job.spec as BenchSpec, leaseId: job.leaseId as string }
}

/** True while the lease still holds. A 409 (`LAB_JOB_LEASE_LOST`) or any other failure means it may not. */
async function heartbeat(jobId: string, leaseId: string): Promise<boolean> {
  try {
    const { status } = await signedPost('/ops/lab/runner/heartbeat', { jobId, leaseId })
    return status === 200
  } catch {
    return false
  }
}

async function postResult(jobId: string, leaseId: string, extra: Record<string, unknown>): Promise<void> {
  const { status } = await signedPost('/ops/lab/runner/result', { jobId, leaseId, ...extra })
  if (status !== 200 && status !== 409) console.error(`result ${jobId}: unexpected status ${status}`)
}

/** Review of #117 P2: a non-2xx used to be logged and swallowed, so `seed` reported a spec "published" that never
 * actually landed. Throwing makes the caller's own accounting (published/skipped/failed) the only source of truth.
 * Also used by agent jobs (CONTRACT: "before finishing, POST each produced run to /publish; runs never travel
 * inside the result" — the 1MB body cap on /result). */
async function publish(run: RunResult): Promise<void> {
  const { status } = await signedPost('/ops/lab/runner/publish', { run })
  if (status < 200 || status >= 300) throw new Error(`publish ${run.specKey}: status ${status}`)
}

/** A business refusal has a closed reason code; anything else is a bug, not a result to report. */
function reasonCodeOf(e: unknown): string | null {
  return e instanceof ReasonError ? e.code : null
}

// ---------------------------------------------------------------------------
// Bench jobs (unchanged from phase 1, B-12 / otto/mamoru#199 review of #117 P1) — moved into its own function so
// `runJob` can dispatch by `kind`.
// ---------------------------------------------------------------------------

async function runBenchJob(job: BenchClaimedJob): Promise<void> {
  const outcome = await runInWorker<RunWorkerPayload, RunWorkerResult>(
    RUN_WORKER_URL,
    { spec: job.spec, datasetsDir: datasetsDir() },
    { heartbeat: () => heartbeat(job.id, job.leaseId), intervalMs: heartbeatIntervalMs() },
  )
  if ('leaseLost' in outcome) {
    console.error(`job ${job.id}: lease lost mid-flight, not posting`)
    return
  }
  if ('timedOut' in outcome) {
    // Bench jobs never pass `budgetMs`, so this never actually fires — kept only so this stays exhaustive
    // against `runInWorker`'s shared 3-outcome type (AL-04 added `timedOut` for agent jobs).
    console.error(`job ${job.id}: unexpected timeout (bench jobs carry no budget) — leaving it to lease expiry`)
    return
  }
  const wr = outcome.result
  if (wr.kind === 'bug') {
    console.error(`job ${job.id} (${specKey(job.spec)}): unexpected error, leaving it to lease expiry: ${wr.message}`)
    return
  }
  const toPost: Outcome = wr.kind === 'run' ? { run: wr.run } : { error: wr.code }
  await postResult(job.id, job.leaseId, toPost)
  console.log(`job ${job.id}: ${'run' in toPost ? toPost.run.specKey : toPost.error}`)
}

// ---------------------------------------------------------------------------
// Agent jobs (task 5, AL-30...AL-32, AL-04). The whole agent loop (model calls + tool calls) runs in a Worker
// thread, same reasoning as bench jobs — see run-agent-worker.ts's own header comment.
// ---------------------------------------------------------------------------

/** AL-03's own words: history carries questions and verified answers, never raw tool output. The claim response
 * (CONTRACT, shared with the landing session building task 6) carries only `{question, answer}` per turn — no
 * run records at all — so a prior turn's `runs` is always `[]` here. `renderAnswerForHistory` (packages/lab-agent)
 * already treats a missing run as "drop this line", never a crash, so this degrades gracefully: a follow-up
 * still sees the prior QUESTION and whatever prose had no run-backed claim/verdict, but loses the concrete
 * numbers of any claim/verdict the prior turn made (its run isn't in this job's store to resolve the tag). This
 * is a real gap in the given claim-response shape, not something this runner can fix on its own — flagged in the
 * PR body with the two ways to close it (the claim response also carrying each cited run, or a landing endpoint
 * to fetch a run by hash on demand).
 */
function priorTurnsFromHistory(history: AgentHistoryTurn[]): PriorTurn[] {
  return history.map((h) => ({ question: h.question, answer: h.answer, runs: [] as AgentRunResult[] }))
}

/** Publish is idempotent (same hash), so a transient 5xx or network blip is retried before giving up. */
async function publishWithRetry(r: RunResult, attempts = 3): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await publish(r)
    } catch (e) {
      if (i >= attempts) throw e
      await new Promise((ok) => setTimeout(ok, 1000 * i))
    }
  }
}

async function runAgentJobClaimed(job: AgentClaimedJob): Promise<void> {
  const budget = checkAndIncrementAgentBudget({ statePath: process.env.LAB_AGENT_BUDGET_STATE })
  if (!budget.ok) {
    await postResult(job.id, job.leaseId, { error: LAB_AGENT_BUDGET })
    console.log(`job ${job.id}: refused, ${LAB_AGENT_BUDGET} (${budget.count}/${budget.limit} agent jobs today)`)
    return
  }

  const payload: AgentWorkerPayload = {
    question: job.question,
    priorTurns: priorTurnsFromHistory(job.history),
    datasetsDir: datasetsDir(),
    modelPlaneUrl: modelPlaneUrl(),
    models: labAgentModelsFromEnv(),
  }

  const pendingPublishes: Promise<void>[] = []
  const unpublished: string[] = []
  const outcome = await runInWorker<AgentWorkerPayload, AgentWorkerResult>(AGENT_WORKER_URL, payload, {
    heartbeat: () => heartbeat(job.id, job.leaseId),
    intervalMs: heartbeatIntervalMs(),
    budgetMs: AGENT_JOB_BUDGET_MS,
    // CONTRACT: "before finishing, the runner POSTs each produced run to /publish (idempotent)". Firing this as
    // soon as a run exists — not only once the whole job is done — is also what AL-04's "keeping any finished
    // runs" means in practice: these are plain fetches on THIS (the main) thread, so a later `worker.terminate()`
    // (budget timeout or lease loss) never aborts one already in flight. Errors are logged, not thrown: a
    // publish failure must never crash the runner's claim/heartbeat loop.
    onRunsProduced: (runs) => {
      for (const r of runs as RunResult[]) {
        pendingPublishes.push(
          publishWithRetry(r).catch((e) => {
            unpublished.push(r.resultHash)
            console.error(`job ${job.id}: publish ${r.resultHash} failed: ${e instanceof Error ? e.message : e}`)
          }),
        )
      }
    },
  })

  await Promise.all(pendingPublishes)

  if ('leaseLost' in outcome) {
    console.error(`job ${job.id}: lease lost mid-flight, not posting (any run already produced was still published above)`)
    return
  }
  if ('timedOut' in outcome) {
    await postResult(job.id, job.leaseId, { error: 'LAB_JOB_TIMEOUT' })
    console.log(`job ${job.id}: LAB_JOB_TIMEOUT`)
    return
  }

  const wr = outcome.result
  if (wr.kind === 'bug') {
    console.error(`job ${job.id}: unexpected error, leaving it to lease expiry: ${wr.message}`)
    return
  }
  if (wr.kind === 'error') {
    await postResult(job.id, job.leaseId, { error: wr.code })
    console.log(`job ${job.id}: ${wr.code}`)
    return
  }

  // Never post an answer that cites a run the store does not have: leave the job to lease expiry instead.
  const missing = wr.runHashes.filter((h) => unpublished.includes(h))
  if (missing.length > 0) {
    console.error(`job ${job.id}: ${missing.length} cited run(s) not published, leaving it to lease expiry`)
    return
  }

  await postResult(job.id, job.leaseId, {
    kind: 'agent',
    answer: wr.answer,
    verifier: { outcome: wr.verifierOutcome, errors: wr.verifierErrors },
    cost: wr.meter,
    runHashes: wr.runHashes,
  })
  console.log(`job ${job.id}: agent answer, verifier=${wr.verifierOutcome}${wr.flagged ? ` (${wr.flagged})` : ''}, runs=${wr.runHashes.length}`)
}

async function runJob(job: ClaimedJob): Promise<void> {
  if (job.kind === 'agent') return runAgentJobClaimed(job)
  return runBenchJob(job)
}

async function cmdRun(): Promise<void> {
  const IDLE_MIN_MS = 5_000
  const IDLE_MAX_MS = 30_000
  let idleMs = IDLE_MIN_MS
  for (;;) {
    let job: ClaimedJob | null = null
    try {
      job = await claim()
    } catch (e) {
      console.error('claim failed:', e instanceof Error ? e.message : e)
    }
    if (job) {
      idleMs = IDLE_MIN_MS
      await runJob(job)
    } else {
      await new Promise((resolve) => setTimeout(resolve, idleMs))
      idleMs = Math.min(IDLE_MAX_MS, idleMs * 2)
    }
  }
}

type SeedSummary = { published: number; skipped: number; failed: number }

/** 1 if anything failed, so a cron/systemd run surfaces it instead of a silently short catalog; 0 otherwise. */
function seedExitCode(summary: SeedSummary): number {
  return summary.failed > 0 ? 1 : 0
}

/**
 * B-03. Three disjoint outcomes per spec, counted apart (review of #117 P2):
 * - `skipped`: known upfront — `basesForWindow` already says this (window, base) has no data (`LAB_DATASET_MISSING`).
 * - `failed`: the compute or the publish itself did not succeed — a spec a reviewer or the coordinator must look at.
 * - `published`: `publish` returned 2xx; nothing else counts as published.
 * Returns the summary rather than touching `process.exitCode` itself: `main` decides (via `seedExitCode`) — kept
 * separate so a test can assert on this function's own counts without mutating the real, process-wide exit code.
 */
async function cmdSeed(): Promise<SeedSummary> {
  const dir = datasetsDir()
  const windows = trainWindows(dir)
  if (windows.length === 0) throw new Error(`no TRAIN window in the manifest at ${dir}`)
  let published = 0
  let skipped = 0
  let failed = 0
  for (const w of windows) {
    const available = basesForWindow(w.id, dir)
    for (const { base, widthTicks } of SEED_VARIANTS) {
      const spec: BenchSpec = { windowId: w.id, base, widthTicks, deposit: SEED_DEPOSIT }
      if (!available.includes(base)) {
        console.error(`skip ${specKey(spec)}: LAB_DATASET_MISSING`)
        skipped++
        continue
      }
      try {
        const run = runBench(spec, dir)
        await publish(run)
        console.log(`seed ${specKey(spec)}: published (${run.resultHash})`)
        published++
      } catch (e) {
        const code = reasonCodeOf(e)
        console.error(`seed ${specKey(spec)}: failed — ${code ?? (e instanceof Error ? e.message : String(e))}`)
        failed++
      }
    }
  }
  const summary: SeedSummary = { published, skipped, failed }
  console.log(`seed done: ${summary.published} published, ${summary.skipped} skipped, ${summary.failed} failed`)
  return summary
}

function cmdOnce(spec: BenchSpec): void {
  const r = runBench(spec, datasetsDir())
  console.log(JSON.stringify({ specKey: r.specKey, variantLabel: r.variantLabel, policyId: r.policyId, resultHash: r.resultHash, simVersion: r.simVersion, deposit: r.deposit, pools: r.pools, metrics: r.metrics, seriesPoints: r.series.length, ops: r.ops.length }, null, 2))
}

function specFromArgs(args: string[]): BenchSpec {
  if (args.length === 1) return parseSpecKey(args[0]!)
  if (args.length === 4) {
    const [windowId, base, widthTicks, deposit] = args as [string, string, string, string]
    if (base !== 'live' && base !== 'guard') throw new Error(`base must be live or guard, got ${base}`)
    return { windowId, base, widthTicks: Number(widthTicks), deposit: Number(deposit) }
  }
  throw new Error('usage: once <windowId>|<base>|<widthTicks>|<deposit>  (or: once <windowId> <base> <widthTicks> <deposit>, to dodge the shell pipe)')
}

// ---------------------------------------------------------------------------
// ask: task 5's own local smoke test — the real agent loop, the real model-plane client, the real datasets. No
// network to the landing at all: no claim, no heartbeat, no publish, no result. Runs on this thread directly
// (not a worker — there is no lease to protect here, and a one-off CLI call can block as long as it needs to).
// ---------------------------------------------------------------------------

function parseAskArgs(args: string[]): { question: string; window?: string } {
  const windowIdx = args.indexOf('--window')
  let window: string | undefined
  let rest = args
  if (windowIdx !== -1) {
    window = args[windowIdx + 1]
    if (!window) throw new Error('usage: ask "<question>" [--window <id>] — --window needs a value')
    rest = [...args.slice(0, windowIdx), ...args.slice(windowIdx + 2)]
  }
  const question = rest.join(' ').trim()
  if (!question) throw new Error('usage: ask "<question>" [--window <id>]')
  return { question, window }
}

async function cmdAsk(args: string[]): Promise<void> {
  const { buildCatalogPrompt, LabBenchRunner, renderAnswerForHistory, runAgentJob } = await import('@mamoru/lab-agent')
  const { question, window } = parseAskArgs(args)
  const dir = datasetsDir()
  const models = labAgentModelsFromEnv()
  console.error(`model-plane: ${modelPlaneUrl()}, models (in order): ${models.join(', ')}`)
  const { ModelPlaneClient } = await import('./model-plane-client.ts')
  const catalog = buildCatalogPrompt(dir)
  const runner = new LabBenchRunner(dir)
  const model = new ModelPlaneClient({ baseUrl: modelPlaneUrl(), models })
  // `--window` is a smoke-test convenience, not an instruction (AL-24 still holds: the question is data) — it
  // only nudges the question text toward a specific window, the same way a user might type it themselves.
  const fullQuestion = window ? `${question} (ventana: ${window})` : question
  const result = await runAgentJob(
    { question: fullQuestion },
    { model, runner, systemPrompt: catalog.systemPrompt, catalogIds: catalog.catalogIds, catalogYears: catalog.years, datasetsDir: dir },
  )
  console.log('--- answer ---')
  console.log(renderAnswerForHistory(result.answer, result.runs))
  console.log('--- cost ---')
  console.log(
    JSON.stringify(
      {
        verifierOutcome: result.verifierOutcome,
        flagged: result.flagged,
        toolRounds: result.toolRounds,
        runs: result.runs.map((r) => r.resultHash),
        modelCalls: result.meter.modelCalls,
        wallMs: result.meter.wallMs,
        repairUsed: result.meter.repairUsed,
      },
      null,
      2,
    ),
  )
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'run') return cmdRun()
  if (cmd === 'seed') {
    process.exitCode = seedExitCode(await cmdSeed())
    return
  }
  if (cmd === 'once') return cmdOnce(specFromArgs(rest))
  if (cmd === 'ask') return cmdAsk(rest)
  console.error('usage: mamoru-lab-runner <run|seed|once|ask>')
  process.exit(1)
}

// `import.meta.main` is only true when this file is bun's own entry point — never when a test imports it (review
// of #117 P2 needs `cmdSeed`/`publish` importable against a mock server) — so the script only runs itself here.
if (import.meta.main) {
  try {
    await main()
  } catch (e) {
    const code = reasonCodeOf(e)
    console.error(code ? `${code}: ${e instanceof ReasonError ? e.detail ?? e.message : ''}` : e instanceof Error ? e.message : e)
    process.exit(1)
  }
}

export { claim, cmdAsk, cmdOnce, cmdRun, cmdSeed, publish, runAgentJobClaimed, runJob, seedExitCode, signedPost }
export type { AgentClaimedJob, AgentHistoryTurn, BenchClaimedJob, ClaimedJob }
