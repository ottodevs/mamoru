// otto/mamoru#406: every rerange setting the sweep takes changes what the run does, through the production `decide`.
import { describe, expect, test } from 'bun:test'
import { conservadorLabGeometryV1, type EngineSettings } from '@mamoru/policy'
import { syntheticDataset } from './fixtures.ts'
import { runBacktest } from './run.ts'
import { engineSettingsOf, policyOf, type Variant } from './sweep.ts'

const SLOW = 120_000
/** The risk bucket alone: the stables pool and WETH/USDC at their live 90/10 weights, no BTC pool. */
const RISK = [{ id: 'stables', preference: 9000, pools: ['pool:USDC/USDT/100'] }, { id: 'risk', preference: 1000, pools: ['pool:WETH/USDC/3000'] }]
const DAY = 86_400

/** WETH/USDC swings 1,800 ticks up and down every 12 hours (+/-900 around the start), the other pools flat. */
const swing = syntheticDataset({ samples: 1_440, tick: (k, i) => (k === 2 ? Math.round(900 * Math.sin((2 * Math.PI * i) / 144)) : 0), growth: [1n << 100n, 1n << 100n, 1n << 100n] })
/** A one-way fall of about 30% over 2.4 days (the guard needs a day of history to read a fall), on WETH/USDC. */
const fall = syntheticDataset({ samples: 864, tick: (k, i) => (k === 2 ? Math.round(Math.min(i, 700) * -5) : 0), growth: [1n << 100n, 1n << 100n, 1n << 100n] })

const variant = (name: string, extra: Partial<Variant>): Variant => ({ name, policy: 'conservador-lab-geometry-v1', overrides: { buckets: RISK, range: { widthTicks: 1000 } }, ...extra })
const reranges = (ds: typeof swing, v: Variant): number => runBacktest(ds, policyOf(v), { deposit: 1_000_000_000n, reviewEvery: 1, sessions: 'enforce', sessionRenewal: 'renewed' }).metrics.operations.rerange
const lazy = (extra: object = {}) => ({ mode: 'lazy' as const, edgeBufferTicks: 0, minDwellSeconds: 0, horizonSeconds: DAY, lvrWeightBps: 10_000, costTest: 'off' as const, ...extra })
const engine = (rerange: EngineSettings['rerange']): Partial<EngineSettings> => ({ rerange })

describe('engine settings as a variant', () => {
  test('the policy is the one the operator builds from the same settings', () => {
    const p = policyOf(variant('x', { engine: engine({ ...lazy({ edgeBufferBps: 2500, maxWaitSeconds: 21_600 }), maxPerWeek: 2 }) }))
    expect(p.range.maxPerWeek).toBe(2)
    expect(p.range.lazy).toEqual({ edgeBufferTicks: 0, minDwellSeconds: 0, horizonSeconds: DAY, lvrWeightBps: 10_000, requireCostEstimate: true, edgeBufferBps: 2500, maxWaitSeconds: 21_600, costTest: 'off' })
    expect(policyOf(variant('y', { engine: { guard: { enabled: true, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10_000 } } } })).guards).toEqual({ byBucket: { risk: { fallFreeze: { fallBps: 900, volBps: 10_000 } } } })
  })
  test('settings the operator would refuse are refused', () => {
    expect(() => engineSettingsOf(variant('z', { engine: engine({ ...lazy(), maxPerWeek: 0 }) }))).toThrow('maxPerWeek')
    expect(() => engineSettingsOf(variant('z', { engine: engine({ ...lazy({ maxWaitSeconds: 10 }) }) }))).toThrow('maxWaitSeconds')
  })
  test('typed overrides take the optional lazy keys and maxPerWeek; a typo is still refused', () => {
    const p = policyOf({ name: 'o', policy: 'conservador-lab-geometry-v1', overrides: { range: { maxPerWeek: 3, lazy: { edgeBufferTicks: 0, minDwellSeconds: 0, horizonSeconds: DAY, lvrWeightBps: 1, costTest: 'off', maxWaitSeconds: 3600 } } } })
    expect(p.range.maxPerWeek).toBe(3)
    expect(p.range.lazy?.costTest).toBe('off')
    expect(() => policyOf({ name: 'o', policy: 'conservador-lab-geometry-v1', overrides: { range: { lazy: { edgeBufferTicks: 0, minDwellSeconds: 0, horizonSeconds: 1, lvrWeightBps: 1, costTest: 'maybe' } } } })).toThrow('veto | off')
  })
  test('no engine and no overrides is still the base policy', () => {
    expect(policyOf({ name: 'conservador-lab-geometry-v1', policy: 'conservador-lab-geometry-v1' })).toBe(conservadorLabGeometryV1)
  })
})

describe('each rerange setting changes the run', () => {
  test(
    'maxPerWeek: 1 re-range a week against none: the cap is honoured by the simulator',
    () => {
      const free = reranges(swing, variant('free', { engine: engine(lazy()) }))
      const one = reranges(swing, variant('one', { engine: engine({ ...lazy(), maxPerWeek: 1 }) }))
      const three = reranges(swing, variant('three', { engine: engine({ ...lazy(), maxPerWeek: 3 }) }))
      expect(free).toBeGreaterThan(8)
      // Five days of the swing: at most 1 per 7 days, so one in the whole run; three per week at most 3.
      expect(one).toBeLessThanOrEqual(1)
      expect(three).toBeLessThanOrEqual(3)
      expect(one).toBeLessThan(three)
      expect(three).toBeLessThan(free)
    },
    SLOW,
  )
  test(
    'maxWaitSeconds and minDwellSeconds hold a position out of range longer',
    () => {
      const quick = reranges(swing, variant('quick', { engine: engine(lazy()) }))
      const dwell = reranges(swing, variant('dwell', { engine: engine(lazy({ minDwellSeconds: 4 * 3600 })) }))
      expect(dwell).toBeLessThan(quick)
      // A wide buffer in ticks stops a move; the wait rule moves it anyway once it has been out long enough.
      const buffered = reranges(swing, variant('buffered', { engine: engine(lazy({ edgeBufferTicks: 1000 })) }))
      const waited = reranges(swing, variant('waited', { engine: engine(lazy({ edgeBufferTicks: 1000, maxWaitSeconds: 1800 })) }))
      expect(buffered).toBeLessThan(quick)
      expect(waited).toBeGreaterThan(buffered)
    },
    SLOW,
  )
  test(
    'edgeBufferBps caps the buffer by the width, so a wide tick buffer stops holding the position',
    () => {
      const ticks = reranges(swing, variant('ticks', { engine: engine(lazy({ edgeBufferTicks: 1000 })) }))
      const bps = reranges(swing, variant('bps', { engine: engine(lazy({ edgeBufferTicks: 1000, edgeBufferBps: 500 })) }))
      expect(bps).toBeGreaterThan(ticks)
    },
    SLOW,
  )
  test(
    'costTest off re-ranges where the fee-against-cost veto holds back',
    () => {
      // No fee growth on this path, so the cost test finds nothing to pay for a move.
      const flat = syntheticDataset({ samples: 1_440, tick: (k, i) => (k === 2 ? Math.round(900 * Math.sin((2 * Math.PI * i) / 144)) : 0) })
      const veto = reranges(flat, variant('veto', { engine: engine(lazy({ costTest: 'veto' })) }))
      const off = reranges(flat, variant('off', { engine: engine(lazy({ costTest: 'off' })) }))
      expect(off).toBeGreaterThan(veto)
    },
    SLOW,
  )
  test(
    'the fall freeze keeps money out of a falling pool: fewer entries than with it off',
    () => {
      const run = (v: Variant) => runBacktest(fall, policyOf(v), { deposit: 1_000_000_000n, reviewEvery: 1, sessions: 'enforce', sessionRenewal: 'renewed' }).metrics
      const off = run(variant('off', { engine: engine(lazy()) }))
      const on = run(variant('on', { engine: { rerange: lazy(), guard: { enabled: true, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 300, volBps: 1000 } } } }))
      const n = (m: typeof off) => m.operations.enter_mint + m.operations.rerange
      expect(n(on)).toBeLessThan(n(off))
    },
    SLOW,
  )
})
