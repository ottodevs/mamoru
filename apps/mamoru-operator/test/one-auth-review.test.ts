// otto/mamoru#293, the fixes of the high-stakes review of PR #202 (Opus + Argon NO APTO), one test each.
import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address, OpView } from '@mamoru/domain'
import { baseRegistry, monadRegistry, type Registry } from '@mamoru/registry'
import { grantKey, ONE_AUTH_V4, oneAuthV4Live, staticPool, v4CapUsdOf, v4ChainShareBps, V4_CAP_MULTIPLE_BPS, type OneAuthV4Deployment, type RegistryPool } from '@mamoru/policy'
import { baseKeyOf, remoteAccountKey, v4RemoteAccountKey } from '@mamoru/account/remote'
import { webAuthnSigner } from '@mamoru/account/safe'
import { v4CreateSetup, v4HomeSession } from '@mamoru/account/one-auth'
import { HttpError, type Operator } from '../src/operator.ts'
import { baseStepLines, v4StoredGrant } from '../src/one-auth.ts'
import type { AccountState } from '../src/state.ts'
import { ctx, passkey, world } from './owner-world.ts'

const D: OneAuthV4Deployment = { registry: '0x00000000000000000000000000000000000000a1', policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3', migrationCheck: '0x00000000000000000000000000000000000000a4' }
const KEY = `0x${'5'.repeat(64)}` as Hex
const pinned = (r: Registry): Registry => {
  const names = ['MamoruRegistry', 'MamoruActionPolicyV4', 'MamoruGasPolicyV2', 'MamoruMigrationCheck'] as const
  const at = [D.registry, D.policy, D.gasPolicy, D.migrationCheck]
  return { ...r, undeployed: [], entries: [...r.entries, ...names.map((name, i) => ({ name, kind: 'smart-sessions-policy', role: 'test', address: at[i]!, codeHash: null }) as never)] }
}
const base = pinned(baseRegistry)
const scoped = { oneAuth: D, opsFlags: () => ({}), opsScopedFlags: () => ({ one_auth_v4: ['k'] }) }
type Priv = { client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown>; getBlockNumber: () => Promise<bigint>; getLogs: (a: unknown) => Promise<unknown[]> }; v4Engine(a: AccountState): { policy: { buckets: { id: string; pools: string[] }[] }; registry: Registry }; v4PoolsCache: unknown; prepared: Map<string, unknown>; tickOneAuth(): Promise<void> }
const priv = (op: Operator) => op as unknown as Priv

function onV4(w: ReturnType<typeof world>, extra: Partial<AccountState> = {}): AccountState {
  const g = v4StoredGrant({ account: ctx.address, chainId: 8453, sessionKey: privateKeyToAccount(KEY).address, permissionId: `0x${'ee'.repeat(32)}`, salt: `0x${'00'.repeat(32)}`, deployment: D, registry: baseRegistry })
  const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: ONE_AUTH_V4, sessionKey: KEY, grants: [{ name: 'one-auth-v4', grant: g, permissionId: `0x${'ee'.repeat(32)}` }], ops: [{ opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'confirmed', updatedAt: '', migrateStep: 0 }], revoked: [], managedTokenIds: [], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 1, ...extra } as unknown as AccountState
  w.state.accounts.k = acc
  return acc
}
const pool = (name: string): RegistryPool => ({ ...staticPool(name, baseRegistry), entry: { twapWindow: 600, twapShortWindow: 60, bandTicks: 100, anchorTick: 0, anchorBand: name.includes('USDT') ? 40 : 0, ratioBps: 10_000, active: true } })
function poolsAre(w: ReturnType<typeof world>, pools: RegistryPool[]) {
  priv(w.op).v4PoolsCache = { peek: () => ({ pools, key: pools.map((p) => p.address).join() }), get: async () => ({ pools, key: pools.map((p) => p.address).join() }) }
}

describe('P0-3: the V4 remote of a design-C account has its own key on the Monad operator', () => {
  test('distinct keys, both resolve to the Base account', () => {
    expect(v4RemoteAccountKey('k', 143)).not.toBe(remoteAccountKey('k', 143))
    expect(baseKeyOf(v4RemoteAccountKey('k', 143), 143)).toBe('k')
    expect(baseKeyOf(remoteAccountKey('k', 143), 143)).toBe('k')
  })

  test('a migrating design-C account provisions its V4 remote under the .v4 key, never the design-C one', async () => {
    const provisioned: AccountContext[] = []
    const peer = { key: async () => privateKeyToAccount(KEY).address, provision: async (c: AccountContext) => (provisioned.push(c), { state: 'pending' as const, code: 'X' }) }
    const w = world(0n, { ...scoped, remoteRegistry: () => pinned(monadRegistry), remotePeers: { 143: peer } })
    const acc = onV4(w, { remote: { chainId: 143, address: `0x${'9'.repeat(40)}`, spec: { chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: privateKeyToAccount(KEY).address, validAfter: 1, validUntil: 2, capUsdc: '1' }, permissionIds: ['0x01'] } as never })
    const target = (w.op as unknown as { v4RemoteTarget(a: AccountState, k: Address, c: bigint): { address: Address } }).v4RemoteTarget(acc, privateKeyToAccount(KEY).address, v4CapUsdOf(100_000_000n))
    const c = priv(w.op).client
    const real = c.readContract.bind(c)
    c.readContract = async (a) => (a.functionName === 'remoteOf' ? { remote: target.address, capUsd: v4CapUsdOf(100_000_000n), ownersHash: `0x${'00'.repeat(32)}`, sessionKey: privateKeyToAccount(KEY).address } : a.functionName === 'isReady' ? false : real(a))
    acc.oneAuth = { capUsd: v4CapUsdOf(100_000_000n).toString() }
    await priv(w.op).tickOneAuth()
    expect(provisioned.map((p) => p.accountKey)).toEqual([v4RemoteAccountKey('k', 143)])
    expect(provisioned[0]!.address).toBe(target.address)
    expect(acc.oneAuth?.remote?.accountKey).toBe(v4RemoteAccountKey('k', 143))
  })
})

describe('P0-4: the operator registry is never mutated; pool replacement takes effect', () => {
  test('a V4 engine build leaves cfg.registry deep-equal; replacing a pool changes the engine pools', () => {
    const w = world(0n, scoped)
    const snapshot = JSON.parse(JSON.stringify(w.op.cfg.registry))
    const ref = w.op.cfg.registry
    const acc = onV4(w)
    poolsAre(w, [pool('pool:USDC/USDT/100'), pool('pool:WETH/USDC/3000')])
    const a = priv(w.op).v4Engine(acc)
    expect(a.policy.buckets.map((b) => b.pools)).toEqual([['pool:USDC/USDT/100'], ['pool:WETH/USDC/3000']])
    poolsAre(w, [pool('pool:USDC/USDT/100'), pool('pool:USDC/cbBTC/500')])
    const b = priv(w.op).v4Engine(acc)
    expect(b.policy.buckets.map((x) => x.pools)).toEqual([['pool:USDC/USDT/100'], ['pool:USDC/cbBTC/500']])
    expect(w.op.cfg.registry).toBe(ref)
    expect(JSON.parse(JSON.stringify(w.op.cfg.registry))).toEqual(snapshot)
    expect(b.registry).not.toBe(ref) // the engine's own copy
  })
})

describe('P1-7: step 1 never stuck in flight; Monad pause fails closed; one submit at a time', () => {
  test('a step 1 that failed on Monad is failed here too (the step opens again)', async () => {
    const peer = { key: async () => privateKeyToAccount(KEY).address, provision: async () => ({ state: 'pending' as const, code: 'X' }), migrateV4: async (_c: AccountContext, phase: string) => (phase === 'status' ? { done: false, failed: true, code: 'OWNER_TX_REVERTS' } : null) }
    const w = world(0n, { ...scoped, remotePeers: { 143: peer } })
    const acc = onV4(w, { remote: { chainId: 143, address: `0x${'9'.repeat(40)}`, spec: { chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: privateKeyToAccount(KEY).address, validAfter: 1, validUntil: 2, capUsdc: '1' }, permissionIds: ['0x01'] } as never })
    acc.ops.push({ opId: 'own-2-migrate-v4', kind: 'migrate-v4', state: 'submitted', updatedAt: '', migrateStep: 1 } as never)
    const c = priv(w.op).client
    const real = c.readContract.bind(c)
    c.readContract = async (a) => (a.functionName === 'remoteOf' || a.functionName === 'isReady' ? (() => { throw new Error('down') })() : real(a))
    await priv(w.op).tickOneAuth()
    expect(acc.ops.find((o) => o.opId === 'own-2-migrate-v4')).toMatchObject({ state: 'failed', code: 'OWNER_TX_REVERTS' })
  })

  test('Monad: an unreadable home pause refuses the submit (PAUSE_STATE_UNAVAILABLE), never sends', async () => {
    const homeClient = { readContract: async (a: { functionName: string }) => (a.functionName === 'configOf' ? { set: true } : (() => { throw new Error('down') })()) }
    const w = world(0n, { ...scoped, chainId: 143, homeClient: homeClient as never })
    const c143 = { ...ctx, chainId: 143 }
    priv(w.op).prepared.set('p1', { prepareId: 'p1', accountKey: 'k', kind: 'migrate-v4', step: 1, home: ctx.address, expires: Date.now() + 60_000, safeTxHash: '0x01', tx: { nonce: 0n } })
    const e = await w.op.submitMigrateV4(c143, { prepareId: 'p1', authenticatorData: '', clientDataJSON: '', signature: '', step: 1 }).catch((x) => x)
    expect((e as HttpError).code).toBe('PAUSE_STATE_UNAVAILABLE')
  })

  test('two submits at once: the second is refused (ONE_AUTH_STEP_IN_FLIGHT)', async () => {
    const w = world(0n, scoped)
    const grants = [{ name: 'x', permissionId: `0x${'01'.repeat(32)}` as Hex, grant: { policyId: 'conservador-live-v2', userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } }]
    w.state.accounts.k = { accountKey: 'k', ctx, active: true, trusted: true, policyId: 'conservador-live-v2', grants, ops: [], revoked: [], managedTokenIds: [], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 0 } as unknown as AccountState
    const c = priv(w.op).client
    const real = c.readContract.bind(c)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    c.readContract = async (a) => (a.functionName === 'isPaused' ? (await gate, false) : real(a))
    const body = { prepareId: 'nope', authenticatorData: '', clientDataJSON: '', signature: '', step: 0 }
    const first = w.op.submitMigrateV4(ctx, body).catch((x) => x)
    const second = await w.op.submitMigrateV4(ctx, body).catch((x) => x)
    expect((second as HttpError).code).toBe('ONE_AUTH_STEP_IN_FLIGHT')
    release()
    await first
  })
})

describe('P1-8: the SessionCreated scan is off the request path, bounded and checkpointed', () => {
  test('a prepare with the scan behind is refused, typed and retryable; the background scan checkpoints every page', async () => {
    const w = world(0n, { ...scoped, oneAuthLogPage: 1_000n })
    const grants = [{ name: 'x', permissionId: `0x${'01'.repeat(32)}` as Hex, grant: { policyId: 'conservador-live-v6', userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } }]
    const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: 'conservador-live-v2', sessionKey: KEY, grants, ops: [], revoked: [], managedTokenIds: [], depositsAfter: '1', historyFromBlock: '1000', epoch: 1, seq: 0 } as unknown as AccountState
    w.state.accounts.k = acc
    const c = priv(w.op).client
    const real = c.readContract.bind(c)
    c.readContract = async (a) => (a.functionName === 'isPaused' ? false : real(a))
    c.getBlockNumber = async () => 1_000_000n
    let pages = 0
    c.getLogs = async () => (pages++, [])
    const p = w.op as unknown as { inventoryNow(a: AccountState): Promise<unknown>; scanInventory(a: AccountState): Promise<void>; v4Eligible(a: AccountState): boolean }
    p.v4Eligible = () => true
    const e = await w.op.prepareMigrateV4(ctx, { step: 0 }).catch((x) => x)
    expect((e as HttpError).code).toBe('ONE_AUTH_INVENTORY_PENDING') // the prepare never scans: refused, typed, retryable
    for (let i = 0; i < 200 && (w.op as unknown as { scanning: Set<string> }).scanning.has('k'); i++) await Bun.sleep(5)
    delete (acc as { oneAuth?: unknown }).oneAuth
    pages = 0
    expect(await p.inventoryNow(acc)).toBeNull() // behind: refused, and the background scan starts
    const busy = (w.op as unknown as { scanning: Set<string> }).scanning
    for (let i = 0; i < 200 && (busy.has('k') || !acc.oneAuth?.inventory); i++) await Bun.sleep(5)
    expect(pages).toBeLessThanOrEqual(200)
    expect(BigInt(acc.oneAuth!.inventory!.scannedTo)).toBe(950n + 200n * 1_000n - 1n)
  })
})

describe('P1-9: an account created on V4 counts its first deposit and needs the minimum', () => {
  test('deployed with no USDC: waits (BELOW_DEPLOY_MINIMUM); deposits are counted from the block the key was given', async () => {
    const w = world(0n, { ...scoped, registry: base })
    const key = await w.op.oneAuthKey({ ...ctx, accountKey: 'k' })
    const session = v4HomeSession({ sessionKey: key.sessionKey, deployment: D, capUsd: BigInt(key.capUsdc), generation: 1n, admit: [], registry: base })
    const created = v4CreateSetup(ctx.owners as Address[], BigInt(ctx.saltNonce), webAuthnSigner(passkey.x, passkey.y, base), session, base)
    const c2: AccountContext = { ...ctx, address: created.address, oneAuth: { sessionKey: key.sessionKey, capUsdc: key.capUsdc } }
    w.chain.deployed = true
    const r = await w.op.startOneAuth(c2)
    expect(r).toEqual({ state: 'waiting', code: 'BELOW_DEPLOY_MINIMUM' })
    expect((w.state as unknown as { oneAuthKeyBlocks?: Record<string, string> }).oneAuthKeyBlocks?.k).toBeDefined()
  })
})

describe('P1-11: C per chain from the policy split and one named multiple; the lines state the real numbers', () => {
  test('Base share 85 %, Monad 15 %, multiple 2: C = 1.7x the cap on Base', () => {
    expect(v4ChainShareBps(oneAuthV4Live, 8453)).toBe(8500)
    expect(v4ChainShareBps(oneAuthV4Live, 143)).toBe(1500)
    expect(V4_CAP_MULTIPLE_BPS).toBe(20_000)
    expect(v4CapUsdOf(100_000_000n)).toBe(170_000_000n)
    expect(v4CapUsdOf(100_000_000n, oneAuthV4Live, 8453)).toBe(170_000_000n)
  })
  test('the summary says that C and 3C, for this Safe and the remote one', () => {
    const lines = baseStepLines({ remove: 3, revoke: 3, capUsd: 170_000_000n, admitted: 0, remoteChain: 'Monad' })
    expect(lines.some((l) => l.includes('170 USDC') && l.includes('510 USDC'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Your Safe on Monad') && l.includes('170 USDC'))).toBe(true)
  })
})

void grantKey
void ({} as OpView)
