import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { decodeAbiParameters, decodeFunctionData, getAddress, keccak256, toHex, zeroAddress, type Hex } from 'viem'
import { address, baseRegistry, ethereumRegistry, monadRegistry, moduleRegistryAbi, multiSendCallOnlyAbi, smartSessionAbi } from '@mamoru/registry'
import { decodeGasCapsV2, decodeInitV4, GAS_CAPS_V2_BY_CHAIN, ONE_AUTH_V4_CONTRACTS, oneAuthV4Deployment } from '@mamoru/policy'
import { permissionIdOf } from '../sessions/index.ts'
import { webAuthnSigner } from '../safe/index.ts'
import { FIXTURE_PATH, fixtureJson } from './fixture.ts'
import { buildMigrateV4, FALLBACK_SELECTOR, FALLBACK_TARGET, inventoryOf, oneAuthRemoteOf, REGISTER_REMOTE_SELECTOR, v4RegisterRemoteAction, v4RemoteSession, v4Session, migrationCalls, migrationCheckAbi, migrationTx, ownerStateOf, smartSessionV4Abi, v4Children, v4CreateSetup, v4HomeSession, V4_REMOTE_SESSION_SALT } from './index.ts'

const D = { table: '0x00000000000000000000000000000000000000a1', policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3', migrationCheck: '0x00000000000000000000000000000000000000a4' } as const
const KEY = '0x00000000000000000000000000000000005e55e5' as const
const SAFE = '0x000000000000000000000000000000000000cafe' as const
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

describe('V4 remote initializer (otto/mamoru#293)', () => {
  test('the committed fixture is what the TypeScript builds (the Solidity parity test reads it)', () => {
    expect(readFileSync(FIXTURE_PATH, 'utf8')).toBe(fixtureJson())
  })

  test('the remote session salt is MamoruV4Helper.REMOTE_SESSION_SALT', () => {
    expect(V4_REMOTE_SESSION_SALT).toBe(keccak256(toHex('mamoru.v4.remote-session')))
  })

  test("V4's children are CREATE from V4 at nonces 1 and 2", () => {
    const c = v4Children(D.policy)
    expect(c.remoteInit).not.toBe(c.helper)
  })

  test('ownerStateOf refuses a passkey owner without its passkey', () => {
    expect(() => ownerStateOf([address('SafeWebAuthnSharedSigner', baseRegistry)], null, baseRegistry)).toThrow()
    expect(ownerStateOf(['0x000000000000000000000000000000000000bacc'], null, baseRegistry).x).toBe(0n)
  })
})

describe('the V4 session', () => {
  const s = v4HomeSession({ sessionKey: KEY, deployment: D, capUsd: 10_000_000_000n, generation: 1n, admit: [5n], remote: null, registry: baseRegistry })

  test('one fallback action, V4 its only action policy, MamoruGasPolicyV2 the only userOp policy', () => {
    expect(s.actions).toHaveLength(2) // the fallback, and #356's (V4, registerRemote)
    expect(s.actions[0]!.actionTarget).toBe(FALLBACK_TARGET)
    expect(s.actions[0]!.actionTargetSelector).toBe(FALLBACK_SELECTOR)
    expect(s.actions[0]!.actionPolicies.map((p) => p.policy)).toEqual([D.policy])
    expect(decodeInitV4(s.actions[0]!.actionPolicies[0]!.initData)).toEqual({ capUsd: 10_000_000_000n, generation: 1n, home: zeroAddress, homeDomain: 0, admit: [5n] })
    expect(s.userOpPolicies.map((p) => p.policy)).toEqual([D.gasPolicy])
    expect(decodeGasCapsV2(s.userOpPolicies[0]!.initData)).toEqual(GAS_CAPS_V2_BY_CHAIN[8453]!)
    expect(s.erc7739Policies.erc1271Policies).toEqual([]) // the session cannot sign for the account
    expect(s.permitERC4337Paymaster).toBe(false)
  })

  test('setup mode: a new account whose setup enables it commits to it', () => {
    const owners = [address('SafeWebAuthnSharedSigner', baseRegistry), '0x000000000000000000000000000000000000bacc' as const]
    const w = webAuthnSigner(1n, 2n, baseRegistry)
    const a = v4CreateSetup(owners, 42n, w, s, baseRegistry)
    const b = v4CreateSetup(owners, 42n, w, v4HomeSession({ sessionKey: KEY, deployment: D, capUsd: 10_000_000_001n, generation: 1n, admit: [5n], remote: null, registry: baseRegistry }), baseRegistry)
    expect(a.permissionId).toBe(permissionIdOf(s))
    expect(a.address).not.toBe(b.address) // the Init is part of the address
  })

  test('#348: T7 is retired and not pinned; A1 is pinned as T8, the same deployment on every chain', () => {
    const t7 = ['0x2a70976970964faB1FBadaFF2f0b3851C2Cb74C7', '0xb1383F8E5045aFdcfF2031743d3c25082C8858a4', '0xe58dad8B381FF93A28Aa2A43De80acb96F535C7B']
    const script = readFileSync(new URL('../../../contracts/action-policy/script/DeployV4.s.sol', import.meta.url), 'utf8')
    const t8 = oneAuthV4Deployment(baseRegistry)
    expect(t8?.policy).toBe('0xCd278c96dC14d59ded497bE63c5c8E2De456f2d8')
    for (const r of [baseRegistry, monadRegistry, ethereumRegistry]) {
      expect(oneAuthV4Deployment(r), r.chain).toEqual(t8)
      for (const a of t7) expect(r.entries.some((e) => e.address === a), `${r.chain} ${a}`).toBe(false)
      expect(r.entries.some((e) => e.name === 'MamoruRegistry'), r.chain).toBe(false)
      expect(r.undeployed, r.chain).toEqual([])
    }
    // A1's deploy script predicts none of T7's addresses: T8 lands at new ones.
    for (const a of t7) expect(script.includes(a)).toBe(false)
  })
})

describe('migration transaction (results section 7)', () => {
  const session = v4HomeSession({ sessionKey: KEY, deployment: D, capUsd: 1_000_000_000n, generation: 1n, admit: [], remote: null, registry: baseRegistry })
  const m = { account: SAFE, remove: [id(1), id(2)], revoke: [id(1), id(2), id(3)], noncesBefore: [0n, 0n, 4n], session, deployment: D, attestData: '0xabcd' as Hex, registry: baseRegistry }

  test('removeSession each enabled id, revokeEnableSignature each id, trust + attest, enable V4, assertMigrated last', () => {
    const calls = migrationCalls(m)
    const names = calls.map((c) => {
      for (const abi of [smartSessionAbi, smartSessionV4Abi, moduleRegistryAbi, migrationCheckAbi] as const) {
        try {
          return decodeFunctionData({ abi: abi as never, data: c.data }).functionName as string
        } catch {}
      }
      return '?'
    })
    expect(names).toEqual(['removeSession', 'removeSession', 'revokeEnableSignature', 'revokeEnableSignature', 'revokeEnableSignature', 'trustAttesters', 'attest', 'enableSessions', 'assertMigrated'])
    const last = decodeFunctionData({ abi: migrationCheckAbi, data: calls.at(-1)!.data })
    expect(last.args).toEqual([getAddress(SAFE), [permissionIdOf(session)], m.revoke, m.noncesBefore])
    expect(calls.at(-1)!.to).toBe(D.migrationCheck)
    const att = decodeFunctionData({ abi: moduleRegistryAbi, data: calls[6]!.data })
    expect((att.args[1] as unknown as { moduleAddress: string }[]).map((r) => r.moduleAddress.toLowerCase())).toEqual([D.policy, D.gasPolicy])
  })

  test('one Safe transaction through MultiSendCallOnly', () => {
    const tx = migrationTx(m)
    expect(tx.to).toBe(address('MultiSendCallOnly_141', baseRegistry))
    expect(tx.operation).toBe(1)
    expect(decodeFunctionData({ abi: multiSendCallOnlyAbi, data: tx.data }).functionName).toBe('multiSend')
  })

  test('refuses an id removed but not revoked, a nonce count mismatch, and the V4 id among the old ones', () => {
    expect(() => migrationCalls({ ...m, revoke: [id(1), id(3)], noncesBefore: [0n, 0n] })).toThrow()
    expect(() => migrationCalls({ ...m, noncesBefore: [0n] })).toThrow()
    expect(() => migrationCalls({ ...m, remove: [], revoke: [permissionIdOf(session)], noncesBefore: [0n] })).toThrow()
  })
})

describe('inventory (spec 010 r1 finding 4)', () => {
  test('remove = enabled, revoke = the superset of events, records and enabled', () => {
    const inv = inventoryOf({ events: [id(1), id(2), id(9)], enabled: [id(2), id(1)], stored: [id(1), id(2), id(4)] })
    expect(inv).toEqual({ ok: true, remove: [id(1), id(2)], revoke: [id(1), id(2), id(4), id(9)] })
  })

  test('fails closed on an enabled session with no event, or one Mamoru has no record of', () => {
    expect(inventoryOf({ events: [id(1)], enabled: [id(1), id(2)], stored: [id(1), id(2)] }).ok).toBe(false)
    const r = inventoryOf({ events: [id(1), id(2)], enabled: [id(1), id(2)], stored: [id(1)] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.unknown).toEqual([id(2)])
  })

  test('fails closed when the V4 session is already enabled', () => {
    expect(inventoryOf({ events: [id(1)], enabled: [id(1)], stored: [id(1)], v4Id: id(1) }).ok).toBe(false)
  })
})

const REMOTE_KEY = '0x000000000000000000000000000000000000f00d' as const
/** UniActionPolicy ActionConfig: the rules in use, as (condition, offset, ref). */
const uniRules = (initData: Hex) => {
  const [c] = decodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'valueLimitPerUse', type: 'uint256' }, { name: 'paramRules', type: 'tuple', components: [{ name: 'length', type: 'uint256' }, { name: 'rules', type: 'tuple[16]', components: [{ name: 'condition', type: 'uint8' }, { name: 'offset', type: 'uint64' }, { name: 'isLimited', type: 'bool' }, { name: 'ref', type: 'bytes32' }, { name: 'usage', type: 'tuple', components: [{ name: 'limit', type: 'uint256' }, { name: 'used', type: 'uint256' }] }] }] }] }],
    initData,
  )
  return { value: c.valueLimitPerUse, rules: c.paramRules.rules.slice(0, Number(c.paramRules.length)).map((r) => ({ condition: r.condition, offset: r.offset, isLimited: r.isLimited, ref: BigInt(r.ref) })) }
}

describe('otto/mamoru#356: a home session registers only the remote the owner signed', () => {
  const init = { capUsd: 10_000_000_000n, generation: 1n, home: zeroAddress, homeDomain: 0, admit: [5n] }

  test('pinned: (V4, registerRemote) with V4 (Init, no admit) and UniActionPolicy domain EQUAL, key EQUAL, no value', () => {
    const s = v4HomeSession({ sessionKey: KEY, deployment: D, capUsd: init.capUsd, generation: 1n, admit: [5n], remote: { domain: 15, sessionKey: REMOTE_KEY }, registry: baseRegistry })
    const a = s.actions[1]!
    expect(a.actionTarget).toBe(D.policy)
    expect(a.actionTargetSelector).toBe(REGISTER_REMOTE_SELECTOR)
    expect(a.actionPolicies.map((p) => p.policy)).toEqual([D.policy, address('UniActionPolicy', baseRegistry)])
    expect(decodeInitV4(a.actionPolicies[0]!.initData)).toEqual({ ...init, admit: [] })
    expect(uniRules(a.actionPolicies[1]!.initData)).toEqual({ value: 0n, rules: [{ condition: 0, offset: 0n, isLimited: false, ref: 15n }, { condition: 0, offset: 32n, isLimited: false, ref: BigInt(REMOTE_KEY) }] })
    // the permission id is the validator's and the salt's only: pinning moves the action, never the id
    expect(permissionIdOf(s)).toBe(permissionIdOf(v4HomeSession({ sessionKey: KEY, deployment: D, capUsd: init.capUsd, generation: 1n, admit: [5n], remote: null, registry: baseRegistry })))
  })

  test('none: one rule no call meets (domain < 0)', () => {
    const a = v4RegisterRemoteAction(null, init, D, baseRegistry)
    expect(uniRules(a.actionPolicies[1]!.initData)).toEqual({ value: 0n, rules: [{ condition: 2, offset: 0n, isLimited: false, ref: 0n }] })
  })

  test('refuses a binding V4 would refuse, and a remote session', () => {
    expect(() => v4RegisterRemoteAction({ domain: 6, sessionKey: REMOTE_KEY }, init, D, baseRegistry)).toThrow() // its own chain
    expect(() => v4RegisterRemoteAction({ domain: 99, sessionKey: REMOTE_KEY }, init, D, baseRegistry)).toThrow() // not in the table
    expect(() => v4RegisterRemoteAction({ domain: 15, sessionKey: zeroAddress }, init, D, baseRegistry)).toThrow()
    expect(() => v4RegisterRemoteAction(null, { ...init, home: SAFE, homeDomain: 15 }, D, baseRegistry)).toThrow()
  })

  test("a remote's session stays the fallback alone (MamoruV4Helper.sessions builds it on chain)", () => {
    expect(v4RemoteSession({ home: SAFE, homeDomain: 6, sessionKey: KEY, capUsd: 1n, deployment: D, registry: monadRegistry, chainId: 143 }).actions).toHaveLength(1)
    expect(v4Session({ sessionKey: KEY, deployment: D, init, salt: id(1), registry: baseRegistry }).actions).toHaveLength(1)
  })

  test('a setup-mode context without `remote` registers none', () => {
    expect(oneAuthRemoteOf({})).toBeNull()
    expect(oneAuthRemoteOf({ remote: null })).toBeNull()
    expect(oneAuthRemoteOf({ remote: { domain: 15, sessionKey: REMOTE_KEY.toUpperCase().replace('0X', '0x') } })).toEqual({ domain: 15, sessionKey: getAddress(REMOTE_KEY) })
  })
})

describe('buildMigrateV4 (the builder the operator prepares with and the Worker rebuilds with)', () => {
  const at = { MamoruActionPolicyV4: D.policy, MamoruGasPolicyV2: D.gasPolicy, MamoruMigrationCheck: D.migrationCheck, MamoruV4Table: D.table } as const
  const pinnedBase = { ...baseRegistry, undeployed: [], entries: [...baseRegistry.entries.filter((e) => !(ONE_AUTH_V4_CONTRACTS as readonly string[]).includes(e.name)), ...ONE_AUTH_V4_CONTRACTS.map((name) => ({ name, kind: 'smart-sessions-policy', role: 'test', address: at[name], codeHash: null }) as never)] }
  const input = { remote: { domain: 15, sessionKey: REMOTE_KEY } as { domain: number; sessionKey: `0x${string}` } | null, chainId: 8453, safe: SAFE, safeNonce: '4', step: 0 as const, capUsdc: '300000000', sessionKey: KEY, generation: '1', admit: ['7'], oldPermissionIds: [id(1), id(2)], removeIds: [id(1)], noncesBefore: ['0', '3'], home: zeroAddress, homeDomain: 0 }

  test('deterministic, refund fields zero, the hash is the SafeTx EIP-712 hash of its fields', () => {
    const a = buildMigrateV4(input, pinnedBase)
    const b = buildMigrateV4(JSON.parse(JSON.stringify(input)), pinnedBase)
    expect(a.safeTxHash).toBe(b.safeTxHash)
    expect(a.safeTx).toMatchObject({ value: '0', operation: 1, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: '4', to: address('MultiSendCallOnly_141', baseRegistry) })
    expect(buildMigrateV4({ ...input, safeNonce: '5' }, pinnedBase).safeTxHash).not.toBe(a.safeTxHash)
  })

  test('refuses what the operator never prepares', () => {
    expect(() => buildMigrateV4(input, { ...baseRegistry, entries: baseRegistry.entries.filter((e) => e.name !== 'MamoruActionPolicyV4'), undeployed: ['MamoruActionPolicyV4'] })).toThrow() // V4 not pinned
    expect(() => buildMigrateV4({ ...input, moveTo: SAFE, transfers: [] }, pinnedBase)).toThrow() // step 0 moves nothing
    expect(() => buildMigrateV4({ ...input, noncesBefore: ['0'] }, pinnedBase)).toThrow()
    expect(() => buildMigrateV4({ ...input, step: 1 }, pinnedBase)).toThrow() // step 1 names a home
    expect(() => buildMigrateV4({ ...input, safeNonce: '0x4' }, pinnedBase)).toThrow()
  })

  test('#356: step 0 names the remote its session may register; the key is in the signed bytes', () => {
    const { remote: _r, ...without } = input
    expect(() => buildMigrateV4(without, pinnedBase)).toThrow() // step 0 must say (null: none)
    const a = buildMigrateV4(input, pinnedBase).safeTxHash
    expect(buildMigrateV4({ ...input, remote: null }, pinnedBase).safeTxHash).not.toBe(a)
    expect(buildMigrateV4({ ...input, remote: { domain: 15, sessionKey: KEY } }, pinnedBase).safeTxHash).not.toBe(a)
    expect(() => buildMigrateV4({ ...input, remote: { domain: 6, sessionKey: REMOTE_KEY } }, pinnedBase)).toThrow()
  })
})
