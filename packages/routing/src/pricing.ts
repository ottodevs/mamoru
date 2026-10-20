import { chainConfig, type NativeAsset } from './chains.ts'
import type { Quote } from './types.ts'

// otto/mamoru#181, review round 3. The selector used to rank quotes by raw `amountOut`, which understates the
// true cost of a route that also attaches a native-asset `value` (deBridge's order-creation fee; a future ETH
// bridge's own gas) — two quotes with the same amountOut are NOT equally good if one of them also drains the
// account's native balance on the source chain. This module converts that `value` into the same units as
// `amountOut` so the two can be subtracted, using a deliberately conservative (high) stated price: overstating
// the native asset's worth makes the selector MORE reluctant to prefer a value-charging route, which is the
// safe direction to be wrong in. These prices are for ranking only — never shown as a real quote, never used to
// compute amountOut/fee, and not a live feed (replace with a price oracle before relying on them for anything
// beyond internal comparison).
//
// Gas is NOT included: this package does not estimate or know the gas cost of any call it quotes, so "every
// cost in the source chain's native asset" here is `value` alone, the one native-asset cost this package
// actually has a number for.

/** Deliberately conservative (high), stated placeholders — see module comment. $5,000/ETH as of this writing;
 * no entry for MON (nothing this round establishes a trustworthy MON/USD price — see `valueCostInAsset`). */
const CONSERVATIVE_USDC6_PER_NATIVE_UNIT: Partial<Record<NativeAsset, bigint>> = {
  ETH: 5_000n * 1_000_000n, // $5,000.00 in USDC's 6-decimal base units, per whole ETH (1e18 wei)
}

const WEI_PER_NATIVE_UNIT = 1_000_000_000_000_000_000n

/**
 * The EXTRA native-asset cost a quote's `value` represents, beyond whatever principal it necessarily carries —
 * expressed in the same units as `quote.amountOut` — or `null` when there is no trustworthy way to do that
 * conversion (caller must treat the quote as having an UNKNOWN, not zero, native cost; see `netOutput`).
 *
 * `value` is NOT always pure cost: when the bridged asset IS the source chain's native asset (canonical.ts's
 * ETH bridge; a native-input deBridge order), the principal itself has to leave the account as `value` — there
 * is no ERC20 transfer to carry it instead. Treating the whole of `value` as cost in that case would double
 * count the principal as if it were being paid twice. The excess over `amountIn` (never negative) is the real
 * extra cost; `amountIn`, not `amountOut`, because `value` is what leaves the account on the SOURCE chain, which
 * is sized against what the account put in, not against what arrives (net of fees) on the other side.
 *
 * When the bridged asset is NOT the source chain's native asset (bridging USDC while the chain's gas asset is
 * ETH or MON), the principal moves as an ERC20 transfer instead, so the entire `value` is genuinely extra —
 * deBridge's USDC-input order-creation fee is the live example. That amount needs a price to compare against a
 * USDC-denominated `amountOut`; a chain whose native asset has no stated price (Monad/MON, this round) returns
 * `null` for a nonzero cost, never silently priced at zero.
 */
export function valueCostInAsset(quote: Quote): bigint | null {
  const value = quote.value ?? 0n
  const nativeAsset = chainConfig(quote.sourceChainId)?.nativeAsset
  if (nativeAsset === undefined) return value === 0n ? 0n : null
  const extra = quote.asset === nativeAsset ? (value > quote.amountIn ? value - quote.amountIn : 0n) : value
  if (extra === 0n) return 0n
  if (quote.asset === nativeAsset) return extra // already the same asset and units as amountOut
  if (quote.asset !== 'USDC') return null // only a USDC-denominated amountOut has a conversion target below
  const price = CONSERVATIVE_USDC6_PER_NATIVE_UNIT[nativeAsset]
  if (price === undefined) return null
  return (extra * price) / WEI_PER_NATIVE_UNIT
}

/**
 * `amountOut` minus the native-value cost, in the same units as `amountOut` — the number `selectBest`/`rank`
 * actually compare, per otto/mamoru#181's "rank by net value, not raw amountOut". Returns `null` instead of a
 * number when the native cost cannot be priced (see `valueCostInAsset`): the caller must never treat `null` as
 * zero cost. A quote with a known, zero cost and one with an unpriced nonzero cost are NOT comparable by
 * subtraction — the unpriced one is always worse, enforced by the selector's ordering, not by this function
 * inventing a number.
 */
export function netOutput(quote: Quote): bigint | null {
  const cost = valueCostInAsset(quote)
  if (cost === null) return null
  return quote.amountOut - cost
}
