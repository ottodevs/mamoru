// otto/mamoru#214: every grant of the Monad sleeve's v5 policy encodes into a SmartSession against the Monad registry.
import { describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { address, baseRegistry, entry, monadRegistry, type Registry } from '@mamoru/registry'
import { computeCaps, decodeMamoruInit, grantKey, instantiateGrant, liveWmonUsdcMonadV5, MONAD_GAS_CAPS, policyRegistry, retargetToPolicy, v4BudgetCaps, V4_POOLS_MONAD, type SessionGrant } from '@mamoru/policy'
import { toSmartSession, v4PoliciesFor, type V4Deployment } from './index.ts'

// The registry writeRegistry builds for Monad: pinned entries plus the two session policies at Base's address.
const monadWrite: Registry = { ...monadRegistry, entries: [...monadRegistry.entries, ...['TimeFramePolicy', 'UsageLimitPolicy'].map((n) => ({ ...entry(n, baseRegistry) }))] }

const d: V4Deployment = {
  actionPolicy: getAddress('0x00000000000000000000000000000000000000Fe'),
  gasPolicy: getAddress('0x00000000000000000000000000000000000000Fd'),
  gasCaps: MONAD_GAS_CAPS,
}
const CAP = 10_000n * 1_000_000n
const caps = computeCaps(liveWmonUsdcMonadV5, CAP, { WMON: { num: 1n, den: 1n } })
const ctx = { account: '0x00000000000000000000000000000000000000aa' as const, sessionKey: '0x00000000000000000000000000000000000000bb' as const, chainId: 143, salt: `0x${'00'.repeat(32)}` as const, validAfter: 0, validUntil: 1, caps }
const grants = (): SessionGrant[] => liveWmonUsdcMonadV5.session.grants.map((t) => retargetToPolicy(instantiateGrant(liveWmonUsdcMonadV5, grantKey(t), ctx), d.actionPolicy, policyRegistry(liveWmonUsdcMonadV5)))

describe('Monad sleeve sessions', () => {
  test('toSmartSession encodes each grant against the Monad registry with the Monad pool in its Init', () => {
    const gs = grants()
    const pf = v4PoliciesFor(gs, d, 1n, v4BudgetCaps(liveWmonUsdcMonadV5, CAP), {}, monadWrite)
    for (const [i, g] of gs.entries()) {
      const p = pf(g, i)!
      const init = decodeMamoruInit((p as { initData: `0x${string}` }).initData)
      expect(init.pool.toLowerCase()).toBe(address('pool:WMON/USDC/3000', monadRegistry).toLowerCase())
      expect(init.bandTicks).toBe(V4_POOLS_MONAD.growth.bandTicks)
      const s = toSmartSession(g, p, monadWrite)
      expect(s.sessionValidator).toBe(address('OwnableValidator', monadRegistry))
      for (const a of s.actions) {
        expect(a.actionPolicies).toHaveLength(2)
        expect(a.actionPolicies[1]!.policy).toBe(d.actionPolicy)
      }
      expect(s.userOpPolicies.at(-1)!.policy).toBe(d.gasPolicy)
    }
  })

  test('the guard refuses a Monad grant against the Base registry (default), and a Base pool Init for a Monad grant', () => {
    const gs = grants()
    const pf = v4PoliciesFor(gs, d, 1n, v4BudgetCaps(liveWmonUsdcMonadV5, CAP), {}, monadWrite)
    expect(() => toSmartSession(gs[0]!, pf(gs[0]!, 0))).toThrow()
    // v4PoliciesFor on the default (Base) registry finds no Base pool for the Monad grant.
    expect(() => v4PoliciesFor(gs, d, 1n, {})(gs[0]!, 0)).toThrow('no v4 pool parameters')
  })
})
