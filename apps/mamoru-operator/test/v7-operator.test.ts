// otto/mamoru#225: conservador-live-v7 (v6 in one session per pool) on the Base operator. The renew row offers it behind
// `merged_grants_v7`; a renewal, and the move from any earlier version (v2 to v6), is ONE owner transaction with every
// grant and every revoke, never a later step; over the gas target it is refused (RENEWAL_TOO_LARGE), never split. Fake
// deployed addresses, as v6-operator.test.ts.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, parseAbi, slice, type Hex } from 'viem'
import { address as registryAddress, baseRegistry, smartSessionAbi } from '@mamoru/registry'
import { POLICIES, V4_TX_GAS_TARGET, grantKey, type PolicyVersion } from '@mamoru/policy'
import { resolveV4Policy, resolveV5Policy, resolveV6Policy, resolveV7Policy } from '../src/boot.ts'
import { HttpError, type Operator } from '../src/operator.ts'
import type { AccountState } from '../src/state.ts'
import { ctx, SAFE, world } from './owner-world.ts'

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
    // Admitted positions: WETH/USDC 0.30 %, owned by the Safe.
    if (a.functionName === 'ownerOf') return SAFE
    if (a.functionName === 'positions') return [0n, `0x${'00'.repeat(20)}`, registryAddress('WETH', baseRegistry), registryAddress('USDC', baseRegistry), 3000, -100, 100, 1n, 0n, 0n, 0n, 0n]
    return base(a)
  }
}

/** `positions`: per-position `manage:<tokenId>` grants the account also holds (legacy v2/v3 accounts), each admitted. */
function running(w: ReturnType<typeof world>, policy: PolicyVersion, only?: (name: string) => boolean, positions: bigint[] = []): AccountState {
  const grants = policy.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ name: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(64, '0')}`, grant: { policyId: policy.policyId, pool: g.pool, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } })).filter((g) => !only || only(g.name))
  const manage = positions.map((id, i) => ({ name: `manage:${id}`, permissionId: `0x${(0x100 + i).toString(16).padStart(64, '0')}`, grant: { policyId: policy.policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } }))
  const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId: policy.policyId, grants: [...grants, ...manage], ops: [], revoked: [], ...(positions.length ? { admittedTokenIds: positions.map(String) } : {}) } as unknown as AccountState
  w.state.accounts.k = acc
  return acc
}

function ready(w: ReturnType<typeof world>): void {
  const p = priv(w.op) as unknown as Record<string, unknown>
  p.settleRenewals = async () => {}
  p.assertRenewable = () => {}
  p.readOf = async () => ({ block: 100n, deployed: true, usdc: 0n, eth: 0n })
}

/**
 * The owner transaction's gas limit as a function of what it carries, shaped like t11's measurements (enable ~0.5M per
 * action, a removeSession ~0.3M before its refund, plus a fixed part): v7 from v6 (8 revokes) fits 16.2M, v7 from a v2
 * account with 12 grants plus per-position ones does not; v6's own split always finds a prefix.
 */
function gasModel(w: ReturnType<typeof world>): { limits: bigint[] } {
  const seen = { limits: [] as bigint[] }
  priv(w.op).ownerTxGasLimit = async (...a: unknown[]) => {
    const calls = (a[1] as { to: string; data: Hex }[]).filter((c) => c.to.toLowerCase() === SMART_SESSION).map((c) => decodeFunctionData({ abi: smartSessionAbi, data: c.data }))
    const actions = calls.filter((d) => d.functionName === 'enableSessions').flatMap((e) => e.args![0] as unknown as { actions: unknown[] }[]).reduce((n, s) => n + s.actions.length, 0)
    const removes = calls.filter((d) => d.functionName === 'removeSession').length
    const gas = 500_000n + 500_000n * BigInt(actions) + 300_000n * BigInt(removes)
    seen.limits.push(gas)
    return gas
  }
  return seen
}

const cfg = (flags: Record<string, boolean>, scope: string[] | null = null) => ({ v4Policy: v4, v5Policy: v5, v6Policy: v6, v7Policy: v7, opsFlags: () => flags, opsScopedFlags: () => (flags.multichain_v6 ? { multichain_v6: scope } : {}) })

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

  test('v7 bridges like v6: its flag alone offers nothing outside the multichain_v6 scope (#217)', () => {
    const none = world(0n, cfg({ merged_grants_v7: true, onchain_action_policy_v5: true }))
    expect(none.op.renewTarget(running(none, v5))).toBe('conservador-live-v5')
    const other = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true, onchain_action_policy_v5: true }, ['0x0000000000000000000000000000000000000001']))
    expect(other.op.renewTarget(running(other, v5))).toBe('conservador-live-v5')
  })

  test('v7 not configured: never offered; an account on v7 renews as v7', () => {
    const w = world(0n, { v4Policy: v4, v5Policy: v5, v6Policy: v6, opsFlags: () => ({ merged_grants_v7: true }) })
    expect(w.op.renewTarget(running(w, v5))).toBe('conservador-live-v5')
    const on = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
    expect(on.op.renewTarget(running(on, v7))).toBe('conservador-live-v7')
  })
})

describe('owner transactions of a v7 approval: one each', () => {
  for (const [label, from] of [['v6 (8 sessions)', v6], ['v5 (9 sessions)', v5], ['v2 (12 sessions)', POLICIES['conservador-live-v2']!]] as const) {
    test(`the move from ${label}: every old grant revoked and every v7 session enabled in ONE transaction, no later step`, async () => {
      const w = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
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
      expect(text).toContain('In USDC/USDT 0.01%: swap USDC and USDT; open, add to, take out, collect and close positions; within 0.10% of the 30- and 5-minute average price and 0.40% of 1:1; swaps and new positions worth at most')
      expect(text).toMatch(/In WETH\/USDC 0\.30%: swap USDC and WETH; .*; 36,000 transactions at most/)
      expect(text).toMatch(/In USDC\/cbBTC 0\.05%: wind down only \(take out, collect and close positions, sell cbBTC for USDC\); .*; sales worth at most .*; 32,000 transactions at most/)
      expect(text).not.toContain('instead of opening another one')
      expect(text).toContain('Bridge: it may burn USDC')
      // #41: the move onto MamoruActionPolicyV2 names the guardian pause (toV5 is by contract version, not policy id).
      expect(text).toContain('A guardian key can pause it at any time; that key can never move your funds, and your next renewal ends a pause')
      // The v6 clause about cbBTC is said once, in its pool's block.
      expect(text.match(/cbBTC/g)!.length).toBe(2)
    })
  }

  test("a v7 account's renewal: its four grants, revoked and enabled again in one transaction", async () => {
    const w = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
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

  test('within the renewal budget (16.2M) but over V4_TX_GAS_TARGET: one transaction, not split', async () => {
    const w = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
    running(w, v5)
    ready(w)
    chain(w, 7n)
    // Over V4_TX_GAS_TARGET (where fitV4 would cut) but within the budget it goes, as one transaction: a move revokes the
    // old set in the same transaction (t11: 15.6M from a 9-session v5 account, 16.1M from a 12-session v2 one).
    priv(w.op).ownerTxGasLimit = async () => V4_TX_GAS_TARGET + 1_600_000n
    const t = await w.op.prepareRenew(ctx)
    expect(t.policyId).toBe('conservador-live-v7')
    expect(smartSessionCalls(priv(w.op).prepared.get(t.prepareId)!.tx).sessions).toHaveLength(4)
  })

  test("a v7 account's own renewal over the budget has nothing to fall back to: RENEWAL_TOO_LARGE, nothing held", async () => {
    const w = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
    running(w, v7)
    ready(w)
    chain(w, 7n)
    priv(w.op).ownerTxGasLimit = async () => 16_200_001n
    await expect(w.op.prepareRenew(ctx)).rejects.toMatchObject({ code: 'RENEWAL_TOO_LARGE' })
    expect(priv(w.op).prepared.size).toBe(0)
  })
})

describe('a v7 move that does not fit one transaction falls back, never leaves the account stuck', () => {
  const v2 = POLICIES['conservador-live-v2']!

  test('legacy v2 with per-position manage grants and admitted positions: the v6 move instead, every old grant revoked, split as v6 is', async () => {
    const w = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
    const acc = running(w, v2, undefined, [101n, 102n])
    ready(w)
    chain(w, 7n)
    const seen = gasModel(w)
    const t = await w.op.prepareRenew(ctx)
    // The v7 attempt was simulated and refused (over 16.2M), then v6 was planned.
    expect(seen.limits[0]!).toBeGreaterThan(16_200_000n)
    expect(t.policyId).toBe('conservador-live-v6')
    expect(t.move).toBe(true)
    const held = priv(w.op).prepared.get(t.prepareId)!
    // The first v6 transaction revokes the whole old set, the per-position grants included.
    expect(new Set(smartSessionCalls(held.tx).removed.map((r) => r.toLowerCase()))).toEqual(new Set(acc.grants.map((g) => g.permissionId.toLowerCase())))
    expect(held.revokes!.length).toBe(acc.grants.length)
    const text = t.summary.join('\n')
    expect(text).toMatch(/takes \d steps/)
    expect(text).toContain('Your 2 open positions stay')
    // The row offers what is signed: renewTarget and the approval view now say v6, and the next tap plans v6 again
    // without trying v7 (no more refused simulations).
    expect(w.op.renewTarget(acc)).toBe('conservador-live-v6')
    const p = priv(w.op) as unknown as Record<string, (...a: unknown[]) => unknown>
    const oneTx = p.oneTxV4!.bind(w.op)
    let v7Tries = 0
    p.oneTxV4 = (...a: unknown[]) => {
      v7Tries++
      return oneTx(...a)
    }
    const again = await w.op.prepareRenew(ctx)
    expect(again.policyId).toBe('conservador-live-v6')
    expect(v7Tries).toBe(0)
  })

  test('the same account without the extra grants fits and moves to v7; a changed grant set tries v7 again', async () => {
    const w = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
    const acc = running(w, v6)
    ready(w)
    chain(w, 7n)
    gasModel(w)
    expect((await w.op.prepareRenew(ctx)).policyId).toBe('conservador-live-v7')
    // A v6 account marked refused (its set then) is offered v7 again once its grants change.
    const big = running(w, v2, undefined, [101n, 102n])
    await w.op.prepareRenew(ctx)
    expect(w.op.renewTarget(big)).toBe('conservador-live-v6')
    big.grants = big.grants.slice(0, 3)
    expect(w.op.renewTarget(big)).toBe('conservador-live-v7')
  })

  test('a v6 account whose v7 move does not fit renews as v6 (its own policy), in as many prompts as v6 takes', async () => {
    const w = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
    const acc = running(w, v6)
    ready(w)
    chain(w, 7n)
    let first = true
    priv(w.op).ownerTxGasLimit = async () => {
      if (first) {
        first = false
        return 16_200_001n
      }
      return 10_000_000n
    }
    const t = await w.op.prepareRenew(ctx)
    expect(t.policyId).toBe('conservador-live-v6')
    expect(t.move).toBe(false)
    expect(w.op.renewTarget(acc)).toBe('conservador-live-v6')
  })

  test('the static estimate (the Safe cannot be simulated) refusing v7 falls back the same way', async () => {
    const w = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
    running(w, v2, undefined, [101n, 102n])
    ready(w)
    chain(w, 7n)
    priv(w.op).ownerTxGasLimit = async () => null
    // activationGasOf: the per-call simulation fails too, so both v7 and v6 are sized by the static model.
    ;(priv(w.op) as unknown as Record<string, unknown>).activationGasOf = async (_l: unknown, _c: unknown, sessions: number) => ({ gas: sessions === 4 ? 17_000_000n : 1_000_000n + BigInt(sessions) * 1_500_000n, simulated: false })
    const t = await w.op.prepareRenew(ctx).catch((e) => {
      if (e instanceof HttpError) throw new Error(`${e.code}: ${e.message}`)
      throw e
    })
    expect(t.policyId).toBe('conservador-live-v6')
  })
})

describe('a fresh activation on v7 (default policy) that does not fit one transaction', () => {
  test('starts on v6 instead, in as many prompts as v6 takes', async () => {
    const w = world(0n, { ...cfg({ merged_grants_v7: true, multichain_v6: true }), policy: v7 })
    w.state.accounts.k = { accountKey: 'k', ctx, active: false, trusted: false, grants: [], ops: [], revoked: [] } as unknown as AccountState
    chain(w, 0n)
    const seen = gasModel(w)
    // Above the activation budget (15M) for v7's 26 actions; v6's split fits.
    priv(w.op).ownerTxGasLimit = async (...a: unknown[]) => {
      const calls = (a[1] as { to: string; data: Hex }[]).filter((c) => c.to.toLowerCase() === SMART_SESSION).map((c) => decodeFunctionData({ abi: smartSessionAbi, data: c.data }))
      const actions = calls.filter((d) => d.functionName === 'enableSessions').flatMap((e) => e.args![0] as unknown as { actions: unknown[] }[]).reduce((n, s) => n + s.actions.length, 0)
      const gas = 2_000_000n + 550_000n * BigInt(actions)
      seen.limits.push(gas)
      return gas
    }
    const t = await w.op.prepareActivate(ctx).catch((e) => {
      if (e instanceof HttpError) throw new Error(`${e.code}: ${e.message}`)
      throw e
    })
    expect(seen.limits[0]!).toBeGreaterThan(15_000_000n)
    // v6's grant names (enter-swap / enter-mint per pool), not v7's merged sessions.
    expect(priv(w.op).prepared.get(t.prepareId)!.grants!.some((g) => g.name.startsWith('enter-'))).toBe(true)
    expect(t.summary.join('\n')).toMatch(/takes \d steps/)
  })
})

describe('the renew row on a v7 account', () => {
  test("a spent pool session says the engine stopped working there (action 'all'), not only re-ranging", () => {
    const w = world(0n, cfg({ merged_grants_v7: true, multichain_v6: true }))
    const acc = running(w, v7)
    const g = (acc.grants as unknown as { name: string; permissionId: Hex }[])[1]!
    ;(acc as unknown as { ops: unknown[] }).ops = [{ opId: 'eng-1', state: 'confirmed', permissionId: g.permissionId }]
    expect(w.op.usageView(acc)).toEqual({ action: 'all', pool: 'pool:WETH/USDC/3000', usedBps: 10_000, spent: true })
  })
})
