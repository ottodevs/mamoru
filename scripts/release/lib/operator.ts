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
