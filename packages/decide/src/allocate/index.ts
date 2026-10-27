import type { ReasonCode } from '@mamoru/domain'
import { grantKeyFor, hasIncrease, hasManageAny, type PolicyVersion } from '@mamoru/policy'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { safeSavings } from '../enter/index.ts'
import { convertKey } from '../rerange/index.ts'
import { depthOf } from '../depth/index.ts'
import { rangeFor, widthFor, widthOf } from '../geometry/index.ts'
import { purgaIdentity, registryOf } from '../gates/index.ts'
import type { GateStep, Observation, PoolObs, PositionObs, Proposal } from '../types.ts'
import { amountsForLiquidity, inSavings, opCostInSavings, volatileOf } from '../value.ts'

/** Default smallest entry when the policy sets none: 0.10 of a 6-decimal savings asset. */
export const DEFAULT_MIN_ENTRY = 100_000n
/** otto/mamoru#195: the userOps an entry costs, a swap and a mint, for the gas floor of `minEntryGasMultiple`. */
const ENTRY_OPS = 2n
/** Swap only when the idle volatile covers less than this share (bps) of what the mint needs. */
const SWAP_BELOW_BPS = 9_000n
/** Sell idle volatile only when it exceeds what the mint needs by more than this share (bps) and savings are short to pair it. */
const SELL_ABOVE_BPS = 11_000n
/**
 * otto/mamoru#171: default for `range.increaseToleranceBps`, how far (bps of the new range's width) each edge of a held
 * position may sit from the edge of the range a mint would get, for the entry to add to it instead. 1000 is the
 * re-range trigger's own edge share: a position that close has the price well inside it, so what is added is not
 * taken straight out again by a re-range, and its token split is within a few percent of the fresh range's.
 */
export const DEFAULT_INCREASE_TOLERANCE_BPS = 1_000

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

/** otto/mamoru#127, #128: savings a bucket is short of its target and holds back on purpose, and why. */
export type Waiting = { bucket: string; code: 'DECIDE_WAIT_DEPTH' | 'DECIDE_WAIT_GAS' | 'DECIDE_ENTRY_PAUSED_FALL'; amount: bigint }

export type Allocation = {
  total: bigint
  free: bigint
  buckets: BucketValue[]
  proposal: Proposal | null
  trail: GateStep[]
  /**
   * Pools whose idle volatile token this allocation has a use for, with the grant its next step needs: the mint that
   * can go, or the swap that makes it possible. The token is held back for it only while that grant has a live session.
   */
  pendingMint: { pool: string; grant: string }[]
  /** Not part of the decision's premise (it moves with every price): reported beside it. */
  waiting: Waiting[]
}

/** The pool priced at its TWAP tick (slot0 when the TWAP is unavailable; the EHG then refuses to act on it). */
function atTwap(pool: PoolObs): PoolObs {
  return pool.twapTick === null ? pool : { ...pool, sqrtPriceX96: sqrtRatioAtTick(pool.twapTick) }
}

export { widthOf }

/**
 * Value share (bps) of the volatile side in a fresh range around the current tick, at the pool price. The mint takes
 * its tokens at that price: split at the TWAP instead, a narrow range a few ticks off its average ends with one token
 * left over.
 */
function volatileShareBps(pool: PoolObs, policy: PolicyVersion, r: { tickLower: number; tickUpper: number }): bigint {
  const p = pool
  const a = amountsForLiquidity(p.sqrtPriceX96, r.tickLower, r.tickUpper, 10n ** 24n)
  const savings = policy.savingsAsset
  const v0 = inSavings(p, p.token0, a.amount0, savings)
  const v1 = inSavings(p, p.token1, a.amount1, savings)
  const vol = p.token0 === savings ? v1 : v0
  return v0 + v1 === 0n ? 5_000n : (vol * 10_000n) / (v0 + v1)
}

/** A live session named `grant`: enabled, not expired, uses left. */
function liveSession(obs: Observation, grant: string): boolean {
  return obs.sessions.some((s) => s.grant === grant && s.active && BigInt(s.validUntil) > obs.block.timestamp && (s.usesLeft ?? 1) > 0)
}

/**
 * otto/mamoru#171: the held position an entry into `pool` adds liquidity to instead of minting a new NFT, or null to
 * mint. Only under a policy whose manage-any in the pool carries MamoruActionPolicyV2.increase (`hasIncrease`), with a
 * live session of that grant, and only for a position this engine manages (`managed`) that the policy admitted for
 * the account (`admitted`, read by the engine at the observation block: a position minted under v2/v3 or V1 and never
 * admitted by V2 is refused by the policy, so that pool mints). The position must have liquidity, the price strictly
 * inside its range (both amounts positive, as the grant's minimums need), and each of its edges within
 * `range.increaseToleranceBps` of the width of `range` (what a mint would get now) from that range's edge. The nearest
 * such position wins, lowest tokenId on ties. The engine re-reads admission and ownership before it builds the call.
 */
export function reusablePosition(obs: Observation, policy: PolicyVersion, pool: PoolObs, range: { tickLower: number; tickUpper: number }): PositionObs | null {
  if (!hasIncrease(policy, pool.name)) return null
  if (!liveSession(obs, grantKeyFor(policy, 'manage-any', pool.name))) return null
  const tolerance = Math.floor(((range.tickUpper - range.tickLower) * (policy.range.increaseToleranceBps ?? DEFAULT_INCREASE_TOLERANCE_BPS)) / 10_000)
  let best: PositionObs | null = null
  let bestDistance = 0
  for (const p of obs.positions) {
    if (p.pool !== pool.name || p.liquidity <= 0n || !p.managed || p.admitted !== true) continue
    if (!(p.tickLower < pool.tick && pool.tick < p.tickUpper)) continue
    const lower = Math.abs(p.tickLower - range.tickLower)
    const upper = Math.abs(p.tickUpper - range.tickUpper)
    if (lower > tolerance || upper > tolerance) continue
    const distance = lower + upper
    if (!best || distance < bestDistance || (distance === bestDistance && p.tokenId < best.tokenId)) {
      best = p
      bestDistance = distance
    }
  }
  return best
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
 * next entry. Its next mint holds the gap, or all the bucket can gather (free savings plus idle volatile) when that
 * is less, split as a new range around the tick needs it. Idle volatile short of that split: buy it. Too much of it
 * and not the savings to pair it (the one-sided tokens a re-range frees): sell the excess back. Otherwise mint.
 */
export function allocate(obs: Observation, policy: PolicyVersion, unsafeDeposit: boolean, frozen?: ReadonlySet<string>): Allocation {
  // `frozen`: bucket ids that get no entry this review (spec 004).
  const savings = policy.savingsAsset
  /** 0 when savings is token0 of the proposal's pool, else 1. */
  const savingsSide = (p: { pool: string }) => (obs.pools.find((x) => x.name === p.pool)?.token0 === savings ? 0 : 1)
  const minEntry = policy.minEntry ?? DEFAULT_MIN_ENTRY
  // otto/mamoru#195: whether a bucket takes an entry at all, and how small that entry may be, also needs k times what
  // its swap and mint cost in gas now. Only that decision: the swap, the sale of idle volatile and the mint inside an
  // entry keep `minEntry`, so a gas price never strands a conversion an entry or a re-range needs.
  const byGas = policy.minEntryGasMultiple ? BigInt(policy.minEntryGasMultiple) * ENTRY_OPS * opCostInSavings(obs, savings) : 0n
  const entryMin = byGas > minEntry ? byGas : minEntry
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
    const purga = purgaIdentity(pool, registryOf(obs))
    if (purga.verdict !== 'GO') trail.push(purga)
    // Spec 004 FREEZE (#101): a bucket whose pool is in a fast fall gets no entry; its share waits where it is.
    const blocked = purga.verdict !== 'GO' ? purga.reason : frozen?.has(b.id) ? ('DECIDE_ENTRY_PAUSED_FALL' as ReasonCode) : null
    return { b, pool, value, deployed, idleVolatile, blocked }
  })
  const executable = rows.filter((r) => r.pool)
  const total = free + executable.reduce((s, r) => s + r.value, 0n)
  // otto/mamoru#213: a bucket on another chain keeps its share of the account; here it waits as savings until bridged.
  const remote = (policy.remoteBuckets ?? []).reduce((s, b) => s + b.preference, 0)
  const prefTotal = BigInt(executable.reduce((s, r) => s + r.b.preference, 0) + remote)

  const buckets: BucketValue[] = rows.map((r) => {
    const target = r.pool && prefTotal > 0n ? (total * BigInt(r.b.preference)) / prefTotal : 0n
    return { bucket: r.b.id, pool: r.pool?.name ?? null, value: r.value, target, weightBps: total > 0n ? Number((r.value * 10_000n) / total) : 0, code: r.blocked ?? 'STRATEGY_PREFERENCE' }
  })
  // A frozen bucket is one more reason savings wait (otto/mamoru#127, #128), shown the same way as a pool short of depth.
  const waiting: Waiting[] = []
  rows.forEach((r, i) => {
    const gap = buckets[i]!.target - r.deployed
    if (r.blocked === 'DECIDE_ENTRY_PAUSED_FALL' && gap >= minEntry && free > 0n) waiting.push({ bucket: r.b.id, code: 'DECIDE_ENTRY_PAUSED_FALL', amount: gap < free ? gap : free })
    // A bucket short by more than the floor but not by enough to pay for its gas waits, and says so (#195).
    const band = gap * 10_000n > buckets[i]!.target * BigInt(policy.rebalanceBandBps ?? 0)
    if (r.pool && !r.blocked && gap >= minEntry && gap < entryMin && band && free > 0n) {
      waiting.push({ bucket: r.b.id, code: 'DECIDE_WAIT_GAS', amount: gap < free ? gap : free })
      buckets[i]!.code = 'DECIDE_WAIT_GAS'
    }
  })

  // Short buckets, most under-weight first (relative deficit), policy order on ties.
  const order = rows
    .map((r, i) => ({ r, i, deficit: buckets[i]!.target - r.value, gap: buckets[i]!.target - r.deployed, target: buckets[i]!.target }))
    .filter((x) => x.r.pool && !x.r.blocked && x.gap >= entryMin && x.gap * 10_000n > x.target * BigInt(policy.rebalanceBandBps ?? 0))
    .sort((x, y) => {
      const dx = (x.deficit * 1_000_000n) / x.target
      const dy = (y.deficit * 1_000_000n) / y.target
      return dx === dy ? x.i - y.i : dy > dx ? 1 : -1
    })

  let proposal: Proposal | null = null
  // otto/mamoru#141: the review has one op. The first short bucket in order takes it, except that selling a bucket's
  // excess idle volatile outranks any op that is not a larger such sale: idle volatile waiting behind small entries is
  // unmanaged exposure (Lab, Feb 2025 100k: 34k of cbBTC waited 16 reviews behind cent-sized mints).
  let picked: number | null = null
  let pickedSale = 0n
  const pendingMint: Allocation['pendingMint'] = []
  for (const { r, i, gap } of order) {
    // After the first proposal the loop only finds which other buckets have a use for their idle volatile; their codes stay.
    const row = proposal ? null : buckets[i]!
    if (unsafeDeposit) {
      if (row) row.code = 'OBS_DEPOSIT_UNSAFE'
      continue
    }
    const pool = r.pool!
    const volatile = volatileOf(pool, savings)
    const volatileValue = inSavings(atTwap(pool), volatile, r.idleVolatile, savings)
    // What the next mint of this bucket holds: the gap, or everything the bucket can gather when that is less.
    const wanted = gap < free + volatileValue ? gap : free + volatileValue
    let size = wanted
    // Lab geometry (#101): the range a mint gets now; without `policy.geometry`, the centred policy width. #171: a held
    // position close enough to it takes the entry instead, and the split follows that position's range.
    const fresh = rangeFor(obs, policy, pool)
    const reuse = reusablePosition(obs, policy, pool, fresh)
    const range = reuse ? { tickLower: reuse.tickLower, tickUpper: reuse.tickUpper } : fresh
    const volShare = volatileShareBps(pool, policy, range)
    // otto/mamoru#127: no more than the pool can take at its depth; the rest waits as savings, with its reason. The
    // swap toward the mint sells at most the volatile share of that size, so it stays within the allowed impact too.
    const depth = depthOf(obs, policy, pool, widthFor(obs, policy, pool))
    if (depth) {
      const bySwap = volShare > 0n ? (depth.swapRoom * 10_000n) / volShare : size
      const room = depth.shareRoom < bySwap ? depth.shareRoom : bySwap
      if (room < size) {
        size = room < entryMin ? 0n : room
        // What does not fit waits as savings, whether this review places part of the bucket or none of it.
        // The bucket stays short by what this entry does not cover; what of it is savings is what waits.
        const short = gap - size
        const held = short < free ? short : free
        if (held >= minEntry) waiting.push({ bucket: r.b.id, code: 'DECIDE_WAIT_DEPTH', amount: held })
        if (size === 0n) {
          if (row) row.code = 'DECIDE_WAIT_DEPTH'
          continue
        }
      }
    }
    const wantVolatile = (size * volShare) / 10_000n
    const wantSavings = size - wantVolatile
    if (volatileValue * 10_000n < wantVolatile * SWAP_BELOW_BPS) {
      const need = wantVolatile - volatileValue
      const amountIn = need < free ? need : free
      if (amountIn < minEntry) {
        if (row) row.code = 'DECIDE_NO_CAPITAL'
        continue
      }
      // What it already holds of the volatile token is part of that mint: it is not idle capital to sell meanwhile.
      const buyGrant = grantKeyFor(policy, 'enter-swap', pool.name) as `enter-swap:${string}`
      if (r.idleVolatile > 0n) pendingMint.push({ pool: pool.name, grant: buyGrant })
      if (row) {
        row.code = 'STRATEGY_PREFERENCE_DEVIATION'
        proposal = { kind: 'enter_swap', grant: buyGrant, pool: pool.name, tokenIn: savings, tokenOut: volatile, fee: pool.fee, amountIn }
        picked = i
      }
      continue
    }
    // Depth shrinks the mint, never the volatile the bucket keeps for it: the sale is judged against the unsized entry,
    // and one sale stays within the impact the pool allows.
    const keepVolatile = (wanted * volShare) / 10_000n
    const keepSavings = wanted - keepVolatile
    if (free < keepSavings && volatileValue * 10_000n > keepVolatile * SELL_ABOVE_BPS) {
      const excessValue = volatileValue - keepVolatile
      let sell = (r.idleVolatile * excessValue) / volatileValue
      let excess = excessValue
      if (depth && sell > depth.sellRoom) {
        sell = depth.sellRoom
        excess = (sell * volatileValue) / r.idleVolatile
      }
      if (excess < minEntry || !hasManageAny(policy)) {
        if (row) row.code = 'DECIDE_NO_CAPITAL'
        continue
      }
      // The rest of the idle token is the volatile side of the mint that follows.
      const sellGrant = convertKey(policy, pool.name)
      pendingMint.push({ pool: pool.name, grant: sellGrant })
      if (row || excess > pickedSale) {
        // The bucket it displaces keeps waiting for a later review, as any bucket after the one that acts.
        if (picked !== null) buckets[picked]!.code = 'STRATEGY_PREFERENCE'
        buckets[i]!.code = 'STRATEGY_PREFERENCE_DEVIATION'
        proposal = { kind: 'enter_swap', grant: sellGrant, pool: pool.name, tokenIn: volatile, tokenOut: savings, fee: pool.fee, amountIn: sell }
        picked = i
        pickedSale = excess
      }
      continue
    }
    const savingsIn = wantSavings < free ? wantSavings : free
    // No more of the idle token than the mint needs: the session cap counts what is asked for, not what the pool takes.
    // What is over stays idle and is converted once the bucket is full.
    // With savings short of the split, the volatile side shrinks with them.
    const pairValue = wantSavings > 0n ? (wantVolatile * savingsIn) / wantSavings : wantVolatile
    const volatileIn = volatileValue > pairValue ? (r.idleVolatile * pairValue) / volatileValue : r.idleVolatile
    const volatileInValue = volatileValue < pairValue ? volatileValue : pairValue
    // A mint smaller than the minimum entry is dust left by an earlier mint: its minimums round to zero and it cannot be built.
    if (savingsIn <= 0n || volatileIn === 0n || savingsIn + volatileInValue < minEntry) {
      if (row) row.code = 'DECIDE_NO_CAPITAL'
      continue
    }
    const mintGrant = reuse ? (grantKeyFor(policy, 'manage-any', pool.name) as `manage-any:${string}`) : (grantKeyFor(policy, 'enter-mint', pool.name) as `enter-mint:${string}`)
    pendingMint.push({ pool: pool.name, grant: mintGrant })
    if (!row) continue
    row.code = 'STRATEGY_PREFERENCE_DEVIATION'
    picked = i
    const savingsIs0 = pool.token0 === savings
    const amounts = { amount0Desired: savingsIs0 ? savingsIn : volatileIn, amount1Desired: savingsIs0 ? volatileIn : savingsIn }
    proposal = reuse
      ? { kind: 'increase_liquidity', grant: mintGrant as `manage-any:${string}`, pool: pool.name, tokenId: reuse.tokenId, ...range, ...amounts }
      : { kind: 'enter_mint', grant: mintGrant as `enter-mint:${string}`, pool: pool.name, ...range, ...amounts }
  }
  if (total === 0n) for (const row of buckets) if (row.code === 'STRATEGY_PREFERENCE') row.code = 'DECIDE_NO_CAPITAL'
  // Each bucket's wait was measured against the same free savings: together they cannot hold more than what is free
  // once this review's entry has taken its savings. Clipped in the order they were found.
  const spent = !proposal ? 0n : proposal.kind === 'enter_swap' && proposal.tokenIn === savings ? proposal.amountIn : proposal.kind === 'enter_mint' || proposal.kind === 'increase_liquidity' ? (savingsSide(proposal) === 0 ? proposal.amount0Desired : proposal.amount1Desired) : 0n
  let left = free > spent ? free - spent : 0n
  const clipped: Waiting[] = []
  for (const w of waiting) {
    const amount = w.amount < left ? w.amount : left
    if (amount >= minEntry) clipped.push({ ...w, amount })
    left -= amount
  }
  return { total, free, buckets, proposal, trail, pendingMint, waiting: clipped }
}
