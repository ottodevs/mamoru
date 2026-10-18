import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, decodeFunctionData, keccak256, stringToHex, type Hex } from 'viem'
import { ReasonError, type Address } from '@mamoru/domain'
import { address, baseRegistry, moduleRegistryAbi, smartSessionAbi, type Registry } from '@mamoru/registry'
import { computeCaps, conservadorLiveV4, grantKey, instantiateGrant, POLICIES, type GrantContext, type SessionGrant } from '@mamoru/policy'
import { webAuthnSigner } from '../safe/index.ts'
import { actionPolicyTrustCalls, activationCall, mamoruActionPolicyInitData, POLICY_RESOLVER_UID, toSmartSession } from '../sessions/index.ts'
import { activationBatch, type ActionPolicyState, type LiveAccount } from './index.ts'

// Spec 007 (otto/mamoru#151) T2: v4 grants on the account side, and proof that v1/v2 grants did not move.

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const POLICY = '0x00000000000000000000000000000000000A11cE' as Address
const deployed: Registry = { ...baseRegistry, entries: [...baseRegistry.entries, { name: 'MamoruActionPolicy', kind: 'smart-sessions-policy', role: 'test', address: POLICY, codeHash: null }], undeployed: [] }
const live: LiveAccount = { safe: ACCOUNT, chainId: 8453, owners: [], saltNonce: 0n, webauthn: webAuthnSigner(1n, 2n) }
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
const hashCaps = new Proxy({}, { get: (_t, k) => BigInt([...String(k)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000_007, 7)) }) as Record<string, bigint>

/**
 * Grants, their Session structs and the enableSessions calldata of every activatable v1/v2 grant set, hashed before
 * spec 007 T2 touched the grant code (computed at eac4520, the base of this branch). Equal hashes: a v1/v2 account
 * signs, enables and is checked against exactly what it was before.
 */
const PRE_V4 = {
  'conservador-v1': ['0x6872a15c39d54abee7d436ae3812fb1a1f6a89a794d3992d7088c6c7c13beed3', '0xe67942ed1e96653c2cf28d7fcf423ba68084bb5934ea75cfafb7fd8fd05a01d4', '0x43b489827ab73dcada6590c03444d3e9c7fe241a51fc48c2489973647bdf9367'],
  'conservador-live-v1': ['0x6c553524b3baaf40773f6d46ff0407c06c480c15f7b886047de94d757f3996e0', '0x897da274972728891b3cb8268d7d3bc7eb3912b0f5d98ec0c4c1a289a06c4e82', '0x6f8bfd939ca12ab8b851cba153bc3ae30cd3b055f9c2914f9ca571213ef11e4f'],
  'conservador-live-v2': ['0x8f8edd5d287c18a4deff3aa7a490b580fa7677ffc2285fc24bc4054494b702dd', '0xc4364a3f3ad684867fc7d07291f314f4dc18a3cc584933c9c6427c5824fa0613', '0xaa661216fdc023e877ea94d2f2e9977b0711fe9ff27d4ac3f053ac4e4f725d52'],
} as const

function v4Grants(over: Partial<GrantContext> = {}): SessionGrant[] {
  const caps = computeCaps(conservadorLiveV4, 1_000_000_000n, { cbBTC: { num: 1n, den: 600n }, WETH: { num: 10n ** 12n, den: 3_000n }, USDT: { num: 1n, den: 1n } })
  return conservadorLiveV4.session.grants.map((g, i) =>
    instantiateGrant(conservadorLiveV4, grantKey(g), { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 8453, salt: `0x${String(i + 1).padStart(64, '0')}`, validAfter: 100, validUntil: 200, caps, capUsdc: 1_000_000_000n, generation: 1n, registry: deployed, ...over }),
  )
}

const POOLS = conservadorLiveV4.session.grants.map((g) => address(g.pool!))
const fresh: ActionPolicyState = { registered: true, attested: false, generation: 0n, enabledKeys: [], enabledPermissionIds: [], pools: POOLS, unadmittedOpenPositions: [] }

function decoded(calls: { to: Address; data: Hex }[]) {
  return calls.map((c) => {
    if (c.to === address('SmartSession')) return decodeFunctionData({ abi: smartSessionAbi, data: c.data }).functionName
    const d = decodeFunctionData({ abi: moduleRegistryAbi, data: c.data })
    if (d.functionName === 'attest') return `attest(${(d.args[1] as readonly { moduleAddress: Address }[]).map((r) => r.moduleAddress).join(',')})`
    return d.functionName
  })
}

describe('v1/v2 grants are byte-identical (spec 007 T2)', () => {
  test.each(Object.entries(PRE_V4))('%s: grants, Session structs and enableSessions calldata', (id, [grantsHash, calldataHash, sessionsHash]) => {
    const p = POLICIES[id]!
    const grants = p.session.grants
      .filter((g) => !g.perPosition)
      .map((g) => instantiateGrant(p, grantKey(g), { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 8453, salt: `0x${'01'.repeat(32)}`, validAfter: 100, validUntil: 200, caps: hashCaps, capUsdc: 1_000_000_000n }))
    expect(keccak256(stringToHex(j(grants)))).toBe(grantsHash)
    expect(keccak256(activationCall(grants, []).data)).toBe(calldataHash)
    expect(keccak256(stringToHex(j(grants.map(toSmartSession))))).toBe(sessionsHash)
    // One policy per action, UniActionPolicy, as before.
    for (const s of grants.map(toSmartSession)) for (const a of s.actions) expect(a.actionPolicies.map((x) => x.policy)).toEqual([address('UniActionPolicy')])
    // The batch of a v1/v2 activation is what it was: trust + attest(TimeFrame, Usage) + enable, or enable alone.
    expect(decoded(activationBatch(live, grants, []).calls)).toEqual(['trustAttesters', `attest(${address('TimeFramePolicy')},${address('UsageLimitPolicy')})`, 'enableSessions'])
    expect(decoded(activationBatch(live, grants, [], { trust: false }).calls)).toEqual(['enableSessions'])
    expect(() => activationBatch(live, grants, [], { actionPolicy: fresh })).toThrow(/carry no action policy/)
  })
})

describe('v4 Session struct (spec 007 T2)', () => {
  test('UniActionPolicy then MamoruActionPolicy with the pool Init on every action, the swap deadline included', () => {
    const [stables] = v4Grants()
    const s = toSmartSession(stables!)
    expect(s.actions).toHaveLength(9)
    const init = mamoruActionPolicyInitData(stables!.actionPolicy!.init)
    for (const a of s.actions) {
      expect(a.actionPolicies.map((p) => p.policy)).toEqual([address('UniActionPolicy'), POLICY])
      expect(a.actionPolicies[1]!.initData).toBe(init)
    }
    expect(s.actions.map((a) => a.actionTargetSelector)).toContain('0x5ae401dc')
  })

  test('Init is abi.encode(MamoruActionPolicy.Init), field for field', () => {
    const init = { pool: address('pool:USDC/USDT/100'), twapWindow: 1800, bandTicks: 10, generation: 7n, budgetWindow: 86_400, perWindow0: 1n, perWindow1: 2n, total0: 3n, total1: (1n << 128n) - 1n }
    const data = mamoruActionPolicyInitData(init)
    // Static tuple: nine words, no offset.
    expect((data.length - 2) / 2).toBe(9 * 32)
    const [pool, twap, band, gen, window, w0, w1, t0, t1] = decodeAbiParameters(['address', 'uint32', 'uint24', 'uint64', 'uint32', 'uint128', 'uint128', 'uint128', 'uint128'].map((type) => ({ type })), data)
    expect([pool, twap, band, gen, window, w0, w1, t0, t1]).toEqual([init.pool, 1800, 10, 7n, 86_400, 1n, 2n, 3n, (1n << 128n) - 1n])
  })
})

describe('v4 activation batch (spec 007 T2)', () => {
  test('a new account: registry trust and one attest of TimeFrame, Usage and the policy, then enable', () => {
    const b = activationBatch(live, v4Grants(), [], { actionPolicy: fresh })
    expect(decoded(b.calls)).toEqual(['trustAttesters', `attest(${address('TimeFramePolicy')},${address('UsageLimitPolicy')},${POLICY})`, 'enableSessions'])
    expect(b.permissionIds).toHaveLength(3)
  })

  test('registerModule first while the policy is not registered', () => {
    const b = activationBatch(live, v4Grants(), [], { actionPolicy: { ...fresh, registered: false } })
    expect(decoded(b.calls)).toEqual(['registerModule', 'trustAttesters', `attest(${address('TimeFramePolicy')},${address('UsageLimitPolicy')},${POLICY})`, 'enableSessions'])
    const reg = decodeFunctionData({ abi: moduleRegistryAbi, data: b.calls[0]!.data })
    expect(reg.args).toEqual([POLICY_RESOLVER_UID, POLICY, '0x', '0x'])
  })

  test('a v1/v2 account upgrading: attest the policy only, remove every grant it has, fresh key', () => {
    const old = [`0x${'0e'.repeat(32)}`, `0x${'0f'.repeat(32)}`] as Hex[]
    const s: ActionPolicyState = { ...fresh, enabledKeys: ['0x00000000000000000000000000000000000000cc'], enabledPermissionIds: old }
    const b = activationBatch(live, v4Grants(), [], { trust: false, actionPolicy: s })
    expect(decoded(b.calls)).toEqual([`attest(${POLICY})`, 'removeSession', 'removeSession', 'enableSessions'])
    expect(b.calls.slice(1, 3).map((c) => decodeFunctionData({ abi: smartSessionAbi, data: c.data }).args[0])).toEqual(old)
    // The key the v2 grants used is refused.
    let e: unknown
    try {
      activationBatch(live, v4Grants(), [], { trust: false, actionPolicy: { ...s, enabledKeys: ['0x00000000000000000000000000000000000000BB'] } })
    } catch (x) {
      e = x
    }
    expect((e as ReasonError).code).toBe('SESSION_PERMISSION_ID_REUSED')
  })

  test('an upgrade is refused while a v2 position is open; once closed, it builds', () => {
    const s: ActionPolicyState = { ...fresh, enabledKeys: ['0x00000000000000000000000000000000000000cc'], enabledPermissionIds: [`0x${'0e'.repeat(32)}`], unadmittedOpenPositions: [6291301n, 6291328n] }
    let e: unknown
    try {
      activationBatch(live, v4Grants(), [], { trust: false, actionPolicy: s })
    } catch (x) {
      e = x
    }
    expect(e).toBeInstanceOf(ReasonError)
    expect((e as ReasonError).code).toBe('SESSION_UPGRADE_UNADMITTED_POSITIONS')
    expect((e as ReasonError).detail).toContain('6291301, 6291328')
    // A renewal is refused the same way (an admitted position never shows here; one minted elsewhere does).
    expect(() => activationBatch(live, v4Grants({ generation: 2n }), [], { trust: false, actionPolicy: { ...s, attested: true, generation: 1n } })).toThrow(/did not admit/)
    expect(decoded(activationBatch(live, v4Grants(), [], { trust: false, actionPolicy: { ...s, unadmittedOpenPositions: [] } }).calls)).toEqual([`attest(${POLICY})`, 'removeSession', 'enableSessions'])
  })

  test('an upgrade split in two (it does not fit one Base tx): some pools at generation 1, the rest added at 1 after', () => {
    const v2 = [`0x${'0e'.repeat(32)}`] as Hex[]
    const first = activationBatch(live, v4Grants().slice(0, 2), [], { trust: false, actionPolicy: { ...fresh, enabledKeys: ['0x00000000000000000000000000000000000000cc'], enabledPermissionIds: v2 } })
    expect(decoded(first.calls)).toEqual([`attest(${POLICY})`, 'removeSession', 'enableSessions'])
    const after: ActionPolicyState = { ...fresh, attested: true, generation: 1n, enabledKeys: ['0x00000000000000000000000000000000000000cc', '0x00000000000000000000000000000000000000BB'], enabledPermissionIds: first.permissionIds }
    expect(decoded(activationBatch(live, v4Grants().slice(2), [], { trust: false, actionPolicy: after }).calls)).toEqual(['enableSessions'])
  })

  test('a v4 renewal: generation + 1, no registry call, every old grant removed, every pool re-enabled', () => {
    const old = [`0x${'0d'.repeat(32)}`] as Hex[]
    const s: ActionPolicyState = { ...fresh, attested: true, generation: 1n, enabledKeys: ['0x00000000000000000000000000000000000000cc'], enabledPermissionIds: old }
    expect(decoded(activationBatch(live, v4Grants({ generation: 2n }), [], { trust: false, actionPolicy: s }).calls)).toEqual(['removeSession', 'enableSessions'])
    expect(() => activationBatch(live, v4Grants({ generation: 2n }).slice(1), [], { trust: false, actionPolicy: s })).toThrow(/must enable every pool/)
    // Same generation (a pool added): nothing removed, the key may stay.
    const add = activationBatch(live, v4Grants({ generation: 1n, sessionKey: '0x00000000000000000000000000000000000000cc' }).slice(2), [], { trust: false, actionPolicy: s })
    expect(decoded(add.calls)).toEqual(['enableSessions'])
  })

  test('refused: no chain state, a stale or skipped generation, mixed grants, an unattested account that trusts nobody', () => {
    expect(() => activationBatch(live, v4Grants(), [])).toThrow(/need the account state/)
    expect(() => activationBatch(live, v4Grants({ generation: 1n }), [], { trust: false, actionPolicy: { ...fresh, generation: 2n, attested: true } })).toThrow(/generation 1 for an account at generation 2/)
    expect(() => activationBatch(live, v4Grants({ generation: 3n }), [], { trust: false, actionPolicy: { ...fresh, generation: 1n, attested: true } })).toThrow(/generation 3/)
    expect(() => activationBatch(live, v4Grants({ generation: 0n + 1n }), [], { actionPolicy: { ...fresh, generation: 0n } }).calls).not.toThrow()
    const [a, b] = v4Grants()
    expect(() => activationBatch(live, [a!, { ...b!, actionPolicy: { ...b!.actionPolicy!, init: { ...b!.actionPolicy!.init, generation: 2n } } }], [], { actionPolicy: fresh })).toThrow(/generations 1, 2/)
    const v2 = instantiateGrant(POLICIES['conservador-live-v2']!, 'enter-swap:pool:USDC/cbBTC/500', { account: ACCOUNT, sessionKey: '0x00000000000000000000000000000000000000bb', chainId: 8453, salt: `0x${'09'.repeat(32)}`, validAfter: 1, validUntil: 2, caps: hashCaps })
    expect(() => activationBatch(live, [a!, v2], [], { actionPolicy: fresh })).toThrow(/v4 and pre-v4/)
    expect(() => actionPolicyTrustCalls(ACCOUNT, POLICY, { trusted: false, registered: true, attested: true })).toThrow()
  })
})
