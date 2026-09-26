import type { Address } from '@mamoru/domain'
import type { MultiSendCall } from '@mamoru/account/safe'
import type { LivePosition } from '@mamoru/account/live'
import { entry } from '@mamoru/registry'
import { approve, burn, collect, decreaseLiquidity, exactInputSingle } from '@mamoru/uniswap-v3'
import { positionUsdc, type PoolPosition, type PoolPrice } from './chain.ts'

/** A swap of `token` back to USDC on `pool`. */
export type SwapBack = { token: string; pool: string; amountIn: bigint; amountOutMinimum: bigint }

const strip = (c: { to: Address; value: bigint; data: `0x${string}` }): MultiSendCall => ({ to: c.to, value: c.value, data: c.data })

/**
 * Withdraw order: the policy's buckets in order (stables first: the largest and cheapest to unwind, then BTC,
 * then risk), positions outside the policy pools last.
 */
export function reduceOrder(positions: PoolPosition[], bucketPools: string[]): PoolPosition[] {
  const rank = (p: PoolPosition) => {
    const i = bucketPools.indexOf(p.pool)
    return i < 0 ? bucketPools.length : i
  }
  return positions.filter((p) => p.liquidity > 0n).sort((a, b) => rank(a) - rank(b) || (a.tokenId < b.tokenId ? -1 : 1))
}

/**
 * Which positions to reduce, and by how much, to free `need` raw USDC of value: whole pools in `reduceOrder`,
 * each only as far as still needed (a partial reduce is proportional over that pool's positions).
 * No rebalancing here: the next engine review restores the target mix from what is left.
 */
export function planReduce(positions: PoolPosition[], prices: Record<string, PoolPrice>, need: bigint, bucketPools: string[]): { pos: PoolPosition; bps: number }[] {
  const ordered = reduceOrder(positions, bucketPools)
  const pools = [...new Set(ordered.map((p) => p.pool))]
  const out: { pos: PoolPosition; bps: number }[] = []
  let remaining = need
  for (const pool of pools) {
    if (remaining <= 0n) break
    const ps = ordered.filter((p) => p.pool === pool)
    const value = ps.reduce((s, p) => s + positionUsdc(p, prices[pool]!.sqrtPriceX96), 0n)
    if (value === 0n) continue
    const bps = remaining >= value ? 10_000 : Math.min(10_000, Number((remaining * 10_000n) / value) + 1)
    for (const pos of ps) out.push({ pos, bps })
    remaining -= (value * BigInt(bps)) / 10_000n
  }
  return out
}

export function closeCalls(account: Address, ps: LivePosition[], deadline: bigint, burnIt: boolean): MultiSendCall[] {
  return ps.flatMap((p) =>
    [
      ...(p.liquidity > 0n ? [decreaseLiquidity({ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: p.amount0Min, amount1Min: p.amount1Min, deadline })] : []),
      collect({ account, tokenId: p.tokenId }),
      ...(burnIt ? [burn(p.tokenId)] : []),
    ].map(strip),
  )
}

/** Each swap: exact approve to SwapRouter02, exactInputSingle to the Safe, approve back to 0. */
export function swapBackCalls(account: Address, swaps: SwapBack[]): MultiSendCall[] {
  return swaps
    .filter((s) => s.amountIn > 0n)
    .flatMap((s) =>
      [
        approve(s.token, 'SwapRouter02', s.amountIn),
        exactInputSingle({ account, tokenIn: s.token, tokenOut: 'USDC', fee: entry(s.pool).fee!, amountIn: s.amountIn, amountOutMinimum: s.amountOutMinimum }),
        approve(s.token, 'SwapRouter02', 0n),
      ].map(strip),
    )
}

/** The pool a token is swapped back to USDC on: the policy's pool for it, else the first registry USDC pool that has it. */
export function routeOf(token: string, bucketPools: string[], usdcPools: string[]): string | undefined {
  const has = (p: string) => entry(p).token0 === token || entry(p).token1 === token
  return bucketPools.find(has) ?? usdcPools.find(has)
}
