// otto/mamoru#456: RPC requests of one simulated hour per account on the fake chain (owner-world.ts), per loop the
// issue cut: the chain usage counters (read from every 5-min review of a V3 account), the armed watcher on a Safe nobody
// opened in days (one Multicall3 per due pass, shared by every armed Safe of the pass), and tickOneAuth on a settled V4
// home. The clock is moved by hand; every method of the fake client is counted. Run: bun test/rpc-spend-bench.ts
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { baseRegistry, monadRegistry, type Registry } from '@mamoru/registry'
import { ONE_AUTH_V4, v4CapUsdOf, type OneAuthV4Deployment } from '@mamoru/policy'
import { v4StoredGrant } from '../src/one-auth.ts'
import type { AccountState } from '../src/state.ts'
import { ctx, sign, world } from './owner-world.ts'

const realNow = Date.now
let now = realNow()
Date.now = () => now
const MIN = 60_000

/** Counts every call of every method of `client` (the operator's fake client), by method name. */
function counting(op: unknown): () => number {
  const client = (op as { client: Record<string, unknown> }).client
  let n = 0
  for (const [k, v] of Object.entries(client)) if (typeof v === 'function') client[k] = (...a: unknown[]) => (n++, (v as (...x: unknown[]) => unknown).apply(client, a))
  return () => n
}

async function usage(): Promise<number> {
  const w = world(20_000_000n)
  ;(w.op as unknown as { startLoop: () => void }).startLoop = () => {}
  await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
  const acc = w.state.accounts.k!
  const u = w.op as unknown as { refreshChainUsage(a: AccountState): Promise<void> }
  await u.refreshChainUsage(acc)
  const reads = counting(w.op)
  // One review every 5 min for an hour, each asking for the counters (bridgeLimitFor does on every V3 review).
  for (let t = 0; t < 12; t++) {
    now += 5 * MIN
    await u.refreshChainUsage(acc)
  }
  return reads()
}

async function armed(): Promise<number> {
  const w = world(0n)
  const op = await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
  w.state.accounts.k!.ops.find((o) => o.opId === op.opId)!.updatedAt = new Date(now - 3 * 86_400_000).toISOString()
  const a = w.op as unknown as { checkArmed(): Promise<void>; armStopped: boolean }
  a.armStopped = false
  await a.checkArmed()
  const reads = counting(w.op)
  // ARM_WATCH_MS passes for an hour.
  for (let t = 0; t < 240; t++) {
    now += 15_000
    await a.checkArmed()
  }
  return reads()
}

async function oneAuth(): Promise<number> {
  const D: OneAuthV4Deployment = { table: '0x00000000000000000000000000000000000000a1', policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3', migrationCheck: '0x00000000000000000000000000000000000000a4' }
  const KEY = `0x${'5'.repeat(64)}` as Hex
  const pinned = (r: Registry): Registry => {
    const names = ['MamoruV4Table', 'MamoruActionPolicyV4', 'MamoruGasPolicyV2', 'MamoruMigrationCheck'] as const
    const at = [D.table, D.policy, D.gasPolicy, D.migrationCheck]
    return { ...r, undeployed: [], entries: [...r.entries.filter((e) => !(names as readonly string[]).includes(e.name)), ...names.map((name, i) => ({ name, kind: 'smart-sessions-policy', role: 'test', address: at[i]!, codeHash: null }) as never)] }
  }
  const peer = { key: async () => privateKeyToAccount(KEY).address, provision: async () => ({ state: 'pending' as const, code: 'X' }) }
  const w = world(0n, { oneAuth: D, opsFlags: () => ({}), opsScopedFlags: () => ({ one_auth_v4: ['k'] }), remoteRegistry: () => pinned(monadRegistry), remotePeers: { 143: peer } } as never)
  const g = v4StoredGrant({ account: ctx.address, chainId: 8453, sessionKey: privateKeyToAccount(KEY).address, permissionId: `0x${'ee'.repeat(32)}`, salt: `0x${'00'.repeat(32)}`, deployment: D, registry: baseRegistry })
  const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: ONE_AUTH_V4, sessionKey: KEY, grants: [{ name: 'one-auth-v4', grant: g, permissionId: `0x${'ee'.repeat(32)}` }], ops: [{ opId: 'own-1-migrate-v4', kind: 'migrate-v4', state: 'confirmed', updatedAt: '', migrateStep: 0 }], revoked: [], managedTokenIds: [], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 1, oneAuth: { capUsd: v4CapUsdOf(100_000_000n).toString() } } as unknown as AccountState
  w.state.accounts.k = acc
  const target = (w.op as unknown as { v4RemoteTarget(a: AccountState, k: Address, c: bigint): { address: Address } }).v4RemoteTarget(acc, privateKeyToAccount(KEY).address, v4CapUsdOf(100_000_000n))
  const c = (w.op as unknown as { client: { readContract: (a: { functionName: string }) => Promise<unknown> } }).client
  const real = c.readContract.bind(c)
  c.readContract = async (a) => (a.functionName === 'configOf' ? { set: true, capUsd: v4CapUsdOf(100_000_000n) } : a.functionName === 'remoteOf' ? { remote: target.address, capUsd: v4CapUsdOf(100_000_000n), ownersHash: `0x${'00'.repeat(32)}`, sessionKey: privateKeyToAccount(KEY).address } : a.functionName === 'isReady' ? true : real(a))
  const t = w.op as unknown as { tickOneAuth(): Promise<void> }
  await t.tickOneAuth()
  const reads = counting(w.op)
  for (let i = 0; i < 60; i++) {
    now += MIN
    await t.tickOneAuth()
  }
  return reads()
}

const out = { usagePerAccountHour: await usage(), armedStalePassesPerHour: await armed(), oneAuthSettledPerAccountHour: await oneAuth() }
Date.now = realNow
console.log(JSON.stringify(out))
process.exit(0)
