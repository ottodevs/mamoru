// otto/mamoru#225: conservador-live-v7 (v6 in one session per pool) on the Base operator. The renew row offers it behind
// `merged_grants_v7`; a renewal, and the move from any earlier version (v2 to v6), is ONE owner transaction with every
// grant and every revoke, never a later step; over the gas target it is refused (RENEWAL_TOO_LARGE), never split. Fake
// deployed addresses, as v6-operator.test.ts.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, parseAbi, slice, type Hex } from 'viem'
import { address as registryAddress, baseRegistry, smartSessionAbi } from '@mamoru/registry'
import { POLICIES, V4_TX_GAS_TARGET, grantKey, type PolicyVersion } from '@mamoru/policy'
import { resolveV4Policy, resolveV5Policy, resolveV6Policy, resolveV7Policy } from '../src/boot.ts'
import type { Operator } from '../src/operator.ts'
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
const v7 = resolveV7Policy('base', env)!
const SMART_SESSION = registryAddress('SmartSession', baseRegistry).toLowerCase()
const UNI = registryAddress('UniActionPolicy', baseRegistry).toLowerCase()

type Held = { grants?: { name: string; permissionId: Hex }[]; revokes?: Hex[]; tx: { to: string; data: Hex } }
type Privates = { prepared: Map<string, Held>; client: { readContract: (a: { functionName: string; args?: readonly unknown[] }) => Promise<unknown> }; ownerTxGasLimit: (...a: unknown[]) => Promise<bigint | null> }
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

/** The SmartSession calls of the owner transaction: removeSession ids, and the sessions enableSessions enables. */
function smartSessionCalls(tx: { to: string; data: Hex }) {
  const calls = (tx.data.startsWith('0x8d80ff0a') ? unpack(tx.data) : [tx]).filter((c) => c.to.toLowerCase() === SMART_SESSION).map((c) => decodeFunctionData({ abi: smartSessionAbi, data: c.data }))
  const enables = calls.filter((d) => d.functionName === 'enableSessions')
  const removed = calls.filter((d) => d.functionName === 'removeSession').map((d) => d.args![0] as Hex)
  return { enables, removed, sessions: enables.flatMap((e) => e.args![0] as unknown as { actions: { actionTargetSelector: Hex; actionPolicies: { policy: string }[] }[] }[]) }
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

function running(w: ReturnType<typeof world>, policy: PolicyVersion, only?: (name: string) => boolean): AccountState {
  const grants = policy.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ name: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(64, '0')}`, grant: { policyId: policy.policyId, pool: g.pool, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } })).filter((g) => !only || only(g.name))
  const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: policy.policyId, grants, ops: [], revoked: [] } as unknown as AccountState
  w.state.accounts.k = acc
  return acc
}

function ready(w: ReturnType<typeof world>): void {
  const p = priv(w.op) as unknown as Record<string, unknown>
  p.settleRenewals = async () => {}
  p.assertRenewable = () => {}
  p.readOf = async () => ({ block: 100n, deployed: true, usdc: 0n, eth: 0n })
}

const cfg = (flags: Record<string, boolean>) => ({ v4Policy: v4, v5Policy: v5, v6Policy: v6, v7Policy: v7, opsFlags: () => flags })

describe('boot wiring', () => {
  test('v7 is wired exactly like v6 (V2, gas policy, gate) and needs the same environment', () => {
    expect(v7.policyId).toBe('conservador-live-v7')
    expect(v7.actionPolicy).toMatchObject({ address: V2, contractVersion: 2, gasPolicy: { address: GAS } })
    expect(v7.actionPolicy!.pauseGate!.toLowerCase()).toBe(GATE)
    expect(resolveV7Policy('base', { ...env, MAMORU_PAUSE_GATE_ADDRESS: undefined })).toBeUndefined()
    expect(resolveV7Policy('base', { ...env, MAMORU_ONCHAIN_POLICY_V4: undefined })).toBeUndefined()
    expect(resolveV7Policy('monad', env)).toBeUndefined()
  })
})

describe('the renew row offers v7 only behind merged_grants_v7', () => {
  test('flag on: v2-v6 accounts go to v7, ahead of v6; flag off: unchanged', () => {
    for (const from of [POLICIES['conservador-live-v2']!, v4, v5, v6]) {
      const on = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true, onchain_action_policy_v5: true }))
      expect(on.op.renewTarget(running(on, from))).toBe('conservador-live-v7')
      const off = world(0n, cfg({ multichain_v6: true }))
      expect(off.op.renewTarget(running(off, from))).toBe('conservador-live-v6')
    }
  })

  test('v7 not configured: never offered; an account on v7 renews as v7', () => {
    const w = world(0n, { v4Policy: v4, v5Policy: v5, v6Policy: v6, opsFlags: () => ({ merged_grants_v7: true }) })
    expect(w.op.renewTarget(running(w, v5))).toBe('conservador-live-v5')
    const on = world(0n, cfg({ merged_grants_v7: true }))
    expect(on.op.renewTarget(running(on, v7))).toBe('conservador-live-v7')
  })
})

describe('owner transactions of a v7 approval: one each', () => {
  for (const [label, from] of [['v6 (8 sessions)', v6], ['v5 (9 sessions)', v5], ['v2 (12 sessions)', POLICIES['conservador-live-v2']!]] as const) {
    test(`the move from ${label}: every old grant revoked and every v7 session enabled in ONE transaction, no later step`, async () => {
      const w = world(0n, cfg({ merged_grants_v7: true }))
      const acc = running(w, from)
      ready(w)
      chain(w, 7n)
      const t = await w.op.prepareRenew(ctx)
      expect(t.policyId).toBe('conservador-live-v7')
      expect(t.move).toBe(true)
      const held = priv(w.op).prepared.get(t.prepareId)!
      expect(held.grants!.map((g) => g.name)).toEqual([`manage-any:pool:USDC/USDT/100`, `manage-any:pool:WETH/USDC/3000`, `manage-any:pool:USDC/cbBTC/500`, 'bridge-out'])
      const { enables, removed, sessions } = smartSessionCalls(held.tx)
      expect(enables).toHaveLength(1)
      expect(sessions).toHaveLength(4)
      expect(new Set(removed.map((r) => r.toLowerCase()))).toEqual(new Set(acc.grants.map((g) => g.permissionId.toLowerCase())))
      // decrease / collect / burn / deadline carry V2 alone; bridge-out the gate.
      for (const s of sessions.slice(0, 3)) {
        for (const a of s.actions) {
          const named = a.actionPolicies.map((p) => p.policy.toLowerCase())
          expect(named.at(-1)).toBe(V2)
          if (['0x0c49ccbe', '0xfc6f7865', '0x42966c68', '0x5ae401dc'].includes(a.actionTargetSelector)) expect(named).toEqual([V2])
          else expect(named).toEqual([UNI, V2])
        }
      }
      const text = t.summary.join('\n')
      expect(text).not.toMatch(/steps/)
      expect(text).toContain('In USDC/USDT 0.01%: swap USDC and USDT, open, add to, take out, collect and close positions; only within 0.10% of the 30- and 5-minute average price and 0.40% of 1:1')
      expect(text).toMatch(/In WETH\/USDC 0\.30%: swap USDC and WETH, .*; at most 36,000 transactions/)
      expect(text).toMatch(/In USDC\/cbBTC 0\.05%: only take out, collect and close positions and sell cbBTC for USDC; nothing new goes in; .*; at most 32,000 transactions/)
      expect(text).toContain('Bridge: it may burn USDC')
      // The v6 clause about cbBTC is said once, in its pool's block.
      expect(text.match(/cbBTC/g)!.length).toBe(2)
    })
  }

  test("a v7 account's renewal: its four grants, revoked and enabled again in one transaction", async () => {
    const w = world(0n, cfg({ merged_grants_v7: true }))
    const acc = running(w, v7)
    ready(w)
    chain(w, 7n)
    const t = await w.op.prepareRenew(ctx)
    expect(t.move).toBe(false)
    const held = priv(w.op).prepared.get(t.prepareId)!
    const { removed, sessions } = smartSessionCalls(held.tx)
    expect(sessions).toHaveLength(4)
    expect(removed).toHaveLength(acc.grants.length)
  })

  test('over V4_TX_GAS_TARGET by simulation: RENEWAL_TOO_LARGE, nothing held, never split', async () => {
    const w = world(0n, cfg({ merged_grants_v7: true }))
    running(w, v5)
    ready(w)
    chain(w, 7n)
    priv(w.op).ownerTxGasLimit = async () => V4_TX_GAS_TARGET + 1n
    await expect(w.op.prepareRenew(ctx)).rejects.toMatchObject({ code: 'RENEWAL_TOO_LARGE' })
    expect(priv(w.op).prepared.size).toBe(0)
    // At the target it goes, as one transaction.
    priv(w.op).ownerTxGasLimit = async () => V4_TX_GAS_TARGET
    const t = await w.op.prepareRenew(ctx)
    expect(smartSessionCalls(priv(w.op).prepared.get(t.prepareId)!.tx).sessions).toHaveLength(4)
  })
})
