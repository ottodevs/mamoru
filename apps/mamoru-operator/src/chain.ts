import { parseAbi, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, entry, erc20Abi, nonfungiblePositionManagerAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'

export const LIVE_POOL = 'pool:USDC/cbBTC/500'
const Q96 = 1n << 96n
const enumerableAbi = parseAbi(['function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)'])

export type PoolPosition = { tokenId: bigint; liquidity: bigint; tickLower: number; tickUpper: number; inRange: boolean; amount0: bigint; amount1: bigint }

export type SafeRead = {
  block: bigint
  deployed: boolean
  eth: bigint
  usdc: bigint
  cbbtc: bigint
  sqrtPriceX96: bigint
  tick: number
  positions: PoolPosition[]
}

/** Token amounts of `liquidity` between two ticks at `sqrtPriceX96` (token0 USDC, token1 cbBTC). */
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

/** Everything the Safe holds at one block: balances and its positions in pool:USDC/cbBTC/500. */
export async function readSafe(client: PublicClient, safe: Address): Promise<SafeRead> {
  const blockNumber = await client.getBlockNumber()
  const at = { blockNumber } as const
  const npm = address('NonfungiblePositionManager')
  const pool = entry(LIVE_POOL)
  const [code, eth, usdc, cbbtc, nfts, slot0] = await Promise.all([
    client.getCode({ address: safe, ...at }),
    client.getBalance({ address: safe, ...at }),
    client.readContract({ address: address('USDC'), abi: erc20Abi, functionName: 'balanceOf', args: [safe], ...at }),
    client.readContract({ address: address('cbBTC'), abi: erc20Abi, functionName: 'balanceOf', args: [safe], ...at }),
    client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [safe], ...at }),
    client.readContract({ address: pool.address, abi: uniswapV3PoolAbi, functionName: 'slot0', ...at }),
  ])
  const [sqrtPriceX96, tick] = [slot0[0], slot0[1]]
  const ids = await Promise.all(Array.from({ length: Number(nfts) }, (_, i) => client.readContract({ address: npm, abi: enumerableAbi, functionName: 'tokenOfOwnerByIndex', args: [safe, BigInt(i)], ...at })))
  const usdcAddr = address('USDC').toLowerCase()
  const cbbtcAddr = address('cbBTC').toLowerCase()
  const positions: PoolPosition[] = []
  for (const tokenId of ids) {
    const p = await client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId], ...at })
    if (p[2].toLowerCase() !== usdcAddr || p[3].toLowerCase() !== cbbtcAddr || p[4] !== pool.fee) continue
    const [tickLower, tickUpper, liquidity] = [p[5], p[6], p[7]]
    const { amount0, amount1 } = amountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity)
    positions.push({ tokenId, liquidity, tickLower, tickUpper, inRange: tick >= tickLower && tick < tickUpper, amount0, amount1 })
  }
  return { block: blockNumber, deployed: !!code && code !== '0x', eth, usdc, cbbtc, sqrtPriceX96, tick, positions }
}
