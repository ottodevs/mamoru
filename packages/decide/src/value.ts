import type { RegistryName } from '@mamoru/registry'
import { token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import type { Observation, PoolObs } from './types.ts'

/** Raw units of the savings asset worth `amount` of `token`, at the pool's slot0. The pool must pair the two. */
export function inSavings(pool: PoolObs, token: RegistryName, amount: bigint, savings: RegistryName): bigint {
  if (token === savings) return amount
  if (pool.token0 === token && pool.token1 === savings) return token0InToken1(amount, pool.sqrtPriceX96)
  if (pool.token1 === token && pool.token0 === savings) return token1InToken0(amount, pool.sqrtPriceX96)
  throw new Error(`${pool.name} does not price ${token} in ${savings}`)
}

/** Estimated cost of one userOp in the savings asset: gas budget times the bid, priced with the ETH price pool. */
export function opCostInSavings(obs: Observation, savings: RegistryName): bigint {
  const wei = obs.gas.opGasUnits * obs.gas.maxFeePerGas
  const p = obs.ethPrice
  return p.token0 === savings ? token1InToken0(wei, p.sqrtPriceX96) : token0InToken1(wei, p.sqrtPriceX96)
}

export function volatileOf(pool: PoolObs, savings: RegistryName): RegistryName {
  if (pool.token0 === savings) return pool.token1
  if (pool.token1 === savings) return pool.token0
  throw new Error(`${pool.name} does not pair ${savings}`)
}
