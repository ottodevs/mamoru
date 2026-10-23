import { describe, expect, test } from 'bun:test'
import { ReasonError } from '@mamoru/domain'
import { claimValueMatches, displayValue, isMetricKey, resolveMetric, verdictsComparable, writeVerdictSentence, type MetricKey } from './contract.ts'
import type { RunResult } from './types.ts'

/** A minimal, hand-built RunResult (B-02 shape) — no lab-bench dependency needed for these pure-mapping tests. */
function makeRun(over: Partial<RunResult> = {}): RunResult {
  return {
    specKey: 'fix-full|live|2000|1000',
    spec: { windowId: 'fix-full', base: 'live', widthTicks: 2000, deposit: 1000 },
    variantLabel: 'Política actual',
    policyId: 'conservador-live-v2',
    resultHash: '0xaaa',
    simVersion: 'backtest-1',
    window: { id: 'fix-full', label: 'fixture', regime: 'calm', split: 'train', from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z', market: { note: 'fixture' } },
    deposit: 1000,
    pools: ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'],
    metrics: {
      days: 7,
      end: 983.56,
      net: -16.44,
      hodl: 999.9996,
      vsHodl: -16.44,
      fees: 12.3,
      gas: 1.08,
      timeInRangeBps: 9821,
      maxDrawdownBps: 412,
      returnBps: -164,
      operations: { enter_swap: 3, enter_mint: 3, harvest: 2, rerange: 0 },
    },
    reasons: {},
    ops: [],
    series: [],
    ...over,
  }
}

describe('resolveMetric / displayValue (AL-20a)', () => {
  test('USDC metrics round to 2 decimals', () => {
    const r = makeRun()
    expect(displayValue(resolveMetric(r, 'end')!)).toBe(983.56)
    expect(displayValue(resolveMetric(r, 'net')!)).toBe(-16.44)
    expect(displayValue(resolveMetric(r, 'fees')!)).toBe(12.3)
    expect(displayValue(resolveMetric(r, 'gas')!)).toBe(1.08)
  })

  test('percentage metrics (bps on the run) round to 1 decimal', () => {
    const r = makeRun()
    expect(displayValue(resolveMetric(r, 'timeInRange')!)).toBe(98.2)
    expect(displayValue(resolveMetric(r, 'maxDrawdown')!)).toBe(4.1)
    expect(displayValue(resolveMetric(r, 'return')!)).toBe(-1.6)
  })

  test('vsUsdc is derived (end - deposit), never stored on the run', () => {
    const r = makeRun({ metrics: { ...makeRun().metrics, end: 1050.2 }, deposit: 1000 })
    expect(displayValue(resolveMetric(r, 'vsUsdc')!)).toBe(50.2)
  })

  test('operations.<kind> resolves only for a kind this run actually counted — never defaults a typo to zero', () => {
    const r = makeRun()
    expect(displayValue(resolveMetric(r, 'operations.harvest')!)).toBe(2)
    expect(displayValue(resolveMetric(r, 'operations.enter_swap')!)).toBe(3)
    expect(resolveMetric(r, 'operations.not_a_real_kind' as MetricKey)).toBeUndefined()
  })

  test('priceMove is unresolvable when the window carries no market stats (the fixture manifest case)', () => {
    const r = makeRun() // window.market = { note: 'fixture' }, no btc field
    expect(resolveMetric(r, 'priceMove')).toBeUndefined()
  })

  test('priceMove reads window.market.btc.move as a percentage when present', () => {
    const r = makeRun({ window: { ...makeRun().window, market: { btc: { move: -0.0687 } } } })
    expect(displayValue(resolveMetric(r, 'priceMove')!)).toBe(-6.9)
  })

  test('isMetricKey accepts the closed base keys and any operations.<kind>, rejects everything else', () => {
    expect(isMetricKey('end')).toBe(true)
    expect(isMetricKey('operations.harvest')).toBe(true)
    expect(isMetricKey('operations.')).toBe(true) // syntactically ok; resolveMetric still rejects it (no such kind)
    expect(isMetricKey('vsHoldPct')).toBe(false)
    expect(isMetricKey('')).toBe(false)
    expect(isMetricKey(42)).toBe(false)
  })
})

describe('claimValueMatches (AL-21: exact, not within a tolerance)', () => {
  test('matches the exact display-rounded value', () => {
    const r = makeRun()
    const info = resolveMetric(r, 'net')!
    expect(claimValueMatches(-16.44, info)).toBe(true)
  })

  test('rejects a value off by more than rounding, even by a small amount', () => {
    const r = makeRun()
    const info = resolveMetric(r, 'net')!
    expect(claimValueMatches(-16.45, info)).toBe(false)
    expect(claimValueMatches(-16.43, info)).toBe(false)
    expect(claimValueMatches(-16.4, info)).toBe(false) // metrics.gas's own value submitted as net (LAB-AL-11 shape)
  })
})

describe('verdictsComparable / writeVerdictSentence (AL-20b, AL-20c)', () => {
  test('a run vs. its own hold/usdc baseline always has a sentence, direction from the sign', () => {
    const r = makeRun() // vsHodl = -16.44 (below hold); end 983.56 < deposit 1000 (below usdc)
    expect(writeVerdictSentence(r, 'hold')).toContain('16.44 USDC por debajo de mantener la mezcla')
    expect(writeVerdictSentence(r, 'usdc')).toContain('16.44 USDC por debajo de quedarte en USDC')
  })

  test('within 0.01 is reported as equal, not a direction', () => {
    const r = makeRun({ metrics: { ...makeRun().metrics, vsHodl: 0.004 } })
    expect(writeVerdictSentence(r, 'hold')).toContain('igual')
  })

  test('two runs sharing window, deposit, savings asset and simVersion are comparable (differ only in policy)', () => {
    const live = makeRun({ resultHash: '0xlive', variantLabel: 'Política actual' })
    const guard = makeRun({ resultHash: '0xguard', spec: { ...live.spec, base: 'guard' }, policyId: 'conservador-lab-guards-v1', variantLabel: 'Con guarda de caídas', metrics: { ...live.metrics, end: 990, vsHodl: -9.99 } })
    expect(verdictsComparable(live, guard)).toBe(true)
    const sentence = writeVerdictSentence(live, guard.resultHash, guard)
    expect(sentence).toContain('Con guarda de caídas')
  })

  test('LAB-AL-15: different deposits, or different windows, are LAB_VERDICT_INCOMPARABLE', () => {
    const a = makeRun({ resultHash: '0xa', deposit: 1000 })
    const bigger = makeRun({ resultHash: '0xb', deposit: 5000 })
    expect(verdictsComparable(a, bigger)).toBe(false)
    expect(() => writeVerdictSentence(a, bigger.resultHash, bigger)).toThrow(ReasonError)

    const otherWindow = makeRun({ resultHash: '0xc', window: { ...a.window, id: 'fix-other' } })
    expect(verdictsComparable(a, otherWindow)).toBe(false)
  })
})
