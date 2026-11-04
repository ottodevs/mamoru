// otto/mamoru#210: conservador-live-v7 on the Base operator. The renew row offers it behind its own scoped flag `vaults_v7`,
// never in the default offer. One approval is ONE owner transaction: v6's grants on MamoruActionPolicyV3 plus one
// vault-family session per vault, also on V3 alone (no pause gate, no UniActionPolicy). v6 is not touched.
// Fake deployed addresses; V3 and the gate are the registry pins withPinnedV6Base() gives.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, pad, parseAbi, slice, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address } from '@mamoru/domain'
import { address as registryAddress, baseRegistry, smartSessionAbi } from '@mamoru/registry'
import { encodeVaultFamilyInit, grantKey } from '@mamoru/policy'
import { remoteInput, remoteSafe } from '@mamoru/account/remote'
import { resolveV4Policy, resolveV5Policy, resolveV6Policy, resolveV7Policy } from '../src/boot.ts'
import { HttpError, upgradeSplitOf, type Operator, type OperatorConfig } from '../src/operator.ts'
import type { RemoteProvision } from '../src/remote-peer.ts'
import type { AccountState, StoredGrant } from '../src/state.ts'
import { FIXTURE_SESSION_KEY, GATE_V3_BASE_PINNED, V3_BASE_PINNED, withPinnedV3, withPinnedV6Base } from '../../../packages/account/remote/fixture.ts'
import { ctx, quiet, sign, world } from './owner-world.ts'

const V1 = `0x${'11'.repeat(20)}`
const GAS = `0x${'22'.repeat(20)}`
const V2 = `0x${'33'.repeat(20)}`
const env = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: V1, MAMORU_ACTION_POLICY_V2_ADDRESS: V2, MAMORU_GAS_POLICY_ADDRESS: GAS }
const reg6 = withPinnedV6Base()
const V3 = V3_BASE_PINNED.toLowerCase()
const GATE = GATE_V3_BASE_PINNED.toLowerCase()
const UNI = registryAddress('UniActionPolicy', baseRegistry).toLowerCase()
const v4 = resolveV4Policy('base', env)!
const v5 = resolveV5Policy('base', env)!
const v6 = resolveV6Policy('base', env, reg6)!
const v7 = resolveV7Policy('base', env, reg6)!

type Privates = { settleRenewals(a: AccountState): Promise<void>; assertRenewable(a: AccountState): void; readOf(a: AccountState, safe: Hex): Promise<{ block: bigint }>; prepared: Map<string, { grants?: StoredGrant[]; revokes?: Hex[]; extend?: boolean; tx: { to: string; data: Hex } }>; client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown> }; inScope(a: AccountState, f: string): boolean }
const priv = (op: Operator) => op as unknown as Privates

function unpack(data: Hex): { to: string; data: Hex }[] {
  const packed = decodeFunctionData({ abi: parseAbi(['function multiSend(bytes transactions)']), data }).args[0] as Hex
  const out: { to: string; data: Hex }[] = []
  let at = 0
  const len = (packed.length - 2) / 2
  while (at < len) {
    const to = slice(packed, at + 1, at + 21)
    const n = Number(BigInt(slice(packed, at + 53, at + 85)))
    out.push({ to, data: slice(packed, at + 85, at + 85 + n) })
    at += 85 + n
  }
  return out
}

function sessionsOf(tx: { to: string; data: Hex }) {
  const smartSession = registryAddress('SmartSession', baseRegistry).toLowerCase()
  const calls = tx.data.startsWith('0x8d80ff0a') ? unpack(tx.data) : [tx]
  const enable = calls.filter((c) => c.to.toLowerCase() === smartSession).map((c) => decodeFunctionData({ abi: smartSessionAbi, data: c.data })).filter((d) => d.functionName === 'enableSessions')
  expect(enable).toHaveLength(1)
  const sessions = enable[0]!.args![0] as unknown as { userOpPolicies: { policy: string }[]; actions: { actionTarget: string; actionPolicies: { policy: string; initData: Hex }[] }[] }[]
  return sessions.map((s) => ({
    userOp: new Set(s.userOpPolicies.map((p) => p.policy.toLowerCase())),
    perAction: s.actions.map((a) => a.actionPolicies.map((p) => p.policy.toLowerCase())),
    inits: s.actions.map((a) => a.actionPolicies.map((p) => p.initData)),
    targets: s.actions.map((a) => a.actionTarget.toLowerCase()),
    action: new Set(s.actions.flatMap((a) => a.actionPolicies.map((p) => p.policy.toLowerCase()))),
  }))
}

const UID = `0x${'ab'.repeat(32)}`
function chain(w: ReturnType<typeof world>, generation: bigint) {
  const client = priv(w.op).client
  const base = client.readContract.bind(client)
  client.readContract = async (a) => {
    if (a.functionName === 'findModule') return { resolverUID: UID, sender: `0x${'01'.repeat(20)}` }
    if (a.functionName === 'findAttestation') return { time: 0, expirationTime: 0, revocationTime: 0, attester: `0x${'00'.repeat(20)}` }
    if (a.functionName === 'generationOf') return generation
    if (a.functionName === 'configOf') return { generation }
    if (a.functionName === 'isPaused') return false
    return base(a)
  }
}

function running(w: ReturnType<typeof world>, policy = v6): AccountState {
  const grants = policy.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ name: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(64, '0')}`, grant: { policyId: policy.policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } }))
  const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: policy.policyId, grants, ops: [], revoked: [] } as unknown as AccountState
  w.state.accounts.k = acc
  return acc
}

function ready(w: ReturnType<typeof world>): void {
  const p = priv(w.op)
  ;(p as unknown as { settleRenewals: () => Promise<void> }).settleRenewals = async () => {}
  ;(p as unknown as { assertRenewable: () => void }).assertRenewable = () => {}
  ;(p as unknown as { readOf: () => Promise<unknown> }).readOf = async () => ({ block: 100n, deployed: false, usdc: 0n, eth: 0n })
}

const SESSION_KEY = privateKeyToAccount(FIXTURE_SESSION_KEY).address
const pinnedV3 = withPinnedV3()
function fakePeer() {
  const keyAsked: AccountContext[] = []
  return {
    keyAsked,
    peer: {
      key: async (c: AccountContext): Promise<Address> => {
        keyAsked.push(c)
        return SESSION_KEY
      },
      provision: async (c: AccountContext): Promise<RemoteProvision> => ({ state: 'active', address: c.address as Address }),
    },
  }
}

type Flags = Record<string, boolean>
type Scoped = Record<string, string[] | null>
const cfg7 = (flags: Flags, scoped: Scoped, extra: Partial<OperatorConfig> = {}): Partial<OperatorConfig> => ({
  registry: reg6,
  v4Policy: v4,
  v5Policy: v5,
  v6Policy: v6,
  v7Policy: v7,
  opsFlags: () => flags,
  opsScopedFlags: () => scoped,
  remoteRegistry: () => pinnedV3,
  ...extra,
})

describe('boot wiring', () => {
  test('v7 runs on v6\'s contracts: V3 (contractVersion 3), the registry gate, the gas policy', () => {
    expect(v7.policyId).toBe('conservador-live-v7')
    expect(v7.actionPolicy).toMatchObject({ address: V3_BASE_PINNED, contractVersion: 3, gasPolicy: { address: GAS } })
    expect(v7.actionPolicy!.pauseGate!.toLowerCase()).toBe(GATE)
    expect(v7.buckets.find((b) => b.id === 'stables')!.vaults).toEqual(['vault:gtUSDCp', 'vault:waBasUSDC'])
  })

  test('not configured where v6 is not (V3 not pinned, or no v4 opt-in)', () => {
    const unpinned = { ...baseRegistry, entries: baseRegistry.entries.filter((e) => e.name !== 'MamoruActionPolicyV3') }
    expect(resolveV7Policy('base', env, unpinned)).toBeUndefined()
    expect(resolveV7Policy('base', { ...env, MAMORU_ONCHAIN_POLICY_V4: undefined }, reg6)).toBeUndefined()
    expect(resolveV7Policy('monad', env, reg6)).toBeUndefined()
  })
})

describe('the renew row offers v7 only behind vaults_v7 (scoped, #217 rules)', () => {
  const target = (flags: Flags, scoped: Scoped, from = v6) => {
    const w = world(0n, cfg7(flags, scoped))
    return w.op.renewTarget(running(w, from))
  }

  test('everyone (null): v5 and v6 accounts move to v7, ahead of v6', () => {
    expect(target({ vaults_v7: true }, { vaults_v7: null })).toBe('conservador-live-v7')
    expect(target({ vaults_v7: true, multichain_v6: true }, { vaults_v7: null, multichain_v6: null }, v5)).toBe('conservador-live-v7')
  })

  test('list: the account key or the Safe address gets v7; anyone else keeps what it had', () => {
    expect(target({}, { vaults_v7: ['k'] })).toBe('conservador-live-v7')
    expect(target({}, { vaults_v7: [String(ctx.address).toLowerCase()] })).toBe('conservador-live-v7')
    expect(target({}, { vaults_v7: ['other'] })).toBe('conservador-live-v6')
    expect(target({ multichain_v6: true }, { vaults_v7: ['other'], multichain_v6: null }, v5)).toBe('conservador-live-v6')
  })

  test('off, malformed, or an old Worker without scopes: never offered', () => {
    expect(target({}, {})).toBe('conservador-live-v6')
    expect(target({}, { vaults_v7: [] })).toBe('conservador-live-v6')
    expect(target({ vaults_v7: true }, {})).toBe('conservador-live-v6')
  })

  test('v7 not configured: never offered, flag or not; v6 offers stay exactly as before', () => {
    const w = world(0n, { ...cfg7({ vaults_v7: true, multichain_v6: true }, { vaults_v7: null, multichain_v6: null }), v7Policy: undefined })
    expect(w.op.renewTarget(running(w, v5))).toBe('conservador-live-v6')
  })

  test('an account already on v7 renews as v7', () => {
    expect(target({}, {}, v7)).toBe('conservador-live-v7')
  })

  test('upgradeSplit v6 -> v7: the same mix, USDC/USDT now at 0 (exit only)', () => {
    expect(upgradeSplitOf(v6, v7)).toEqual({
      from: [{ bucket: 'stables', bps: 5000 }, { bucket: 'risk', bps: 3500 }, { bucket: 'growth', bps: 1500 }],
      to: [{ bucket: 'stables', chainId: 8453, bps: 5000 }, { bucket: 'risk', chainId: 8453, bps: 3500 }, { bucket: 'stables-lp', chainId: 8453, bps: 0 }, { bucket: 'btc-usdc', chainId: 8453, bps: 0 }, { bucket: 'growth', chainId: 143, bps: 1500 }],
    })
  })
})

describe('the opt-in exit of USDC/USDT reads stables_lp_exit per account', () => {
  test('off by default; on for the accounts in scope only', () => {
    const scope = (s: Scoped, f: Flags = {}) => {
      const w = world(0n, cfg7(f, s))
      return priv(w.op).inScope(running(w, v7), 'stables_lp_exit')
    }
    expect(scope({})).toBe(false)
    expect(scope({ stables_lp_exit: [] })).toBe(false)
    expect(scope({ stables_lp_exit: ['other'] })).toBe(false)
    expect(scope({ stables_lp_exit: ['k'] })).toBe(true)
    expect(scope({ stables_lp_exit: null }, { stables_lp_exit: true, yield_fee: false })).toBe(true)
  })
})

describe('owner transaction of the move to v7', () => {
  test('v6 -> v7: ONE owner transaction; V3 alone on the vault sessions (vault-family Init), v6\'s policies on the rest', async () => {
    const p = fakePeer()
    const w = world(0n, cfg7({}, { vaults_v7: ['k'] }, { remotePeers: { 143: p.peer } }))
    const a = running(w, v6)
    ready(w)
    chain(w, 7n)
    const t = await w.op.prepareRenew(ctx)
    expect(t.policyId).toBe('conservador-live-v7')
    expect(t.move).toBe(true)
    const held = priv(w.op).prepared.get(t.prepareId)!
    const names = held.grants!.map((g) => g.name)
    expect(names.sort()).toEqual(['bridge-out', 'manage-any:pool:USDC/USDT/100', 'manage-any:pool:USDC/cbBTC/500', 'manage-any:pool:WETH/USDC/3000', 'vault-supply:vault:gtUSDCp', 'vault-supply:vault:waBasUSDC'])
    expect(held.extend).toBeUndefined()
    const sessions = sessionsOf(held.tx)
    expect(sessions).toHaveLength(names.length)
    const byName = new Map(held.grants!.map((g, i) => [g.name, sessions[i]!]))
    for (const v of ['vault:gtUSDCp', 'vault:waBasUSDC']) {
      const s = byName.get(`vault-supply:${v}`)!
      expect(s.userOp.has(GAS)).toBe(true)
      expect(s.targets).toEqual([registryAddress('USDC', baseRegistry), registryAddress(v, baseRegistry), registryAddress(v, baseRegistry)].map((x) => x.toLowerCase()))
      for (const policies of s.perAction) expect(policies).toEqual([V3])
      // generation of V3 + 1, the vault family
      for (const inits of s.inits) expect(inits).toEqual([encodeVaultFamilyInit(8n)])
    }
    expect(byName.get('bridge-out')!.action).toEqual(new Set([UNI, GATE]))
    for (const policies of byName.get('manage-any:pool:WETH/USDC/3000')!.perAction) expect(policies).toEqual([V3])
    // USDC/USDT exit on V3 alone; v6's cbBTC exit keeps UniActionPolicy beside V3.
    for (const policies of byName.get('manage-any:pool:USDC/USDT/100')!.perAction) expect(policies).toEqual([V3])
    for (const policies of byName.get('manage-any:pool:USDC/cbBTC/500')!.perAction) expect(policies).toEqual([UNI, V3])
    // The v6 sessions are revoked in the same transaction.
    expect(held.revokes!.length).toBe(a.grants.length)
    const text = t.summary.join('\n')
    expect(text).toContain('Lending: it may supply USDC to')
    expect(text).toContain('nothing new goes into USDC/USDT')
    expect(t.remote!.address).toBe(remoteSafe(remoteInput(ctx, t.remote!.spec, pinnedV3)).address)
  })
})

describe('otto/mamoru#368: a Start activates on v7 wherever v7 is offered', () => {
  /** A Base operator whose default policy is v5, offering v6 and v7; what a Start of a fresh account `k` prepares. */
  async function start(flags: Flags, scoped: Scoped, extra: Partial<OperatorConfig> = {}) {
    const p = fakePeer()
    const w = world(0n, { policy: v5, ...cfg7(flags, scoped, { remotePeers: { 143: p.peer }, ...extra }) })
    w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
    chain(w, 0n)
    const t = await w.op.prepareActivate(ctx)
    const held = priv(w.op).prepared.get(t.prepareId)!
    return { t, held, names: held.grants!.map((g) => g.name), policyIds: new Set(held.grants!.map((g) => g.grant.policyId)), peer: p }
  }

  test('vaults_v7 for everyone: the Start is v7 in ONE approval (vaults, bridge-out to its own Safe on Monad), nothing left for a second one', async () => {
    const r = await start({ vaults_v7: true }, { vaults_v7: null })
    expect(r.policyIds).toEqual(new Set([v7.policyId]))
    expect(r.names).toContain('bridge-out')
    expect(r.names.some((n) => n.includes('vault:gtUSDCp'))).toBe(true)
    expect(r.t.remote).toBeDefined()
    const want = v7.session.grants.filter((g) => !g.perPosition).map(grantKey).sort()
    expect([...r.names].sort()).toEqual(want)
    // Review r1: the remote Safe is the one these keys, the Monad session key and the spec give, and bridge-out mints
    // only to it, in the very transaction the owner signs.
    const remote = r.t.remote!
    expect(remote.spec).toMatchObject({ chainId: 143, sessionKey: SESSION_KEY })
    expect(remote.address).toBe(remoteSafe(remoteInput(ctx, remote.spec, pinnedV3)).address)
    const burn = r.held.grants!.find((g) => g.name === 'bridge-out')!.grant.actions.find((a) => a.params.some((x) => x.field === 'mintRecipient'))!
    expect(burn.params.find((x) => x.field === 'mintRecipient')).toMatchObject({ condition: 'EQUAL', ref: BigInt(remote.address) })
    expect(r.held.tx.data.toLowerCase()).toContain(pad(remote.address, { size: 32 }).slice(2).toLowerCase())
    expect(r.t.summary.join('\n')).toContain(remote.address)
  })

  test('review r1: armed for its deposit, it fires as the v7 the owner signed even after vaults_v7 is narrowed, and stays v7', async () => {
    let scoped: Scoped = { vaults_v7: null }
    const p = fakePeer()
    const w = world(0n, { policy: v5, ...cfg7({ vaults_v7: true }, {}, { remotePeers: { 143: p.peer }, opsScopedFlags: () => scoped }) })
    w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
    chain(w, 0n)
    const t = await w.op.prepareActivate(ctx)
    expect(await w.op.submit(ctx, 'activate', sign(t))).toMatchObject({ code: 'ARMED' })
    const acc = w.state.accounts.k!
    expect(acc.armed?.remote).toMatchObject({ address: t.remote!.address })
    scoped = { vaults_v7: ['someone-else'] }
    w.chain.usdc = 10_000_000n
    await quiet(() => (w.op as unknown as { fireArmed(a: AccountState, u: bigint): Promise<void> }).fireArmed(acc, 10_000_000n))
    await new Promise((r) => setTimeout(r, 10))
    expect(acc.active).toBe(true)
    expect(acc.policyId).toBe(v7.policyId)
    expect(acc.remote).toMatchObject({ chainId: 143, address: t.remote!.address })
    // Its own policy decides from now on: v7, never the default, and nothing left to move to.
    expect(w.op.policyOf(acc).policyId).toBe(v7.policyId)
    expect(w.op.v4Target(acc)).toBeNull()
  })

  test('review r1: no Monad operator reachable: the v7 Start is refused (503), never quietly started on another policy', async () => {
    const w = world(0n, { policy: v5, ...cfg7({ vaults_v7: true }, { vaults_v7: null }) })
    w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
    chain(w, 0n)
    const e = await w.op.prepareActivate(ctx).catch((x: unknown) => x)
    expect(e instanceof HttpError && e.code).toBe('REMOTE_UNAVAILABLE')
  })

  test('in scope by account key: v7, ahead of a v6 new-account scope; out of scope: v6 by its own scope, else the default', async () => {
    expect((await start({}, { vaults_v7: ['k'], multichain_v6_new: ['k'] })).policyIds).toEqual(new Set([v7.policyId]))
    expect((await start({}, { vaults_v7: ['someone-else'], multichain_v6_new: ['k'] })).policyIds).toEqual(new Set([v6.policyId]))
    expect((await start({ vaults_v7: true }, {})).policyIds).toEqual(new Set([v5.policyId]))
  })

  test('v7 not configured: exactly as before', async () => {
    expect((await start({ vaults_v7: true }, { vaults_v7: null }, { v7Policy: undefined })).policyIds).toEqual(new Set([v5.policyId]))
  })
})
