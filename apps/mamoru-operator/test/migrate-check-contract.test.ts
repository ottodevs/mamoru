// otto/mamoru#293 x #295: the cross-side contract. The merged operator's REAL migrate-v4 prepare (step 0 on Base; step 1 on
// Monad, with and without funds to move) is run through the Worker's own `checkMigrateTx` with the D1 rows the Worker would
// have, and must pass; a tampered one must not. The two sides cannot drift without this failing.
import { describe, expect, test } from 'bun:test'
import { encodeFunctionResult, toFunctionSelector, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, OwnerTxToSign } from '@mamoru/domain'
import { address, monadRegistry, uniswapV3PoolAbi, type Registry } from '@mamoru/registry'
import { grantKey, ONE_AUTH_V4_REMOTE, POLICIES, v4CapUsdOf, type OneAuthV4Deployment } from '@mamoru/policy'
import { remoteAccountKey, remoteInput, remoteSafe, v4RemoteFromSpec } from '@mamoru/account/remote'
import { checkMigrateTx } from '../../mamoru-app/src/api/migrate-check.ts'
import type { AccountRow } from '../../mamoru-app/src/api/accounts/store.ts'
import { resolveV6Policy } from '../src/boot.ts'
import { Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'
import { withPinnedV3, withPinnedV6Base } from '../../../packages/account/remote/fixture.ts'
import { answerAggregate3 } from './fake-multicall.ts'
import { ctx, world } from './owner-world.ts'

const D: OneAuthV4Deployment = { registry: '0x00000000000000000000000000000000000000a1', policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3', migrationCheck: '0x00000000000000000000000000000000000000a4' }
const KEY = `0x${'5'.repeat(64)}` as Hex
const SESSION_KEY = privateKeyToAccount(KEY).address
const CAP = 1_500_000_000n // the account's D1 cap (USDC base units)
const reg6 = withPinnedV6Base()
const v6 = resolveV6Policy('base', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: `0x${'11'.repeat(20)}`, MAMORU_ACTION_POLICY_V2_ADDRESS: `0x${'33'.repeat(20)}`, MAMORU_GAS_POLICY_ADDRESS: `0x${'22'.repeat(20)}` }, reg6)!

function pinned(r: Registry): Registry {
  const names = ['MamoruRegistry', 'MamoruActionPolicyV4', 'MamoruGasPolicyV2', 'MamoruMigrationCheck'] as const
  const at = [D.registry, D.policy, D.gasPolicy, D.migrationCheck]
  return { ...r, undeployed: [], entries: [...r.entries, ...names.map((name, i) => ({ name, kind: 'smart-sessions-policy', role: 'test', address: at[i]!, codeHash: null }) as never)] }
}
const base6 = pinned(reg6)
const monad = pinned(withPinnedV3(monadRegistry))
const OLD_SPEC = { chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: SESSION_KEY, validAfter: 1_790_000_000, validUntil: 1_821_536_000, capUsdc: '1500000000' }

/** The D1 rows the Worker would hold for this account: Base, and its pre-V4 Monad Safe. */
const row = (chainId: number, addr: string): AccountRow => ({ account_key: chainId === 8453 ? 'k' : remoteAccountKey('k', 143), user_id: 'u', chain_id: chainId, address: addr as never, owners_json: JSON.stringify(ctx.owners), passkey_credential_id: ctx.passkey.credentialId, passkey_x: ctx.passkey.x, passkey_y: ctx.passkey.y, salt_nonce: ctx.saltNonce, preset: 'conservador', policy_version: 'x', recovery_ack_at: null, created_at: '', env: 'prod', is_test: 1 })
// The design-C Safe's own address: the one its keys and spec give.
const OLD_MONAD = remoteSafe(remoteInput(ctx, OLD_SPEC, monad)).address
const caps = { base: v4CapUsdOf(CAP) }

/** Step 0: the real Base prepare of a v6 account (inventory and chain reads stubbed as in migrate-v4-input.test.ts). */
async function realStep0(): Promise<OwnerTxToSign> {
  const w = world(0n, { registry: base6, v6Policy: v6, oneAuth: D, opsFlags: () => ({}), opsScopedFlags: () => ({ one_auth_v4: ['k'] }) })
  const grants = v6.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ name: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex, grant: { policyId: v6.policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } }))
  w.state.accounts.k = { accountKey: 'k', ctx, active: true, trusted: true, policyId: v6.policyId, sessionKey: KEY, signedCapUsdc: CAP.toString(), grants, ops: [], revoked: [], managedTokenIds: [], admittedTokenIds: [], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 0 } as unknown as AccountState
  const ids = grants.map((g) => g.permissionId)
  const p = w.op as unknown as { inventoryNow: () => Promise<unknown>; capFor: (a: AccountState) => bigint; client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown> } }
  p.capFor = () => CAP
  p.inventoryNow = async () => ({ ok: true, at: '', scannedFrom: '0', scannedTo: '1', events: ids, remove: ids, revoke: ids })
  const real = p.client.readContract.bind(p.client)
  p.client.readContract = async (a) => (a.functionName === 'isPaused' ? false : a.functionName === 'getNonce' ? 3n : a.functionName === 'getPermissionIDs' ? ids : real(a))
  return w.op.prepareMigrateV4(ctx, { step: 0 })
}

/** Step 1: the real Monad-side prepare (planRemoteMigration) on the design-C Safe, over a fake Monad chain holding `funds`. */
async function realStep1(funds: { usdc: bigint; wmon: bigint }): Promise<OwnerTxToSign> {
  const word = (v: bigint) => toHex(v, { size: 32 })
  const usdc = address('USDC', monad).toLowerCase()
  const wmon = address('WMON', monad).toLowerCase()
  const balances = (target: string) => (target.toLowerCase() === usdc ? funds.usdc : target.toLowerCase() === wmon ? funds.wmon : 0n)
  const client = {
    getBlockNumber: async () => 500n,
    getBlock: async () => ({ number: 500n, hash: `0x${'ab'.repeat(32)}`, parentHash: `0x${'cd'.repeat(32)}`, timestamp: 1_790_000_000n }),
    getGasPrice: async () => 100_000_000_000n,
    getCode: async () => '0x01',
    getBalance: async () => 10n ** 18n,
    getTransactionCount: async () => 5,
    getLogs: async () => [],
    readContract: async ({ functionName, args, address: at }: { functionName: string; args?: readonly unknown[]; address?: string }) => {
      if (functionName === 'nonce') return 9n
      if (functionName === 'balanceOf') return balances(String(at))
      if (functionName === 'getNonce') return 1n
      if (functionName === 'getPermissionIDs') return [`0x${'01'.padStart(64, '0')}`]
      if (functionName === 'isPermissionEnabled') return true
      if (functionName === 'slot0') return [2n ** 96n, 0, 0, 0, 0, 0, true]
      void args
      throw new Error(`unexpected read ${functionName}`)
    },
    request: async () => `0x${'0'.repeat(64)}`,
    call: async ({ to, data }: { to: string; data: Hex }) => {
      if (to.toLowerCase() === address('Multicall3', monad).toLowerCase()) {
        return {
          data: answerAggregate3(data, (target, callData) => {
            if (callData.startsWith('0x70a08231')) return word(balances(target))
            if (callData.startsWith('0x3850c7bd')) return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'slot0', result: [2n ** 96n, 0, 0, 0, 0, 0, true] })
            if (callData.startsWith('0x4d2301cc')) return word(10n ** 18n)
            if (callData.startsWith(toFunctionSelector('getBlockNumber()'))) return word(500n)
            if (callData.startsWith(toFunctionSelector('isPermissionEnabled(bytes32,address)'))) return word(1n)
            throw new Error('execution reverted')
          }),
        }
      }
      return { data: '0x' as Hex }
    },
  } as unknown as PublicClient
  const relayer = { address: `0x${'7'.repeat(40)}`, send: async () => ({ hash: `0x${'1'.repeat(64)}`, receipt: { status: 'success', logs: [] } as unknown as TransactionReceipt }) } as unknown as Relayer
  const baseKey = 'k'
  const remoteCtx: AccountContext = {
    ...ctx,
    accountKey: remoteAccountKey(baseKey, 143),
    chainId: 143,
    address: OLD_MONAD,
    remote: OLD_SPEC,
  }
  const state = { accounts: {} as Record<string, AccountState>, remoteKeys: { [baseKey]: KEY } }
  const store = { state, save: () => {} } as unknown as StateStore
  // The Base account's V4 config, read over the home chain: set, with the C the Base step signed.
  const homeClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'configOf') return { set: true, capUsd: caps.base, generation: 1n, homeDomain: 0, initHash: `0x${'00'.repeat(32)}`, home: '0x0000000000000000000000000000000000000000' }
      if (functionName === 'isPaused') return false
      if (functionName === 'remoteOf') return { remote: '0x0000000000000000000000000000000000000000', capUsd: 0n, ownersHash: `0x${'00'.repeat(32)}`, sessionKey: '0x0000000000000000000000000000000000000000' }
      throw new Error(`unexpected home read ${functionName}`)
    },
  } as unknown as PublicClient
  const cfg = { chainId: 143, registry: monad, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1, oneAuth: D, homeClient, chainWrites: [143], opsFlags: () => ({}), opsScopedFlags: () => ({}) } as unknown as OperatorConfig
  const op = new Operator(cfg, client, relayer, store)
  ;(op as unknown as { retryMs: number }).retryMs = 0
  ;(op as unknown as { inventoryNow: () => Promise<unknown> }).inventoryNow = async () => ({ ok: true, at: '', scannedFrom: '0', scannedTo: '1', events: [`0x${'01'.padStart(64, '0')}`], remove: [`0x${'01'.padStart(64, '0')}`], revoke: [`0x${'01'.padStart(64, '0')}`] })
  // The Monad account the design-C Safe is: active on its design-C policy.
  state.accounts[remoteCtx.accountKey] = { accountKey: remoteCtx.accountKey, ctx: remoteCtx, active: true, trusted: true, policyId: 'live-wmon-usdc-monad-v6', sessionKey: KEY, grants: [], ops: [], revoked: [], managedTokenIds: [], admittedTokenIds: [], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 0 } as unknown as AccountState
  // The destination the Base operator names (V4's derivation over the account's keys): the Monad operator checks it itself.
  const target = v4RemoteFromSpec({ address: ctx.address, owners: ctx.owners, passkey: ctx.passkey }, { chainId: 143, policyId: ONE_AUTH_V4_REMOTE, sessionKey: SESSION_KEY, validAfter: 0, validUntil: 0, capUsdc: caps.base.toString(), home: ctx.address, homeDomain: 6 }, monad).address
  return op.prepareMigrateV4(remoteCtx, { step: 1, home: ctx.address, capUsdc: caps.base.toString(), moveTo: target })
}

const rows1 = { base: row(8453, ctx.address), monad: row(143, OLD_MONAD) }
const regOf = (c: number) => (c === 143 ? monad : base6)

describe("the merged operator's real migrate-v4 prepare passes the Worker's check", () => {
  test('step 0 (Base)', async () => {
    const tx = await realStep0()
    expect(() => checkMigrateTx({ tx, step: 0, base: row(8453, ctx.address), monad: null, capUsdc: CAP.toString(), registryOf: regOf })).not.toThrow()
  })

  test('step 1 (Monad) with funds to move', async () => {
    const tx = await realStep1({ usdc: 5_000_000n, wmon: 3n * 10n ** 18n })
    expect(tx.moveTo).toBeDefined()
    expect(() => checkMigrateTx({ tx, step: 1, ...rows1, capUsdc: CAP.toString(), registryOf: regOf })).not.toThrow()
  })

  test('step 1 (Monad) with nothing to move: no destination, no transfers', async () => {
    const tx = await realStep1({ usdc: 0n, wmon: 0n })
    expect(tx.moveTo).toBeUndefined()
    expect(tx.input?.transfers ?? []).toHaveLength(0)
    expect(() => checkMigrateTx({ tx, step: 1, ...rows1, capUsdc: CAP.toString(), registryOf: regOf })).not.toThrow()
  })

  test('a tampered real prepare fails (a changed nonce in the transaction, a changed cap in the input)', async () => {
    const tx = await realStep0()
    const at = { step: 0 as const, base: row(8453, ctx.address), monad: null, capUsdc: CAP.toString(), registryOf: regOf }
    expect(() => checkMigrateTx({ tx: { ...tx, safeTx: { ...tx.safeTx!, nonce: '99' } }, ...at })).toThrow()
    expect(() => checkMigrateTx({ tx: { ...tx, input: { ...tx.input!, capUsdc: (BigInt(tx.input!.capUsdc) + 1n).toString() } }, ...at })).toThrow()
  })
})
