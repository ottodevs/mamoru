import type { RegistryName } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import type { Observation, PoolObs, Proposal } from './types.ts'
import { inSavings } from './value.ts'

/**
 * otto/mamoru#410: MamoruActionPolicyV4 refuses a swap, mint or increase worth more than 1/DEPTH_MULTIPLE of the pool's
 * depth over its band (I2, `_requireDepth`), whatever the daily budget. The operator reads that bound per pool
 * (`Observation.opRoom`, in raw savings units, with margin); a priced op above it is cut down to it, so a thin pool
 * takes a large entry over several reviews instead of refusing every one (AA23). A room under `floor` (the minimum
 * entry, or ten times one op's gas when more) holds the op (DECIDE_WAIT_DEPTH), a sale too: it would only spend gas on
 * slivers, and arbitrage refills the band within blocks. Decreases are not priced, so an exit's decrease always goes.
 * A pool without a bound in `opRoom` is left as it is.
 *
 * V4 values the op at the edge of its range (the TWAP band hull, a few band widths from the spot at most); the
 * operator's 20% margin on the room covers that for every V4 band (100 ticks, ~1%, at most today).
 */
export function fitOpRoom(p: Proposal, obs: Observation, savings: RegistryName, floor: bigint): Proposal | null {
  if (p.kind !== 'enter_swap' && p.kind !== 'enter_mint' && p.kind !== 'increase_liquidity') return p
  const room = obs.opRoom?.find((r) => r.pool === p.pool)?.room
  if (room === undefined) return p
  const pool = obs.pools.find((x) => x.name === p.pool)
  if (!pool) return p
  const value = p.kind === 'enter_swap' ? valueOf(pool, [[p.tokenIn, p.amountIn]], savings) : valueOf(pool, [[pool.token0, p.amount0Desired], [pool.token1, p.amount1Desired]], savings)
  if (value <= room) return p
  if (room < floor || room === 0n) return null
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
