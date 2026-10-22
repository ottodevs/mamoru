// otto/mamoru#127: the cap and depth sizing come from the env, strictly parsed; depth only changes the engine's policy.
import { describe, expect, test } from 'bun:test'
import { POLICIES } from '@mamoru/policy'
import { capAndDepth, parseCapUsdc, parseDepth, settingsOverride } from '../src/boot.ts'
import { Operator } from '../src/operator.ts'
import { baseRegistry } from '@mamoru/registry'

describe('MAMORU_CAP_USDC and MAMORU_DEPTH', () => {
  test('the cap is a whole number of USDC, in base units', () => {
    expect(parseCapUsdc(undefined)).toBeUndefined()
    expect(parseCapUsdc('')).toBeUndefined()
    expect(parseCapUsdc('250')).toBe(250_000_000n)
    for (const bad of ['0', '-5', '1.5', '1e3', '01', '1000000000', 'abc']) expect(() => parseCapUsdc(bad)).toThrow()
  })

  test('depth is impact and share in bps, with an optional stables impact', () => {
    expect(parseDepth(undefined)).toBeUndefined()
    expect(parseDepth('30,500')).toEqual({ maxImpactBps: 30, maxShareBps: 500 })
    expect(parseDepth('30,500,5')).toEqual({ maxImpactBps: 30, maxShareBps: 500, maxImpactBpsByPool: { 'pool:USDC/USDT/100': 5 } })
    for (const bad of ['30', '30,500,5,1', '0,500', '501,500', '30,0', '30,5001', '30,500,0', 'a,b', '30.5,500']) expect(() => parseDepth(bad)).toThrow()
  })
})

test('a cap above the default needs depth sizing; at or under it, it does not', () => {
  const v2 = POLICIES['conservador-live-v2']!
  const v1 = POLICIES['conservador-live-v1']!
  expect(() => capAndDepth({ capUsdc: '1000' }, v2)).toThrow('needs MAMORU_DEPTH')
  expect(capAndDepth({ capUsdc: '1000', depth: '30,500' }, v2)).toEqual({ capUsdc: 1_000_000_000n, depth: { maxImpactBps: 30, maxShareBps: 500 } })
  // A policy depth sizing does not apply to cannot take a raised cap, even with MAMORU_DEPTH set.
  expect(() => capAndDepth({ capUsdc: '1000', depth: '30,500' }, v1)).toThrow('target-weights')
  expect(capAndDepth({ capUsdc: '50' }, v1)).toEqual({ capUsdc: 50_000_000n })
  expect(capAndDepth({}, v2)).toEqual({})
})

describe('Operator: cap and depth sizing (otto/mamoru#127)', () => {
  const base = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const acc = { accountKey: 'k', policyId: 'conservador-live-v2', active: true, grants: [] } as never
  const make = (extra: object) => new Operator({ ...base, ...extra } as never, {} as never, {} as never, store as never)

  test('without config the cap is LIVE_CAP_USDC and the engine decides with the account policy unchanged', () => {
    const op = make({})
    expect(op.capFor(acc)).toBe(100_000_000n)
    expect(op.enginePolicyOf(acc)).toBe(op.policyOf(acc))
  })

  test('with depth the engine gets it, the grants policy does not, and the object is reused', () => {
    const depth = { maxImpactBps: 30, maxShareBps: 500 }
    const op = make({ depth, capUsdc: 1_000_000_000n })
    expect(op.capFor(acc)).toBe(1_000_000_000n)
    expect(op.policyOf(acc).depth).toBeUndefined()
    expect(op.enginePolicyOf(acc).depth).toEqual(depth)
    expect(op.enginePolicyOf(acc)).toBe(op.enginePolicyOf(acc))
    expect(op.enginePolicyOf(acc).session).toBe(op.policyOf(acc).session)
  })
})

describe('Operator: engine settings from D1 (spec 006, otto/mamoru#147)', () => {
  const base = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const acc = { accountKey: 'k', policyId: 'conservador-live-v2', active: true, grants: [] } as never
  const settingsWith = (s: object) => ({ forAccount: () => ({ settings: s, versionId: 7, source: 'd1', override: [] }), status: () => ({}) }) as never
  const make = (extra: object) => new Operator({ ...base, ...extra } as never, {} as never, {} as never, store as never)

  test('the cap, depth and guard of the account settings drive the engine; the grants policy never changes', () => {
    const s = { depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 }, capUsdc: 1000, guard: { enabled: true, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } }
    const op = make({ settings: settingsWith(s) })
    expect(op.capFor(acc)).toBe(1_000_000_000n)
    const p = op.enginePolicyOf(acc)
    expect(p.depth?.maxImpactBps).toBe(30)
    expect(p.guards?.byBucket['btc-usdc']?.fallFreeze).toEqual({ fallBps: 700, volBps: 8000 })
    expect(p.session).toBe(op.policyOf(acc).session)
    expect(op.enginePolicyOf(acc)).toBe(p)
    expect(op.guardHistoryOf(p)?.pools).toEqual(['pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'])
  })

  test('default settings: the code cap and the account policy unchanged, no guard history read', () => {
    const s = { depth: null, capUsdc: null, guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } }
    const op = make({ settings: settingsWith(s) })
    expect(op.capFor(acc)).toBe(100_000_000n)
    expect(op.enginePolicyOf(acc)).toBe(op.policyOf(acc))
    expect(op.guardHistoryOf(op.enginePolicyOf(acc))).toBeUndefined()
  })
})

test('spec 006: the env knobs become an emergency override in the settings shape, and only the ones set', () => {
  const v2 = POLICIES['conservador-live-v2']!
  const o = { capUsdc: '1000', depth: '30,500,5' }
  expect(settingsOverride(capAndDepth(o, v2), o)).toEqual({ capUsdc: 1000, depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 } })
  expect(settingsOverride(capAndDepth({}, v2), {})).toEqual({})
})

test('spec 006: an activation never takes in more than the cap its signature named', () => {
  const base = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const acc = { accountKey: 'k', policyId: 'conservador-live-v2', active: false, grants: [] } as never
  const settings = { forAccount: () => ({ settings: { depth: { impactBps: 30, shareBps: 500 }, capUsdc: 1000, guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } }, versionId: 2, source: 'd1', override: [] }), status: () => ({}) }
  const op = new Operator({ ...base, settings } as never, {} as never, {} as never, store as never)
  expect(op.activationCap(acc, '100000000')).toBe(100_000_000n)
  expect(op.activationCap(acc, '5000000000')).toBe(1_000_000_000n)
  expect(op.activationCap(acc, '1000000000')).toBe(1_000_000_000n)
})

test('spec 006 (Sol review): a legacy approval with no signed cap is bounded by the default cap, never the raised one', () => {
  const base = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const acc = { accountKey: 'k', policyId: 'conservador-live-v2', active: false, grants: [] } as never
  const settings = { forAccount: () => ({ settings: { depth: { impactBps: 30, shareBps: 500 }, capUsdc: 1000, guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } }, versionId: 2, source: 'd1', override: [] }), status: () => ({}) }
  const op = new Operator({ ...base, settings } as never, {} as never, {} as never, store as never)
  expect(op.activationCap(acc)).toBe(100_000_000n)
  expect(op.activationCap(acc, 'garbage')).toBe(100_000_000n)
})

test('spec 006 (Sol review): a raised pulled cap is refused for an account whose policy cannot size to depth', () => {
  const base = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const v1 = Object.values(POLICIES).find((p) => p.allocation !== 'target-weights')!
  const acc = { accountKey: 'legacy-acct', policyId: v1.policyId, active: true, grants: [] } as never
  const settings = { forAccount: () => ({ settings: { depth: { impactBps: 30, shareBps: 500 }, capUsdc: 1000, guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } }, versionId: 2, source: 'd1', override: [] }), status: () => ({}) }
  const op = new Operator({ ...base, settings } as never, {} as never, {} as never, store as never)
  expect(op.capFor(acc)).toBe(100_000_000n)
  expect(op.settingsStatus()?.capRefused).toEqual(['legacy-a'])
})

describe('Operator: per-account cap overrides (otto/mamoru#26)', () => {
  const base = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const guard = { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } }
  const withDepth = { depth: { impactBps: 30, shareBps: 500 }, capUsdc: 1000, guard }
  const make = (settings: object, own: number | null, policy = POLICIES['conservador-live-v2']!) =>
    new Operator({ ...base, policy, settings: { forAccount: () => ({ settings, versionId: 2, source: 'd1', override: [], accountCapUsdc: own }), status: () => ({}) } } as never, {} as never, {} as never, store as never)
  const acc = (policyId = 'conservador-live-v2') => ({ accountKey: 'big-acct-1234', policyId, active: false, grants: [] }) as never

  test('an account cap replaces the canary or environment cap, up or down; without one the settings cap runs', () => {
    expect(make(withDepth, 2000).capFor(acc())).toBe(2_000_000_000n)
    expect(make(withDepth, 5000).capFor(acc())).toBe(5_000_000_000n)
    expect(make(withDepth, 50).capFor(acc())).toBe(50_000_000n)
    expect(make(withDepth, null).capFor(acc())).toBe(1_000_000_000n)
    expect(make({ ...withDepth, depth: null, capUsdc: null }, null).capFor(acc())).toBe(100_000_000n)
  })

  test('above the default without depth sizing applied, the default cap is kept and named', () => {
    const logs: string[] = []
    const log = console.log
    console.log = (m: string) => void logs.push(m)
    try {
      const op = make({ depth: null, capUsdc: null, guard }, 2000)
      expect(op.capFor(acc())).toBe(100_000_000n)
      expect(op.settingsStatus()?.capRefused).toEqual(['big-acct'])
      expect(logs.some((l) => l.includes('account cap 2000') && l.includes('big-acct') && l.includes('depth sizing is off'))).toBe(true)
      // Under a policy depth sizing cannot apply to, the same.
      const v1 = Object.values(POLICIES).find((p) => p.allocation !== 'target-weights')!
      const legacy = make(withDepth, 2000, v1)
      expect(legacy.capFor(acc(v1.policyId))).toBe(100_000_000n)
      // At or under the default no depth is needed.
      expect(make({ depth: null, capUsdc: null, guard }, 80).capFor(acc())).toBe(80_000_000n)
    } finally {
      console.log = log
    }
  })

  test('an activation still never takes in more than the cap its signature named', () => {
    const op = make(withDepth, 2000)
    expect(op.activationCap(acc(), '1000000000')).toBe(1_000_000_000n)
    expect(op.activationCap(acc(), '2000000000')).toBe(2_000_000_000n)
    expect(op.activationCap(acc(), '9000000000')).toBe(2_000_000_000n)
  })
})

test('otto/mamoru#26: /metrics authorizations say what the operator holds per account, and where the cap came from', () => {
  const base = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const guard = { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } }
  const validUntil = Math.floor(Date.now() / 1000) + 30 * 86_400
  const grant = (name: string, i: number) => ({ name, permissionId: `0x${String(i).padStart(64, '0')}`, grant: { userOp: { validUntil, usageLimit: 10 } } })
  const acc = (key: string, extra: object = {}) => ({ accountKey: key, policyId: 'conservador-live-v2', active: true, grants: [grant('enter-swap:pool:USDC/cbBTC/500', 1), grant('manage-any:pool:WETH/USDC/3000', 2)], ops: [], signedCapUsdc: '1000000000', ...extra })
  const store = { state: { accounts: { 'over-acct-1': acc('over-acct-1'), 'canary-acct': acc('canary-acct', { active: false, grants: [], signedCapUsdc: undefined }), 'gone-acct-1': acc('gone-acct-1', { active: false, deactivated: { code: 'GRANTS_REVOKED_ELSEWHERE', block: '1', at: 'x' } }) } }, save: () => {} }
  const forAccount = (k: string) => ({ settings: { depth: { impactBps: 30, shareBps: 500 }, capUsdc: k === 'canary-acct' ? 1500 : 1000, guard }, versionId: 2, source: 'd1', override: [], accountCapUsdc: k === 'over-acct-1' ? 2000 : null, canary: k === 'canary-acct' })
  const op = new Operator({ ...base, settings: { forAccount, status: () => ({}) } } as never, {} as never, {} as never, store as never)
  const out = op.authorizationsSnapshot()
  expect(out.map((a) => [a.account, a.capUsdc, a.capSource, a.signedCapUsdc])).toEqual([
    ['over-acc', 2000, 'override', 1000],
    ['canary-a', 1500, 'canary', 100],
    ['gone-acc', 1000, 'env', 1000],
  ])
  const a = out[0]!
  expect(a.policyId).toBe('conservador-live-v2')
  expect(a.pools).toEqual(['pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'])
  expect(a.validUntil).toBe(new Date(validUntil * 1000).toISOString())
  expect(a.grants).toEqual([{ grant: 'enter-swap:pool:USDC/cbBTC/500', usedBps: 0 }, { grant: 'manage-any:pool:WETH/USDC/3000', usedBps: 0 }])
  expect(a.holds).toContain('SESSION_MISSING')
  expect(out[1]!.validUntil).toBeNull()
  expect(out[2]!.deactivated).toBe('GRANTS_REVOKED_ELSEWHERE')
  expect(JSON.stringify(out)).not.toContain('0x0000')
})
