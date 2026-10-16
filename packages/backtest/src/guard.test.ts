import { describe, expect, test } from 'bun:test'
import { conservadorLabGuardsV1, conservadorLiveV2 } from '@mamoru/policy'
import { POOLS, syntheticDataset } from './fixtures.ts'
import { guardOf } from './observe.ts'
import { runBacktest } from './run.ts'

const DEPOSIT = 1_000n * 1_000_000n
const SLOW = 60_000
const STEP = 600
const DAY = 86_400 / STEP
/** Fee growth per sample, as the backtest suite uses. */
const GROWTH = [1n << 103n, 1n << 104n, 1n << 96n] as const
// Deterministic noise of up to 200 ticks per sample: about 120% annualized on 30-min TWAP returns, calm or not.
const zig = (i: number) => (((i * 2_654_435_761) >>> 0) % 401) - 200
// cbBTC (token1) falls when the tick rises; WETH (token0) when it falls. From day 2, 1% a day becomes 12% in 12 h.
const fall = (i: number) => (i < 2 * DAY ? 0 : Math.min(i - 2 * DAY, DAY / 2) * Math.round(1_280 / (DAY / 2)))
const crash = syntheticDataset({ samples: 4 * DAY, step: STEP, growth: GROWTH, tick: (k, i) => (k === 0 ? 0 : k === 1 ? zig(i) + fall(i) : zig(i) - fall(i)) })
const calm = syntheticDataset({ samples: 4 * DAY, step: STEP, growth: GROWTH, tick: (k, i) => (k === 0 ? 0 : zig(i)) })

const volatileEntries = (r: ReturnType<typeof runBacktest>) => r.ops.filter((o) => (o.kind === 'enter_swap' || o.kind === 'enter_mint') && o.pool !== POOLS[0] && o.grant.startsWith('enter-')).length

describe('Lab regression: fall freeze (spec 004, #101)', () => {
  test('observe builds 24 h history only once a day of samples exists', () => {
    expect(guardOf(crash, 10, 1_800).pools[POOLS[1]]).toEqual({ twap24hAgoTick: null, realizedVol24hBps: null })
    const g = guardOf(crash, 3 * DAY, 1_800).pools[POOLS[1]]!
    expect(g.realizedVol24hBps!).toBeGreaterThan(10_000)
  })

  test('calm: the guarded policy trades exactly as conservador-live-v2', () => {
    const a = runBacktest(calm, conservadorLiveV2, { deposit: DEPOSIT })
    const b = runBacktest(calm, conservadorLabGuardsV1, { deposit: DEPOSIT })
    expect(b.reasons.DECIDE_ENTRY_PAUSED_FALL ?? 0).toBe(0)
    expect(b.metrics).toEqual(a.metrics)
    expect(b.ops.map(({ trail: _t, ...o }) => o)).toEqual(a.ops.map(({ trail: _t, ...o }) => o))
  }, SLOW)

  // A fall with no rebound is the rule's known weak case: the tokens a re-range frees wait as they are, so this
  // checks the mechanism, not that the guarded run ends higher (the Lab gate on recorded windows decides that).
  test('fall: entries into the falling buckets wait, re-ranges still run', () => {
    const a = runBacktest(crash, conservadorLiveV2, { deposit: DEPOSIT })
    const b = runBacktest(crash, conservadorLabGuardsV1, { deposit: DEPOSIT })
    expect(b.reasons.DECIDE_ENTRY_PAUSED_FALL ?? 0).toBeGreaterThan(0)
    expect(volatileEntries(b)).toBeLessThan(volatileEntries(a))
    expect(b.metrics.operations.rerange).toBeGreaterThan(0)
  }, SLOW)
})
