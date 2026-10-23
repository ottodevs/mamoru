/**
 * Runtime flags set from /ops (mamoru-astro) and stored in D1 (migrations/d1/0012_ops_flags.sql), read by the app
 * Worker (apps/mamoru-app/src/api/ops-flags.ts's readOpsFlags) and carried to the operator in the engine settings
 * payload (otto/mamoru#129). Replaces the env-var gating the yield ledger used before (operator MAMORU_SNAPSHOT /
 * MAMORU_YIELD_LEDGER, app Worker YIELD_LEDGER): flipping a flag no longer needs a redeploy or an operator restart.
 * Names here are shared between the app and the operator; add a flag by adding one entry.
 */
export const OPS_FLAGS = {
  yield_ledger: {
    label: 'Yield ledger',
    description: 'The app Worker cron pulls the operator snapshot into D1, and the operator runs the yield-ledger entry baseline (otto/mamoru#129).',
  },
  /**
   * Spec 007 (otto/mamoru#151) T7, default off. Gates anything v4-related that runs AFTER the operator has pulled
   * engine settings at least once: the renew row's offer to move a running v2/v3 account to conservadorLiveV4
   * (`Operator.v4Target`, read on every view). Accounts already on v4 keep their renewals and their usage signal
   * whatever the flag says (turning it off never strands one half-moved). It does NOT gate the one earlier, process-wide decision —
   * `apps/mamoru-operator/src/boot.ts`'s `resolveNamedPolicy`, which picks the policy an account named BEFORE any
   * settings pull exists — that one reads `MAMORU_ONCHAIN_POLICY_V4`/`MAMORU_ACTION_POLICY_ADDRESS`/`MAMORU_GAS_POLICY_ADDRESS` from the
   * environment instead, for exactly that timing reason (see its own doc comment).
   */
  onchain_action_policy_v4: {
    label: 'On-chain action policy (v4)',
    description: 'Offers running v2/v3 accounts the renewal that moves them to conservadorLiveV4 (otto/mamoru#151, T7). The deployed MamoruActionPolicy and MamoruGasPolicy addresses are operator settings, never hardcoded.',
  },
  /**
   * otto/mamoru#151, default off: offers running v2/v3/v4 accounts the renewal that moves them to conservadorLiveV5, the
   * policy version for MamoruActionPolicyV2 (increase through the policy, the guardian pause, the swap deadline under
   * the policy). Only where the operator has `MAMORU_ACTION_POLICY_V2_ADDRESS` (V2 deployed); while it is on it takes
   * precedence over `onchain_action_policy_v4` for v2/v3 accounts. Accounts already on v5 keep their renewals whatever it says.
   */
  onchain_action_policy_v5: {
    label: 'On-chain action policy (v5, MamoruActionPolicyV2)',
    description: 'Offers running v2/v3/v4 accounts the renewal that moves them to conservadorLiveV5 on MamoruActionPolicyV2 (otto/mamoru#151, #171). The V2 address is an operator setting, never hardcoded.',
  },
  /**
   * otto/mamoru#67, default off: a signed-in owner can open a second sleeve of the same account on Monad (chain 143)
   * and Home shows it next to the Base one. Honored ONLY on beta.mamoru.lol: app.mamoru.lol reads it as off whatever
   * the row says (apps/mamoru-app/src/api/sleeves.ts), since prod and beta share this D1 and its flags.
   */
  monad_sleeves: {
    label: 'Monad sleeves (beta only)',
    description: 'Beta only: owners can add a Monad (143) sleeve, deposit USDC there and see its WMON/USDC positions (otto/mamoru#67). Prod ignores it.',
  },
} as const

export type OpsFlagName = keyof typeof OPS_FLAGS
