import { describe, expect, test } from 'bun:test'
import { address } from '@mamoru/registry'
import { computeCaps, conservadorLiveV4, conservadorV1, instantiateGrant, V4_POOLS } from '@mamoru/policy'
import { toSmartSession, type SecondActionPolicy } from './index.ts'

const ctx = {
  account: '0x00000000000000000000000000000000000000aa' as const,
  sessionKey: '0x00000000000000000000000000000000000000bb' as const,
  chainId: 8453,
  salt: `0x${'00'.repeat(32)}` as const,
  validAfter: 0,
  validUntil: 1,
  caps: { usdcSwapPerCall: 1n, usdcSwapTotal: 1n, usdcMint: 1n, cbbtcMint: 1n, cbbtcConvertPerCall: 1n, cbbtcConvertTotal: 1n },
}

const v4Ctx = {
  account: ctx.account,
  sessionKey: ctx.sessionKey,
  chainId: 8453,
  salt: ctx.salt,
  validAfter: 0,
  validUntil: 1,
  caps: computeCaps(conservadorLiveV4, 10_000n * 1_000_000n, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } }),
}

describe('toSmartSession (spec 007 otto/mamoru#151, T2)', () => {
  test('without a second policy: byte-for-byte what every live grant (v2/v3) has always produced — one action policy per action', () => {
    const grant = instantiateGrant(conservadorV1, 'enter-swap', ctx)
    const session = toSmartSession(grant)
    expect(session.actions).toHaveLength(grant.actions.length)
    for (const a of session.actions) {
      expect(a.actionPolicies).toHaveLength(1)
      expect(a.actionPolicies[0]!.policy.toLowerCase()).toBe(address('UniActionPolicy').toLowerCase())
    }
  })

  test('with a second policy: it is appended after UniActionPolicy on every action, same initData for all of them', () => {
    const grant = instantiateGrant(conservadorV1, 'enter-swap', ctx)
    const mamoruPolicy = '0x00000000000000000000000000000000000000Fe' as const
    const initData = '0x1234' as const
    const secondPolicy: SecondActionPolicy = { policy: mamoruPolicy, initData }
    const session = toSmartSession(grant, secondPolicy)
    expect(session.actions).toHaveLength(grant.actions.length)
    for (const a of session.actions) {
      expect(a.actionPolicies).toHaveLength(2)
      expect(a.actionPolicies[0]!.policy.toLowerCase()).toBe(address('UniActionPolicy').toLowerCase())
      expect(a.actionPolicies[1]!.policy.toLowerCase()).toBe(mamoruPolicy.toLowerCase())
      expect(a.actionPolicies[1]!.initData).toBe(initData)
    }
  })

  test('everything but actionPolicies is unchanged by the second policy (sessionValidator, salt, userOpPolicies, actionTarget/Selector)', () => {
    const grant = instantiateGrant(conservadorV1, 'enter-swap', ctx)
    const plain = toSmartSession(grant)
    const dual = toSmartSession(grant, { policy: '0x00000000000000000000000000000000000000Fe', initData: '0x' })
    expect(dual.sessionValidator).toBe(plain.sessionValidator)
    expect(dual.sessionValidatorInitData).toBe(plain.sessionValidatorInitData)
    expect(dual.salt).toBe(plain.salt)
    expect(dual.userOpPolicies).toEqual(plain.userOpPolicies)
    expect(dual.permitERC4337Paymaster).toBe(plain.permitERC4337Paymaster)
    expect(dual.actions.map((a) => [a.actionTarget, a.actionTargetSelector])).toEqual(plain.actions.map((a) => [a.actionTarget, a.actionTargetSelector]))
  })
})

describe('toSmartSession: authorization-parity guard (otto/mamoru#151 T7, T6 audit H-2)', () => {
  // T6: "the merged manage-any's volatile-token approve has no UniActionPolicy spender rule, and its cumulative
  // caps follow T_p = 10 x Cp" — both properties rely on MamoruActionPolicy being the session's second policy.
  // `enterSwapV4Grant`/`enterMintV4Grant`/`manageAnyV4Grant` (packages/policy/src/v4-grants.ts) mark every grant
  // they build with `requiresActionPolicy: true`; `toSmartSession` must refuse to encode one without a real
  // second policy, so this cannot silently reach the chain looser than v2/v3.
  const MAMORU_POLICY = '0x00000000000000000000000000000000000000Fe' as const

  test('a v4 grant without a second policy throws SESSION_ACTION_POLICY_MISSING', () => {
    const grant = instantiateGrant(conservadorLiveV4, 'manage-any:pool:USDC/cbBTC/500', v4Ctx)
    expect(grant.requiresActionPolicy).toBe(true)
    expect(() => toSmartSession(grant)).toThrow('a v4 grant needs MamoruActionPolicy')
  })

  test('a v4 grant with the second policy at the zero address throws (zero is the same as none)', () => {
    const grant = instantiateGrant(conservadorLiveV4, 'enter-swap:pool:USDC/cbBTC/500', v4Ctx)
    expect(() => toSmartSession(grant, { policy: '0x0000000000000000000000000000000000000000', initData: '0x' })).toThrow('a v4 grant needs MamoruActionPolicy')
  })

  test('a v4 grant WITH a real second policy builds normally', () => {
    const grant = instantiateGrant(conservadorLiveV4, 'enter-mint:pool:USDC/cbBTC/500', v4Ctx)
    const session = toSmartSession(grant, { policy: MAMORU_POLICY, initData: '0x1234' })
    for (const a of session.actions) {
      expect(a.actionPolicies).toHaveLength(2)
      expect(a.actionPolicies[1]!.policy.toLowerCase()).toBe(MAMORU_POLICY.toLowerCase())
    }
  })

  test('v2/v3 grants are unflagged and unchanged: no second policy required, no throw', () => {
    const grant = instantiateGrant(conservadorV1, 'enter-swap', ctx)
    expect(grant.requiresActionPolicy).toBeUndefined()
    expect(() => toSmartSession(grant)).not.toThrow()
  })
})
