import type { PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, entry, erc20Abi, nonfungiblePositionManagerAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { Batch, MULTICALL3, balanceRead, contractRead, tokenIdReads, isDeployed } from '@mamoru/rpc'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'

export const LIVE_POOL = 'pool:USDC/cbBTC/500'
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
  const e = entry(pool)
  return e.token0 === 'USDC' ? (amount * Q192) / (sqrtPriceX96 * sqrtPriceX96) : (amount * sqrtPriceX96 * sqrtPriceX96) / Q192
}

/** Raw units of the pool's other token per raw USDC, for computeCaps. */
export function priceOf(pool: string, sqrtPriceX96: bigint): { asset: string; num: bigint; den: bigint } {
  const e = entry(pool)
  return e.token0 === 'USDC' ? { asset: e.token1!, num: sqrtPriceX96 * sqrtPriceX96, den: Q192 } : { asset: e.token0!, num: Q192, den: sqrtPriceX96 * sqrtPriceX96 }
}

export function positionUsdc(p: PoolPosition, sqrtPriceX96: bigint): bigint {
  return inUsdc(p.pool, p.token0, p.amount0, sqrtPriceX96) + inUsdc(p.pool, p.token1, p.amount1, sqrtPriceX96)
}

/** Everything the Safe holds at one block: balances and its positions in every registry pool that pairs USDC. Two eth_call through Multicall3. */
export async function readSafe(client: PublicClient, safe: Address): Promise<SafeRead> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
  const at = { blockNumber } as const
  const npm = address('NonfungiblePositionManager')
  const tokenNames = [...new Set(USDC_POOLS.flatMap((p) => [entry(p).token0!, entry(p).token1!]))]
  const first = new Batch(client, MULTICALL3, blockNumber)
  const ethRead = first.add(balanceRead(client, MULTICALL3, safe, blockNumber))
  const nftRead = first.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [safe], ...at }))
  const balanceReads = tokenNames.map((t) => first.add(contractRead(client, { address: address(t), abi: erc20Abi, functionName: 'balanceOf', args: [safe], ...at })))
  const slotReads = USDC_POOLS.map((p) => first.add(contractRead(client, { address: address(p), abi: uniswapV3PoolAbi, functionName: 'slot0', ...at })))
  const idsOf = tokenIdReads(client, MULTICALL3, first, safe, blockNumber)
  const [deployed] = await Promise.all([isDeployed(client, safe, blockNumber), first.run()])
  const [eth, nfts, balances, slots] = await Promise.all([ethRead.need(), nftRead.need(), Promise.all(balanceReads.map((r) => r.need())), Promise.all(slotReads.map((r) => r.need()))])
  const tokens = Object.fromEntries(tokenNames.map((t, i) => [t, balances[i]!]))
  const prices: Record<string, PoolPrice> = Object.fromEntries(USDC_POOLS.map((p, i) => [p, { sqrtPriceX96: slots[i]![0], tick: slots[i]![1] }]))
  const ids = await idsOf(Number(nfts))
  const second = new Batch(client, MULTICALL3, blockNumber)
  const positionReads = ids.map((tokenId) => second.add(contractRead(client, { address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId], ...at })))
  if (second.size > 0) await second.run()
  const positions: PoolPosition[] = []
  for (const [i, tokenId] of ids.entries()) {
    const p = await positionReads[i]!.need()
    const pool = USDC_POOLS.find((n) => {
      const e = entry(n)
      return p[2].toLowerCase() === address(e.token0!).toLowerCase() && p[3].toLowerCase() === address(e.token1!).toLowerCase() && p[4] === e.fee
    })
    if (!pool) continue
    const e = entry(pool)
    const price = prices[pool]!
    const [tickLower, tickUpper, liquidity] = [p[5], p[6], p[7]]
    const { amount0, amount1 } = amountsForLiquidity(price.sqrtPriceX96, tickLower, tickUpper, liquidity)
    positions.push({ tokenId, pool, token0: e.token0!, token1: e.token1!, fee: e.fee!, liquidity, tickLower, tickUpper, inRange: price.tick >= tickLower && price.tick < tickUpper, amount0, amount1 })
  }
  const live = prices[LIVE_POOL]!
  return { block: blockNumber, deployed, eth, usdc: tokens.USDC ?? 0n, cbbtc: tokens.cbBTC ?? 0n, sqrtPriceX96: live.sqrtPriceX96, tick: live.tick, tokens, prices, positions }
}
