import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters } from 'viem'
import { address, monadRegistry } from '@mamoru/registry'
import { computeCaps, instantiateGrant, policyHash, type GrantContext } from './instantiate.ts'
import { grantKeyFor } from './grants.ts'
import { labWmonUsdcMonadV1, liveWmonUsdcMonadV6, labWmonUsdcMonadV6 } from './policies-monad.ts'
import { conservadorLiveV5, INCREASE_TOLERANCE_BPS } from './policies-v4.ts'
import { conservadorLiveV6 } from './policies-v6.ts'
import { decodeMamoruInitAny, encodeMamoruInit, encodeMamoruInitAtSetup, FAMILY_UNISWAP_AT_SETUP, exitOnlyV3Only, exitOnlyV5Grant, grantsV5, manageAnyV3Only, MAMORU_INIT_TUPLE, mamoruInitFor, V4_POOLS_MONAD } from './v4-grants.ts'

const CAP = 1_500n * 1_000_000n

function ctx(): GrantContext {
  return { account: '0x00000000000000000000000000000000000000aa', sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 143, salt: `0x${'00'.repeat(32)}`, validAfter: 0, validUntil: 1, caps: computeCaps(liveWmonUsdcMonadV6, CAP, {}) }
}

describe('live-wmon-usdc-monad-v6 (otto/mamoru#251)', () => {
  test('conservador-live-v6 points its Growth bucket at it', () => {
    expect(conservadorLiveV6.remoteBuckets![0]!.policyId).toBe(liveWmonUsdcMonadV6.policyId)
  })

  test('WMON/USDC on Monad mainnet: the lab range, v5 harvest, execution and session, a MON gas reserve', () => {
    expect(liveWmonUsdcMonadV6.chain).toBe('monad')
    expect(liveWmonUsdcMonadV6.sourceChainId).toBe(143)
    expect(labWmonUsdcMonadV6.chain).toBe('fork')
    expect(liveWmonUsdcMonadV6.buckets).toEqual([{ id: 'risk', preference: 10_000, pools: ['pool:WMON/USDC/3000'] }])
    expect(liveWmonUsdcMonadV6.range).toEqual({ ...labWmonUsdcMonadV1.range, increaseToleranceBps: INCREASE_TOLERANCE_BPS })
    expect(liveWmonUsdcMonadV6.execution).toEqual(conservadorLiveV5.execution)
    expect(liveWmonUsdcMonadV6.session.validitySeconds).toBe(conservadorLiveV5.session.validitySeconds)
    expect(liveWmonUsdcMonadV6.gasReserveWei).toBe(2_000_000_000_000_000_000n)
    expect(policyHash(liveWmonUsdcMonadV6)).not.toBe(policyHash(labWmonUsdcMonadV6))
    // One session carries v5's three: their usage together.
    expect(liveWmonUsdcMonadV6.session.grants.map((g) => [g.name, g.usageLimit])).toEqual([['manage-any', 36_000]])
  })

  test('one manage-any: every action of v5\'s three grants once, no param rule, V3 its only action policy', () => {
    const usage = { enterSwap: 1, enterMint: 1, manageAny: 1 }
    const v5 = new Set(grantsV5(V4_POOLS_MONAD.growth, usage).flatMap((g) => g.actions.map((a) => `${a.target}.${a.signature}`)))
    const v3 = manageAnyV3Only(V4_POOLS_MONAD.growth, usage)
    const got = v3.actions.map((a) => `${a.target}.${a.signature}`)
    expect(new Set(got)).toEqual(v5)
    expect(got.length).toBe(v5.size)
    // The entries are handed to it: decide asks for enter-swap / enter-mint and gets this session.
    expect(grantKeyFor(liveWmonUsdcMonadV6, 'enter-swap', 'pool:WMON/USDC/3000')).toBe('manage-any:pool:WMON/USDC/3000')
    expect(grantKeyFor(liveWmonUsdcMonadV6, 'enter-mint', 'pool:WMON/USDC/3000')).toBe('manage-any:pool:WMON/USDC/3000')
    expect(() => grantKeyFor(liveWmonUsdcMonadV6, 'enter-swap', 'pool:EURW/USDC/100')).toThrow('no enter-swap')
    // Exit only stays exit only under V3 alone: no mint, no increase, no approval of the stable token.
    const exit = exitOnlyV3Only(V4_POOLS_MONAD.growth, 1)
    expect(exit.actions.map((a) => `${a.target}.${a.signature}`)).toEqual(exitOnlyV5Grant(V4_POOLS_MONAD.growth, 1).actions.map((a) => `${a.target}.${a.signature}`))
    expect(exit.actions.every((a) => a.params.length === 0) && exit.actionPolicyOnly).toBe(true)
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
