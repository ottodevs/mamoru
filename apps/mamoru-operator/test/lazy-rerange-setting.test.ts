// otto/mamoru#172: the lazy re-range is an engine setting. It reaches the engine through the account's settings
// (canary included) and never the policy that grants and policy hashes are built from.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { permissionIdOf, toSmartSession } from '@mamoru/account/sessions'
import { settingsResponseSignature } from '@mamoru/operator-auth'
import { canonicalSettingsJson, DEFAULT_ENGINE_SETTINGS, ENGINE_SETTINGS_TEMPLATES, grantKey, instantiateGrant, POLICIES, policyHash, type EngineSettings, type PolicyVersion } from '@mamoru/policy'
import { EngineSettingsSource, type SettingsVersion } from '../src/engine-settings.ts'
import { Operator } from '../src/operator.ts'

const SECRET = 'op-secret'
const NOW = 1_760_616_000_000
const LAZY = ENGINE_SETTINGS_TEMPLATES['conservador-live-v2 + lazy-h24h-b100-d30']!
const V2 = POLICIES['conservador-live-v2']!
const hashOf = (s: EngineSettings) => createHash('sha256').update(canonicalSettingsJson(s)).digest('hex')
const version = (id: number, settings: EngineSettings, accountKeys: string[] | null = null): SettingsVersion => ({ id, env: 'prod', accountKeys, template: `t${id}`, settings, hash: hashOf(settings), createdAt: '2026-10-18T00:00:00Z' })

/** A settings source fed by a fake, correctly signed app Worker answering `versions`. */
async function sourceWith(versions: SettingsVersion[]): Promise<EngineSettingsSource> {
  const fetch = (async () => {
    const text = JSON.stringify({ versions, betaAccounts: [], servedAt: '2026-10-18T12:00:00.000Z' })
    return new Response(text, { status: 200, headers: { 'x-mamoru-sig': await settingsResponseSignature(SECRET, text, Math.floor(NOW / 60_000)) } })
  }) as never
  const s = new EngineSettingsSource({ url: 'https://app.example', secret: SECRET, stateDir: mkdtempSync(join(tmpdir(), 'settings-')), fetch, now: () => NOW })
  expect(await s.pull()).toBe(true)
  return s
}

const base = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: V2, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
const store = { state: { accounts: {} }, save: () => {} }
const account = (key: string) => ({ accountKey: key, policyId: 'conservador-live-v2', active: true, grants: [] }) as never
const operator = (settings?: EngineSettingsSource) => new Operator({ ...base, ...(settings ? { settings } : {}) } as never, {} as never, {} as never, store as never)

/** Every grant an activation of `policy` would sign, with fixed context: the bytes the owner signs, and their ids. */
function grantsOf(policy: PolicyVersion): string {
  const ctx = {
    account: '0x00000000000000000000000000000000000000aa' as const,
    sessionKey: '0x00000000000000000000000000000000000000bb' as const,
    chainId: 8453,
    salt: `0x${'42'.repeat(32)}` as const,
    validAfter: 1_760_000_000,
    validUntil: 1_760_000_000 + policy.session.validitySeconds,
    caps: Object.fromEntries(policy.session.caps.map((c, i) => [c.name, BigInt(i + 1) * 1_000_000n])),
    admittedTokenIds: [],
    capUsdc: 100_000_000n,
  }
  const grants = policy.session.grants.filter((g) => !g.perPosition).map((g) => instantiateGrant(policy, grantKey(g), ctx))
  return JSON.stringify({ grants, ids: grants.map((g) => permissionIdOf(toSmartSession(g))) }, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))
}

describe('lazy re-range engine setting (otto/mamoru#172)', () => {
  test('a canary with lazy reaches only its accounts; the others keep the eager policy object', async () => {
    const op = operator(await sourceWith([version(1, DEFAULT_ENGINE_SETTINGS), version(2, LAZY, ['Canary-Acct'])]))
    const canary = account('canary-acct')
    const other = account('other-acct')
    const lazy = op.enginePolicyOf(canary)
    expect(lazy.range.lazy).toEqual({ edgeBufferTicks: 100, minDwellSeconds: 1800, horizonSeconds: 86_400, lvrWeightBps: 10_000 })
    expect(lazy.range.cooldownSeconds).toBe(V2.range.cooldownSeconds)
    expect(op.enginePolicyOf(canary)).toBe(lazy)
    expect(op.enginePolicyOf(other)).toBe(V2)
    // Engine.retune accepts it: same id, session and buckets objects.
    expect(lazy.policyId).toBe(V2.policyId)
    expect(lazy.session).toBe(V2.session)
    expect(lazy.buckets).toBe(V2.buckets)
    // The engine of a lazy account reads volatility and fee growth of every pool of the policy; eager reads nothing.
    const gh = op.guardHistoryOf(lazy)!
    expect(gh.pools).toEqual(['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'])
    expect(gh.fees).toBeInstanceOf(Map)
    expect(op.guardHistoryOf(op.enginePolicyOf(other))).toBeUndefined()
    // One history per process, shared by every engine.
    expect(op.guardHistoryOf(lazy)!.fees).toBe(gh.fees)
  })

  test('lazy with the fall guard on: both pool sets are read, the guard pools first', async () => {
    const both = { ...LAZY, guard: { ...LAZY.guard, enabled: true } }
    const op = operator(await sourceWith([version(1, both)]))
    expect(op.guardHistoryOf(op.enginePolicyOf(account('a')))!.pools).toEqual(['pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000', 'pool:USDC/USDT/100'])
  })

  test('grants are byte-identical with the knob on or off, and so is every policy hash', async () => {
    const off = operator()
    const on = operator(await sourceWith([version(1, LAZY)]))
    const acc = account('acct')
    const hashes = Object.fromEntries(Object.entries(POLICIES).map(([k, p]) => [k, policyHash(p)]))
    // What grants are built from: the account's policy, the very same object with or without the setting.
    expect(on.policyOf(acc)).toBe(off.policyOf(acc))
    expect(policyHash(on.policyOf(acc))).toBe(policyHash(V2))
    expect(grantsOf(on.policyOf(acc))).toBe(grantsOf(off.policyOf(acc)))
    expect(JSON.parse(grantsOf(on.policyOf(acc))).grants.every((g: { policyHash: string }) => g.policyHash === '0x3b4759978007f38513d67d64d09b65957e90f9ab4d0c75afa22a1d016d939cf0')).toBe(true)
    // A grant names the hash of the policy it was built from, so one built from the engine's (overlaid) policy would
    // differ: that is why every grant site (approval, renewal, extension, manage) builds from `policyOf`, never
    // `enginePolicyOf`, as it already did for depth sizing and the guard.
    expect(on.enginePolicyOf(acc)).not.toBe(V2)
    expect(grantsOf(on.enginePolicyOf(acc))).not.toBe(grantsOf(V2))
    for (const [k, p] of Object.entries(POLICIES)) expect({ k, h: policyHash(p) }).toEqual({ k, h: hashes[k]! })
  })

  test('a version out of the lazy bounds refuses the whole pull: the engine keeps what it ran', async () => {
    const bad = { ...LAZY, rerange: { mode: 'lazy' as const, edgeBufferTicks: 5000, minDwellSeconds: 1800, horizonSeconds: 86_400, lvrWeightBps: 10_000 } }
    const fetch = (async () => {
      const text = JSON.stringify({ versions: [version(1, bad)], betaAccounts: [], servedAt: '2026-10-18T12:00:00.000Z' })
      return new Response(text, { status: 200, headers: { 'x-mamoru-sig': await settingsResponseSignature(SECRET, text, Math.floor(NOW / 60_000)) } })
    }) as never
    const s = new EngineSettingsSource({ url: 'https://app.example', secret: SECRET, stateDir: mkdtempSync(join(tmpdir(), 'settings-')), fetch, now: () => NOW })
    expect(await s.pull()).toBe(false)
    expect(s.status().lastError).toContain('rerange.edgeBufferTicks')
    expect(operator(s).enginePolicyOf(account('a'))).toBe(V2)
  })
})
