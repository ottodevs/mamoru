import { SUBSIDY_MIN_USDC } from './subsidy.ts'

/**
 * The gas reserve a Safe needs to start (policy gasReserveWei + TOP_UP_MARGIN_WEI, 0.0005 ETH on the live policies)
 * is bought by the Safe itself, inside the activation the owner signs (otto/mamoru#15): a small USDC -> ETH swap,
 * paid to the Safe, after the grants are enabled. The relayer then only pays the deploy and the execTransaction gas,
 * which are spent on chain and leave the owner nothing to take away. The relayer's subsidy (subsidy.ts, #82) stays
 * for the starts that cannot buy their own reserve in the batch: an approval signed before any USDC arrived, an
 * account under SELF_RESERVE_MIN_USDC, no quote, or a reserve that would cost more than SELF_RESERVE_MAX_USDC.
 *
 * The minimum out is the reserve the Safe lacks: the swap either fills it or reverts, and the activation with it,
 * before the relayer sends anything (the preflight simulates the whole execTransaction). The USDC in is sized from a
 * QuoterV2 price with SELF_RESERVE_HEADROOM_BPS on top, so the price can move that far between the prepare and the
 * execution without failing the start. What the owner can lose to price or MEV is bounded by that headroom and by
 * SELF_RESERVE_MAX_USDC; any ETH above the minimum stays in the Safe as theirs.
 * TODO(otto/mamoru#140): size from the pool TWAP floor (PR #46/#64) instead of the QuoterV2 spot once it is on main.
 */

/** USDC (base units) the Safe must hold for the activation to buy its own reserve; smaller accounts keep #82's path. */
export const SELF_RESERVE_MIN_USDC = SUBSIDY_MIN_USDC
/** The most USDC one activation converts (3 USDC: 0.0005 ETH up to ~5,400 USD/ETH with the headroom). */
export const SELF_RESERVE_MAX_USDC = 3_000_000n
/** On top of the quoted price: the price may move this far before the activation would revert. */
export const SELF_RESERVE_HEADROOM_BPS = 1_000n
/** USDC the price is probed with: one dollar, far from the pools' depth, so its rate scales linearly to ~1.5. */
export const SELF_RESERVE_PROBE_USDC = 1_000_000n
/** How long the signed swap stays valid: as long as an approval may sensibly wait armed for the relayer. */
export const SELF_RESERVE_DEADLINE_SECONDS = 7n * 86_400n
/** USDC is converted in whole cents, so the amount the owner reads is the amount that is swapped. */
const CENT = 10_000n

export type SelfReserveSkip = 'FUNDED' | 'NO_DEPOSIT' | 'BELOW_MINIMUM' | 'NO_QUOTE' | 'OVER_MAX' | 'QUOTE_SHORT'
export type SelfReservePlan = { amountIn: bigint; minOut: bigint } | { skip: SelfReserveSkip }

/**
 * USDC in for `need` wei at the probed rate (`probeOut` wei for `probeIn` USDC), plus the headroom, rounded up to a
 * cent; null when there is no rate.
 */
export function selfReserveAmountIn(need: bigint, probeIn: bigint, probeOut: bigint): bigint | null {
  if (need <= 0n || probeIn <= 0n || probeOut <= 0n) return null
  const den = probeOut * 10_000n
  const raw = (need * probeIn * (10_000n + SELF_RESERVE_HEADROOM_BPS) + den - 1n) / den
  return ((raw + CENT - 1n) / CENT) * CENT
}

/**
 * Whether this activation buys its own reserve, and with what. `probeOut` is the quote for SELF_RESERVE_PROBE_USDC
 * (null: no quote). Pure; the exact amount is quoted again by the caller (selfReserveConfirmed).
 */
export function selfReservePlan(i: { usdc: bigint; eth: bigint; target: bigint; probeOut: bigint | null }): SelfReservePlan {
  const need = i.eth >= i.target ? 0n : i.target - i.eth
  if (need === 0n) return { skip: 'FUNDED' }
  if (i.usdc === 0n) return { skip: 'NO_DEPOSIT' }
  if (i.usdc < SELF_RESERVE_MIN_USDC) return { skip: 'BELOW_MINIMUM' }
  const amountIn = i.probeOut === null ? null : selfReserveAmountIn(need, SELF_RESERVE_PROBE_USDC, i.probeOut)
  if (amountIn === null) return { skip: 'NO_QUOTE' }
  if (amountIn > SELF_RESERVE_MAX_USDC) return { skip: 'OVER_MAX' }
  return { amountIn, minOut: need }
}

/** The quote for exactly `amountIn` must clear the minimum with room (half the headroom), or the plan is dropped. */
export function selfReserveConfirmed(minOut: bigint, quoted: bigint): boolean {
  return quoted * 10_000n >= minOut * (10_000n + SELF_RESERVE_HEADROOM_BPS / 2n)
}
