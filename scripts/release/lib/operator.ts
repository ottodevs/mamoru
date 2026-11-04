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
 * the new process only. A failed review sets `lastDecisionCode` to its reason (OBS_RPC_UNAVAILABLE, REVIEW_ERROR...).
 */
export interface EngineView {
  account: string
  lastReviewAt: string | null
  lastDecisionCode: string | null
  consecutiveErrors: number
  lastErrorClass: string | null
}

/** Failed reviews in a row after which an engine counts as not observing. Reviews run every 20 s: about a minute. */
export const OBSERVE_FAIL_AFTER = 3
/** How long a redeploy waits, after the boot is healthy, for every engine to observe. MAMORU_DEPLOY_OBSERVE_MS overrides it. */
export const OBSERVE_TIMEOUT_MS = 240_000

/** The observation wait from MAMORU_DEPLOY_OBSERVE_MS (unset: the default), or why the value is refused. */
export function observeTimeout(raw: string | undefined): number | string {
  if (raw === undefined || raw === '') return OBSERVE_TIMEOUT_MS
  if (!/^\d+$/.test(raw)) return `MAMORU_DEPLOY_OBSERVE_MS=${raw} is not a number of milliseconds`
  const ms = Number(raw)
  if (ms < 60_000 || ms > 900_000) return `MAMORU_DEPLOY_OBSERVE_MS=${raw} is outside 60000..900000 (1 to 15 minutes)`
  return ms
}

/** The engine's last review reached a decision (it observed the chain) and, when `since` is given, did so after it. */
function observing(e: EngineView, since?: number): boolean {
  if (e.lastReviewAt === null || e.consecutiveErrors !== 0) return false
  return since === undefined || Date.parse(e.lastReviewAt) >= since
}

/** A last review older than this before the redeploy (a review held for an owner tx, a keyed RPC over its budget) does
 * not say the engine observes now: it is named, not required. */
export const BASELINE_FRESH_MS = 10 * 60_000

/**
 * Engines a redeploy must see observing again: those that were observing before it (a review in the last
 * BASELINE_FRESH_MS, and fewer than OBSERVE_FAIL_AFTER failures in a row). An engine already failing before is not the new code's doing and
 * would only make a redeploy (or the rollback that fixes it) go back to the broken sha; it is named, not required.
 * No `engines` before (the running code does not publish them): every engine is required.
 */
export function engineBaseline(before: EngineView[] | undefined, now: number): { required: Set<string> | null; failing: string[] } {
  if (!before) return { required: null, failing: [] }
  const required = new Set<string>()
  const failing: string[] = []
  for (const e of before) {
    const fresh = e.lastReviewAt !== null && now - Date.parse(e.lastReviewAt) <= BASELINE_FRESH_MS
    if (fresh && e.consecutiveErrors < OBSERVE_FAIL_AFTER) required.add(e.account)
    else failing.push(e.account)
  }
  return { required, failing }
}

export type ObserveVerdict = { state: 'ok' } | { state: 'wait'; pending: string[] } | { state: 'fail'; why: string }

function engineLine(e: EngineView): string {
  return `${e.account} ${e.consecutiveErrors}x ${e.lastDecisionCode ?? 'no code'}${e.lastErrorClass ? ` (${e.lastErrorClass})` : ''}`
}

/**
 * otto/mamoru#369: whether the new boot's engines observe. `ok` once every required engine (all of them when
 * `required` is null) has a review after `since` that reached a decision, and there are at least `expected` engines;
 * `fail` as soon as a required engine has failed OBSERVE_FAIL_AFTER reviews in a row, or when `timedOut` comes with
 * engines still not observing; otherwise `wait`. 4 Nov 2026 (ottodevs/mamoru#281): every Monad review failed
 * OBS_RPC_UNAVAILABLE for 10 minutes while the loops had started, and the redeploy called it healthy.
 */
export function observeVerdict(engines: EngineView[] | undefined, expected: number, required: Set<string> | null, since: number, timedOut: boolean): ObserveVerdict {
  const list = engines ?? []
  const need = required === null ? list : list.filter((e) => required.has(e.account))
  const failing = need.filter((e) => e.consecutiveErrors >= OBSERVE_FAIL_AFTER)
  if (failing.length) return { state: 'fail', why: `${failing.length} of ${need.length} engines fail to observe: ${failing.slice(0, 4).map(engineLine).join(', ')}${failing.length > 4 ? ', ...' : ''}` }
  const seen = new Set(list.map((e) => e.account))
  const missing = required === null ? [] : [...required].filter((a) => !seen.has(a))
  const pending = [...need.filter((e) => !observing(e, since)).map((e) => e.account), ...missing.map((a) => `${a} (no engine)`)]
  if (list.length < expected) pending.push(`${expected - list.length} engine(s) not published yet`)
  if (!pending.length) return { state: 'ok' }
  if (timedOut) {
    const detail = need.filter((e) => !observing(e, since)).map((e) => (e.lastReviewAt === null ? `${e.account} no review` : engineLine(e)))
    return { state: 'fail', why: `no successful observation in time from ${pending.length} engine(s): ${[...detail, ...missing.map((a) => `${a} no engine`)].concat(list.length < expected ? [`${list.length} of ${expected} engines published`] : []).slice(0, 5).join(', ')}` }
  }
  return { state: 'wait', pending }
}
