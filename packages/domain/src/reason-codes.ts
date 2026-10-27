export const REASON_CODES = [
  // Observación
  'OBS_OK',
  'OBS_RPC_UNAVAILABLE',
  'OBS_CHAIN_MISMATCH',
  'OBS_BLOCK_INCONSISTENT',
  'OBS_DEPOSIT_DETECTED',
  'OBS_DEPOSIT_UNSAFE',
  'OBS_UNMANAGED_ASSET',
  'OBS_ETH_NOT_INVESTED',
  'OBS_EXTERNAL_CHANGE',
  'OBS_OWNER_ACTION',
  'OBS_POSITION_OUT_OF_RANGE',
  'OBS_FEES_ABOVE_COST',
  // Cuenta y fondos
  'ACCT_COUNTERFACTUAL',
  'ACCT_GAS_RESERVE_LOW',
  'ACCT_FUNDS_WHILE_CLOSED',
  'FUNDS_GATE_CLOSED',
  'DEPOSIT_OVER_CAP',
  // Sesión
  'SESSION_ACTIVE',
  'SESSION_MISSING',
  'SESSION_EXPIRED',
  // otto/mamoru#149: the grant has used every userOp its approval allows; a renewal restores them.
  'SESSION_USAGE_SPENT',
  'SESSION_REVOKED',
  'SESSION_RENEWAL_DUE',
  'SESSION_POSITION_OUT_OF_SCOPE',
  // otto/mamoru#140: the account already holds MAX_INVENTORY admitted positions; no further mint.
  'INVENTORY_FULL',
  'SESSION_FOREIGN_USE',
  'SESSION_PERMISSION_ID_REUSED',
  // Spec 007 (otto/mamoru#151) T7: a v4 grant (`requiresActionPolicy`) is only as strict as v2/v3 WITH
  // MamoruActionPolicy in the same session (its merged manage-any has no UniActionPolicy spender rule for the
  // volatile-token approve, and its cumulative caps follow T_p = 10 x Cp); `toSmartSession` refuses to encode one
  // without a real second policy, a programming error that must never reach the chain.
  'SESSION_ACTION_POLICY_MISSING',
  // T7 (GPT-6 review of #97, P1 3): the second policy, the gas policy or the Init is not the one the policy config
  // names (deployed address, the address the grant was retargeted to, the grant's pool and tokens).
  'SESSION_ACTION_POLICY_MISMATCH',
  // T7: basefee leaves no room under a v4 session's MamoruGasPolicy maxFeePerGas cap; the engine waits.
  'GAS_PRICE_OVER_CAP',
  // Pre-chequeo de política en el motor
  'POLICY_DENIED_TARGET',
  'POLICY_DENIED_RECIPIENT',
  'POLICY_DENIED_AMOUNT',
  'POLICY_DENIED_CUMULATIVE',
  'POLICY_DENIED_APPROVAL',
  'POLICY_DENIED_VALUE',
  'POLICY_DENIED_CALLTYPE',
  'POLICY_DENIED_POSITION',
  'POLICY_TARGET_NOT_IN_REGISTRY',
  // Spec 007 (otto/mamoru#151) T4: precheck's own mirror of MamoruActionPolicy.checkAction (a)-(c), so a call the
  // deployed policy would refuse at validation is refused here first, before the userOp is ever signed and sent.
  'POLICY_PRICE_BAND',
  'POLICY_NOT_ADMITTED',
  'POLICY_BUDGET',
  // otto/mamoru#151: MamoruActionPolicyV2's guardian paused the account; every session action is refused until it
  // unpauses or the owner renews. The engine waits; the owner's own path is not behind the policy.
  'POLICY_PAUSED',
  // Puertas
  'PURGA_OK',
  'PURGA_NOT_APPLICABLE',
  'PURGA_NOT_CURATED',
  'PURGA_IDENTITY_INCOMPLETE',
  'PURGA_IDENTITY_MISMATCH',
  'PURGA_INCIDENT',
  'PURGA_EVIDENCE_UNKNOWN',
  'RISK_OK',
  'RISK_INCIDENT_EXIT',
  'RISK_EVIDENCE_UNKNOWN',
  'RISK_TOKEN_PAUSED',
  'RISK_ACCOUNT_BLOCKLISTED',
  'RISK_SHADOW',
  'RISK_DATA_INSUFFICIENT',
  'EHG_OK',
  'EHG_QUOTE_UNAVAILABLE',
  'EHG_TWAP_UNAVAILABLE',
  'EHG_PRICE_DIVERGENCE',
  'EHG_SIM_REVERT',
  'EHG_SIM_DELTA_MISMATCH',
  'EHG_SIM_UNAVAILABLE',
  'EHG_OBSERVATION_STALE',
  'EHG_OBSERVATION_REORGED',
  'EHG_NO_GO_OVERRIDDEN_BY_EXIT',
  'EHG_SHADOW',
  'ENY_SHADOW',
  'STRATEGY_PREFERENCE',
  'STRATEGY_PREFERENCE_DEVIATION',
  // Decisión y salida
  'DECIDE_HOLD',
  'DECIDE_NO_CAPITAL',
  // otto/mamoru#127: the bucket's pool cannot take more without moving its price or making Mamoru too large a share of it; the rest waits as USDC.
  'DECIDE_WAIT_DEPTH',
  // otto/mamoru#195: the entry would be under k times what its swap and mint cost in gas; it waits as USDC until it grows.
  'DECIDE_WAIT_GAS',
  // otto/mamoru#215: savings for a bucket on another chain wait here: its sleeve is not ready yet, or a bridge is still in flight.
  'DECIDE_WAIT_BRIDGE',
  // otto/mamoru#215: savings go to the account's own sleeve on another chain (CCTP), for the bucket served there.
  'DECIDE_BRIDGE_OUT',
  // otto/mamoru#215: a bridge-out is never signed before it is in the operator's bridge journal (it would be in flight unseen).
  'BRIDGE_JOURNAL_UNAVAILABLE',
  // otto/mamoru#127: the quote of an entry swap is worse than the depth policy allows; refused before sending.
  'EHG_SWAP_IMPACT_OVER_LIMIT',
  'DECIDE_PAUSED',
  'DECIDE_SLOT_BUSY',
  'DECIDE_IN_RANGE',
  'DECIDE_HARVEST',
  'DECIDE_HARVEST_BELOW_COST',
  'DECIDE_ENTER',
  'DECIDE_RANGE_ADJUST',
  'DECIDE_RANGE_COOLDOWN',
  // otto/mamoru#218: the pool already had `range.maxPerWeek` re-ranges in the last 7 days.
  'DECIDE_RANGE_WEEKLY_CAP',
  // Lab (#101): a re-range that would cost more (gas, swap, LVR) than the fees it earns over the policy horizon waits.
  'DECIDE_RANGE_BELOW_COST',
  // otto/mamoru#172: live lazy re-range without the fee or volatility history the cost test needs: it holds (fail closed).
  'DECIDE_RANGE_NO_FEE_HISTORY',
  'DECIDE_ENTRY_PAUSED_FALL',
  // Lab (#101 round 3): the stables pool is off peg past the guard; nothing moves in it, or it is being left.
  'RISK_DEPEG_PAIRED',
  // Lab (#101 round 3): a volatile bucket gave up thirds of its weight on a fall from its 7-day high.
  'RISK_STAGED_EXIT',
  'DECIDE_EXIT',
  'DECIDE_CONVERT',
  'DECIDE_CONVERT_HELD',
  'PLAN_BUCKET_NO_EXECUTABLE_POOL',
  'EXIT_USER_EMERGENCY',
  'EXIT_RISK_INCIDENT',
  'EXIT_PENDING',
  'EXIT_COMPLETED',
  // Operación, envío y reconciliación
  'OP_SLOT_BUSY',
  'REVIEW_DEDUPED',
  'OP_PREEMPTED_BY_EXIT',
  'OP_OWNER_MISMATCH',
  'OP_DECISION_STALE',
  'OP_NONCE_MOVED',
  'OP_SIGNED',
  'OP_INCLUDED',
  'DRY_RUN_STOP',
  'SIGN_CHAIN_NOT_ALLOWED',
  'SIGN_STATE_INVALID',
  'BUNDLER_ACCEPTED',
  'BUNDLER_REJECTED',
  'BUNDLER_UNAVAILABLE',
  'EXEC_OK',
  'EXEC_INNER_REVERT',
  'RECON_SEND_UNKNOWN',
  'RECON_TIMEOUT',
  'RECON_RESENT_SAME_BYTES',
  'RECON_REPLACED_FEE',
  'RECON_REORGED',
  'RECON_UNINCLUDABLE',
  'RECON_NONCE_CONSUMED_BY_OTHER',
  'RECON_RECEIPT_MISMATCH',
  // Clasificación en cadena del runner
  'CHAIN_REJECTED_VALIDATION',
  'CHAIN_REVERTED_EXECUTION',
  // Webhook, proyección y MultiBaas
  'HOOK_ACCEPTED',
  'HOOK_BAD_SIGNATURE',
  'HOOK_STALE',
  'HOOK_DUPLICATE',
  'HOOK_UNMAPPED',
  'HOOK_REORGED',
  'HOOK_COALESCED',
  'PROJ_CONFIRMED',
  'PROJ_RECONCILED',
  'PROJ_INDEXER_PENDING',
  'PROJ_INDEXER_MISMATCH',
  'PROJ_REORGED',
  'PROJ_PRINCIPAL_EXCLUDED',
  'PROJ_SAVINGS_EXCEEDS_BALANCE',
  'PROJ_SOURCE_FALLBACK_RPC',
  'PROJ_FOREIGN_CHAIN_ROW',
  'PROJ_PROVENANCE_COMPLETE',
  'MB_BASE_INDEXING_OK',
  'MB_BASE_INDEXING_ABSENT',
  'MB_QUERY_MISMATCH',
  'MB_INDEX_LAGGING',
  'MB_QUERY_FAILED',
  'MB_BEFORE_START_BLOCK',
  // Login, vista, intenciones y configuración
  'AUTH_REQUIRED',
  'AUTH_ORIGIN_REJECTED',
  'GRANT_REQUIRED',
  'GRANT_INVALID_PROOF',
  'GRANT_EXPIRED',
  'INTENT_ACCEPTED',
  'INTENT_REJECTED_STATE',
  'ONB_RECOVERY_REQUIRED',
  'ONB_BACKUP_UNPROVEN',
  'ONB_ADDRESS_MATCH',
  'ONB_POLICY_HASH_MATCH',
  'CONFIG_DRY_RUN_REQUIRED',
  'CONFIG_MODE_INVALID',
  // Laboratorio
  'LAB_CHAIN_ID_FORBIDDEN',
  'LAB_BLOCK_REQUIRED',
  'LAB_BLOCK_HASH_MISMATCH',
  'LAB_ANVIL_VERSION_MISMATCH',
  'LAB_REGISTRY_CODE_MISMATCH',
  'LAB_KEY_IN_ARGV',
  'LAB_BUNDLER_NOT_LOCAL',
  'LAB_P256_UNAVAILABLE',
  'LAB_SIMULATE_UNAVAILABLE',
  'LAB_SNAPSHOT_FOREIGN',
  'LAB_REPRO_OK',
  'LAB_FAULT_INJECTED',
  // Chain, registro y configuración por chain (002)
  'CHAIN_UNSUPPORTED',
  'REGISTRY_CHAIN_MISMATCH',
  'REGISTRY_BLOCK_MISMATCH',
  'POLICY_CHAIN_MISMATCH',
  'POLICY_POOL_NOT_CURATED',
  'CONFIG_CHAIN_RPC_MISSING',
  'CONFIG_CHAIN_FINALITY_UNKNOWN',
  // Sesión por chain (002)
  'SESSION_POLICY_UNAVAILABLE_ON_CHAIN',
  'SESSION_ATTESTATION_UNAVAILABLE_ON_CHAIN',
  // Gas y relayer por chain (002)
  'AA_GAS_MARGIN_EXCEEDED',
  'GAS_ACCOUNTING_MISMATCH',
  'RELAYER_NATIVE_LOW',
  // Observación, MultiBaas y laboratorio por chain (002)
  'OBS_FUNDS_ON_UNOPENED_CHAIN',
  'MB_CHAIN_INDEXING_OK',
  'MB_CHAIN_INDEXING_ABSENT',
  'LAB_FORK_GAP_INCONCLUSIVE',
  'LAB_CODE_INJECTION_FORBIDDEN',
  // Agent Lab bench (008, otto/mamoru#199)
  'LAB_SPEC_INVALID',
  'LAB_HOLDOUT_DENIED',
  'LAB_DATASET_MISSING',
  // Agent Lab agent (008, otto/mamoru#200): tool + answer-verifier reason codes.
  'LAB_OVERRIDE_UNKNOWN',
  'LAB_VERDICT_INCOMPARABLE',
  'LAB_ANSWER_PARTIAL',
  // Round 2 review of otto/mamoru#200/#126: a text/caveat block's {{cN}}/{{vN}} reference token names a claim
  // or verdict index the answer doesn't actually have.
  'LAB_REF_UNKNOWN',
  // Agent Lab runner (008 task 5, otto/mamoru#204): the runner's own job-lifecycle and model-plane codes.
  'LAB_JOB_LEASE_LOST',
  'LAB_JOB_TIMEOUT',
  'LAB_MODEL_UNAVAILABLE',
  // Not in spec 008's own "New reason codes" list — the daily cap this task's contract adds on top of it
  // (max 30 agent jobs/day across requesters, enforced on the runner side).
  'LAB_AGENT_BUDGET',
  // otto/mamoru#101 phase 1 (shadow, Decision.shadowRisk only): the pool's TVL is under Packaging's 2M floor, or could not be read.
  'RISK_POOL_TVL_FLOOR',
  'RISK_POOL_TVL_UNREAD',
] as const

export type ReasonCode = (typeof REASON_CODES)[number]

const CODE_SET: ReadonlySet<string> = new Set(REASON_CODES)

export function isReasonCode(value: string): value is ReasonCode {
  return CODE_SET.has(value)
}

export class ReasonError extends Error {
  readonly code: ReasonCode
  readonly detail?: string

  constructor(code: ReasonCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
    this.detail = detail
  }
}
