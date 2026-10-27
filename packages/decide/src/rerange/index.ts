import type { ReasonCode } from '@mamoru/domain'
import { grantKeyFor, hasManageAny, preferenceTotal, type PolicyVersion } from '@mamoru/policy'
import type { RegistryName } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { edgeBpsOf, widenEarly } from '../geometry/index.ts'
import type { EnterSwapProposal, Observation, PoolObs, PositionObs, RerangeProposal, ReduceProposal } from '../types.ts'
import { inSavings, opCostInSavings, volatileOf } from '../value.ts'
import { rerangeWorth } from '../rebalance/lazy.ts'

const Q96 = 1n << 96n

/** Session key of a live manage grant for `pool`: `name`, or `name:<pool>` on a multi-pool policy. */
export function anyKey<N extends 'manage-any' | 'convert-any'>(policy: PolicyVersion, name: N, pool: string): N | `${N}:${string}` {
  return grantKeyFor(policy, name, pool) as N | `${N}:${string}`
}

/**
 * The session that converts a volatile token back to savings in `pool`: `convert-any` where the policy has one (v1 to
 * v3), else the pool's `manage-any`. Spec 007 v4 merges convert-any into manage-any, one session per pool that holds
 * the harvest/convert swap; asking v4 for convert-any threw "no convert-any grant" on every harvest, re-range convert
 * and idle convert (otto/mamoru#189).
 */
export function convertKey(policy: PolicyVersion, pool: string): ConvertKey {
  const own = policy.session.grants.some((g) => g.name === 'convert-any' && (g.pool === pool || !g.pool))
  return (own ? grantKeyFor(policy, 'convert-any', pool) : grantKeyFor(policy, 'manage-any', pool)) as ConvertKey
}
export type ConvertKey = 'convert-any' | `convert-any:${string}` | 'manage-any' | `manage-any:${string}`
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
  // A position with no liquidity has no range to keep: its tokens are only owed, not at risk of the price.
  if (!hasManageAny(policy) || policy.range.adjust !== 'on_out_of_range' || p.liquidity === 0n) return { code: null, proposal: null }
  // Built only when proposed: a pool without its own manage-any grant must not throw before the trigger says so.
  const proposal = (): RerangeProposal => ({ kind: 'rerange', grant: anyKey(policy, 'manage-any', pool.name), pool: pool.name, tokenId: p.tokenId, liquidity: p.liquidity })
  const lazy = policy.range.lazy
  if (lazy) {
    // Lab (#101 experiment 4): past the edge by the buffer, out long enough, and worth its cost; no near-edge trigger.
    const past = pool.tick < p.tickLower - lazy.edgeBufferTicks || pool.tick >= p.tickUpper + lazy.edgeBufferTicks
    if (!past) return { code: null, proposal: null }
    const lastAt = obs.lastRerangeAt ?? null
    if (lastAt !== null && obs.block.timestamp - lastAt < BigInt(policy.range.cooldownSeconds)) return { code: 'DECIDE_RANGE_COOLDOWN', proposal: null }
    const since = p.outOfRangeSince ?? null
    if (lazy.minDwellSeconds > 0 && (since === null || obs.block.timestamp - since < BigInt(lazy.minDwellSeconds))) return { code: 'DECIDE_RANGE_COOLDOWN', proposal: null }
    const w = rerangeWorth(obs, policy, p, pool, lazy)
    // Live (#172): no estimate is no re-range. The Lab keeps its measured rule (abstain) unless a variant sets the flag.
    if (!w && lazy.requireCostEstimate) return { code: 'DECIDE_RANGE_NO_FEE_HISTORY', proposal: null }
    if (w && !w.worth) return { code: 'DECIDE_RANGE_BELOW_COST', proposal: null }
    return { code: 'DECIDE_RANGE_ADJUST', proposal: proposal() }
  }
  const width = p.tickUpper - p.tickLower
  const outside = pool.tick < p.tickLower || pool.tick >= p.tickUpper
  // Lab geometry (#101): a skewed placement sits near one edge on purpose, so that edge's threshold is smaller.
  const edgeBps = policy.geometry ? edgeBpsOf(policy, pool, EDGE_BPS) : { lower: EDGE_BPS, upper: EDGE_BPS }
  const near = !outside && ((pool.tick - p.tickLower) * 10_000 < width * edgeBps.lower || (p.tickUpper - pool.tick) * 10_000 < width * edgeBps.upper)
  // Lab geometry: volatility spiking widens a narrow range before the price leaves it.
  const widen = !outside && !near && policy.geometry !== undefined && widenEarly(obs, policy, pool, width)
  if (!outside && !near && !widen) return { code: null, proposal: null }
  const last = obs.lastRerangeAt ?? null
  if (last !== null && obs.block.timestamp - last < BigInt(policy.range.cooldownSeconds)) return { code: 'DECIDE_RANGE_COOLDOWN', proposal: null }
  return { code: 'DECIDE_RANGE_ADJUST', proposal: proposal() }
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
  let total = free + (obs.remote?.value ?? 0n)
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
  const totalPreference = BigInt(preferenceTotal(policy))
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
export function reduceOf(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>, lab?: { skip?: ReadonlySet<string>; driftBps?: Partial<Record<string, number>> }): { code: ReasonCode | null; proposal: ReduceProposal | null } {
  if (!hasManageAny(policy)) return { code: null, proposal: null }
  const { total, buckets } = bucketValues(obs, policy, policyPools)
  if (total === 0n) return { code: null, proposal: null }
  for (const b of buckets) {
    // Lab (#101 round 3): a depegged pool is left alone; a bucket under a staged exit is reduced at its own band.
    if (b.pool && lab?.skip?.has(b.pool)) continue
    const drift = BigInt(lab?.driftBps?.[b.bucket] ?? DRIFT_BPS)
    if (!b.pool || b.value * 10_000n <= b.target * 10_000n + total * drift) continue
    const pool = obs.pools.find((x) => x.name === b.pool)
    const p = obs.positions.find((x) => x.pool === b.pool && x.liquidity > 0n && isManaged(x, policy, policyPools))
    if (!pool || !p) continue
    const excess = b.value - b.target
    if (excess * 10_000n <= opCostInSavings(obs, policy.savingsAsset) * BigInt(policy.harvest.costFactorBps)) return { code: 'DECIDE_HARVEST_BELOW_COST', proposal: null }
    const pv = positionValue(p, pool, policy.savingsAsset)
    const liquidity = pv === 0n ? 0n : (p.liquidity * (excess < pv ? excess : pv)) / pv
    if (liquidity === 0n) continue
    return { code: 'STRATEGY_PREFERENCE_DEVIATION', proposal: { kind: 'reduce', grant: anyKey(policy, 'manage-any', pool.name), pool: pool.name, tokenId: p.tokenId, liquidity } }
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
  const totalPreference = preferenceTotal(policy)
  const half = (capital * BigInt(preference)) / BigInt(totalPreference) / 2n
  if (value * 2n <= half * 3n || free >= half) return null
  const amountIn = (held * (value - half)) / value
  if (amountIn === 0n) return null
  return { kind: 'enter_swap', grant: convertKey(policy, pool.name), pool: pool.name, tokenIn: volatile, tokenOut: savings, fee: pool.fee, amountIn }
}

/**
 * After a reduce, the freed volatile side sits idle in the Safe. When its
 * bucket is not under-weight (positions within 5 points of the target), the
 * idle volatile goes back to the savings asset (grant convert-any), so the
 * freed value flows to the under-weight buckets through the normal entries.
 * Below the op cost times the harvest factor it stays. `keep` names the pools
 * whose idle volatile the allocation can mint now: there it waits for that
 * mint. Idle volatile the allocation cannot pair is still converted.
 */
export function idleConvertOf(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>, keep?: ReadonlySet<string>): EnterSwapProposal | null {
  if (!hasManageAny(policy)) return null
  const savings = policy.savingsAsset
  const { total, buckets } = bucketValues(obs, policy, policyPools)
  const floor = opCostInSavings(obs, savings) * BigInt(policy.harvest.costFactorBps)
  for (const b of buckets) {
    if (!b.pool || b.value * 10_000n + total * BigInt(DRIFT_BPS) < b.target * 10_000n) continue
    // Bought for a top-up and about to be minted: selling it back would undo the entry.
    if (keep?.has(b.pool)) continue
    if (!obs.positions.some((p) => p.pool === b.pool && p.liquidity > 0n && isManaged(p, policy, policyPools))) continue
    const pool = obs.pools.find((x) => x.name === b.pool)
    if (!pool) continue
    const volatile = volatileOf(pool, savings)
    const held = obs.balances[volatile] ?? 0n
    if (held === 0n || inSavings(pool, volatile, held, savings) * 10_000n <= floor) continue
    return { kind: 'enter_swap', grant: convertKey(policy, pool.name), pool: pool.name, tokenIn: volatile, tokenOut: savings, fee: pool.fee, amountIn: held }
  }
  return null
}
