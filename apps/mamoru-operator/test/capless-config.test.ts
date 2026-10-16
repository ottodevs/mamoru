// otto/mamoru#127: the cap and depth sizing come from the env, strictly parsed; depth only changes the engine's policy.
import { describe, expect, test } from 'bun:test'
import { POLICIES } from '@mamoru/policy'
import { capAndDepth, parseCapUsdc, parseDepth, settingsOverride } from '../src/boot.ts'
import { Operator } from '../src/operator.ts'

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
  const base = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
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
  const base = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
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
  const base = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const acc = { accountKey: 'k', policyId: 'conservador-live-v2', active: false, grants: [] } as never
  const settings = { forAccount: () => ({ settings: { depth: { impactBps: 30, shareBps: 500 }, capUsdc: 1000, guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } }, versionId: 2, source: 'd1', override: [] }), status: () => ({}) }
  const op = new Operator({ ...base, settings } as never, {} as never, {} as never, store as never)
  expect(op.activationCap(acc, '100000000')).toBe(100_000_000n)
  expect(op.activationCap(acc, '5000000000')).toBe(1_000_000_000n)
  expect(op.activationCap(acc, '1000000000')).toBe(1_000_000_000n)
})

test('spec 006 (Sol review): a legacy approval with no signed cap is bounded by the default cap, never the raised one', () => {
  const base = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const acc = { accountKey: 'k', policyId: 'conservador-live-v2', active: false, grants: [] } as never
  const settings = { forAccount: () => ({ settings: { depth: { impactBps: 30, shareBps: 500 }, capUsdc: 1000, guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } }, versionId: 2, source: 'd1', override: [] }), status: () => ({}) }
  const op = new Operator({ ...base, settings } as never, {} as never, {} as never, store as never)
  expect(op.activationCap(acc)).toBe(100_000_000n)
  expect(op.activationCap(acc, 'garbage')).toBe(100_000_000n)
})

test('spec 006 (Sol review): a raised pulled cap is refused for an account whose policy cannot size to depth', () => {
  const base = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const v1 = Object.values(POLICIES).find((p) => p.allocation !== 'target-weights')!
  const acc = { accountKey: 'legacy-acct', policyId: v1.policyId, active: true, grants: [] } as never
  const settings = { forAccount: () => ({ settings: { depth: { impactBps: 30, shareBps: 500 }, capUsdc: 1000, guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10000 } } }, versionId: 2, source: 'd1', override: [] }), status: () => ({}) }
  const op = new Operator({ ...base, settings } as never, {} as never, {} as never, store as never)
  expect(op.capFor(acc)).toBe(100_000_000n)
  expect(op.settingsStatus()?.capRefused).toEqual(['legacy-a'])
})
