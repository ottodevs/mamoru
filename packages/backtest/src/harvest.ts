// Lab (otto/mamoru#178): harvest arms. The live engine harvests at 3x its userOp budget and only collects (#140); the
// volatile fees then wait in the account until target-weights re-allocates them. The Lab compares that with two other
// rules, run by the simulator around the production `decide`, never inside it:
// - `savings` (A·k): a position's fees go to a USDC savings layer apart from the buckets, when they reach k times what
//   the harvest costs (collect + swap of the volatile part + its pool fee and price impact), or, with a time cap, when
//   the cap has passed and they cover the cost once. Savings never go back into a bucket and are not part of the
//   target weights.
// - `compound` (B): the fees go back into the same position (increaseLiquidity), when they reach k times the cost of a
//   collect and an increase. Reference, as Beefy does.
// Absent from the run config, nothing here runs and every result hash is the one of before.
import { ReasonError } from '@mamoru/domain'
import { allocate, type Observation } from '@mamoru/decide'
import type { PolicyVersion } from '@mamoru/policy'
import { baseRegistry, entry, type RegistryEntry, type RegistryName } from '@mamoru/registry'
import { quoteMint } from '@mamoru/uniswap-v3/quote'
import type { OpKind, PoolSample, Sample } from './types.ts'
import { swapOut, valueIn, type SimPosition, type World } from './world.ts'

const Q128 = 1n << 128n

/**
 * `live`: `decide` as it is; the run only measures. `savings`: A·k, `capSeconds` the time cap T. `compound`: B. `k` is a
 * multiple of the harvest's own cost, read to the hundredth.
 */
export type HarvestArm = { kind: 'live' } | { kind: 'savings'; k: number; capSeconds?: number } | { kind: 'compound'; k: number }

export function armName(a: HarvestArm): string {
  if (a.kind === 'live') return 'live'
  if (a.kind === 'compound') return `B-k${a.k}`
  return `A-k${a.k}${a.capSeconds ? `-T${a.capSeconds % 86_400 === 0 ? `${a.capSeconds / 86_400}d` : `${a.capSeconds}s`}` : ''}`
}

/** What one pool's fees went through over a run. Amounts are raw token units; values raw savings units. */
export type PoolLedger = {
  /** Fees taken out of positions (harvests, and the collect a re-range or reduce starts with), per token. */
  collected: Record<RegistryName, bigint>
  /** The same at the price of each collect. */
  collectedValue: bigint
  /** Fees accrued by the pool's positions, collected or not. */
  fees: bigint
  harvests: number
  swaps: number
  increases: number
  /** Volatile fees sold to the savings asset, per token; their value at the pool mid at the sale; what the sales paid. */
  converted: Record<RegistryName, bigint>
  convertedValue: bigint
  swapOut: bigint
  /** Savings-asset fees that went to the savings layer as they were. */
  direct: bigint
  /** Gas of the harvest's own operations (collect, swap, increase), and what the swaps lost to fee and impact. */
  gas: bigint
  swapLoss: bigint
  /** Savings arm: volatile fees a re-range or reduce collected, waiting for the pool's next harvest swap. */
  pending: Record<RegistryName, bigint>
}

export type HarvestLedger = {
  arm: HarvestArm
  /** Savings layer, raw savings units, its yield included. */
  savings: bigint
  savingsRemX128: bigint
  yieldEarned: bigint
  pools: Record<RegistryName, PoolLedger>
  /** Per position: time of its last harvest, or of the first review that saw it. */
  since: Map<bigint, number>
  /** Principal drift from the target weights, from the first review with a position in every bucket. */
  drift: { entered: boolean; samples: number; sumBps: number; maxBps: number }
}

export function newLedger(arm: HarvestArm): HarvestLedger {
  return { arm, savings: 0n, savingsRemX128: 0n, yieldEarned: 0n, pools: {}, since: new Map(), drift: { entered: false, samples: 0, sumBps: 0, maxBps: 0 } }
}

export function poolLedger(l: HarvestLedger, pool: RegistryName): PoolLedger {
  return (l.pools[pool] ??= { collected: {}, collectedValue: 0n, fees: 0n, harvests: 0, swaps: 0, increases: 0, converted: {}, convertedValue: 0n, swapOut: 0n, direct: 0n, gas: 0n, swapLoss: 0n, pending: {} })
}

function add(r: Record<RegistryName, bigint>, token: RegistryName, amount: bigint): void {
  if (amount > 0n) r[token] = (r[token] ?? 0n) + amount
}

/** The token of the pool that is not the savings asset (USDT in the stables pool). */
export function otherToken(e: RegistryEntry, savings: RegistryName): RegistryName {
  if (e.token0 === savings) return e.token1!
  if (e.token1 === savings) return e.token0!
  throw new Error(`${e.name} does not pair ${savings}`)
}

/** Records a collect the engine made (a harvest of `decide`, or the collect a re-range or reduce starts with). */
export function recordCollect(l: HarvestLedger, e: RegistryEntry, ps: PoolSample, fees0: bigint, fees1: bigint, savings: RegistryName): void {
  const pl = poolLedger(l, e.name)
  add(pl.collected, e.token0!, fees0)
  add(pl.collected, e.token1!, fees1)
  pl.collectedValue += valueIn(e, ps, e.token0!, fees0, savings) + valueIn(e, ps, e.token1!, fees1, savings)
}

/**
 * Savings arm, before a re-range or reduce runs: the fees its collect takes go to the savings layer, not the account.
 * The savings-asset side lands at once; the volatile side waits for the pool's next harvest swap.
 */
export function divertFees(l: HarvestLedger, pos: SimPosition, e: RegistryEntry, ps: PoolSample, savings: RegistryName): void {
  const pl = poolLedger(l, e.name)
  recordCollect(l, e, ps, pos.owed0, pos.owed1, savings)
  const vol = otherToken(e, savings)
  const [s, v] = e.token0 === savings ? [pos.owed0, pos.owed1] : [pos.owed1, pos.owed0]
  l.savings += s
  pl.direct += s
  add(pl.pending, vol, v)
  pos.owed0 = 0n
  pos.owed1 = 0n
}

export type HarvestEstimate = { feesValue: bigint; cost: bigint; volatile: RegistryName; volatileAmount: bigint; out: bigint; loss: bigint }

/**
 * What harvesting `pos` now is worth and costs, at the pool mid. Savings: collect + (when there is volatile to sell)
 * one swap, and the swap's fee and impact on the fees plus what waits in `pending`. Compound: collect + increase.
 */
export function estimate(arm: HarvestArm, pl: PoolLedger | undefined, pos: SimPosition, e: RegistryEntry, ps: PoolSample, savings: RegistryName, gasOf: (k: OpKind) => bigint): HarvestEstimate {
  const vol = otherToken(e, savings)
  const owedVol = e.token0 === savings ? pos.owed1 : pos.owed0
  const owedSav = e.token0 === savings ? pos.owed0 : pos.owed1
  const amount = owedVol + (arm.kind === 'savings' ? (pl?.pending[vol] ?? 0n) : 0n)
  const mid = valueIn(e, ps, vol, amount, savings)
  const feesValue = owedSav + mid
  if (arm.kind === 'compound') return { feesValue, cost: gasOf('harvest') + gasOf('increase_liquidity'), volatile: vol, volatileAmount: amount, out: 0n, loss: 0n }
  const out = amount > 0n ? swapOut(e, ps, vol, amount) : 0n
  const loss = mid > out ? mid - out : 0n
  return { feesValue, cost: gasOf('harvest') + (amount > 0n ? gasOf('enter_swap') + loss : 0n), volatile: vol, volatileAmount: amount, out, loss }
}

/** The arm's trigger: fees at least k times the cost; with a time cap, past the cap and at least once the cost. */
export function triggers(arm: HarvestArm, est: HarvestEstimate, now: number, since: number): boolean {
  if (arm.kind === 'live' || est.feesValue <= 0n) return false
  const k = BigInt(Math.round(arm.k * 100))
  if (est.feesValue * 100n >= k * est.cost) return true
  return arm.kind === 'savings' && arm.capSeconds !== undefined && now - since >= arm.capSeconds && est.feesValue >= est.cost
}

/** One operation the arm ran, for the run's log. */
export type LabOp = { kind: OpKind; pool: RegistryName; tokenId: bigint; grant: string; gasCost: bigint; feesValue: bigint }

/**
 * At a review: the first position (in the account's order) whose fees meet the arm's trigger is harvested. Savings: the
 * collect and the swap of the volatile part (two userOps: a convert in the same batch could sell principal, #140), the
 * proceeds to the savings layer. Compound: the collect and an increase of the same position with what fits its range;
 * what does not fit stays in the account, as live. Returns the operations, or null when no position triggers.
 */
export function labHarvest(l: HarvestLedger, w: World, ds: { pools: RegistryName[] }, s: Sample, savings: RegistryName, slippageBps: number, gasOf: (k: OpKind) => bigint): LabOp[] | null {
  const arm = l.arm
  if (arm.kind === 'live') return null
  for (const pos of w.positions) {
    const ps = s.pools[ds.pools.indexOf(pos.pool)]
    if (!ps) continue
    if (!l.since.has(pos.tokenId)) l.since.set(pos.tokenId, s.time)
    const e = entry(pos.pool, baseRegistry)
    const pl = l.pools[pos.pool]
    const est = estimate(arm, pl, pos, e, ps, savings, gasOf)
    if (!triggers(arm, est, s.time, l.since.get(pos.tokenId)!)) continue
    const led = poolLedger(l, pos.pool)
    const fees0 = pos.owed0
    const fees1 = pos.owed1
    recordCollect(l, e, ps, fees0, fees1, savings)
    pos.owed0 = 0n
    pos.owed1 = 0n
    l.since.set(pos.tokenId, s.time)
    led.harvests++
    const collectGas = gasOf('harvest')
    led.gas += collectGas
    const ops: LabOp[] = [{ kind: 'harvest', pool: pos.pool, tokenId: pos.tokenId, grant: 'lab:harvest', gasCost: collectGas, feesValue: est.feesValue }]
    if (arm.kind === 'savings') {
      const owedSav = e.token0 === savings ? fees0 : fees1
      l.savings += owedSav
      led.direct += owedSav
      if (est.volatileAmount > 0n) {
        add(led.converted, est.volatile, est.volatileAmount)
        led.convertedValue += est.out + est.loss
        led.swapOut += est.out
        led.swapLoss += est.loss
        led.pending[est.volatile] = 0n
        l.savings += est.out
        led.swaps++
        const swapGas = gasOf('enter_swap')
        led.gas += swapGas
        ops.push({ kind: 'enter_swap', pool: pos.pool, tokenId: pos.tokenId, grant: 'lab:harvest-swap', gasCost: swapGas, feesValue: 0n })
      }
      return ops
    }
    // Compound: the fees land in the account, then go back into the position as far as its range takes them.
    w.balances[e.token0!] = (w.balances[e.token0!] ?? 0n) + fees0
    w.balances[e.token1!] = (w.balances[e.token1!] ?? 0n) + fees1
    let q
    try {
      q = quoteMint({ sqrtPriceX96: ps.sqrtPriceX96, tickLower: pos.tickLower, tickUpper: pos.tickUpper, amount0Desired: fees0, amount1Desired: fees1, slippageBps })
    } catch (err) {
      if (!(err instanceof ReasonError)) throw err
      q = null
    }
    if (q && q.liquidity > 0n) {
      w.balances[e.token0!] = w.balances[e.token0!]! - q.amount0
      w.balances[e.token1!] = w.balances[e.token1!]! - q.amount1
      pos.liquidity += q.liquidity
      led.increases++
      const incGas = gasOf('increase_liquidity')
      led.gas += incGas
      ops.push({ kind: 'increase_liquidity', pool: pos.pool, tokenId: pos.tokenId, grant: 'lab:compound', gasCost: incGas, feesValue: 0n })
    }
    return ops
  }
  return null
}

/**
 * The savings layer earns what the account's stables position earned per unit of value over the interval (the
 * stated assumption: the layer sits in the same stable pool, same range, and is small next to it).
 */
export function accrueYield(l: HarvestLedger, stableFees: bigint, stableValue: bigint): void {
  if (l.savings === 0n || stableFees === 0n || stableValue === 0n) return
  const t = l.savingsRemX128 + (l.savings * stableFees * Q128) / stableValue
  const whole = t / Q128
  l.savingsRemX128 = t % Q128
  l.savings += whole
  l.yieldEarned += whole
}

/**
 * Drift of the principal from the policy's target weights at this review, as `allocate` values the buckets (positions
 * and idle volatile at the TWAP, over the account's free savings and buckets): the largest bucket's distance in bps.
 * Counted from the first review that has a position in every bucket's pool and every bucket within the policy's
 * re-balance band (3% when it sets none): before it the account is still entering, and every arm enters the same way.
 */
export function driftStep(l: HarvestLedger, obs: Observation, policy: PolicyVersion): void {
  const pools = policy.buckets.flatMap((b) => b.pools.slice(0, 1))
  if (!l.drift.entered && !pools.every((p) => obs.positions.some((x) => x.pool === p))) return
  const a = allocate(obs, policy, false)
  const pref = policy.buckets.reduce((n, b) => n + b.preference, 0)
  let worst = 0
  for (const b of a.buckets) {
    const target = (policy.buckets.find((x) => x.id === b.bucket)!.preference * 10_000) / pref
    worst = Math.max(worst, Math.abs(b.weightBps - target))
  }
  if (!l.drift.entered) l.drift.entered = worst <= (policy.rebalanceBandBps ?? 300)
  if (!l.drift.entered) return
  l.drift.samples++
  l.drift.sumBps += worst
  l.drift.maxBps = Math.max(l.drift.maxBps, worst)
}

/** Per pool, at the end of the run; raw savings units. */
export type PoolHarvestReport = {
  pool: RegistryName
  fees: bigint
  harvests: number
  swaps: number
  increases: number
  gas: bigint
  swapLoss: bigint
  /** Savings: USDC this pool put in the layer, plus what still waits to be sold at the end price, minus gas. In kind: the fees collected, at the end price, minus gas. */
  captured: bigint
  /** Savings: what the volatile fees sold would have lost (or gained, negative) had they been held to the end. In kind: 0. */
  exposureRemoved: bigint
  /** Fees still in positions at the end, at the end price. */
  uncollected: bigint
}

export type HarvestReport = {
  arm: string
  savings: bigint
  yieldEarned: bigint
  /** Savings: the layer plus what waits to be sold, minus the harvests' gas. In kind: the fees collected, at the end price, minus gas. */
  captured: bigint
  exposureRemoved: bigint
  /** Gas of the harvests' own operations and the swaps' fee and impact; fees accrued by every position. */
  cost: bigint
  fees: bigint
  harvests: number
  swaps: number
  increases: number
  driftMaxBps: number
  driftMeanBps: number
  /** Lowest value of the account net of gas over the run (#150: gas must not take it below zero). */
  minValue: bigint
  pools: PoolHarvestReport[]
}

/** Value at the end of what the arm holds outside the account: the savings layer and the volatile fees waiting in it. */
export function heldOutside(l: HarvestLedger, s: Sample, price: (s: Sample, token: RegistryName, amount: bigint) => bigint): bigint {
  let v = l.savings
  for (const pl of Object.values(l.pools)) for (const [token, amount] of Object.entries(pl.pending)) v += price(s, token, amount)
  return v
}

export function harvestReport(l: HarvestLedger, w: World, last: Sample, price: (s: Sample, token: RegistryName, amount: bigint) => bigint, minValue: bigint): HarvestReport {
  const pools: PoolHarvestReport[] = Object.entries(l.pools)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pool, pl]) => {
      const e = entry(pool, baseRegistry)
      const atEnd = (r: Record<RegistryName, bigint>) => Object.entries(r).reduce((n, [t, a]) => n + price(last, t, a), 0n)
      const captured = l.arm.kind === 'savings' ? pl.direct + pl.swapOut + atEnd(pl.pending) - pl.gas : atEnd(pl.collected) - pl.gas
      const exposureRemoved = l.arm.kind === 'savings' ? pl.convertedValue - atEnd(pl.converted) : 0n
      const uncollected = w.positions.filter((p) => p.pool === pool).reduce((n, p) => n + price(last, e.token0!, p.owed0) + price(last, e.token1!, p.owed1), 0n)
      return { pool, fees: pl.fees, harvests: pl.harvests, swaps: pl.swaps, increases: pl.increases, gas: pl.gas, swapLoss: pl.swapLoss, captured, exposureRemoved, uncollected }
    })
  const sum = (f: (p: PoolHarvestReport) => bigint) => pools.reduce((n, p) => n + f(p), 0n)
  const count = (f: (p: PoolHarvestReport) => number) => pools.reduce((n, p) => n + f(p), 0)
  return {
    arm: armName(l.arm),
    savings: l.savings,
    yieldEarned: l.yieldEarned,
    captured: sum((p) => p.captured) + l.yieldEarned,
    exposureRemoved: sum((p) => p.exposureRemoved),
    cost: sum((p) => p.gas + p.swapLoss),
    fees: sum((p) => p.fees),
    harvests: count((p) => p.harvests),
    swaps: count((p) => p.swaps),
    increases: count((p) => p.increases),
    driftMaxBps: l.drift.maxBps,
    driftMeanBps: l.drift.samples === 0 ? 0 : Math.round(l.drift.sumBps / l.drift.samples),
    minValue,
    pools,
  }
}
