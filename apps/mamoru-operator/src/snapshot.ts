// One read of every Safe the operator serves and of the pools they hold, pinned to one block (otto/mamoru#136).
// Phase 1: read-only and off by default (MAMORU_SNAPSHOT=1). Nothing decides from it yet: funding, the armed
// watcher and the engine keep their own reads, with their own provider and staleness rules.

import { decodeFunctionResult, encodeFunctionData, parseAbi, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, entry, erc20Abi, nonfungiblePositionManagerAbi, safeAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { BATCH_MAX_CALLS, Batch, balanceRead, contractRead, type Handle, type Read } from '@mamoru/rpc'
import { feeGrowthInside, positionFees } from '@mamoru/uniswap-v3/fees'
import { amountsForLiquidity, inUsdc, USDC_POOLS } from './chain.ts'

const enumerableAbi = parseAbi(['function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)'])

/**
 * Whether the Safe has code, inside the batch: Multicall3 calls a codeless address successfully and gets empty
 * return data (no Safe yet), while a deployed Safe answers getThreshold. If the call itself fails in the batch,
 * the retry on its own is a plain eth_getCode at the same block, so a failed read is never taken for "undeployed".
 */
function deployedRead(client: PublicClient, safe: Address, blockNumber: bigint): Read<boolean> {
  return {
    to: safe,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'getThreshold' }),
    decode: (returnData) => {
      if (returnData === '0x') return false
      decodeFunctionResult({ abi: safeAbi, functionName: 'getThreshold', data: returnData })
      return true
    },
    direct: async () => {
      const code = await client.getCode({ address: safe, blockNumber })
      return !!code && code !== '0x'
    },
  }
}

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
  /** Fee income since the position's last checkpoint (yield only). */
  accrued0: bigint
  accrued1: bigint
  /** tokensOwed at the checkpoint: earlier fees, and principal a decrease left uncollected. Not counted as yield. */
  owed0: bigint
  owed1: bigint
  /** What collect would pay now: owed + accrued (an estimate; the pool may round a few units down). */
  collectable0: bigint
  collectable1: bigint
  /** Principal of the position in raw USDC at the pool price. */
  valueUsdc: bigint
  /** Accrued fees in raw USDC at the pool price. */
  feesUsdc: bigint
  /** Owed amounts in raw USDC at the pool price. */
  owedUsdc: bigint
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
  /** Accrued fees of all positions: yield not yet collected. */
  feesUsdc: bigint
  /** Owed amounts of all positions (may include principal). */
  owedUsdc: bigint
  /** idle + lp + accrued + owed: everything the Safe would hold if it collected now. */
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
  if (!pool || !pools[pool]) throw new Error(`snapshot: no USDC pool prices ${token}`)
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
    slot0: first.add(contractRead(client, { address: address(p), abi: uniswapV3PoolAbi, functionName: 'slot0', ...at })),
    fg0: first.add(contractRead(client, { address: address(p), abi: uniswapV3PoolAbi, functionName: 'feeGrowthGlobal0X128', ...at })),
    fg1: first.add(contractRead(client, { address: address(p), abi: uniswapV3PoolAbi, functionName: 'feeGrowthGlobal1X128', ...at })),
  }))
  const safeReads = targets.map((t) => ({
    t,
    eth: first.add(balanceRead(client, multicall3, t.safe, block)),
    nfts: first.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [t.safe], ...at })),
    deployed: first.add(deployedRead(client, t.safe, block)),
    tokens: tokenNames.map((name) => ({ name, read: first.add(contractRead(client, { address: address(name), abi: erc20Abi, functionName: 'balanceOf', args: [t.safe], ...at })) })),
  }))
  await run(first)

  // A read that failed inside the batch is retried on its own at the same block (need()); if that fails too, the
  // whole snapshot fails and the loop keeps the previous one. No failed read is ever reported as a zero.
  const pools: Record<string, PoolState> = {}
  for (const r of poolReads) {
    const [s, fg0, fg1] = await Promise.all([r.slot0.need(), r.fg0.need(), r.fg1.need()])
    pools[r.pool] = { sqrtPriceX96: s[0], tick: s[1], feeGrowthGlobal0X128: fg0, feeGrowthGlobal1X128: fg1 }
  }
  const nftCounts = await Promise.all(safeReads.map((s) => s.nfts.need()))

  // Batch 2: token ids of Safes that hold positions.
  const second = new Batch(client, multicall3, block)
  const idReads = safeReads.map((s, i) => Array.from({ length: Number(nftCounts[i]!) }, (_, k) => second.add(contractRead(client, { address: npm, abi: enumerableAbi, functionName: 'tokenOfOwnerByIndex', args: [s.t.safe, BigInt(k)], ...at }))))
  await run(second)
  const ids = await Promise.all(idReads.map((reads) => Promise.all(reads.map((r) => r.need()))))

  // Batch 3: positions.
  const third = new Batch(client, multicall3, block)
  const posReads = ids.map((list) => list.map((tokenId) => ({ tokenId, read: third.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId], ...at })) })))
  await run(third)

  type Raw = { tokenId: bigint; pool: string; tickLower: number; tickUpper: number; liquidity: bigint; in0: bigint; in1: bigint; owed0: bigint; owed1: bigint }
  const raws: Raw[][] = []
  for (const list of posReads) {
    const out: Raw[] = []
    for (const { tokenId, read } of list) {
      const p = await read.need()
      // A position outside the USDC pools of the registry is not one Mamoru opened: left out, as readSafe does.
      const pool = USDC_POOLS.find((n) => {
        const e = entry(n)
        return p[2].toLowerCase() === address(e.token0!).toLowerCase() && p[3].toLowerCase() === address(e.token1!).toLowerCase() && p[4] === e.fee
      })
      if (!pool) continue
      out.push({ tokenId, pool, tickLower: p[5], tickUpper: p[6], liquidity: p[7], in0: p[8], in1: p[9], owed0: p[10], owed1: p[11] })
    }
    raws.push(out)
  }

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
  const ticks = new Map<string, readonly [bigint, bigint, bigint, bigint, bigint, bigint, number, boolean]>()
  for (const [key, h] of tickReads) ticks.set(key, await h.need())

  const safes: SafeSnapshot[] = []
  for (const [i, s] of safeReads.entries()) {
    const balances = await Promise.all(s.tokens.map((x) => x.read.need()))
    const tokens = Object.fromEntries(s.tokens.map((x, k) => [x.name, balances[k]!])) as Record<string, bigint>
    const eth = await s.eth.need()
    const positions: PositionSnapshot[] = []
    for (const r of raws[i]!) {
      const e = entry(r.pool)
      const ps = pools[r.pool]!
      const lower = ticks.get(`${r.pool}:${r.tickLower}`)!
      const upper = ticks.get(`${r.pool}:${r.tickUpper}`)!
      const { amount0, amount1 } = amountsForLiquidity(ps.sqrtPriceX96, r.tickLower, r.tickUpper, r.liquidity)
      const inside = feeGrowthInside(ps.tick, r.tickLower, r.tickUpper, ps.feeGrowthGlobal0X128, ps.feeGrowthGlobal1X128, { feeGrowthOutside0X128: lower[2], feeGrowthOutside1X128: lower[3] }, { feeGrowthOutside0X128: upper[2], feeGrowthOutside1X128: upper[3] })
      const f = positionFees({ liquidity: r.liquidity, feeGrowthInside0LastX128: r.in0, feeGrowthInside1LastX128: r.in1, tokensOwed0: r.owed0, tokensOwed1: r.owed1 }, inside)
      const usdc = (a0: bigint, a1: bigint) => inUsdc(r.pool, e.token0!, a0, ps.sqrtPriceX96) + inUsdc(r.pool, e.token1!, a1, ps.sqrtPriceX96)
      positions.push({
        tokenId: r.tokenId,
        pool: r.pool,
        token0: e.token0!,
        token1: e.token1!,
        liquidity: r.liquidity,
        tickLower: r.tickLower,
        tickUpper: r.tickUpper,
        inRange: ps.tick >= r.tickLower && ps.tick < r.tickUpper,
        amount0,
        amount1,
        accrued0: f.accrued0,
        accrued1: f.accrued1,
        owed0: r.owed0,
        owed1: r.owed1,
        collectable0: f.collectable0,
        collectable1: f.collectable1,
        valueUsdc: usdc(amount0, amount1),
        feesUsdc: usdc(f.accrued0, f.accrued1),
        owedUsdc: usdc(r.owed0, r.owed1),
      })
    }
    const idleUsdc = Object.entries(tokens).reduce((n, [name, amt]) => n + tokenUsdc(name, amt, pools), 0n)
    const lpUsdc = positions.reduce((n, p) => n + p.valueUsdc, 0n)
    const feesUsdc = positions.reduce((n, p) => n + p.feesUsdc, 0n)
    const owedUsdc = positions.reduce((n, p) => n + p.owedUsdc, 0n)
    safes.push({
      accountKey: s.t.accountKey,
      safe: s.t.safe,
      active: s.t.active,
      armed: s.t.armed,
      // Balances of an undeployed Safe are real too: tokens can be sent to its counterfactual address.
      deployed: await s.deployed.need(),
      eth,
      tokens,
      positions,
      idleUsdc,
      lpUsdc,
      feesUsdc,
      owedUsdc,
      totalUsdc: idleUsdc + lpUsdc + feesUsdc + owedUsdc,
    })
  }
  return { chainId, block, readAt: new Date().toISOString(), pools, safes, calls }
}

/** MAMORU_SNAPSHOT_MS: default 30 s; never under 10 s; anything not a finite number is the default. */
export function snapshotIntervalMs(raw: string | undefined): number {
  const n = Number(raw?.trim())
  if (!raw?.trim() || !Number.isFinite(n)) return 30_000
  return Math.max(10_000, n)
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
