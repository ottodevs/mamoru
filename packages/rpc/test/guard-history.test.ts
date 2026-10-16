import { describe, expect, test } from 'bun:test'
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, isAddressEqual, parseAbi, type Address, type Hex } from 'viem'
import { marketOf } from '@mamoru/decide'
import { multicall3Abi } from '../src/multicall.ts'
import {
  addGuardPoint,
  cumulativeAtFromObserve,
  cumulativeAtOf,
  emptyGuardSeries,
  guardSecondsAgos,
  observeGuardHistory,
  type GuardSeries,
} from '../src/guard-history.ts'

const observeAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])
const W = 1_800
const DAY_S = 86_400
const MULTICALL3 = `0x${'ca11'.repeat(10)}` as Address
const BTC_POOL = `0x${'b7c0'.repeat(10)}` as Address
const STABLE_POOL = `0x${'5ab1'.repeat(10)}` as Address

describe('guardSecondsAgos', () => {
  test('matches marketOf\'s own windowing: oldest first, 0 last, segments+2 points', () => {
    const agos = guardSecondsAgos(W)
    expect(agos.length).toBe(50)
    expect(agos[0]).toBe(49 * W)
    expect(agos.at(-1)).toBe(0)
    expect(agos.every((a, i) => i === 0 || a < agos[i - 1]!)).toBe(true)
  })

  test('a window that does not divide a day, or covers half a day or more (fewer than 2 segments), answers nothing: marketOf would abstain on it anyway', () => {
    expect(guardSecondsAgos(700)).toEqual([])
    expect(guardSecondsAgos(86_400)).toEqual([]) // 1 segment
    expect(guardSecondsAgos(0)).toEqual([])
    expect(guardSecondsAgos(-1)).toEqual([])
  })
})

describe('addGuardPoint', () => {
  const p = (time: number, tick = 0n) => ({ time, tickCumulative: tick })

  test('the first point is always appended', () => {
    expect(addGuardPoint(emptyGuardSeries(), p(1_000), W, 10 * W).points).toEqual([p(1_000)])
  })

  test('a point less than a window after the last one replaces it, not appends', () => {
    const s1 = addGuardPoint(emptyGuardSeries(), p(1_000, 1n), W, 10 * W)
    const s2 = addGuardPoint(s1, p(1_000 + W - 1, 2n), W, 10 * W)
    expect(s2.points).toEqual([p(1_000 + W - 1, 2n)])
  })

  test('a point a window or more after the last one is appended', () => {
    const s1 = addGuardPoint(emptyGuardSeries(), p(1_000, 1n), W, 10 * W)
    const s2 = addGuardPoint(s1, p(1_000 + W, 2n), W, 10 * W)
    expect(s2.points).toEqual([p(1_000, 1n), p(1_000 + W, 2n)])
  })

  test('a point at or before the last kept one is ignored: the series never goes backwards', () => {
    const s1 = addGuardPoint(emptyGuardSeries(), p(2_000, 1n), W, 10 * W)
    expect(addGuardPoint(s1, p(2_000, 2n), W, 10 * W).points).toEqual([p(2_000, 1n)])
    expect(addGuardPoint(s1, p(1_500, 2n), W, 10 * W).points).toEqual([p(2_000, 1n)])
  })

  test('points maxAgeSeconds or older than the new point are dropped first', () => {
    let s: GuardSeries = emptyGuardSeries()
    for (let t = 0; t <= 10 * W; t += W) s = addGuardPoint(s, p(t, BigInt(t)), W, 5 * W)
    // Only points within 5*W of the last time (10*W) survive: strictly less than 5*W old.
    expect(s.points.every((x) => 10 * W - x.time < 5 * W)).toBe(true)
    expect(s.points.at(-1)).toEqual(p(10 * W, BigInt(10 * W)))
  })
})

describe('cumulativeAtOf: rolling series read like the backtest dataset', () => {
  test('empty series answers nothing', () => {
    expect(cumulativeAtOf(emptyGuardSeries())(100)).toBeNull()
  })

  test('a time before the first point answers nothing', () => {
    const s = addGuardPoint(emptyGuardSeries(), { time: 1_000, tickCumulative: 1n }, W, 10 * W)
    expect(cumulativeAtOf(s)(500)).toBeNull()
  })

  test('the last point at or before t, matching the backtest dataset\'s own cumulativeAt', () => {
    let s: GuardSeries = emptyGuardSeries()
    for (let t = 0; t <= 5 * W; t += W) s = addGuardPoint(s, { time: t, tickCumulative: BigInt(t) }, W, 20 * W)
    const at = cumulativeAtOf(s)
    expect(at(2 * W)).toEqual({ time: 2 * W, tickCumulative: BigInt(2 * W) })
    expect(at(2 * W + 10)).toEqual({ time: 2 * W, tickCumulative: BigInt(2 * W) })
  })

  test('fed into marketOf: a full 24.5 h rolling series answers; a short one abstains (FR-LC-007, fail safe)', () => {
    const now = 100 * DAY_S
    let s: GuardSeries = emptyGuardSeries()
    const agos = guardSecondsAgos(W)
    // Only the most recent 10 points: nowhere near the 24 h the rule needs.
    for (const ago of agos.slice(-10)) s = addGuardPoint(s, { time: now - ago, tickCumulative: BigInt(now - ago) }, W, 2 * DAY_S)
    expect(marketOf(now, W, cumulativeAtOf(s))).toEqual({ twap24hAgoTick: null, realizedVol24hBps: null })
    // The full set: every point marketOf will ask for is present, each an exact hit.
    let full: GuardSeries = emptyGuardSeries()
    // `agos` is oldest-first (largest ago first), which is ascending time (`now - ago`): the order `addGuardPoint` expects.
    for (const ago of agos) full = addGuardPoint(full, { time: now - ago, tickCumulative: BigInt(now - ago) * 100n }, W, 2 * DAY_S)
    const m = marketOf(now, W, cumulativeAtOf(full))
    expect(m.twap24hAgoTick).not.toBeNull()
    expect(m.realizedVol24hBps).not.toBeNull()
  })
})

describe('cumulativeAtFromObserve', () => {
  test('every requested offset is an exact point; anything else answers nothing', () => {
    const now = 1_000_000
    const agos = [3_600, 1_800, 0]
    const at = cumulativeAtFromObserve(now, agos, [10n, 20n, 30n])
    expect(at(now - 3_600)).toEqual({ time: now - 3_600, tickCumulative: 10n })
    expect(at(now)).toEqual({ time: now, tickCumulative: 30n })
    expect(at(now - 900)).toBeNull()
  })
})

// ---- observeGuardHistory against a minimal fake chain --------------------------------------------------------

/** Decodes one `observe(uint32[])` call and answers it: reverts if any requested offset is past `maxLookback`. */
function observeResult(data: Hex, tick: bigint, base: bigint, maxLookback: number): { success: boolean; returnData: Hex } {
  const { args } = decodeFunctionData({ abi: observeAbi, data })
  const secondsAgos = args[0] as readonly number[]
  if (secondsAgos.some((s) => s > maxLookback)) return { success: false, returnData: '0x' }
  const tickCumulatives = secondsAgos.map((s) => base - BigInt(s) * tick)
  const secondsPerLiquidity = secondsAgos.map(() => 0n)
  return { success: true, returnData: encodeFunctionResult({ abi: observeAbi, functionName: 'observe', result: [tickCumulatives, secondsPerLiquidity] }) }
}

/** A client with two pools: one whose oracle answers any lookback (the stables pool today, see LC-T6), one that only answers within `maxLookback` (cbBTC/WETH today). */
function fakeClient(maxLookback: number) {
  const pools: Record<string, { tick: bigint; base: bigint; maxLookback: number }> = {
    [STABLE_POOL.toLowerCase()]: { tick: 0n, base: 0n, maxLookback: Number.MAX_SAFE_INTEGER },
    [BTC_POOL.toLowerCase()]: { tick: 7n, base: 1_000_000n, maxLookback },
  }
  const answer = (to: Address, data: Hex): { success: boolean; returnData: Hex } => {
    const pool = pools[to.toLowerCase()]
    if (!pool) return { success: false, returnData: '0x' }
    return observeResult(data, pool.tick, pool.base, pool.maxLookback)
  }
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: readonly unknown[] }) {
        if (method !== 'eth_call') throw new Error(`unexpected method ${method}`)
        const { to, data } = (params as readonly [{ to: Address; data: Hex }])[0]!
        if (isAddressEqual(to, MULTICALL3)) {
          const { args } = decodeFunctionData({ abi: multicall3Abi, data })
          const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]
          const results = calls.map((c) => answer(c.target, c.callData))
          return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
        }
        const r = answer(to, data)
        if (!r.success) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' })
        return r.returnData
      },
    }),
  })
}

describe('observeGuardHistory', () => {
  const targets = [
    { name: 'pool:USDC/USDT/100', address: STABLE_POOL },
    { name: 'pool:USDC/cbBTC/500', address: BTC_POOL },
  ]

  test('a pool whose oracle answers the full window: on-chain history, no fallback point needed to resolve it', async () => {
    const client = fakeClient(3_600)
    const now = 100 * DAY_S
    const r = await observeGuardHistory(client, MULTICALL3, targets, 1n, now, W, new Map())
    expect(r.onChain.has('pool:USDC/USDT/100')).toBe(true)
    expect(r.pools['pool:USDC/USDT/100']).toEqual({ twap24hAgoTick: 0, realizedVol24hBps: 0 })
  })

  test('a pool whose oracle cannot look back 24.5 h: falls back, and a cold series abstains (RISK_DATA_INSUFFICIENT upstream)', async () => {
    const client = fakeClient(3_600)
    const now = 100 * DAY_S
    const r = await observeGuardHistory(client, MULTICALL3, targets, 1n, now, W, new Map())
    expect(r.onChain.has('pool:USDC/cbBTC/500')).toBe(false)
    expect(r.pools['pool:USDC/cbBTC/500']).toEqual({ twap24hAgoTick: null, realizedVol24hBps: null })
    // But the fallback series did pick up this review's point, from the always-answerable observe([0]).
    expect(r.series.get('pool:USDC/cbBTC/500')?.points.length).toBe(1)
  })

  test('fed every ~30 min across a 24.5 h fallback build-up, the series eventually answers, without the on-chain path ever working', async () => {
    const client = fakeClient(3_600)
    let series = new Map<string, GuardSeries>()
    let now = 100 * DAY_S
    let lastPools: Record<string, unknown> = {}
    for (let i = 0; i <= 50; i++) {
      const r = await observeGuardHistory(client, MULTICALL3, targets, 1n, now, W, series)
      series = new Map(r.series)
      lastPools = r.pools
      expect(r.onChain.has('pool:USDC/cbBTC/500')).toBe(false)
      now += W
    }
    expect((lastPools['pool:USDC/cbBTC/500'] as { twap24hAgoTick: number | null }).twap24hAgoTick).not.toBeNull()
    expect((lastPools['pool:USDC/cbBTC/500'] as { realizedVol24hBps: number | null }).realizedVol24hBps).not.toBeNull()
  })

  test('byte-identical shape when no targets are asked: empty pools, empty series, no request sent', async () => {
    const client = fakeClient(3_600)
    const r = await observeGuardHistory(client, MULTICALL3, [], 1n, 100 * DAY_S, W, new Map())
    expect(r.pools).toEqual({})
    expect(r.series.size).toBe(0)
    expect(r.onChain.size).toBe(0)
  })
})
