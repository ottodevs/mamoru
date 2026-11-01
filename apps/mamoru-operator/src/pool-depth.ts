import type { PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import type { Observation } from '@mamoru/decide'
import { baseRegistry, entry, uniswapV3PoolAbi, type Registry } from '@mamoru/registry'
import { quoterV2, token0InToken1, token1InToken0, type QuoteRequest } from '@mamoru/uniswap-v3/quote'

/**
 * otto/mamoru#101 phase 1c (shadow only): the exit-direction price impact curve of each live pool that pairs USDC, for
 * Packaging's EEL, exit slippage and position ratio rules. Selling the pool's non-USDC token for USDC, USD sizes on a
 * fixed ladder converted to the sell token at the pool's slot0 mid price, each quoted with QuoterV2 (an eth_call at one
 * block, the same helper the engine's swaps use).
 * - impactBps = round((1 - amountOut / expectedOut) * 10_000), clamped at 0, where expectedOut = amountIn at mid * (1 - fee):
 *   the pool fee is not in the impact (the rule adds it).
 * - A revert or a zero output means "too large / no liquidity": that size and every larger one are null; the ladder stops.
 *   Any other failure (timeout, transport, budget) is not liquidity: the refresh of that pool is dropped, the last good
 *   curve is kept until `staleMs`, and it is retried after `retryMs`.
 * - Cost: per refresh one eth_blockNumber, then per pool one slot0 read and at most 9 quotes, sequential, each with a
 *   timeout; hourly. Skipped while the keyed RPC budget (`over`) is spent. Memory only: a restart reads again at the first
 *   review (11 calls per pool), so there is no state file.
 * Nothing here throws into a review.
 */

type Depth = NonNullable<Observation['poolDepth']>[string]

/** USD sizes of the ladder, ascending. */
export const DEPTH_LADDER_USD = [1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000, 3_000_000, 10_000_000] as const

export type DepthPool = { name: string; address: Address; token0: string; token1: string; fee: number; token0Address: Address; token1Address: Address; usdcAddress: Address; usdcDecimals: number }

/** What the cache needs from the chain: the head, slot0 `sqrtPriceX96` at it, and one QuoterV2 quote. */
export type DepthIo = {
  block(): Promise<bigint>
  sqrtPrice(pool: Address, block: bigint): Promise<bigint>
  quote(q: QuoteRequest): Promise<bigint>
}

/** Raw output of the pool fee-free mid price for `amountIn` of the sell token, in raw USDC. */
function midOut(amountIn: bigint, sqrt: bigint, sellIsToken0: boolean): bigint {
  return sellIsToken0 ? token0InToken1(amountIn, sqrt) : token1InToken0(amountIn, sqrt)
}

/** impact in bps from the quote against the fee-adjusted mid output; null when there is nothing to compare. */
export function impactBpsOf(amountOut: bigint, expectedOut: bigint): number | null {
  if (expectedOut <= 0n) return null
  if (amountOut >= expectedOut) return 0
  return Number(((expectedOut - amountOut) * 10_000n * 2n + expectedOut) / (expectedOut * 2n))
}

/** A call that reverted: the pool cannot fill the size. Everything else (network, timeout) is an unread, not a depth. */
const reverted = (e: unknown): boolean => /revert|execution reverted|out of gas|STF|SPL/i.test((e as Error)?.message ?? '')

export class PoolDepthCache {
  private readonly cache = new Map<string, { at: number; sizesUsd: number[]; impactBps: (number | null)[]; feeBps: number }>()
  private readonly lastTry = new Map<string, number>()
  private inFlight: Promise<void> | null = null
  private readonly now: () => number
  private readonly refreshMs: number
  private readonly staleMs: number
  private readonly timeoutMs: number
  private readonly retryMs: number
  private readonly over: () => boolean

  constructor(
    private readonly pools: DepthPool[],
    private readonly io: DepthIo,
    opts: { now?: () => number; refreshMs?: number; staleMs?: number; timeoutMs?: number; retryMs?: number; over?: () => boolean } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.refreshMs = opts.refreshMs ?? 3_600_000
    this.staleMs = opts.staleMs ?? 6 * 3_600_000
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.retryMs = opts.retryMs ?? 300_000
    this.over = opts.over ?? (() => false)
  }

  /** What the engine's `poolDepth` callback returns: synchronous, from memory; starts a background refresh when one is due. */
  get(): NonNullable<Observation['poolDepth']> {
    this.kick()
    const out: NonNullable<Observation['poolDepth']> = {}
    const now = this.now()
    for (const p of this.pools) {
      const c = this.cache.get(p.name)
      const fresh = c && now - c.at <= this.staleMs ? c : undefined
      // Every pool gets an entry, also before the first read ends: a null curve is reported unread, never silent.
      out[p.name] = {
        sizesUsd: [...DEPTH_LADDER_USD],
        impactBps: fresh ? [...fresh.impactBps] : DEPTH_LADDER_USD.map(() => null),
        feeBps: fresh?.feeBps ?? p.fee / 100,
        asOf: fresh ? Math.floor(fresh.at / 1000) : 0,
      } satisfies Depth
    }
    return out
  }

  /** Fire and forget; never throws. */
  kick(): void {
    if (this.inFlight) return
    const now = this.now()
    if (!this.pools.some((p) => now - (this.lastTry.get(p.name) ?? -Infinity) >= this.refreshMs)) return
    this.inFlight = this.refresh().catch(() => {}).finally(() => { this.inFlight = null })
  }

  /** Resolves when the refresh in flight (or a new one) is done; for tests and boot. */
  async settled(): Promise<void> {
    this.kick()
    await this.inFlight
  }

  private async refresh(): Promise<void> {
    let block: bigint | undefined
    for (const p of this.pools) {
      const now = this.now()
      if (now - (this.lastTry.get(p.name) ?? -Infinity) < this.refreshMs) continue
      // Over the keyed RPC budget the background read waits; the last curve ages on.
      if (this.over()) return
      // Marked before the calls: a failing pool is retried soon (below), never on every review.
      this.lastTry.set(p.name, now)
      try {
        block ??= await this.timed(this.io.block())
        const curve = await this.curveOf(p, block)
        this.cache.set(p.name, { at: now, ...curve })
      } catch {
        this.lastTry.set(p.name, now - this.refreshMs + this.retryMs)
        // The head read failed: the next pool would fail the same way; try it again on the next kick.
        block = undefined
      }
    }
  }

  private async curveOf(p: DepthPool, block: bigint): Promise<{ sizesUsd: number[]; impactBps: (number | null)[]; feeBps: number }> {
    const sqrt = await this.timed(this.io.sqrtPrice(p.address, block))
    if (sqrt <= 0n) throw new Error('slot0 price is zero')
    const sellIsToken0 = p.token0Address.toLowerCase() !== p.usdcAddress.toLowerCase()
    const tokenIn = sellIsToken0 ? p.token0Address : p.token1Address
    const impactBps: (number | null)[] = []
    let stopped = false
    for (const usd of DEPTH_LADDER_USD) {
      if (stopped) {
        impactBps.push(null)
        continue
      }
      const usdcRaw = BigInt(usd) * 10n ** BigInt(p.usdcDecimals)
      // Sell-token amount worth `usd` at mid (before the fee), then what the pool should give for it after the fee.
      const amountIn = sellIsToken0 ? token1InToken0(usdcRaw, sqrt) : token0InToken1(usdcRaw, sqrt)
      if (amountIn <= 0n) throw new Error('size rounds to zero')
      const expected = (midOut(amountIn, sqrt, sellIsToken0) * BigInt(1_000_000 - p.fee)) / 1_000_000n
      let out: bigint
      try {
        out = await this.timed(this.io.quote({ tokenIn, tokenOut: p.usdcAddress, fee: p.fee, amountIn, blockNumber: block }))
      } catch (e) {
        if (!reverted(e)) throw e
        out = 0n
      }
      const bps = out > 0n ? impactBpsOf(out, expected) : null
      impactBps.push(bps)
      if (bps === null) stopped = true
    }
    return { sizesUsd: [...DEPTH_LADDER_USD], impactBps, feeBps: p.fee / 100 }
  }

  private timed<T>(p: Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), this.timeoutMs) })
    return Promise.race([p, timeout]).finally(() => clearTimeout(t))
  }
}

/** The live Base pools that pair USDC, by registry name (the same three Packaging policies list). */
export const DEPTH_POOL_NAMES = ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'] as const

export function depthPoolsOf(names: readonly string[], registry: Registry): DepthPool[] {
  const usdc = entry('USDC', registry)
  return names.map((name) => {
    const e = entry(name, registry)
    return {
      name, address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!,
      token0Address: entry(e.token0!, registry).address, token1Address: entry(e.token1!, registry).address,
      usdcAddress: usdc.address, usdcDecimals: usdc.decimals ?? 6,
    }
  })
}

/** The chain reads of one registry on `client`: QuoterV2 through `quoterV2(registry)`, slot0 through the pool ABI. */
export function depthIoOf(client: PublicClient, registry: Registry): DepthIo {
  const q = quoterV2(registry)
  return {
    block: () => client.getBlockNumber(),
    sqrtPrice: async (pool, blockNumber) => {
      const [sqrtPriceX96] = await client.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber })
      return sqrtPriceX96
    },
    quote: (r) => q.quoteExactInputSingle(client, r),
  }
}

/** The cache for the Base live pools. */
export function livePoolDepth(client: PublicClient, opts: { over?: () => boolean } = {}): PoolDepthCache {
  return new PoolDepthCache(depthPoolsOf(DEPTH_POOL_NAMES, baseRegistry), depthIoOf(client, baseRegistry), opts)
}

/**
 * The cache the operator of `registry` runs: Base only (the ladder lists the Base pools, and their QuoterV2). Another chain
 * (Monad) or no registry gets none: no calls, no "unread" lines for pools it does not have.
 */
export function poolDepthFor(registry: Registry | undefined, client: PublicClient, opts: { over?: () => boolean } = {}): PoolDepthCache | undefined {
  return registry?.chainId === baseRegistry.chainId ? livePoolDepth(client, opts) : undefined
}
