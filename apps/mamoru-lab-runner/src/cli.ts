#!/usr/bin/env bun
/**
 * Agent Lab bench runner (spec 008, B-03/B-12). Claims bench jobs from the landing Worker's signed runner API,
 * computes them with the production engine (`@mamoru/lab-bench`, over local dataset files), and posts results
 * back. Holds no wallet key, no RPC key and no D1 credential — only `LAB_RUNNER_SECRET` (B-05 signing) and the
 * dataset files on disk (Architecture).
 *
 * Commands:
 *   run             claim / heartbeat / result loop — what the systemd unit runs
 *   seed            the B-03 catalog matrix, published without a job
 *   once <specKey>  compute one spec locally and print a summary — no network, no env required beyond LAB_DATASETS
 *
 * Env: LAB_RUNNER_URL (e.g. https://mamoru.lol), LAB_RUNNER_SECRET, LAB_DATASETS (default
 * ~/.local/share/mamoru-lab/datasets). `run` and `seed` need the first two; `once` needs neither.
 */
import { ReasonError } from '@mamoru/domain'
import { basesForWindow, defaultDatasetsDir, parseSpecKey, runBench, specKey, trainWindows, type Base, type BenchSpec, type RunResult } from '@mamoru/lab-bench'
import { runInWorker } from './run-in-worker.ts'
import type { RunWorkerPayload, RunWorkerResult } from './run-worker.ts'
import { signRequest } from './sign.ts'

const RUN_WORKER_URL = new URL('./run-worker.ts', import.meta.url)
/** AL-02's lease expiry is 120s ahead and renews every 30s; this matches the renewal cadence. */
const HEARTBEAT_INTERVAL_MS = 30_000

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

function datasetsDir(): string {
  return process.env.LAB_DATASETS ?? defaultDatasetsDir()
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

type ClaimedJob = { id: string; spec: BenchSpec; leaseId: string }
type Outcome = { run: RunResult } | { error: string }

async function claim(): Promise<ClaimedJob | null> {
  const { status, json } = await signedPost('/ops/lab/runner/claim', {})
  if (status === 204) return null
  if (status !== 200) throw new Error(`claim: unexpected status ${status}`)
  return (json as { job: ClaimedJob }).job
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

async function postResult(jobId: string, leaseId: string, outcome: Outcome): Promise<void> {
  const { status } = await signedPost('/ops/lab/runner/result', { jobId, leaseId, ...outcome })
  if (status !== 200 && status !== 409) console.error(`result ${jobId}: unexpected status ${status}`)
}

/** Review of #117 P2: a non-2xx used to be logged and swallowed, so `seed` reported a spec "published" that never
 * actually landed. Throwing makes the caller's own accounting (published/skipped/failed) the only source of truth. */
async function publish(run: RunResult): Promise<void> {
  const { status } = await signedPost('/ops/lab/runner/publish', { run })
  if (status < 200 || status >= 300) throw new Error(`publish ${run.specKey}: status ${status}`)
}

/** A business refusal has a closed reason code; anything else is a bug, not a result to report. */
function reasonCodeOf(e: unknown): string | null {
  return e instanceof ReasonError ? e.code : null
}

/**
 * Runs one claimed job: computes its spec in a worker thread (review of #117 P1 — `runBench` is a long,
 * synchronous call, and running it on the same thread as the heartbeat would starve the heartbeat) while a
 * heartbeat ticks every 30s on this thread. The moment a heartbeat reports the lease lost, the worker is
 * terminated at once and the job's own result is never posted (AL-02/AL-02a) — even if it had finished, a fenced
 * write from the server side would refuse it anyway; this is the client staying quiet about it too.
 */
async function runJob(job: ClaimedJob): Promise<void> {
  const outcome = await runInWorker<RunWorkerPayload, RunWorkerResult>(
    RUN_WORKER_URL,
    { spec: job.spec, datasetsDir: datasetsDir() },
    { heartbeat: () => heartbeat(job.id, job.leaseId), intervalMs: HEARTBEAT_INTERVAL_MS },
  )
  if ('leaseLost' in outcome) {
    console.error(`job ${job.id}: lease lost mid-flight, not posting`)
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

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'run') return cmdRun()
  if (cmd === 'seed') {
    process.exitCode = seedExitCode(await cmdSeed())
    return
  }
  if (cmd === 'once') return cmdOnce(specFromArgs(rest))
  console.error('usage: mamoru-lab-runner <run|seed|once>')
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

export { cmdOnce, cmdRun, cmdSeed, publish, seedExitCode, signedPost }
