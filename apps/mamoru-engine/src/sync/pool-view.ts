import type { Figure, PoolLiquidityView, PoolRef, PoolSwapView, PoolView, Provenance, ReasonCode } from '@mamoru/domain'
import type { LiquidityEvent, PoolEvent, SwapEvent } from './logs.ts'
import { feeOn, pricePerWhole, valueAt, type Rate } from './math.ts'
import type { PoolState } from './pool-state.ts'
import { estimateAt, fig, notObserved, rpcAt, type Anchor } from './provenance.ts'

export const RECENT_ROWS = 10

export type TokenInfo = { symbol: string; decimals: number }

/** A history row with the provenance its source gave it (dashboard.md §6.5). */
export type SourcedEvent = PoolEvent & { provenance: Provenance }

export type PoolHistory = {
  events: SourcedEvent[]
  /** Provenance of figures computed from the whole window. */
  window: Provenance
  /** ISO time of each block that carries a displayed row. */
  blockTimes: ReadonlyMap<number, string>
}

export type PoolViewInput = {
  ref: PoolRef
  token0: TokenInfo
  token1: TokenInfo
  anchor: Anchor
  /** null when the registry code hash check failed; every figure is then not observed. */
  state: PoolState | null
  identityCode?: ReasonCode
  history: PoolHistory | null
  historyCode?: ReasonCode
  window: { fromBlock: number; toBlock: number }
  /** USDC base units per base unit of each token, when known. */
  rates: ReadonlyMap<string, Rate>
  maxTwapDeviationTicks?: number
}

const QUOTE = 'USDC'

function amountFig(value: bigint, unit: string, provenance: Provenance): Figure<string> {
  return fig(value.toString(), provenance, unit)
}

/** Value in USDC of token amounts, or not observed when an amount or a rate is missing. */
function valueFig(input: PoolViewInput, parts: [string, bigint | null][], code?: ReasonCode): Figure<string> {
  let total = 0n
  for (const [symbol, amount] of parts) {
    const rate = input.rates.get(symbol)
    if (amount === null || !rate) return notObserved(input.anchor, code, QUOTE, 'estimate')
    total += valueAt(amount, rate)
  }
  return fig(total.toString(), estimateAt(input.anchor), QUOTE)
}

/** Price of the non-USDC token in USDC base units per whole token. */
function priceFig(input: PoolViewInput): Figure<string> {
  const { state, anchor, token0, token1 } = input
  const priced = token0.symbol === QUOTE ? token1 : token0
  const rate = input.rates.get(priced.symbol)
  if (!state || state.sqrtPriceX96 === null || !rate) return notObserved(anchor, input.identityCode, QUOTE)
  return fig(pricePerWhole(rate, priced.decimals).toString(), rpcAt(anchor), QUOTE)
}

function swapRow(e: SwapEvent & { provenance: Provenance }, input: PoolViewInput, at: string): PoolSwapView {
  return {
    block: e.block, blockHash: e.blockHash, txHash: e.txHash, logIndex: e.logIndex, at, provenance: e.provenance,
    amount0: amountFig(e.amount0, input.token0.symbol, e.provenance),
    amount1: amountFig(e.amount1, input.token1.symbol, e.provenance),
    tick: e.tick,
  }
}

function liquidityRow(e: LiquidityEvent & { provenance: Provenance }, input: PoolViewInput, at: string): PoolLiquidityView {
  return {
    block: e.block, blockHash: e.blockHash, txHash: e.txHash, logIndex: e.logIndex, at, provenance: e.provenance,
    kind: e.kind,
    amount0: amountFig(e.amount0, input.token0.symbol, e.provenance),
    amount1: amountFig(e.amount1, input.token1.symbol, e.provenance),
    tickLower: e.tickLower, tickUpper: e.tickUpper,
  }
}

const isSwap = (e: SourcedEvent): e is SwapEvent & { provenance: Provenance } => e.kind === 'swap'
// A Burn of zero liquidity only pokes fees; it is not a liquidity change.
const isLiquidity = (e: SourcedEvent): e is LiquidityEvent & { provenance: Provenance } => e.kind !== 'swap' && e.amount > 0n

function stats(input: PoolViewInput): PoolView['stats'] {
  const { anchor, token0, token1, history, ref } = input
  const u0 = token0.symbol
  const u1 = token1.symbol
  if (!history) {
    const code = input.historyCode ?? input.identityCode
    const nNum = () => notObserved<number>(anchor, code)
    const nStr = (unit: string) => notObserved<string>(anchor, code, unit)
    return {
      swaps: nNum(), volume0: nStr(u0), volume1: nStr(u1), volumeValue: nStr(QUOTE),
      fees0: nStr(u0), fees1: nStr(u1), feesValue: nStr(QUOTE), tickMin: nNum(), tickMax: nNum(),
      added: { count: nNum(), amount0: nStr(u0), amount1: nStr(u1) },
      removed: { count: nNum(), amount0: nStr(u0), amount1: nStr(u1) },
    }
  }
  const w = history.window
  const swaps = history.events.filter(isSwap)
  const liq = history.events.filter(isLiquidity)
  let vol0 = 0n
  let vol1 = 0n
  let tickMin: number | null = null
  let tickMax: number | null = null
  for (const s of swaps) {
    if (s.amount0 > 0n) vol0 += s.amount0
    if (s.amount1 > 0n) vol1 += s.amount1
    tickMin = tickMin === null ? s.tick : Math.min(tickMin, s.tick)
    tickMax = tickMax === null ? s.tick : Math.max(tickMax, s.tick)
  }
  const fees0 = feeOn(vol0, ref.fee)
  const fees1 = feeOn(vol1, ref.fee)
  const sum = (kind: 'mint' | 'burn') => {
    const rows = liq.filter((e) => e.kind === kind)
    return {
      count: fig(rows.length, w),
      amount0: amountFig(rows.reduce((a, e) => a + e.amount0, 0n), u0, w),
      amount1: amountFig(rows.reduce((a, e) => a + e.amount1, 0n), u1, w),
    }
  }
  const est = estimateAt(anchor)
  return {
    swaps: fig(swaps.length, w),
    volume0: amountFig(vol0, u0, w),
    volume1: amountFig(vol1, u1, w),
    volumeValue: valueFig(input, [[u0, vol0], [u1, vol1]]),
    fees0: amountFig(fees0, u0, est),
    fees1: amountFig(fees1, u1, est),
    feesValue: valueFig(input, [[u0, fees0], [u1, fees1]]),
    tickMin: tickMin === null ? notObserved(anchor) : fig(tickMin, w),
    tickMax: tickMax === null ? notObserved(anchor) : fig(tickMax, w),
    added: sum('mint'),
    removed: sum('burn'),
  }
}

/** PoolView of dashboard.md §7.6.2 from the state at `H` and the window history. Pure. */
export function buildPoolView(input: PoolViewInput): PoolView {
  const { anchor, state, token0, token1, history } = input
  const code = input.identityCode
  const at = rpcAt(anchor)
  const u0 = token0.symbol
  const u1 = token1.symbol

  const tick: Figure<number> = state && state.tick !== null ? fig(state.tick, at) : notObserved(anchor, code)
  const twap: Figure<number> =
    state && state.twapTick !== null ? fig(state.twapTick, at) : notObserved(anchor, code ?? state?.twapCode ?? 'EHG_TWAP_UNAVAILABLE')
  let guard: Figure<'ok' | 'above_guard'>
  if (state && state.tick !== null && state.twapTick !== null && input.maxTwapDeviationTicks !== undefined) {
    guard = fig(Math.abs(state.tick - state.twapTick) <= input.maxTwapDeviationTicks ? 'ok' : 'above_guard', at)
  } else {
    guard = notObserved(anchor, code ?? 'EHG_TWAP_UNAVAILABLE')
  }

  const bal0 = state?.balance0 ?? null
  const bal1 = state?.balance1 ?? null
  const timeOf = (block: number) => {
    const t = history?.blockTimes.get(block)
    if (t === undefined) throw new Error(`block time missing for ${block}`)
    return t
  }
  const newestFirst = [...(history?.events ?? [])].reverse()

  return {
    pool: input.ref,
    block: anchor.blockNumber,
    price: priceFig(input),
    tick,
    twapTick: twap,
    twapGuard: guard,
    liquidity: state && state.liquidity !== null ? fig(state.liquidity.toString(), at) : notObserved(anchor, code),
    balances: {
      amount0: bal0 === null ? notObserved(anchor, code, u0) : amountFig(bal0, u0, at),
      amount1: bal1 === null ? notObserved(anchor, code, u1) : amountFig(bal1, u1, at),
      value: valueFig(input, [[u0, bal0], [u1, bal1]], code),
    },
    window: input.window,
    stats: stats(input),
    recentSwaps: newestFirst.filter(isSwap).slice(0, RECENT_ROWS).map((e) => swapRow(e, input, timeOf(e.block))),
    recentLiquidity: newestFirst.filter(isLiquidity).slice(0, RECENT_ROWS).map((e) => liquidityRow(e, input, timeOf(e.block))),
    accountPositions: [],
  }
}

/** Blocks whose time the recent rows need. */
export function displayedBlocks(events: PoolEvent[]): number[] {
  const newest = [...events].reverse()
  const rows = [
    ...newest.filter((e) => e.kind === 'swap').slice(0, RECENT_ROWS),
    ...newest.filter((e) => e.kind !== 'swap' && e.amount > 0n).slice(0, RECENT_ROWS),
  ]
  return [...new Set(rows.map((e) => e.block))]
}
