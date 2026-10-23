// Lab otto/mamoru#186: single-asset USDC supply into an ERC-4626 vault, as a study arm beside the LP buckets. Supply
// only: one deposit at the window's first sample, one redeem at its last; interest is the share price's growth, read
// from a public daily APY series (or the vault's own share-price series, to check the APY model). Nothing here runs
// in `decide`; it prices the vault's two operations with the simulator's gas model on the window's own samples.
import { baseRegistry, entry } from '@mamoru/registry'
import { token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { ETH_PRICE_POOL } from './observe.ts'
import { DEFAULT_GAS } from './run.ts'
import type { Dataset, GasModel, Sample } from './types.ts'

const YEAR = 365 * 86_400

/** A daily APY reading (percent, compounded yearly) taken at `time`; it measures the growth since the reading before. */
export type RatePoint = { time: number; apyPct: number }
/** The vault's assets per share at `time`. */
export type PricePoint = { time: number; price: number }

/** Gas units of the vault's two operations, each one userOp of the Mamoru account. */
export type VaultGas = { deposit: bigint; redeem: bigint }

/**
 * Growth of one unit of assets from `from` to `to` (Unix seconds) under a daily APY series. Each reading is the
 * trailing rate of the interval that ends at it, so the rate in force between two readings is the later one's; after
 * the last reading its rate goes on. Null when `from` is before the first reading: the vault, or its data, did not
 * exist yet, and the window is skipped rather than filled.
 */
export function growthFromApy(points: readonly RatePoint[], from: number, to: number): number | null {
  if (to < from) throw new Error('growthFromApy: to before from')
  if (points.length === 0 || from < points[0]!.time) return null
  let log = 0
  for (let i = 0; i < points.length; i++) {
    const start = Math.max(from, points[i]!.time)
    const next = points[i + 1]
    const end = Math.min(to, next ? next.time : Number.POSITIVE_INFINITY)
    if (end <= start) continue
    const apy = (next ?? points[i]!).apyPct / 100
    if (apy <= -1) throw new Error(`growthFromApy: APY ${apy * 100}% at ${points[i]!.time}`)
    log += Math.log1p(apy) * ((end - start) / YEAR)
  }
  return Math.exp(log)
}

/** Share price at `t`, geometric between the two readings around it. Null outside the series. */
export function priceAt(points: readonly PricePoint[], t: number): number | null {
  if (points.length === 0 || t < points[0]!.time || t > points.at(-1)!.time) return null
  let i = 0
  while (i + 1 < points.length && points[i + 1]!.time <= t) i++
  const a = points[i]!
  const b = points[i + 1]
  if (!b || a.time === t) return a.price
  const f = (t - a.time) / (b.time - a.time)
  return a.price * (b.price / a.price) ** f
}

/** Growth of the share price from `from` to `to`; null when either end is outside the series. */
export function growthFromPrice(points: readonly PricePoint[], from: number, to: number): number | null {
  const a = priceAt(points, from)
  const b = priceAt(points, to)
  return a === null || b === null ? null : b / a
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
  /** End value net of both operations' gas; holding USDC ends at `deposit`. */
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

/** Days until the interest of `deposit` at `apyPct` pays `gas` (both operations); Infinity when it never does. */
export function breakEvenDays(deposit: number, apyPct: number, gas: number): number {
  if (gas <= 0) return 0
  if (apyPct <= 0) return Number.POSITIVE_INFINITY
  return (Math.log1p(gas / deposit) / Math.log1p(apyPct / 100)) * 365
}

/** Smallest deposit whose interest over `days` at `apyPct` pays `gas`. */
export function breakEvenDeposit(days: number, apyPct: number, gas: number): number {
  if (days <= 0 || apyPct <= 0) return Number.POSITIVE_INFINITY
  return gas / ((1 + apyPct / 100) ** (days / 365) - 1)
}
