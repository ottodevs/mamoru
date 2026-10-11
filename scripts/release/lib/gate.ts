// What may be deployed where. Pure decisions over values the scripts read (refs, the release log, the
// clock), so every refusal is tested without git, wrangler or a network.
import type { ReleaseRecord } from './release-log.ts'

export const DEFAULT_SOAK_HOURS = 24
/** The shortest soak a release may ask for without calling itself a hotfix (copy and read-only views). */
export const SHORT_SOAK_HOURS = 2

export type Verdict = { ok: true } | { ok: false; reason: string }

const SHA = /^[0-9a-f]{40}$/
const short = (sha: string) => sha.slice(0, 7)

/**
 * Production gets one sha: the one named on the command line, which must be the tip of beta (what is
 * running there) and must be on main (reviewed and merged). Nothing is taken from "whatever the tip is now".
 */
export function prodTarget(input: { requested: string | undefined; beta: string; betaIsOnMain: boolean }): Verdict {
  const { requested, beta, betaIsOnMain } = input
  if (!requested) return { ok: false, reason: 'name the sha to release: `bun run deploy:prod <sha>`. It is the sha that soaked on beta and that Otto gave the GO for.' }
  if (!SHA.test(requested)) return { ok: false, reason: `'${requested}' is not a full commit sha.` }
  if (requested !== beta) return { ok: false, reason: `${short(requested)} is not what beta runs: origin/beta is at ${short(beta)}. Production only gets the sha that is on beta.` }
  if (!betaIsOnMain) return { ok: false, reason: `${short(beta)} is not on origin/main. beta must point at a commit of main.` }
  return { ok: true }
}

/** Beta only ever runs a commit of main. */
export function betaTarget(input: { beta: string; betaIsOnMain: boolean; expected?: string }): Verdict {
  if (input.expected && input.expected !== input.beta) return { ok: false, reason: `origin/beta is at ${short(input.beta)}, caller expected ${short(input.expected)}.` }
  if (!input.betaIsOnMain) return { ok: false, reason: `${short(input.beta)} is not on origin/main. beta is a pointer to a commit of main: nobody commits to it.` }
  return { ok: true }
}

export type SoakOptions = { minHours: number; hotfix?: string }

/** `--min-soak-hours=N` and `--hotfix=<reason>`. Anything else is refused: a typo must not become a default. */
export function parseSoakOptions(args: readonly string[]): { ok: true; options: SoakOptions } | { ok: false; reason: string } {
  let minHours = DEFAULT_SOAK_HOURS
  let hotfix: string | undefined
  for (const arg of args) {
    const hours = arg.match(/^--min-soak-hours=(\d+(?:\.\d+)?)$/)
    const fix = arg.match(/^--hotfix=(.*)$/s)
    if (hours) minHours = Number(hours[1])
    else if (fix) hotfix = fix[1]!.trim()
    else return { ok: false, reason: `unknown argument '${arg}'.` }
  }
  if (hotfix !== undefined && hotfix.length < 10) return { ok: false, reason: '--hotfix needs the reason in words (what is broken in production).' }
  if (minHours < SHORT_SOAK_HOURS && hotfix === undefined) return { ok: false, reason: `a soak under ${SHORT_SOAK_HOURS} hours is a hotfix: say why with --hotfix="<reason>".` }
  return { ok: true, options: hotfix === undefined ? { minHours } : { minHours, hotfix } }
}

/**
 * Has this sha been on beta long enough? Counted from its first beta deploy whose smoke test passed, as
 * recorded in the release log of this machine. No record is a refusal, not zero hours.
 */
export function soakVerdict(records: readonly ReleaseRecord[], sha: string, now: Date, options: SoakOptions): Verdict & { hours?: number } {
  const first = records
    .filter((r) => r.env === 'beta' && r.sha === sha && r.smokeOk)
    .map((r) => Date.parse(r.at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0]
  if (first === undefined) return { ok: false, reason: `the release log has no beta deploy of ${short(sha)} with a passing smoke test. Deploy it to beta with \`bun run deploy:beta\` first.` }
  const hours = (now.getTime() - first) / 3_600_000
  if (hours < 0) return { ok: false, reason: `the beta deploy of ${short(sha)} is dated in the future. Check the clock and the release log.` }
  if (hours < options.minHours) {
    const left = options.minHours - hours
    return { ok: false, hours, reason: `${short(sha)} has been on beta for ${hours.toFixed(1)} h; this release asks for ${options.minHours} h (${left.toFixed(1)} h to go).` }
  }
  return { ok: true, hours }
}

/** The next release tag of a day: app-YYYY.MM.DD.N, N from 1, in UTC. */
export function nextTag(existing: readonly string[], now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '.')
  const prefix = `app-${day}.`
  const last = existing
    .filter((t) => t.startsWith(prefix) && /^\d+$/.test(t.slice(prefix.length)))
    .map((t) => Number(t.slice(prefix.length)))
    .reduce((a, b) => Math.max(a, b), 0)
  return `${prefix}${last + 1}`
}
