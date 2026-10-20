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
  GUARD_CALLS_PER_POOL,
  observeGuardHistory,
  SharedGuardReads,
  type FeeGrowthHistory,
  type FeePoint,
  type GuardSeries,
} from '../src/guard-history.ts'

const observeAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])
const W = 1_800
const DAY_S = 86_400

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

import { BTC_POOL, fakeClient, MULTICALL3, poolCalls, STABLE_POOL } from './fake-guard-client.ts'

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

describe('SharedGuardReads: one read per pool per TTL for the whole process (#172, GPT-6 review)', () => {
  const targets = [
    { name: 'pool:USDC/USDT/100', address: STABLE_POOL },
    { name: 'pool:USDC/cbBTC/500', address: BTC_POOL },
  ]

  test('N engines in one interval, sequential or at the same time: one batch, one read per pool', async () => {
    const shared = new SharedGuardReads()
    const client = fakeClient(3_600, { growth: 1n })
    poolCalls.n = 0
    const now = 100 * DAY_S
    const first = await shared.read(client, MULTICALL3, targets, 1n, now, W)
    const same = await Promise.all(Array.from({ length: 50 }, (_, i) => shared.read(client, MULTICALL3, targets, 1n + BigInt(i), now + (i % 59), W)))
    expect(shared.counts).toEqual({ batches: 1, poolCalls: targets.length * GUARD_CALLS_PER_POOL })
    expect(poolCalls.n).toBe(targets.length * GUARD_CALLS_PER_POOL)
    for (const r of same) expect(r).toEqual(first)
    // Concurrent first readers share the batch in flight.
    const fresh = new SharedGuardReads()
    poolCalls.n = 0
    await Promise.all(Array.from({ length: 20 }, () => fresh.read(client, MULTICALL3, targets, 1n, now, W)))
    expect(fresh.counts.batches).toBe(1)
    expect(poolCalls.n).toBe(targets.length * GUARD_CALLS_PER_POOL)
    // Past the TTL the next engine reads again; a pool asked for the first time is read alone.
    await shared.read(client, MULTICALL3, targets, 2n, now + 60, W)
    expect(shared.counts.batches).toBe(2)
    await shared.read(client, MULTICALL3, [targets[0]!], 2n, now + 61, W)
    expect(shared.counts.batches).toBe(2)
  })

  test('two TWAP windows on the same pool never share a read (GPT-6 review, round 2)', async () => {
    const W2 = W * 2
    const client = fakeClient(3_600, { growth: 1n })
    const now = 100 * DAY_S
    const shared = new SharedGuardReads()
    const a = await shared.read(client, MULTICALL3, targets, 1n, now, W)
    const b = await shared.read(client, MULTICALL3, targets, 1n, now + 1, W2)
    expect(shared.counts.batches).toBe(2)
    // Each equals what a reader of only that window gets.
    expect(a).toEqual(await new SharedGuardReads().read(client, MULTICALL3, targets, 1n, now, W))
    expect(b).toEqual(await new SharedGuardReads().read(client, MULTICALL3, targets, 1n, now + 1, W2))
    // Within the TTL each window reuses its own read.
    await shared.read(client, MULTICALL3, targets, 2n, now + 30, W)
    await shared.read(client, MULTICALL3, targets, 2n, now + 30, W2)
    expect(shared.counts.batches).toBe(2)
    expect(shared.seriesOf(W)).not.toBe(shared.seriesOf(W2))
  })

  test('restart: restored series give the volatility a failed long read cannot; without them it is missing', async () => {
    // cbBTC's oracle answers one hour only, so its volatility comes from the fallback series alone.
    const client = fakeClient(3_600, { growth: 1n })
    const before = new SharedGuardReads()
    let now = 100 * DAY_S
    for (; now < 100 * DAY_S + 25 * 3_600; now += 300) await before.read(client, MULTICALL3, targets, 1n, now, W)
    const warm = await before.read(client, MULTICALL3, targets, 1n, now, W)
    expect(warm['pool:USDC/cbBTC/500']!.realizedVol24hBps).not.toBeNull()
    // A new process, a minute later.
    const saved = before.state()
    const restored = new SharedGuardReads({ fees: saved.fees, series: saved.series })
    const after = await restored.read(client, MULTICALL3, targets, 2n, now + 60, W)
    expect(after['pool:USDC/cbBTC/500']!.realizedVol24hBps).not.toBeNull()
    expect(after['pool:USDC/cbBTC/500']!.feeGrowth24h).not.toBeNull()
    const cold = await new SharedGuardReads().read(client, MULTICALL3, targets, 2n, now + 60, W)
    expect(cold['pool:USDC/cbBTC/500']!.realizedVol24hBps).toBeNull()
    expect(cold['pool:USDC/cbBTC/500']!.feeGrowth24h).toBeNull()
  }, 30_000)

  test('a failed read is not kept: the next engine reads again', async () => {
    const shared = new SharedGuardReads()
    const broken = createPublicClient({ transport: custom({ async request() { throw new Error('down') } }) })
    await expect(shared.read(broken, MULTICALL3, targets, 1n, 100 * DAY_S, W)).rejects.toThrow()
    const r = await shared.read(fakeClient(3_600, { growth: 1n }), MULTICALL3, targets, 1n, 100 * DAY_S, W)
    expect(shared.counts.batches).toBe(2)
    expect(r['pool:USDC/cbBTC/500']).toBeDefined()
  })

  test('the shared fee history fills from whichever engine reads, and onUpdate is told', async () => {
    let told = 0
    const shared = new SharedGuardReads({ onUpdate: () => told++ })
    const growth = { growth: 0n }
    const client = fakeClient(3_600, growth)
    let r: Awaited<ReturnType<SharedGuardReads['read']>> = {}
    for (let t = 0; t <= 13 * 3_600; t += 20) {
      growth.growth += 1n
      r = await shared.read(client, MULTICALL3, targets, 1n, 100 * DAY_S + t, W)
    }
    expect(r['pool:USDC/cbBTC/500']!.feeGrowth24h?.seconds).toBeGreaterThanOrEqual(12 * 3_600)
    expect(told).toBe(shared.counts.batches)
  })

  test('calls per hour, 100 lazy accounts on the 3 live pools: per engine review (before) and shared (after)', async () => {
    const three = [...targets, { name: 'pool:WETH/USDC/3000', address: BTC_POOL }]
    const client = fakeClient(3_600, { growth: 1n })
    const hour = async (reviewSeconds: number, accounts: number, shared: SharedGuardReads | null) => {
      poolCalls.n = 0
      const fees: FeeGrowthHistory = new Map()
      for (let t = 0; t < 3_600; t += reviewSeconds) {
        for (let a = 0; a < accounts; a++) {
          // Accounts are staggered over the review interval, as their loops are.
          const now = 100 * DAY_S + t + Math.floor((a * reviewSeconds) / accounts)
          if (shared) await shared.read(client, MULTICALL3, three, 1n, now, W)
          else await observeGuardHistory(client, MULTICALL3, three, 1n, now, W, new Map(), fees)
        }
      }
      return poolCalls.n
    }
    // Before: every review of every account reads its pools, so it is linear in accounts; measured on 10, times 10.
    const counts = {
      every20s: { before: (await hour(20, 10, null)) * 10, after: await hour(20, 100, new SharedGuardReads()) },
      every120s: { before: (await hour(120, 10, null)) * 10, after: await hour(120, 100, new SharedGuardReads()) },
    }
    console.log(`[#172] guard pool calls per hour, 100 lazy accounts, 3 pools: ${JSON.stringify(counts)}`)
    expect(counts.every20s.before).toBe(100 * 180 * 3 * GUARD_CALLS_PER_POOL)
    expect(counts.every120s.before).toBe(100 * 30 * 3 * GUARD_CALLS_PER_POOL)
    // After: one read of the 3 pools per TTL (60 s), whatever the number of accounts or their cadence.
    expect(counts.every20s.after).toBe(60 * 3 * GUARD_CALLS_PER_POOL)
    expect(counts.every120s.after).toBe(60 * 3 * GUARD_CALLS_PER_POOL)
  }, 60_000)
})
