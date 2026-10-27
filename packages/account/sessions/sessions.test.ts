import { describe, expect, test } from 'bun:test'
import { baseRegistry, address } from '@mamoru/registry'
import { computeCaps, conservadorLiveV4, conservadorLiveV5, conservadorLiveV6, POLICY_INCREASE_SIG, conservadorV1, decodeMamoruInit, encodeGasCaps, encodeMamoruInit, grantKey, instantiateGrant, mamoruInitFor, retargetToPolicy, V4_GAS_CAPS, V4_POOLS, v4BudgetCaps, type SessionGrant } from '@mamoru/policy'
import { activationCall, selfAttestCall, selfRevokeAttestationCall, toSmartSession, v4PoliciesFor, type SecondActionPolicy } from './index.ts'

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
      expect(a.actionPolicies[0]!.policy.toLowerCase()).toBe(address('UniActionPolicy', baseRegistry).toLowerCase())
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
      expect(a.actionPolicies[0]!.policy.toLowerCase()).toBe(address('UniActionPolicy', baseRegistry).toLowerCase())
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
  const GAS_POLICY = '0x00000000000000000000000000000000000000Fd' as const
  const OTHER = '0x00000000000000000000000000000000000000Fc' as const
  const caps = v4BudgetCaps(conservadorLiveV4, 10_000n * 1_000_000n)
  const initFor = (g: SessionGrant, poolOverride?: (typeof V4_POOLS)[keyof typeof V4_POOLS]) => encodeMamoruInit(mamoruInitFor(poolOverride ?? Object.values(V4_POOLS).find((p) => p.pool === g.pool)!, 1n, caps))
  const full = (g: SessionGrant, over: Partial<SecondActionPolicy> = {}): SecondActionPolicy => ({
    policy: MAMORU_POLICY,
    initData: initFor(g),
    gas: { policy: GAS_POLICY, initData: encodeGasCaps(V4_GAS_CAPS) },
    expected: { actionPolicy: MAMORU_POLICY, gasPolicy: GAS_POLICY },
    ...over,
  })

  test('a v4 grant without a second policy throws SESSION_ACTION_POLICY_MISSING', () => {
    const grant = instantiateGrant(conservadorLiveV4, 'manage-any:pool:USDC/cbBTC/500', v4Ctx)
    expect(grant.requiresActionPolicy).toBe(true)
    expect(() => toSmartSession(grant)).toThrow('a v4 grant needs MamoruActionPolicy')
  })

  test('a v4 grant with the second policy at the zero address throws (zero is the same as none)', () => {
    const grant = instantiateGrant(conservadorLiveV4, 'enter-swap:pool:USDC/cbBTC/500', v4Ctx)
    expect(() => toSmartSession(grant, { policy: '0x0000000000000000000000000000000000000000', initData: '0x' })).toThrow('a v4 grant needs MamoruActionPolicy')
  })

  test('a v4 grant WITH both policies, bound to the configured addresses, builds: two action policies, three userOp policies', () => {
    const grant = retargetToPolicy(instantiateGrant(conservadorLiveV4, 'enter-mint:pool:USDC/cbBTC/500', v4Ctx), MAMORU_POLICY)
    const session = toSmartSession(grant, full(grant))
    for (const a of session.actions) {
      expect(a.actionPolicies).toHaveLength(2)
      expect(a.actionPolicies[1]!.policy.toLowerCase()).toBe(MAMORU_POLICY.toLowerCase())
    }
    expect(session.userOpPolicies.map((p) => p.policy.toLowerCase())).toEqual([address('TimeFramePolicy', baseRegistry), address('UsageLimitPolicy', baseRegistry), GAS_POLICY].map((a) => a.toLowerCase()))
    expect(session.userOpPolicies[2]!.initData).toBe(encodeGasCaps(V4_GAS_CAPS))
  })

  test('v2/v3 grants are unflagged and unchanged: no second policy required, no throw', () => {
    const grant = instantiateGrant(conservadorV1, 'enter-swap', ctx)
    expect(grant.requiresActionPolicy).toBeUndefined()
    expect(() => toSmartSession(grant)).not.toThrow()
  })
})

describe('T7 (GPT-6 review of #97): P1 1-3', () => {
  const A = '0x00000000000000000000000000000000000000fe' as const
  const G = '0x00000000000000000000000000000000000000fd' as const
  const X = '0x00000000000000000000000000000000000000fc' as const
  const d = { actionPolicy: A, gasPolicy: G, gasCaps: V4_GAS_CAPS }
  const caps = v4BudgetCaps(conservadorLiveV4, 10_000n * 1_000_000n)
  const keys = conservadorLiveV4.session.grants.map(grantKey)
  const grants = keys.map((k) => retargetToPolicy(instantiateGrant(conservadorLiveV4, k, v4Ctx), A))
  const btcSwap = grants.find((g) => g.name === 'enter-swap' && g.pool === 'pool:USDC/cbBTC/500')!
  const ok = (g: SessionGrant): SecondActionPolicy => v4PoliciesFor([g], d, 1n, caps)(g, 0) as SecondActionPolicy

  test('P1 1: activationCall encodes v4 grants with their policies; without them it still refuses', () => {
    expect(() => activationCall(grants, [])).toThrow('MamoruActionPolicy')
    const act = activationCall(grants, [], v4PoliciesFor(grants, d, 1n, caps))
    expect(act.permissionIds).toHaveLength(grants.length)
  })

  test('P1 1: Init.admit rides on the first grant of each pool only; the rest of the pool carries the same Init without it', () => {
    const admitByPool = { 'pool:USDC/cbBTC/500': [7n, 9n] }
    const f = v4PoliciesFor(grants, d, 1n, caps, admitByPool)
    const btc = grants.map((g, i) => [g, i] as const).filter(([g]) => g.pool === 'pool:USDC/cbBTC/500')
    const inits = btc.map(([g, i]) => decodeMamoruInit((f(g, i) as SecondActionPolicy).initData))
    expect(inits[0]!.admit).toEqual([7n, 9n])
    for (const i of inits.slice(1)) expect(i.admit).toEqual([])
    expect(new Set(inits.map((i) => i.perWindow)).size).toBe(1)
  })

  test('P1 2: a v4 grant without MamoruGasPolicy is refused, and so is one with the zero address', () => {
    expect(() => toSmartSession(btcSwap, { ...ok(btcSwap), gas: undefined })).toThrow('MamoruGasPolicy')
    expect(() => toSmartSession(btcSwap, { ...ok(btcSwap), gas: { policy: `0x${'0'.repeat(40)}`, initData: encodeGasCaps(V4_GAS_CAPS) } })).toThrow('MamoruGasPolicy')
  })

  test('P1 2/4: gas caps the contract would refuse (no maxFeePerGas cap, or under the priority cap) are refused', () => {
    expect(() => toSmartSession(btcSwap, { ...ok(btcSwap), gas: { policy: G, initData: encodeGasCaps({ ...V4_GAS_CAPS, maxFeePerGas: 0n }) } })).toThrow('SESSION_ACTION_POLICY_MISMATCH')
    expect(() => toSmartSession(btcSwap, { ...ok(btcSwap), gas: { policy: G, initData: '0x1234' } })).toThrow('SESSION_ACTION_POLICY_MISMATCH')
  })

  test('P1 3: any nonzero second policy is no longer enough — it must be the configured one and the retarget address', () => {
    expect(() => toSmartSession(btcSwap, { ...ok(btcSwap), policy: X })).toThrow('SESSION_ACTION_POLICY_MISMATCH')
    expect(() => toSmartSession(btcSwap, { ...ok(btcSwap), expected: { actionPolicy: X, gasPolicy: G } })).toThrow('SESSION_ACTION_POLICY_MISMATCH')
    expect(() => toSmartSession(btcSwap, { ...ok(btcSwap), gas: { policy: X, initData: encodeGasCaps(V4_GAS_CAPS) } })).toThrow('SESSION_ACTION_POLICY_MISMATCH')
    expect(() => toSmartSession(btcSwap, { ...ok(btcSwap), expected: undefined })).toThrow('SESSION_ACTION_POLICY_MISMATCH')
    // retargeted to another deployment than the one configured
    const elsewhere = retargetToPolicy(instantiateGrant(conservadorLiveV4, grantKey(btcSwap), v4Ctx), X)
    expect(() => toSmartSession(elsewhere, ok(elsewhere))).toThrow('SESSION_ACTION_POLICY_MISMATCH')
    // never retargeted (mint and approvals still on the position manager)
    const raw = instantiateGrant(conservadorLiveV4, 'enter-mint:pool:USDC/cbBTC/500', v4Ctx)
    expect(() => toSmartSession(raw, ok(raw))).toThrow('SESSION_ACTION_POLICY_MISMATCH')
    expect(() => toSmartSession(btcSwap, ok(btcSwap))).not.toThrow()
  })

  test('P1 3: the Init must name the grant\'s pool', () => {
    const wrongPool = { ...ok(btcSwap), initData: encodeMamoruInit(mamoruInitFor(V4_POOLS.risk, 1n, caps)) }
    expect(() => toSmartSession(btcSwap, wrongPool)).toThrow('Init pool')
    expect(() => toSmartSession(btcSwap, { ...ok(btcSwap), initData: '0x00' })).toThrow('SESSION_ACTION_POLICY_MISMATCH')
  })

  test('P1 3: a grant whose rules pin a token or fee of another pool is refused', () => {
    const forged: SessionGrant = { ...btcSwap, actions: btcSwap.actions.map((a) => ({ ...a, params: a.params.map((p) => (p.field === 'tokenOut' ? { ...p, ref: BigInt(address('WETH', baseRegistry)) } : p)) })) }
    expect(() => toSmartSession(forged, ok(btcSwap))).toThrow('not a token of the pool')
    const fee: SessionGrant = { ...btcSwap, actions: btcSwap.actions.map((a) => ({ ...a, params: a.params.map((p) => (p.field === 'fee' ? { ...p, ref: 3000n } : p)) })) }
    expect(() => toSmartSession(fee, ok(btcSwap))).toThrow("pool's fee")
  })
})

describe('v5 grants (MamoruActionPolicyV2, otto/mamoru#151, #171): increase and the swap deadline', () => {
  const A = '0x00000000000000000000000000000000000000fe' as const
  const G = '0x00000000000000000000000000000000000000fd' as const
  const X = '0x00000000000000000000000000000000000000fc' as const
  const d = { actionPolicy: A, gasPolicy: G, gasCaps: V4_GAS_CAPS }
  const caps = v4BudgetCaps(conservadorLiveV5, 10_000n * 1_000_000n)
  const keys = conservadorLiveV5.session.grants.map(grantKey)
  const grants = keys.map((k) => retargetToPolicy(instantiateGrant(conservadorLiveV5, k, v4Ctx), A))
  const manage = grants.find((g) => g.name === 'manage-any' && g.pool === 'pool:USDC/cbBTC/500')!
  const ok = (g: SessionGrant): SecondActionPolicy => v4PoliciesFor([g], d, 1n, caps)(g, 0) as SecondActionPolicy

  test('every v5 grant encodes with MamoruActionPolicyV2 on every action, the deadline and increase included', () => {
    const act = activationCall(grants, [], v4PoliciesFor(grants, d, 1n, caps))
    expect(act.permissionIds).toHaveLength(9)
    for (const g of grants) {
      const s = toSmartSession(g, ok(g))
      for (const a of s.actions) expect(a.actionPolicies.map((p) => p.policy.toLowerCase())).toEqual([address('UniActionPolicy', baseRegistry).toLowerCase(), A])
    }
    const s = toSmartSession(manage, ok(manage))
    expect(s.actions.find((a) => a.actionTargetSelector === '0x5ae401dc')!.actionTarget).toBe(address('SwapRouter02', baseRegistry))
    expect(s.actions.filter((a) => a.actionTarget.toLowerCase() === A).length).toBe(2) // mint and increase
  })

  test('increase anywhere but the policy is refused, and so is the manager\'s increaseLiquidity', () => {
    const atNpm: SessionGrant = { ...manage, actions: manage.actions.map((a) => (a.signature === POLICY_INCREASE_SIG ? { ...a, targetAddress: address('NonfungiblePositionManager', baseRegistry) } : a)) }
    expect(() => toSmartSession(atNpm, ok(manage))).toThrow('increase targets')
    const atOther: SessionGrant = { ...manage, actions: manage.actions.map((a) => (a.signature === POLICY_INCREASE_SIG ? { ...a, targetAddress: X } : a)) }
    expect(() => toSmartSession(atOther, ok(manage))).toThrow('increase targets')
    const npmIncrease: SessionGrant = { ...manage, actions: [...manage.actions, { ...manage.actions.find((a) => a.signature === POLICY_INCREASE_SIG)!, signature: 'increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))', selector: '0x219f5d17', targetAddress: address('NonfungiblePositionManager', baseRegistry) }] }
    expect(() => toSmartSession(npmIncrease, ok(manage))).toThrow("increaseLiquidity is never a session action")
    // Never retargeted: increase still names the manager (where it does not exist), refused all the same.
    const raw = instantiateGrant(conservadorLiveV5, grantKey(manage), v4Ctx)
    expect(() => toSmartSession(raw, ok(raw))).toThrow('SESSION_ACTION_POLICY_MISMATCH')
  })
})

// otto/mamoru#151 review round 4: an unrevoked attestation that lapses is revoked, then attested again, same tx.
describe('selfRevokeAttestationCall', () => {
  test('revoke((address)[]) on the ModuleRegistry, one request per module', () => {
    const m = `0x${'ab'.repeat(20)}` as const
    const call = selfRevokeAttestationCall([m])
    expect(call.to).toBe(address('ModuleRegistry', baseRegistry))
    expect(call.data.slice(0, 10)).toBe('0x4990a682') // revoke((address)[]), present in the Base registry's bytecode
    expect(call.data.toLowerCase()).toContain('ab'.repeat(20))
  })
})

describe('selfAttestCall data', () => {
  test('carries the caller-given bytes, so an attestation made again after a revoke is not the same CREATE2 data', () => {
    const m = `0x${'cd'.repeat(20)}` as const
    const a = selfAttestCall([m], '0x01')
    const b = selfAttestCall([m], '0x02')
    expect(a.data).not.toBe(b.data)
    expect(selfAttestCall([m]).data).toBe(selfAttestCall([m], '0x').data) // default unchanged for first attestations
  })
})

describe('otto/mamoru#213: bridge-out takes MamoruPauseGate and MamoruGasPolicy, never MamoruActionPolicy', () => {
  const G = '0x00000000000000000000000000000000000000fd' as const
  const A = '0x00000000000000000000000000000000000000fe' as const
  const P = '0x00000000000000000000000000000000000000fb' as const
  const d = { actionPolicy: A, gasPolicy: G, gasCaps: V4_GAS_CAPS, pauseGate: P }
  const caps = computeCaps(conservadorLiveV6, 10_000n * 1_000_000n, { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } })
  const bridge = instantiateGrant(conservadorLiveV6, 'bridge-out', { ...v4Ctx, caps })
  const gas = { policy: G, initData: encodeGasCaps(V4_GAS_CAPS) }

  test('encoded with the gas policy as a userOp policy and the pause gate after UniActionPolicy on every action', () => {
    const p = v4PoliciesFor([bridge], d, 1n, v4BudgetCaps(conservadorLiveV6, 10_000n * 1_000_000n))(bridge, 0)
    expect(p).toEqual({ gate: { policy: P, initData: '0x' }, gas, expected: { pauseGate: P, gasPolicy: G } })
    const s = toSmartSession(bridge, p)
    expect(s.userOpPolicies.map((x) => x.policy.toLowerCase())).toEqual([address('TimeFramePolicy', baseRegistry), address('UsageLimitPolicy', baseRegistry), G].map((x) => x.toLowerCase()))
    for (const a of s.actions) expect(a.actionPolicies.map((x) => x.policy.toLowerCase())).toEqual([address('UniActionPolicy', baseRegistry).toLowerCase(), P])
  })

  test('refused without the gate or the gas policy, with wrong addresses, or with an action policy', () => {
    expect(() => toSmartSession(bridge)).toThrow('MamoruPauseGate')
    expect(() => activationCall([bridge], [])).toThrow('MamoruPauseGate')
    expect(() => v4PoliciesFor([bridge], { actionPolicy: A, gasPolicy: G, gasCaps: V4_GAS_CAPS }, 1n, {})(bridge, 0)).toThrow('no MamoruPauseGate')
    expect(() => toSmartSession(bridge, { gate: { policy: A, initData: '0x' }, gas, expected: { pauseGate: P, gasPolicy: G } })).toThrow('not the configured MamoruPauseGate')
    expect(() => toSmartSession(bridge, { gate: { policy: P, initData: '0x01' }, gas, expected: { pauseGate: P, gasPolicy: G } })).toThrow('no init data')
    expect(() => toSmartSession(bridge, { gate: { policy: P, initData: '0x' }, gas: { ...gas, policy: A }, expected: { pauseGate: P, gasPolicy: G } })).toThrow('not the configured MamoruGasPolicy')
    expect(() => toSmartSession(bridge, { policy: A, initData: '0x', gas, expected: { actionPolicy: A, gasPolicy: G } })).toThrow('never takes MamoruActionPolicy')
  })
})
