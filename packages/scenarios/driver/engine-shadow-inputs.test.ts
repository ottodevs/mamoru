import { describe, expect, test } from 'bun:test'
import type { Observation } from '@mamoru/decide'
import { safePoolDepth, shadowInputsOf } from './engine.ts'

const depth: NonNullable<Observation['poolDepth']> = { 'pool:USDC/cbBTC/500': { sizesUsd: [1000], impactBps: [1], feeBps: 5, asOf: 1 } }
const stats: NonNullable<Observation['poolStats']> = {
  'pool:USDC/cbBTC/500': { tvlUsd: 1, tvl1dAgoUsd: 1, tvl7dAgoUsd: 1, tvl30dAgoUsd: 1, volume7dUsd: 1, volumeLastDayUsd: 1, volume28dAvgUsd: 1, asOf: 1 },
}

/** The callbacks count their calls: a gate that is off must not even ask (otto/mamoru#101). */
function cfg() {
  const n = { stats: 0, depth: 0 }
  return { n, cfg: { poolStats: () => (n.stats++, stats), poolDepth: () => (n.depth++, depth) } }
}

describe('shadow inputs of a review (otto/mamoru#101)', () => {
  test('packaging:eel alone reads the depth callback only', () => {
    const c = cfg()
    expect(shadowInputsOf({ shadow: ['packaging:eel'] }, c.cfg)).toEqual({ poolDepth: depth })
    expect(c.n).toEqual({ stats: 0, depth: 1 })
  })

  test('packaging:tvl alone reads the stats callback only; both gates read both', () => {
    const c = cfg()
    expect(shadowInputsOf({ shadow: ['packaging:tvl'] }, c.cfg)).toEqual({ poolStats: stats })
    expect(c.n).toEqual({ stats: 1, depth: 0 })
    expect(shadowInputsOf({ shadow: ['packaging:tvl', 'packaging:eel'] }, c.cfg)).toEqual({ poolStats: stats, poolDepth: depth })
  })

  test('no gate: nothing is read and no key is set (the observation is as it was)', () => {
    const c = cfg()
    expect(shadowInputsOf({ shadow: ['packaging:eny'] }, c.cfg)).toEqual({})
    expect(c.n).toEqual({ stats: 0, depth: 0 })
  })

  test('no callback, an empty answer or a throwing callback is the same as none', () => {
    expect(shadowInputsOf({ shadow: ['packaging:eel'] }, {})).toEqual({})
    expect(safePoolDepth(() => ({}))).toBeUndefined()
    expect(safePoolDepth(() => { throw new Error('boom') })).toBeUndefined()
    expect(shadowInputsOf({ shadow: ['packaging:eel', 'packaging:tvl'] }, { poolDepth: () => { throw new Error('x') }, poolStats: () => { throw new Error('y') } })).toEqual({})
  })
})
