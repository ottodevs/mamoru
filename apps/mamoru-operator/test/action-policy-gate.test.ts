import { describe, expect, test } from 'bun:test'
import { POLICIES } from '@mamoru/policy'
import { assertApprovable, HttpError } from '../src/operator.ts'
import { ctx, world } from './owner-world.ts'

// Spec 007 (otto/mamoru#151): the operator signs no v4 approval while MamoruActionPolicy is not deployed (and, until
// T7, not after either); v1/v2 approvals go through as before.
describe('v4 approvals are refused (spec 007)', () => {
  test('every policy without an action policy passes; both v4 versions are refused, not deployed', () => {
    for (const p of Object.values(POLICIES)) {
      if (p.actionPolicy) {
        let e: unknown
        try {
          assertApprovable(p)
        } catch (x) {
          e = x
        }
        expect(e, p.policyId).toBeInstanceOf(HttpError)
        expect(e as HttpError).toMatchObject({ status: 503, code: 'ACTION_POLICY_NOT_DEPLOYED' })
      } else expect(() => assertApprovable(p), p.policyId).not.toThrow()
    }
  })

  test('an operator configured with conservador-live-v4 refuses a Start and sends nothing', async () => {
    const w = world(0n, { policy: POLICIES['conservador-live-v4']! })
    const err = await w.op.prepareActivate(ctx).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 503, code: 'ACTION_POLICY_NOT_DEPLOYED' })
    expect(w.sent).toHaveLength(0)
  })

  test('the same operator on conservador-live-v2 prepares the Start as before', async () => {
    const w = world(0n, { policy: POLICIES['conservador-live-v2']! })
    const tx = await w.op.prepareActivate(ctx)
    expect(tx.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
