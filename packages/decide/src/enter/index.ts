import type { ReasonCode } from '@mamoru/domain'
import { grantKeyFor, preferenceTotal, type PolicyVersion } from '@mamoru/policy'
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
 * otto/mamoru#251: the session key of an entry grant for `pool`, as allocate takes it: the plain name for a single-pair
 * policy, the pool's key otherwise, and under MamoruActionPolicyV3 alone (the Monad v6 Safe) the pool's manage-any. No
 * grant at all: the plain name, which no session carries, so the gate refuses it (SESSION_MISSING) as before.
 */
function entryKey<N extends 'enter-swap' | 'enter-mint'>(policy: PolicyVersion, name: N, pool: string): N {
  try {
    return grantKeyFor(policy, name, pool) as N
  } catch {
    return name
  }
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
  const totalPreference = preferenceTotal(policy)
  const target = (capital * BigInt(preference)) / BigInt(totalPreference)
  const half = target / 2n
  if (half === 0n) return { code: 'DECIDE_NO_CAPITAL', proposal: null }
  if (volatileValue * 4n < target) {
    const amountIn = half < free ? half : free
    return {
      code: 'STRATEGY_PREFERENCE',
      proposal: { kind: 'enter_swap', grant: entryKey(policy, 'enter-swap', pool.name), pool: pool.name, tokenIn: savings, tokenOut: volatile, fee: pool.fee, amountIn },
    }
  }
  const savingsIn = half < free ? half : free
  const range = rangeAround(pool.tick, policy.range.widthTicks, pool.tickSpacing)
  const savingsIs0 = pool.token0 === savings
  return {
    code: 'STRATEGY_PREFERENCE',
    proposal: {
      kind: 'enter_mint',
      grant: entryKey(policy, 'enter-mint', pool.name),
      pool: pool.name,
      ...range,
      amount0Desired: savingsIs0 ? savingsIn : volatileHeld,
      amount1Desired: savingsIs0 ? volatileHeld : savingsIn,
    },
  }
}
