// Pure rules of an operator redeploy, kept apart from the shell work so they can be tested.

export interface DeployPlanInput {
  sha: string
  running: string
  onMain: boolean
  /** `running` is an ancestor of `sha`: the deploy only moves forward. */
  forward: boolean
  rollback: boolean
}

/** Why a redeploy is refused, or null when it may go ahead. */
export function refuseDeploy(p: DeployPlanInput): string | null {
  if (!/^[0-9a-f]{40}$/.test(p.sha)) return 'the sha is written in full, all 40 characters'
  if (p.sha === p.running) return `the operator already runs ${p.sha.slice(0, 7)}`
  if (!p.onMain) return `${p.sha.slice(0, 7)} is not a commit of origin/main (reviewed and merged)`
  if (!p.forward && !p.rollback) {
    return `${p.sha.slice(0, 7)} does not contain the running ${p.running.slice(0, 7)}: deploying it would drop merged work. Deploy the tip of main, or pass --rollback to go back on purpose`
  }
  return null
}

export interface MetricsView {
  gitSha?: string
  live?: boolean
}

/** Healthy once the restarted process answers /metrics with the new sha and the live flag it had before. */
export function healthy(m: MetricsView | null, sha: string, wasLive: boolean): boolean {
  return !!m && typeof m.gitSha === 'string' && sha.startsWith(m.gitSha) && m.gitSha.length >= 7 && m.live === wasLive
}

/** Lines of a boot journal that mean the process is not fit to keep running. */
export function fatalLines(journal: string): string[] {
  return journal.split('\n').filter((l) => /\b(fatal|uncaught|unhandled rejection|refusing to boot|EADDRINUSE)\b/i.test(l))
}

/**
 * Full fingerprints (git %GF) whose good signature makes a commit deployable. Fixed here, not read from the
 * environment: main is signed by Ot's key (merge-pr.sh re-signs every merged commit). A new signer is a reviewed
 * change to this line.
 */
export const ALLOWED_SIGNERS = ['A2C36B5E38869D26A66BE1DE53A35CC2D46A3B29'] as const

/** A commit may run the operator only with a good signature (%G? = G) by an allowed key. */
export function signedOk(status: string, fingerprint: string): boolean {
  return status === 'G' && (ALLOWED_SIGNERS as readonly string[]).includes(fingerprint)
}

/** `process.env.X` names a source tree reads, from `git grep -h -o` output. */
export function envReads(grepOut: string): string[] {
  return [...new Set(grepOut.split('\n').map((l) => l.trim().replace(/^process\.env\./, '')).filter((v) => /^[A-Z0-9_]+$/.test(v)))].sort()
}

/** Variables the target reads that the running code did not, each with whether the env file sets it. */
export function newEnv(before: string[], after: string[], envFile: string): { name: string; set: boolean }[] {
  const had = new Set(before)
  const set = new Set(envFile.split('\n').map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1]).filter((v): v is string => !!v))
  return after.filter((v) => !had.has(v)).map((name) => ({ name, set: set.has(name) }))
}

/** Distinct accounts whose engine loop started in a boot's journal (`[engine <key>] loop started`). */
export function loopsStarted(journal: string): number {
  return new Set([...journal.matchAll(/^\[engine ([^\]]+)\] loop started/gm)].map((m) => m[1])).size
}

export type UnitTarget = { dir: string; envFile: string; metricsUrl: string }

/**
 * `systemctl show -p Environment --value`: space-separated assignments; systemd quotes a whole assignment that holds a
 * space or a special character ("K=a b"), and a quote may also follow the `=`. A later assignment wins, as in systemd.
 */
export function unitEnvironment(value: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of value.matchAll(/"((?:[^"\\]|\\.)*)"|([A-Za-z_][A-Za-z0-9_]*="(?:[^"\\]|\\.)*")|(\S+)/g)) {
    const raw = (m[1] ?? m[2] ?? m[3]!).replace(/\\(.)/g, '$1')
    const eq = raw.indexOf('=')
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.slice(0, eq))) continue
    out[raw.slice(0, eq)] = raw.slice(eq + 1).replace(/^"(.*)"$/, '$1')
  }
  return out
}

/** The value of the last `KEY=` line of an env file (the one that wins), unquoted. */
export function envFileValue(text: string, key: string): string | undefined {
  const all = [...text.matchAll(new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`, 'gm'))]
  return all.at(-1)?.[1]?.trim().replace(/^["']|["']$/g, '')
}

/**
 * otto/mamoru#241: the dir, env file and metrics URL of the unit being redeployed, read from the unit itself
 * (WorkingDirectory, Environment=MAMORU_OPERATOR_ENV, PORT in that env file), so naming a unit can never check out
 * or verify another operator's. A given override must agree with the unit; a string is the reason to refuse.
 */
export function unitTarget(
  unit: string,
  facts: { workingDirectory: string; environment: string; envFileText: (path: string) => string | null; realpath: (p: string) => string },
  given: { dir?: string; envFile?: string; metricsUrl?: string },
  defaultEnvFile: string,
  defaultUnit = 'mamoru-operator',
): UnitTarget | string {
  if (!facts.workingDirectory) return `unit ${unit} has no WorkingDirectory (is it installed?)`
  const dir = facts.realpath(facts.workingDirectory)
  const declared = unitEnvironment(facts.environment).MAMORU_OPERATOR_ENV
  // Only the default (Base) unit may use the default env file: any other unit names its own, or nothing is assumed.
  if (declared === undefined && unit !== defaultUnit) return `unit ${unit} sets no Environment=MAMORU_OPERATOR_ENV; refusing to assume ${defaultEnvFile}`
  const envFile = declared ?? defaultEnvFile
  const text = facts.envFileText(envFile)
  if (text === null) return `unit ${unit}: env file ${envFile} not readable`
  const portValue = envFileValue(text, 'PORT')
  if (portValue !== undefined && !/^\d+$/.test(portValue)) return `unit ${unit}: PORT=${portValue} in ${envFile} is not a port`
  const port = portValue ?? '8787'
  const metricsUrl = `http://127.0.0.1:${port}/metrics`
  if (given.dir !== undefined && facts.realpath(given.dir) !== dir) return `MAMORU_OPERATOR_DIR=${given.dir} is not unit ${unit}'s WorkingDirectory ${dir}`
  if (given.envFile !== undefined && given.envFile !== envFile) return `MAMORU_OPERATOR_ENV=${given.envFile} is not unit ${unit}'s env file ${envFile}`
  if (given.metricsUrl !== undefined && given.metricsUrl.replace(/\/+$/, '') !== metricsUrl) return `MAMORU_OPERATOR_METRICS=${given.metricsUrl} is not unit ${unit}'s ${metricsUrl} (PORT in ${envFile})`
  return { dir, envFile, metricsUrl }
}

/**
 * otto/mamoru#369: one engine as GET /metrics shows it (`engines[]`, apps/mamoru-operator/src/metrics.ts
 * EngineHealthSnapshot). The tracker lives in memory and starts empty at boot, so after a restart every field speaks of
 * the new process only. Every review that does not reach a decision adds one to `consecutiveErrors` (an observation
 * failure of any code, EHG_OBSERVATION_STALE included, GRANT_CHECK_UNAVAILABLE, REVIEW_ERROR) and sets
 * `lastDecisionCode` to its code; one that decides sets it back to 0. Fields are read defensively: an older operator
 * may lack one.
 */
export interface EngineView {
  account?: unknown
  lastReviewAt?: unknown
  lastDecisionCode?: unknown
  consecutiveErrors?: unknown
}

/**
 * The rule: roll back by itself only on positive evidence of a regression, never on silence or a blip. A regression is
 * an engine that was clean before the redeploy, has not decided once since the restart, and has failed with a hard
 * code at least REGRESSION_REVIEWS times in a row over at least REGRESSION_SPAN_MS, and that for most of the engines
 * that were clean. 4 Nov 2026 (ottodevs/mamoru#281): every Monad review failed OBS_RPC_UNAVAILABLE for 10 minutes.
 */
export const REGRESSION_REVIEWS = 5
export const REGRESSION_SPAN_MS = 120_000
/** How long a redeploy watches the engines once the boot is healthy. MAMORU_DEPLOY_OBSERVE_MS overrides it. */
export const OBSERVE_TIMEOUT_MS = 240_000

/**
 * A failure that says the new code cannot observe: an OBS_* reason (OBS_RPC_UNAVAILABLE, OBS_BLOCK_INCONSISTENT...) or
 * a thrown review. Not hard: waits and holds such as EHG_OBSERVATION_STALE (the post-restart observation floor of an
 * unsettled op: 22:19 on 4 Nov, 11 in a row on a healthy deploy), EHG_OBSERVATION_REORGED, GRANT_CHECK_UNAVAILABLE.
 */
export function hardFailure(code: string | null): boolean {
  return code !== null && (code.startsWith('OBS_') || code === 'REVIEW_ERROR')
}

/** The observation wait from MAMORU_DEPLOY_OBSERVE_MS (unset: the default), or why the value is refused. */
export function observeTimeout(raw: string | undefined): number | string {
  if (raw === undefined || raw === '') return OBSERVE_TIMEOUT_MS
  if (!/^\d+$/.test(raw)) return `MAMORU_DEPLOY_OBSERVE_MS=${raw} is not a number of milliseconds`
  const ms = Number(raw)
  if (ms < REGRESSION_SPAN_MS + 60_000 || ms > 900_000) return `MAMORU_DEPLOY_OBSERVE_MS=${raw} is outside ${REGRESSION_SPAN_MS + 60_000}..900000`
  return ms
}

type Parsed = { account: string; lastReviewAt: number | null; code: string | null; errors: number | null }
function parse(e: EngineView): Parsed | null {
  if (!e || typeof e !== 'object' || typeof e.account !== 'string' || !e.account) return null
  const at = typeof e.lastReviewAt === 'string' ? Date.parse(e.lastReviewAt) : NaN
  return {
    account: e.account,
    lastReviewAt: Number.isFinite(at) ? at : null,
    code: typeof e.lastDecisionCode === 'string' ? e.lastDecisionCode : null,
    errors: typeof e.consecutiveErrors === 'number' && Number.isInteger(e.consecutiveErrors) && e.consecutiveErrors >= 0 ? e.consecutiveErrors : null,
  }
}
function engineList(engines: unknown): Parsed[] | null {
  if (!Array.isArray(engines)) return null
  return engines.map((e) => parse(e as EngineView)).filter((e): e is Parsed => e !== null)
}

/**
 * Engines a redeploy watches: the ones clean before it (a last review that decided: `consecutiveErrors` 0). One already
 * failing (an RPC outage before and after is not a regression) or with fields missing is named, not watched.
 * `required` null: there is no baseline (/metrics did not answer with `engines`), so nothing is evidence of a
 * regression and the redeploy only reports.
 */
export function engineBaseline(engines: unknown): { required: Set<string> | null; notRequired: string[] } {
  const list = engineList(engines)
  if (!list) return { required: null, notRequired: [] }
  const required = new Set<string>()
  const notRequired: string[] = []
  for (const e of list) {
    if (e.lastReviewAt !== null && e.errors === 0) required.add(e.account)
    else notRequired.push(e.account)
  }
  return { required, notRequired }
}

/** A redeploy may roll back by itself only with a baseline, and never when it is itself an explicit --rollback. */
export function autoRollbackAllowed(baseline: { required: Set<string> | null }, rollback: boolean): boolean {
  return baseline.required !== null && !rollback
}

/** Every engine account a /metrics `engines` lists: what a report-only watch without a baseline looks at. */
export function engineAccounts(engines: unknown): Set<string> {
  return new Set((engineList(engines) ?? []).map((e) => e.account))
}

/** What the watch has seen of one engine since the restart. `observed` is sticky: a later blip does not undo it. */
export type EngineTrack = { observed: boolean; lastReviewAt: number | null; errors: number; code: string | null; hardCount: number; hardSince: number | null; hardLast: number | null }

/**
 * Folds one /metrics snapshot into the tracks (a new map; `prev` is not changed). Reviews before `since` (the restart)
 * are ignored. Between two polls an engine may review more than once: a `consecutiveErrors` that went down without
 * reaching 0 means a review decided in between; a streak of the same hard code grows by the increase of the counter.
 */
export function trackEngines(prev: ReadonlyMap<string, EngineTrack>, engines: unknown, since: number): Map<string, EngineTrack> {
  const next = new Map(prev)
  for (const e of engineList(engines) ?? []) {
    const t: EngineTrack = { ...(prev.get(e.account) ?? { observed: false, lastReviewAt: null, errors: 0, code: null, hardCount: 0, hardSince: null, hardLast: null }) }
    if (e.lastReviewAt === null || e.lastReviewAt < since || e.lastReviewAt === t.lastReviewAt) continue
    const at = e.lastReviewAt
    if (e.errors === 0) {
      t.observed = true
      t.hardCount = 0
      t.hardSince = t.hardLast = null
    } else if (e.errors === null || !hardFailure(e.code)) {
      // Unknown, or a wait/hold: no evidence either way, and it ends any hard streak.
      t.hardCount = 0
      t.hardSince = t.hardLast = null
    } else {
      if (t.lastReviewAt !== null && e.errors <= t.errors) {
        // The counter went down: a review in between decided.
        t.observed = true
        t.hardCount = 0
        t.hardSince = null
      }
      const grew = t.hardCount > 0 && t.code === e.code ? Math.max(1, e.errors - t.errors) : 1
      t.hardCount += grew
      t.hardSince ??= at
      t.hardLast = at
    }
    t.errors = e.errors ?? 0
    t.code = e.code
    t.lastReviewAt = at
    next.set(e.account, t)
  }
  return next
}

export type ObserveVerdict =
  | { state: 'wait' }
  | { state: 'ok'; quiet: string[] }
  | { state: 'regression'; why: string }
  | { state: 'doubt'; why: string }

/**
 * otto/mamoru#369, the decision over the tracks of the required engines:
 * - `regression` (the only one that may roll back by itself): most required engines have not decided once since the
 *   restart and each failed a hard code REGRESSION_REVIEWS times in a row over REGRESSION_SPAN_MS.
 * - `ok`: every required engine decided once (sticky); at the deadline, engines with no review at all since the restart
 *   are `quiet` (a warning: silence is not a regression).
 * - `doubt` at the deadline: engines reviewed but never decided, without the evidence above. Reported, never rolled back.
 * - `wait` otherwise.
 */
export function observeVerdict(tracks: ReadonlyMap<string, EngineTrack>, required: ReadonlySet<string>, timedOut: boolean): ObserveVerdict {
  const req = [...required]
  const regressed = req.filter((a) => {
    const t = tracks.get(a)
    return !!t && !t.observed && t.hardCount >= REGRESSION_REVIEWS && t.hardSince !== null && t.hardLast !== null && t.hardLast - t.hardSince >= REGRESSION_SPAN_MS
  })
  if (regressed.length > 0 && regressed.length * 2 > req.length) {
    const codes = [...new Set(regressed.map((a) => tracks.get(a)!.code))].join(', ')
    return { state: 'regression', why: `${regressed.length} of ${req.length} engines clean before the redeploy have not observed since it (${codes}, ${REGRESSION_REVIEWS}+ in a row over ${REGRESSION_SPAN_MS / 1000}+ s): ${regressed.slice(0, 4).join(', ')}${regressed.length > 4 ? ', ...' : ''}` }
  }
  const quiet = req.filter((a) => tracks.get(a)?.lastReviewAt == null)
  const stuck = req.filter((a) => {
    const t = tracks.get(a)
    return !!t && t.lastReviewAt !== null && !t.observed
  })
  if (!stuck.length && (timedOut || !quiet.length)) return { state: 'ok', quiet }
  if (!timedOut) return { state: 'wait' }
  return { state: 'doubt', why: `${stuck.length} of ${req.length} engines reviewed but never decided since the restart: ${stuck.slice(0, 4).map((a) => `${a} ${tracks.get(a)!.errors}x ${tracks.get(a)!.code ?? '?'}`).join(', ')}${quiet.length ? `; no review at all: ${quiet.join(', ')}` : ''}` }
}
