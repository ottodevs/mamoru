import { describe, expect, test } from 'bun:test'
import { decide, type Observation } from '@mamoru/decide'
import { conservadorLiveV2, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
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

/** An observation of the three live Base pools (USDC against USDT, cbBTC and WETH), no positions. */
function shadowObs(extra: Partial<Observation>): Observation {
  const mk = (name: string, t0: string, t1: string, fee: number, tick: number) => {
    const e = entry(name, baseRegistry)
    return { name, address: e.address, token0: t0, token1: t1, fee, tickSpacing: 10, sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick, identity: { factoryPool: e.address, token0: address(t0, baseRegistry), token1: address(t1, baseRegistry), fee, tickSpacing: 10 } }
  }
  return {
    chainId: 31337,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: [], native: 10n ** 17n, balances: { USDC: 0n, cbBTC: 0n, WETH: 0n, USDT: 0n }, positions: [],
    pools: [mk('pool:USDC/USDT/100', 'USDC', 'USDT', 100, 0), mk('pool:USDC/cbBTC/500', 'USDC', 'cbBTC', 500, -69_080), mk('pool:WETH/USDC/3000', 'WETH', 'USDC', 3000, -194_700)],
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-197_000), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [], intents: { paused: false, exitRequested: false }, slot: null,
    ...extra,
  }
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

  test('no callback (a chain without one, deliberately silent): nothing is set', () => {
    expect(shadowInputsOf({ shadow: ['packaging:eel', 'packaging:tvl'] }, {})).toEqual({})
    expect(safePoolDepth(undefined)).toBeUndefined()
  })

  test('a callback that throws or answers nothing is "supplied, nothing read": an empty object, never silence', () => {
    expect(safePoolDepth(() => ({}))).toEqual({})
    expect(safePoolDepth(() => undefined)).toEqual({})
    expect(safePoolDepth(() => { throw new Error('boom') })).toEqual({})
    expect(shadowInputsOf({ shadow: ['packaging:eel', 'packaging:tvl'] }, { poolDepth: () => { throw new Error('x') }, poolStats: () => { throw new Error('y') } })).toEqual({ poolStats: {}, poolDepth: {} })
  })

  test('decide reports every USDC pool unread for the empty object, depth and stats alike', () => {
    const lab: PolicyVersion = { ...conservadorLiveV2, shadow: ['packaging:tvl', 'packaging:eel'] }
    const o = shadowObs({ ...shadowInputsOf(lab, { poolDepth: () => { throw new Error('x') }, poolStats: () => undefined }) })
    const risk = decide(o, lab).shadowRisk ?? []
    for (const code of ['RISK_POOL_DEPTH_UNREAD', 'RISK_POOL_STATS_UNREAD']) {
      expect(risk.filter((r) => r.code === code).map((r) => r.pool).sort()).toEqual(['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'])
    }
  })
})
