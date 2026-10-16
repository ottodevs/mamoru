// otto/mamoru#127: the cap and depth sizing come from the env, strictly parsed; depth only changes the engine's policy.
import { describe, expect, test } from 'bun:test'
import { POLICIES } from '@mamoru/policy'
import { capAndDepth, parseCapUsdc, parseDepth } from '../src/boot.ts'
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
  expect(() => capAndDepth({ capUsdc: '1000' })).toThrow('needs MAMORU_DEPTH')
  expect(capAndDepth({ capUsdc: '1000', depth: '30,500' })).toEqual({ capUsdc: 1_000_000_000n, depth: { maxImpactBps: 30, maxShareBps: 500 } })
  expect(capAndDepth({ capUsdc: '50' })).toEqual({ capUsdc: 50_000_000n })
  expect(capAndDepth({})).toEqual({})
})

describe('Operator: cap and depth sizing (otto/mamoru#127)', () => {
  const base = { chainId: 8453, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  const store = { state: { accounts: {} }, save: () => {} }
  const acc = { accountKey: 'k', policyId: 'conservador-live-v2', active: true, grants: [] } as never
  const make = (extra: object) => new Operator({ ...base, ...extra } as never, {} as never, {} as never, store as never)

  test('without config the cap is LIVE_CAP_USDC and the engine decides with the account policy unchanged', () => {
    const op = make({})
    expect(op.cap).toBe(100_000_000n)
    expect(op.enginePolicyOf(acc)).toBe(op.policyOf(acc))
  })

  test('with depth the engine gets it, the grants policy does not, and the object is reused', () => {
    const depth = { maxImpactBps: 30, maxShareBps: 500 }
    const op = make({ depth, capUsdc: 1_000_000_000n })
    expect(op.cap).toBe(1_000_000_000n)
    expect(op.policyOf(acc).depth).toBeUndefined()
    expect(op.enginePolicyOf(acc).depth).toEqual(depth)
    expect(op.enginePolicyOf(acc)).toBe(op.enginePolicyOf(acc))
    expect(op.enginePolicyOf(acc).session).toBe(op.policyOf(acc).session)
  })
})
