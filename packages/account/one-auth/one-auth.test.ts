import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { decodeFunctionData, getAddress, keccak256, toHex, zeroAddress, type Hex } from 'viem'
import { address, baseRegistry, moduleRegistryAbi, multiSendCallOnlyAbi, smartSessionAbi } from '@mamoru/registry'
import { decodeGasCapsV2, decodeInitV4, GAS_CAPS_V2_BY_CHAIN, oneAuthV4Deployment } from '@mamoru/policy'
import { permissionIdOf } from '../sessions/index.ts'
import { webAuthnSigner } from '../safe/index.ts'
import { FIXTURE_PATH, fixtureJson } from './fixture.ts'
import { FALLBACK_SELECTOR, FALLBACK_TARGET, inventoryOf, migrationCalls, migrationCheckAbi, migrationTx, ownerStateOf, smartSessionV4Abi, v4Children, v4CreateSetup, v4HomeSession, V4_REMOTE_SESSION_SALT } from './index.ts'

const D = { registry: '0x00000000000000000000000000000000000000a1', policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3', migrationCheck: '0x00000000000000000000000000000000000000a4' } as const
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
  const s = v4HomeSession({ sessionKey: KEY, deployment: D, capUsd: 10_000_000_000n, generation: 1n, admit: [5n], registry: baseRegistry })

  test('one fallback action, V4 its only action policy, MamoruGasPolicyV2 the only userOp policy', () => {
    expect(s.actions).toHaveLength(1)
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
    const b = v4CreateSetup(owners, 42n, w, v4HomeSession({ sessionKey: KEY, deployment: D, capUsd: 10_000_000_001n, generation: 1n, admit: [5n], registry: baseRegistry }), baseRegistry)
    expect(a.permissionId).toBe(permissionIdOf(s))
    expect(a.address).not.toBe(b.address) // the Init is part of the address
  })

  test('the deployment is null until the four contracts are pinned (fail closed)', () => {
    expect(oneAuthV4Deployment(baseRegistry)).toBeNull()
  })
})

describe('migration transaction (results section 7)', () => {
  const session = v4HomeSession({ sessionKey: KEY, deployment: D, capUsd: 1_000_000_000n, generation: 1n, admit: [], registry: baseRegistry })
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
