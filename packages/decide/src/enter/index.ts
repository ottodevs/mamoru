import type { ReasonCode } from '@mamoru/domain'
import type { PolicyVersion } from '@mamoru/policy'
import { rangeAround } from '@mamoru/uniswap-v3/quote'
import type { Observation, PoolObs, Proposal } from '../types.ts'
import { inSavings, volatileOf } from '../value.ts'

/** Savings asset the account holds from deposits that are already `safe`. */
export function safeSavings(obs: Observation, policy: PolicyVersion): bigint {
  const savings = policy.savingsAsset
  const unsafe = obs.deposits.filter((d) => d.token === savings && !d.safe).reduce((s, d) => s + d.amount, 0n)
  const held = obs.balances[savings] ?? 0n
  return held > unsafe ? held - unsafe : 0n
}

/**
 * Plan §9, step 7, for one bucket with an executable pool and no managed
 * position: Strategy sizes the bucket by preference; with free savings and
 * too little of the volatile token for the range, swap; with both, mint.
 */
export function enterBucket(obs: Observation, policy: PolicyVersion, preference: number, pool: PoolObs): { code: ReasonCode; proposal: Proposal | null } {
  const savings = policy.savingsAsset
  const volatile = volatileOf(pool, savings)
  const free = safeSavings(obs, policy)
  const volatileHeld = obs.balances[volatile] ?? 0n
  const volatileValue = inSavings(pool, volatile, volatileHeld, savings)
  const capital = free + volatileValue
  if (capital === 0n) return { code: 'DECIDE_NO_CAPITAL', proposal: null }
  const totalPreference = policy.buckets.reduce((s, b) => s + b.preference, 0)
  const target = (capital * BigInt(preference)) / BigInt(totalPreference)
  const half = target / 2n
  if (half === 0n) return { code: 'DECIDE_NO_CAPITAL', proposal: null }
  if (volatileValue * 4n < target) {
    const amountIn = half < free ? half : free
    return {
      code: 'STRATEGY_PREFERENCE',
      proposal: { kind: 'enter_swap', grant: 'enter-swap', pool: pool.name, tokenIn: savings, tokenOut: volatile, fee: pool.fee, amountIn },
    }
  }
  const savingsIn = half < free ? half : free
  const range = rangeAround(pool.tick, policy.range.widthTicks, pool.tickSpacing)
  const savingsIs0 = pool.token0 === savings
  return {
    code: 'STRATEGY_PREFERENCE',
    proposal: {
      kind: 'enter_mint',
      grant: 'enter-mint',
      pool: pool.name,
      ...range,
      amount0Desired: savingsIs0 ? savingsIn : volatileHeld,
      amount1Desired: savingsIs0 ? volatileHeld : savingsIn,
    },
  }
}
