import { describe, expect, test } from 'bun:test'
import { createPublicClient, custom, decodeFunctionData, encodeFunctionData, encodeFunctionResult, isAddressEqual, parseAbi, type Address, type Hex } from 'viem'
import { marketOf } from '@mamoru/decide'
import { multicall3Abi } from '../src/multicall.ts'
import { uniswapV3PoolAbi } from '@mamoru/registry'
import {
  addFeePoint,
  addGuardPoint,
  cumulativeAtFromObserve,
  cumulativeAtOf,
  emptyGuardSeries,
  FEE_POINT_STEP_SECONDS,
  feeGrowth24hOf,
  guardSecondsAgos,
  observeGuardHistory,
  type FeeGrowthHistory,
  type FeePoint,
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

  test('the second point is always appended too: with only one point there is no anchor yet to slide against', () => {
    const s1 = addGuardPoint(emptyGuardSeries(), p(1_000, 1n), W, 10 * W)
    const s2 = addGuardPoint(s1, p(1_000 + 1, 2n), W, 10 * W)
    expect(s2.points).toEqual([p(1_000, 1n), p(1_000 + 1, 2n)])
  })

  test('with an anchor established, a point less than half a window past it replaces the head, not appends', () => {
    let s = addGuardPoint(emptyGuardSeries(), p(0, 1n), W, 10 * W)
    s = addGuardPoint(s, p(1, 2n), W, 10 * W) // anchor = p(0), head = p(1)
    const s2 = addGuardPoint(s, p(W / 2 - 1, 3n), W, 10 * W) // still < W/2 past the anchor p(0)
    expect(s2.points).toEqual([p(0, 1n), p(W / 2 - 1, 3n)])
  })

  test('a point half a window or more past the anchor is appended: the slid head freezes as the next anchor', () => {
    let s = addGuardPoint(emptyGuardSeries(), p(0, 1n), W, 10 * W)
    s = addGuardPoint(s, p(1, 2n), W, 10 * W)
    const s2 = addGuardPoint(s, p(W / 2, 3n), W, 10 * W)
    expect(s2.points).toEqual([p(0, 1n), p(1, 2n), p(W / 2, 3n)])
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

  test('REGRESSION (agy review, pre-fix bug): fed at a realistic review cadence far below the window (60 s, the live default is ~20 s), the series still grows past one point and every two kept points stay under half a window apart', () => {
    let s: GuardSeries = emptyGuardSeries()
    const STEP = 60
    const HOURS_25 = 25 * 3_600
    for (let t = 0; t <= HOURS_25; t += STEP) s = addGuardPoint(s, p(t, BigInt(t)), W, HOURS_25 + W)
    expect(s.points.length).toBeGreaterThan(10)
    for (let i = 1; i < s.points.length; i++) expect(s.points[i]!.time - s.points[i - 1]!.time).toBeLessThan(W / 2)
    // And it actually answers marketOf at an arbitrary review timestamp, not only at a multiple of W.
    const now = s.points.at(-1)!.time
    const m = marketOf(now, W, cumulativeAtOf(s))
    expect(m.twap24hAgoTick).not.toBeNull()
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
function fakeClient(maxLookback: number, fees?: { growth: bigint; failOn?: Address }) {
  const pools: Record<string, { tick: bigint; base: bigint; maxLookback: number }> = {
    [STABLE_POOL.toLowerCase()]: { tick: 0n, base: 0n, maxLookback: Number.MAX_SAFE_INTEGER },
    [BTC_POOL.toLowerCase()]: { tick: 7n, base: 1_000_000n, maxLookback },
  }
  const answer = (to: Address, data: Hex): { success: boolean; returnData: Hex } => {
    const pool = pools[to.toLowerCase()]
    if (!pool) return { success: false, returnData: '0x' }
    // #172: fee growth globals, token1 twice token0; one pool may revert them.
    for (const [i, fn] of (['feeGrowthGlobal0X128', 'feeGrowthGlobal1X128'] as const).entries()) {
      if (data.slice(0, 10) !== encodeFunctionData({ abi: uniswapV3PoolAbi, functionName: fn }).slice(0, 10)) continue
      if (!fees || (fees.failOn && isAddressEqual(fees.failOn, to))) return { success: false, returnData: '0x' }
      return { success: true, returnData: encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: fn, result: fees.growth * BigInt(i + 1) }) }
    }
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

  test('fed every 5 min (well below the window, like the live ~20 s review cadence) across a 24.5 h fallback build-up, the series eventually answers, without the on-chain path ever working', async () => {
    const client = fakeClient(3_600)
    const STEP = 300 // 5 min; the live default review cadence is ~20 s, far finer still — this is the regression agy's review caught (packages/rpc/src/guard-history.ts's addGuardPoint).
    let series = new Map<string, GuardSeries>()
    let now = 100 * DAY_S
    let lastPools: Record<string, unknown> = {}
    for (let i = 0; i <= (25 * 3_600) / STEP; i++) {
      const r = await observeGuardHistory(client, MULTICALL3, targets, 1n, now, W, series)
      series = new Map(r.series)
      lastPools = r.pools
      expect(r.onChain.has('pool:USDC/cbBTC/500')).toBe(false)
      now += STEP
    }
    // A fast review cadence must still grow the series past one point, not replace it forever.
    expect(series.get('pool:USDC/cbBTC/500')!.points.length).toBeGreaterThan(10)
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

describe('fee growth history (otto/mamoru#172)', () => {
  const pt = (time: number, g: bigint): FeePoint => ({ time, growth0X128: g, growth1X128: 2n * g })

  test('addFeePoint keeps points a step apart, drops what is older than a day and an hour, never goes back', () => {
    let s: readonly FeePoint[] = []
    for (let t = 0; t <= 3_600; t += 20) s = addFeePoint(s, pt(t, BigInt(t)))
    expect(s.length).toBeGreaterThan(3_600 / FEE_POINT_STEP_SECONDS - 1)
    expect(s.length).toBeLessThan(3_600 / FEE_POINT_STEP_SECONDS + 3)
    expect(s.at(-1)!.time).toBe(3_600)
    expect(addFeePoint(s, pt(3_000, 0n))).toEqual(s)
    expect(addFeePoint(s, pt(3_600 + DAY_S + 3_600, 1n))[0]!.time).toBeGreaterThan(3_600)
  })

  test('feeGrowth24hOf: from the first point at or after 24 h ago; null under 12 h of history; wraps like uint256', () => {
    const now = 10 * DAY_S
    expect(feeGrowth24hOf([], pt(now, 5n))).toBeNull()
    expect(feeGrowth24hOf([pt(now - 11 * 3_600, 1n)], pt(now, 5n))).toBeNull()
    expect(feeGrowth24hOf([pt(now - 30 * 3_600, 0n), pt(now - 20 * 3_600, 1n), pt(now - 3_600, 4n)], pt(now, 5n))).toEqual({ growth0X128: 4n, growth1X128: 8n, seconds: 20 * 3_600 })
    const top = (1n << 256n) - 1n
    expect(feeGrowth24hOf([{ time: now - DAY_S, growth0X128: top, growth1X128: top }], { time: now, growth0X128: 1n, growth1X128: 0n })).toEqual({ growth0X128: 2n, growth1X128: 1n, seconds: DAY_S })
  })

  const targets = [
    { name: 'pool:USDC/USDT/100', address: STABLE_POOL },
    { name: 'pool:USDC/cbBTC/500', address: BTC_POOL },
  ]

  test('without a fee history no fee growth is read or set (the guard-only shape is unchanged)', async () => {
    const r = await observeGuardHistory(fakeClient(3_600, { growth: 1n }), MULTICALL3, targets, 1n, 100 * DAY_S, W, new Map())
    expect(Object.values(r.pools).every((p) => p && !('feeGrowth24h' in p))).toBe(true)
  })

  test('with one, the shared history fills from every review and answers once it covers 12 h; a failed read is null', async () => {
    const fees: FeeGrowthHistory = new Map()
    const growth = { growth: 0n, failOn: undefined as Address | undefined }
    const client = fakeClient(3_600, growth)
    let now = 100 * DAY_S
    let last = await observeGuardHistory(client, MULTICALL3, targets, 1n, now, W, new Map(), fees)
    expect(last.pools['pool:USDC/cbBTC/500']!.feeGrowth24h).toBeNull()
    for (let i = 0; i < (13 * 3_600) / 300; i++) {
      now += 300
      growth.growth += 10n
      last = await observeGuardHistory(client, MULTICALL3, targets, 1n, now, W, new Map(), fees)
    }
    const g = last.pools['pool:USDC/cbBTC/500']!.feeGrowth24h!
    expect(g.seconds).toBe(13 * 3_600)
    expect(g.growth0X128).toBe(growth.growth)
    expect(g.growth1X128).toBe(2n * growth.growth)
    expect(fees.get('pool:USDC/cbBTC/500')!.length).toBeGreaterThan(70)
    growth.failOn = BTC_POOL
    const failed = await observeGuardHistory(client, MULTICALL3, targets, 1n, now + 300, W, new Map(), fees)
    expect(failed.pools['pool:USDC/cbBTC/500']!.feeGrowth24h).toBeNull()
    expect(failed.pools['pool:USDC/USDT/100']!.feeGrowth24h).not.toBeNull()
  })
})
