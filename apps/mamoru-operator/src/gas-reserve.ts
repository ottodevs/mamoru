import { LAB_GAS_LIMITS, MAX_PRIORITY_FEE_PER_GAS } from '@mamoru/scenarios/driver/engine.ts'

type Env = Record<string, string | undefined>

/**
 * otto/mamoru#8: the relayer funds a Safe's gas reserve once, at activation (otto/mamoru#82's top-up, subsidy.ts:
 * `policy.gasReserveWei + TOP_UP_MARGIN_WEI`, about 0.0005 ETH live). Every engine rebalance and fee collection
 * since then spends from that same balance and nothing ever tops it back up, so an active account's native
 * balance drifts down towards the policy's own floor (`ehgPreliminary`'s `ACCT_GAS_RESERVE_LOW`,
 * `packages/decide/src/gates/index.ts`), at which point the engine stops reviewing it entirely: no more
 * rebalances, no more fee collection, with nothing in the journal louder than one decision line saying so.
 *
 * This module only detects that drift and says so (alert, not top-up). An automatic refill spends relayer ETH on
 * real funds and must respect otto/mamoru#82's subsidy limits (per-Safe, per-passkey and daily caps) — that is a
 * follow-up gated on #82 landing first, not this ticket.
 */

/**
 * Gas units one engine userOp is budgeted for (verification + call + preVerification): the same figure the
 * engine itself sums as `OP_GAS_UNITS` (`packages/scenarios/driver/engine.ts`, not exported under that name) and
 * prices a harvest's worth against (`opCostInSavings`, `packages/decide/src/value.ts`). It is a worst-case
 * *allowance*, not actual gas used — real usage on Base is normally a fraction of it, the same way
 * `ACTIVATION_GAS_WEI` in `operator.ts` is deliberately "on the high side on purpose".
 */
const ONE_ACTION_GAS_UNITS = LAB_GAS_LIMITS.verificationGasLimit + LAB_GAS_LIMITS.callGasLimit + LAB_GAS_LIMITS.preVerificationGas // 5,100,000

/**
 * A representative, *not* worst-case, `maxFeePerGas` for estimating one action's wei cost. The engine's own
 * live formula is `baseFee * 2n + MAX_PRIORITY_FEE_PER_GAS` (same file); this alert threshold is a static
 * default rather than something recomputed every block, so it assumes a base fee of the same small order as
 * the priority fee the engine already bids on Base (both near-zero in normal conditions) instead of reading
 * the live one or assuming a congestion spike. A congestion spike is already budgeted for separately, once,
 * by `TOP_UP_MARGIN_WEI` in `operator.ts` — see `defaultGasReserveAlertWei` for why that figure must not be
 * reused here as a per-action cost.
 */
const ASSUMED_MAX_FEE_PER_GAS = 3n * MAX_PRIORITY_FEE_PER_GAS // baseFee(≈ the priority bid) * 2 + the priority bid

/** Estimated wei cost of one engine action (rebalance or fee collection), same shape as `opCostInSavings`: ~0.0000153 ETH. */
export const ONE_ACTION_WEI = ONE_ACTION_GAS_UNITS * ASSUMED_MAX_FEE_PER_GAS

/**
 * Actions of runway the default alert threshold leaves above the hard floor (`policy.gasReserveWei`, where
 * `ehgPreliminary`'s `ACCT_GAS_RESERVE_LOW` freezes the engine) once it fires. Small on purpose: the point is
 * an operator notices and can act before the account is actually stuck, not a page sent a dozen actions early.
 */
export const ALERT_RUNWAY_ACTIONS = 3n

/**
 * Wei below which a Safe's reserve is treated as low, when `MAMORU_GAS_RESERVE_ALERT_WEI` is not set:
 * `policy.gasReserveWei` (the hard floor) plus `ALERT_RUNWAY_ACTIONS` actions' worth of `ONE_ACTION_WEI`.
 *
 * A first version of this threshold used `gasReserveWei + TOP_UP_MARGIN_WEI` — the Safe's *original* funded
 * target (independent review on otto/mamoru#8, NO-GO: the margin equalled the Safe's entire funded balance, so
 * every account that ran even one action went low immediately and stayed low forever, making the alert
 * meaningless). The mistake was conflating two different things: `TOP_UP_MARGIN_WEI` in `operator.ts` is sized
 * for the *first* userOp's worst-case prefund specifically — the one-time cost of seeding the account's
 * EntryPoint deposit at activation — not an ongoing per-action cost, so it is not a fit margin for "N actions
 * of runway". `ONE_ACTION_WEI` is sized instead, and is far smaller.
 *
 * With the live policy's numbers (`gasReserveWei` 300_000_000_000_000 wei, activation target
 * 500_000_000_000_000 wei, `ONE_ACTION_WEI` 15_300_000_000_000 wei): the default threshold is
 * 345_900_000_000_000 wei. A freshly activated account can run roughly ten ordinary actions (consuming the
 * 200_000_000_000_000 wei of margin activation funded above the floor) before ever crossing it, and then
 * `ALERT_RUNWAY_ACTIONS` (3) more before it would actually reach the hard floor and freeze — by construction,
 * since the threshold is exactly that many actions above the floor.
 */
export function defaultGasReserveAlertWei(gasReserveWei: bigint): bigint {
  return gasReserveWei + ALERT_RUNWAY_ACTIONS * ONE_ACTION_WEI
}

/** `MAMORU_GAS_RESERVE_ALERT_WEI`: an absolute wei override for every account's alert threshold, read once at boot. A missing, non-numeric or negative value falls back to the per-policy default above (never throws, like the other MAMORU_* parsers in this app). */
export function gasReserveAlertOverrideFromEnv(env: Env = process.env): bigint | null {
  const raw = env.MAMORU_GAS_RESERVE_ALERT_WEI?.trim()
  if (!raw || !/^\d+$/.test(raw)) return null
  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

/** The alert threshold to apply to one account: the env override if set, else the per-policy default. */
export function gasReserveAlertWei(gasReserveWei: bigint, override: bigint | null): bigint {
  return override ?? defaultGasReserveAlertWei(gasReserveWei)
}
