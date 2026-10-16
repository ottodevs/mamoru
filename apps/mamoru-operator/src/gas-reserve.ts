type Env = Record<string, string | undefined>

/**
 * otto/mamoru#8: the relayer funds a Safe's gas reserve once, at activation (otto/mamoru#82's top-up, subsidy.ts:
 * `policy.gasReserveWei + TOP_UP_MARGIN_WEI`, about 0.0005 ETH live). Every engine rebalance and fee collection
 * since then spends from that same balance — operator.ts's own comment on `TOP_UP_MARGIN_WEI` says why: "the first
 * userOp prefund leaves the Safe's balance into its EntryPoint deposit" — and nothing ever tops it back up. Left
 * alone, an active account's native balance drifts down to the policy's own floor
 * (`ehgPreliminary`'s `ACCT_GAS_RESERVE_LOW`, `packages/decide/src/gates/index.ts`), at which point the engine
 * stops reviewing it at all: no more rebalances, no more fee collection, with nothing in the journal louder than
 * one decision line saying so.
 *
 * This module only detects that drift and says so (alert, not top-up). An automatic refill spends relayer ETH on
 * real funds and must respect otto/mamoru#82's subsidy limits (per-Safe, per-passkey and daily caps) — that is a
 * follow-up gated on #82 landing first, not this ticket.
 */

/**
 * Wei below which a Safe's reserve is treated as low, when `MAMORU_GAS_RESERVE_ALERT_WEI` is not set: the same
 * target the relayer funds at activation (`gasReserveWei` + the top-up margin). The margin alone is sized in
 * operator.ts for one userOp's worst-case prefund, so a Safe under the *full* funded target has already spent
 * through that one-operation headroom and is one more engine action away from `ACCT_GAS_RESERVE_LOW`, which
 * freezes it. Alerting at the funded target rather than at the hard floor itself gives an operator a lead window
 * instead of finding out only once the account is already stuck.
 */
export function defaultGasReserveAlertWei(gasReserveWei: bigint, topUpMarginWei: bigint): bigint {
  return gasReserveWei + topUpMarginWei
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
export function gasReserveAlertWei(gasReserveWei: bigint, topUpMarginWei: bigint, override: bigint | null): bigint {
  return override ?? defaultGasReserveAlertWei(gasReserveWei, topUpMarginWei)
}
