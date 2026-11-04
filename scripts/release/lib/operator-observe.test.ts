import { describe, expect, test } from 'bun:test'
import { autoRollbackAllowed, betterPayload, engineAccounts, engineBaseline, hardFailure, OBSERVE_TIMEOUT_MS, observeTimeout, observeVerdict, REGRESSION_REVIEWS, REGRESSION_SPAN_MS, trackEngines, watchedEngines, type EngineTrack, type EngineView } from './operator.ts'

// otto/mamoru#369: operator:deploy watches the engines after the restart and rolls back by itself only on positive
// evidence of a regression.
const T0 = Date.parse('2026-11-04T22:19:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const decided = (account: string, s: number, code = 'DECIDE_HOLD'): EngineView => ({ account, lastReviewAt: at(s), lastDecisionCode: code, consecutiveErrors: 0, lastErrorClass: null } as EngineView)
const failed = (account: string, s: number, n: number, code = 'OBS_RPC_UNAVAILABLE'): EngineView => ({ account, lastReviewAt: at(s), lastDecisionCode: code, consecutiveErrors: n, lastErrorClass: 'rpc_other' } as EngineView)
const silent = (account: string): EngineView => ({ account, lastReviewAt: null, lastDecisionCode: null, consecutiveErrors: 0 })

/** Folds polls (each a /metrics `engines`) from a restart at T0; returns the tracks. */
function watch(polls: EngineView[][]): Map<string, EngineTrack> {
  let t = new Map<string, EngineTrack>()
  for (const p of polls) t = trackEngines(t, p, T0)
  return t
}
const MONAD = ['3f9a7c21', '9b0e41aa', 'c0ffee00']

describe('codes', () => {
  test('OBS_* and thrown reviews are hard; waits and holds are not', () => {
    expect(hardFailure('OBS_RPC_UNAVAILABLE')).toBe(true)
    expect(hardFailure('REVIEW_ERROR')).toBe(true)
    expect(hardFailure('EHG_OBSERVATION_STALE')).toBe(false)
    expect(hardFailure('GRANT_CHECK_UNAVAILABLE')).toBe(false)
    expect(hardFailure(null)).toBe(false)
  })
})

describe('baseline', () => {
  test('only engines clean before are watched; failing, never reviewed or malformed ones are named', () => {
    const b = engineBaseline([decided('a', -30), failed('b', -20, 1), silent('c'), { account: 'd', lastReviewAt: at(-5) }, { nope: 1 }])
    expect([...b.required!]).toEqual(['a'])
    expect(b.notRequired).toEqual(['b', 'c', 'd'])
  })
  test('no engines array (a failed fetch, an older operator): no baseline, never "every engine"', () => {
    expect(engineBaseline(undefined).required).toBeNull()
    expect(engineBaseline({}).required).toBeNull()
  })
})

describe('observeVerdict', () => {
  test('no baseline, a partial first answer: one engine published and observed is not ok while 3 are expected', () => {
    const tracks = watch([[decided('a', 10, 'DECIDE_IN_RANGE')]])
    expect(observeVerdict(tracks, new Set(['a']), false, null, 3)).toEqual({ state: 'wait' })
    expect(observeVerdict(tracks, new Set(['a']), true, null, 3).state).toBe('doubt')
    const all = watch([['a', 'b', 'c'].map((x) => decided(x, 10, 'DECIDE_IN_RANGE'))])
    expect(observeVerdict(all, new Set(['a', 'b', 'c']), false, null, 3)).toEqual({ state: 'ok', quiet: [] })
  })

  test('22:19 (fdf04d4, healthy): 11 EHG_OBSERVATION_STALE in ~60 s, then DECIDE_IN_RANGE -> no rollback, ok', () => {
    const polls = Array.from({ length: 11 }, (_, i) => [failed('8b0b4d7f', 5 + i * 5, i + 1, 'EHG_OBSERVATION_STALE')])
    const during = watch(polls)
    expect(observeVerdict(during, new Set(['8b0b4d7f']), false)).toEqual({ state: 'wait' })
    const tracks = watch([...polls, [decided('8b0b4d7f', 62, 'DECIDE_IN_RANGE')]])
    expect(observeVerdict(tracks, new Set(['8b0b4d7f']), false)).toEqual({ state: 'ok', quiet: [] })
    // Even never deciding, STALE alone is a doubt at the deadline, never a regression.
    expect(observeVerdict(watch(Array.from({ length: 40 }, (_, i) => [failed('8b0b4d7f', 5 + i * 6, i + 1, 'EHG_OBSERVATION_STALE')])), new Set(['8b0b4d7f']), true).state).toBe('doubt')
  })

  test('4 Nov (ottodevs/mamoru#281): every Monad engine fails OBS_RPC_UNAVAILABLE every 20 s for 2+ min -> regression', () => {
    const polls = Array.from({ length: 8 }, (_, i) => MONAD.map((a) => failed(a, 1 + i * 20, i + 1)))
    const v = observeVerdict(watch(polls), new Set(MONAD), false)
    expect(v.state).toBe('regression')
    expect(v.state === 'regression' && v.why).toContain('3 of 3')
    expect(v.state === 'regression' && v.why).toContain('OBS_RPC_UNAVAILABLE')
    // Not before the span: five failures in 80 s are not yet evidence.
    expect(observeVerdict(watch(polls.slice(0, 5)), new Set(MONAD), false)).toEqual({ state: 'wait' })
    expect(REGRESSION_REVIEWS).toBeGreaterThanOrEqual(5)
    expect(REGRESSION_SPAN_MS).toBeGreaterThanOrEqual(120_000)
  })

  test('several failed reviews between two polls count by the counter', () => {
    const v = observeVerdict(watch([MONAD.map((a) => failed(a, 5, 1)), MONAD.map((a) => failed(a, 125, 7))]), new Set(MONAD), false)
    expect(v.state).toBe('regression')
  })

  test('only a minority regressed -> not a rollback; a doubt at the deadline', () => {
    const polls = Array.from({ length: 8 }, (_, i) => [failed(MONAD[0]!, 1 + i * 20, i + 1), decided(MONAD[1]!, 2 + i * 20), decided(MONAD[2]!, 3 + i * 20)])
    expect(observeVerdict(watch(polls), new Set(MONAD), false)).toEqual({ state: 'wait' })
    expect(observeVerdict(watch(polls), new Set(MONAD), true).state).toBe('doubt')
  })

  test('a transient blip after observing does not undo it (sticky)', () => {
    const polls = [[decided('a', 5)], ...Array.from({ length: 10 }, (_, i) => [failed('a', 25 + i * 20, i + 1)])]
    expect(observeVerdict(watch(polls), new Set(['a']), false)).toEqual({ state: 'ok', quiet: [] })
  })

  test('a review that decided between two polls counts as observed', () => {
    expect(observeVerdict(watch([[failed('a', 5, 3)], [failed('a', 45, 1)]]), new Set(['a']), false)).toEqual({ state: 'ok', quiet: [] })
  })

  test('a quiet engine (no review since the restart) is a warning at the deadline, not a failure', () => {
    const tracks = watch([[decided('a', 5), silent('b')], [decided('a', 25), { ...decided('b', -60) }]])
    expect(observeVerdict(tracks, new Set(['a', 'b']), false)).toEqual({ state: 'wait' })
    expect(observeVerdict(tracks, new Set(['a', 'b']), true)).toEqual({ state: 'ok', quiet: ['b'] })
  })

  test('P1-1: nothing to watch is never ok: wait, then a doubt at the deadline', () => {
    expect(observeVerdict(new Map(), new Set(), false)).toEqual({ state: 'wait' })
    expect(observeVerdict(new Map(), null, false)).toEqual({ state: 'wait' })
    expect(observeVerdict(new Map(), new Set(), true).state).toBe('doubt')
    expect(observeVerdict(new Map(), null, true).state).toBe('doubt')
  })

  test('P1-1: without a baseline the watched set is the union of every poll; an empty first answer freezes nothing', () => {
    let seen = watchedEngines(null, null, [])
    expect(seen).toBeNull()
    seen = watchedEngines(null, seen, 'not an array')
    expect(seen).toBeNull()
    seen = watchedEngines(null, seen, [failed(MONAD[0]!, 5, 1)])
    seen = watchedEngines(null, seen, [failed(MONAD[1]!, 25, 1)])
    expect([...seen!].sort()).toEqual([MONAD[0]!, MONAD[1]!].sort())
    // The 4 Nov shape behind an empty first poll is still a regression, not "engines observe after 0 s".
    const polls: EngineView[][] = [[], ...Array.from({ length: 8 }, (_, i) => MONAD.map((a) => failed(a, 1 + i * 20, i + 1)))]
    let set: Set<string> | null = null
    for (const p of polls) set = watchedEngines(null, set, p)
    expect(observeVerdict(watch(polls), set, false).state).toBe('regression')
    // With a baseline the set is the baseline's.
    expect([...watchedEngines(new Set(['a']), null, [decided('b', 5)])!]).toEqual(['a'])
  })

  test('P1-2: a fatal-looking line does not hide a regression; without one it is a doubt at the deadline, never an early ok', () => {
    const broken = Array.from({ length: 8 }, (_, i) => MONAD.map((a) => failed(a, 1 + i * 20, i + 1)))
    expect(observeVerdict(watch(broken), new Set(MONAD), false, 'error: unhandled rejection').state).toBe('regression')
    const fine = watch([MONAD.map((a) => decided(a, 5))])
    expect(observeVerdict(fine, new Set(MONAD), false, 'error: unhandled rejection')).toEqual({ state: 'wait' })
    const v = observeVerdict(fine, new Set(MONAD), true, 'error: unhandled rejection')
    expect(v.state === 'doubt' && v.why).toContain('unhandled rejection')
  })
})

describe('P1-3: the baseline payload', () => {
  type P = { operator?: { gitSha: string; accounts?: { active: number } }; engines?: unknown }
  const noOp: P = { engines: [] }
  const noEngines: P = { operator: { gitSha: 'aaaaaaa', accounts: { active: 2 } } }
  const full: P = { operator: { gitSha: 'aaaaaaa', accounts: { active: 3 } }, engines: [decided('a', -5)] }
  test('everything comes from one answer: the one with the operator view, then the one with engines', () => {
    expect(betterPayload<P>(null, noEngines)).toBe(noEngines)
    expect(betterPayload<P>(noOp, noEngines)).toBe(noEngines)
    expect(betterPayload<P>(noEngines, full)).toBe(full)
    expect(betterPayload<P>(full, noEngines)).toBe(full)
    expect(betterPayload<P>(noEngines, null)).toBe(noEngines)
    // No operator view at all: nothing to take (operator-deploy.ts refuses to move).
    expect(betterPayload<P>(null, noOp)).toBeNull()
  })
})

describe('report-only cases (the script never rolls back on these)', () => {
  const autoRollback = (engines: unknown, rollback: boolean) => autoRollbackAllowed(engineBaseline(engines), rollback)
  test('baseline fetch failed: report only, watching what the new boot publishes', () => {
    expect(autoRollback(undefined, false)).toBe(false)
    const polls = Array.from({ length: 8 }, (_, i) => MONAD.map((a) => failed(a, 1 + i * 20, i + 1)))
    const v = observeVerdict(watch(polls), engineAccounts(polls[0]), false)
    expect(v.state).toBe('regression') // reported on #83, exit 1, left in place
  })
  test('--rollback: report only, even with a baseline', () => {
    expect(autoRollback([decided('a', -10)], true)).toBe(false)
    expect(autoRollback([decided('a', -10)], false)).toBe(true)
  })
})

describe('observation window', () => {
  test('default, override and refused values (it must cover the regression span)', () => {
    expect(observeTimeout(undefined)).toBe(OBSERVE_TIMEOUT_MS)
    expect(observeTimeout('300000')).toBe(300_000)
    expect(observeTimeout('5m')).toContain('not a number')
    expect(observeTimeout('60000')).toContain('outside')
    expect(observeTimeout('3600000')).toContain('outside')
  })
})
