// otto/mamoru#151, GPT-6 review of the v2 TS diffs (part 3, P1): a v5 renewal is never prepared without knowing
// whether a guardian paused the account.
import { describe, expect, test } from 'bun:test'
import type { Hex } from '@mamoru/domain'
import { V4_GAS_CAPS, V4_POOLS, conservadorLiveV4, conservadorLiveV5, grantKey, withActionPolicy, type PolicyVersion } from '@mamoru/policy'
import { HttpError, type Operator } from '../src/operator.ts'
import type { AccountState } from '../src/state.ts'
import { ctx, world } from './owner-world.ts'

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
