import type { RegistryName } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import type { Observation, PoolObs, Proposal } from './types.ts'
import { inSavings } from './value.ts'

/**
 * otto/mamoru#410: MamoruActionPolicyV4 refuses a swap, mint or increase worth more than 1/DEPTH_MULTIPLE of the pool's
 * depth over its band (I2, `_requireDepth`), whatever the daily budget. The operator reads that bound per pool
 * (`Observation.opRoom`, in raw savings units, with margin); a priced op above it is cut down to it, so a thin pool
 * takes a large entry over several reviews instead of refusing every one (AA23). An entry cut under `minEntry` waits
 * (DECIDE_WAIT_DEPTH); a sale (exit, depeg, release, harvest) is only cut, never dropped. Decreases are not priced.
 * A pool without a bound in `opRoom` is left as it is.
 */
export function fitOpRoom(p: Proposal, obs: Observation, savings: RegistryName, minEntry: bigint): Proposal | null {
  if (p.kind !== 'enter_swap' && p.kind !== 'enter_mint' && p.kind !== 'increase_liquidity') return p
  const room = obs.opRoom?.find((r) => r.pool === p.pool)?.room
  if (room === undefined) return p
  const pool = obs.pools.find((x) => x.name === p.pool)
  if (!pool) return p
  const value = p.kind === 'enter_swap' ? valueOf(pool, [[p.tokenIn, p.amountIn]], savings) : valueOf(pool, [[pool.token0, p.amount0Desired], [pool.token1, p.amount1Desired]], savings)
  if (value <= room) return p
  const entry = p.kind !== 'enter_swap' || (p.tokenIn === savings && !p.harvestSale)
  if (entry && room < minEntry) return null
  if (room === 0n) return null
  const cut = (a: bigint) => (a * room) / value
  if (p.kind === 'enter_swap') return { ...p, amountIn: cut(p.amountIn) }
  return { ...p, amount0Desired: cut(p.amount0Desired), amount1Desired: cut(p.amount1Desired) }
}

/** The larger of the amounts' value at slot0 and at the TWAP: the cut never relies on the cheaper of the two prices. */
function valueOf(pool: PoolObs, amounts: [RegistryName, bigint][], savings: RegistryName): bigint {
  const at = (q: PoolObs) => amounts.reduce((s, [t, a]) => s + inSavings(q, t, a, savings), 0n)
  const spot = at(pool)
  const twap = pool.twapTick === null ? spot : at({ ...pool, sqrtPriceX96: sqrtRatioAtTick(pool.twapTick) })
  return spot > twap ? spot : twap
}
