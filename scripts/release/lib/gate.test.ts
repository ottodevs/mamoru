// The refusals that keep an unwatched commit out of production. Pure: no git, no wrangler, no network.
import { describe, expect, it } from 'bun:test'
import { betaTarget, DEFAULT_SOAK_HOURS, nextTag, parseSoakOptions, prodTarget, soakVerdict } from './gate.ts'
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
  it('refuses when no sha is named: nothing is taken from the tip of a branch', () => {
    const v = prodTarget({ requested: undefined, beta: A, betaIsOnMain: true })
    expect(v.ok).toBe(false)
    expect(v.ok ? '' : v.reason).toContain('name the sha')
  })
  it('refuses a sha that is not what beta runs, even if it is on main', () => {
    const v = prodTarget({ requested: B, beta: A, betaIsOnMain: true })
    expect(v.ok ? '' : v.reason).toContain('not what beta runs')
  })
  it('refuses when beta points off main', () => {
    const v = prodTarget({ requested: A, beta: A, betaIsOnMain: false })
    expect(v.ok ? '' : v.reason).toContain('not on origin/main')
  })
  it('refuses an abbreviated or malformed sha that reached it unresolved', () => {
    expect(prodTarget({ requested: 'aaaaaaa', beta: A, betaIsOnMain: true }).ok).toBe(false)
    expect(prodTarget({ requested: 'main', beta: A, betaIsOnMain: true }).ok).toBe(false)
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
    const short = soakVerdict([beta(A, 23.99)], A, T0, opts)
    expect(short.ok).toBe(false)
    expect(short.ok ? '' : short.reason).toContain('to go')
  })
  it('no beta record of this sha is a refusal, not zero hours', () => {
    for (const records of [[], [beta(B, 100)], [{ ...beta(A, 100), env: 'prod' as const }]]) {
      const v = soakVerdict(records, A, T0, opts)
      expect(v.ok).toBe(false)
      expect(v.ok ? '' : v.reason).toContain('no beta deploy')
    }
  })
  it('a beta deploy whose smoke test failed does not count', () => {
    expect(soakVerdict([beta(A, 100, false)], A, T0, opts).ok).toBe(false)
    expect(soakVerdict([beta(A, 100, false), beta(A, 30)], A, T0, opts)).toEqual({ ok: true, hours: 30 })
  })
  it('counts from the first passing deploy: a redeploy of the same sha does not restart the soak', () => {
    expect(soakVerdict([beta(A, 30), beta(A, 1)], A, T0, opts)).toEqual({ ok: true, hours: 30 })
  })
  it('a record dated in the future or with a broken date is refused', () => {
    expect(soakVerdict([beta(A, -5)], A, T0, opts).ok).toBe(false)
    expect(soakVerdict([{ ...beta(A, 30), at: 'yesterday' }], A, T0, opts).ok).toBe(false)
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
