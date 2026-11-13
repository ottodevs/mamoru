import type { ChainId, ReasonCode } from '@mamoru/domain'
import { grantKeyFor, hasIncrease, hasManageAny, preferenceTotal, type PolicyVersion } from '@mamoru/policy'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { safeSavings } from '../enter/index.ts'
import { bucketValues, convertKey, DRIFT_BPS, inEdgeBand, rerangeOf } from '../rerange/index.ts'
import { reinvestFits } from '../harvest/index.ts'
import { depthOf } from '../depth/index.ts'
import { rangeFor, widthFor, widthOf } from '../geometry/index.ts'
import { purgaIdentity, registryOf } from '../gates/index.ts'
import type { GateStep, Observation, PoolObs, PositionObs, Proposal } from '../types.ts'
import { amountsForLiquidity, bucketVaults, inSavings, opCostInSavings, vaultValue, volatileOf } from '../value.ts'
import { localTarget, remoteSpill } from '../remote-spill.ts'

/**
 * otto/mamoru#107 (spec 012 HRV-R4): idle USDC on a sleeve for more than this above the threshold goes home.
 * otto/mamoru#401 (owner, 13 Nov 2026): 60 min, not 6 h: capital that cannot work there comes back within the hour.
 */
export const RETURN_DWELL_SECONDS = 3_600n
/** otto/mamoru#401 (owner): the idle threshold is more than this share (bps) of the account's value, or the entry floor if larger. */
export const RETURN_IDLE_BPS = 100n
/** otto/mamoru#107 (spec 012 HRV-R4): after a return home, nothing is bridged back to that chain for this long. */
export const RETURN_HOLD_SECONDS = 24n * 3_600n

/**
 * otto/mamoru#107: the sleeve's idle USDC due home. otto/mamoru#401 (owner): more than max(1 % of the account's value,
 * the entry floor), for more than the dwell period (the operator's clock, `idleSince`). Its gas reserve is MON, never
 * counted; a bridge in flight either way or the sleeve not ready holds the return (see the caller). 0 when not due.
 */
function idleDue(obs: Observation, entryMin: bigint, total: bigint): bigint {
  const idle = obs.remote?.idle ?? 0n
  const since = obs.remote?.idleSince
  const byValue = (total * RETURN_IDLE_BPS) / 10_000n
  // The clock's own threshold when it says which: the dwell was measured above exactly that.
  const threshold = obs.remote?.idleThreshold ?? (byValue > entryMin ? byValue : entryMin)
  return idle > threshold && since !== undefined && obs.block.timestamp - BigInt(since) > RETURN_DWELL_SECONDS ? idle : 0n
}

/** Default smallest entry when the policy sets none: 0.10 of a 6-decimal savings asset. */
export const DEFAULT_MIN_ENTRY = 100_000n
/** otto/mamoru#195: the userOps an entry costs, a swap and a mint, for the gas floor of `minEntryGasMultiple`. */
const ENTRY_OPS = 2n
/** Swap only when the idle volatile covers less than this share (bps) of what the mint needs. */
const SWAP_BELOW_BPS = 9_000n
/** Sell idle volatile only when it exceeds what the mint needs by more than this share (bps) and savings are short to pair it. */
const SELL_ABOVE_BPS = 11_000n
/**
 * otto/mamoru#171: default for `range.increaseToleranceBps`. Since otto/mamoru#220 (one NFT per pool) it no longer
 * decides whether an entry adds to a held position (`reusablePosition` takes any in-range admitted one); kept, with the
 * policy field, so policy hashes and stored policies do not change.
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
export type Waiting = { bucket: string; code: 'DECIDE_WAIT_DEPTH' | 'DECIDE_WAIT_GAS' | 'DECIDE_ENTRY_PAUSED_FALL' | 'DECIDE_WAIT_BRIDGE' | 'DECIDE_WAIT_VAULT_LIQUIDITY' | 'DECIDE_WAIT_BRIDGE_LIMIT' | 'DECIDE_WAIT_BUDGET' | 'DECIDE_WAIT_RENEWAL' | 'REMOTE_DEPTH_BELOW_BUDGET'; amount: bigint }

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
  /** otto/mamoru#215: the local proposal a bridge-out took the review from, for when the bridge cannot go. */
  displaced?: Proposal
  /** otto/mamoru#278: the remote bucket's excess over its target and band, due home (the operator asks for it). */
  returnDue?: { bucket: string; chainId: ChainId; amount: bigint }
  /**
   * otto/mamoru#408: the cap's room took this review's entry: without the cap the account would place savings now, with
   * it nothing goes. Decide names the hold DECIDE_NO_CAPITAL (the operator logs the cap, elsewhere and room with it),
   * never DECIDE_IN_RANGE.
   */
  capHold?: true
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
 * live session of that grant, and only for a position the policy admitted for the account (`admitted`, read by the
 * engine at the observation block: a position minted under v2/v3 or V1 and never admitted by V2 is refused by the
 * policy, so that pool mints). Not `managed`: that flag lists the ids this engine run minted or was granted one by
 * one, so after a restart every older position read unmanaged and each top-up minted a second NFT beside it
 * (otto/mamoru#220: b54dda3a, 2 Nov 2026). Under manage-any every position of a policy pool is managed (isManaged). The position must have liquidity and the price strictly
 * inside its range (both amounts positive, as the grant's minimums need). One NFT per pool by design (otto/mamoru#220,
 * Ot 2 Nov 2026): such a position takes the entry however far its edges are from `range` (what a mint would get now),
 * unless the price sits in its re-range edge band (`inEdgeBand`) and the re-range acts on it this review, which would
 * take the new money straight back out; then the entry mints the fresh position and the re-range closes the old one
 * into it. `range.increaseToleranceBps`
 * no longer excludes one (a held position 340 ticks off took a second NFT on c23e94e1, 2 Nov): the nearest wins, lowest
 * tokenId on ties. The engine re-reads admission and ownership before it builds the call.
 */
export function reusablePosition(obs: Observation, policy: PolicyVersion, pool: PoolObs, range: { tickLower: number; tickUpper: number }): PositionObs | null {
  if (!hasIncrease(policy, pool.name)) return null
  if (!liveSession(obs, grantKeyFor(policy, 'manage-any', pool.name))) return null
  let best: PositionObs | null = null
  let bestDistance = 0
  for (const p of obs.positions) {
    if (p.pool !== pool.name || p.liquidity <= 0n || p.admitted !== true) continue
    if (!(p.tickLower < pool.tick && pool.tick < p.tickUpper)) continue
    // In its edge band it is skipped only when the re-range acts on it now: held there (cooldown, weekly cap, below
    // cost) it takes the entry, so a mint beside it never becomes a merge that bypasses those holds.
    if (inEdgeBand(policy, pool, p) && rerangeOf(obs, policy, p, pool).proposal !== null) continue
    const distance = Math.abs(p.tickLower - range.tickLower) + Math.abs(p.tickUpper - range.tickUpper)
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
export function allocate(obs: Observation, policy: PolicyVersion, unsafeDeposit: boolean, frozen?: ReadonlySet<string>, room?: bigint | null): Allocation {
  // `frozen`: bucket ids that get no entry this review (spec 004).
  // `room` (otto/mamoru#353): the new savings the account's cap lets entries place (capRoomOf); absent or null, no cap.
  const savings = policy.savingsAsset
  /** 0 when savings is token0 of the proposal's pool, else 1. */
  const savingsSide = (p: { pool: string }) => (obs.pools.find((x) => x.name === p.pool)?.token0 === savings ? 0 : 1)
  const minEntry = policy.minEntry ?? DEFAULT_MIN_ENTRY
  // otto/mamoru#195: whether a bucket takes an entry at all, and how small that entry may be, also needs k times what
  // its swap and mint cost in gas now. Only that decision: the swap, the sale of idle volatile and the mint inside an
  // entry keep `minEntry`, so a gas price never strands a conversion an entry or a re-range needs.
  const byGas = policy.minEntryGasMultiple ? BigInt(policy.minEntryGasMultiple) * ENTRY_OPS * opCostInSavings(obs, savings) : 0n
  const entryMin = byGas > minEntry ? byGas : minEntry
  // otto/mamoru#210: a vault deposit also has to earn its own two operations back (#186 condition 4).
  const vaultMin = policy.vaultMinDeposit !== undefined && policy.vaultMinDeposit > entryMin ? policy.vaultMinDeposit : entryMin
  const free = safeSavings(obs, policy)
  const trail: GateStep[] = []
  const rowsAll = policy.buckets.map((b) => {
    // otto/mamoru#210: a vault bucket is worth its shares at the vault's own rate; it has no pool, no volatile and no fall.
    if (b.vaults?.length) {
      const value = vaultValue(obs, b)
      return { b, pool: undefined, vault: true, value, deployed: value, idleVolatile: 0n, blocked: null as ReasonCode | null }
    }
    const pool = b.pools[0] ? obs.pools.find((x) => x.name === b.pools[0]) : undefined
    if (!pool) return { b, pool: undefined, vault: false, value: 0n, deployed: 0n, idleVolatile: 0n, blocked: 'PLAN_BUCKET_NO_EXECUTABLE_POOL' as ReasonCode }
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
    // otto/mamoru#401: a pool whose action policy would refuse any entry at validation (its deferred depth check) gets none.
    const blocked = purga.verdict !== 'GO' ? purga.reason : frozen?.has(b.id) ? ('DECIDE_ENTRY_PAUSED_FALL' as ReasonCode) : obs.depthShort?.some((d) => d.pool === pool.name) ? ('REMOTE_DEPTH_BELOW_BUDGET' as ReasonCode) : null
    return { b, pool, vault: false, value, deployed, idleVolatile, blocked }
  })
  const executable = rowsAll.filter((r) => r.pool || r.vault)
  /**
   * The allocation of `free` savings. otto/mamoru#353: run once with every savings held, and once more with the cap's room
   * when the cap binds (`sales` false: a sale only the smaller amount would ask for is never made). See the end of allocate.
   */
  const run = (free: bigint, sales: boolean) => {
    const rows = rowsAll.map((r) => ({ ...r }))
    const total = free + executable.reduce((s, r) => s + r.value, 0n) + (obs.remote?.value ?? 0n)
    // otto/mamoru#213: a bucket on another chain keeps its share of the account; here it waits as savings until bridged.
    const remote = (policy.remoteBuckets ?? []).reduce((s, b) => s + b.preference, 0)
    // otto/mamoru#293 (review of #202 r2): under MamoruActionPolicyV4 (contractVersion 4) the denominator is every bucket's
    // preference (preferenceTotal), the one the reduce side uses, so a bucket whose registry pool is not listed keeps its
    // weight and its share waits as savings. Every other policy keeps today's denominator (the executable buckets and the
    // remote ones), byte for byte.
    const prefTotal = BigInt(policy.actionPolicy?.contractVersion === 4 ? preferenceTotal(policy) : executable.reduce((s, r) => s + r.b.preference, 0) + remote)

    // otto/mamoru#401: the remote share its sleeve cannot hold (its cap) stays here, spread over the local buckets.
    const spill = remoteSpill(obs, policy, total, prefTotal)
    const buckets: BucketValue[] = rows.map((r) => {
      const target = (r.pool || r.vault) && prefTotal > 0n ? localTarget(total, r.b.preference, prefTotal, remote, spill) : 0n
      return { bucket: r.b.id, pool: r.pool?.name ?? null, value: r.value, target, weightBps: total > 0n ? Number((r.value * 10_000n) / total) : 0, code: r.blocked ?? 'STRATEGY_PREFERENCE' }
    })
    // otto/mamoru#210 (review of #174, P1): an `exitOptIn` bucket the account has not opted out of yet (v7's USDC/USDT, held)
    // is still Stable money: it counts toward the vault bucket's share, so new money never puts a second Stable share in the
    // vaults beside it. Only for sizing the gap: the total and the rows shown above are unchanged.
    const held = obs.exitOptIn === true ? 0n : rows.filter((r) => r.b.preference === 0 && r.b.exitOptIn).reduce((s, r) => s + r.value, 0n)
    const creditTo = held > 0n ? rows.findIndex((r) => r.vault) : -1
    if (creditTo >= 0) rows[creditTo] = { ...rows[creditTo]!, value: rows[creditTo]!.value + held, deployed: rows[creditTo]!.deployed + held }
    // A frozen bucket is one more reason savings wait (otto/mamoru#127, #128), shown the same way as a pool short of depth.
    const waiting: Waiting[] = []
    rows.forEach((r, i) => {
      const gap = buckets[i]!.target - r.deployed
      if ((r.blocked === 'DECIDE_ENTRY_PAUSED_FALL' || r.blocked === 'REMOTE_DEPTH_BELOW_BUDGET') && gap >= minEntry && free > 0n) waiting.push({ bucket: r.b.id, code: r.blocked, amount: gap < free ? gap : free })
      // A bucket short by more than the floor but not by enough to pay for its gas waits, and says so (#195).
      const band = gap * 10_000n > buckets[i]!.target * BigInt(policy.rebalanceBandBps ?? 0)
      const floor = r.vault ? vaultMin : entryMin
      if ((r.pool || r.vault) && !r.blocked && gap >= minEntry && gap < floor && band && free > 0n) {
        waiting.push({ bucket: r.b.id, code: 'DECIDE_WAIT_GAS', amount: gap < free ? gap : free })
        buckets[i]!.code = 'DECIDE_WAIT_GAS'
      }
    })

    // Short buckets, most under-weight first (relative deficit), policy order on ties.
    const order = rows
      .map((r, i) => ({ r, i, deficit: buckets[i]!.target - r.value, gap: buckets[i]!.target - r.deployed, target: buckets[i]!.target }))
      .filter((x) => (x.r.pool || x.r.vault) && !x.r.blocked && x.gap >= (x.r.vault ? vaultMin : entryMin) && x.gap * 10_000n > x.target * BigInt(policy.rebalanceBandBps ?? 0))
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
      if (r.vault) {
        // otto/mamoru#210: the gap goes to the first vault, in the bucket's order, that takes at least the vault floor now,
        // preferring one with a live session (without any, the EHG says which session is missing), up to what that vault takes
        // (review of #174, P1: the rest goes to the next vault on a later review). Less than the floor waits as savings.
        const want = gap < free ? gap : free
        if (want < vaultMin) {
          if (want >= minEntry) waiting.push({ bucket: r.b.id, code: 'DECIDE_WAIT_GAS', amount: want })
          if (row) row.code = want >= minEntry ? 'DECIDE_WAIT_GAS' : 'DECIDE_NO_CAPITAL'
          continue
        }
        const open = bucketVaults(obs, r.b).filter((v) => v.maxDeposit >= vaultMin)
        const v = open.find((x) => liveSession(obs, grantKeyFor(policy, 'vault-supply', x.name))) ?? open[0]
        if (!v) {
          waiting.push({ bucket: r.b.id, code: 'DECIDE_WAIT_VAULT_LIQUIDITY', amount: want })
          if (row) row.code = 'DECIDE_WAIT_VAULT_LIQUIDITY'
          continue
        }
        let assets = want < v.maxDeposit ? want : v.maxDeposit
        // otto/mamoru#107 (spec 012 HRV-R7): on V4 a vault never takes more than the policy's vault ratio of C leaves.
        const ratioRoom = obs.budget?.vaultRoom
        if (ratioRoom !== undefined && ratioRoom < assets) {
          if (ratioRoom < vaultMin) {
            waiting.push({ bucket: r.b.id, code: 'DECIDE_WAIT_BUDGET', amount: want })
            if (row) row.code = 'DECIDE_WAIT_BUDGET'
            continue
          }
          assets = ratioRoom
        }
        if (!row) continue
        row.code = 'STRATEGY_PREFERENCE_DEVIATION'
        picked = i
        proposal = { kind: 'vault_deposit', grant: grantKeyFor(policy, 'vault-supply', v.name) as `vault-supply:${string}`, bucket: r.b.id, pool: v.name, vault: v.name, assets }
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
      // Sized on the range the money goes into: a held position's own width when it takes the entry (#220).
      const depth = depthOf(obs, policy, pool, reuse ? reuse.tickUpper - reuse.tickLower : widthFor(obs, policy, pool))
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
        // With the cap's room only: the idle volatile stays (and is kept for the mint), never sold for the cap.
        if (!sales) {
          pendingMint.push({ pool: pool.name, grant: convertKey(policy, pool.name) })
          if (row) row.code = 'DECIDE_NO_CAPITAL'
          continue
        }
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
    // otto/mamoru#215: a bucket on another chain is filled by moving savings to the account's own sleeve there. Its
    // value there (and what is still in flight) is `obs.remote`; with no sleeve ready, or a bridge not yet minted, its
    // share waits here and says so. A bridge goes before an entry that spends savings (it takes a finality to land),
    // never before the sale of idle volatile.
    // `obs.remote` describes one sleeve (no chain key): a policy with more than one remote bucket would compare each
    // against the others' value and readiness. Refused until it is keyed by chain.
    if ((policy.remoteBuckets?.length ?? 0) > 1) throw new Error(`${policy.policyId}: more than one remote bucket is not supported (obs.remote has no chain key)`)
    let displaced: Proposal | undefined
    /** The bucket of `displaced` (otto/mamoru#353: the capped run's local entry, when its bridge-out is not taken). */
    let displacedAt: number | null = null
    // A bridge needs a live bridge-out session; without one its share waits instead of taking the review.
    const bridgeSession = obs.sessions.find((s) => s.grant === 'bridge-out' && s.active && BigInt(s.validUntil) > obs.block.timestamp && (s.usesLeft ?? 1) > 0)
    const bridgeLive = bridgeSession !== undefined
    // otto/mamoru#376 (spec 011 CAP-R5): never ask more than the grant allows. A V3 grant caps each call and the sum over
    // its approval; when what is left cannot be read the share waits (fail closed).
    const bridgeLimit = bridgeSession?.bridgeLimit ?? { kind: 'unknown' as const }
    for (const rb of policy.remoteBuckets ?? []) {
      if (unsafeDeposit || free === 0n) break
      const target = prefTotal > 0n ? (total * BigInt(rb.preference)) / prefTotal : 0n
      // otto/mamoru#401: the sleeve's capacity is its own cap: the home bridges toward that, never past it (the rest of the
      // share is placed here, `remoteSpill`). A gap under the entry floor or inside the band leaves nothing waiting.
      const cap = obs.remote?.cap
      const goal = cap !== undefined && cap < target ? cap : target
      const gap = goal - (obs.remote?.value ?? 0n)
      if (gap < minEntry || gap * 10_000n <= goal * BigInt(policy.rebalanceBandBps ?? 0)) continue
      let amount = gap < free ? gap : free
      // otto/mamoru#107 (spec 012 HRV-R4): no ping-pong. For 24 h after money came home from that chain nothing goes back
      // (a return itself empties the sleeve's idle, so its idle is no sign the sleeve placed anything), and nothing goes
      // while its idle USDC is due home.
      const returned = obs.remote?.returnedAt
      if ((returned !== undefined && obs.block.timestamp - BigInt(returned) < RETURN_HOLD_SECONDS) || idleDue(obs, entryMin, total) > 0n) {
        waiting.push({ bucket: rb.id, code: 'DECIDE_WAIT_BRIDGE', amount })
        continue
      }
      if (!obs.remote?.ready || (obs.remote.inFlight ?? 0n) > 0n || !bridgeLive) {
        waiting.push({ bucket: rb.id, code: 'DECIDE_WAIT_BRIDGE', amount })
        continue
      }
      if (bridgeLimit.kind === 'unknown' || (bridgeLimit.kind === 'v3' && (bridgeLimit.amountLeft < entryMin || bridgeLimit.perCall < entryMin))) {
        waiting.push({ bucket: rb.id, code: 'DECIDE_WAIT_BRIDGE_LIMIT', amount })
        continue
      }
      if (bridgeLimit.kind === 'v3') {
        if (bridgeLimit.perCall < amount) amount = bridgeLimit.perCall
        if (bridgeLimit.amountLeft < amount) amount = bridgeLimit.amountLeft
      }
      if (amount < entryMin) {
        waiting.push({ bucket: rb.id, code: 'DECIDE_WAIT_GAS', amount })
        continue
      }
      if (proposal && pickedSale > 0n) continue
      if (picked !== null) buckets[picked]!.code = 'STRATEGY_PREFERENCE'
      displaced = proposal ?? undefined
      displacedAt = picked
      proposal = { kind: 'bridge_out', grant: 'bridge-out', bucket: rb.id, chainId: rb.chainId, pool: rb.pools[0]!, amount }
      picked = null
      break
    }
    // otto/mamoru#278 (spec 002 FR-XCH-014 a): the other way. A remote bucket above its target by more than the band, by
    // at least what an entry must be worth (the same ceiling both ways), is due home: the operator asks the remote Safe
    // for the excess. Never while anything is in flight either way, or with the sleeve not ready.
    let returnDue: { bucket: string; chainId: ChainId; amount: bigint } | undefined
    // Never both ways in one review: a bridge out decided above wins and nothing is asked back.
    if (proposal?.kind !== 'bridge_out') for (const rb of policy.remoteBuckets ?? []) {
      if (!obs.remote?.ready || (obs.remote.inFlight ?? 0n) > 0n || total === 0n) break
      const target = prefTotal > 0n ? (total * BigInt(rb.preference)) / prefTotal : 0n
      const excess = obs.remote.value - target
      const over = excess >= entryMin && excess * 10_000n > target * BigInt(policy.rebalanceBandBps ?? 0) ? excess : 0n
      // otto/mamoru#107 (spec 012 HRV-R4): also the sleeve's own idle USDC, once it has sat at or above the threshold for
      // the dwell period (its engine could not place it), even with the sleeve under its target: no veto between chains.
      const idle = idleDue(obs, entryMin, total)
      const amount = over > idle ? over : idle
      if (amount === 0n) continue
      returnDue = { bucket: rb.id, chainId: rb.chainId, amount }
    }
    // otto/mamoru#107 (spec 012 HRV-R3): free savings no bucket takes this review (each inside its fill band, or what it
    // waits for kept aside) go to the Stable bucket's vault, past the band, up to one unit under the line where the
    // drain side would redeem them (DRIFT_BPS, as `reduceOf` measures it), within the vault ratio of C on V4.
    if (!proposal && !unsafeDeposit && free > 0n) {
      const vi = rows.findIndex((r) => r.vault && !r.blocked)
      // What another bucket waits for stays; the vault bucket's own wait (under its floor) is what the sweep places.
      const kept = waiting.filter((w) => vi < 0 || w.bucket !== rows[vi]!.b.id).reduce((s, w) => s + w.amount, 0n)
      const spare = free > kept ? free - kept : 0n
      if (vi >= 0 && spare >= vaultMin) {
        const r = rows[vi]!
        const drain = bucketValues(obs, policy, new Set(policy.buckets.flatMap((b) => b.pools)))
        const bv = drain.buckets.find((b) => b.bucket === r.b.id)
        const bvTotal = drain.total
        // A held `exitOptIn` bucket counts as Stable on the drain side too (reduceOf's credit).
        const credit = r.value - vaultValue(obs, r.b)
        const ceiling = bv ? bv.target + (bvTotal * BigInt(DRIFT_BPS)) / 10_000n - 1n - credit : 0n
        let amount = bv && ceiling > bv.value ? ceiling - bv.value : 0n
        if (amount > spare) amount = spare
        const ratioRoom = obs.budget?.vaultRoom
        const byRatio = ratioRoom !== undefined && ratioRoom < amount
        if (byRatio) amount = ratioRoom
        const open = bucketVaults(obs, r.b).filter((v) => v.maxDeposit >= vaultMin)
        const v = open.find((x) => liveSession(obs, grantKeyFor(policy, 'vault-supply', x.name))) ?? open[0]
        if (v && amount > v.maxDeposit) amount = v.maxDeposit
        if (byRatio && amount < vaultMin) waiting.push({ bucket: r.b.id, code: 'DECIDE_WAIT_BUDGET', amount: spare })
        else if (v && amount >= vaultMin) {
          if (!reinvestFits(obs, policy, amount)) waiting.push({ bucket: r.b.id, code: 'DECIDE_WAIT_BUDGET', amount })
          else {
            buckets[vi]!.code = 'STRATEGY_PREFERENCE_DEVIATION'
            picked = vi
            proposal = { kind: 'vault_deposit', grant: grantKeyFor(policy, 'vault-supply', v.name) as `vault-supply:${string}`, bucket: r.b.id, pool: v.name, vault: v.name, assets: amount }
          }
        }
      }
    }
    if (total === 0n) for (const row of buckets) if (row.code === 'STRATEGY_PREFERENCE') row.code = 'DECIDE_NO_CAPITAL'
    return { total, buckets, proposal, picked, sale: pickedSale > 0n, pendingMint, waiting, displaced, displacedAt, returnDue }
  }
  // Each bucket's wait was measured against the same free savings: together they cannot hold more than what is free
  // once this review's entry has taken its savings. Clipped in the order they were found.
  const clip = (waiting: Waiting[], proposal: Proposal | null, have: bigint): Waiting[] => {
    const spent = !proposal ? 0n : proposal.kind === 'bridge_out' ? proposal.amount : proposal.kind === 'vault_deposit' ? proposal.assets : proposal.kind === 'enter_swap' && proposal.tokenIn === savings ? proposal.amountIn : proposal.kind === 'enter_mint' || proposal.kind === 'increase_liquidity' ? (savingsSide(proposal) === 0 ? proposal.amount0Desired : proposal.amount1Desired) : 0n
    let left = have > spent ? have - spent : 0n
    const clipped: Waiting[] = []
    for (const w of waiting) {
      const amount = w.amount < left ? w.amount : left
      if (amount >= minEntry) clipped.push({ ...w, amount })
      left -= amount
    }
    return clipped
  }
  const open = run(free, true)
  const spend = room === undefined || room === null || room >= free ? free : room > 0n ? room : 0n
  if (spend === free) {
    return { total: open.total, free, buckets: open.buckets, proposal: open.proposal, trail, pendingMint: open.pendingMint, waiting: clip(open.waiting, open.proposal, free), ...(open.displaced ? { displaced: open.displaced } : {}), ...(open.returnDue ? { returnDue: open.returnDue } : {}) }
  }
  // otto/mamoru#353: the cap binds. It limits only the new savings an entry (or a bridge-out) places, and those are sized
  // as if the account held only its room (`capped`). Everything else reads every savings held (`open`): the total and the
  // targets shown, the remote bucket's return (never due because of the cap), a sale of idle volatile (made exactly when
  // it would be without a cap, and outranking any entry as it always does), and the idle volatile kept for a mint.
  // Neither run writes `trail` (only the rows above do, once): the decision's trail has no step of either run twice.
  const capped = run(spend, false)
  const sale = open.sale ? open.proposal : null
  // By bucket id, not position (both runs map policy.buckets in order; matched anyway).
  const codeOf = new Map(capped.buckets.map((b) => [b.bucket, b.code]))
  const buckets = open.buckets.map((b) => ({ ...b, code: codeOf.get(b.bucket) ?? b.code }))
  const at = (i: number | null) => (i === null ? undefined : buckets.findIndex((b) => b.bucket === capped.buckets[i]!.bucket))
  /** What the capped run may decide: an entry that spends savings, or a bridge-out. Never a sale or any other step. */
  const entry = (p: Proposal | null | undefined): p is Proposal =>
    !!p && ((p.kind === 'enter_swap' && p.tokenIn === savings) || p.kind === 'enter_mint' || p.kind === 'increase_liquidity' || p.kind === 'vault_deposit' || p.kind === 'bridge_out')
  let proposal: Proposal | null = null
  let displaced: Proposal | undefined
  if (sale) {
    const c = at(capped.picked)
    if (c !== undefined && c >= 0) buckets[c]!.code = 'STRATEGY_PREFERENCE'
    const o = open.picked === null ? -1 : buckets.findIndex((b) => b.bucket === open.buckets[open.picked!]!.bucket)
    if (o >= 0) buckets[o]!.code = 'STRATEGY_PREFERENCE_DEVIATION'
    proposal = sale
  } else if (capped.proposal?.kind === 'bridge_out') {
    const b = capped.proposal
    // A bridge-out only where the account would bridge without a cap, to the same bucket: the cap never picks a
    // cross-chain move over the local entry the account would make. Otherwise the capped run's local entry, if any.
    if (open.proposal?.kind === 'bridge_out' && open.proposal.bucket === b.bucket) {
      proposal = b
      displaced = entry(capped.displaced) && capped.displaced.kind !== 'bridge_out' ? capped.displaced : undefined
    } else if (entry(capped.displaced) && capped.displaced.kind !== 'bridge_out') {
      proposal = capped.displaced
      const c = at(capped.displacedAt)
      if (c !== undefined && c >= 0) buckets[c]!.code = 'STRATEGY_PREFERENCE_DEVIATION'
    }
  } else if (entry(capped.proposal)) proposal = capped.proposal
  const pendingMint = [...open.pendingMint]
  for (const k of capped.pendingMint) if (!pendingMint.some((x) => x.pool === k.pool && x.grant === k.grant)) pendingMint.push(k)
  const capHold = !proposal && entry(open.proposal)
  return { total: open.total, free, buckets, proposal, trail, pendingMint, waiting: clip(capped.waiting, proposal, spend), ...(displaced ? { displaced } : {}), ...(open.returnDue ? { returnDue: open.returnDue } : {}), ...(capHold ? { capHold: true as const } : {}) }
}
