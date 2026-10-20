// otto/mamoru#172: the lazy re-range is an engine setting. It reaches the engine through the account's settings
// (canary included) and never the policy that grants and policy hashes are built from.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { permissionIdOf, toSmartSession } from '@mamoru/account/sessions'
import { settingsResponseSignature } from '@mamoru/operator-auth'
import { canonicalSettingsJson, DEFAULT_ENGINE_SETTINGS, ENGINE_SETTINGS_TEMPLATES, grantKey, instantiateGrant, POLICIES, policyHash, retargetToPolicy, type EngineSettings, type PolicyVersion } from '@mamoru/policy'
import { resolveV4Policy } from '../src/boot.ts'
import { EngineSettingsSource, type SettingsVersion } from '../src/engine-settings.ts'
import { BTC_POOL, fakeClient, MULTICALL3 } from '../../../packages/rpc/test/fake-guard-client.ts'
import { SharedGuardReads } from '@mamoru/rpc'
import { GUARD_READS_MAX_BYTES, GuardReadsState } from '../src/guard-reads-state.ts'
import { Operator } from '../src/operator.ts'

const SECRET = 'op-secret'
const DAY_S = 86_400
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
    expect(lazy.range.lazy).toEqual({ edgeBufferTicks: 100, minDwellSeconds: 1800, horizonSeconds: 86_400, lvrWeightBps: 10_000, requireCostEstimate: true })
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
    expect(gh.shared).toBe(op.guardReads)
    expect(op.guardHistoryOf(op.enginePolicyOf(other))).toBeUndefined()
    // One reader per process, shared by every engine.
    expect(op.guardHistoryOf(lazy)!.shared).toBe(gh.shared)
  })

  test('lazy with the fall guard on: both pool sets are read, the guard pools first', async () => {
    const both = { ...LAZY, guard: { ...LAZY.guard, enabled: true } }
    const op = operator(await sourceWith([version(1, both)]))
    expect(op.guardHistoryOf(op.enginePolicyOf(account('a')))!.pools).toEqual(['pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000', 'pool:USDC/USDT/100'])
    // Guard only: the engine's own pinned reads, as before; no shared reader.
    const guardOnly = operator(await sourceWith([version(1, ENGINE_SETTINGS_TEMPLATES['lab guards (fall freeze 7%/9%)']!)]))
    expect(guardOnly.guardHistoryOf(guardOnly.enginePolicyOf(account('a')))!.shared).toBeUndefined()
  })

  test('restart: fee history and fallback series come back from the state file, and give the cost test its inputs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-reads-'))
    const state = new GuardReadsState(dir)
    expect(state.load()).toEqual({ fees: new Map(), series: new Map() })
    // One process: cbBTC's long observe fails (the oracle answers an hour), so its volatility is the series alone.
    let saves = 0
    const first = new SharedGuardReads({ onUpdate: (st) => (saves++, state.update(st, saves * 60_000)) })
    const client = fakeClient(3_600, { growth: 1n })
    const targets = [{ name: 'pool:USDC/cbBTC/500', address: BTC_POOL }]
    let now = 100 * DAY_S
    for (; now < 100 * DAY_S + 25 * 3_600; now += 300) await first.read(client, MULTICALL3, targets, 1n, now, 1_800)
    expect(statSync(join(dir, 'guard-reads.json')).mode & 0o777).toBe(0o600)
    const loaded = new GuardReadsState(dir).load(now)
    expect(loaded.series.get(1_800)!.get('pool:USDC/cbBTC/500')!.points.length).toBeGreaterThan(40)
    // What was saved at the last write (throttled: a minute of reads may be missing) is what the process held then.
    expect(loaded.fees.get('pool:USDC/cbBTC/500')!.length).toBeGreaterThan(100)
    expect(loaded.series.get(1_800)!.get('pool:USDC/cbBTC/500')!.points.every((p, i, a) => i === 0 || p.time > a[i - 1]!.time)).toBe(true)
    // The next process, built at boot from the file: the first read after the restart has volatility and fee growth.
    const op = new Operator({ ...base, guardReadsState: { load: () => new GuardReadsState(dir).load(now), update: () => {} } } as never, {} as never, {} as never, store as never)
    const after = await op.guardReads.read(client, MULTICALL3, targets, 2n, now + 60, 1_800)
    expect(after['pool:USDC/cbBTC/500']!.realizedVol24hBps).not.toBeNull()
    expect(after['pool:USDC/cbBTC/500']!.feeGrowth24h).not.toBeNull()
    // A file from two days ago is all stale: nothing is restored, and the lazy rule has no estimate (holds).
    const late = now + 2 * DAY_S
    expect(new GuardReadsState(dir).load(late)).toEqual({ fees: new Map(), series: new Map() })
    const stale = new Operator({ ...base, guardReadsState: { load: () => new GuardReadsState(dir).load(late), update: () => {} } } as never, {} as never, {} as never, store as never)
    const blind = await stale.guardReads.read(client, MULTICALL3, targets, 3n, late, 1_800)
    expect(blind['pool:USDC/cbBTC/500']!.realizedVol24hBps).toBeNull()
    expect(blind['pool:USDC/cbBTC/500']!.feeGrowth24h).toBeNull()
  }, 60_000)

  test('the state file is loaded strictly: malformed, unknown, future or oversized entries are dropped; writes are throttled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-reads-'))
    const file = join(dir, 'guard-reads.json')
    const now = 1_800_000_000
    const pt = (time: number, c: string) => ({ time, tickCumulative: c })
    writeFileSync(file, JSON.stringify({
      fees: {
        'pool:WETH/USDC/3000': [{ time: now - 10, growth0X128: '7', growth1X128: '8' }, { time: 'x' }, { time: now - 5, growth0X128: '-1', growth1X128: '1' }, { time: now - 4, growth0X128: (1n << 256n).toString(), growth1X128: '1' }, { time: now + 3_600, growth0X128: '1', growth1X128: '1' }],
        'not a pool': [{ time: now, growth0X128: '1', growth1X128: '1' }],
      },
      series: {
        '1800': { 'pool:USDC/cbBTC/500': [pt(now - 20, '-5'), pt(now - 30, '-4'), pt(now - 30, '-3'), pt(now - 10, '1.5'), pt(now - 200_000, '1')], bad: 3 },
        '1234': { 'pool:USDC/cbBTC/500': [pt(now, '1')] },
        '01800': { 'pool:USDC/cbBTC/500': [pt(now, '1')] },
      },
    }))
    const st = new GuardReadsState(dir).load(now)
    expect(st.fees).toEqual(new Map([['pool:WETH/USDC/3000', [{ time: now - 10, growth0X128: 7n, growth1X128: 8n }]]]) as never)
    // Sorted, one point per time (the last), the malformed and the too-old dropped; unknown windows dropped.
    expect([...st.series.keys()]).toEqual([1_800])
    expect(st.series.get(1_800)!.get('pool:USDC/cbBTC/500')!.points).toEqual([{ time: now - 30, tickCumulative: -3n }, { time: now - 20, tickCumulative: -5n }])
    // Capped at what the series ever holds: the newest only.
    const many = Array.from({ length: 1_000 }, (_, i) => pt(now - 1_000 + i, String(i)))
    writeFileSync(file, JSON.stringify({ fees: {}, series: { '1800': { 'pool:USDC/cbBTC/500': many } } }))
    const capped = new GuardReadsState(dir).load(now).series.get(1_800)!.get('pool:USDC/cbBTC/500')!.points
    expect(capped.length).toBe((4 * DAY_S) / 1_800 + 8)
    expect(capped.at(-1)!.time).toBe(now - 1)
    for (const bad of ['{not json', '[]', 'null', '{"fees":3,"series":[]}']) {
      writeFileSync(file, bad)
      expect(new GuardReadsState(dir).load(now)).toEqual({ fees: new Map(), series: new Map() })
    }
    // Only pools the operator's registry knows: 40 plausible strangers cannot push a real pool out (GPT-6 review, round 4).
    const strangers = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`pool:AAA${i}/BBB/${i + 1}`, [{ time: now - 10, growth0X128: '1', growth1X128: '1' }]]))
    writeFileSync(file, JSON.stringify({ fees: { ...strangers, 'pool:WETH/USDC/3000': [{ time: now - 10, growth0X128: '7', growth1X128: '8' }] }, series: {} }))
    expect([...new GuardReadsState(dir).load(now).fees.keys()]).toEqual(['pool:WETH/USDC/3000'])
    expect(new GuardReadsState(dir, new Set(['pool:AAA1/BBB/2'])).load(now).fees.size).toBe(1)
    // At most one write a minute.
    const w = new GuardReadsState(dir)
    const one = { fees: new Map([['pool:WETH/USDC/3000', [{ time: now, growth0X128: 1n, growth1X128: 2n }]]]), series: new Map() } as never
    w.update(one, 1_000)
    w.update({ fees: new Map(), series: new Map() } as never, 30_000)
    expect(new GuardReadsState(dir).load(now).fees.size).toBe(1)
  })

  test('an oversized state file is refused unread: the operator starts empty, never crashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-reads-'))
    const now = 1_800_000_000
    // Valid JSON, just big: 2 MiB of points for a real pool.
    const point = { time: now - 10, growth0X128: '7', growth1X128: '8' }
    const big = JSON.stringify({ fees: { 'pool:WETH/USDC/3000': Array.from({ length: 40_000 }, () => point) }, series: {} })
    expect(big.length).toBeGreaterThan(GUARD_READS_MAX_BYTES)
    writeFileSync(join(dir, 'guard-reads.json'), big)
    const errors: string[] = []
    const orig = console.error
    console.error = (m: string) => errors.push(m)
    try {
      expect(new GuardReadsState(dir).load(now)).toEqual({ fees: new Map(), series: new Map() })
      const op = new Operator({ ...base, guardReadsState: new GuardReadsState(dir) } as never, {} as never, {} as never, store as never)
      expect(op.guardReads.fees.size).toBe(0)
    } finally {
      console.error = orig
    }
    expect(errors.some((e) => e.includes('not read, starting empty'))).toBe(true)
    // Just under the cap it is read, and capped to the newest points the history keeps.
    writeFileSync(join(dir, 'guard-reads.json'), JSON.stringify({ fees: { 'pool:WETH/USDC/3000': Array.from({ length: 5_000 }, (_, i) => ({ ...point, time: now - 5_000 + i })) }, series: {} }))
    const fees = new GuardReadsState(dir).load(now).fees.get('pool:WETH/USDC/3000')!
    expect(fees.length).toBe((2 * DAY_S) / 600 + 8)
    expect(fees.at(-1)!.time).toBe(now - 1)
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

  test('v4 (spec 007): a conservador-live-v4 account keeps its policy object, hash and grants with the knob on', async () => {
    const v4Policy = resolveV4Policy('base', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: '0x00000000000000000000000000000000000000a1', MAMORU_GAS_POLICY_ADDRESS: '0x00000000000000000000000000000000000000a2' })!
    const v4op = (settings?: EngineSettingsSource) => new Operator({ ...base, v4Policy, ...(settings ? { settings } : {}) } as never, {} as never, {} as never, store as never)
    const off = v4op()
    const on = v4op(await sourceWith([version(1, LAZY)]))
    const acc = { accountKey: 'v4-acct', policyId: 'conservador-live-v4', active: true, grants: [] } as never
    const hash = policyHash(v4Policy)
    expect(on.policyOf(acc)).toBe(v4Policy)
    expect(off.policyOf(acc)).toBe(v4Policy)
    // What the operator signs for a v4 account (operator.ts prepare): every grant instantiated from `policyOf`, then
    // retargeted to the deployed MamoruActionPolicy.
    const signed = (op: Operator) => {
      const p = op.policyOf(acc)
      const ctx = { account: '0x00000000000000000000000000000000000000aa' as const, sessionKey: '0x00000000000000000000000000000000000000bb' as const, chainId: 8453, salt: `0x${'42'.repeat(32)}` as const, validAfter: 1_760_000_000, validUntil: 1_760_000_000 + p.session.validitySeconds, caps: Object.fromEntries(p.session.caps.map((c, i) => [c.name, BigInt(i + 1) * 1_000_000n])), admittedTokenIds: [], capUsdc: 100_000_000n }
      const grants = p.session.grants.filter((g) => !g.perPosition).map((t) => {
        const g = instantiateGrant(p, grantKey(t), ctx)
        return t.requiresActionPolicy ? retargetToPolicy(g, p.actionPolicy!.address) : g
      })
      expect(grants.every((g) => g.policyHash === hash)).toBe(true)
      return JSON.stringify(grants, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))
    }
    expect(signed(on)).toBe(signed(off))
    // The engine copy is lazy, keeps the account-sized action policy and the session/buckets Engine.retune checks.
    const engine = on.enginePolicyOf(acc)
    const eager = off.enginePolicyOf(acc)
    expect(engine.range.lazy).toEqual({ edgeBufferTicks: 100, minDwellSeconds: 1800, horizonSeconds: 86_400, lvrWeightBps: 10_000, requireCostEstimate: true })
    expect(eager.range.lazy).toBeUndefined()
    expect(engine.actionPolicy).toEqual(eager.actionPolicy)
    expect(engine.session).toBe(v4Policy.session)
    expect(engine.buckets).toBe(v4Policy.buckets)
    expect(on.guardHistoryOf(engine)!.shared).toBe(on.guardReads)
    expect(policyHash(v4Policy)).toBe(hash)
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
