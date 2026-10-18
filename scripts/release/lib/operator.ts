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
