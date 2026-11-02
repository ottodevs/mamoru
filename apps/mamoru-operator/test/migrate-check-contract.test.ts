// otto/mamoru#293 x #295: the operator's migrate-v4 prepare output, run through the Worker's own check
// (apps/mamoru-app/src/api/migrate-check.ts, the same file as on feat/295-whats-new), so the two sides cannot drift:
//  - step 0: the real `prepareMigrateV4` of a v6 account on the owner-world chain (inventory stubbed clean);
//  - step 1: a Monad migration built the way planRemoteMigration builds it (migrationTx + ERC-20 transfers to the new V4
//    Safe, the hold's `migrateFields`), against a Monad registry with the V4 stack pinned in memory.
import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, erc20Abi, hashTypedData, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { OwnerTxToSign, RemoteSpec } from '@mamoru/domain'
import { address, baseRegistry, monadRegistry, type Registry } from '@mamoru/registry'
import { grantKey, ONE_AUTH_V4_REMOTE, type OneAuthV4Deployment } from '@mamoru/policy'
import { ownerSafeTx } from '@mamoru/account/live'
import { safeTxTypedData } from '@mamoru/account/safe'
import { buildMigrateV4, type MigrateV4Input } from '@mamoru/account/one-auth'
import { v4RemoteFromSpec } from '@mamoru/account/remote'
import { checkMigrateTx } from '../../mamoru-app/src/api/migrate-check.ts'
import type { AccountRow } from '../../mamoru-app/src/api/accounts/store.ts'
import { resolveV6Policy } from '../src/boot.ts'
import { movedTo, type Operator } from '../src/operator.ts'
import type { AccountState } from '../src/state.ts'
import { withPinnedV6Base } from '../../../packages/account/remote/fixture.ts'
import { ctx, world } from './owner-world.ts'

const D: OneAuthV4Deployment = { registry: '0x00000000000000000000000000000000000000a1', policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3', migrationCheck: '0x00000000000000000000000000000000000000a4' }
const KEY = `0x${'5'.repeat(64)}` as Hex
const reg6 = withPinnedV6Base()
const v6 = resolveV6Policy('base', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: `0x${'11'.repeat(20)}`, MAMORU_ACTION_POLICY_V2_ADDRESS: `0x${'33'.repeat(20)}`, MAMORU_GAS_POLICY_ADDRESS: `0x${'22'.repeat(20)}` }, reg6)!

const row = (chainId: number, addr: string): AccountRow => ({ account_key: chainId === 8453 ? 'k' : 'k@143', user_id: 'u', chain_id: chainId, address: addr as never, owners_json: JSON.stringify(ctx.owners), passkey_credential_id: ctx.passkey.credentialId, passkey_x: ctx.passkey.x, passkey_y: ctx.passkey.y, salt_nonce: ctx.saltNonce, preset: 'conservador', policy_version: 'x', recovery_ack_at: null, created_at: '', env: 'prod', is_test: 1 })

/** A registry with the V4 stack pinned (what the base.json / monad.json pin does). */
function pinned(r: Registry): Registry {
  const names = ['MamoruRegistry', 'MamoruActionPolicyV4', 'MamoruGasPolicyV2', 'MamoruMigrationCheck'] as const
  const at = [D.registry, D.policy, D.gasPolicy, D.migrationCheck]
  return { ...r, undeployed: [], entries: [...r.entries, ...names.map((name, i) => ({ name, kind: 'smart-sessions-policy', role: 'test', address: at[i]!, codeHash: null }) as never)] }
}
const pinnedMonad = () => pinned(monadRegistry)
const base6 = pinned(reg6)

describe("the operator's migrate-v4 prepare passes the Worker's check (#295 migrate-check.ts)", () => {
  test('step 0 (Base): the real prepare of a v6 account', async () => {
    const w = world(0n, { registry: base6, v6Policy: v6, oneAuth: D, opsFlags: () => ({}), opsScopedFlags: () => ({ one_auth_v4: ['k'] }) })
    const grants = v6.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ name: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex, grant: { policyId: v6.policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } }))
    const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: v6.policyId, sessionKey: KEY, signedCapUsdc: '1500000000', grants, ops: [], revoked: [], managedTokenIds: [], admittedTokenIds: [], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 0 } as unknown as AccountState
    w.state.accounts.k = acc
    const ids = grants.map((g) => g.permissionId)
    const p = w.op as unknown as { refreshInventory: () => Promise<unknown>; client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown> } }
    p.refreshInventory = async () => ({ ok: true, at: '', scannedFrom: '0', scannedTo: '1', events: ids, remove: ids, revoke: ids })
    const real = p.client.readContract.bind(p.client)
    p.client.readContract = async (a) => (a.functionName === 'isPaused' ? false : a.functionName === 'getNonce' ? 0n : a.functionName === 'getPermissionIDs' ? ids : real(a))
    const tx = await (w.op as Operator).prepareMigrateV4(ctx, { step: 0 })
    expect(tx.step).toBe(0)
    expect(tx.chainId).toBe(8453)
    expect(tx.moveTo).toBeUndefined()
    expect(tx.safeTx?.operation).toBe(1)
    // the Worker's other path: rebuild from `input` with the same builder, the same hash
    expect(buildMigrateV4(tx.input!, base6).safeTxHash).toBe(tx.safeTxHash)
    expect(() => checkMigrateTx({ tx, step: 0, rows: [row(8453, ctx.address)] })).not.toThrow()
    // and the check would refuse it on the wrong step, or with a field changed
    expect(() => checkMigrateTx({ tx, step: 1, rows: [row(8453, ctx.address)] })).toThrow()
    expect(() => checkMigrateTx({ tx: { ...tx, safeTx: { ...tx.safeTx!, nonce: '99' } }, step: 0, rows: [row(8453, ctx.address)] })).toThrow()
  })

  test('step 1 (Monad): remove, revoke, enable V4, ERC-20 transfers to the new V4 Safe, assertMigrated', () => {
    const monad = pinnedMonad()
    const sessionKey = privateKeyToAccount(KEY).address
    const capUsd = 4_500_000_000n
    const spec: RemoteSpec = { chainId: 143, policyId: ONE_AUTH_V4_REMOTE, sessionKey, validAfter: 0, validUntil: 0, capUsdc: capUsd.toString(), home: ctx.address, homeDomain: 6 }
    const target = v4RemoteFromSpec(ctx, spec, monad)
    const old = '0x0000000000000000000000000000000000000ce1' as const
    const ids = [`0x${'01'.padStart(64, '0')}`] as Hex[]
    const input: MigrateV4Input = { chainId: 143, safe: old, safeNonce: '0', step: 1, capUsdc: capUsd.toString(), sessionKey, generation: '1', admit: [], oldPermissionIds: ids, removeIds: ids, noncesBefore: ['0'], home: ctx.address, homeDomain: 6, moveTo: target.address, transfers: (['USDC', 'WMON'] as const).map((t) => ({ token: address(t, monad), amount: '5' })) }
    const built = buildMigrateV4(input, monad)
    expect(movedTo(built.calls)!.toLowerCase()).toBe(target.address.toLowerCase())
    const tx: OwnerTxToSign = { safe: old, chainId: 143, safeTxHash: built.safeTxHash, summary: [], expiresAt: '', prepareId: 'p', step: 1, moveTo: target.address, remote: { chainId: 143, address: target.address, spec }, safeTx: built.safeTx, input }
    const rows = [row(8453, ctx.address), row(143, old)]
    expect(() => checkMigrateTx({ tx, step: 1, rows, registryOf: () => monad })).not.toThrow()
    // a destination other than the owner's own V4 Safe there is refused
    expect(() => checkMigrateTx({ tx: { ...tx, moveTo: old }, step: 1, rows, registryOf: () => monad })).toThrow()
  })
})
