import { describe, expect, test } from 'bun:test'
import { address } from '@mamoru/registry'
import { conservadorV1, instantiateGrant } from '@mamoru/policy'
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
