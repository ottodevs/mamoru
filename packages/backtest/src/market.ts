// What the market did in a dataset, read from the pools' ticks: the label of a Lab window, not a policy result.
import { entry, type RegistryName } from '@mamoru/registry'
import type { Dataset } from './types.ts'

export type AssetMove = {
  /** Last price over first, minus one. */
  move: number
  /** Largest fall from a running high, as a fraction of the high. */
  maxDrawdown: number
  /** Worst fall from a high of the previous 24 hours (negative). */
  worstDay: number
  /** Realized volatility over the window, annualized from sample-to-sample log returns. */
  vol: number
}

export type MarketSummary = { days: number; btc: AssetMove | null; eth: AssetMove | null; usdtMaxOffPegBps: number | null }

const LN_TICK = Math.log(1.0001)
const YEAR = 365 * 86_400
const DAY = 86_400

/** Log price of `token` in the pool's other token at each sample, up to a constant; null where the pool was not read. */
function logPrices(ds: Dataset, pool: RegistryName, token: RegistryName): { time: number[]; lp: number[] } | null {
  const k = ds.pools.indexOf(pool)
  if (k < 0) return null
  const e = entry(pool)
  // tick = log_1.0001(token1 per token0): the price of token0 rises with the tick, the price of token1 falls.
  const sign = e.token0 === token ? 1 : -1
  const time: number[] = []
  const lp: number[] = []
  for (const s of ds.samples) {
    const p = s.pools[k]
    if (!p) continue
    time.push(s.time)
    lp.push(sign * p.tick * LN_TICK)
  }
  return lp.length < 2 ? null : { time, lp }
}

/** Move, drawdown, worst day and annualized volatility of a log-price series. Exported for tests. */
export function moveOf(time: number[], lp: number[]): AssetMove {
  let peak = lp[0]!
  let maxDd = 0
  let worstDay = 0
  // Indexes of the last 24 hours that no later sample in the window exceeds: the front is the window's high.
  const highs = [0]
  let head = 0
  let sum = 0
  let sum2 = 0
  for (let i = 1; i < lp.length; i++) {
    const r = lp[i]! - lp[i - 1]!
    sum += r
    sum2 += r * r
    peak = Math.max(peak, lp[i]!)
    maxDd = Math.max(maxDd, 1 - Math.exp(lp[i]! - peak))
    while (head < highs.length && time[i]! - time[highs[head]!]! > DAY) head++
    if (head < highs.length) worstDay = Math.min(worstDay, Math.exp(lp[i]! - lp[highs[head]!]!) - 1)
    while (highs.length > head && lp[highs.at(-1)!]! <= lp[i]!) highs.pop()
    highs.push(i)
  }
  const n = lp.length - 1
  const mean = sum / n
  const variance = n > 1 ? (sum2 - n * mean * mean) / (n - 1) : 0
  const dt = (time.at(-1)! - time[0]!) / n
  return { move: Math.exp(lp.at(-1)! - lp[0]!) - 1, maxDrawdown: maxDd, worstDay, vol: Math.sqrt(Math.max(0, variance) * (YEAR / dt)) }
}

export function marketOfDataset(ds: Dataset): MarketSummary {
  const days = ds.samples.length < 2 ? 0 : (ds.samples.at(-1)!.time - ds.samples[0]!.time) / DAY
  const one = (pool: RegistryName, token: RegistryName) => {
    const s = logPrices(ds, pool, token)
    return s && moveOf(s.time, s.lp)
  }
  const usdt = logPrices(ds, 'pool:USDC/USDT/100', 'USDT')
  return {
    days,
    btc: one('pool:USDC/cbBTC/500', 'cbBTC'),
    eth: one('pool:WETH/USDC/3000', 'WETH'),
    // Both tokens have 6 decimals, so the raw price is the price. The pool shows only the ratio, not which side moved.
    usdtMaxOffPegBps: usdt && usdt.lp.reduce((max, x) => Math.max(max, Math.abs(Math.exp(x) - 1) * 10_000), 0),
  }
}
