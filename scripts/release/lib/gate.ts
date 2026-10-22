// What may be deployed where. Pure decisions over values the scripts read (refs, the release log, the
// clock), so every refusal is tested without git, wrangler or a network.
import type { ReleaseRecord } from './release-log.ts'

export const DEFAULT_SOAK_HOURS = 2
/** The shortest soak a release may ask for without calling itself a hotfix. Equal to the default since 22-oct-2026. */
export const SHORT_SOAK_HOURS = 2

export type Verdict = { ok: true } | { ok: false; reason: string }

const SHA = /^[0-9a-f]{40}$/
const short = (sha: string) => sha.slice(0, 7)

/**
 * Production gets one sha: the one named on the command line, which must be the tip of beta (what is
 * running there) and must be on main (reviewed and merged). Nothing is taken from "whatever the tip is now".
 */
export function prodTarget(input: { requested: string; beta: string; betaIsOnMain: boolean }): Verdict {
  const { requested, beta, betaIsOnMain } = input
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
 * The command line of deploy:prod: exactly one full 40-character sha, then options. A branch, a tag, HEAD or
 * a short sha is refused before git ever sees it: the release is the commit that was written down, not what
 * a name points at when the command runs.
 */
export function parseProdArgs(args: readonly string[]): { ok: true; sha: string; options: SoakOptions } | { ok: false; reason: string } {
  const positional = args.filter((a) => !a.startsWith('--'))
  if (positional.length === 0) return { ok: false, reason: 'name the sha to release: `bun run deploy:prod <sha>`. It is the sha that soaked on beta and that Otto gave the GO for.' }
  if (positional.length > 1) return { ok: false, reason: `one sha and nothing else: got ${positional.map((p) => `'${p}'`).join(', ')}. Options are written --name=value, in one word (quote a reason: --hotfix="...").` }
  const sha = positional[0]!
  if (!SHA.test(sha)) return { ok: false, reason: `'${sha}' is not a full 40-character commit sha. Branch names, tags and short shas are not accepted.` }
  const parsed = parseSoakOptions(args.filter((a) => a.startsWith('--')))
  return parsed.ok ? { ok: true, sha, options: parsed.options } : parsed
}

/** deploy:beta takes nothing, or the one full sha a caller expects beta to be at. */
export function parseBetaArgs(args: readonly string[]): { ok: true; expected?: string } | { ok: false; reason: string } {
  if (args.length === 0) return { ok: true }
  if (args.length > 1 || !SHA.test(args[0]!)) return { ok: false, reason: `deploy:beta takes no argument, or the one full 40-character sha origin/beta is expected to be at: got ${args.map((a) => `'${a}'`).join(', ')}.` }
  return { ok: true, expected: args[0]! }
}

/** Hours for a person: never rounded up to the next number. */
const floorHours = (h: number) => (Math.floor(h * 100) / 100).toFixed(2)

/**
 * Has this sha been on beta, without interruption, long enough? Read from the beta records of the release
 * log, newest first: the latest deploy must be this sha with a passing smoke test, and the soak runs back
 * from there only while every earlier record is the same sha with a passing smoke test. Another commit on
 * beta in between, or a failed smoke test, ends it: what counts is the time beta has been running this
 * commit and nothing else. No record is a refusal, not zero hours.
 */
export function soakVerdict(records: readonly ReleaseRecord[], sha: string, now: Date, options: SoakOptions): Verdict & { hours?: number } {
  const beta = records.filter((r) => r.env === 'beta')
  if (beta.some((r) => !Number.isFinite(Date.parse(r.at)))) return { ok: false, reason: 'the release log has a beta record with a date that cannot be read. Fix the log before releasing.' }
  // A record from the future means the clock or the log is wrong, and every sum made with it would be too.
  if (beta.some((r) => Date.parse(r.at) > now.getTime())) return { ok: false, reason: 'the release log has a beta deploy dated in the future. Check the clock and the release log.' }
  const newestFirst = [...beta].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const latest = newestFirst[0]
  if (!newestFirst.some((r) => r.sha === sha && r.smokeOk)) return { ok: false, reason: `the release log has no beta deploy of ${short(sha)} with a passing smoke test. Deploy it to beta with \`bun run deploy:beta\` first.` }
  if (!latest || latest.sha !== sha) return { ok: false, reason: `the latest beta deploy in the release log is ${latest ? short(latest.sha) : 'missing'}, not ${short(sha)}. Deploy ${short(sha)} to beta again; its soak starts then.` }
  if (!latest.smokeOk) return { ok: false, reason: `the latest beta deploy of ${short(sha)} failed its smoke test. It is not soaking.` }
  let start = Date.parse(latest.at)
  for (const r of newestFirst) {
    if (r.sha !== sha || !r.smokeOk) break
    start = Date.parse(r.at)
  }
  const hours = (now.getTime() - start) / 3_600_000
  if (hours < options.minHours) {
    const minutesLeft = Math.ceil((options.minHours - hours) * 60)
    return { ok: false, hours, reason: `${short(sha)} has been on beta for ${floorHours(hours)} h; this release asks for ${options.minHours} h (${minutesLeft} min to go).` }
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
