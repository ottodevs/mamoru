// otto/mamoru#214: conservador-live-v6 on the Base operator. The renew row offers it behind `multichain_v6`; its owner
// transactions encode the bridge-out grant with MamoruPauseGate + MamoruGasPolicy and every other grant with
// MamoruActionPolicyV2 (+ gas policy); the gas split handles the pool-less bridge-out grant. Fake deployed addresses.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, parseAbi, slice, type Hex } from 'viem'
import { address as registryAddress, baseRegistry, smartSessionAbi } from '@mamoru/registry'
import { V4_TX_GAS_TARGET, conservadorLiveV5, conservadorLiveV6, grantKey, orderV4Keys, splitV4Keys } from '@mamoru/policy'
import { resolveV4Policy, resolveV5Policy, resolveV6Policy } from '../src/boot.ts'
import { HttpError, upgradeSplitOf, type Operator } from '../src/operator.ts'
import type { AccountState } from '../src/state.ts'
import { ctx, world } from './owner-world.ts'

const V1 = `0x${'11'.repeat(20)}`
const GAS = `0x${'22'.repeat(20)}`
const V2 = `0x${'33'.repeat(20)}`
const GATE = `0x${'44'.repeat(20)}`
const env = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: V1, MAMORU_ACTION_POLICY_V2_ADDRESS: V2, MAMORU_GAS_POLICY_ADDRESS: GAS, MAMORU_PAUSE_GATE_ADDRESS: GATE }
const v4 = resolveV4Policy('base', env)!
const v5 = resolveV5Policy('base', env)!
const v6 = resolveV6Policy('base', env)!

type Privates = { settleRenewals(a: AccountState): Promise<void>; assertRenewable(a: AccountState): void; readOf(a: AccountState, safe: Hex): Promise<{ block: bigint }>; prepared: Map<string, { grants?: { name: string; permissionId: Hex }[]; tx: { to: string; data: Hex } }>; client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown> } }
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

/** Every session the owner transaction enables, with the set of policy contracts it names. */
function sessionsOf(tx: { to: string; data: Hex }) {
  const smartSession = registryAddress('SmartSession', baseRegistry).toLowerCase()
  const calls = tx.data.startsWith('0x8d80ff0a') ? unpack(tx.data) : [tx]
  const enable = calls.filter((c) => c.to.toLowerCase() === smartSession).map((c) => decodeFunctionData({ abi: smartSessionAbi, data: c.data })).filter((d) => d.functionName === 'enableSessions')
  expect(enable).toHaveLength(1)
  const sessions = enable[0]!.args![0] as unknown as { userOpPolicies: { policy: string }[]; actions: { actionPolicies: { policy: string }[] }[] }[]
  return sessions.map((s) => ({
    userOp: new Set(s.userOpPolicies.map((p) => p.policy.toLowerCase())),
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

describe('boot wiring', () => {
  test('v6 carries the gate beside V2 and the gas policy, contractVersion 2', () => {
    expect(v6.policyId).toBe('conservador-live-v6')
    expect(v6.actionPolicy).toMatchObject({ address: V2, contractVersion: 2, gasPolicy: { address: GAS } })
    expect(v6.actionPolicy!.pauseGate!.toLowerCase()).toBe(GATE)
  })
})

describe('the renew row offers v6 only behind multichain_v6', () => {
  const acc = (w: ReturnType<typeof world>, id: string) => running(w, id === 'conservador-live-v4' ? v4 : v5)
  const cfg = (flags: Record<string, boolean>) => ({ v4Policy: v4, v5Policy: v5, v6Policy: v6, opsFlags: () => flags })

  test('flag on: v4 and v5 accounts go to v6, ahead of v5; flag off: v4 -> v5 and v5 stays (unchanged)', () => {
    for (const from of ['conservador-live-v4', 'conservador-live-v5']) {
      const on = world(0n, cfg({ multichain_v6: true, onchain_action_policy_v5: true }))
      expect(on.op.renewTarget(acc(on, from))).toBe('conservador-live-v6')
      const off = world(0n, cfg({ onchain_action_policy_v5: true }))
      expect(off.op.renewTarget(acc(off, from))).toBe(from === 'conservador-live-v4' ? 'conservador-live-v5' : from)
    }
  })

  test('v6 not configured (no gate): never offered, flag or not', () => {
    const w = world(0n, { v4Policy: v4, v5Policy: v5, opsFlags: () => ({ multichain_v6: true }) })
    expect(w.op.renewTarget(running(w, v5))).toBe('conservador-live-v5')
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

  test('renewal v5 -> v6: every session encodes; bridge-out with the gate, the rest with V2; all with the gas policy', async () => {
    const w = world(0n, { v4Policy: v4, v5Policy: v5, v6Policy: v6, opsFlags: () => ({ multichain_v6: true }) })
    running(w, v5)
    ready(w)
    chain(w, 7n)
    asked.length = 0
    const t = await w.op.prepareRenew(ctx)
    expect(t.policyId).toBe('conservador-live-v6')
    expect(t.move).toBe(true)
    // The gate is registered like the other two policies before anything is signed.
    expect(asked).toEqual(expect.arrayContaining([V2, GAS, GATE]))
    const held = priv(w.op).prepared.get(t.prepareId)!
    const sessions = sessionsOf(held.tx)
    const names = held.grants!.map((g) => g.name)
    expect(sessions).toHaveLength(names.length)
    names.forEach((name, i) => {
      expect(sessions[i]!.userOp.has(GAS)).toBe(true)
      if (name === 'bridge-out') {
        expect(sessions[i]!.action.has(GATE)).toBe(true)
        expect(sessions[i]!.action.has(V2)).toBe(false)
      } else {
        expect(sessions[i]!.action.has(V2)).toBe(true)
        expect(sessions[i]!.action.has(GATE)).toBe(false)
      }
    })
    // The exit-only btc grant is enabled with V2 for its pool (so the old positions can be wound down).
    expect(names.some((n) => n.includes('USDC/cbBTC'))).toBe(true)
    expect(t.summary.join('\n')).toContain('Circle')
    // Review of PR #141: the bridge consent line reads the policy's real cap names (bridgePerCall, bridgeTotal), never 0.
    const bridge = t.summary.find((l) => l.startsWith('Bridge:'))!
    expect(bridge).toBeDefined()
    expect(bridge).not.toMatch(/at most 0(\.0+)? USDC/)
    expect(bridge).not.toMatch(/and 0(\.0+)? USDC in total/)
  })

  test('extension: a v6 account missing only bridge-out gets just that session, with the gate', async () => {
    const w = world(0n, { v4Policy: v4, v5Policy: v5, v6Policy: v6, opsFlags: () => ({ multichain_v6: true }) })
    running(w, v6, (n) => n !== 'bridge-out')
    ready(w)
    chain(w, 7n)
    const t = await w.op.prepareRenew(ctx)
    const held = priv(w.op).prepared.get(t.prepareId)!
    expect(held.grants!.map((g) => g.name)).toEqual(['bridge-out'])
    const [s] = sessionsOf(held.tx)
    expect([...s!.action]).toContain(GATE)
    expect(s!.action.has(V2)).toBe(false)
    expect(s!.userOp.has(GAS)).toBe(true)
  })

  test('a v6 renewal without a configured gate cannot be built', async () => {
    const noGate = { ...v6, actionPolicy: { ...v6.actionPolicy!, pauseGate: undefined } }
    const w = world(0n, { v4Policy: v4, v5Policy: v5, v6Policy: noGate, opsFlags: () => ({ multichain_v6: true }) })
    running(w, v5)
    ready(w)
    chain(w, 7n)
    await expect(w.op.prepareRenew(ctx)).rejects.toThrow(/PauseGate/)
  })
})

// Boot refuses v6 as the default policy (assertBootPolicies, review of PR #141): this checks only the encoding.
describe('a fresh activation on v6 (default policy)', () => {
  test('Start enables the bridge-out grant with the gate and the others with V2, and names the Monad share', async () => {
    const w = world(0n, { policy: v6, v4Policy: v4, v5Policy: v5, v6Policy: v6 })
    w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
    chain(w, 0n)
    const t = await w.op.prepareActivate(ctx).catch((e) => {
      if (e instanceof HttpError) throw new Error(`${e.code}: ${e.message}`)
      throw e
    })
    const held = priv(w.op).prepared.get(t.prepareId)!
    const names = held.grants!.map((g) => g.name)
    const sessions = sessionsOf(held.tx)
    expect(sessions).toHaveLength(names.length)
    names.forEach((name, i) => {
      expect(sessions[i]!.userOp.has(GAS)).toBe(true)
      expect(sessions[i]!.action.has(name === 'bridge-out' ? GATE : V2)).toBe(true)
      expect(sessions[i]!.action.has(name === 'bridge-out' ? V2 : GATE)).toBe(false)
    })
    expect(t.summary.join('\n')).toContain('Growth on Monad')
  })
})
