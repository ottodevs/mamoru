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
   * and Home shows it next to the Base one. Honored on app.mamoru.lol and beta.mamoru.lol alike (prod and beta share this
   * D1 and its flags), never on any other host (apps/mamoru-app/src/api/sleeves.ts). Not scopable: on means every owner.
   */
  monad_sleeves: {
    label: 'Monad sleeves',
    description: 'Owners on app.mamoru.lol and beta.mamoru.lol can have a Monad (143) sleeve, deposit USDC there and see its WMON/USDC positions (otto/mamoru#67). On means every owner, prod and beta.',
  },
  /**
   * otto/mamoru#214, default off: offers running v2/v3/v4/v5 accounts on Base the renewal that moves them to
   * conservadorLiveV6 (stables 50 / Balance 35 / BTC exit-only, growth 15 % on the owner's Monad sleeve). Only where
   * the operator has `MAMORU_PAUSE_GATE_ADDRESS` as well; takes precedence over `onchain_action_policy_v5` while on.
   * The renewal itself provisions the owner's Safe on Monad (otto/mamoru#251); the Worker shows that Safe as a sleeve only
   * while `monad_sleeves` is on, so turn both on together.
   */
  multichain_v6: {
    label: 'Multichain (v6: Base + Monad growth)',
    description: 'Offers running Base accounts the renewal that moves them to conservadorLiveV6: growth 15 % on the owner\'s Monad sleeve, bridge-out behind MamoruPauseGate (otto/mamoru#214). The renewal provisions the owner\'s Monad Safe; turn on monad_sleeves with it so the app shows it. Scopable to accounts.',
  },
  /**
   * otto/mamoru#231, default off, scoped like multichain_v6: a Start of an account in scope activates it directly on
   * conservadorLiveV6 (Base + its own Safe on Monad, one approval) instead of the operator's default policy. Only where
   * the operator offers v6 at all (MAMORU_PAUSE_GATE_ADDRESS, V3 pinned, a Monad peer). Not for everyone until the one
   * approval fits its gas (#259), the two-chain e2e reaches the Monad LP (#272) and the return leg exists (#278).
   */
  multichain_v6_new: {
    label: 'Multichain for new accounts (v6 on Start)',
    description: 'A Start activates the account directly on conservadorLiveV6 (Base + its own Safe on Monad, growth 15 %) instead of the default policy (otto/mamoru#231). Scope it to test accounts until #259, #272 and #278 are done.',
  },
  /**
   * otto/mamoru#293 (spec 010 A1, one authorization), default off, scoped like multichain_v6: an account in scope on a
   * v2-v6 policy is offered the move to MamoruActionPolicyV4 (the "What's new" screen: one owner Safe transaction on Base,
   * a second on Monad for a design-C remote Safe), and its renewals stop once it runs on V4. A1 has no registry, no admin
   * and no guardian: which pools and vaults V4 allows is fixed in code and in the immutable MamoruV4Table, deployed as T8
   * (otto/mamoru#348). Honoured only where the chain's registry file pins all four of MamoruActionPolicyV4,
   * MamoruGasPolicyV2, MamoruMigrationCheck and MamoruV4Table: with any of them unset the operator offers nobody V4,
   * whatever the flag says. Accounts already on V4 stay on it. Keep it scoped to a list of accounts, never everyone,
   * until per-account non-exportable session keys (spec 009 KEY-01) are done.
   */
  one_auth_v4: {
    label: 'One authorization (V4)',
    description: 'Offers accounts in scope the move to MamoruActionPolicyV4 (spec 010 A1, otto/mamoru#293): the owner signs once and has no more renewals; pools and vaults are fixed in code and in the immutable T8 contracts, with no registry and no admin. Inert until the four V4 contracts are pinned. Scope it to a list of accounts until KEY-01 (per-account session keys) is done.',
  },
  /**
   * otto/mamoru#210, default off: offers running Base accounts (v2-v6) the renewal that moves them to conservadorLiveV7: v6
   * with the Stable 50 % supplied to ERC-4626 vaults (Morpho gtUSDCp, then Aave waBasUSDC) on MamoruActionPolicyV3's
   * vault family. Scopable to accounts like `multichain_v6`; only where v6's contracts are configured. Takes precedence
   * over `multichain_v6` for an account in both scopes. Not in any default offer.
   */
  vaults_v7: {
    label: 'Stable in lending vaults (v7)',
    description: 'Offers running Base accounts the renewal that moves them to conservadorLiveV7: Stable 50 % in Morpho gtUSDCp / Aave waBasUSDC on MamoruActionPolicyV3, USDC/USDT exit only (otto/mamoru#210). Scopable to accounts.',
  },
  /**
   * otto/mamoru#210, default off: for a v7 account in scope, the engine winds down its old USDC/USDT positions (the
   * exit-only `stables-lp` bucket) in full; out of scope they are held as they are. Ot has not decided between an
   * automatic and an opt-in migration: until then it is opt-in, per account.
   */
  stables_lp_exit: {
    label: 'v7: wind down USDC/USDT (opt-in)',
    description: 'For v7 accounts in scope, the engine exits the old USDC/USDT positions in full and the USDC goes to the lending vaults; out of scope they stay as they are (otto/mamoru#210). Scopable to accounts.',
  },
  /**
   * otto/mamoru#371, default off: Mamoru keeps 10 % of the yield collected from 5 Nov 2026 on, paid to the operator's
   * relayer in the owner's next withdrawal, on its own line of the summary the owner signs (the engine cannot pay anyone
   * but the account). Scopable to accounts.
   */
  yield_fee: {
    label: 'Yield fee (10 % at withdrawal)',
    description: 'Withdrawals of accounts in scope pay Mamoru 10 % of the yield collected since 5 Nov 2026, to the relayer, shown in the approval (otto/mamoru#371). Scopable to accounts.',
  },
} as const

export type OpsFlagName = keyof typeof OPS_FLAGS
