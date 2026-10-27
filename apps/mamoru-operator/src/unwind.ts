import type { Address } from '@mamoru/domain'
import type { MultiSendCall } from '@mamoru/account/safe'
import type { LivePosition } from '@mamoru/account/live'
import { address, entry, erc4626Abi, type Registry } from '@mamoru/registry'
import { encodeFunctionData } from 'viem'
import { uniswapV3 } from '@mamoru/uniswap-v3'
import { positionUsdc, type PoolPosition, type PoolPrice, type VaultHolding } from './chain.ts'

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
  // otto/mamoru#140 (part1 #4 / part2 #8): a position can be worth decreasing+collecting with 0 current liquidity
  // if a past decrease left tokensOwed uncollected — collect() sweeps it regardless of how much liquidity a call
  // in the same batch removes. Excluding it here left that value with no path out of the Safe.
  return positions.filter((p) => p.liquidity > 0n || p.tokensOwed0 > 0n || p.tokensOwed1 > 0n).sort((a, b) => rank(a) - rank(b) || (a.tokenId < b.tokenId ? -1 : 1))
}

/**
 * Which positions to reduce, and by how much, to free `need` raw USDC of value: whole pools in `reduceOrder`,
 * each only as far as still needed (a partial reduce is proportional over that pool's positions).
 * No rebalancing here: the next engine review restores the target mix from what is left.
 */
export function planReduce(positions: PoolPosition[], prices: Record<string, PoolPrice>, need: bigint, bucketPools: string[], registry: Registry): { pos: PoolPosition; bps: number }[] {
  const ordered = reduceOrder(positions, bucketPools)
  const pools = [...new Set(ordered.map((p) => p.pool))]
  const out: { pos: PoolPosition; bps: number }[] = []
  let remaining = need
  for (const pool of pools) {
    if (remaining <= 0n) break
    const ps = ordered.filter((p) => p.pool === pool)
    const value = ps.reduce((s, p) => s + positionUsdc(p, prices[pool]!.sqrtPriceX96, registry), 0n)
    if (value === 0n) continue
    const bps = remaining >= value ? 10_000 : Math.min(10_000, Number((remaining * 10_000n) / value) + 1)
    for (const pos of ps) out.push({ pos, bps })
    remaining -= (value * BigInt(bps)) / 10_000n
  }
  return out
}

export function closeCalls(account: Address, ps: LivePosition[], deadline: bigint, burnIt: boolean, registry: Registry): MultiSendCall[] {
  const { burn, collect, decreaseLiquidity } = uniswapV3(registry)
  return ps.flatMap((p) =>
    [
      ...(p.liquidity > 0n ? [decreaseLiquidity({ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: p.amount0Min, amount1Min: p.amount1Min, deadline })] : []),
      collect({ account, tokenId: p.tokenId }),
      ...(burnIt ? [burn(p.tokenId)] : []),
    ].map(strip),
  )
}

/** Each swap: exact approve to SwapRouter02, exactInputSingle to the Safe, approve back to 0. */
export function swapBackCalls(account: Address, swaps: SwapBack[], registry: Registry): MultiSendCall[] {
  const { approve, exactInputSingle } = uniswapV3(registry)
  return swaps
    .filter((s) => s.amountIn > 0n)
    .flatMap((s) =>
      [
        approve(s.token, 'SwapRouter02', s.amountIn),
        exactInputSingle({ account, tokenIn: s.token, tokenOut: 'USDC', fee: entry(s.pool, registry).fee!, amountIn: s.amountIn, amountOutMinimum: s.amountOutMinimum }),
        approve(s.token, 'SwapRouter02', 0n),
      ].map(strip),
    )
}

/** The pool a token is swapped back to USDC on: the policy's pool for it, else the first registry USDC pool that has it. */
export function routeOf(token: string, bucketPools: string[], usdcPools: string[], registry: Registry): string | undefined {
  const has = (p: string) => entry(p, registry).token0 === token || entry(p, registry).token1 === token
  return bucketPools.find(has) ?? usdcPools.find(has)
}

/**
 * otto/mamoru#210: what an owner exit takes out of the Safe's vaults: `withdraw(assets)` for part of a vault, `redeem`
 * of every share when the whole vault goes (no share dust left behind). `all`: every share (Stop).
 */
export type VaultExit = { vault: string; assets: bigint; shares: bigint; all: boolean }

/**
 * otto/mamoru#210: the vault part of a withdrawal or a Stop. Vaults first (they are the stables bucket and pay out
 * without a swap), in `order` (the policy's), each only as far as still needed and never past what it can pay now
 * (`maxWithdraw`). `need` null: everything (Stop). Returns the exits and what of `need` the vaults cannot pay now.
 */
export function planVaultExit(vaults: readonly VaultHolding[], need: bigint | null, order: readonly string[]): { exits: VaultExit[]; short: bigint } {
  const rank = (v: VaultHolding) => {
    const i = order.indexOf(v.name)
    return i < 0 ? order.length : i
  }
  const exits: VaultExit[] = []
  let remaining = need
  let short = 0n
  for (const v of [...vaults].filter((x) => x.shares > 0n).sort((a, b) => rank(a) - rank(b))) {
    if (remaining !== null && remaining <= 0n) break
    const want = remaining === null || remaining >= v.assets ? v.assets : remaining
    const payable = want < v.maxWithdraw ? want : v.maxWithdraw
    if (payable < want) short += want - payable
    if (payable > 0n) {
      // The whole holding, payable in full: redeem every share. Otherwise withdraw the assets (the vault rounds up the shares).
      const all = payable === v.assets && v.maxRedeem >= v.shares
      exits.push({ vault: v.name, assets: payable, shares: all ? v.shares : 0n, all })
    }
    if (remaining !== null) remaining -= payable
  }
  if (remaining !== null && remaining > 0n) short = remaining > short ? remaining : short
  return { exits, short }
}

export function vaultExitCalls(account: Address, exits: readonly VaultExit[], registry: Registry): MultiSendCall[] {
  return exits.map((x) => ({
    to: address(x.vault, registry),
    value: 0n,
    data: x.all
      ? encodeFunctionData({ abi: erc4626Abi, functionName: 'redeem', args: [x.shares, account, account] })
      : encodeFunctionData({ abi: erc4626Abi, functionName: 'withdraw', args: [x.assets, account, account] }),
  }))
}
