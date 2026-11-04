import { describe, expect, test } from 'bun:test'
import { BASELINE_FRESH_MS, engineBaseline, OBSERVE_FAIL_AFTER, OBSERVE_TIMEOUT_MS, observeTimeout, observeVerdict, type EngineView } from './operator.ts'

// otto/mamoru#369: operator:deploy waits for the engines to observe after the restart and rolls back when they do not.
const T0 = Date.parse('2026-11-04T18:50:00Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()
const ok = (account: string, ms = 30_000): EngineView => ({ account, lastReviewAt: at(ms), lastDecisionCode: 'DECIDE_HOLD', consecutiveErrors: 0, lastErrorClass: null })
const failing = (account: string, n: number, code = 'OBS_RPC_UNAVAILABLE', ms = 60_000): EngineView => ({ account, lastReviewAt: at(ms), lastDecisionCode: code, consecutiveErrors: n, lastErrorClass: 'rpc_other' })
const fresh = (account: string): EngineView => ({ account, lastReviewAt: null, lastDecisionCode: null, consecutiveErrors: 0, lastErrorClass: null })
const MONAD = ['3f9a7c21', '9b0e41aa', 'c0ffee00']

describe('engine baseline before the redeploy', () => {
  test('engines observing now are required; one already failing or not reviewed lately is named, not required', () => {
    const b = engineBaseline([ok('a', -60_000), failing('b', OBSERVE_FAIL_AFTER, 'OBS_RPC_UNAVAILABLE', -30_000), ok('c', -BASELINE_FRESH_MS - 1), fresh('d'), failing('e', 1, 'OBS_RPC_UNAVAILABLE', -10_000)], T0)
    expect([...b.required!].sort()).toEqual(['a', 'e'])
    expect(b.failing).toEqual(['b', 'c', 'd'])
  })
  test('a running operator without engines in /metrics requires every engine', () => {
    expect(engineBaseline(undefined, T0)).toEqual({ required: null, failing: [] })
  })
})

describe('observeVerdict', () => {
  const required = new Set(MONAD)

  test('the 4 Nov incident: every Monad review fails OBS_RPC_UNAVAILABLE after the restart -> fail (rollback)', () => {
    const v = observeVerdict(MONAD.map((a) => failing(a, OBSERVE_FAIL_AFTER)), 3, required, T0, false)
    expect(v.state).toBe('fail')
    expect(v.state === 'fail' && v.why).toContain('3 of 3 engines fail to observe')
    expect(v.state === 'fail' && v.why).toContain('OBS_RPC_UNAVAILABLE')
  })

  test('it fails before the window ends: no need to wait 10 minutes', () => {
    const v = observeVerdict([ok(MONAD[0]!), ok(MONAD[1]!), failing(MONAD[2]!, OBSERVE_FAIL_AFTER)], 3, required, T0, false)
    expect(v.state).toBe('fail')
  })

  test('healthy: every engine reviewed after the restart and reached a decision -> ok', () => {
    expect(observeVerdict(MONAD.map((a) => ok(a)), 3, required, T0, false)).toEqual({ state: 'ok' })
  })

  test('fewer failures than the threshold, or no review yet, waits', () => {
    const v = observeVerdict([ok(MONAD[0]!), failing(MONAD[1]!, OBSERVE_FAIL_AFTER - 1), fresh(MONAD[2]!)], 3, required, T0, false)
    expect(v).toEqual({ state: 'wait', pending: [MONAD[1]!, MONAD[2]!] })
  })

  test('still not observing when the window ends -> fail, naming who', () => {
    const v = observeVerdict([ok(MONAD[0]!), failing(MONAD[1]!, 1), fresh(MONAD[2]!)], 3, required, T0, true)
    expect(v.state).toBe('fail')
    expect(v.state === 'fail' && v.why).toContain(`${MONAD[2]} no review`)
    expect(v.state === 'fail' && v.why).toContain(`${MONAD[1]} 1x OBS_RPC_UNAVAILABLE`)
  })

  test('a review from before the restart does not count', () => {
    const v = observeVerdict([ok(MONAD[0]!, -5_000), ok(MONAD[1]!), ok(MONAD[2]!)], 3, required, T0, false)
    expect(v).toEqual({ state: 'wait', pending: [MONAD[0]!] })
  })

  test('an engine already failing before the redeploy does not block it (nor the rollback that fixes it)', () => {
    const b = engineBaseline([ok('a', -20_000), failing('b', 9, 'OBS_RPC_UNAVAILABLE', -20_000)], T0)
    expect(observeVerdict([ok('a'), failing('b', 12)], 2, b.required, T0, false)).toEqual({ state: 'ok' })
    // An explicit --rollback away from the 4 Nov sha: nothing observed before, so nothing is required but the boot.
    const broken = engineBaseline(MONAD.map((a) => failing(a, 30, 'OBS_RPC_UNAVAILABLE', -10_000)), T0)
    expect(observeVerdict(MONAD.map(fresh), 3, broken.required, T0, false)).toEqual({ state: 'ok' })
  })

  test('a required engine missing from the new boot, or fewer engines than active accounts, is not ok', () => {
    expect(observeVerdict([ok(MONAD[0]!), ok(MONAD[1]!)], 3, required, T0, false).state).toBe('wait')
    expect(observeVerdict([ok(MONAD[0]!), ok(MONAD[1]!)], 3, required, T0, true).state).toBe('fail')
    expect(observeVerdict([ok('a')], 2, null, T0, false).state).toBe('wait')
    expect(observeVerdict(undefined, 1, null, T0, true).state).toBe('fail')
  })

  test('without a baseline every engine is required', () => {
    expect(observeVerdict([ok('a'), failing('b', OBSERVE_FAIL_AFTER)], 2, null, T0, false).state).toBe('fail')
    expect(observeVerdict([ok('a'), ok('b')], 2, null, T0, false)).toEqual({ state: 'ok' })
  })
})

describe('observation window', () => {
  test('default, override and refused values', () => {
    expect(observeTimeout(undefined)).toBe(OBSERVE_TIMEOUT_MS)
    expect(observeTimeout('300000')).toBe(300_000)
    expect(observeTimeout('5m')).toContain('not a number')
    expect(observeTimeout('0')).toContain('outside')
    expect(observeTimeout('3600000')).toContain('outside')
  })
})
