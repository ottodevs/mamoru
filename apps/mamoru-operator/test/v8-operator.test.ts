// otto/mamoru#428 (spec 014): conservador-live-v8 on the Base operator, step 0 of leaving Monad. Behind the scoped flag
// `base_v8` a Start activates it (no Safe on Monad, no bridge) and every earlier Base account is offered the move to it,
// ahead of every other offer. One approval is ONE owner transaction, every grant on MamoruActionPolicyV3 alone.
// Fake deployed addresses; V3 and the gate are the registry pins withPinnedV6Base() gives.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, pad, parseAbi, slice, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address, ReturnHomeStatus, WhatsNew } from '@mamoru/domain'
import { address as registryAddress, baseRegistry, smartSessionAbi } from '@mamoru/registry'
import { encodeVaultFamilyInit, grantKey } from '@mamoru/policy'
import { remoteInput, remoteSafe } from '@mamoru/account/remote'
import { resolveV4Policy, resolveV5Policy, resolveV6Policy, resolveV7Policy, resolveV8Policy } from '../src/boot.ts'
import { monadSellLines, returnHomeLines } from '@mamoru/account/return-home'
import { leaveMonadPoints, v8MoveLines, type Operator, type OperatorConfig } from '../src/operator.ts'
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
const v8 = resolveV8Policy('base', env, reg6)!

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
  v8Policy: v8,
  opsFlags: () => flags,
  opsScopedFlags: () => scoped,
  remoteRegistry: () => pinnedV3,
  ...extra,
})

describe('boot wiring', () => {
  test('v8 runs on v6\'s contracts: V3 (contractVersion 3) and the gas policy, no pause gate (no bridge-out)', () => {
    expect(v8.policyId).toBe('conservador-live-v8')
    expect(v8.actionPolicy).toMatchObject({ address: V3_BASE_PINNED, contractVersion: 3, gasPolicy: { address: GAS } })
    expect(v8.actionPolicy!.pauseGate).toBeUndefined()
    expect(v8.remoteBuckets).toBeUndefined()
  })

  test('not configured where v6 is not (V3 not pinned, or no v4 opt-in), nor on Monad', () => {
    const unpinned = { ...baseRegistry, entries: baseRegistry.entries.filter((e) => e.name !== 'MamoruActionPolicyV3') }
    expect(resolveV8Policy('base', env, unpinned)).toBeUndefined()
    expect(resolveV8Policy('base', { ...env, MAMORU_ONCHAIN_POLICY_V4: undefined }, reg6)).toBeUndefined()
    expect(resolveV8Policy('monad', env, reg6)).toBeUndefined()
  })
})

describe('the renew row offers v8 to every earlier Base version behind base_v8, ahead of everything', () => {
  const target = (flags: Flags, scoped: Scoped, from = v7) => {
    const w = world(0n, cfg7(flags, scoped))
    return w.op.renewTarget(running(w, from))
  }

  test('in scope: v6 and v7 accounts move to v8, ahead of v7', () => {
    expect(target({ base_v8: true }, { base_v8: null })).toBe('conservador-live-v8')
    expect(target({ base_v8: true, vaults_v7: true }, { base_v8: null, vaults_v7: null }, v6)).toBe('conservador-live-v8')
    expect(target({}, { base_v8: ['k'] })).toBe('conservador-live-v8')
  })

  test('every earlier Base version moves to it too (owner, 21 Nov): v4 and v5 go to v8, ahead of v7', () => {
    expect(target({ base_v8: true, vaults_v7: true }, { base_v8: null, vaults_v7: null }, v5)).toBe('conservador-live-v8')
    expect(target({ base_v8: true }, { base_v8: null }, v4)).toBe('conservador-live-v8')
  })

  test('out of scope, off, or v8 not configured: as before', () => {
    expect(target({}, { base_v8: ['other'] })).toBe('conservador-live-v7')
    expect(target({ base_v8: true }, {})).toBe('conservador-live-v7')
    const w = world(0n, { ...cfg7({ base_v8: true }, { base_v8: null }), v8Policy: undefined })
    expect(w.op.renewTarget(running(w, v7))).toBe('conservador-live-v7')
  })

  test('an account already on v8 renews as v8', () => {
    expect(target({}, {}, v8)).toBe('conservador-live-v8')
  })
})

describe('owner transaction of the move to v8', () => {
  test('v7 -> v8: ONE owner transaction, every session on V3 alone, no bridge-out, the v7 grants revoked; the summary says Monad ends', async () => {
    const w = world(0n, cfg7({}, { base_v8: ['k'] }))
    const a = running(w, v7)
    ;(a as unknown as { remote: unknown }).remote = { chainId: 143, address: `0x${'cd'.repeat(20)}`, spec: {}, permissionIds: [], ready: true }
    ready(w)
    chain(w, 7n)
    const t = await w.op.prepareRenew(ctx)
    expect(t.policyId).toBe('conservador-live-v8')
    expect(t.move).toBe(true)
    expect(t.remote).toBeUndefined()
    const held = priv(w.op).prepared.get(t.prepareId)!
    const names = held.grants!.map((g) => g.name)
    expect([...names].sort()).toEqual(['manage-any:pool:USDC/USDT/100', 'manage-any:pool:USDC/cbBTC/500', 'manage-any:pool:WETH/USDC/3000', 'vault-supply:vault:gtUSDCp', 'vault-supply:vault:waBasUSDC'])
    const sessions = sessionsOf(held.tx)
    expect(sessions).toHaveLength(names.length)
    for (const s of sessions) for (const policies of s.perAction) expect(policies).toEqual([V3])
    expect(sessions.some((s) => s.action.has(GATE) || s.action.has(UNI))).toBe(false)
    expect(held.revokes!.length).toBe(a.grants.length)
    const text = t.summary.join('\n')
    expect(text).toContain('Mamoru stops sending money to Monad: on Base it aims for 50% in Stable, 25% in WETH/USDC, 25% in USDC/cbBTC')
    // Spec 014 r2 (copy C4): with the Monad step on the same screen, the line says the USDC comes with it.
    expect(text).toContain('Your USDC on Monad comes here with the other step')
    expect(text).not.toContain('keeps what it holds')
  })
})

describe('review r1: the move waits for a bridge to Monad still in flight', () => {
  test('a pending burn refuses the v7 -> v8 prepare (BRIDGE_IN_FLIGHT); none: prepared', async () => {
    let pending: unknown = { id: 'b1', state: 'burned' }
    const bridgeMonad = { pending: () => pending } as unknown as OperatorConfig['bridgeMonad']
    const w = world(0n, cfg7({}, { base_v8: ['k'] }, { bridgeMonad }))
    running(w, v7)
    ready(w)
    chain(w, 7n)
    const e = await w.op.prepareRenew(ctx).catch((x: unknown) => x)
    expect((e as { code?: string }).code).toBe('BRIDGE_IN_FLIGHT')
    pending = undefined
    expect((await w.op.prepareRenew(ctx)).policyId).toBe('conservador-live-v8')
  })
})

describe('review r2: nothing is bridged to Monad for an account in base_v8 scope', () => {
  test('the remote read gets no bridge permission in scope, its permission ids out of scope', async () => {
    const asked: (readonly Hex[])[] = []
    const fence = { on: false }
    const bridgeMonad = { pending: () => undefined, fenced: () => fence.on, remote: async (_k: string, _s: string, _t: number, _b: bigint, ids: readonly Hex[]) => (asked.push(ids), { value: 0n, inFlight: 0n, ready: true }) } as unknown as OperatorConfig['bridgeMonad']
    const read = async (scoped: Scoped) => {
      const w = world(0n, cfg7({}, scoped, { bridgeMonad }))
      const a = running(w, v7)
      ;(a as unknown as { remote: unknown }).remote = { chainId: 143, address: `0x${'cd'.repeat(20)}`, spec: { validUntil: 4_000_000_000, capUsdc: '1000000000' }, permissionIds: [`0x${'0e'.repeat(32)}`], ready: true }
      const r = (w.op as unknown as { remoteOf(a: AccountState): { remote?: (b: bigint) => Promise<unknown> } }).remoteOf(a)
      await r.remote!(1n)
    }
    await read({})
    await read({ base_v8: ['k'] })
    // Spec 014 RH-11: nor behind the fence of a return home, whatever the scope.
    fence.on = true
    await read({})
    expect(asked).toEqual([[`0x${'0e'.repeat(32)}`], [], []])
  })
})

describe('review r2: a v2 account moves to v8 in one owner transaction', () => {
  test('v2 -> v8: every v8 session on V3 alone, every v2 grant revoked in the same transaction', async () => {
    const v2 = (await import('@mamoru/policy')).POLICIES['conservador-live-v2']!
    const w = world(0n, cfg7({}, { base_v8: ['k'] }))
    const a = running(w, v2)
    ready(w)
    chain(w, 7n)
    const t = await w.op.prepareRenew(ctx)
    expect(t.policyId).toBe('conservador-live-v8')
    const held = priv(w.op).prepared.get(t.prepareId)!
    expect([...held.grants!.map((g) => g.name)].sort()).toEqual(v8.session.grants.filter((g) => !g.perPosition).map(grantKey).sort())
    for (const s of sessionsOf(held.tx)) for (const policies of s.perAction) expect(policies).toEqual([V3])
    expect(held.revokes!.length).toBe(a.grants.length)
    expect(t.summary.join('\n')).not.toContain('Monad')
  })
})

describe('a Start activates on v8 wherever base_v8 is in scope', () => {
  async function start(flags: Flags, scoped: Scoped) {
    const w = world(0n, { policy: v5, ...cfg7(flags, scoped) })
    w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
    chain(w, 0n)
    const t = await w.op.prepareActivate(ctx)
    const held = priv(w.op).prepared.get(t.prepareId)!
    return { t, names: held.grants!.map((g) => g.name), policyIds: new Set(held.grants!.map((g) => g.grant.policyId)) }
  }

  test('base_v8 for everyone: v8 in one approval, no Safe on Monad, no bridge-out, even with vaults_v7 on (no Monad operator needed)', async () => {
    const r = await start({ base_v8: true, vaults_v7: true }, { base_v8: null, vaults_v7: null })
    expect(r.policyIds).toEqual(new Set([v8.policyId]))
    expect(r.t.remote).toBeUndefined()
    expect(r.names).not.toContain('bridge-out')
    expect([...r.names].sort()).toEqual(v8.session.grants.filter((g) => !g.perPosition).map(grantKey).sort())
  })

  test('out of scope: v7 as before (#368)', async () => {
    const r = await start({}, { base_v8: ['someone-else'] })
    expect(r.policyIds).toEqual(new Set([v5.policyId]))
  })
})

// SCN-RH-05, SCN-RH-06 (spec 014 RH-01, RH-06, RH-10): the "What's new" view of leaving Monad.
describe("the What's new view of leaving Monad (policy 'base-v8')", () => {
  const HOME = ctx.address as Address
  const MONAD_SAFE = `0x${'cd'.repeat(20)}`
  const homeLines = returnHomeLines({ sessions: 1, usdc: 449_550_000n, home: HOME })
  const status = (o: Partial<ReturnHomeStatus> = {}): ReturnHomeStatus => ({ next: 'return-home', sessions: 1, usdc: '449550000', wmon: '0', openPositions: 0, block: '500', home: homeLines, ...o })
  /** A Base account on `from` in the base_v8 scope; `monad`: what its Monad peer answers about its Safe there (absent: no Safe on Monad; null: the peer cannot say). */
  function leaving(from = v7, monad?: ReturnHomeStatus | null, scoped: Scoped = { base_v8: ['k'] }) {
    const asked: { ctx: AccountContext; home: string }[] = []
    const answer = { status: monad }
    const peer = { ...fakePeer().peer, returnHomeStatus: async (c: AccountContext, home: Address) => (asked.push({ ctx: c, home }), answer.status ?? null) }
    const w = world(0n, cfg7({}, scoped, { remotePeers: { 143: peer } }))
    const a = running(w, from)
    if (monad !== undefined) (a as unknown as { remote: unknown }).remote = { chainId: 143, address: MONAD_SAFE, spec: { chainId: 143, policyId: 'live-wmon-usdc-monad-v6' }, permissionIds: [], ready: true }
    const view = async (): Promise<WhatsNew | null> => {
      const read = () => (priv(w.op) as unknown as { whatsNewView(a: AccountState): WhatsNew | null }).whatsNewView(a)
      read()
      await new Promise((r) => setTimeout(r, 5))
      return read()
    }
    return { w, a, view, asked, answer }
  }

  test('a v7 account with a Safe on Monad: two steps, Monad first, then Base; the lines are the prepares\' own', async () => {
    const l = leaving(v7, status())
    const v = (await l.view())!
    expect(v).toMatchObject({ policy: 'base-v8', signatures: 2, currentStep: 0 })
    expect(v.steps).toEqual([
      { chain: 'monad', kind: 'return-home', summary: homeLines },
      { chain: 'base', kind: 'renew', summary: v8MoveLines(v8, true) },
    ])
    expect(v.points).toEqual(leaveMonadPoints(v8, 2))
    expect(v.points).toEqual([
      'Your USDC on Monad comes back to your Safe on Base, through Circle (about 15-20 minutes, no fee)',
      'Mamoru stops working on Monad: no more money goes there',
      'On Base, Mamoru aims for 50 % Stable, 25 % WETH/USDC and 25 % USDC/cbBTC',
      'Two confirmations with your passkey, one per network',
    ])
    // The peer was asked about this account's own Safe on Monad, with this Safe as its home.
    expect(l.asked[0]).toMatchObject({ home: HOME, ctx: { chainId: 143, address: MONAD_SAFE } })
    // Threats S15: the percentages the screen and the Base step name are the target policy's own preferences.
    expect(v8.buckets.filter((b) => b.preference > 0).map((b) => b.preference)).toEqual([5000, 2500, 2500])
    expect(v.steps[1]!.summary[0]).toBe('Mamoru stops sending money to Monad: on Base it aims for 50% in Stable, 25% in WETH/USDC, 25% in USDC/cbBTC')
  })

  test('a depth-held Safe: three steps, the owner sale first, and the return home names its amount as a minimum', async () => {
    const sell = monadSellLines(120n * 10n ** 18n, 3_580_000n)
    const home = returnHomeLines({ sessions: 1, usdc: 303_580_000n, home: HOME, afterSale: true })
    const v = (await leaving(v7, status({ next: 'monad-sell', wmon: (120n * 10n ** 18n).toString(), usdc: '300000000', sell, home })).view())!
    expect(v).toMatchObject({ policy: 'base-v8', signatures: 3, currentStep: 0 })
    expect(v.steps.map((x) => `${x.chain}:${x.kind}`)).toEqual(['monad:monad-sell', 'monad:return-home', 'base:renew'])
    expect(v.steps[0]!.summary).toEqual(['Sell 120 WMON in your Safe on Monad for at least 3.58 USDC, so all of it can come home'])
    expect(v.steps[1]!.summary.join('\n')).toContain('Send your USDC after the sale (at least 303.58 USDC) from your Safe on Monad to your Safe on Base')
    expect(v.points[3]).toBe('Three confirmations with your passkey: two on Monad, one on Base')
  })

  test('an account with no Safe on Monad (v2): one step, the renewal to v8, and no Monad wording', async () => {
    const l = leaving(v4)
    const v = (await l.view())!
    expect(v).toMatchObject({ policy: 'base-v8', signatures: 1, currentStep: 0 })
    expect(v.steps).toEqual([{ chain: 'base', kind: 'renew', summary: v8MoveLines(v8, false) }])
    expect(v.steps[0]!.summary).toHaveLength(1)
    expect(l.asked).toHaveLength(0)
  })

  test('the Monad peer has not answered: nothing is offered (the Monad step is never left out)', async () => {
    expect(await leaving(v7, null).view()).toBeNull()
  })

  test('SCN-RH-05: step A done, step B not: the Monad step is marked done and the Base step is the current one', async () => {
    const v = (await leaving(v7, status({ next: 'done', sessions: 0, usdc: '0', home: [] })).view())!
    expect(v.steps).toEqual([
      { chain: 'monad', kind: 'return-home', summary: [], done: true },
      { chain: 'base', kind: 'renew', summary: v8MoveLines(v8, true) },
    ])
    expect(v.currentStep).toBe(1)
    expect(v.signatures).toBe(2)
  })

  test('step B done, step A not (RH-06): the account is on v8, the Monad step is still offered', async () => {
    const v = (await leaving(v8, status()).view())!
    expect(v.steps.map((x) => [x.kind, x.done ?? false])).toEqual([['return-home', false], ['renew', true]])
    expect(v.currentStep).toBe(0)
  })

  test('both done, or on v8 with no Safe on Monad: nothing to offer', async () => {
    expect(await leaving(v8, status({ next: 'done', sessions: 0, usdc: '0', home: [] })).view()).toBeNull()
    expect(await leaving(v8).view()).toBeNull()
  })

  test('still unwinding, or a step on its way: the Monad step says why it waits', async () => {
    expect((await leaving(v7, status({ next: 'unwinding', openPositions: 1 })).view())!.steps[0]).toMatchObject({ kind: 'return-home', waiting: 'unwinding' })
    expect((await leaving(v7, status({ next: 'in-flight' })).view())!.steps[0]).toMatchObject({ kind: 'return-home', waiting: 'in-flight' })
  })

  test('out of the base_v8 scope: not offered, and the peer is not asked', async () => {
    const l = leaving(v7, status(), { base_v8: ['other'] })
    expect(await l.view()).toBeNull()
    expect(l.asked).toHaveLength(0)
  })

  test('the peer is asked at most once per interval, however often the view is read', async () => {
    const l = leaving(v7, status())
    await l.view()
    await l.view()
    await l.view()
    expect(l.asked).toHaveLength(1)
  })
})
