import type { PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, entry, erc20Abi, nonfungiblePositionManagerAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { Batch, MULTICALL3, balanceRead, blockNumberRead, contractRead, createDeployedChecker, tokenIdReads, type Handle } from '@mamoru/rpc'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'

/**
 * Stand-in for the chain's `safe` tag in `isSafeDeployed`, without the eth_getBlockByNumber a real one would
 * cost: a sighting this many blocks behind the one just read is treated as confirmed. ~450 blocks is about 15
 * minutes at Base's ~2 s blocks, the same order as Ethereum L1 finality; a reorg past it would be extraordinary.
 * Its own checker (not the engine's `isDeployed`): a confirmation accepted on this looser, heuristic basis can
 * never let the engine's observe() skip eth_getCode on its own, stricter terms, whatever either one decides.
 */
const SAFE_SIGHTING_LAG = 450n
const isSafeDeployed = createDeployedChecker()

export const LIVE_POOL = 'pool:USDC/cbBTC/500'
/**
 * otto/mamoru#140 (part2 #4): position NFTs readSafe inspects at most. Anyone can send a Safe position NFTs; past
 * this many, only the ones Mamoru admitted are read (when the caller names them), else the first MAX_INVENTORY.
 */
export const MAX_INVENTORY = 64
const Q96 = 1n << 96n
const Q192 = 1n << 192n

/** Registry pools that pair USDC: the pools a position of the account can be read, valued and unwound in. */
export const USDC_POOLS = baseRegistry.entries.filter((e) => e.kind === 'pool' && (e.token0 === 'USDC' || e.token1 === 'USDC')).map((e) => e.name)

export type PoolPosition = {
  tokenId: bigint
  pool: string
  token0: string
  token1: string
  fee: number
  liquidity: bigint
  tickLower: number
  tickUpper: number
  inRange: boolean
  amount0: bigint
  amount1: bigint
  /** Settled fees/principal (from a past collect-less decrease) the position already owes, not reflected in amount0/amount1: see positionUsdc. */
  tokensOwed0: bigint
  tokensOwed1: bigint
}

export type PoolPrice = { sqrtPriceX96: bigint; tick: number }

export type SafeRead = {
  block: bigint
  deployed: boolean
  eth: bigint
  usdc: bigint
  cbbtc: bigint
  /** pool:USDC/cbBTC/500 slot0. */
  sqrtPriceX96: bigint
  tick: number
  /** Balance of every token of USDC_POOLS. */
  tokens: Record<string, bigint>
  prices: Record<string, PoolPrice>
  /** Positions in any of USDC_POOLS. */
  positions: PoolPosition[]
  /** Position NFTs the Safe holds in all, read or not (see MAX_INVENTORY). */
  positionCount?: number
  /** The admitted ids were read one by one (over MAX_INVENTORY); `ownedIds` are the ones still the Safe's. */
  byId?: boolean
  ownedIds?: bigint[]
}

/** Token amounts of `liquidity` between two ticks at `sqrtPriceX96`. */
export function amountsForLiquidity(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const a = sqrtRatioAtTick(tickLower)
  const b = sqrtRatioAtTick(tickUpper)
  const s = sqrtPriceX96 < a ? a : sqrtPriceX96 > b ? b : sqrtPriceX96
  const amount0 = s < b ? ((liquidity << 96n) * (b - s)) / b / s : 0n
  const amount1 = s > a ? (liquidity * (s - a)) / Q96 : 0n
  return { amount0, amount1 }
}

/** cbBTC raw units in USDC raw units at the pool price (token0 USDC). */
export function cbbtcInUsdc(amount1: bigint, sqrtPriceX96: bigint): bigint {
  return (amount1 << 192n) / (sqrtPriceX96 * sqrtPriceX96)
}

/** Raw USDC worth `amount` of `token` at the slot0 of `pool` (a USDC pool). */
export function inUsdc(pool: string, token: string, amount: bigint, sqrtPriceX96: bigint): bigint {
  if (token === 'USDC' || amount === 0n) return amount
  const e = entry(pool, baseRegistry)
  return e.token0 === 'USDC' ? (amount * Q192) / (sqrtPriceX96 * sqrtPriceX96) : (amount * sqrtPriceX96 * sqrtPriceX96) / Q192
}

/** Raw units of the pool's other token per raw USDC, for computeCaps. */
export function priceOf(pool: string, sqrtPriceX96: bigint): { asset: string; num: bigint; den: bigint } {
  const e = entry(pool, baseRegistry)
  return e.token0 === 'USDC' ? { asset: e.token1!, num: sqrtPriceX96 * sqrtPriceX96, den: Q192 } : { asset: e.token0!, num: Q192, den: sqrtPriceX96 * sqrtPriceX96 }
}

/**
 * otto/mamoru#140 (part2 #8): readSafe's amount0/amount1 come only from current liquidity; tokensOwed0/1 (fees, or
 * principal left by a decrease whose collect has not run yet) sit on the position too and are just as collectible
 * — collect() always sweeps both. Valuation counts them so a position is never reported worth less than it is.
 */
export function positionUsdc(p: PoolPosition, sqrtPriceX96: bigint): bigint {
  return inUsdc(p.pool, p.token0, p.amount0 + p.tokensOwed0, sqrtPriceX96) + inUsdc(p.pool, p.token1, p.amount1 + p.tokensOwed1, sqrtPriceX96)
}

/**
 * Everything the Safe holds at one block: balances and its positions in every registry pool that pairs USDC.
 * One eth_call when it holds no position, two when it does: the block number rides inside the first Multicall3
 * call instead of a separate eth_blockNumber, and eth_getCode is asked only until the Safe's deployment is
 * confirmed (see `isDeployed`).
 */
export async function readSafe(client: PublicClient, safe: Address, opts: { admitted?: readonly bigint[] } = {}): Promise<SafeRead> {
  const npm = address('NonfungiblePositionManager', baseRegistry)
  const tokenNames = [...new Set(USDC_POOLS.flatMap((p) => [entry(p, baseRegistry).token0!, entry(p, baseRegistry).token1!]))]
  const first = new Batch(client, MULTICALL3, undefined)
  const blockRead = first.add(blockNumberRead(client, MULTICALL3))
  const ethRead = first.add(balanceRead(client, MULTICALL3, safe))
  const nftRead = first.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [safe] }))
  const balanceReads = tokenNames.map((t) => first.add(contractRead(client, { address: address(t, baseRegistry), abi: erc20Abi, functionName: 'balanceOf', args: [safe] })))
  const slotReads = USDC_POOLS.map((p) => first.add(contractRead(client, { address: address(p, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' })))
  // The block is known only once `first` has run: the speculative ids carry none (they resolve through
  // `.maybe()` only), the one-more-request round of an account with more positions is pinned to it below.
  const idsOf = tokenIdReads(client, MULTICALL3, first, safe)
  await first.run()
  // Not `.need()`: its retry falls back to an unpinned, unbatched getBlockNumber(), which can answer from a
  // later block than the one `first`'s other reads actually came from (the head may have moved by then).
  // There is no block to retroactively pin that retry to without defeating the point of reading it from this
  // same batch, so a sub-call this batch answered with everything else failing is reason enough to fail the
  // whole read: the caller gets a fresh, consistent one on its next try instead of a reported block that
  // does not match the values next to it.
  const bn = blockRead.maybe()
  if (bn === null) throw new Error('readSafe: the block number did not come back with the first Multicall3 call')
  const blockNumber = bn
  const at = { blockNumber } as const
  // `.need()`'s retry of a read that failed inside `first` would otherwise resolve at an unrelated, unpinned
  // "latest": everything readSafe reports must come from `blockNumber`, the one `first` itself answered at.
  const needAt = <T>(h: Handle<T>, retry: () => Promise<T>): Promise<T> => {
    const v = h.maybe()
    return v === null ? retry() : Promise.resolve(v)
  }
  const safeNumber = blockNumber > SAFE_SIGHTING_LAG ? blockNumber - SAFE_SIGHTING_LAG : 0n
  const [deployed, eth, nfts, balances, slots] = await Promise.all([
    isSafeDeployed(client, safe, blockNumber, safeNumber),
    needAt(ethRead, () => client.getBalance({ address: safe, blockNumber })),
    needAt(nftRead, () => client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [safe], blockNumber })),
    Promise.all(balanceReads.map((r, i) => needAt(r, () => client.readContract({ address: address(tokenNames[i]!, baseRegistry), abi: erc20Abi, functionName: 'balanceOf', args: [safe], blockNumber })))),
    Promise.all(slotReads.map((r, i) => needAt(r, () => client.readContract({ address: address(USDC_POOLS[i]!, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber })))),
  ])
  const tokens = Object.fromEntries(tokenNames.map((t, i) => [t, balances[i]!]))
  const prices: Record<string, PoolPrice> = Object.fromEntries(USDC_POOLS.map((p, i) => [p, { sqrtPriceX96: slots[i]![0], tick: slots[i]![1] }]))
  const count = Number(nfts)
  // Over MAX_INVENTORY the ids are not enumerated: the admitted ones are read by id, each checked to still be the
  // Safe's (ownerOf), a burned or moved one skipped; without them, the first MAX_INVENTORY.
  const byId = count > MAX_INVENTORY && opts.admitted !== undefined
  if (count > MAX_INVENTORY) console.log(`[read] ${safe} holds ${count} position NFTs; reading ${byId ? `the ${opts.admitted!.length} admitted` : `the first ${MAX_INVENTORY}`}`)
  // At most MAX_INVENTORY admitted ids, the newest: the record is pruned to what the Safe still owns (operator readOf).
  const listed = byId ? [...opts.admitted!].slice(-MAX_INVENTORY) : await idsOf(Math.min(count, MAX_INVENTORY), blockNumber)
  const second = new Batch(client, MULTICALL3, blockNumber)
  const positionReads = listed.map((tokenId) => second.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId], ...at })))
  const ownerReads = byId ? listed.map((tokenId) => second.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', args: [tokenId], ...at }))) : []
  if (second.size > 0) await second.run()
  // A burned admitted id reverts ownerOf: skipped. A read that failed for any other reason fails the whole read, so
  // a provider error never shows as a position that is not there.
  const owned = async (i: number): Promise<boolean> => {
    try {
      return (await ownerReads[i]!.need()).toLowerCase() === safe.toLowerCase()
    } catch (e) {
      if (/revert|nonexistent|invalid token/i.test((e as Error).message ?? '')) return false
      throw e
    }
  }
  const keep = byId ? await Promise.all(listed.map((_, i) => owned(i))) : listed.map(() => true)
  const ids = listed.filter((_, i) => keep[i])
  const positions: PoolPosition[] = []
  for (const tokenId of ids) {
    const p = await positionReads[listed.indexOf(tokenId)]!.need()
    const pool = USDC_POOLS.find((n) => {
      const e = entry(n, baseRegistry)
      return p[2].toLowerCase() === address(e.token0!, baseRegistry).toLowerCase() && p[3].toLowerCase() === address(e.token1!, baseRegistry).toLowerCase() && p[4] === e.fee
    })
    if (!pool) continue
    const e = entry(pool, baseRegistry)
    const price = prices[pool]!
    const [tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1] = [p[5], p[6], p[7], p[10], p[11]]
    const { amount0, amount1 } = amountsForLiquidity(price.sqrtPriceX96, tickLower, tickUpper, liquidity)
    positions.push({ tokenId, pool, token0: e.token0!, token1: e.token1!, fee: e.fee!, liquidity, tickLower, tickUpper, inRange: price.tick >= tickLower && price.tick < tickUpper, amount0, amount1, tokensOwed0, tokensOwed1 })
  }
  const live = prices[LIVE_POOL]!
  return { block: blockNumber, deployed, eth, usdc: tokens.USDC ?? 0n, cbbtc: tokens.cbBTC ?? 0n, sqrtPriceX96: live.sqrtPriceX96, tick: live.tick, tokens, prices, positions, positionCount: count, ...(byId ? { byId, ownedIds: ids } : {}) }
}
