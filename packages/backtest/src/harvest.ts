// Lab (otto/mamoru#178): harvest arms. The live engine harvests at 3x its userOp budget and only collects (#140); the
// volatile fees then wait in the account until target-weights re-allocates them. The Lab compares that with two other
// rules, run by the simulator around the production `decide`, never inside it:
// - `savings` (A·k): a position's fees go to a USDC savings layer apart from the buckets, when they reach k times what
//   the harvest costs (collect + swap of the volatile part + its pool fee and price impact), or, with a time cap, when
//   the cap has passed and they cover the cost once. Savings never go back into a bucket and are not part of the
//   target weights.
// - `compound` (B): the fees go back into the same position (increaseLiquidity), when they reach k times the cost of a
//   collect and an increase. Reference, as Beefy does.
// otto/mamoru#413 adds two shapes, Lab only:
// - `savings` with a `vault` sink: the savings layer is the Stable vault, outside the bucket weights. Harvested USDC
//   waits as USDC until one deposit of at least max(1 USDC, sweepK x the deposit's gas) goes in (its own userOp), then
//   earns the vault's share-price growth.
// - `switch` (D): per pool, compound while the pool's trailing fee APR is high, savings (vault sink) once it falls under
//   `exitBps`; back to compounding only above `enterBps` (hysteresis), so it does not flip on noise.
// Absent from the run config, nothing here runs and every result hash is the one of before.
import { ReasonError } from '@mamoru/domain'
import { amountsForLiquidity, amountsOf, inSavings, volatileOf, type Observation } from '@mamoru/decide'
import type { PolicyVersion } from '@mamoru/policy'
import { baseRegistry, entry, type RegistryEntry, type RegistryName } from '@mamoru/registry'
import { quoteMint, sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import type { OpKind, PoolSample, Sample } from './types.ts'
import { swapOut, valueIn, type SimPosition, type World } from './world.ts'

const Q128 = 1n << 128n

/**
 * `live`: `decide` as it is; the run only measures. `savings`: A·k, `capSeconds` the time cap T. `compound`: B. `k` is a
 * multiple of the harvest's own cost, read to the hundredth.
 */
export type HarvestArm =
  | { kind: 'live' }
  | { kind: 'savings'; k: number; capSeconds?: number; sink?: VaultSink }
  | { kind: 'compound'; k: number }
  | SwitchArm

/**
 * #413: the savings layer is the Stable vault. Harvested USDC waits as USDC (`sweep`) until it reaches
 * max(`VAULT_MIN_SWEEP`, sweepK x the gas of a vault deposit); one deposit userOp then puts it in, and from there it grows
 * with the vault's share price (`SimConfig.vaultPrices`). Valued at its share price; no redeem is charged, as no arm
 * pays the exit of its positions.
 */
export type VaultSink = { kind: 'vault'; sweepK: number }

/**
 * #413 mode D: per pool, compound (as `compound`) while the pool's fee APR over the last `aprSeconds` is high; once it
 * falls under `exitBps`, savings into the vault (as `savings` with the sink); back to compounding only when it rises
 * over `enterBps`. Every pool starts compounding and keeps that until it has `aprSeconds` of history.
 */
export type SwitchArm = { kind: 'switch'; k: number; capSeconds?: number; sink: VaultSink; aprSeconds: number; exitBps: number; enterBps: number }

/** The engine's vault floor on v7/v8 (policy V7_ENGINE, otto/mamoru#390): 1 USDC. */
export const VAULT_MIN_SWEEP = 1_000_000n

const days = (sec: number) => (sec % 86_400 === 0 ? `${sec / 86_400}d` : `${sec}s`)

export function armName(a: HarvestArm): string {
  if (a.kind === 'live') return 'live'
  if (a.kind === 'compound') return `B-k${a.k}`
  const cap = a.capSeconds ? `-T${days(a.capSeconds)}` : ''
  if (a.kind === 'switch') return `D-k${a.k}${cap}-s${a.sink.sweepK}-apr${a.exitBps}-${a.enterBps}-${days(a.aprSeconds)}`
  return `A-k${a.k}${cap}${a.sink ? `-vault-s${a.sink.sweepK}` : ''}`
}

/** The vault sink of an arm, if it has one. */
export function sinkOf(a: HarvestArm): VaultSink | undefined {
  return a.kind === 'switch' ? a.sink : a.kind === 'savings' ? a.sink : undefined
}

/** What one pool's fees went through over a run. Amounts are raw token units; values raw savings units. */
export type PoolLedger = {
  /** Fees taken out of positions (harvests, and the collect a re-range or reduce starts with), per token. */
  collected: Record<RegistryName, bigint>
  /** The same at the price of each collect. */
  collectedValue: bigint
  /** Fees accrued by the pool's positions, collected or not; and the same in raw token units. */
  fees: bigint
  earned: Record<RegistryName, bigint>
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
  /**
   * Savings arm: volatile fees a re-range or reduce collected, waiting for the pool's next harvest swap (or a swap of
   * their own, when the pool has no position left). Not savings until sold: reported as unconverted.
   */
  pending: Record<RegistryName, bigint>
  /**
   * Compound arm: fees that ended in the account in kind (what an increase could not take, the collect of a re-range
   * or reduce) and the compounded liquidity's share of a position a re-range or reduce took out, per token.
   */
  inKind: Record<RegistryName, bigint>
  /**
   * Compound arm: the value, in the savings asset at the TWAP of that moment, of every compounded share a re-range or
   * reduce took out. Fixed from then on: no later price exposure, and its re-compounding is not attributed.
   */
  frozen: bigint
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
  /** Compound arm, per position: the liquidity its compounded fees bought (and still hold). */
  compounded: Map<bigint, bigint>
  /** Principal drift from the target weights, from the first review with a position in every bucket. */
  drift: { entered: boolean; samples: number; sumBps: number; maxBps: number }
  /** Vault sink (#413): savings USDC not deposited yet (part of `savings`), deposits made and their gas. */
  sweep: bigint
  sweeps: number
  sweepGas: bigint
  vaultRemE18: bigint
  /** Switch arm (#413), per pool: fee intervals for the trailing APR, the pool's current mode, and how often it flipped. */
  apr: Map<RegistryName, { first: number; xs: { time: number; fees: number; valueSeconds: number }[] }>
  mode: Map<RegistryName, 'compound' | 'savings'>
  switches: number
}

export function newLedger(arm: HarvestArm): HarvestLedger {
  return { arm, savings: 0n, savingsRemX128: 0n, yieldEarned: 0n, pools: {}, since: new Map(), compounded: new Map(), drift: { entered: false, samples: 0, sumBps: 0, maxBps: 0 }, sweep: 0n, sweeps: 0, sweepGas: 0n, vaultRemE18: 0n, apr: new Map(), mode: new Map(), switches: 0 }
}

/** USDC into the savings layer; with a vault sink it waits for the next deposit. */
function toSavings(l: HarvestLedger, amount: bigint): void {
  l.savings += amount
  if (sinkOf(l.arm)) l.sweep += amount
}

/**
 * The rule a pool's fees follow now: the arm itself, or for `switch` the savings or compound rule of the pool's mode.
 * `savings` here never carries the sink; the sink is read from the ledger's arm.
 */
export function ruleOf(l: HarvestLedger, pool: RegistryName): Exclude<HarvestArm, SwitchArm> {
  const a = l.arm
  if (a.kind !== 'switch') return a
  return (l.mode.get(pool) ?? 'compound') === 'compound' ? { kind: 'compound', k: a.k } : { kind: 'savings', k: a.k, ...(a.capSeconds ? { capSeconds: a.capSeconds } : {}) }
}

/** Switch arm: one interval of a pool's positions, its fees and value (raw savings units) over `dt` seconds. */
export function recordInterval(l: HarvestLedger, pool: RegistryName, time: number, fees: bigint, value: bigint, dt: number): void {
  if (l.arm.kind !== 'switch' || dt <= 0) return
  const h = l.apr.get(pool) ?? { first: time - dt, xs: [] }
  h.xs.push({ time, fees: Number(fees), valueSeconds: Number(value) * dt })
  while (h.xs.length && h.xs[0]!.time <= time - l.arm.aprSeconds) h.xs.shift()
  l.apr.set(pool, h)
}

/** Trailing fee APR of a pool in bps, or null before it has `aprSeconds` of history. */
export function aprBps(l: HarvestLedger, pool: RegistryName, now: number): number | null {
  if (l.arm.kind !== 'switch') return null
  const h = l.apr.get(pool)
  if (!h || now - h.first < l.arm.aprSeconds) return null
  let fees = 0
  let vs = 0
  for (const x of h.xs) {
    fees += x.fees
    vs += x.valueSeconds
  }
  return vs > 0 ? (fees * 365 * 86_400 * 10_000) / vs : 0
}

/** Switch arm, at a review: each pool with history moves between compound and savings on its APR, with hysteresis. */
export function stepModes(l: HarvestLedger, now: number): void {
  const a = l.arm
  if (a.kind !== 'switch') return
  for (const pool of l.apr.keys()) {
    const apr = aprBps(l, pool, now)
    if (apr === null) continue
    const m = l.mode.get(pool) ?? 'compound'
    const next = m === 'compound' && apr < a.exitBps ? 'savings' : m === 'savings' && apr > a.enterBps ? 'compound' : m
    if (next !== m) {
      l.mode.set(pool, next)
      l.switches++
    }
  }
}

/**
 * Vault sink: the savings already deposited grow with the vault's share price from `fromPrice` to `toPrice`. What
 * waits in `sweep` earns nothing.
 */
export function accrueVault(l: HarvestLedger, fromPrice: number, toPrice: number): void {
  const invested = l.savings - l.sweep
  if (invested <= 0n || toPrice === fromPrice) return
  const g = BigInt(Math.round((toPrice / fromPrice - 1) * 1e18))
  const t = l.vaultRemE18 + invested * g
  const whole = t / 10n ** 18n
  l.vaultRemE18 = t % 10n ** 18n
  l.savings += whole
  l.yieldEarned += whole
}

/** Fees a position earned over one interval (#178: the ledger balances to them, token by token). */
export function recordEarned(l: HarvestLedger, e: RegistryEntry, fees0: bigint, fees1: bigint, value: bigint): void {
  const pl = poolLedger(l, e.name)
  pl.fees += value
  add(pl.earned, e.token0!, fees0)
  add(pl.earned, e.token1!, fees1)
}

export function poolLedger(l: HarvestLedger, pool: RegistryName): PoolLedger {
  return (l.pools[pool] ??= { collected: {}, collectedValue: 0n, fees: 0n, earned: {}, harvests: 0, swaps: 0, increases: 0, converted: {}, convertedValue: 0n, swapOut: 0n, direct: 0n, gas: 0n, swapLoss: 0n, pending: {}, inKind: {}, frozen: 0n })
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
 * Savings arm, after a re-range or reduce has run: the fees its collect credited to the account go to the savings
 * layer instead. The savings-asset side lands at once; the volatile side waits for a harvest swap. Called only for an
 * operation that went through, with the fees it collected.
 */
export function divertFees(l: HarvestLedger, w: World, e: RegistryEntry, ps: PoolSample, fees0: bigint, fees1: bigint, savings: RegistryName): void {
  const pl = poolLedger(l, e.name)
  recordCollect(l, e, ps, fees0, fees1, savings)
  for (const [token, amount] of [[e.token0!, fees0], [e.token1!, fees1]] as const) {
    const held = w.balances[token] ?? 0n
    if (amount > held) throw new Error(`diverting ${amount} ${token} of fees, the account holds ${held}`)
    w.balances[token] = held - amount
  }
  const vol = otherToken(e, savings)
  const [s, v] = e.token0 === savings ? [fees0, fees1] : [fees1, fees0]
  toSavings(l, s)
  pl.direct += s
  add(pl.pending, vol, v)
}

/**
 * Compound arm, before a re-range or reduce of `pos` takes out `removed` liquidity: the compounded share of what comes
 * out, valued in the savings asset at `twapSqrtPriceX96`. `commit` books it once the operation went through: it is
 * added to B's captured as a fixed amount and the position's compounded liquidity shrinks by it. A replacement position
 * starts with no compounded liquidity (a stated limit of B: what it later re-compounds from that value is not
 * attributed).
 */
export function compoundedShare(l: HarvestLedger, pos: SimPosition, removed: bigint, twapSqrtPriceX96: bigint, savings: RegistryName): { commit: () => void } {
  const added = l.compounded.get(pos.tokenId) ?? 0n
  if (added === 0n || pos.liquidity === 0n) return { commit: () => {} }
  const share = (added * (removed < pos.liquidity ? removed : pos.liquidity)) / pos.liquidity
  const out = amountsOf(twapSqrtPriceX96, pos.tickLower, pos.tickUpper, share)
  const e = entry(pos.pool, baseRegistry)
  const at = { sqrtPriceX96: twapSqrtPriceX96 } as PoolSample
  const value = valueIn(e, at, e.token0!, out.amount0, savings) + valueIn(e, at, e.token1!, out.amount1, savings)
  return {
    commit: () => {
      poolLedger(l, pos.pool).frozen += value
      l.compounded.set(pos.tokenId, added - share)
    },
  }
}

/** Compound arm: fees a re-range or reduce collected stay in the account in kind. */
export function keepInKind(l: HarvestLedger, e: RegistryEntry, fees0: bigint, fees1: bigint): void {
  const pl = poolLedger(l, e.name)
  add(pl.inKind, e.token0!, fees0)
  add(pl.inKind, e.token1!, fees1)
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
 * what does not fit stays in the account, as live. With a vault sink and `sweep`, a review with no harvest deposits the
 * waiting savings once they reach the floor. Returns the operations, or null when nothing triggers.
 */
export function labHarvest(l: HarvestLedger, w: World, ds: { pools: RegistryName[] }, s: Sample, savings: RegistryName, slippageBps: number, gasOf: (k: OpKind) => bigint, sweep = true): LabOp[] | null {
  if (l.arm.kind === 'live') return null
  stepModes(l, s.time)
  for (const pos of w.positions) {
    const arm = ruleOf(l, pos.pool)
    if (arm.kind === 'live') return null
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
      toSavings(l, owedSav)
      led.direct += owedSav
      if (est.volatileAmount > 0n) {
        sell(l, led, est)
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
    const used = q && q.liquidity > 0n ? q : null
    add(led.inKind, e.token0!, fees0 - (used?.amount0 ?? 0n))
    add(led.inKind, e.token1!, fees1 - (used?.amount1 ?? 0n))
    if (used) {
      w.balances[e.token0!] = w.balances[e.token0!]! - used.amount0
      w.balances[e.token1!] = w.balances[e.token1!]! - used.amount1
      pos.liquidity += used.liquidity
      l.compounded.set(pos.tokenId, (l.compounded.get(pos.tokenId) ?? 0n) + used.liquidity)
      led.increases++
      const incGas = gasOf('increase_liquidity')
      led.gas += incGas
      ops.push({ kind: 'increase_liquidity', pool: pos.pool, tokenId: pos.tokenId, grant: 'lab:compound', gasCost: incGas, feesValue: 0n })
    }
    return ops
  }
  // Savings: volatile fees a re-range or reduce left waiting in a pool that has no position any more get a swap of
  // their own, on the same rule (no collect in the cost). Pending exists only for a pool whose fees were diverted.
  if (l.arm.kind === 'savings' || l.arm.kind === 'switch') for (const [pool, pl] of Object.entries(l.pools)) {
    if (w.positions.some((p) => p.pool === pool)) continue
    const ps = s.pools[ds.pools.indexOf(pool)]
    if (!ps) continue
    const e = entry(pool, baseRegistry)
    const vol = otherToken(e, savings)
    const amount = pl.pending[vol] ?? 0n
    if (amount === 0n) continue
    const out = swapOut(e, ps, vol, amount)
    const mid = valueIn(e, ps, vol, amount, savings)
    const loss = mid > out ? mid - out : 0n
    const est = { feesValue: mid, cost: gasOf('enter_swap') + loss, volatile: vol, volatileAmount: amount, out, loss }
    if (!triggers({ kind: 'savings', k: l.arm.k }, est, s.time, s.time)) continue
    sell(l, pl, est)
    const swapGas = gasOf('enter_swap')
    pl.gas += swapGas
    return [{ kind: 'enter_swap', pool, tokenId: 0n, grant: 'lab:harvest-swap', gasCost: swapGas, feesValue: 0n }]
  }
  // Vault sink (#413): the waiting USDC goes into the vault in one deposit once it is worth the deposit's gas.
  const sink = sinkOf(l.arm)
  if (sweep && sink && l.sweep > 0n) {
    const gas = gasOf('vault_deposit')
    const floor = (gas * BigInt(Math.round(sink.sweepK * 100))) / 100n
    if (l.sweep >= (floor > VAULT_MIN_SWEEP ? floor : VAULT_MIN_SWEEP)) {
      l.sweep = 0n
      l.sweeps++
      l.sweepGas += gas
      return [{ kind: 'vault_deposit', pool: 'vault:gtUSDCp', tokenId: 0n, grant: 'lab:savings-deposit', gasCost: gas, feesValue: 0n }]
    }
  }
  return null
}

/** Sells the volatile fees of an estimate (the position's and what was pending) into the savings layer. */
function sell(l: HarvestLedger, led: PoolLedger, est: HarvestEstimate): void {
  add(led.converted, est.volatile, est.volatileAmount)
  led.convertedValue += est.out + est.loss
  led.swapOut += est.out
  led.swapLoss += est.loss
  led.pending[est.volatile] = 0n
  toSavings(l, est.out)
  led.swaps++
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
 * Drift of the principal from the policy's target weights at this review: the largest distance (bps of the account)
 * between a bucket's weight and its target. A bucket is worth its positions in any of its pools (amounts and fees owed,
 * at the TWAP) and the idle volatile token of its pools (counted once, for the first bucket that lists it); the account
 * is its free savings asset plus the buckets. The savings layer is outside it. Sampled at every review from the first
 * one where every bucket that has pools holds a position in one of them.
 */
export function driftStep(l: HarvestLedger, obs: Observation, policy: PolicyVersion): void {
  const savings = policy.savingsAsset
  // A pool listed by two buckets would give each the full value of its positions: no policy under test does it.
  const listed = policy.buckets.flatMap((b) => b.pools)
  if (new Set(listed).size !== listed.length) throw new Error(`${policy.policyId}: two buckets share a pool; drift would count its positions twice`)
  const live = policy.buckets.filter((b) => b.pools.length > 0)
  if (!l.drift.entered) l.drift.entered = live.length > 0 && live.every((b) => obs.positions.some((x) => !!x.pool && b.pools.includes(x.pool)))
  if (!l.drift.entered) return
  const counted = new Set<RegistryName>()
  const values = policy.buckets.map((b) => {
    let v = 0n
    for (const name of b.pools) {
      const pool = obs.pools.find((x) => x.name === name)
      if (!pool) continue
      const sp = pool.twapTick === null ? pool.sqrtPriceX96 : sqrtRatioAtTick(pool.twapTick)
      const at = { ...pool, sqrtPriceX96: sp }
      for (const pos of obs.positions) {
        if (pos.pool !== name) continue
        const a = amountsForLiquidity(sp, pos.tickLower, pos.tickUpper, pos.liquidity)
        v += inSavings(at, at.token0, a.amount0 + pos.collectable0, savings) + inSavings(at, at.token1, a.amount1 + pos.collectable1, savings)
      }
      const vol = volatileOf(pool, savings)
      if (!counted.has(vol)) {
        counted.add(vol)
        v += inSavings(at, vol, obs.balances[vol] ?? 0n, savings)
      }
    }
    return v
  })
  const total = (obs.balances[savings] ?? 0n) + values.reduce((a, b) => a + b, 0n)
  if (total === 0n) return
  const pref = policy.buckets.reduce((n, b) => n + b.preference, 0)
  let worst = 0
  policy.buckets.forEach((b, i) => {
    const weight = Number((values[i]! * 10_000n) / total)
    worst = Math.max(worst, Math.abs(weight - (b.preference * 10_000) / pref))
  })
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
  /**
   * Savings: USDC this pool put in the layer, minus gas. Live: the fees collected, held in kind, at the end price, minus
   * gas. Compound: the compounded liquidity's share of the positions at the end (fees owed on it included), plus what
   * stayed in kind, at the end price, minus gas.
   */
  captured: bigint
  /** Savings: volatile fees collected and not sold yet, at the end price; not part of `captured`. */
  unconverted: bigint
  /** Savings: what the volatile fees sold would have lost (or gained, negative) had they been held to the end. In kind: 0. */
  exposureRemoved: bigint
  /** Fees still in positions at the end, at the end price. */
  uncollected: bigint
}

export type HarvestReport = {
  arm: string
  savings: bigint
  yieldEarned: bigint
  /** Sum of the pools' `captured`, plus the savings layer's yield. */
  captured: bigint
  unconverted: bigint
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
  /**
   * #413: realized yield, what the 10 % fee is charged on: every fee collected (harvests and the collect a re-range or
   * reduce starts with, at the price of each collect) plus the savings layer's yield. Fees still owed are not in it.
   */
  realized: bigint
  /** Vault sink (#413): deposits, their gas (also in `cost`), and the savings USDC still waiting for one. */
  vault?: { sweeps: number; gas: bigint; waiting: bigint }
  /** Switch arm (#413): mode flips over the run, and each pool's mode at the end. */
  switches?: { count: number; endModes: Record<RegistryName, 'compound' | 'savings'> }
  pools: PoolHarvestReport[]
}

/** Value at the end of what the arm holds outside the account: the savings layer and the volatile fees waiting in it. */
export function heldOutside(l: HarvestLedger, s: Sample, price: (s: Sample, token: RegistryName, amount: bigint) => bigint): bigint {
  let v = l.savings
  for (const pl of Object.values(l.pools)) for (const [token, amount] of Object.entries(pl.pending)) v += price(s, token, amount)
  return v
}

export function harvestReport(l: HarvestLedger, w: World, ds: { pools: RegistryName[] }, last: Sample, price: (s: Sample, token: RegistryName, amount: bigint) => bigint, minValue: bigint): HarvestReport {
  const poolIndex = (name: RegistryName) => ds.pools.indexOf(name)
  const pools: PoolHarvestReport[] = Object.entries(l.pools)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pool, pl]) => {
      const e = entry(pool, baseRegistry)
      const atEnd = (r: Record<RegistryName, bigint>) => Object.entries(r).reduce((n, [t, a]) => n + price(last, t, a), 0n)
      // Every fee unit a position earned is either collected or still owed: a fee moved twice or erased stops the run.
      for (const t of [e.token0!, e.token1!]) {
        const owed = w.positions.filter((p) => p.pool === pool).reduce((n, p) => n + (t === e.token0 ? p.owed0 : p.owed1), 0n)
        if ((pl.earned[t] ?? 0n) !== (pl.collected[t] ?? 0n) + owed) throw new Error(`${pool} ${t}: earned ${pl.earned[t] ?? 0n}, collected ${pl.collected[t] ?? 0n} + owed ${owed}`)
      }
      const ps = last.pools[poolIndex(pool)]
      // Compound: what the compounded liquidity is worth at the end, its share of each position's amounts and fees owed.
      const lpShare = w.positions.filter((p) => p.pool === pool && p.liquidity > 0n).reduce((n, p) => {
        const added = l.compounded.get(p.tokenId) ?? 0n
        if (added === 0n || !ps) return n
        const a = amountsOf(ps.sqrtPriceX96, p.tickLower, p.tickUpper, p.liquidity)
        const whole = price(last, e.token0!, a.amount0 + p.owed0) + price(last, e.token1!, a.amount1 + p.owed1)
        return n + (whole * added) / p.liquidity
      }, 0n)
      // A switch arm sums both rules' parts; under savings or compound alone the other rule's parts are zero.
      const captured =
        l.arm.kind === 'savings' ? pl.direct + pl.swapOut - pl.gas
        : l.arm.kind === 'compound' ? lpShare + atEnd(pl.inKind) + pl.frozen - pl.gas
        : l.arm.kind === 'switch' ? pl.direct + pl.swapOut + lpShare + atEnd(pl.inKind) + pl.frozen - pl.gas
        : atEnd(pl.collected) - pl.gas
      const diverts = l.arm.kind === 'savings' || l.arm.kind === 'switch'
      const unconverted = diverts ? atEnd(pl.pending) : 0n
      const exposureRemoved = diverts ? pl.convertedValue - atEnd(pl.converted) : 0n
      const uncollected = w.positions.filter((p) => p.pool === pool).reduce((n, p) => n + price(last, e.token0!, p.owed0) + price(last, e.token1!, p.owed1), 0n)
      return { pool, fees: pl.fees, harvests: pl.harvests, swaps: pl.swaps, increases: pl.increases, gas: pl.gas, swapLoss: pl.swapLoss, captured, unconverted, exposureRemoved, uncollected }
    })
  const sum = (f: (p: PoolHarvestReport) => bigint) => pools.reduce((n, p) => n + f(p), 0n)
  const count = (f: (p: PoolHarvestReport) => number) => pools.reduce((n, p) => n + f(p), 0)
  return {
    arm: armName(l.arm),
    savings: l.savings,
    yieldEarned: l.yieldEarned,
    captured: sum((p) => p.captured) + l.yieldEarned - l.sweepGas,
    unconverted: sum((p) => p.unconverted),
    exposureRemoved: sum((p) => p.exposureRemoved),
    cost: sum((p) => p.gas + p.swapLoss) + l.sweepGas,
    fees: sum((p) => p.fees),
    harvests: count((p) => p.harvests),
    swaps: count((p) => p.swaps),
    increases: count((p) => p.increases),
    driftMaxBps: l.drift.maxBps,
    driftMeanBps: l.drift.samples === 0 ? 0 : Math.round(l.drift.sumBps / l.drift.samples),
    minValue,
    realized: Object.values(l.pools).reduce((n, pl) => n + pl.collectedValue, 0n) + l.yieldEarned,
    ...(sinkOf(l.arm) ? { vault: { sweeps: l.sweeps, gas: l.sweepGas, waiting: l.sweep } } : {}),
    ...(l.arm.kind === 'switch' ? { switches: { count: l.switches, endModes: Object.fromEntries([...l.mode.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) } } : {}),
    pools,
  }
}
