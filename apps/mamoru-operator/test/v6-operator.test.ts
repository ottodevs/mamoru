// otto/mamoru#251: conservador-live-v6 on the Base operator. The renew row offers it behind `multichain_v6`. One approval is
// ONE owner transaction: every Uniswap grant has MamoruActionPolicyV3 as its only action policy (one manage-any per pool,
// cbBTC exit-only), bridge-out has UniActionPolicy + MamoruPauseGate and mints only to the account's own Safe on Monad,
// which the Base operator derives from the Monad operator's session key (remoteFor) and provisions once the approval lands.
// Fake deployed addresses; V3 and the gate are the registry pins withPinnedV6Base() gives.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, getAddress, pad, parseAbi, slice, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address } from '@mamoru/domain'
import { address as registryAddress, baseRegistry, smartSessionAbi } from '@mamoru/registry'
import { V4_TX_GAS_TARGET, conservadorLiveV5, conservadorLiveV6, grantKey, orderV4Keys, splitV4Keys } from '@mamoru/policy'
import { remoteInput, remoteSafe } from '@mamoru/account/remote'
import { resolveV4Policy, resolveV5Policy, resolveV6Policy } from '../src/boot.ts'
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

type Privates = { settleRenewals(a: AccountState): Promise<void>; assertRenewable(a: AccountState): void; readOf(a: AccountState, safe: Hex): Promise<{ block: bigint }>; prepared: Map<string, { grants?: StoredGrant[]; revokes?: Hex[]; extend?: boolean; tx: { to: string; data: Hex } }>; client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown> } }
const priv = (op: Operator) => op as unknown as Privates

/** MultiSend (packed) -> its calls. */
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

/** Every session the owner transaction enables, with the policy contracts it names (per action, and as sets). */
function sessionsOf(tx: { to: string; data: Hex }) {
  const smartSession = registryAddress('SmartSession', baseRegistry).toLowerCase()
  const calls = tx.data.startsWith('0x8d80ff0a') ? unpack(tx.data) : [tx]
  const enable = calls.filter((c) => c.to.toLowerCase() === smartSession).map((c) => decodeFunctionData({ abi: smartSessionAbi, data: c.data })).filter((d) => d.functionName === 'enableSessions')
  expect(enable).toHaveLength(1)
  const sessions = enable[0]!.args![0] as unknown as { userOpPolicies: { policy: string }[]; actions: { actionPolicies: { policy: string }[] }[] }[]
  return sessions.map((s) => ({
    userOp: new Set(s.userOpPolicies.map((p) => p.policy.toLowerCase())),
    perAction: s.actions.map((a) => a.actionPolicies.map((p) => p.policy.toLowerCase())),
    action: new Set(s.actions.flatMap((a) => a.actionPolicies.map((p) => p.policy.toLowerCase()))),
  }))
}

const UID = `0x${'ab'.repeat(32)}`
const asked: string[] = []
/** The registry, the policy contracts and the guardian pause answer as a deployed, attested world would. */
function chain(w: ReturnType<typeof world>, generation: bigint) {
  const client = priv(w.op).client
  const base = client.readContract.bind(client)
  client.readContract = async (a) => {
    if (a.functionName === 'findModule') {
      asked.push(String(a.args?.[0]).toLowerCase())
      return { resolverUID: UID, sender: `0x${'01'.repeat(20)}` }
    }
    if (a.functionName === 'findAttestation') return { time: 0, expirationTime: 0, revocationTime: 0, attester: `0x${'00'.repeat(20)}` }
    if (a.functionName === 'generationOf') return generation
    if (a.functionName === 'configOf') return { generation }
    if (a.functionName === 'isPaused') return false
    return base(a)
  }
}

function running(w: ReturnType<typeof world>, policy = v5, only?: (name: string) => boolean): AccountState {
  const grants = policy.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ name: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(64, '0')}`, grant: { policyId: policy.policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } })).filter((g) => !only || only(g.name))
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

/** The Monad operator as the Base one sees it: gives the session key, records what it was asked, answers `provision`. */
function fakePeer(answer: { provision: RemoteProvision; keyFails?: boolean } = { provision: { state: 'active', address: SESSION_KEY } }) {
  const keyAsked: AccountContext[] = []
  const provisioned: AccountContext[] = []
  const peer = {
    key: async (c: AccountContext): Promise<Address> => {
      keyAsked.push(c)
      if (answer.keyFails) throw new Error('remote operator of chain 143 gave no session key (502 )')
      return SESSION_KEY
    },
    provision: async (c: AccountContext): Promise<RemoteProvision> => {
      provisioned.push(c)
      return answer.provision.state === 'active' ? { state: 'active', address: c.address as Address } : answer.provision
    },
  }
  return { peer, keyAsked, provisioned, answer }
}

const scopedOn = { multichain_v6: null }
/** A Base operator offering v6 (flag on for everyone) with the Monad operator `peer`; V3 on Monad is the pinned fixture one. */
const cfg6 = (peer?: ReturnType<typeof fakePeer>['peer'], extra: Partial<OperatorConfig> = {}): Partial<OperatorConfig> => ({
  registry: reg6,
  v4Policy: v4,
  v5Policy: v5,
  v6Policy: v6,
  opsFlags: () => ({ multichain_v6: true }),
  opsScopedFlags: () => scopedOn,
  remoteRegistry: () => pinnedV3,
  ...(peer ? { remotePeers: { 143: peer } } : {}),
  ...extra,
})

describe('boot wiring', () => {
  test('v6 carries V3 as its action policy (contractVersion 3), the registry gate and the gas policy', () => {
    expect(v6.policyId).toBe('conservador-live-v6')
    expect(v6.actionPolicy).toMatchObject({ address: V3_BASE_PINNED, contractVersion: 3, gasPolicy: { address: GAS } })
    expect(v6.actionPolicy!.pauseGate!.toLowerCase()).toBe(GATE)
  })
})

describe('the renew row offers v6 only behind multichain_v6', () => {
  const acc = (w: ReturnType<typeof world>, id: string) => running(w, id === 'conservador-live-v4' ? v4 : v5)
  const cfg = (flags: Record<string, boolean>) => ({ v4Policy: v4, v5Policy: v5, v6Policy: v6, opsFlags: () => flags, opsScopedFlags: () => (flags.multichain_v6 ? { multichain_v6: null } : {}) })

  test('flag on: v4 and v5 accounts go to v6, ahead of v5; flag off: v4 -> v5 and v5 stays (unchanged)', () => {
    for (const from of ['conservador-live-v4', 'conservador-live-v5']) {
      const on = world(0n, cfg({ multichain_v6: true, onchain_action_policy_v5: true }))
      expect(on.op.renewTarget(acc(on, from))).toBe('conservador-live-v6')
      const off = world(0n, cfg({ onchain_action_policy_v5: true }))
      expect(off.op.renewTarget(acc(off, from))).toBe(from === 'conservador-live-v4' ? 'conservador-live-v5' : from)
    }
  })

  test('v6 not configured (V3 or the gate not pinned): never offered, flag or not', () => {
    const w = world(0n, { v4Policy: v4, v5Policy: v5, opsFlags: () => ({ multichain_v6: true }) })
    expect(w.op.renewTarget(running(w, v5))).toBe('conservador-live-v5')
  })

  describe('otto/mamoru#217 per-account scope on multichain_v6', () => {
    // The Worker serves a scoped flag as flags false + scopedFlags list; unscoped as flags true + scopedFlags null.
    const world6 = (flags: Record<string, boolean>, scoped?: Record<string, string[] | null>) =>
      world(0n, { v4Policy: v4, v5Policy: v5, v6Policy: v6, opsFlags: () => flags, ...(scoped ? { opsScopedFlags: () => scoped } : {}) })
    const on = { multichain_v6: true, onchain_action_policy_v5: true }
    const target = (w: ReturnType<typeof world>) => w.op.renewTarget(running(w, v5))

    test('explicit everyone (null): v6, as today', () => {
      expect(target(world6(on, { multichain_v6: null }))).toBe('conservador-live-v6')
    })
    test('list: the account key or the Safe address gets v6; anyone else keeps v5', () => {
      const off = { ...on, multichain_v6: false }
      expect(target(world6(off, { multichain_v6: ['k'] }))).toBe('conservador-live-v6')
      expect(target(world6(off, { multichain_v6: [String(ctx.address).toLowerCase()] }))).toBe('conservador-live-v6')
      expect(target(world6(off, { multichain_v6: ['other', '0xabc'] }))).toBe('conservador-live-v5')
    })
    test('a v4 account outside the scope falls to v5, or stays v4 with v5 off', () => {
      const w = world6({ onchain_action_policy_v5: true }, { multichain_v6: ['other'] })
      expect(w.op.renewTarget(running(w, v4))).toBe('conservador-live-v5')
      const w2 = world6({}, { multichain_v6: ['other'] })
      expect(w2.op.renewTarget(running(w2, v4))).toBe('conservador-live-v4')
    })
    test('malformed or empty scope (reaches the operator as []): nobody', () => {
      expect(target(world6({ onchain_action_policy_v5: true }, { multichain_v6: [] }))).toBe('conservador-live-v5')
    })
    test('old Worker: flags.multichain_v6 true with no scope information offers nobody v6', () => {
      expect(target(world6(on))).toBe('conservador-live-v5')
      expect(target(world6(on, {}))).toBe('conservador-live-v5')
    })
    test('flag off: nothing offered even with a list', () => {
      expect(target(world6({ onchain_action_policy_v5: true }, {}))).toBe('conservador-live-v5')
    })
  })

  test('an account already on v6 renews as v6', () => {
    const w = world(0n, cfg({ multichain_v6: true }))
    expect(w.op.renewTarget(running(w, v6))).toBe('conservador-live-v6')
  })

  test('the approval view of a v5 account offered v6 carries upgradeSplit; one offered v5 does not', () => {
    const view = (flags: Record<string, boolean>) => {
      const w = world(0n, cfg(flags))
      const a = running(w, v5)
      return (w.op as unknown as { approvalView(a: AccountState): { upgradePolicy?: string; upgradeSplit?: unknown } | null }).approvalView(a)
    }
    expect(view({ multichain_v6: true })).toMatchObject({ upgradePolicy: 'conservador-live-v6', upgradeSplit: { to: expect.any(Array) } })
    expect(view({})?.upgradeSplit).toBeUndefined()
  })

  test('upgradeSplit: before -> after, cbBTC leaving, growth on Monad; none for a move without a remote bucket', () => {
    expect(upgradeSplitOf(v5, v6)).toEqual({
      from: [{ bucket: 'stables', bps: 5000 }, { bucket: 'btc-usdc', bps: 4000 }, { bucket: 'risk', bps: 1000 }],
      to: [{ bucket: 'stables', chainId: 8453, bps: 5000 }, { bucket: 'risk', chainId: 8453, bps: 3500 }, { bucket: 'btc-usdc', chainId: 8453, bps: 0 }, { bucket: 'growth', chainId: 143, bps: 1500 }],
    })
    expect(upgradeSplitOf(v4, v5)).toBeUndefined()
    expect(conservadorLiveV5.remoteBuckets).toBeUndefined()
  })
})

describe('owner transactions of a v6 approval', () => {
  test('gas split: the pool-less bridge-out grant sorts last and lands in exactly one transaction', () => {
    const keys = v6.session.grants.filter((g) => !g.perPosition).map(grantKey)
    expect(keys).toContain('bridge-out')
    const ordered = orderV4Keys(v6, keys)
    expect(ordered.at(-1)).toBe('bridge-out')
    expect(ordered).toHaveLength(keys.length)
    const split = splitV4Keys(v6, keys, { ceiling: V4_TX_GAS_TARGET, overheadGas: 1_000_000n })
    expect(split.flat()).toEqual(ordered)
    expect(split.flat().filter((k) => k === 'bridge-out')).toHaveLength(1)
    // A tighter ceiling splits into several transactions; bridge-out stays whole, in the last one.
    const tight = splitV4Keys(v6, keys, { ceiling: 6_000_000n })
    expect(tight.length).toBeGreaterThan(1)
    expect(tight.flat()).toEqual(ordered)
    expect(tight.at(-1)!.at(-1)).toBe('bridge-out')
    // Its two actions are priced like any other session's (not zero for want of a pool): alone it does not fit one action's gas.
    expect(() => splitV4Keys(v6, ['bridge-out'], { ceiling: 1_000_000n })).toThrow('one item alone')
    expect(splitV4Keys(v6, ['bridge-out'], { ceiling: V4_TX_GAS_TARGET })).toEqual([['bridge-out']])
  })

  /** What a v6 prepare (renewal from v5, or a Start on v6) holds, checked the same for both. */
  function expectOneV6Transaction(w: ReturnType<typeof world>, t: Awaited<ReturnType<Operator['prepareRenew']>>) {
    const held = priv(w.op).prepared.get(t.prepareId)!
    const sessions = sessionsOf(held.tx)
    const names = held.grants!.map((g) => g.name)
    // One owner transaction carries every grant: the stables and balance manage-any, cbBTC exit-only, bridge-out. No later step.
    expect(names).toEqual(['manage-any:pool:USDC/USDT/100', 'manage-any:pool:WETH/USDC/3000', 'manage-any:pool:USDC/cbBTC/500', 'bridge-out'])
    expect(held.extend).toBeUndefined()
    expect(sessions).toHaveLength(names.length)
    names.forEach((name, i) => {
      expect(sessions[i]!.userOp.has(GAS)).toBe(true)
      if (name === 'bridge-out') {
        // UniActionPolicy (the CCTP burn rules) and the pause gate; V3 is not on it.
        expect(sessions[i]!.action).toEqual(new Set([UNI, GATE]))
      } else if (name.endsWith('USDC/cbBTC/500')) {
        // The cbBTC exit keeps UniActionPolicy beside V3: its swap sells cbBTC for USDC only (review r2 P1 4).
        for (const policies of sessions[i]!.perAction) expect(policies).toEqual([UNI, V3])
      } else {
        // Every Uniswap action has exactly one action policy: MamoruActionPolicyV3 (no UniActionPolicy param rules).
        expect(sessions[i]!.perAction.length).toBeGreaterThan(0)
        for (const policies of sessions[i]!.perAction) expect(policies).toEqual([V3])
      }
    })
    return held
  }

  test('renewal v5 -> v6: ONE owner transaction; V3 alone on the manage-any grants, UniActionPolicy + gate on bridge-out', async () => {
    const p = fakePeer()
    const w = world(0n, cfg6(p.peer))
    running(w, v5)
    ready(w)
    chain(w, 7n)
    asked.length = 0
    const t = await w.op.prepareRenew(ctx)
    expect(t.policyId).toBe('conservador-live-v6')
    expect(t.move).toBe(true)
    // V3, the gas policy and the gate are registered like the other policies before anything is signed.
    expect(asked).toEqual(expect.arrayContaining([V3, GAS, GATE]))
    const held = expectOneV6Transaction(w, t)
    // The old v5 sessions are revoked in the same transaction.
    expect(held.revokes!.length).toBeGreaterThan(0)
    expect(t.summary.join('\n')).toContain('Circle')
    // Review of PR #141: the bridge consent line reads the policy's real cap names (bridgePerCall, bridgeTotal), never 0.
    const bridge = t.summary.find((l) => l.startsWith('Bridge:'))!
    expect(bridge).toBeDefined()
    expect(bridge).not.toMatch(/at most 0(\.0+)? USDC/)
    expect(bridge).not.toMatch(/and 0(\.0+)? USDC in total/)
    expect(p.provisioned).toEqual([])
  })

  test('renewal: the mint recipient of bridge-out is the remote Safe the owner is shown, and that is the Safe these keys and the Monad session key give', async () => {
    const p = fakePeer()
    const w = world(0n, cfg6(p.peer))
    running(w, v5)
    ready(w)
    chain(w, 7n)
    const t = await w.op.prepareRenew(ctx)
    const remote = t.remote!
    expect(remote.chainId).toBe(143)
    expect(remote.spec).toMatchObject({ chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: SESSION_KEY })
    // The Base operator asked the Monad one for the key of THIS account, once.
    expect(p.keyAsked.map((c) => c.accountKey)).toEqual([ctx.accountKey])
    // The address is a function of the account's keys, the session key and the spec: nothing a caller could pick.
    const again = remoteSafe(remoteInput(ctx, remote.spec, pinnedV3))
    expect(remote.address).toBe(again.address)
    expect(remote.address.toLowerCase()).not.toBe(String(ctx.address).toLowerCase())
    const held = priv(w.op).prepared.get(t.prepareId)!
    const burn = held.grants!.find((g) => g.name === 'bridge-out')!.grant.actions.find((a) => a.params.some((r) => r.field === 'mintRecipient'))!
    expect(burn.params.find((r) => r.field === 'mintRecipient')).toMatchObject({ condition: 'EQUAL', ref: BigInt(remote.address) })
    // And it is the word the owner signs over: the Safe transaction carries the recipient (as a policy parameter).
    expect(held.tx.data.toLowerCase()).toContain(pad(remote.address, { size: 32 }).slice(2).toLowerCase())
    // The summary names the Safe and the move of savings to it.
    expect(t.summary.join('\n')).toContain(remote.address)
  })

  test('no Monad operator configured, or one that gives no key: 503 REMOTE_UNAVAILABLE and nothing is prepared', async () => {
    for (const p of [undefined, fakePeer({ provision: { state: 'pending', code: 'X' }, keyFails: true })]) {
      const w = world(0n, cfg6(p?.peer))
      running(w, v5)
      ready(w)
      chain(w, 7n)
      const { out } = await quiet(() => w.op.prepareRenew(ctx).catch((e: unknown) => e))
      expect(out).toBeInstanceOf(HttpError)
      expect(out).toMatchObject({ status: 503, code: 'REMOTE_UNAVAILABLE' })
      expect(priv(w.op).prepared.size).toBe(0)
      expect(w.sent).toEqual([])
    }
    // A fresh Start on v6 is refused the same way.
    const w = world(0n, { policy: v6, ...cfg6() })
    w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
    chain(w, 0n)
    const { out } = await quiet(() => w.op.prepareActivate(ctx).catch((e: unknown) => e))
    expect(out).toMatchObject({ status: 503, code: 'REMOTE_UNAVAILABLE' })
    expect(priv(w.op).prepared.size).toBe(0)
  })

  test('a v6 account that already has its remote Safe re-derives it instead of asking the Monad operator again', async () => {
    const p = fakePeer()
    const w = world(0n, cfg6(p.peer))
    const a = running(w, v6)
    ready(w)
    chain(w, 7n)
    const first = await w.op.prepareRenew(ctx)
    a.remote = { chainId: 143, address: first.remote!.address as never, spec: first.remote!.spec, permissionIds: [] }
    p.keyAsked.length = 0
    const second = await w.op.prepareRenew(ctx)
    expect(p.keyAsked).toEqual([])
    expect(second.remote!.address).toBe(first.remote!.address)
    // A stored address that is not what the keys give is never signed over.
    a.remote = { ...a.remote, address: `0x${'ab'.repeat(20)}` as never }
    const { out } = await quiet(() => w.op.prepareRenew(ctx).catch((e: unknown) => e))
    expect(String((out as Error).message)).toContain('is not what its keys give')
  })

  test('extension: a v6 account missing only bridge-out gets just that session, with the gate and the same remote Safe', async () => {
    const p = fakePeer()
    const w = world(0n, cfg6(p.peer))
    running(w, v6, (n) => n !== 'bridge-out')
    ready(w)
    chain(w, 7n)
    const t = await w.op.prepareRenew(ctx)
    const held = priv(w.op).prepared.get(t.prepareId)!
    expect(held.grants!.map((g) => g.name)).toEqual(['bridge-out'])
    const [s] = sessionsOf(held.tx)
    expect(s!.action).toEqual(new Set([UNI, GATE]))
    expect(s!.userOp.has(GAS)).toBe(true)
    expect(t.remote!.address).toBe(remoteSafe(remoteInput(ctx, t.remote!.spec, pinnedV3)).address)
  })

  test('a v6 renewal without a configured gate cannot be built', async () => {
    const noGate = { ...v6, actionPolicy: { ...v6.actionPolicy!, pauseGate: undefined } }
    const w = world(0n, cfg6(fakePeer().peer, { v6Policy: noGate }))
    running(w, v5)
    ready(w)
    chain(w, 7n)
    await expect(w.op.prepareRenew(ctx)).rejects.toThrow(/PauseGate/)
  })
})

// Boot refuses v6 as the default policy (assertBootPolicies, review of PR #141): this checks only the encoding.
describe('a fresh activation on v6 (default policy)', () => {
  test('Start enables the stables, balance, cbBTC exit-only and bridge-out grants in one transaction, and names the remote Safe', async () => {
    const p = fakePeer()
    const w = world(0n, { policy: v6, ...cfg6(p.peer) })
    w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
    chain(w, 0n)
    const t = await w.op.prepareActivate(ctx).catch((e) => {
      if (e instanceof HttpError) throw new Error(`${e.code}: ${e.message}`)
      throw e
    })
    const held = priv(w.op).prepared.get(t.prepareId)!
    const sessions = sessionsOf(held.tx)
    const names = held.grants!.map((g) => g.name)
    expect(names).toEqual(['manage-any:pool:USDC/USDT/100', 'manage-any:pool:WETH/USDC/3000', 'manage-any:pool:USDC/cbBTC/500', 'bridge-out'])
    names.forEach((name, i) => {
      expect(sessions[i]!.userOp.has(GAS)).toBe(true)
      if (name === 'bridge-out') expect(sessions[i]!.action).toEqual(new Set([UNI, GATE]))
      else for (const policies of sessions[i]!.perAction) expect(policies).toEqual(name.endsWith('USDC/cbBTC/500') ? [UNI, V3] : [V3])
    })
    expect(t.remote!.address).toBe(remoteSafe(remoteInput(ctx, t.remote!.spec, pinnedV3)).address)
    expect(t.summary.join('\n')).toContain(t.remote!.address)
  })
})

describe('after a confirmed v6 approval the account\'s own Safe on Monad is provisioned', () => {
  const settle = () => new Promise((r) => setTimeout(r, 10))

  /** A Start on v6 prepared and signed; returns the world, the peer and what the owner was shown. */
  async function started(answer: Parameters<typeof fakePeer>[0]) {
    const p = fakePeer(answer)
    // Funded, so the Start is not armed to wait for a deposit.
    const w = world(10_000_000n, { policy: v6, ...cfg6(p.peer) })
    w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
    chain(w, 0n)
    const t = await w.op.prepareActivate(ctx)
    return { w, p, t }
  }
  const confirm = async (w: ReturnType<typeof world>, t: Awaited<ReturnType<Operator['prepareActivate']>>) => {
    await quiet(() => w.op.submit(ctx, 'activate', sign(t)))
    await settle()
  }

  test('nothing is recorded or provisioned before the approval lands', async () => {
    const { w, p, t } = await started(undefined)
    expect(w.state.accounts.k!.remote).toBeUndefined()
    expect(p.provisioned).toEqual([])
    expect(t.remote).toBeDefined()
  })

  test('the Monad operator is asked with the remote Safe\'s own context; ready flips when it answers active', async () => {
    const { w, p, t } = await started(undefined)
    await confirm(w, t)
    const acc = w.state.accounts.k!
    expect(acc.active).toBe(true)
    expect(acc.remote).toMatchObject({ chainId: 143, address: t.remote!.address, spec: t.remote!.spec, ready: true })
    expect(acc.remote!.permissionIds.length).toBe(remoteSafe(remoteInput(ctx, t.remote!.spec, pinnedV3)).permissionIds.length)
    expect(p.provisioned).toHaveLength(1)
    const c = p.provisioned[0]!
    expect(c).toMatchObject({ accountKey: `${ctx.accountKey}@143`, chainId: 143, address: t.remote!.address, remote: t.remote!.spec, owners: ctx.owners, saltNonce: ctx.saltNonce })
    expect(c.passkey).toEqual(ctx.passkey)
    // Once ready it is not asked again, and the funding view carries it.
    await w.op.tickRemotes()
    expect(p.provisioned).toHaveLength(1)
  })

  test('review r2 P1 2: no bridge to the remote Safe in the last 30 days of its sessions (its permissions are not handed over)', async () => {
    const { w, t } = await started(undefined)
    await confirm(w, t)
    const acc = w.state.accounts.k!
    const seen: (readonly Hex[] | undefined)[] = []
    const o = w.op as unknown as { cfg: { bridgeMonad?: unknown }; remoteOf(a: AccountState): { remote?: (b: bigint) => Promise<unknown> } }
    o.cfg.bridgeMonad = { remote: async (...a: unknown[]) => (seen.push(a[4] as readonly Hex[]), { value: 0n, inFlight: 0n, ready: true }) }
    // One engine's `remote`, kept across reviews: the cutoff is judged at each call, not when the engine was built.
    const remote = o.remoteOf(acc).remote!
    await remote(1n)
    expect(seen[0]).toEqual(acc.remote!.permissionIds)
    acc.remote!.spec = { ...acc.remote!.spec, validUntil: Math.floor(Date.now() / 1000) + 29 * 86_400 }
    await remote(2n)
    expect(seen[1]).toEqual([])
  })

  test('a pending answer keeps it not ready, and tickRemotes asks again until the Monad operator says active', async () => {
    const { w, p, t } = await started({ provision: { state: 'pending', code: 'REMOTE_SAFE_UNVERIFIED' } })
    await quiet(async () => {
      await confirm(w, t)
      const acc = w.state.accounts.k!
      expect(acc.remote).toMatchObject({ address: t.remote!.address, ready: false, lastCode: 'REMOTE_SAFE_UNVERIFIED' })
      expect(p.provisioned).toHaveLength(1)
      await w.op.tickRemotes()
      expect(p.provisioned).toHaveLength(2)
      expect(acc.remote!.ready).toBe(false)
      p.answer.provision = { state: 'active', address: SESSION_KEY }
      await w.op.tickRemotes()
      expect(p.provisioned).toHaveLength(3)
      expect(acc.remote).toMatchObject({ ready: true, lastCode: undefined })
    })
  })

  test('a Monad operator that provisions another address than the committed one is never taken as ready', async () => {
    const { w, p, t } = await started({ provision: { state: 'pending', code: 'X' } })
    p.peer.provision = async (c) => {
      p.provisioned.push(c)
      return { state: 'active', address: `0x${'ab'.repeat(20)}` as Address }
    }
    await quiet(async () => {
      await confirm(w, t)
      expect(w.state.accounts.k!.remote!.ready).not.toBe(true)
    })
  })

  test('the funding view of an account with a remote Safe carries it, ready or not', async () => {
    const { w, t } = await started({ provision: { state: 'pending', code: 'X' } })
    await quiet(async () => {
      await confirm(w, t)
      const view = await w.op.funding(ctx)
      expect(view.remote).toEqual({ chainId: 143, address: t.remote!.address, spec: t.remote!.spec, ready: false })
    })
  })
})
