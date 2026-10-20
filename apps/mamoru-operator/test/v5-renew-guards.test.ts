// otto/mamoru#151, GPT-6 review of the v2 TS diffs (part 3, two P1s): a v5 renewal is never prepared without knowing
// whether a guardian paused the account, and a prepared renewal is never sent when the row now offers another policy.
import { describe, expect, test } from 'bun:test'
import type { Hex } from '@mamoru/domain'
import { V4_GAS_CAPS, V4_POOLS, conservadorLiveV4, conservadorLiveV5, grantKey, withActionPolicy, type PolicyVersion } from '@mamoru/policy'
import { HttpError, renewPolicyOf, type Operator } from '../src/operator.ts'
import type { AccountState } from '../src/state.ts'
import { ctx, sign, world } from './owner-world.ts'

const V1 = `0x${'11'.repeat(20)}` as Hex
const V2 = `0x${'33'.repeat(20)}` as Hex
const GAS = `0x${'22'.repeat(20)}` as Hex
const v4 = withActionPolicy(conservadorLiveV4, V1, Object.values(V4_POOLS), { gasPolicy: { address: GAS, caps: V4_GAS_CAPS } })
const v5 = withActionPolicy(conservadorLiveV5, V2, Object.values(V4_POOLS), { gasPolicy: { address: GAS, caps: V4_GAS_CAPS }, contractVersion: 2 })

type Privates = {
  settleRenewals(a: AccountState): Promise<void>
  assertRenewable(a: AccountState): void
  readOf(a: AccountState, safe: Hex): Promise<{ block: bigint }>
  fitV4(...args: unknown[]): Promise<never>
  prepared: Map<string, Record<string, unknown>>
}
const priv = (op: Operator) => op as unknown as Privates

/** A running account holding every grant of `policy` (nothing missing: a renewal, not an extension). */
function running(w: ReturnType<typeof world>, policyId: string, policy: PolicyVersion = policyId.includes('v5') ? v5 : v4): AccountState {
  const grants = policy.session.grants.map((g, i) => ({ name: grantKey(g), permissionId: `0x${i.toString(16).padStart(64, '0')}`, grant: { policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } }))
  const acc = { accountKey: 'k', ctx, active: true, trusted: true, policyId, grants, ops: [], revoked: [] } as unknown as AccountState
  w.state.accounts.k = acc
  return acc
}

async function code(f: () => Promise<unknown>): Promise<string> {
  try {
    await f()
  } catch (e) {
    if (e instanceof HttpError) return e.code
    throw e
  }
  return 'OK'
}

describe('a v5 renewal fails closed when the guardian pause cannot be read (P1)', () => {
  test('isPaused unreadable: PAUSE_STATE_UNAVAILABLE (503, retryable), nothing fitted or held', async () => {
    const w = world(0n, { v4Policy: v4, v5Policy: v5 })
    const acc = running(w, 'conservador-live-v5')
    const p = priv(w.op)
    p.settleRenewals = async () => {}
    p.assertRenewable = () => {}
    p.readOf = async () => ({ block: 100n })
    let fitted = false
    p.fitV4 = async () => {
      fitted = true
      throw new Error('not reached')
    }
    // owner-world's chain throws on any read it does not know: isPaused is one.
    expect(await code(() => w.op.prepareRenew(ctx))).toBe('PAUSE_STATE_UNAVAILABLE')
    expect(fitted).toBe(false)
    expect(p.prepared.size).toBe(0)
    expect(acc.policyId).toBe('conservador-live-v5')
  })

  test('a v4 account (V1 has no pause) reads nothing and goes on to fit the renewal', async () => {
    const w = world(0n, { v4Policy: v4 })
    running(w, 'conservador-live-v4')
    const p = priv(w.op)
    p.settleRenewals = async () => {}
    p.assertRenewable = () => {}
    p.readOf = async () => ({ block: 100n })
    p.fitV4 = async () => {
      throw new HttpError(409, 'FITTED', 'reached the fit')
    }
    expect(await code(() => w.op.prepareRenew(ctx))).toBe('FITTED')
  })
})

describe('a prepared renewal is sent only for the policy the row offers now (P1)', () => {
  test('a v4 move prepared, then the v5 flag on: submit refuses APPROVAL_TARGET_CHANGED and drops it', async () => {
    const flags: Record<string, boolean> = { onchain_action_policy_v4: true }
    const w = world(0n, { v4Policy: v4, v5Policy: v5, opsFlags: () => flags })
    const acc = running(w, 'conservador-live-v2')
    expect(w.op.renewTarget(acc)).toBe('conservador-live-v4')
    const p = priv(w.op)
    p.prepared.set('pv4', { prepareId: 'pv4', accountKey: 'k', kind: 'renew', safeTxHash: `0x${'00'.repeat(32)}`, expires: Date.now() + 60_000, policyId: 'conservador-live-v4', safe: ctx.address.toLowerCase() })
    flags.onchain_action_policy_v5 = true
    expect(w.op.renewTarget(acc)).toBe('conservador-live-v5')
    const body = { ...sign({ safe: ctx.address, chainId: 8453, safeTxHash: `0x${'00'.repeat(32)}`, summary: [], expiresAt: '', prepareId: 'pv4' }) }
    expect(await code(() => w.op.submit(ctx, 'renew', body))).toBe('APPROVAL_TARGET_CHANGED')
    expect(p.prepared.has('pv4')).toBe(false)
    expect(w.sent).toHaveLength(0)
  })

  test('the same policy still offered: not refused for its target (it goes on to the signature check)', async () => {
    const flags: Record<string, boolean> = { onchain_action_policy_v4: true }
    const w = world(0n, { v4Policy: v4, v5Policy: v5, opsFlags: () => flags })
    running(w, 'conservador-live-v2')
    const p = priv(w.op)
    p.prepared.set('pv4', { prepareId: 'pv4', accountKey: 'k', kind: 'renew', safeTxHash: `0x${'00'.repeat(32)}`, expires: Date.now() + 60_000, policyId: 'conservador-live-v4', safe: ctx.address.toLowerCase() })
    const r = await code(() => w.op.submit(ctx, 'renew', { prepareId: 'pv4', authenticatorData: '', clientDataJSON: '', signature: '' }))
    expect(r).not.toBe('APPROVAL_TARGET_CHANGED')
  })

  test('renewPolicyOf: one policy per renewal; mixed grants are never held for signing', () => {
    const g = (policyId: string) => ({ grant: { policyId } }) as never
    expect(renewPolicyOf([g('conservador-live-v5'), g('conservador-live-v5')])).toBe('conservador-live-v5')
    expect(renewPolicyOf([])).toBeUndefined()
    expect(() => renewPolicyOf([g('conservador-live-v4'), g('conservador-live-v5')])).toThrow('mixes policies')
  })
})

describe('a full v5 renewal reads the pause again at submit (GPT-6 round 2, P1)', () => {
  /** A v5 account, a prepared renewal of it (as planRenew holds one), and the pause read `isPaused` answers. */
  function preparedV5(pausedWarned: boolean, answer: () => boolean) {
    const w = world(0n, { v4Policy: v4, v5Policy: v5 })
    const acc = running(w, 'conservador-live-v5')
    const p = priv(w.op)
    p.prepared.set('pr', { prepareId: 'pr', accountKey: 'k', kind: 'renew', safeTxHash: `0x${'00'.repeat(32)}`, expires: Date.now() + 60_000, policyId: 'conservador-live-v5', move: false, pauseChecked: true, pausedWarned, safe: ctx.address.toLowerCase() })
    const client = (w.op as unknown as { client: { readContract: (a: { functionName: string }) => Promise<unknown> } }).client
    const read = client.readContract
    client.readContract = async (a) => (a.functionName === 'isPaused' ? answer() : read(a))
    return { w, acc, p }
  }
  const body = { prepareId: 'pr', authenticatorData: '', clientDataJSON: '', signature: '' }

  test('paused after a prepare that did not warn: PAUSE_STATE_CHANGED, dropped, nothing sent', async () => {
    const { w, p } = preparedV5(false, () => true)
    expect(await code(() => w.op.submit(ctx, 'renew', body))).toBe('PAUSE_STATE_CHANGED')
    expect(p.prepared.has('pr')).toBe(false)
    expect(w.sent).toHaveLength(0)
  })

  test('the prepared warning matches the pause now (paused and warned, or not paused): it goes on to the signature check', async () => {
    for (const [warned, paused] of [[true, true], [false, false], [true, false]] as const) {
      const { w, p } = preparedV5(warned, () => paused)
      const r = await code(() => w.op.submit(ctx, 'renew', body))
      expect(r).not.toBe('PAUSE_STATE_CHANGED')
      expect(r).not.toBe('PAUSE_STATE_UNAVAILABLE')
      expect(r).toBe('BAD_SIGNATURE')
      expect(p.prepared.has('pr')).toBe(true)
    }
  })

  test('the pause cannot be read at submit: PAUSE_STATE_UNAVAILABLE (retryable), kept, nothing sent', async () => {
    const { w, p } = preparedV5(false, () => {
      throw new Error('HTTP request failed. Status: 503')
    })
    expect(await code(() => w.op.submit(ctx, 'renew', body))).toBe('PAUSE_STATE_UNAVAILABLE')
    expect(p.prepared.has('pr')).toBe(true)
    expect(w.sent).toHaveLength(0)
  })
})
