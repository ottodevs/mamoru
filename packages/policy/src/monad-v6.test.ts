import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters } from 'viem'
import { address, monadRegistry } from '@mamoru/registry'
import { computeCaps, instantiateGrant, policyHash, type GrantContext } from './instantiate.ts'
import { liveWmonUsdcMonadV5, liveWmonUsdcMonadV6, labWmonUsdcMonadV6 } from './policies-monad.ts'
import { conservadorLiveV6 } from './policies-v6.ts'
import { decodeMamoruInitAny, encodeMamoruInit, encodeMamoruInitAtSetup, FAMILY_UNISWAP_AT_SETUP, grantsV3Only, grantsV5, MAMORU_INIT_TUPLE, mamoruInitFor, V4_POOLS_MONAD } from './v4-grants.ts'

const CAP = 1_500n * 1_000_000n

function ctx(): GrantContext {
  return { account: '0x00000000000000000000000000000000000000aa', sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 143, salt: `0x${'00'.repeat(32)}`, validAfter: 0, validUntil: 1, caps: computeCaps(liveWmonUsdcMonadV6, CAP, {}) }
}

describe('live-wmon-usdc-monad-v6 (otto/mamoru#251)', () => {
  test('conservador-live-v6 points its Growth bucket at it', () => {
    expect(conservadorLiveV6.remoteBuckets![0]!.policyId).toBe(liveWmonUsdcMonadV6.policyId)
  })

  test("v5's pool, range, budgets and usage on Monad mainnet, under a new id and hash", () => {
    expect(liveWmonUsdcMonadV6.chain).toBe('monad')
    expect(liveWmonUsdcMonadV6.sourceChainId).toBe(143)
    expect(labWmonUsdcMonadV6.chain).toBe('fork')
    expect(liveWmonUsdcMonadV6.buckets).toEqual(liveWmonUsdcMonadV5.buckets)
    expect(liveWmonUsdcMonadV6.range).toEqual(liveWmonUsdcMonadV5.range)
    expect(policyHash(liveWmonUsdcMonadV6)).not.toBe(policyHash(liveWmonUsdcMonadV5))
    expect(liveWmonUsdcMonadV6.session.grants.map((g) => [g.name, g.usageLimit])).toEqual(liveWmonUsdcMonadV5.session.grants.map((g) => [g.name, g.usageLimit]))
  })

  test('every grant: v5 actions, no param rule, V3 its only action policy', () => {
    const v5 = grantsV5(V4_POOLS_MONAD.growth, { enterSwap: 1, enterMint: 1, manageAny: 1 })
    const v3 = grantsV3Only(V4_POOLS_MONAD.growth, { enterSwap: 1, enterMint: 1, manageAny: 1 })
    expect(v3.map((g) => g.actions.map((a) => `${a.target}.${a.signature}`))).toEqual(v5.map((g) => g.actions.map((a) => `${a.target}.${a.signature}`)))
    for (const g of liveWmonUsdcMonadV6.session.grants) {
      expect(g.actionPolicyOnly).toBe(true)
      expect(g.requiresActionPolicy).toBe(true)
      expect(g.actions.every((a) => a.params.length === 0)).toBe(true)
      const r = instantiateGrant(liveWmonUsdcMonadV6, `${g.name}:${g.pool}`, ctx())
      expect(r.actionPolicyOnly).toBe(true)
      expect(r.actions.every((a) => a.params.length === 0)).toBe(true)
    }
  })

  test('caps: the budget pair only, in USDC, so the setup needs no price', () => {
    const c = computeCaps(liveWmonUsdcMonadV6, CAP, {})
    const s = V4_POOLS_MONAD.growth.caps
    expect(Object.keys(c).sort()).toEqual([s.budgetTotal, s.budgetWindow].sort())
    expect(c[s.budgetWindow]).toBe(CAP * 3n)
    expect(c[s.budgetTotal]).toBe(CAP * 10n)
  })

  test('an actionPolicyOnly template with a param rule is refused', () => {
    const bad = { ...liveWmonUsdcMonadV6, session: { ...liveWmonUsdcMonadV6.session, grants: liveWmonUsdcMonadV6.session.grants.map((g, i) => (i ? g : { ...g, actions: [{ ...g.actions[0]!, params: [{ field: 'x', index: 0, condition: 'EQUAL' as const, ref: 'ACCOUNT' as const, denial: 'POLICY_DENIED_TARGET' as const }] }, ...g.actions.slice(1)] })) } }
    expect(() => instantiateGrant(bad, `${bad.session.grants[0]!.name}:${bad.session.grants[0]!.pool}`, ctx())).toThrow('no param rules')
  })
})

describe('MamoruActionPolicyV3 setup-mode Init (otto/mamoru#251)', () => {
  const init = mamoruInitFor(V4_POOLS_MONAD.growth, 1n, computeCaps(liveWmonUsdcMonadV6, CAP, {}))

  test('abi.encode(FAMILY_UNISWAP_AT_SETUP, Init), as the contract decodes it', () => {
    expect(init.pool).toBe(address('pool:WMON/USDC/3000', monadRegistry))
    const enc = encodeMamoruInitAtSetup(init)
    expect(enc).toBe(encodeAbiParameters([{ type: 'uint256' }, ...MAMORU_INIT_TUPLE], [3n, init]))
    expect(FAMILY_UNISWAP_AT_SETUP).toBe(3n)
    expect(decodeMamoruInitAny(enc)).toEqual({ init, atSetup: true })
    expect(decodeMamoruInitAny(encodeMamoruInit(init))).toEqual({ init, atSetup: false })
  })

  test('setup mode admits no position (the contract would refuse it: BadInit 13)', () => {
    expect(() => encodeMamoruInitAtSetup({ ...init, admit: [1n] })).toThrow('admits no position')
  })
})
