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
