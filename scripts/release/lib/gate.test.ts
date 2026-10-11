// The refusals that keep an unwatched commit out of production. Pure: no git, no wrangler, no network.
import { describe, expect, it } from 'bun:test'
import { betaTarget, DEFAULT_SOAK_HOURS, nextTag, parseBetaArgs, parseProdArgs, parseSoakOptions, prodTarget, soakVerdict } from './gate.ts'
import type { ReleaseRecord } from './release-log.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const T0 = new Date('2026-10-11T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000).toISOString()
const beta = (sha: string, h: number, smokeOk = true): ReleaseRecord => ({ env: 'beta', sha, versionId: 'v', previousVersionId: 'p', smokeOk, at: hoursAgo(h) })

describe('prodTarget', () => {
  it('accepts only the named sha when it is the tip of beta and on main', () => {
    expect(prodTarget({ requested: A, beta: A, betaIsOnMain: true })).toEqual({ ok: true })
  })
  it('refuses a sha that is not what beta runs, even if it is on main', () => {
    const v = prodTarget({ requested: B, beta: A, betaIsOnMain: true })
    expect(v.ok ? '' : v.reason).toContain('not what beta runs')
  })
  it('refuses when beta points off main', () => {
    const v = prodTarget({ requested: A, beta: A, betaIsOnMain: false })
    expect(v.ok ? '' : v.reason).toContain('not on origin/main')
  })
  it('refuses anything that is not a full sha, should one ever reach it', () => {
    expect(prodTarget({ requested: 'aaaaaaa', beta: A, betaIsOnMain: true }).ok).toBe(false)
    expect(prodTarget({ requested: 'main', beta: A, betaIsOnMain: true }).ok).toBe(false)
  })
})

describe('parseProdArgs: the command line of deploy:prod', () => {
  it('takes one full sha as written, and the options', () => {
    expect(parseProdArgs([A])).toEqual({ ok: true, sha: A, options: { minHours: 24 } })
    expect(parseProdArgs(['--min-soak-hours=2', A])).toEqual({ ok: true, sha: A, options: { minHours: 2 } })
  })
  it('refuses when no sha is named: nothing is taken from the tip of a branch', () => {
    const v = parseProdArgs([])
    expect(v.ok ? '' : v.reason).toContain('name the sha')
    expect(parseProdArgs(['--min-soak-hours=2']).ok).toBe(false)
  })
  it('refuses a branch, a remote branch, a tag, HEAD and a short sha: git never resolves a name', () => {
    for (const name of ['main', 'beta', 'origin/beta', 'origin/main', 'HEAD', 'app-2026.10.11.1', A.slice(0, 7), A.slice(0, 39), `${A}a`, A.toUpperCase(), `${A}^`, `${A}~1`, '']) {
      const v = parseProdArgs([name])
      expect(v.ok).toBe(false)
    }
    expect((parseProdArgs(['origin/beta']) as { reason: string }).reason).toContain('not a full 40-character commit sha')
  })
  it('refuses a second word instead of ignoring it: a forgotten -- or a reason written apart', () => {
    for (const args of [[A, B], [A, 'min-soak-hours=2'], [A, '--hotfix', 'withdrawals fail with 500'], [A, 'now']]) {
      const v = parseProdArgs(args)
      expect(v.ok).toBe(false)
    }
    expect((parseProdArgs([A, 'min-soak-hours=2']) as { reason: string }).reason).toContain('one sha and nothing else')
  })
  it('passes on the refusals of the options', () => {
    expect(parseProdArgs([A, '--force']).ok).toBe(false)
    expect(parseProdArgs([A, '--min-soak-hours=1']).ok).toBe(false)
  })
})

describe('parseBetaArgs', () => {
  it('takes nothing, or the one full sha the caller expects', () => {
    expect(parseBetaArgs([])).toEqual({ ok: true })
    expect(parseBetaArgs([A])).toEqual({ ok: true, expected: A })
  })
  it('refuses a short sha or a name instead of ignoring it and deploying anyway', () => {
    for (const args of [[A.slice(0, 7)], ['beta'], [A, B], ['--force']]) expect(parseBetaArgs(args).ok).toBe(false)
  })
})

describe('betaTarget', () => {
  it('accepts a tip that is on main, and the sha a watcher expected', () => {
    expect(betaTarget({ beta: A, betaIsOnMain: true })).toEqual({ ok: true })
    expect(betaTarget({ beta: A, betaIsOnMain: true, expected: A })).toEqual({ ok: true })
  })
  it('refuses a tip that is not on main: nobody commits to beta', () => {
    expect(betaTarget({ beta: A, betaIsOnMain: false }).ok).toBe(false)
  })
  it('refuses when beta moved since the caller looked', () => {
    expect(betaTarget({ beta: A, betaIsOnMain: true, expected: B }).ok).toBe(false)
  })
})

describe('parseSoakOptions', () => {
  it('defaults to 24 hours', () => {
    expect(DEFAULT_SOAK_HOURS).toBe(24)
    expect(parseSoakOptions([])).toEqual({ ok: true, options: { minHours: 24 } })
  })
  it('takes a shorter soak down to 2 hours without a reason', () => {
    expect(parseSoakOptions(['--min-soak-hours=2'])).toEqual({ ok: true, options: { minHours: 2 } })
  })
  it('under 2 hours needs a hotfix reason in words', () => {
    expect(parseSoakOptions(['--min-soak-hours=1']).ok).toBe(false)
    expect(parseSoakOptions(['--min-soak-hours=0', '--hotfix=x']).ok).toBe(false)
    expect(parseSoakOptions(['--min-soak-hours=0.5', '--hotfix=withdrawals fail with 500 in production'])).toEqual({ ok: true, options: { minHours: 0.5, hotfix: 'withdrawals fail with 500 in production' } })
  })
  it('refuses anything it does not know, so a typo is not a default', () => {
    expect(parseSoakOptions(['--min-soak-hour=2']).ok).toBe(false)
    expect(parseSoakOptions(['--min-soak-hours=-3']).ok).toBe(false)
    expect(parseSoakOptions(['--min-soak-hours=two']).ok).toBe(false)
    expect(parseSoakOptions(['--force']).ok).toBe(false)
  })
})

describe('soakVerdict', () => {
  const opts = { minHours: 24 }
  it('passes once the sha has been on beta long enough, to the minute', () => {
    expect(soakVerdict([beta(A, 24)], A, T0, opts)).toEqual({ ok: true, hours: 24 })
    expect(soakVerdict([beta(A, 23.99)], A, T0, opts).ok).toBe(false)
  })
  it('the refusal never rounds up: 23.99 hours is not shown as 24.0 with 0.0 to go', () => {
    const v = soakVerdict([beta(A, 23.99)], A, T0, opts)
    expect(v.ok ? '' : v.reason).toContain('on beta for 23.99 h')
    expect(v.ok ? '' : v.reason).toContain('(1 min to go)')
    const w = soakVerdict([beta(A, 23.999)], A, T0, opts)
    expect(w.ok ? '' : w.reason).toContain('on beta for 23.99 h')
  })
  it('no beta record of this sha is a refusal, not zero hours', () => {
    for (const records of [[], [beta(B, 100)], [{ ...beta(A, 100), env: 'prod' as const }]]) {
      const v = soakVerdict(records, A, T0, opts)
      expect(v.ok).toBe(false)
      expect(v.ok ? '' : v.reason).toContain('no beta deploy')
    }
  })
  it('a beta deploy whose smoke test failed does not count, and what came before it does not either', () => {
    expect(soakVerdict([beta(A, 100, false)], A, T0, opts).ok).toBe(false)
    // Passed 100 h ago, failed 50 h ago, passed again 30 h ago: the soak is the 30 h since the failure was fixed.
    expect(soakVerdict([beta(A, 100), beta(A, 50, false), beta(A, 30)], A, T0, opts)).toEqual({ ok: true, hours: 30 })
    expect(soakVerdict([beta(A, 100), beta(A, 50, false), beta(A, 10)], A, T0, opts).ok).toBe(false)
  })
  it('the latest beta deploy failed its smoke test: refused however long the sha soaked before', () => {
    const v = soakVerdict([beta(A, 30), beta(A, 1, false)], A, T0, opts)
    expect(v.ok).toBe(false)
    expect(v.ok ? '' : v.reason).toContain('failed its smoke test')
  })
  it('another commit on beta in between ends the soak: only the uninterrupted run counts', () => {
    // A for a while, then B, then A again ten minutes ago.
    const back = soakVerdict([beta(A, 30), beta(B, 20), beta(A, 10 / 60)], A, T0, opts)
    expect(back.ok).toBe(false)
    expect(back.ok ? '' : back.reason).toContain('on beta for 0.16 h')
    // B is on beta now: A is not what is soaking, whatever it did before.
    const gone = soakVerdict([beta(A, 30), beta(B, 2)], A, T0, opts)
    expect(gone.ok ? '' : gone.reason).toContain('latest beta deploy in the release log is bbbbbbb')
  })
  it('a redeploy of the same sha with a passing smoke test does not restart the soak', () => {
    expect(soakVerdict([beta(A, 30), beta(A, 1)], A, T0, opts)).toEqual({ ok: true, hours: 30 })
  })
  it('the order of the lines does not matter, the dates do; production records are ignored', () => {
    const prod = { ...beta(B, 5), env: 'prod' as const }
    expect(soakVerdict([beta(A, 1), prod, beta(B, 40), beta(A, 30)], A, T0, opts)).toEqual({ ok: true, hours: 30 })
  })
  it('a record dated in the future or with a date that cannot be read is refused', () => {
    expect(soakVerdict([beta(A, -5)], A, T0, opts).ok).toBe(false)
    expect(soakVerdict([{ ...beta(A, 30), at: 'yesterday' }], A, T0, opts).ok).toBe(false)
    expect(soakVerdict([beta(A, 30), { ...beta(B, 30), at: 'yesterday' }], A, T0, opts).ok).toBe(false)
  })
  it('honours the hours asked for', () => {
    expect(soakVerdict([beta(A, 3)], A, T0, { minHours: 2 }).ok).toBe(true)
    expect(soakVerdict([beta(A, 1)], A, T0, { minHours: 2 }).ok).toBe(false)
    expect(soakVerdict([beta(A, 0.1)], A, T0, { minHours: 0, hotfix: 'withdrawals fail with 500' }).ok).toBe(true)
  })
})

describe('nextTag', () => {
  it('is app-YYYY.MM.DD.N in UTC, N from 1', () => {
    expect(nextTag([], T0)).toBe('app-2026.10.11.1')
    expect(nextTag(['app-2026.10.10.4', 'archive/perf'], T0)).toBe('app-2026.10.11.1')
  })
  it('follows the highest N of the day, not the count', () => {
    expect(nextTag(['app-2026.10.11.1', 'app-2026.10.11.3', 'app-2026.10.11.x', 'app-2026.10.11.10'], T0)).toBe('app-2026.10.11.11')
  })
  it('uses the UTC day near midnight', () => {
    expect(nextTag([], new Date('2026-10-11T23:59:59Z'))).toBe('app-2026.10.11.1')
    expect(nextTag([], new Date('2026-10-12T00:00:00Z'))).toBe('app-2026.10.12.1')
  })
})
