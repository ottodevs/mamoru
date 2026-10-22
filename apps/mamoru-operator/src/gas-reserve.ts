import { LAB_GAS_LIMITS, MAX_PRIORITY_FEE_PER_GAS } from '@mamoru/scenarios/driver/engine.ts'

type Env = Record<string, string | undefined>

/**
 * otto/mamoru#8: a Safe's gas reserve is funded once, at activation, to `policy.gasReserveWei + TOP_UP_MARGIN_WEI`
 * (about 0.0005 ETH live): by the Safe itself through the USDC -> ETH swap in its activation batch when it can
 * (otto/mamoru#15, self-reserve.ts; the swap's minimum out is exactly what the Safe lacks of that target), else by
 * operator.ts's activation top-up, charged to sponsorship.ts's activation budget. Either way the Safe starts at that
 * same target, so the threshold below applies unchanged. Every engine rebalance and fee collection
 * since then spends from that same balance and nothing ever tops it back up, so an active account's native
 * balance drifts down towards the policy's own floor (`ehgPreliminary`'s `ACCT_GAS_RESERVE_LOW`,
 * `packages/decide/src/gates/index.ts`), at which point the engine stops reviewing it entirely: no more
 * rebalances, no more fee collection, with nothing in the journal louder than one decision line saying so.
 *
 * This module only detects that drift and says so (alert, not top-up). An automatic refill spends relayer ETH on
 * real funds and must go through sponsorship.ts's limits (per-account counts and the daily relayer budget, as the
 * activation top-up does) so a drained account cannot be cycled into repeated payouts — a follow-up, not this ticket.
 */

/**
 * Base's documented minimum base fee (https://docs.base.org/specifications/transactions/network-fees): 5,000,000 wei.
 * At that floor the engine's own `engineGas` formula (`baseFee * 2n + MAX_PRIORITY_FEE_PER_GAS`,
 * `packages/scenarios/driver/engine.ts`) bids an 11,000,000 wei `maxFeePerGas`.
 */
export const BASE_MIN_BASE_FEE_WEI = 5_000_000n
export const MIN_ENGINE_MAX_FEE_PER_GAS = BASE_MIN_BASE_FEE_WEI * 2n + MAX_PRIORITY_FEE_PER_GAS

/** Gas units one engine userOp declares (verification + call + preVerification), 5,100,000: what its prefund is sized on. */
export const ONE_ACTION_GAS_UNITS = LAB_GAS_LIMITS.verificationGasLimit + LAB_GAS_LIMITS.callGasLimit + LAB_GAS_LIMITS.preVerificationGas

/**
 * Worst-case native wei one engine userOp can take from the Safe: its full ERC-4337 prefund (`gas units ×
 * maxFeePerGas`) when the Safe's EntryPoint deposit is empty. Priced at the fee the engine bid on this very review
 * (`Observation.gas.maxFeePerGas`, already read, no extra RPC call), never below what it would bid at Base's minimum
 * base fee: 56,100,000,000,000 wei at that minimum.
 */
export function onePrefundWei(maxFeePerGas: bigint, gasUnits: bigint = ONE_ACTION_GAS_UNITS): bigint {
  const fee = maxFeePerGas > MIN_ENGINE_MAX_FEE_PER_GAS ? maxFeePerGas : MIN_ENGINE_MAX_FEE_PER_GAS
  return gasUnits * fee
}

/**
 * Worst-case prefunds of runway the default threshold keeps above the hard floor (`policy.gasReserveWei`, where
 * `ehgPreliminary`'s `ACCT_GAS_RESERVE_LOW` refuses every action). One is the minimum for the alert to fire at
 * least one review before the gate refuses (a Safe observed at the threshold can lose one full prefund and still
 * sit on the floor, which the gate's strict `<` still passes); the second absorbs a base-fee rise between reviews.
 */
export const ALERT_RUNWAY_PREFUNDS = 2n

/**
 * Wei below which a Safe's reserve is treated as low, when `MAMORU_GAS_RESERVE_ALERT_WEI` is not set:
 * `policy.gasReserveWei` plus `ALERT_RUNWAY_PREFUNDS` worst-case prefunds at this review's fee.
 *
 * History (independent reviews on otto/mamoru#53): a first version used `gasReserveWei + TOP_UP_MARGIN_WEI`, the
 * Safe's whole funded target, so every account went low after one action and stayed low. A second version sized
 * the runway on an *assumed* 3,000,000 wei fee (three actions, 45.9e12 wei), below what the engine bids even at
 * Base's minimum base fee: one empty-deposit prefund (56.1e12 wei) could take a Safe from just above that
 * threshold to below the floor, so the alert would only fire once the gate already refused. Pricing on the
 * engine's own observed fee, floored at Base's minimum, closes that.
 *
 * Live policy at Base's minimum fee: `gasReserveWei` 300e12 + 2 × 56.1e12 = 412.2e12 wei, under the 500e12 wei
 * activation target. Activation's first userOp seeds the EntryPoint deposit (at most one prefund, leaving
 * ≥ 443.9e12), and later userOps draw on that deposit first (unused prefund is refunded into it, not to the Safe),
 * so a freshly activated account is not low. When base fees rise the threshold rises with them and may exceed
 * the funded target: that is a real signal (two empty-deposit prefunds at that fee would reach the floor).
 */
export function defaultGasReserveAlertWei(gasReserveWei: bigint, maxFeePerGas: bigint, gasUnits: bigint = ONE_ACTION_GAS_UNITS): bigint {
  return gasReserveWei + ALERT_RUNWAY_PREFUNDS * onePrefundWei(maxFeePerGas, gasUnits)
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

/** The alert threshold to apply to one account on one review: the env override if set, else the per-policy default at this review's fee. */
export function gasReserveAlertWei(gasReserveWei: bigint, override: bigint | null, maxFeePerGas: bigint, gasUnits: bigint = ONE_ACTION_GAS_UNITS): bigint {
  return override ?? defaultGasReserveAlertWei(gasReserveWei, maxFeePerGas, gasUnits)
}
