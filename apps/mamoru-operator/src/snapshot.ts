// One read of every Safe the operator serves and of the pools they hold, pinned to one block (otto/mamoru#136).
// Phase 1: read-only and off by default (MAMORU_SNAPSHOT=1). Nothing decides from it yet: funding, the armed
// watcher and the engine keep their own reads, with their own provider and staleness rules.

import { parseAbi, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, entry, erc20Abi, nonfungiblePositionManagerAbi, safeAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { BATCH_MAX_CALLS, Batch, balanceRead, contractRead, type Handle } from '@mamoru/rpc'
import { feeGrowthInside, uncollectedFees } from '@mamoru/uniswap-v3/fees'
import { amountsForLiquidity, inUsdc, USDC_POOLS } from './chain.ts'

const enumerableAbi = parseAbi(['function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)'])

export type SnapshotTarget = { accountKey: string; safe: Address; active: boolean; armed: boolean }

export type PoolState = { sqrtPriceX96: bigint; tick: number; feeGrowthGlobal0X128: bigint; feeGrowthGlobal1X128: bigint }

export type PositionSnapshot = {
  tokenId: bigint
  pool: string
  token0: string
  token1: string
  liquidity: bigint
  tickLower: number
  tickUpper: number
  inRange: boolean
  amount0: bigint
  amount1: bigint
  fees0: bigint
  fees1: bigint
  /** Principal of the position in raw USDC at the pool price. */
  valueUsdc: bigint
  /** Uncollected fees in raw USDC at the pool price. */
  feesUsdc: bigint
}

export type SafeSnapshot = {
  accountKey: string
  safe: Address
  active: boolean
  armed: boolean
  deployed: boolean
  eth: bigint
  /** Balance of every token of USDC_POOLS, raw units. */
  tokens: Record<string, bigint>
  positions: PositionSnapshot[]
  /** Tokens held outside positions, in raw USDC. ETH (gas) is left out. */
  idleUsdc: bigint
  lpUsdc: bigint
  feesUsdc: bigint
  /** idle + lp + uncollected fees. */
  totalUsdc: bigint
}

export type Snapshot = {
  chainId: number
  block: bigint
  readAt: string
  pools: Record<string, PoolState>
  safes: SafeSnapshot[]
  /** eth_call requests this snapshot cost (one per Multicall3 chunk). */
  calls: number
}

/** The pool of USDC_POOLS that prices `token` in USDC: the first one pairing it with USDC. */
function pricingPool(token: string): string | null {
  return USDC_POOLS.find((p) => entry(p).token0 === token || entry(p).token1 === token) ?? null
}

function tokenUsdc(token: string, amount: bigint, pools: Record<string, PoolState>): bigint {
  if (token === 'USDC' || amount === 0n) return amount
  const pool = pricingPool(token)
  if (!pool || !pools[pool]) return 0n
  return inUsdc(pool, token, amount, pools[pool]!.sqrtPriceX96)
}

/**
 * Everything the targets hold at one block. Batches, all through Multicall3 at the same block:
 * 1. block number, every pool's slot0 and fee growth, every Safe's ETH, tokens, NFT count and Safe code check;
 * 2. tokenOfOwnerByIndex for Safes holding positions;
 * 3. positions(tokenId);
 * 4. ticks(lower) and ticks(upper) of every position, deduplicated per pool.
 * The cost is a handful of eth_call whatever the number of Safes, split only by Multicall3's per-call limits.
 */
export async function readSnapshot(client: PublicClient, multicall3: Address, chainId: number, targets: SnapshotTarget[]): Promise<Snapshot> {
  // One eth_blockNumber pins every batch to the same block, however many Multicall3 chunks they split into.
  const block = await client.getBlockNumber({ cacheTime: 0 })
  const at = { blockNumber: block } as const
  let calls = 1
  // Our reads are under 100 bytes each, so BATCH_MAX_CALLS, not BATCH_MAX_BYTES, decides the chunks.
  const run = async (b: Batch) => {
    if (b.size === 0) return
    calls += Math.ceil(b.size / BATCH_MAX_CALLS)
    await b.run()
  }
  const npm = address('NonfungiblePositionManager')
  const tokenNames = [...new Set(USDC_POOLS.flatMap((p) => [entry(p).token0!, entry(p).token1!]))]

  const first = new Batch(client, multicall3, block)
  const poolReads = USDC_POOLS.map((p) => ({
    pool: p,
    slot0: first.add(contractRead(client, { address: address(p), abi: uniswapV3PoolAbi, functionName: 'slot0' })),
    fg0: first.add(contractRead(client, { address: address(p), abi: uniswapV3PoolAbi, functionName: 'feeGrowthGlobal0X128' })),
    fg1: first.add(contractRead(client, { address: address(p), abi: uniswapV3PoolAbi, functionName: 'feeGrowthGlobal1X128' })),
  }))
  const safeReads = targets.map((t) => ({
    t,
    eth: first.add(balanceRead(client, multicall3, t.safe)),
    nfts: first.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [t.safe] })),
    // Fails on an undeployed Safe (no code): that failure is the deployed check, at no extra request.
    threshold: first.add(contractRead(client, { address: t.safe, abi: safeAbi, functionName: 'getThreshold' })),
    tokens: tokenNames.map((name) => ({ name, read: first.add(contractRead(client, { address: address(name), abi: erc20Abi, functionName: 'balanceOf', args: [t.safe] })) })),
  }))
  await run(first)

  const pools: Record<string, PoolState> = {}
  for (const r of poolReads) {
    const s = r.slot0.maybe()
    const fg0 = r.fg0.maybe()
    const fg1 = r.fg1.maybe()
    if (!s || fg0 === null || fg1 === null) continue
    pools[r.pool] = { sqrtPriceX96: s[0], tick: s[1], feeGrowthGlobal0X128: fg0, feeGrowthGlobal1X128: fg1 }
  }

  // Batch 2: token ids of Safes that hold positions.
  const second = new Batch(client, multicall3, block)
  const idReads = safeReads.map((s) => {
    const n = Number(s.nfts.maybe() ?? 0n)
    return Array.from({ length: n }, (_, i) => second.add(contractRead(client, { address: npm, abi: enumerableAbi, functionName: 'tokenOfOwnerByIndex', args: [s.t.safe, BigInt(i)], ...at })))
  })
  await run(second)

  // Batch 3: positions.
  const third = new Batch(client, multicall3, block)
  const posReads = idReads.map((reads) =>
    reads.map((r) => r.maybe()).filter((id): id is bigint => id !== null).map((tokenId) => ({ tokenId, read: third.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId], ...at })) })),
  )
  await run(third)

  type Raw = { tokenId: bigint; pool: string; tickLower: number; tickUpper: number; liquidity: bigint; in0: bigint; in1: bigint; owed0: bigint; owed1: bigint }
  const raws: Raw[][] = posReads.map((list) => {
    const out: Raw[] = []
    for (const { tokenId, read } of list) {
      const p = read.maybe()
      if (!p) continue
      const pool = USDC_POOLS.find((n) => {
        const e = entry(n)
        return p[2].toLowerCase() === address(e.token0!).toLowerCase() && p[3].toLowerCase() === address(e.token1!).toLowerCase() && p[4] === e.fee
      })
      if (!pool || !pools[pool]) continue
      out.push({ tokenId, pool, tickLower: p[5], tickUpper: p[6], liquidity: p[7], in0: p[8], in1: p[9], owed0: p[10], owed1: p[11] })
    }
    return out
  })

  // Batch 4: the two ticks of every position, once per (pool, tick).
  const fourth = new Batch(client, multicall3, block)
  const tickReads = new Map<string, Handle<readonly [bigint, bigint, bigint, bigint, bigint, bigint, number, boolean]>>()
  for (const r of raws.flat()) {
    for (const tick of [r.tickLower, r.tickUpper]) {
      const key = `${r.pool}:${tick}`
      if (!tickReads.has(key)) tickReads.set(key, fourth.add(contractRead(client, { address: address(r.pool), abi: uniswapV3PoolAbi, functionName: 'ticks', args: [tick], ...at })))
    }
  }
  await run(fourth)

  const safes: SafeSnapshot[] = safeReads.map((s, i) => {
    const tokens = Object.fromEntries(s.tokens.map((x) => [x.name, x.read.maybe() ?? 0n])) as Record<string, bigint>
    const positions: PositionSnapshot[] = []
    for (const r of raws[i]!) {
      const e = entry(r.pool)
      const ps = pools[r.pool]!
      const lower = tickReads.get(`${r.pool}:${r.tickLower}`)!.maybe()
      const upper = tickReads.get(`${r.pool}:${r.tickUpper}`)!.maybe()
      const { amount0, amount1 } = amountsForLiquidity(ps.sqrtPriceX96, r.tickLower, r.tickUpper, r.liquidity)
      let fees0 = r.owed0
      let fees1 = r.owed1
      if (lower && upper) {
        const inside = feeGrowthInside(ps.tick, r.tickLower, r.tickUpper, ps.feeGrowthGlobal0X128, ps.feeGrowthGlobal1X128, { feeGrowthOutside0X128: lower[2], feeGrowthOutside1X128: lower[3] }, { feeGrowthOutside0X128: upper[2], feeGrowthOutside1X128: upper[3] })
        ;({ fees0, fees1 } = uncollectedFees({ liquidity: r.liquidity, feeGrowthInside0LastX128: r.in0, feeGrowthInside1LastX128: r.in1, tokensOwed0: r.owed0, tokensOwed1: r.owed1 }, inside))
      }
      const valueUsdc = inUsdc(r.pool, e.token0!, amount0, ps.sqrtPriceX96) + inUsdc(r.pool, e.token1!, amount1, ps.sqrtPriceX96)
      const feesUsdc = inUsdc(r.pool, e.token0!, fees0, ps.sqrtPriceX96) + inUsdc(r.pool, e.token1!, fees1, ps.sqrtPriceX96)
      positions.push({ tokenId: r.tokenId, pool: r.pool, token0: e.token0!, token1: e.token1!, liquidity: r.liquidity, tickLower: r.tickLower, tickUpper: r.tickUpper, inRange: ps.tick >= r.tickLower && ps.tick < r.tickUpper, amount0, amount1, fees0, fees1, valueUsdc, feesUsdc })
    }
    const idleUsdc = Object.entries(tokens).reduce((n, [name, amt]) => n + tokenUsdc(name, amt, pools), 0n)
    const lpUsdc = positions.reduce((n, p) => n + p.valueUsdc, 0n)
    const feesUsdc = positions.reduce((n, p) => n + p.feesUsdc, 0n)
    return {
      accountKey: s.t.accountKey,
      safe: s.t.safe,
      active: s.t.active,
      armed: s.t.armed,
      deployed: s.threshold.maybe() !== null,
      eth: s.eth.maybe() ?? 0n,
      tokens,
      positions,
      idleUsdc,
      lpUsdc,
      feesUsdc,
      totalUsdc: idleUsdc + lpUsdc + feesUsdc,
    }
  })
  return { chainId, block, readAt: new Date().toISOString(), pools, safes, calls }
}

/** Reads a snapshot every `intervalMs` and keeps the latest. Off unless started; a failed read keeps the previous one. */
export class SnapshotLoop {
  private latest: Snapshot | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  lastError: string | null = null

  constructor(
    private readonly read: () => Promise<Snapshot>,
    private readonly intervalMs: number,
    /** Over the keyed CU budget the loop reads at most once per `slowMs`, like the other loops that can wait. */
    private readonly overBudget: () => boolean = () => false,
    private readonly slowMs: number = 60_000,
  ) {}

  get current(): Snapshot | null {
    return this.latest
  }

  start(): void {
    if (this.running) return
    this.running = true
    const tick = async () => {
      try {
        this.latest = await this.read()
        this.lastError = null
      } catch (err) {
        this.lastError = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'snapshot failed'
      }
      if (this.running) this.timer = setTimeout(tick, this.overBudget() ? Math.max(this.slowMs, this.intervalMs) : this.intervalMs)
    }
    void tick()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
