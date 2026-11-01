import { describe, expect, test } from 'bun:test'
import { encodeFunctionResult, type PublicClient } from 'viem'
import { address, baseRegistry, monadRegistry } from '@mamoru/registry'
import { quoterV2Abi, sqrtRatioAtTick, token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { DEPTH_LADDER_USD, DEPTH_POOL_NAMES, PoolDepthCache, depthIoOf, depthPoolsOf, impactBpsOf, poolDepthFor, type DepthIo } from '../src/pool-depth.ts'

const BTC = 'pool:USDC/cbBTC/500' // USDC is token0: the sell token is token1
const WETH = 'pool:WETH/USDC/3000' // USDC is token1: the sell token is token0
const TICK: Record<string, number> = { [BTC]: -69_080, [WETH]: -194_700, 'pool:USDC/USDT/100': 0 }
const pools = (names: string[]) => depthPoolsOf(names, baseRegistry)

type Q = { tokenIn: string; tokenOut: string; fee: number; amountIn: bigint; blockNumber: bigint }

/** A chain whose k-th quote of a pool answers `impacts[k]` bps under the fee-adjusted mid output (null: revert; 'zero'; 'fail': transport error). */
function fakeIo(impacts: (number | null | 'zero' | 'fail' | 'hang')[], opts: { head?: bigint } = {}) {
  const calls: { kind: string; q?: Q; at?: number }[] = []
  let n = 0
  const io: DepthIo = {
    block: async () => (calls.push({ kind: 'block' }), opts.head ?? 123n),
    sqrtPrice: async (pool) => {
      calls.push({ kind: 'slot0' })
      n = 0
      const name = [BTC, WETH, 'pool:USDC/USDT/100'].find((x) => depthPoolsOf([x], baseRegistry)[0]!.address === pool)!
      return sqrtRatioAtTick(TICK[name]!)
    },
    quote: async (q) => {
      calls.push({ kind: 'quote', q })
      const k = n++
      const bps = impacts[k] ?? impacts[impacts.length - 1]!
      if (bps === null) throw new Error('execution reverted')
      if (bps === 'fail') throw new Error('fetch failed')
      if (bps === 'hang') return await new Promise<bigint>(() => {})
      if (bps === 'zero') return 0n
      const p = [BTC, WETH, 'pool:USDC/USDT/100'].map((x) => depthPoolsOf([x], baseRegistry)[0]!).find((x) => x.token0Address === q.tokenIn || x.token1Address === q.tokenIn)!
      const sqrt = sqrtRatioAtTick(TICK[p.name]!)
      const mid = q.tokenIn === p.token0Address ? token0InToken1(q.amountIn, sqrt) : token1InToken0(q.amountIn, sqrt)
      const afterFee = (mid * BigInt(1_000_000 - q.fee)) / 1_000_000n
      return (afterFee * BigInt(10_000 - bps)) / 10_000n
    },
  }
  return { io, calls, quotes: () => calls.filter((c) => c.kind === 'quote') }
}

const T0 = 1_700_000_000_000
const clock = () => {
  const c = { t: T0 }
  return { c, now: () => c.t }
}

describe('impact maths', () => {
  test('impactBpsOf: rounds, clamps at 0, nothing to compare is null', () => {
    expect(impactBpsOf(9_950n, 10_000n)).toBe(50)
    expect(impactBpsOf(9_999n, 10_000n)).toBe(1) // 0.01% rounds to 1 bps
    expect(impactBpsOf(10_001n, 10_000n)).toBe(0)
    expect(impactBpsOf(1n, 0n)).toBeNull()
  })
})

describe('PoolDepthCache', () => {
  test('first read starts a refresh; the ladder arrives from memory, the fee is not in the impact', async () => {
    const f = fakeIo([1, 2, 5, 10, 20, 40, 80, 160, 320])
    const { now } = clock()
    const cache = new PoolDepthCache(pools([BTC]), f.io, { now, timeoutMs: 1000 })
    const first = cache.get()
    expect(first[BTC]!.impactBps.every((x) => x === null)).toBe(true) // before the read ends: unread, not silent
    expect(first[BTC]!.asOf).toBe(0)
    await cache.settled()
    const d = cache.get()[BTC]!
    expect(d.sizesUsd).toEqual([...DEPTH_LADDER_USD])
    expect(d.impactBps).toEqual([1, 2, 5, 10, 20, 40, 80, 160, 320])
    expect(d.feeBps).toBe(5)
    expect(d.asOf).toBe(Math.floor(T0 / 1000))
  })

  test('calls: one head, one slot0 and nine sequential quotes per pool, at one block, USDC out', async () => {
    const f = fakeIo([0])
    const cache = new PoolDepthCache(pools([BTC, WETH]), f.io, { now: clock().now })
    await cache.settled()
    expect(f.calls.map((c) => c.kind)).toEqual(['block', 'slot0', ...Array(9).fill('quote'), 'slot0', ...Array(9).fill('quote')])
    const usdc = address('USDC', baseRegistry)
    const [btc, weth] = [f.quotes().slice(0, 9).map((c) => c.q!), f.quotes().slice(9).map((c) => c.q!)]
    for (const q of [...btc, ...weth]) {
      expect(q.blockNumber).toBe(123n)
      expect(q.tokenOut).toBe(usdc)
    }
    // BTC pool: USDC is token0, so the cbBTC (token1) is sold; WETH pool: WETH (token0) is sold.
    expect(btc[0]!.tokenIn).toBe(address('cbBTC', baseRegistry))
    expect(btc[0]!.fee).toBe(500)
    expect(weth[0]!.tokenIn).toBe(address('WETH', baseRegistry))
    expect(weth[0]!.fee).toBe(3000)
    // 1,000 USD of cbBTC at mid: 1000e6 raw USDC priced back is within one unit of rounding.
    const usd = (q: Q, tokenIsToken1: boolean) => Number(tokenIsToken1 ? token1InToken0(q.amountIn, sqrtRatioAtTick(TICK[BTC]!)) : token0InToken1(q.amountIn, sqrtRatioAtTick(TICK[WETH]!))) / 1e6
    expect(usd(btc[0]!, true)).toBeCloseTo(1_000, 2)
    expect(usd(btc[8]!, true)).toBeCloseTo(10_000_000, -1)
    expect(usd(weth[3]!, false)).toBeCloseTo(30_000, 2)
  })

  test('a revert stops the ladder: that size and every larger one are null, and no more quotes are made', async () => {
    const f = fakeIo([3, 6, 9, 12, null])
    const cache = new PoolDepthCache(pools([BTC]), f.io, { now: clock().now })
    await cache.settled()
    expect(cache.get()[BTC]!.impactBps).toEqual([3, 6, 9, 12, null, null, null, null, null])
    expect(f.quotes()).toHaveLength(5)
  })

  test('a zero output is also null and stops the ladder', async () => {
    const f = fakeIo([3, 'zero'])
    const cache = new PoolDepthCache(pools([WETH]), f.io, { now: clock().now })
    await cache.settled()
    expect(cache.get()[WETH]!.impactBps).toEqual([3, null, null, null, null, null, null, null, null])
    expect(f.quotes()).toHaveLength(2)
  })

  test('at most one refresh per hour per pool', async () => {
    const f = fakeIo([0])
    const k = clock()
    const cache = new PoolDepthCache(pools([BTC]), f.io, { now: k.now })
    await cache.settled()
    const n = f.calls.length
    k.c.t += 59 * 60_000
    cache.get()
    await cache.settled()
    expect(f.calls.length).toBe(n)
    k.c.t += 2 * 60_000
    await cache.settled()
    expect(f.calls.length).toBe(2 * n)
  })

  test('a transport failure is not depth: nothing is cached, the pool is retried after retryMs, then it reads', async () => {
    const k = clock()
    let fail = true
    const ok = fakeIo([7])
    const io: DepthIo = { ...ok.io, quote: async (q) => (fail ? Promise.reject(new Error('fetch failed')) : ok.io.quote(q)) }
    const cache = new PoolDepthCache(pools([BTC]), io, { now: k.now, retryMs: 300_000 })
    await cache.settled()
    expect(cache.get()[BTC]!.impactBps.every((x) => x === null)).toBe(true) // not a "too large" tail
    fail = false
    k.c.t += 60_000
    await cache.settled()
    expect(cache.get()[BTC]!.impactBps.every((x) => x === null)).toBe(true) // retry not yet due
    k.c.t += 300_000
    await cache.settled()
    expect(cache.get()[BTC]!.impactBps[0]).toBe(7)
  })

  test('a failed refresh keeps the last good curve until the staleness limit, then null', async () => {
    const k = clock()
    let fail = false
    const ok = fakeIo([4])
    const io: DepthIo = { ...ok.io, block: async () => { if (fail) throw new Error('down'); return 1n } }
    const cache = new PoolDepthCache(pools([BTC]), io, { now: k.now })
    await cache.settled()
    fail = true
    k.c.t += 3_600_000 + 1
    await cache.settled()
    expect(cache.get()[BTC]!.impactBps[0]).toBe(4)
    k.c.t += 3 * 3_600_000
    expect(cache.get()[BTC]!.impactBps[0]).toBe(4) // 4 h 0 min: still within 6 h
    k.c.t += 2 * 3_600_000 + 1
    const d = cache.get()[BTC]!
    expect(d.impactBps.every((x) => x === null)).toBe(true)
    expect(d.asOf).toBe(0)
    expect(d.sizesUsd).toHaveLength(9)
  })

  test('a throwing or hanging chain read is contained: get() never throws and a review is never held', async () => {
    const io: DepthIo = { block: () => { throw new Error('sync boom') }, sqrtPrice: async () => 1n, quote: async () => 1n }
    const cache = new PoolDepthCache(pools([BTC]), io, { now: clock().now })
    expect(() => cache.get()).not.toThrow()
    await cache.settled()
    expect(cache.get()[BTC]!.impactBps.every((x) => x === null)).toBe(true)
    const hang = fakeIo(['hang'])
    const slow = new PoolDepthCache(pools([BTC]), hang.io, { now: clock().now, timeoutMs: 20 })
    const t = Date.now()
    await slow.settled()
    expect(Date.now() - t).toBeLessThan(2000)
    expect(slow.get()[BTC]!.impactBps.every((x) => x === null)).toBe(true)
  })

  test('over the keyed RPC budget: no calls, the pool is read as soon as the budget is back', async () => {
    const f = fakeIo([0])
    let over = true
    const cache = new PoolDepthCache(pools([BTC]), f.io, { now: clock().now, over: () => over })
    await cache.settled()
    expect(f.calls).toHaveLength(0)
    over = false
    await cache.settled()
    expect(f.quotes()).toHaveLength(9)
  })
})

describe('chain reads and wiring', () => {
  test('depthIoOf: QuoterV2 of the registry at the given block; slot0 at the given block', async () => {
    const seen: { to?: string; blockNumber?: bigint }[] = []
    const client = {
      getBlockNumber: async () => 77n,
      readContract: async (a: { blockNumber: bigint; functionName: string }) => { seen.push({ blockNumber: a.blockNumber }); return [5n, 0, 0, 0, 0, 0, true] },
      call: async (a: { to: string; blockNumber: bigint }) => {
        seen.push({ to: a.to, blockNumber: a.blockNumber })
        return { data: encodeFunctionResult({ abi: quoterV2Abi, functionName: 'quoteExactInputSingle', result: [999n, 0n, 0, 0n] }) }
      },
    } as unknown as PublicClient
    const io = depthIoOf(client, baseRegistry)
    expect(await io.block()).toBe(77n)
    expect(await io.sqrtPrice(address('USDC', baseRegistry), 78n)).toBe(5n)
    const out = await io.quote({ tokenIn: address('cbBTC', baseRegistry), tokenOut: address('USDC', baseRegistry), fee: 500, amountIn: 1n, blockNumber: 79n })
    expect(out).toBe(999n)
    expect(seen).toEqual([{ blockNumber: 78n }, { to: address('QuoterV2', baseRegistry), blockNumber: 79n }])
  })

  test('Base only: Monad or no registry gets no cache (no calls, no unread lines); the three live pools are listed', () => {
    const client = {} as PublicClient
    expect(poolDepthFor(baseRegistry, client)).toBeInstanceOf(PoolDepthCache)
    expect(poolDepthFor(monadRegistry, client)).toBeUndefined()
    expect(poolDepthFor(undefined, client)).toBeUndefined()
    expect(Object.keys(poolDepthFor(baseRegistry, client)!.get()).sort()).toEqual([...DEPTH_POOL_NAMES].sort())
  })
})
