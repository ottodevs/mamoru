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
   * engine settings at least once (per-account activation/renewal into conservadorLiveV4, the usage-triggered
   * renewal signal for the policy's own budgets). It does NOT gate the one earlier, process-wide decision —
   * `apps/mamoru-operator/src/boot.ts`'s `resolveNamedPolicy`, which picks the policy an account named BEFORE any
   * settings pull exists — that one reads `MAMORU_ONCHAIN_POLICY_V4`/`MAMORU_ACTION_POLICY_ADDRESS` from the
   * environment instead, for exactly that timing reason (see its own doc comment).
   */
  onchain_action_policy_v4: {
    label: 'On-chain action policy (v4)',
    description: 'Per-account activation into conservadorLiveV4 and its usage-triggered renewal signal (otto/mamoru#151, T7). The deployed MamoruActionPolicy address is a setting, never hardcoded.',
  },
} as const

export type OpsFlagName = keyof typeof OPS_FLAGS
