// otto/mamoru#293, the fixes of the high-stakes review of PR #202 (Opus + Argon NO APTO), one test each.
import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, getAddress, encodeFunctionResult, parseAbi, type Hex } from 'viem'
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

const D: OneAuthV4Deployment = { table: '0x00000000000000000000000000000000000000a1', policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3', migrationCheck: '0x00000000000000000000000000000000000000a4' }
const KEY = `0x${'5'.repeat(64)}` as Hex
const pinned = (r: Registry): Registry => {
  const names = ['MamoruV4Table', 'MamoruActionPolicyV4', 'MamoruGasPolicyV2', 'MamoruMigrationCheck'] as const
  const at = [D.table, D.policy, D.gasPolicy, D.migrationCheck]
  return { ...r, undeployed: [], entries: [...r.entries.filter((e) => !(names as readonly string[]).includes(e.name)), ...names.map((name, i) => ({ name, kind: 'smart-sessions-policy', role: 'test', address: at[i]!, codeHash: null }) as never)] }
}
const base = pinned(baseRegistry)
const scoped = { oneAuth: D, opsFlags: () => ({}), opsScopedFlags: () => ({ one_auth_v4: ['k'] }) }
type Priv = { client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown>; getBlockNumber: () => Promise<bigint>; getLogs: (a: unknown) => Promise<unknown[]> }; v4Engine(a: AccountState): { policy: { buckets: { id: string; pools: string[] }[] }; registry: Registry }; v4PoolsCache: unknown; prepared: Map<string, unknown>; tickOneAuth(): Promise<void>; refreshV4Held(a: AccountState): Promise<void>; v4PoolsFor(a: AccountState): { key: string } | null }
const priv = (op: Operator) => op as unknown as Priv

function onV4(w: ReturnType<typeof world>, extra: Partial<AccountState> = {}): AccountState {
  const g = v4StoredGrant({ account: ctx.address, chainId: 8453, sessionKey: privateKeyToAccount(KEY).address, permissionId: `0x${'ee'.repeat(32)}`, salt: `0x${'00'.repeat(32)}`, deployment: D, registry: baseRegistry })
  const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: ONE_AUTH_V4, sessionKey: KEY, grants: [{ name: 'one-auth-v4', grant: g, permissionId: `0x${'ee'.repeat(32)}` }], ops: [{ opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'confirmed', updatedAt: '', migrateStep: 0 }], revoked: [], managedTokenIds: [], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 1, ...extra } as unknown as AccountState
  w.state.accounts.k = acc
  return acc
}
const pool = (name: string): RegistryPool => ({ ...staticPool(name, baseRegistry), entry: { twapWindow: 600, twapShortWindow: 60, bandTicks: 100, anchorTick: 0, anchorBand: name.includes('USDT') ? 40 : 0, ratioBps: 10_000, active: true } })
function poolsAre(w: ReturnType<typeof world>, pools: RegistryPool[]) {
  const read = { pools, key: pools.map((p) => p.address).join() }
  priv(w.op).v4PoolsCache = { peek: () => read, get: async () => read }
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
    c.readContract = async (a) => (a.functionName === 'configOf' ? { set: true, capUsd: v4CapUsdOf(100_000_000n) } : a.functionName === 'remoteOf' ? { remote: target.address, capUsd: v4CapUsdOf(100_000_000n), ownersHash: `0x${'00'.repeat(32)}`, sessionKey: privateKeyToAccount(KEY).address } : a.functionName === 'isReady' ? false : real(a))
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

  test('Monad (A1): the home has no pause, only its V4 config is read; an unreadable config refuses (HOME_UNAVAILABLE)', async () => {
    const read: string[] = []
    let down = true
    const homeClient = { readContract: async (a: { functionName: string }) => (read.push(a.functionName), a.functionName === 'configOf' && !down ? { set: true } : (() => { throw new Error('down') })()) }
    const w = world(0n, { ...scoped, chainId: 143, homeClient: homeClient as never })
    const c143 = { ...ctx, chainId: 143 }
    const prep = () => priv(w.op).prepared.set('p1', { prepareId: 'p1', accountKey: 'k', kind: 'migrate-v4', step: 1, home: ctx.address, expires: Date.now() + 60_000, safeTxHash: '0x01', tx: { nonce: 0n } })
    prep()
    const e = await w.op.submitMigrateV4(c143, { prepareId: 'p1', authenticatorData: '', clientDataJSON: '', signature: '', step: 1 }).catch((x) => x)
    expect((e as HttpError).code).toBe('HOME_UNAVAILABLE')
    down = false
    prep()
    const f = await w.op.submitMigrateV4(c143, { prepareId: 'p1', authenticatorData: '', clientDataJSON: '', signature: '', step: 1 }).catch((x) => x)
    expect((f as HttpError | undefined)?.code).not.toBe('PAUSE_STATE_UNAVAILABLE')
    expect((f as HttpError | undefined)?.code).not.toBe('ONE_AUTH_PAUSED')
    expect(read.every((n) => n === 'configOf')).toBe(true)
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

// #356: the Monad operator's remote session key for the account (stable per account, as `remoteKey` keeps it).
const REMOTE: Address = getAddress('0x000000000000000000000000000000000000f00d')
const keyPeer = (key: () => Promise<Address>) => ({ 143: { key, provision: async () => ({ state: 'pending' as const, code: 'TEST' }) } })

describe('P1-9: an account created on V4 counts its first deposit and needs the minimum', () => {
  test('deployed with no USDC: waits (BELOW_DEPLOY_MINIMUM); deposits are counted from the block the key was given', async () => {
    const w = world(0n, { ...scoped, registry: base, remotePeers: keyPeer(async () => REMOTE) })
    const key = await w.op.oneAuthKey({ ...ctx, accountKey: 'k' })
    expect(key.remote).toEqual({ domain: 15, sessionKey: REMOTE })
    const session = v4HomeSession({ sessionKey: key.sessionKey, deployment: D, capUsd: BigInt(key.capUsdc), generation: 1n, admit: [], remote: key.remote, registry: base })
    const created = v4CreateSetup(ctx.owners as Address[], BigInt(ctx.saltNonce), webAuthnSigner(passkey.x, passkey.y, base), session, base)
    const c2: AccountContext = { ...ctx, address: created.address, oneAuth: { sessionKey: key.sessionKey, capUsdc: key.capUsdc, remote: key.remote } }
    w.chain.deployed = true
    const r = await w.op.startOneAuth(c2)
    expect(r).toEqual({ state: 'waiting', code: 'BELOW_DEPLOY_MINIMUM' })
    expect((w.state as unknown as { oneAuthKeyBlocks?: Record<string, string> }).oneAuthKeyBlocks?.k).toBeDefined()
  })
})

describe('#356: the remote a V4 session may register is fixed with its key', () => {
  test('setup mode: the remote is given once with the key and never changes; a Safe naming another is refused', async () => {
    let k: Address = REMOTE
    const w = world(0n, { ...scoped, registry: base, remotePeers: keyPeer(async () => k) })
    const first = await w.op.oneAuthKey({ ...ctx, accountKey: 'k' })
    k = getAddress('0x000000000000000000000000000000000000beef')
    expect((await w.op.oneAuthKey({ ...ctx, accountKey: 'k' })).remote).toEqual(first.remote)
    const other = { domain: 15, sessionKey: k }
    const session = v4HomeSession({ sessionKey: first.sessionKey, deployment: D, capUsd: BigInt(first.capUsdc), generation: 1n, admit: [], remote: other, registry: base })
    const created = v4CreateSetup(ctx.owners as Address[], BigInt(ctx.saltNonce), webAuthnSigner(passkey.x, passkey.y, base), session, base)
    const c2: AccountContext = { ...ctx, address: created.address, oneAuth: { sessionKey: first.sessionKey, capUsdc: first.capUsdc, remote: other } }
    await expect(w.op.startOneAuth(c2)).rejects.toMatchObject({ code: 'REMOTE_KEY_UNKNOWN' })
  })

  test('a key given before #356 keeps its session (no remote in the answer, no peer call); that Safe is never run', async () => {
    let asked = 0
    const w = world(0n, { ...scoped, registry: base, remotePeers: keyPeer(async () => (asked++, REMOTE)) })
    const st = w.state as unknown as { oneAuthKeys?: Record<string, Hex> }
    st.oneAuthKeys = { k: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' }
    const key = await w.op.oneAuthKey({ ...ctx, accountKey: 'k' })
    expect('remote' in key).toBe(false)
    expect(asked).toBe(0)
    const session = v4HomeSession({ sessionKey: key.sessionKey, deployment: D, capUsd: BigInt(key.capUsdc), generation: 1n, admit: [], remote: undefined, registry: base })
    const created = v4CreateSetup(ctx.owners as Address[], BigInt(ctx.saltNonce), webAuthnSigner(passkey.x, passkey.y, base), session, base)
    const c2: AccountContext = { ...ctx, address: created.address, oneAuth: { sessionKey: key.sessionKey, capUsdc: key.capUsdc } }
    await expect(w.op.startOneAuth(c2)).rejects.toMatchObject({ code: 'ONE_AUTH_LEGACY_SESSION' })
  })

  test('a first key request whose remote cannot be resolved gives no key; the retry gives the key with its remote', async () => {
    let up = false
    const w = world(0n, { ...scoped, registry: base, remotePeers: keyPeer(async () => (up ? REMOTE : Promise.reject(new Error('down')))) })
    await expect(w.op.oneAuthKey({ ...ctx, accountKey: 'k' })).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
    const st = w.state as unknown as { oneAuthKeys?: Record<string, Hex>; oneAuthRemotes?: Record<string, unknown> }
    expect(st.oneAuthKeys?.k).toBeUndefined()
    expect(st.oneAuthRemotes?.k).toBeUndefined()
    up = true
    const key = await w.op.oneAuthKey({ ...ctx, accountKey: 'k' })
    expect(key.remote).toEqual({ domain: 15, sessionKey: REMOTE })
  })

  test('the Monad operator down: an account with a remote bucket waits (503); a Base-only one pins none and goes on', async () => {
    const w = world(0n, { ...scoped, registry: base, remotePeers: keyPeer(async () => Promise.reject(new Error('down'))) })
    const p = w.op as unknown as { v4RemoteBinding: (a: AccountState) => Promise<unknown>; v4PolicyOf: (a: unknown) => unknown }
    const acc = { accountKey: 'k', ctx, policyId: ONE_AUTH_V4 } as unknown as AccountState
    await expect(p.v4RemoteBinding(acc)).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
    p.v4PolicyOf = () => ({ ...oneAuthV4Live, remoteBuckets: [] })
    expect(await p.v4RemoteBinding(acc)).toBeNull()
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

describe('review of #202, round 2', () => {
  const designC = { chainId: 143, address: `0x${'9'.repeat(40)}`, spec: { chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: privateKeyToAccount(KEY).address, validAfter: 1, validUntil: 2, capUsdc: '1' }, permissionIds: ['0x01'] } as never
  const stub = (w: ReturnType<typeof world>, f: (fn: string, args?: readonly unknown[]) => unknown) => {
    const c = priv(w.op).client
    const real = c.readContract.bind(c)
    c.readContract = async (a) => {
      const v = f(a.functionName, a.args)
      return v === undefined ? real(a) : v
    }
  }

  test('Opus 1: C is V4\'s own (configOf), refreshed every tick; the late-receipt rebuild keeps the signed C', async () => {
    const w = world(0n, { ...scoped, remoteRegistry: () => pinned(monadRegistry) })
    const acc = onV4(w)
    acc.oneAuth = { capUsd: '1' }
    stub(w, (fn) => (fn === 'configOf' ? { set: true, capUsd: 999n } : fn === 'remoteOf' || fn === 'isReady' ? (() => { throw new Error('down') })() : undefined))
    await priv(w.op).tickOneAuth()
    expect(acc.oneAuth?.capUsd).toBe('999')
    // stash keeps v4CapUsd for a receipt read later
    const op = { opId: 'own-9-migrate-v4', kind: 'migrate-v4', state: 'proposed', updatedAt: '' }
    ;(w.op as unknown as { stash(a: AccountState, o: unknown, p: unknown): void }).stash(acc, op, { kind: 'migrate-v4', step: 0, v4CapUsd: '170000000', safeTxHash: '0x01', tx: { nonce: 3n } })
    expect((op as { v4CapUsd?: string }).v4CapUsd).toBe('170000000')
  })

  test('Opus 1: no Monad step before V4 registered the remote (typed, retryable)', async () => {
    const peer = { key: async () => privateKeyToAccount(KEY).address, provision: async () => ({ state: 'pending' as const, code: 'X' }), migrateV4: async () => ({}) }
    const w = world(0n, { ...scoped, remotePeers: { 143: peer } })
    onV4(w, { remote: designC })
    stub(w, (fn) => (fn === 'isPaused' ? false : fn === 'remoteOf' ? { remote: '0x0000000000000000000000000000000000000000', capUsd: 0n, ownersHash: `0x${'00'.repeat(32)}`, sessionKey: '0x0000000000000000000000000000000000000000' } : fn === 'isReady' ? false : undefined))
    const e = await w.op.prepareMigrateV4(ctx, { step: 1 }).catch((x) => x)
    expect((e as HttpError).code).toBe('ONE_AUTH_REMOTE_PENDING')
  })

  test('Opus 2: the engine holds while a migration is prepared or on its way; no prepare over an engine op still out', () => {
    const w = world(0n, scoped)
    const acc = onV4(w, { ops: [] as never })
    const hold = (w.op as unknown as { migrationHold(a: AccountState): boolean }).migrationHold.bind(w.op)
    expect(hold(acc)).toBe(false)
    priv(w.op).prepared.set('m', { prepareId: 'm', accountKey: 'k', kind: 'migrate-v4', expires: Date.now() + 60_000 })
    expect(hold(acc)).toBe(true)
    priv(w.op).prepared.delete('m')
    acc.ops.push({ opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: '', migrateStep: 0 } as never)
    expect(hold(acc)).toBe(true) // an unread receipt is still on its way (relayable)
    acc.ops = [{ opId: 'eng-1-1-op-1-enter_mint', kind: 'enter', state: 'submitted', updatedAt: '' } as never]
    expect(() => (w.op as unknown as { assertEngineSettled(a: AccountState): void }).assertEngineSettled(acc)).toThrow('finishing an operation')
  })

  test('Opus 3: a step 1 confirmed on Monad whose submit answer was lost is confirmed here (mirror op created)', async () => {
    const peer = { key: async () => privateKeyToAccount(KEY).address, provision: async () => ({ state: 'pending' as const, code: 'X' }), migrateV4: async (_c: AccountContext, phase: string) => (phase === 'status' ? { done: true, failed: false } : null) }
    const w = world(0n, { ...scoped, remotePeers: { 143: peer } })
    const acc = onV4(w, { remote: designC })
    stub(w, (fn) => (fn === 'configOf' ? (() => { throw new Error('down') })() : undefined))
    await priv(w.op).tickOneAuth()
    expect(acc.ops.filter((o) => o.kind === 'migrate-v4').map((o) => [o.migrateStep, o.state])).toEqual([[0, 'confirmed'], [1, 'confirmed']])
  })

  test('Opus 6: a registered remote the current keys no longer give, and not ready: registered again', async () => {
    const peer = { key: async () => privateKeyToAccount(KEY).address, provision: async () => ({ state: 'pending' as const, code: 'X' }) }
    const w = world(0n, { ...scoped, remotePeers: { 143: peer }, remoteRegistry: () => pinned(monadRegistry) })
    const acc = onV4(w)
    const registered: string[] = []
    ;(w.op as unknown as { registerRemoteV4: (a: AccountState, d: number, k: Address) => Promise<void> }).registerRemoteV4 = async (_a, _d, k) => void registered.push(k)
    stub(w, (fn) => (fn === 'configOf' ? { set: true, capUsd: 170_000_000n } : fn === 'remoteOf' ? { remote: `0x${'7'.repeat(40)}`, capUsd: 170_000_000n, ownersHash: `0x${'00'.repeat(32)}`, sessionKey: privateKeyToAccount(KEY).address } : fn === 'isReady' ? false : undefined))
    await priv(w.op).tickOneAuth()
    expect(registered).toEqual([privateKeyToAccount(KEY).address])
    await priv(w.op).tickOneAuth() // rate-limited
    expect(registered.length).toBe(1)
    void acc
  })

  test('Argon 3: on Monad a submit is checked against a step-1 prepare of this account before anything else', async () => {
    const homeClient = { readContract: async () => { throw new Error('must not read the home before the prepare check') } }
    const w = world(0n, { ...scoped, chainId: 143, homeClient: homeClient as never })
    const c143 = { ...ctx, chainId: 143 }
    priv(w.op).prepared.set('p0', { prepareId: 'p0', accountKey: 'k', kind: 'migrate-v4', step: 0, home: ctx.address, expires: Date.now() + 60_000, safeTxHash: '0x01', tx: { nonce: 0n } })
    for (const body of [{ prepareId: 'p0', step: 1 }, { prepareId: 'nope', step: 1 }, { prepareId: 'p0' }]) {
      const e = await w.op.submitMigrateV4(c143, { authenticatorData: '', clientDataJSON: '', signature: '', ...body } as never).catch((x) => x)
      expect((e as HttpError).code).toBe('ONE_AUTH_STEP_MISMATCH')
    }
  })

  test('Argon 3: on Base a submit without `step` is step 1 once step 0 is done (not ONE_AUTH_DONE)', () => {
    const w = world(0n, scoped)
    const acc = onV4(w)
    const step = (w.op as unknown as { submitStep(b: unknown, a?: AccountState): number }).submitStep.bind(w.op)
    expect(step({ prepareId: 'x' }, acc)).toBe(1)
    expect(step({ prepareId: 'x', step: 0 }, acc)).toBe(0)
  })
})

describe('review of #247 (P1): after a restart, a held pool V4 no longer finds eligible keeps its exit', () => {
  test('the fresh operator reads the held position from the chain and runs its pool as exit-only', async () => {
    const BTC = 'pool:USDC/cbBTC/500'
    const btc = staticPool(BTC, baseRegistry)
    const w = world(0n, scoped)
    const acc = onV4(w, { admittedTokenIds: ['7'] })
    poolsAre(w, [pool('pool:WETH/USDC/3000')]) // cbBTC/USDC not eligible now
    const before = priv(w.op).v4Engine(acc)
    expect(before.policy.buckets.flatMap((b) => b.pools)).not.toContain(BTC)
    const NPM = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1'
    const helper = (await import('@mamoru/account/one-auth')).v4Children(D.policy).helper
    const c = priv(w.op).client
    const real = c.readContract.bind(c)
    c.readContract = async (a) => {
      if (a.functionName === 'chain') return { chainId: 8453n, factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', npm: NPM }
      if (a.functionName === 'getPool') return btc.address
      if (a.functionName === 'aggregate3') {
        return (a.args![0] as { target: string; callData: Hex }[]).map((x) => {
          if (x.target === NPM && x.callData.startsWith('0x6352211e')) return { success: true, returnData: encodeAbiParameters([{ type: 'address' }], [ctx.address]) }
          if (x.target === NPM) return { success: true, returnData: encodeFunctionResult({ abi: parseAbi(['function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)']), functionName: 'positions', result: [0n, ctx.address, btc.token0, btc.token1, 500, -10, 10, 5_000n, 0n, 0n, 0n, 0n] }) }
          if (x.target === helper) return { success: true, returnData: encodeFunctionResult({ abi: parseAbi(['struct E { uint32 a; uint32 b; uint24 c; int24 d; uint24 e; uint16 f; bool g; }', 'function exitEntry(address) view returns (E)']), functionName: 'exitEntry', result: { a: 1800, b: 300, c: 120, d: 0, e: 0, f: 1500, g: false } }) }
          return { success: true, returnData: encodeAbiParameters([{ type: 'int24' }], [10]) }
        })
      }
      return real(a)
    }
    const keyBefore = priv(w.op).v4PoolsFor(acc)!.key
    await priv(w.op).refreshV4Held(acc)
    expect(priv(w.op).v4PoolsFor(acc)!.key).not.toBe(keyBefore) // the loop restarts on it before its first review
    const after = priv(w.op).v4Engine(acc) as unknown as { policy: { buckets: { id: string; pools: string[]; preference: number }[]; session: { grants: { pool?: string; actions: unknown[] }[] }; actionPolicy: { bandTicksByPool: Record<string, number> } }; sessions: { name: string }[] }
    expect(after.policy.buckets.find((b) => b.id === 'exit-only')).toMatchObject({ preference: 0, pools: [BTC] })
    expect(after.policy.session.grants.find((g) => g.pool === BTC)!.actions).toEqual([]) // no increase: exits only
    expect(after.policy.actionPolicy.bandTicksByPool[BTC]).toBe(120) // V4's exit entry
    expect(after.sessions.map((x) => x.name)).toContain(`manage-any:${BTC}`)
  })
})

describe('review of #247 (P2): lane-1 session ops (registerRemote now, announceReady next)', () => {
  type Lane1 = { sendV4SessionOp(a: AccountState, i: unknown[]): Promise<Hex | null>; lane1Bundler: () => { sendUserOperation: (op: { callData: Hex; nonce: bigint }) => Promise<Hex> } }
  function setup(revert = false) {
    const w = world(0n, scoped)
    const acc = onV4(w)
    const sent: { callData: Hex; nonce: bigint }[] = []
    let t = 1_800_000_000n
    let chainNonce = 0n
    const c = priv(w.op).client as unknown as Record<string, unknown>
    const real = (c.readContract as (a: unknown) => Promise<unknown>).bind(c)
    c.getBlock = async () => ({ number: 500n, timestamp: t, baseFeePerGas: 5_000_000n, hash: `0x${'aa'.repeat(32)}` })
    c.readContract = async (a: { functionName: string }) => (a.functionName === 'getNonce' ? chainNonce : real(a))
    c.call = async () => {
      if (revert) throw new Error('execution reverted: RemoteNotReady(15)')
      return { data: '0x' }
    }
    ;(w.op as unknown as Lane1).lane1Bundler = () => ({ sendUserOperation: async (op) => (sent.push(op), `0x${'bb'.repeat(32)}` as Hex) })
    const send = () => (w.op as unknown as Lane1).sendV4SessionOp(acc, [{ kind: 'registerRemote', domain: 15, sessionKey: privateKeyToAccount(KEY).address }])
    return { send, sent, advance: (s: bigint) => (t += s), spend: () => chainNonce++ }
  }

  test('two senders at once never sign the same nonce; the next one waits for the nonce or the window to pass', async () => {
    const s = setup()
    const [a, b] = await Promise.all([s.send(), s.send()])
    expect([a, b].filter((x) => x !== null)).toHaveLength(1)
    expect(s.sent).toHaveLength(1)
    expect(await s.send()).toBeNull() // nonce 0 unspent, its window open
    s.spend()
    expect(await s.send()).not.toBeNull() // the first landed: nonce 1
    expect(s.sent.map((o) => o.nonce)).toEqual([0n, 1n])
    s.advance(301n)
    expect(await s.send()).not.toBeNull() // nonce 1 never landed and its window closed: it can be signed again
  })

  test('an op that would revert after validating is never signed', async () => {
    const s = setup(true)
    expect(await s.send()).toBeNull()
    expect(s.sent).toHaveLength(0)
  })
})

describe('review r1 of #253 (P1-2): a lane-1 op is on disk before it is sent; the ledger survives a restart', () => {
  type SentOp = { userOpHash: Hex; fromBlock: string; t: string }
  type Lane1At = { sendV4SessionOpAt(a: AccountState, i: unknown[], onSigned?: (op: SentOp) => Promise<void> | void): Promise<{ op: SentOp } | { wait: string } | { fault: string }>; lane1Bundler: () => { sendUserOperation: (op: unknown) => Promise<Hex> } }
  function setup(o: { revert?: boolean; baseFee?: bigint } = {}) {
    const w = world(0n, scoped)
    const acc = onV4(w)
    const c = priv(w.op).client as unknown as Record<string, unknown>
    const real = (c.readContract as (a: unknown) => Promise<unknown>).bind(c)
    c.getBlock = async () => ({ number: 500n, timestamp: 1_800_000_000n, baseFeePerGas: o.baseFee ?? 5_000_000n, hash: `0x${'aa'.repeat(32)}` })
    c.readContract = async (a: { functionName: string }) => (a.functionName === 'getNonce' ? 0n : real(a))
    c.call = async () => {
      if (o.revert) throw new Error('execution reverted: BadMessage(5)')
      return { data: '0x' }
    }
    return { w, acc, lane1: w.op as unknown as Lane1At }
  }
  const intents = [{ kind: 'relayMessage', message: `0x${'01'.repeat(244)}`, attestation: `0x${'02'.repeat(65)}` }]

  test('the ledger and the caller\'s write happen before the bundler sees the op; a bundler that throws after is the op sent', async () => {
    const { acc, lane1 } = setup()
    const log: string[] = []
    lane1.lane1Bundler = () => ({
      sendUserOperation: async () => {
        log.push(`bundler (ledger nonce ${acc.lane1Open?.nonce})`)
        throw new Error('bundler timed out')
      },
    })
    const r = await lane1.sendV4SessionOpAt(acc, intents, (op) => void log.push(`persist ${op.userOpHash.slice(0, 6)}`))
    expect('op' in r).toBe(true)
    expect(log).toEqual([`persist ${(r as { op: SentOp }).op.userOpHash.slice(0, 6)}`, 'bundler (ledger nonce 0)'])
    expect(acc.lane1Open?.nonce).toBe('0')
  })

  test('after a restart (a new operator on the same state) the open op still holds lane 1: nothing signed beside it', async () => {
    const a = setup()
    let sent = 0
    a.lane1.lane1Bundler = () => ({ sendUserOperation: async () => (sent++, `0x${'bb'.repeat(32)}` as Hex) })
    expect('op' in (await a.lane1.sendV4SessionOpAt(a.acc, intents))).toBe(true)
    const b = setup()
    b.w.state.accounts.k = JSON.parse(JSON.stringify(a.acc)) as AccountState
    b.lane1.lane1Bundler = () => ({ sendUserOperation: async () => (sent++, `0x${'bb'.repeat(32)}` as Hex) })
    const r = await b.lane1.sendV4SessionOpAt(b.w.state.accounts.k!, intents)
    expect(r).toEqual({ wait: 'lane-1 op with nonce 0 still open' })
    expect(sent).toBe(1)
  })

  test('P1-1: the simulation refusing it is a fault; gas over the ceiling is a wait; neither signs anything', async () => {
    const f = setup({ revert: true })
    f.lane1.lane1Bundler = () => ({ sendUserOperation: async () => { throw new Error('never') } })
    const r = await f.lane1.sendV4SessionOpAt(f.acc, intents)
    expect('fault' in r).toBe(true)
    expect(f.acc.lane1Open).toBeUndefined()
    const g = setup({ baseFee: 10n ** 12n })
    expect(await g.lane1.sendV4SessionOpAt(g.acc, intents)).toEqual({ wait: 'gas over the ceiling' })
  })
})
