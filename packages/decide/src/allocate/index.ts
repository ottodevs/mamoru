import type { ReasonCode } from '@mamoru/domain'
import { grantKeyFor, type PolicyVersion } from '@mamoru/policy'
import { rangeAround, sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { safeSavings } from '../enter/index.ts'
import { purgaIdentity } from '../gates/index.ts'
import type { GateStep, Observation, PoolObs, Proposal } from '../types.ts'
import { amountsForLiquidity, inSavings, volatileOf } from '../value.ts'

/** Default smallest entry when the policy sets none: 0.10 of a 6-decimal savings asset. */
export const DEFAULT_MIN_ENTRY = 100_000n
/** Swap only when the idle volatile covers less than this share (bps) of what the mint needs. */
const SWAP_BELOW_BPS = 9_000n

export type BucketValue = {
  bucket: string
  pool: string | null
  /** Positions in the pool plus the idle volatile token, in raw savings units at the TWAP. */
  value: bigint
  target: bigint
  /** Share of the whole account in bps (0 when the account is empty). */
  weightBps: number
  code: ReasonCode
}

export type Allocation = {
  total: bigint
  free: bigint
  buckets: BucketValue[]
  proposal: Proposal | null
  trail: GateStep[]
  /** Pools whose idle volatile token this allocation can mint now. It waits there for its turn; it is not idle capital. */
  pendingMint: string[]
}

/** The pool priced at its TWAP tick (slot0 when the TWAP is unavailable; the EHG then refuses to act on it). */
function atTwap(pool: PoolObs): PoolObs {
  return pool.twapTick === null ? pool : { ...pool, sqrtPriceX96: sqrtRatioAtTick(pool.twapTick) }
}

export function widthOf(policy: PolicyVersion, pool: string): number {
  return policy.range.widthTicksByPool?.[pool] ?? policy.range.widthTicks
}

/** Value share (bps) of the volatile side in a fresh range around the current tick, at the TWAP. */
function volatileShareBps(pool: PoolObs, policy: PolicyVersion): bigint {
  const r = rangeAround(pool.tick, widthOf(policy, pool.name), pool.tickSpacing)
  const p = atTwap(pool)
  const a = amountsForLiquidity(p.sqrtPriceX96, r.tickLower, r.tickUpper, 10n ** 24n)
  const savings = policy.savingsAsset
  const v0 = inSavings(p, p.token0, a.amount0, savings)
  const v1 = inSavings(p, p.token1, a.amount1, savings)
  const vol = p.token0 === savings ? v1 : v0
  return v0 + v1 === 0n ? 5_000n : (vol * 10_000n) / (v0 + v1)
}

/**
 * Target weights (policy `allocation: 'target-weights'`). Every bucket is valued in the savings asset at the TWAP:
 * its positions (amounts at the TWAP plus what `collect` returns) and the idle volatile token of its pool. The
 * account total adds the free savings, so idle capital counts toward the targets and is always re-invested.
 * Targets are the preferences of the buckets that have an executable pool, over that total. A bucket is short when
 * its positions, without the idle token, are under the target by at least `minEntry` and by more than the
 * `rebalanceBandBps` band. The gap is measured on the positions because a swap toward a mint moves value from the free
 * savings into the bucket's idle token: measured with it, the swap itself would close the gap and the mint would
 * never follow. The most under-weight short bucket (by deficit relative to its target, policy order on ties) gets the
 * next entry: a swap when its idle volatile is short of the mint, else a mint of a new range around the tick.
 */
export function allocate(obs: Observation, policy: PolicyVersion, unsafeDeposit: boolean): Allocation {
  const savings = policy.savingsAsset
  const minEntry = policy.minEntry ?? DEFAULT_MIN_ENTRY
  const free = safeSavings(obs, policy)
  const trail: GateStep[] = []
  const rows = policy.buckets.map((b) => {
    const pool = b.pools[0] ? obs.pools.find((x) => x.name === b.pools[0]) : undefined
    if (!pool) return { b, pool: undefined, value: 0n, deployed: 0n, idleVolatile: 0n, blocked: 'PLAN_BUCKET_NO_EXECUTABLE_POOL' as ReasonCode }
    const p = atTwap(pool)
    const volatile = volatileOf(pool, savings)
    let value = 0n
    for (const pos of obs.positions) {
      if (pos.pool !== pool.name) continue
      const a = amountsForLiquidity(p.sqrtPriceX96, pos.tickLower, pos.tickUpper, pos.liquidity)
      value += inSavings(p, p.token0, a.amount0 + pos.collectable0, savings) + inSavings(p, p.token1, a.amount1 + pos.collectable1, savings)
    }
    const idleVolatile = obs.balances[volatile] ?? 0n
    const deployed = value
    value += inSavings(p, volatile, idleVolatile, savings)
    const purga = purgaIdentity(pool)
    if (purga.verdict !== 'GO') trail.push(purga)
    return { b, pool, value, deployed, idleVolatile, blocked: purga.verdict !== 'GO' ? purga.reason : null }
  })
  const executable = rows.filter((r) => r.pool)
  const total = free + executable.reduce((s, r) => s + r.value, 0n)
  const prefTotal = BigInt(executable.reduce((s, r) => s + r.b.preference, 0))

  const buckets: BucketValue[] = rows.map((r) => {
    const target = r.pool && prefTotal > 0n ? (total * BigInt(r.b.preference)) / prefTotal : 0n
    return { bucket: r.b.id, pool: r.pool?.name ?? null, value: r.value, target, weightBps: total > 0n ? Number((r.value * 10_000n) / total) : 0, code: r.blocked ?? 'STRATEGY_PREFERENCE' }
  })

  // Short buckets, most under-weight first (relative deficit), policy order on ties.
  const order = rows
    .map((r, i) => ({ r, i, deficit: buckets[i]!.target - r.value, gap: buckets[i]!.target - r.deployed, target: buckets[i]!.target }))
    .filter((x) => x.r.pool && !x.r.blocked && x.gap >= minEntry && x.gap * 10_000n > x.target * BigInt(policy.rebalanceBandBps ?? 0))
    .sort((x, y) => {
      const dx = (x.deficit * 1_000_000n) / x.target
      const dy = (y.deficit * 1_000_000n) / y.target
      return dx === dy ? x.i - y.i : dy > dx ? 1 : -1
    })

  let proposal: Proposal | null = null
  const pendingMint: string[] = []
  for (const { r, i, deficit } of order) {
    // After the first proposal the loop only finds which other buckets hold a mint that can go; their codes stay.
    const row = proposal ? null : buckets[i]!
    if (unsafeDeposit) {
      if (row) row.code = 'OBS_DEPOSIT_UNSAFE'
      continue
    }
    const pool = r.pool!
    const volatile = volatileOf(pool, savings)
    const volatileValue = inSavings(atTwap(pool), volatile, r.idleVolatile, savings)
    // What the next mint of this bucket holds: the idle volatile plus the savings still missing from the target.
    const short = deficit > 0n ? deficit : 0n
    const size = short < free ? short + volatileValue : free + volatileValue
    const wantVolatile = (size * volatileShareBps(pool, policy)) / 10_000n
    if (volatileValue * 10_000n < wantVolatile * SWAP_BELOW_BPS) {
      const need = wantVolatile - volatileValue
      const amountIn = need < free ? need : free
      if (amountIn < minEntry) {
        if (row) row.code = 'DECIDE_NO_CAPITAL'
        continue
      }
      if (row) {
        row.code = 'STRATEGY_PREFERENCE_DEVIATION'
        proposal = { kind: 'enter_swap', grant: grantKeyFor(policy, 'enter-swap', pool.name) as `enter-swap:${string}`, pool: pool.name, tokenIn: savings, tokenOut: volatile, fee: pool.fee, amountIn }
      }
      continue
    }
    const wantSavings = size - wantVolatile
    const savingsIn = wantSavings < free ? wantSavings : free
    if (savingsIn <= 0n || r.idleVolatile === 0n) {
      if (row) row.code = 'DECIDE_NO_CAPITAL'
      continue
    }
    pendingMint.push(pool.name)
    if (!row) continue
    row.code = 'STRATEGY_PREFERENCE_DEVIATION'
    const range = rangeAround(pool.tick, widthOf(policy, pool.name), pool.tickSpacing)
    const savingsIs0 = pool.token0 === savings
    proposal = {
      kind: 'enter_mint',
      grant: grantKeyFor(policy, 'enter-mint', pool.name) as `enter-mint:${string}`,
      pool: pool.name,
      ...range,
      amount0Desired: savingsIs0 ? savingsIn : r.idleVolatile,
      amount1Desired: savingsIs0 ? r.idleVolatile : savingsIn,
    }
  }
  if (total === 0n) for (const row of buckets) if (row.code === 'STRATEGY_PREFERENCE') row.code = 'DECIDE_NO_CAPITAL'
  return { total, free, buckets, proposal, trail, pendingMint }
}
