// Lab otto/mamoru#186: single-asset USDC supply into an ERC-4626 vault, as a study arm beside the LP buckets. Supply
// only: one deposit at the window's first sample, one redeem at its last. Interest is the share price's growth: the
// vault's own observed share price where a public series has it, otherwise a model from a public daily rate series.
// Nothing here runs in `decide`; it prices the vault's two operations with the simulator's gas model on the window's
// own samples.
import { baseRegistry, entry } from '@mamoru/registry'
import { token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { ETH_PRICE_POOL } from './observe.ts'
import { DEFAULT_GAS } from './run.ts'
import type { Dataset, GasModel, Sample } from './types.ts'

const YEAR = 365 * 86_400
/** Largest gap between two readings a window may contain and still be scored (review of #186, finding 6). */
export const MAX_GAP_SECONDS = 2 * 86_400

/**
 * A daily rate reading (percent) taken at `time`, in force from `time` until the next reading. `null`: the source had
 * no base rate that day (a gap, never zero and never the reward rate).
 */
export type RatePoint = { time: number; ratePct: number | null }
/**
 * How a source's rate accrues. `apy`: effective yearly yield, compounded (MetaMorpho share price, Morpho API APY).
 * `apr`: a simple yearly rate accrued linearly between readings (Aave's `liquidityRate`, which DefiLlama reports as
 * the reserve's base APY); readings compound with each other, as the liquidity index does on every update.
 */
export type RateConvention = 'apy' | 'apr'
/** The vault's assets per share at `time`. */
export type PricePoint = { time: number; price: number }

/** Gas units of the vault's two operations, each one userOp of the Mamoru account. */
export type VaultGas = { deposit: bigint; redeem: bigint }

/**
 * Growth of one unit of assets from `from` to `to` (Unix seconds) under a rate series, each reading applied forward
 * from its own time. Null (unavailable) when the series does not cover the whole window: no reading at or before
 * `from`, a null reading in force inside it, two readings in force inside it more than `maxGap` apart, or the last
 * reading in force more than `maxGap` before `to`.
 */
export function growthFromRates(points: readonly RatePoint[], from: number, to: number, convention: RateConvention, maxGap = MAX_GAP_SECONDS): number | null {
  if (to < from) throw new Error('growthFromRates: to before from')
  let i = points.findLastIndex((p) => p.time <= from)
  if (i < 0) return null
  let log = 0
  for (; i < points.length; i++) {
    const p = points[i]!
    const next = points[i + 1]
    const end = next ? Math.min(next.time, to) : to
    // The reading must be fresh for the whole stretch it covers inside the window.
    if (end - p.time > maxGap) return null
    if (p.ratePct === null) return null
    const r = p.ratePct / 100
    const dt = (end - Math.max(p.time, from)) / YEAR
    if (convention === 'apy') {
      if (r <= -1) throw new Error(`growthFromRates: APY ${p.ratePct}% at ${p.time}`)
      log += Math.log1p(r) * dt
    } else log += Math.log1p(r * dt)
    if (!next || next.time >= to) return Math.exp(log)
  }
  return Math.exp(log)
}

/** Share price at `t`, geometric between the two readings around it. Null outside the series or across a gap > `maxGap`. */
export function priceAt(points: readonly PricePoint[], t: number, maxGap = MAX_GAP_SECONDS): number | null {
  const i = points.findLastIndex((p) => p.time <= t)
  if (i < 0) return null
  const a = points[i]!
  if (a.time === t) return a.price
  const b = points[i + 1]
  if (!b || b.time - a.time > maxGap) return null
  const f = (t - a.time) / (b.time - a.time)
  return a.price * (b.price / a.price) ** f
}

/** Observed growth of the share price from `from` to `to`; null when either end is not covered. */
export function growthFromPrice(points: readonly PricePoint[], from: number, to: number, maxGap = MAX_GAP_SECONDS): number | null {
  const a = priceAt(points, from, maxGap)
  const b = priceAt(points, to, maxGap)
  return a === null || b === null ? null : b / a
}

export type VaultSeries = {
  /** Creation of the vault contract itself (not of the market or reserve under it). */
  created: number
  rates: readonly RatePoint[]
  convention: RateConvention
  /** Observed share price, when a public source has it. */
  prices?: readonly PricePoint[]
}
export type VaultGrowth =
  | { status: 'predates' | 'gap'; growth: null; source: null; model: number | null }
  | { status: 'ok'; growth: number; source: 'price' | 'rates'; model: number | null }

/**
 * The growth a depositor got over the window: the observed share-price ratio where the vault has a price series,
 * the rate model only where it has none. `model` is the rate model alone, to report the discrepancy. A window that
 * starts before the vault existed is `predates`; one the chosen series does not cover is `gap`.
 */
export function vaultGrowth(v: VaultSeries, from: number, to: number, maxGap = MAX_GAP_SECONDS): VaultGrowth {
  const model = from < v.created ? null : growthFromRates(v.rates, from, to, v.convention, maxGap)
  if (from < v.created) return { status: 'predates', growth: null, source: null, model }
  if (v.prices && v.prices.length > 0) {
    const g = growthFromPrice(v.prices, from, to, maxGap)
    return g === null ? { status: 'gap', growth: null, source: null, model } : { status: 'ok', growth: g, source: 'price', model }
  }
  return model === null ? { status: 'gap', growth: null, source: null, model } : { status: 'ok', growth: model, source: 'rates', model }
}

/**
 * Gas of one operation of `units` at sample `s`, in raw USDC: the simulator's formula (units x (base fee + tip) +
 * the L1 data fee), priced through the dataset's ETH price pool.
 */
export function opGasRaw(ds: Dataset, s: Sample, units: bigint, gas: GasModel = DEFAULT_GAS): bigint {
  const wei = units * (s.baseFeeWei + gas.priorityFeeWei) + gas.l1FeeWei
  const e = entry(ETH_PRICE_POOL, baseRegistry)
  const ps = s.pools[ds.pools.indexOf(ETH_PRICE_POOL)]
  if (!ps) throw new Error(`no ${ETH_PRICE_POOL} sample at block ${s.block} to price gas`)
  if (e.token0 !== 'USDC' && e.token1 !== 'USDC') throw new Error(`${ETH_PRICE_POOL} does not price gas in USDC`)
  return e.token0 === 'USDC' ? token1InToken0(wei, ps.sqrtPriceX96) : token0InToken1(wei, ps.sqrtPriceX96)
}

export type VaultRun = {
  deposit: number
  /** Assets the shares are worth at the end, before the redeem's gas. */
  gross: number
  interest: number
  gas: number
  /** End value in USDC net of both operations' gas; holding USDC ends at `deposit`. */
  end: number
  net: number
  returnPct: number
}

/** One deposit, held, one redeem. Amounts in USDC; `gasIn` and `gasOut` are the two operations' cost in USDC. */
export function vaultRun(deposit: number, growth: number, gasIn: number, gasOut: number): VaultRun {
  if (!(deposit > 0)) throw new Error('vaultRun: deposit must be positive')
  // Gas is paid by the account beside the deposit (as the simulator charges it against the value), so all of the
  // deposit buys shares.
  const gross = deposit * growth
  const gas = gasIn + gasOut
  const end = gross - gas
  return { deposit, gross, interest: gross - deposit, gas, end, net: end - deposit, returnPct: ((end - deposit) / deposit) * 100 }
}

/** Effective yearly yield of a rate of `convention`, readings once a day. */
export function effectiveApyPct(ratePct: number, convention: RateConvention): number {
  return convention === 'apy' ? ratePct : ((1 + ratePct / 100 / 365) ** 365 - 1) * 100
}

/** Days until the interest of `deposit` at `apyPct` (effective) pays `gas` (both operations); Infinity when it never does. */
export function breakEvenDays(deposit: number, apyPct: number, gas: number): number {
  if (gas <= 0) return 0
  if (apyPct <= 0) return Number.POSITIVE_INFINITY
  return (Math.log1p(gas / deposit) / Math.log1p(apyPct / 100)) * 365
}

/** Smallest deposit whose interest over `days` at `apyPct` (effective) pays `gas`. */
export function breakEvenDeposit(days: number, apyPct: number, gas: number): number {
  if (days <= 0 || apyPct <= 0) return Number.POSITIVE_INFINITY
  return gas / ((1 + apyPct / 100) ** (days / 365) - 1)
}
