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
} as const

export type OpsFlagName = keyof typeof OPS_FLAGS
