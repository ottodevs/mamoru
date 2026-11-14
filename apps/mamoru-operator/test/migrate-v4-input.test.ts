// otto/mamoru#293 x #201 (review of #202, P0-1/P0-2): the Worker does not parse the operator's migrate-v4 tx: it
// rebuilds it with `buildMigrateV4` from the prepare's `input` and compares hashes. This test holds the operator to that:
//  - the prepare's safeTxHash is exactly buildMigrateV4(prepare.input).safeTxHash, and its safeTx the builder's;
//  - every field of `input` is one the Worker can derive or check by itself: the account's own Safe (its D1 row), the
//    chain of the step, C from the account's cap in D1 (v4CapUsdOf), the ids it removes = SmartSession's enumeration on
//    chain, each nonce = SmartSession.getNonce on chain, no home and nothing moved on step 0; only the session key is the
//    operator's choice (it signs with it; V4 bounds it).
import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { monadRegistry, type Registry } from '@mamoru/registry'
import { grantKey, ONE_AUTH_V4_REMOTE, v4CapUsdOf, type OneAuthV4Deployment } from '@mamoru/policy'
import { buildMigrateV4, type MigrateV4Input } from '@mamoru/account/one-auth'
import { v4RemoteFromSpec } from '@mamoru/account/remote'
import { resolveV6Policy } from '../src/boot.ts'
import { movedTo, type Operator } from '../src/operator.ts'
import type { AccountState } from '../src/state.ts'
import { withPinnedV6Base } from '../../../packages/account/remote/fixture.ts'
import { ctx, world } from './owner-world.ts'

const D: OneAuthV4Deployment = { table: '0x00000000000000000000000000000000000000a1', policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3', migrationCheck: '0x00000000000000000000000000000000000000a4' }
const KEY = `0x${'5'.repeat(64)}` as Hex
const reg6 = withPinnedV6Base()
const v6 = resolveV6Policy('base', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: `0x${'11'.repeat(20)}`, MAMORU_ACTION_POLICY_V2_ADDRESS: `0x${'33'.repeat(20)}`, MAMORU_GAS_POLICY_ADDRESS: `0x${'22'.repeat(20)}` }, reg6)!

/** A registry with the V4 stack pinned (what the base.json / monad.json pin does). */
function pinned(r: Registry): Registry {
  const names = ['MamoruV4Table', 'MamoruActionPolicyV4', 'MamoruGasPolicyV2', 'MamoruMigrationCheck'] as const
  const at = [D.table, D.policy, D.gasPolicy, D.migrationCheck]
  return { ...r, undeployed: [], entries: [...r.entries.filter((e) => !(names as readonly string[]).includes(e.name)), ...names.map((name, i) => ({ name, kind: 'smart-sessions-policy', role: 'test', address: at[i]!, codeHash: null }) as never)] }
}
const base6 = pinned(reg6)

describe('the migrate-v4 prepare is exactly buildMigrateV4(input), and input is derivable by the Worker', () => {
  test('step 0 (Base): the real prepare of a v6 account', async () => {
    // #356: the Monad operator's remote session key for this account, pinned in the session
    const REMOTE = '0x000000000000000000000000000000000000f00d' as const
    const w = world(0n, { registry: base6, v6Policy: v6, oneAuth: D, opsFlags: () => ({}), opsScopedFlags: () => ({ one_auth_v4: ['k'] }), remotePeers: { 143: { key: async () => REMOTE, provision: async () => ({ state: 'pending', code: 'TEST' }) } } })
    const grants = v6.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ name: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex, grant: { policyId: v6.policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } }))
    const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: v6.policyId, sessionKey: KEY, signedCapUsdc: '1500000000', grants, ops: [], revoked: [], managedTokenIds: [], admittedTokenIds: [], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 0 } as unknown as AccountState
    w.state.accounts.k = acc
    const ids = grants.map((g) => g.permissionId)
    const nonceOf = (id: Hex) => BigInt(ids.indexOf(id) + 3)
    const p = w.op as unknown as { inventoryNow: () => Promise<unknown>; capFor: (a: AccountState) => bigint; client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown> } }
    p.inventoryNow = async () => ({ ok: true, at: '', scannedFrom: '0', scannedTo: '1', events: ids, remove: ids, revoke: ids })
    const real = p.client.readContract.bind(p.client)
    p.client.readContract = async (a) => (a.functionName === 'isPaused' ? false : a.functionName === 'getNonce' ? nonceOf(a.args![0] as Hex) : a.functionName === 'getPermissionIDs' ? ids : real(a))
    const tx = await (w.op as Operator).prepareMigrateV4(ctx, { step: 0 })
    const input = tx.input!
    // the Worker's rebuild
    const rebuilt = buildMigrateV4(input, base6)
    expect(rebuilt.safeTxHash).toBe(tx.safeTxHash)
    expect(rebuilt.safeTx).toEqual(tx.safeTx!)
    // what the Worker derives on its own
    expect(input.safe.toLowerCase()).toBe(ctx.address.toLowerCase()) // its D1 row
    expect(tx.safe.toLowerCase()).toBe(ctx.address.toLowerCase())
    expect(input.chainId).toBe(8453)
    expect(tx.chainId).toBe(8453)
    expect(input.step).toBe(0)
    expect(input.capUsdc).toBe(v4CapUsdOf(p.capFor(acc)).toString()) // the D1 cap, C = cap x Base share x multiple
    expect(input.removeIds).toEqual(ids) // = SmartSession.getPermissionIDs on chain
    expect(input.noncesBefore).toEqual(input.oldPermissionIds.map((id) => nonceOf(id).toString())) // = getNonce on chain
    expect(BigInt(input.home)).toBe(0n)
    expect(input.homeDomain).toBe(0)
    expect(input.moveTo).toBeUndefined()
    expect(input.sessionKey).toBe(privateKeyToAccount(KEY).address) // the operator's own key
    expect(input.remote).toEqual({ domain: 15, sessionKey: REMOTE }) // #356: the only remote its session may register
    expect(input.safeNonce).toBe(tx.safeTx!.nonce)
    expect(tx.safeTx).toMatchObject({ safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: '0x0000000000000000000000000000000000000000', refundReceiver: '0x0000000000000000000000000000000000000000' })
    // one changed field gives another hash
    expect(buildMigrateV4({ ...input, capUsdc: (BigInt(input.capUsdc) + 1n).toString() }, base6).safeTxHash).not.toBe(tx.safeTxHash)
  })

  test('step 1 (Monad): the destination is the V4 Safe the owner keys give, and the only recipient', () => {
    const monad = pinned(monadRegistry)
    const sessionKey = privateKeyToAccount(KEY).address
    const spec = { chainId: 143, policyId: ONE_AUTH_V4_REMOTE, sessionKey, validAfter: 0, validUntil: 0, capUsdc: '2550000000', home: ctx.address, homeDomain: 6 }
    const target = v4RemoteFromSpec(ctx, spec, monad)
    const old = '0x0000000000000000000000000000000000000ce1' as const
    const ids = [`0x${'01'.padStart(64, '0')}`] as Hex[]
    const input: MigrateV4Input = { chainId: 143, safe: old, safeNonce: '0', step: 1, capUsdc: '1', sessionKey, generation: '1', admit: [], oldPermissionIds: ids, removeIds: ids, noncesBefore: ['0'], home: ctx.address, homeDomain: 6, moveTo: target.address, transfers: [{ token: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', amount: '5' }] }
    const built = buildMigrateV4(input, monad)
    expect(movedTo(built.calls)!.toLowerCase()).toBe(target.address.toLowerCase())
    expect(buildMigrateV4(JSON.parse(JSON.stringify(input)), monad).safeTxHash).toBe(built.safeTxHash)
  })
})
