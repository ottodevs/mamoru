import type { PublicClient } from 'viem'
import { BASE_CHAIN_ID, ReasonError, chainOf, isChainId, type Address, type ChainId } from '@mamoru/domain'
import { address, entry, erc20Abi, nonfungiblePositionManagerAbi, uniswapV3PoolAbi, type Registry } from '@mamoru/registry'
import { Batch, balanceRead, blockNumberRead, contractRead, createDeployedChecker, multicall3Of, tokenIdReads, type Handle } from '@mamoru/rpc'
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

/**
 * otto/mamoru#63: the pool whose slot0 readSafe reports as `sqrtPriceX96`/`tick`, per chain. A name here must be a
 * USDC pool of that chain's registry (`livePool` checks it). A chain without one has no live pool and readSafe refuses.
 */
const LIVE_POOLS: Record<ChainId, string> = {
  8453: 'pool:USDC/cbBTC/500',
  143: 'pool:WMON/USDC/3000',
}
/**
 * otto/mamoru#140 (part2 #4): position NFTs readSafe inspects at most. Anyone can send a Safe position NFTs; past
 * this many, only the ones Mamoru admitted are read (when the caller names them), else the first MAX_INVENTORY.
 */
export const MAX_INVENTORY = 64
const Q96 = 1n << 96n
const Q192 = 1n << 192n

/**
 * otto/mamoru#63: why the operator may not sign or send on `registry`'s chain, or null when it may. Base is written
 * to as always. Any other registry (Monad mainnet, its testnet, or a lab fork of either) is read only: the relayer
 * refuses every send, the loopback bundler is not started, owner prepares and submits answer CHAIN_READ_ONLY and no
 * engine or armed loop starts. Reading and valuing a Safe stay open.
 *
 * otto/mamoru#61: `writes` lifts this for one chain alone: its registry chain is in the MAMORU_CHAIN_WRITES opt-in
 * (`writes.optIn`) AND the RPC answers that very chain id (`writes.chainId`), never a lab fork id of it. boot.ts only
 * passes it once the chain's write registry is verified (`writeRegistry`).
 */
export function writeRefusal(registry: Registry, writes?: { chainId: number; optIn: readonly number[] }): string | null {
  if (registry.chainId === BASE_CHAIN_ID) return null
  if (writes && writes.chainId === registry.chainId && writes.optIn.includes(registry.chainId)) return null
  return `read only on ${registry.chain} (registry chain ${registry.chainId}): the operator signs and sends nothing off Base${writes?.optIn.includes(registry.chainId) ? ' (MAMORU_CHAIN_WRITES names it, but the RPC is not that chain)' : ''}`
}

/**
 * otto/mamoru#61: the pool that prices the chain's native asset in USDC for the engine's gas cost (decide). Absent for
 * a chain: no engine runs there (`nativePricePool` throws).
 */
const NATIVE_PRICE_POOLS: Record<ChainId, string> = {
  8453: 'pool:WETH/USDC/3000',
  143: 'pool:WMON/USDC/3000',
}

/** The native price pool of `registry`'s chain, a USDC pool of that registry pairing its wrapped native; else CHAIN_UNSUPPORTED. */
export function nativePricePool(registry: Registry): string {
  const pool = (NATIVE_PRICE_POOLS as Record<number, string | undefined>)[registry.chainId]
  const wrapped = isChainId(registry.chainId) ? chainOf(registry.chainId).wrappedNative : null
  const e = pool && usdcPools(registry).includes(pool) ? entry(pool, registry) : null
  if (!e || (e.token0 !== wrapped && e.token1 !== wrapped)) throw new ReasonError('CHAIN_UNSUPPORTED', `no native price pool for ${registry.chain}`)
  return pool!
}

const usdcPoolsOf = new WeakMap<Registry, string[]>()

/** Registry pools that pair USDC: the pools a position of the account can be read, valued and unwound in. */
export function usdcPools(registry: Registry): string[] {
  let pools = usdcPoolsOf.get(registry)
  if (!pools) {
    pools = registry.entries.filter((e) => e.kind === 'pool' && (e.token0 === 'USDC' || e.token1 === 'USDC')).map((e) => e.name)
    usdcPoolsOf.set(registry, pools)
  }
  return pools
}

/** The live pool of `registry`'s chain (see LIVE_POOLS), or CHAIN_UNSUPPORTED. */
export function livePool(registry: Registry): string {
  const pool = (LIVE_POOLS as Record<number, string | undefined>)[registry.chainId]
  if (!pool || !usdcPools(registry).includes(pool)) throw new ReasonError('CHAIN_UNSUPPORTED', `no live USDC pool for ${registry.chain}`)
  return pool
}

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
  /** slot0 of the chain's live pool (`livePool`). */
  sqrtPriceX96: bigint
  tick: number
  /** Balance of every token of the registry's USDC pools (`usdcPools`), by registry name. */
  tokens: Record<string, bigint>
  prices: Record<string, PoolPrice>
  /** Positions in any of the registry's USDC pools. */
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

/** Raw USDC worth `amount` of `token` at the slot0 of `pool` (a USDC pool of `registry`). */
export function inUsdc(pool: string, token: string, amount: bigint, sqrtPriceX96: bigint, registry: Registry): bigint {
  if (token === 'USDC' || amount === 0n) return amount
  const e = entry(pool, registry)
  return e.token0 === 'USDC' ? (amount * Q192) / (sqrtPriceX96 * sqrtPriceX96) : (amount * sqrtPriceX96 * sqrtPriceX96) / Q192
}

/** Raw units of the pool's other token per raw USDC, for computeCaps. */
export function priceOf(pool: string, sqrtPriceX96: bigint, registry: Registry): { asset: string; num: bigint; den: bigint } {
  const e = entry(pool, registry)
  return e.token0 === 'USDC' ? { asset: e.token1!, num: sqrtPriceX96 * sqrtPriceX96, den: Q192 } : { asset: e.token0!, num: Q192, den: sqrtPriceX96 * sqrtPriceX96 }
}

/**
 * otto/mamoru#140 (part2 #8): readSafe's amount0/amount1 come only from current liquidity; tokensOwed0/1 (fees, or
 * principal left by a decrease whose collect has not run yet) sit on the position too and are just as collectible
 * — collect() always sweeps both. Valuation counts them so a position is never reported worth less than it is.
 */
export function positionUsdc(p: PoolPosition, sqrtPriceX96: bigint, registry: Registry): bigint {
  return inUsdc(p.pool, p.token0, p.amount0 + p.tokensOwed0, sqrtPriceX96, registry) + inUsdc(p.pool, p.token1, p.amount1 + p.tokensOwed1, sqrtPriceX96, registry)
}

/**
 * Everything the Safe holds at one block: balances and its positions in every pool of `registry` that pairs USDC.
 * `registry` is the one of the chain `client` reads (otto/mamoru#63): every address comes from it.
 * One eth_call when it holds no position, two when it does: the block number rides inside the first Multicall3
 * call instead of a separate eth_blockNumber, and eth_getCode is asked only until the Safe's deployment is
 * confirmed (see `isDeployed`).
 */
export async function readSafe(client: PublicClient, safe: Address, registry: Registry, opts: { admitted?: readonly bigint[] } = {}): Promise<SafeRead> {
  const pools = usdcPools(registry)
  const live = livePool(registry)
  const npm = address('NonfungiblePositionManager', registry)
  const multicall3 = multicall3Of(registry)
  const tokenNames = [...new Set(pools.flatMap((p) => [entry(p, registry).token0!, entry(p, registry).token1!]))]
  const first = new Batch(client, multicall3, undefined)
  const blockRead = first.add(blockNumberRead(client, multicall3))
  const ethRead = first.add(balanceRead(client, multicall3, safe))
  const nftRead = first.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [safe] }))
  const balanceReads = tokenNames.map((t) => first.add(contractRead(client, { address: address(t, registry), abi: erc20Abi, functionName: 'balanceOf', args: [safe] })))
  const slotReads = pools.map((p) => first.add(contractRead(client, { address: address(p, registry), abi: uniswapV3PoolAbi, functionName: 'slot0' })))
  // The block is known only once `first` has run: the speculative ids carry none (they resolve through
  // `.maybe()` only), the one-more-request round of an account with more positions is pinned to it below.
  const idsOf = tokenIdReads(client, multicall3, first, safe, undefined, npm)
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
    Promise.all(balanceReads.map((r, i) => needAt(r, () => client.readContract({ address: address(tokenNames[i]!, registry), abi: erc20Abi, functionName: 'balanceOf', args: [safe], blockNumber })))),
    Promise.all(slotReads.map((r, i) => needAt(r, () => client.readContract({ address: address(pools[i]!, registry), abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber })))),
  ])
  const tokens = Object.fromEntries(tokenNames.map((t, i) => [t, balances[i]!]))
  const prices: Record<string, PoolPrice> = Object.fromEntries(pools.map((p, i) => [p, { sqrtPriceX96: slots[i]![0], tick: slots[i]![1] }]))
  const count = Number(nfts)
  // Over MAX_INVENTORY the ids are not enumerated: the admitted ones are read by id, each checked to still be the
  // Safe's (ownerOf), a burned or moved one skipped; without them, the first MAX_INVENTORY.
  const byId = count > MAX_INVENTORY && opts.admitted !== undefined
  if (count > MAX_INVENTORY) console.log(`[read] ${safe} holds ${count} position NFTs; reading ${byId ? `the ${opts.admitted!.length} admitted` : `the first ${MAX_INVENTORY}`}`)
  // At most MAX_INVENTORY admitted ids, the newest: the record is pruned to what the Safe still owns (operator readOf).
  const listed = byId ? [...opts.admitted!].slice(-MAX_INVENTORY) : await idsOf(Math.min(count, MAX_INVENTORY), blockNumber)
  const second = new Batch(client, multicall3, blockNumber)
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
    const pool = pools.find((n) => {
      const e = entry(n, registry)
      return p[2].toLowerCase() === address(e.token0!, registry).toLowerCase() && p[3].toLowerCase() === address(e.token1!, registry).toLowerCase() && p[4] === e.fee
    })
    if (!pool) continue
    const e = entry(pool, registry)
    const price = prices[pool]!
    const [tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1] = [p[5], p[6], p[7], p[10], p[11]]
    const { amount0, amount1 } = amountsForLiquidity(price.sqrtPriceX96, tickLower, tickUpper, liquidity)
    positions.push({ tokenId, pool, token0: e.token0!, token1: e.token1!, fee: e.fee!, liquidity, tickLower, tickUpper, inRange: price.tick >= tickLower && price.tick < tickUpper, amount0, amount1, tokensOwed0, tokensOwed1 })
  }
  const livePrice = prices[live]!
  return { block: blockNumber, deployed, eth, usdc: tokens.USDC ?? 0n, sqrtPriceX96: livePrice.sqrtPriceX96, tick: livePrice.tick, tokens, prices, positions, positionCount: count, ...(byId ? { byId, ownedIds: ids } : {}) }
}
