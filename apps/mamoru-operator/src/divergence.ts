// otto/mamoru#155: a withdrawal whose swap prices below the pool's 30-minute TWAP is never refused. Prepare answers
// with a PriceDivergenceWarning (per leg: the TWAP-fair amount, the quote, the router minimum baked into the calldata
// the owner signs, the shortfall) and a fresh quoteId; submit runs only with that quoteId accepted, and answers
// PRICE_DIVERGENCE_STALE when the live quote has fallen under an accepted minimum. Without a divergence nothing here
// changes the plan: the router minimum stays the usual one on the quote.
import { randomBytes } from 'node:crypto'
import type { PriceDivergenceLeg, PriceDivergenceWarning } from '@mamoru/domain'
import { diverges, twapFloor } from '@mamoru/uniswap-v3/twap'

export type SwapJudgement = {
  amountIn: bigint
  fee: number
  tokenInIsToken0: boolean
  twapTick: number
  /** The pool's slot0 tick at the prepare block, when read. */
  spotTick?: number
  /** QuoterV2 at the prepare block. */
  quote: bigint
  /** The router minimum the batch carries (the usual one on the quote). */
  minimum: bigint
  maxTwapDeviationTicks: number
  slippageBps: number
}

/**
 * What `amountIn` buys at the TWAP tick after the pool fee (no deviation, no slippage), and whether the swap diverges:
 * spot more than `maxTwapDeviationTicks` from the TWAP, or the quote under the TWAP floor (otto/mamoru#140's
 * twapFloor). A divergence whose minimum is not below the fair amount costs the owner nothing and is not one.
 */
export function judgeSwap(j: SwapJudgement): { fair: bigint; divergent: boolean } {
  const base = { amountIn: j.amountIn, fee: j.fee, twapTick: j.twapTick, tokenInIsToken0: j.tokenInIsToken0 }
  const fair = twapFloor({ ...base, deviationTicks: 0, slippageBps: 0 })
  const floor = twapFloor({ ...base, deviationTicks: j.maxTwapDeviationTicks, slippageBps: j.slippageBps })
  const moved = j.quote < floor || (j.spotTick !== undefined && diverges(j.spotTick, j.twapTick, j.maxTwapDeviationTicks))
  return { fair, divergent: moved && j.minimum < fair }
}

/** One leg of the warning. `minimum` < `fair` (judgeSwap); shortfall and bps are against the minimum, bps ceiled. */
export function divergenceLeg(l: { kind: PriceDivergenceLeg['kind']; token: string; sellToken?: string; decimals: number; fair: bigint; quote: bigint; minimum: bigint }): PriceDivergenceLeg {
  const shortfall = l.fair > l.minimum ? l.fair - l.minimum : 0n
  const bps = l.fair > 0n ? Number((shortfall * 10_000n + l.fair - 1n) / l.fair) : 0
  return {
    kind: l.kind,
    token: l.token,
    ...(l.sellToken ? { sellToken: l.sellToken } : {}),
    decimals: l.decimals,
    fairAmount: l.fair.toString(),
    quotedAmount: l.quote.toString(),
    minAmount: l.minimum.toString(),
    shortfall: shortfall.toString(),
    shortfallBps: bps,
  }
}

/**
 * The warning over every diverging leg, or undefined when there is none. A swap-back leg's output is USDC; a payout
 * leg's shortfall is converted at the USDC it spends (`usdcIn`) over its fair amount, rounded up. A fresh quoteId
 * every time, never derived from the numbers.
 */
export function divergenceWarning(legs: { leg: PriceDivergenceLeg; usdcIn?: bigint }[]): PriceDivergenceWarning | undefined {
  if (!legs.length) return undefined
  let total = 0n
  for (const { leg, usdcIn } of legs) {
    const s = BigInt(leg.shortfall)
    if (leg.kind === 'swap-back') total += s
    else {
      const fair = BigInt(leg.fairAmount)
      total += fair > 0n && usdcIn !== undefined ? (s * usdcIn + fair - 1n) / fair : 0n
    }
  }
  return { code: 'PRICE_DIVERGENCE', legs: legs.map((x) => x.leg), shortfallUsdc: total.toString(), quoteId: randomBytes(16).toString('hex') }
}

/** What submit re-quotes for one accepted leg: the same swap, and the minimum the owner accepted for it. */
export type AcceptedSwap = { pool: string; tokenIn: string; tokenOut: string; fee: number; amountIn: bigint; minimum: bigint }

/**
 * Submit, a prepare that carried a warning: the owner accepted exactly this warning's quote. Anything else (no
 * acceptance, a malformed one, the quoteId of another prepare or another account) is not an acceptance.
 */
export function accepts(warning: PriceDivergenceWarning, accepted: unknown): boolean {
  const quoteId = accepted && typeof accepted === 'object' ? (accepted as { quoteId?: unknown }).quoteId : undefined
  return typeof quoteId === 'string' && quoteId === warning.quoteId
}

/**
 * An accepted warning the price has moved past: a live quote under its accepted minimum. A quote that could not be
 * read (null) does not make it stale: the accepted minimum is in the signed calldata, so the swap cannot run below it.
 */
export function staleAcceptance(swaps: readonly AcceptedSwap[], liveQuotes: readonly (bigint | null)[]): boolean {
  return swaps.some((s, i) => {
    const q = liveQuotes[i]
    return q !== null && q !== undefined && q < s.minimum
  })
}
