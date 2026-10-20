import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsResponseSignature, verifyMetricsSignature } from '@mamoru/operator-auth'
import { createHash } from 'node:crypto'
import { canonicalSettingsJson, DEFAULT_ENGINE_SETTINGS, ENGINE_SETTINGS_TEMPLATES, type EngineSettings } from '@mamoru/policy'
import { checkPayload, ENGINE_SETTINGS_PATH, EngineSettingsSource, resolveFor, type SettingsVersion } from '../src/engine-settings.ts'

const SECRET = 'op-secret'
const NOW = 1_760_616_000_000
const depth = ENGINE_SETTINGS_TEMPLATES['conservador + depth 30/500/5, cap 1000']!

const hashOf = (s: unknown) => { try { return createHash('sha256').update(canonicalSettingsJson(s as EngineSettings)).digest('hex') } catch { return 'x' } }
const v = (id: number, env: 'prod' | 'beta', settings: unknown = depth, accountKeys: string[] | null = null) =>
  ({ id, env, accountKeys, template: `t${id}`, settings, hash: hashOf(settings), createdAt: '2026-10-16T00:00:00Z' }) as SettingsVersion

/** A fake app Worker: checks the request signature like the real one and signs what it returns. */
function worker(body: () => unknown, opts: { badSig?: boolean; status?: number } = {}) {
  const calls: string[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(url)
    const sig = new Headers(init?.headers).get('x-mamoru-sig')
    if (!(await verifyMetricsSignature(SECRET, 'GET', ENGINE_SETTINGS_PATH, sig, NOW))) return new Response('no', { status: 401 })
    if (opts.status) return new Response('x', { status: opts.status })
    const text = JSON.stringify(body())
    const out = await settingsResponseSignature(opts.badSig ? 'other' : SECRET, text, Math.floor(NOW / 60_000))
    return new Response(text, { status: 200, headers: { 'x-mamoru-sig': out } })
  }
  return { fetch, calls }
}

const source = (fetch: ReturnType<typeof worker>['fetch'], stateDir = mkdtempSync(join(tmpdir(), 'settings-')), extra: object = {}) =>
  new EngineSettingsSource({ url: 'https://app.example', secret: SECRET, stateDir, fetch, now: () => NOW, ...extra })

describe('operator engine settings (spec 006)', () => {
  test('a signed, in-bounds pull applies, is saved as last-known-good (0600) and resolves per account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-'))
    const w = worker(() => ({ versions: [v(1, 'prod'), v(2, 'prod', DEFAULT_ENGINE_SETTINGS, ['canary-acct']), v(3, 'beta', DEFAULT_ENGINE_SETTINGS)], betaAccounts: ['beta-acct'], servedAt: '2026-10-16T12:00:00.000Z' }))
    const s = source(w.fetch, dir)
    expect(await s.pull()).toBe(true)
    expect(s.forAccount('any').settings.capUsdc).toBe(1000)
    expect(s.forAccount('any').versionId).toBe(1)
    expect(s.forAccount('canary-acct').versionId).toBe(2)
    expect(s.forAccount('CANARY-ACCT').versionId).toBe(2)
    expect(s.forAccount('beta-acct').versionId).toBe(3)
    expect(s.status().source).toBe('d1')
    expect(statSync(join(dir, 'engine-settings.json')).mode & 0o777).toBe(0o600)
    // A new process with the endpoint down runs the last-known-good.
    const again = source(worker(() => ({}), { status: 503 }).fetch, dir)
    expect(again.forAccount('any').versionId).toBe(1)
    expect(again.status().source).toBe('last-known-good')
    await again.pull()
    expect(again.forAccount('any').versionId).toBe(1)
    expect(again.status().lastError).toContain('503')
  })

  test('a response signed with another secret is refused and nothing changes', async () => {
    const s = source(worker(() => ({ versions: [v(1, 'prod')], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }), { badSig: true }).fetch)
    expect(await s.pull()).toBe(false)
    expect(s.forAccount('any').settings).toEqual(DEFAULT_ENGINE_SETTINGS)
    expect(s.status().lastError).toContain('signature')
  })

  test('one version out of the code bounds refuses the whole pull', () => {
    expect(() => checkPayload({ versions: [v(1, 'prod'), v(2, 'beta', { ...depth, capUsdc: 5_000_000 })], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }, null)).toThrow('capUsdc')
    expect(() => checkPayload({ versions: [v(1, 'prod', { ...depth, depth: null })], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }, null)).toThrow('needs depth sizing')
  })

  test('a stale or replayed body cannot take an environment back to an older version', async () => {
    let body: unknown = { versions: [v(5, 'prod')], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }
    const s = source(worker(() => body).fetch)
    await s.pull()
    body = { versions: [v(4, 'prod', DEFAULT_ENGINE_SETTINGS)], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }
    expect(await s.pull()).toBe(false)
    expect(s.forAccount('any').versionId).toBe(5)
    expect(s.status().lastError).toContain('stale')
    // A rollback is a new, higher version: accepted.
    body = { versions: [v(6, 'prod', DEFAULT_ENGINE_SETTINGS)], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }
    expect(await s.pull()).toBe(true)
    expect(s.forAccount('any').settings.capUsdc).toBeNull()
  })

  test('the env override wins and is reported; an out-of-bounds combination falls back to defaults plus override', async () => {
    const s = source(worker(() => ({ versions: [v(1, 'prod')], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' })).fetch, undefined, { override: { capUsdc: 50 } })
    await s.pull()
    expect(s.forAccount('any').settings.capUsdc).toBe(50)
    expect(s.forAccount('any').override).toEqual(['capUsdc'])
    expect(s.status().override).toEqual(['capUsdc'])
    const t = source(worker(() => ({ versions: [v(1, 'prod')], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' })).fetch, undefined, { override: { depth: null } })
    await t.pull()
    const r = t.forAccount('any')
    expect(r.source).toBe('default')
    expect(r.settings).toEqual(DEFAULT_ENGINE_SETTINGS)
    expect(r.override).toEqual([])
    expect(t.status().lastError).toContain('out of bounds')
  })

  test('without a URL nothing is pulled and the code defaults run', async () => {
    const w = worker(() => ({}))
    const s = new EngineSettingsSource({ url: null, secret: SECRET, stateDir: mkdtempSync(join(tmpdir(), 'settings-')), fetch: w.fetch })
    expect(await s.pull()).toBe(false)
    expect(w.calls).toEqual([])
    expect(resolveFor(null, 'x').settings).toEqual(DEFAULT_ENGINE_SETTINGS)
    expect(s.forAccount('x').source).toBe('default')
  })

  test('the last-known-good file holds only what passed every check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-'))
    const s = source(worker(() => ({ versions: [v(1, 'prod')], betaAccounts: ['b'], servedAt: '2026-10-16T12:00:00.000Z' })).fetch, dir)
    await s.pull()
    const saved = JSON.parse(readFileSync(join(dir, 'engine-settings.json'), 'utf8'))
    expect(saved.versions.map((x: SettingsVersion) => x.id)).toEqual([1])
    expect(saved.betaAccounts).toEqual(['b'])
  })
})

describe('operator engine settings: integrity and scope (spec 006 review)', () => {
  test('a version whose hash does not match its settings refuses the pull', () => {
    expect(() => checkPayload({ versions: [{ ...v(1, 'prod'), hash: 'deadbeef' }], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }, null)).toThrow('hash does not match')
  })

  test('a body served before the applied one is a replay, even with the same versions', () => {
    const applied = checkPayload({ versions: [v(1, 'prod')], betaAccounts: ['b'], servedAt: '2026-10-16T12:01:00.000Z' }, null)
    expect(() => checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }, applied)).toThrow('stale')
  })

  test('a body without a valid servedAt is refused', () => {
    expect(() => checkPayload({ versions: [v(1, 'prod')], betaAccounts: [] }, null)).toThrow('servedAt')
    expect(() => checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], servedAt: 'soon' }, null)).toThrow('servedAt')
  })

  test('one canary per environment: a newer canary retires the older one for every account', () => {
    const p = checkPayload({ versions: [v(1, 'prod', DEFAULT_ENGINE_SETTINGS), v(2, 'prod', depth, ['a', 'b']), v(3, 'prod', depth, ['a'])], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }, null)
    expect(resolveFor(p, 'a').versionId).toBe(3)
    expect(resolveFor(p, 'b').versionId).toBe(1)
  })

  test('stop() ends the poll: no timer is armed again', async () => {
    const s = new EngineSettingsSource({ url: 'https://app.example', secret: SECRET, stateDir: mkdtempSync(join(tmpdir(), 'settings-')), fetch: (async () => new Response('x', { status: 503 })) as never, now: () => NOW })
    s.start()
    expect((s as unknown as { timer: unknown }).timer).not.toBeNull()
    s.stop()
    expect((s as unknown as { stopped: boolean }).stopped).toBe(true)
  })
})

describe('operator engine settings: Sol review (spec 006)', () => {
  test('a raised cap is refused at pull time when the operator policy is not target-weights', () => {
    expect(() => checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }, null, { allocation: 'single-pool' })).toThrow('target-weights')
    expect(checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }, null, { allocation: 'target-weights' }).versions).toHaveLength(1)
  })

  test('the local emergency file wins over D1 for every account, is re-read on each poll, and a bad one is ignored', async () => {
    const { writeFileSync, rmSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'settings-'))
    const s = source(worker(() => ({ versions: [v(1, 'prod')], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' })).fetch, dir)
    await s.pull()
    expect(s.forAccount('a').settings.capUsdc).toBe(1000)
    writeFileSync(join(dir, 'engine-settings.local.json'), JSON.stringify(DEFAULT_ENGINE_SETTINGS))
    expect(await s.pull()).toBe(true)
    expect(s.forAccount('a').source).toBe('local')
    expect(s.forAccount('a').settings.capUsdc).toBeNull()
    expect(s.status().source).toBe('local')
    writeFileSync(join(dir, 'engine-settings.local.json'), '{"capUsdc": 5}')
    await s.pull()
    expect(s.forAccount('a').source).toBe('d1')
    expect(s.status().lastError).toContain('ignored')
    rmSync(join(dir, 'engine-settings.local.json'))
    await s.pull()
    expect(s.forAccount('a').versionId).toBe(1)
  })

  test('no successful pull for 15 minutes is reported stale', async () => {
    let t = NOW
    const s = new EngineSettingsSource({ url: 'https://app.example', secret: SECRET, stateDir: mkdtempSync(join(tmpdir(), 'settings-')), fetch: (async () => new Response('x', { status: 503 })) as never, now: () => t })
    await s.pull()
    expect(s.status().stale).toBe(false)
    t = NOW + 16 * 60_000
    await s.pull()
    expect(s.status().stale).toBe(true)
  })
})

describe('operator ops flags (otto/mamoru#129): checkPayload parses `flags`, EngineSettingsSource carries it', () => {
  test('absent flags: every flag reads as off, the pull is not refused', () => {
    const p = checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], servedAt: '2026-10-16T12:00:00.000Z' }, null)
    expect(p.flags).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false })
  })

  test('explicit null flags: the same as absent', () => {
    const p = checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], flags: null, servedAt: '2026-10-16T12:00:00.000Z' }, null)
    expect(p.flags).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false })
  })

  test('a non-object flags field refuses the whole pull', () => {
    expect(() => checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], flags: 'on', servedAt: '2026-10-16T12:00:00.000Z' }, null)).toThrow('flags must be an object')
    expect(() => checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], flags: ['yield_ledger'], servedAt: '2026-10-16T12:00:00.000Z' }, null)).toThrow('flags must be an object')
  })

  test('a malformed or unknown entry reads as off, the rest of the pull still applies', () => {
    const p = checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], flags: { yield_ledger: 'yes', some_future_flag: true }, servedAt: '2026-10-16T12:00:00.000Z' }, null)
    expect(p.versions).toHaveLength(1)
    expect(p.flags).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false })
  })

  test('a valid flags object is carried through as-is', () => {
    const p = checkPayload({ versions: [v(1, 'prod')], betaAccounts: [], flags: { yield_ledger: true }, servedAt: '2026-10-16T12:00:00.000Z' }, null)
    expect(p.flags).toEqual({ yield_ledger: true, onchain_action_policy_v4: false, onchain_action_policy_v5: false })
  })

  test('EngineSettingsSource.flags() and status().flags reflect the latest applied pull; no pull yet is every flag off', async () => {
    const s = source(worker(() => ({ versions: [v(1, 'prod')], betaAccounts: [], flags: { yield_ledger: true }, servedAt: '2026-10-16T12:00:00.000Z' })).fetch)
    expect(s.flags()).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false })
    await s.pull()
    expect(s.flags()).toEqual({ yield_ledger: true, onchain_action_policy_v4: false, onchain_action_policy_v5: false })
    expect(s.status().flags).toEqual({ yield_ledger: true, onchain_action_policy_v4: false, onchain_action_policy_v5: false })
  })

  test('a flag flip alone (same versions, same betaAccounts) still reports changed and fires onChange', async () => {
    let onChangeCalls = 0
    let body: unknown = { versions: [v(1, 'prod')], betaAccounts: [], flags: { yield_ledger: false }, servedAt: '2026-10-16T12:00:00.000Z' }
    const s = new EngineSettingsSource({ url: 'https://app.example', secret: SECRET, stateDir: mkdtempSync(join(tmpdir(), 'settings-')), fetch: worker(() => body).fetch, now: () => NOW, onChange: () => onChangeCalls++ })
    expect(await s.pull()).toBe(true)
    expect(onChangeCalls).toBe(1)
    // Same versions and betaAccounts, only the flag moved: still a change.
    body = { versions: [v(1, 'prod')], betaAccounts: [], flags: { yield_ledger: true }, servedAt: '2026-10-16T12:00:00.000Z' }
    expect(await s.pull()).toBe(true)
    expect(onChangeCalls).toBe(2)
    expect(s.flags()).toEqual({ yield_ledger: true, onchain_action_policy_v4: false, onchain_action_policy_v5: false })
    // Truly nothing changed: no second onChange.
    expect(await s.pull()).toBe(false)
    expect(onChangeCalls).toBe(2)
  })

  test('flags survive via last-known-good: a new process with the endpoint down still knows the flag was on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-'))
    const w = worker(() => ({ versions: [v(1, 'prod')], betaAccounts: [], flags: { yield_ledger: true }, servedAt: '2026-10-16T12:00:00.000Z' }))
    const s = source(w.fetch, dir)
    await s.pull()
    const again = source(worker(() => ({}), { status: 503 }).fetch, dir)
    expect(again.flags()).toEqual({ yield_ledger: true, onchain_action_policy_v4: false, onchain_action_policy_v5: false })
  })
})
