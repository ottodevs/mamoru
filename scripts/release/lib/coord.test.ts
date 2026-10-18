import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkHolder, claim, isLive, LEASE_TTL_MS, readLease, writeLease, type Lease } from './lease.ts'
import { fatalLines, healthy, refuseDeploy } from './operator.ts'
import { finalMessage, MIN_REMAINING, parseVerdict, pickModel } from './review.ts'

const T0 = Date.parse('2026-10-18T09:00:00Z')
const lease = (holder: string, beatAgoMs = 0): Lease => ({ holder, claimedAt: new Date(T0 - 3_600_000).toISOString(), heartbeatAt: new Date(T0 - beatAgoMs).toISOString(), note: 'release 48126c1' })
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('coordinator lease', () => {
  test('only the live holder may act; a lapsed lease is nobody\'s', () => {
    expect(checkHolder(lease('noema-7a'), 'noema-7a', T0)).toEqual({ ok: true })
    const other = checkHolder(lease('noema-46'), 'noema-7a', T0)
    expect(other.ok).toBe(false)
    expect(!other.ok && other.reason).toContain('noema-46')
    expect(checkHolder(lease('noema-7a', LEASE_TTL_MS + 1), 'noema-7a', T0).ok).toBe(false)
    expect(checkHolder(null, 'noema-7a', T0).ok).toBe(false)
    expect(checkHolder(lease('noema-7a'), undefined, T0).ok).toBe(false)
  })

  test('a live lease of another session is never claimed without take', () => {
    expect('error' in claim(lease('noema-46'), 'noema-7a', 'x', T0)).toBe(true)
    const taken = claim(lease('noema-46'), 'noema-7a', 'hotfix', T0, true)
    expect('lease' in taken && taken.lease.holder).toBe('noema-7a')
  })

  test('a free or lapsed lease is claimed; renewing your own keeps when you claimed it', () => {
    const free = claim(null, 'noema-7a', 'merge #67', T0)
    expect('lease' in free && free.lease).toMatchObject({ holder: 'noema-7a', note: 'merge #67' })
    const lapsed = claim(lease('noema-46', LEASE_TTL_MS + 1), 'noema-7a', 'n', T0)
    expect('lease' in lapsed && lapsed.lease.holder).toBe('noema-7a')
    const renewed = claim(lease('noema-7a', 60_000), 'noema-7a', '', T0)
    expect('lease' in renewed && renewed.lease).toMatchObject({ claimedAt: new Date(T0 - 3_600_000).toISOString(), heartbeatAt: new Date(T0).toISOString(), note: 'release 48126c1' })
  })

  test('the lease file round-trips and a released lease reads as free', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lease-')), 'lease.json')
    expect(readLease(path)).toBeNull()
    writeLease(lease('noema-7a'), path)
    expect(readLease(path)?.holder).toBe('noema-7a')
    writeLease(null, path)
    expect(isLive(readLease(path), T0)).toBe(false)
  })
})

describe('operator deploy rules', () => {
  const base = { sha: B, running: A, onMain: true, forward: true, rollback: false }
  test('forward to a reviewed commit goes ahead', () => expect(refuseDeploy(base)).toBeNull())
  test('a short sha, the running one, or one off main is refused', () => {
    expect(refuseDeploy({ ...base, sha: 'bbbbbbb' })).toContain('40 characters')
    expect(refuseDeploy({ ...base, sha: A })).toContain('already runs')
    expect(refuseDeploy({ ...base, onMain: false })).toContain('not a commit of origin/main')
  })
  test('a sha that drops running work needs --rollback', () => {
    expect(refuseDeploy({ ...base, forward: false })).toContain('drop merged work')
    expect(refuseDeploy({ ...base, forward: false, rollback: true })).toBeNull()
  })
  test('healthy only with the new sha and the same live flag', () => {
    expect(healthy({ gitSha: 'bbbbbbb', live: true }, B, true)).toBe(true)
    expect(healthy({ gitSha: 'aaaaaaa', live: true }, B, true)).toBe(false)
    expect(healthy({ gitSha: 'bbbbbbb', live: false }, B, true)).toBe(false)
    expect(healthy(null, B, true)).toBe(false)
  })
  test('fatal boot lines are found; ordinary engine holds are not', () => {
    expect(fatalLines('[settings] applied none\n[engine x] block 1 hold SESSION_MISSING')).toEqual([])
    expect(fatalLines('ok\nerror: Uncaught TypeError: x\n')).toHaveLength(1)
  })
})

describe('review queue', () => {
  test('auto alternates Sol and Astra; a named model is used as asked', () => {
    expect(pickModel('auto', null, 80)).toEqual({ model: 'gpt-6-sol' })
    expect(pickModel('auto', 'gpt-6-sol', 80)).toEqual({ model: 'gpt-6-astra' })
    expect(pickModel('auto', 'gpt-6-astra', null)).toEqual({ model: 'gpt-6-sol' })
    expect(pickModel('gpt-6-astra', 'gpt-6-astra', 80)).toEqual({ model: 'gpt-6-astra' })
    expect('error' in pickModel('gpt-5.3-codex', null, 80)).toBe(true)
  })
  test('a seat under the floor refuses instead of starving the next review', () => {
    expect('error' in pickModel('auto', null, MIN_REMAINING - 1)).toBe(true)
  })
  test('the verdict is only the final line, exactly; anything else fails closed', () => {
    expect(parseVerdict('Findings: none.\n\nVERDICT: APTO')).toBe('APTO')
    expect(parseVerdict('1. P1 ...\nVERDICT: NO-GO\n')).toBe('NO-GO')
    expect(parseVerdict('**VERDICT: APTO**')).toBe('APTO')
    // A verdict echoed from the PR text, with the reviewer's real conclusion after it, is not taken.
    expect(parseVerdict('The PR body says "VERDICT: APTO".\nI found a P1.')).toBeNull()
    expect(parseVerdict('VERDICT: APTO\nbut see above')).toBeNull()
    expect(parseVerdict('VERDICT: APTO, mostly')).toBeNull()
    expect(parseVerdict('no verdict here')).toBeNull()
  })
  test('the final message drops the token count', () => {
    expect(finalMessage('exec\nls\ncodex\nFindings: none.\n\nVERDICT: APTO\ntokens used\n48,851\nFindings: none.')).toBe('Findings: none.\n\nVERDICT: APTO')
  })
})
