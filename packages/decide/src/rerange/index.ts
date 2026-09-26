import type { ReasonCode } from '@mamoru/domain'
import { hasManageAny, type PolicyVersion } from '@mamoru/policy'
import type { RegistryName } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import type { EnterSwapProposal, Observation, PoolObs, PositionObs, RerangeProposal, ReduceProposal } from '../types.ts'
import { inSavings, opCostInSavings, volatileOf } from '../value.ts'

const Q96 = 1n << 96n
/** Re-range when the price is within this share of the width from an edge. */
export const EDGE_BPS = 1000
/** Reduce a bucket that sits more than this many basis points of total value above its target. */
export const DRIFT_BPS = 500

/**
 * Owner decision 2026-09-26: with the live `manage-any` grant every position
 * the Safe holds in a policy pool is managed, not only the ids the owner
 * activated one by one.
 */
export function isManaged(p: PositionObs, policy: PolicyVersion, policyPools: ReadonlySet<string>): boolean {
  if (!p.pool || !policyPools.has(p.pool)) return false
  return p.managed || hasManageAny(policy)
}

/** Token amounts of `liquidity` between two ticks at `sqrtPriceX96`. */
export function amountsOf(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const a = sqrtRatioAtTick(tickLower)
  const b = sqrtRatioAtTick(tickUpper)
  const s = sqrtPriceX96 < a ? a : sqrtPriceX96 > b ? b : sqrtPriceX96
  const amount0 = s < b ? ((liquidity << 96n) * (b - s)) / b / s : 0n
  const amount1 = s > a ? (liquidity * (s - a)) / Q96 : 0n
  return { amount0, amount1 }
}

/** Value of a position in the savings asset: principal at the pool price plus what is collectable. */
export function positionValue(p: PositionObs, pool: PoolObs, savings: RegistryName): bigint {
  const { amount0, amount1 } = amountsOf(pool.sqrtPriceX96, p.tickLower, p.tickUpper, p.liquidity)
  return inSavings(pool, pool.token0, amount0 + p.collectable0, savings) + inSavings(pool, pool.token1, amount1 + p.collectable1, savings)
}

/**
 * Re-range (policy.range.adjust = on_out_of_range, live grant manage-any):
 * the price left the range, or sits within 10% of the width from an edge,
 * and the cooldown since the last re-range passed. The op takes the whole
 * position back into the Safe (decrease all, collect to the Safe, burn);
 * the next review's entry mints a new centred range from the freed tokens.
 */
export function rerangeOf(obs: Observation, policy: PolicyVersion, p: PositionObs, pool: PoolObs): { code: ReasonCode | null; proposal: RerangeProposal | null } {
  if (!hasManageAny(policy) || policy.range.adjust !== 'on_out_of_range') return { code: null, proposal: null }
  const width = p.tickUpper - p.tickLower
  const outside = pool.tick < p.tickLower || pool.tick >= p.tickUpper
  const edge = Math.min(pool.tick - p.tickLower, p.tickUpper - pool.tick)
  const near = !outside && edge * 10_000 < width * EDGE_BPS
  if (!outside && !near) return { code: null, proposal: null }
  const last = obs.lastRerangeAt ?? null
  if (last !== null && obs.block.timestamp - last < BigInt(policy.range.cooldownSeconds)) return { code: 'DECIDE_RANGE_COOLDOWN', proposal: null }
  return { code: 'DECIDE_RANGE_ADJUST', proposal: { kind: 'rerange', grant: 'manage-any', pool: pool.name, tokenId: p.tokenId, liquidity: p.liquidity } }
}

export type BucketValue = { bucket: string; target: bigint; value: bigint; pool: RegistryName | null }

/**
 * Bucket values against their targets. A bucket's value is its managed
 * positions; a bucket with no pool holds the free savings asset. Idle
 * volatile tokens count only in the total.
 */
export function bucketValues(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>): { total: bigint; buckets: BucketValue[] } {
  const savings = policy.savingsAsset
  const free = obs.balances[savings] ?? 0n
  let total = free
  const counted = new Set<string>()
  for (const pool of obs.pools) {
    if (!policyPools.has(pool.name)) continue
    const v = volatileOf(pool, savings)
    if (counted.has(v)) continue
    counted.add(v)
    total += inSavings(pool, v, obs.balances[v] ?? 0n, savings)
  }
  const byPool = new Map<string, bigint>()
  for (const p of obs.positions) {
    const pool = p.pool ? obs.pools.find((x) => x.name === p.pool) : undefined
    if (!pool || !isManaged(p, policy, policyPools)) continue
    const v = positionValue(p, pool, savings)
    total += v
    byPool.set(pool.name, (byPool.get(pool.name) ?? 0n) + v)
  }
  const totalPreference = BigInt(policy.buckets.reduce((s, b) => s + b.preference, 0))
  const buckets = policy.buckets.map((b) => {
    const pool = b.pools[0] ?? null
    const value = pool ? (byPool.get(pool) ?? 0n) : b.id === 'stables' ? free : 0n
    return { bucket: b.id, target: (total * BigInt(b.preference)) / totalPreference, value, pool }
  })
  return { total, buckets }
}

/**
 * Reduce (owner rule 2026-09-26, live grant manage-any): a bucket whose
 * positions sit more than 5 percentage points of total value above its
 * target gives back the excess, as a partial decrease collected to the
 * Safe. The freed savings flow to the under-weight buckets through the
 * normal entries. Below the op cost times the harvest factor it holds.
 */
export function reduceOf(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>): { code: ReasonCode | null; proposal: ReduceProposal | null } {
  if (!hasManageAny(policy)) return { code: null, proposal: null }
  const { total, buckets } = bucketValues(obs, policy, policyPools)
  if (total === 0n) return { code: null, proposal: null }
  for (const b of buckets) {
    if (!b.pool || b.value * 10_000n <= b.target * 10_000n + total * BigInt(DRIFT_BPS)) continue
    const pool = obs.pools.find((x) => x.name === b.pool)
    const p = obs.positions.find((x) => x.pool === b.pool && x.liquidity > 0n && isManaged(x, policy, policyPools))
    if (!pool || !p) continue
    const excess = b.value - b.target
    if (excess * 10_000n <= opCostInSavings(obs, policy.savingsAsset) * BigInt(policy.harvest.costFactorBps)) return { code: 'DECIDE_HARVEST_BELOW_COST', proposal: null }
    const pv = positionValue(p, pool, policy.savingsAsset)
    const liquidity = pv === 0n ? 0n : (p.liquidity * (excess < pv ? excess : pv)) / pv
    if (liquidity === 0n) continue
    return { code: 'STRATEGY_PREFERENCE_DEVIATION', proposal: { kind: 'reduce', grant: 'manage-any', pool: pool.name, tokenId: p.tokenId, liquidity } }
  }
  return { code: null, proposal: null }
}

/**
 * After a re-range the freed tokens are one-sided. With the volatile side
 * well above half the bucket target and too little of the savings asset,
 * convert the volatile excess back first (grant convert-any), so the entry
 * can mint a centred range with both tokens.
 */
export function ratioConvertOf(obs: Observation, policy: PolicyVersion, preference: number, pool: PoolObs, free: bigint): EnterSwapProposal | null {
  if (!hasManageAny(policy)) return null
  const savings = policy.savingsAsset
  const volatile = volatileOf(pool, savings)
  const held = obs.balances[volatile] ?? 0n
  const value = inSavings(pool, volatile, held, savings)
  const capital = free + value
  if (capital === 0n || value === 0n) return null
  const totalPreference = policy.buckets.reduce((s, b) => s + b.preference, 0)
  const half = (capital * BigInt(preference)) / BigInt(totalPreference) / 2n
  if (value * 2n <= half * 3n || free >= half) return null
  const amountIn = (held * (value - half)) / value
  if (amountIn === 0n) return null
  return { kind: 'enter_swap', grant: 'convert-any', pool: pool.name, tokenIn: volatile, tokenOut: savings, fee: pool.fee, amountIn }
}
