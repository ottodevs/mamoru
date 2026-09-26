import type { Address, Hex, ReasonCode } from '@mamoru/domain'
import type { RegistryName } from '@mamoru/registry'

/** Rhinestone UniActionPolicy ParamCondition, in enum order. */
export const PARAM_CONDITIONS = [
  'EQUAL',
  'GREATER_THAN',
  'LESS_THAN',
  'GREATER_THAN_OR_EQUAL',
  'LESS_THAN_OR_EQUAL',
  'NOT_EQUAL',
  'IN_RANGE',
] as const
export type ParamCondition = (typeof PARAM_CONDITIONS)[number]

/**
 * Reference of a rule, as written in the policy:
 * - `ACCOUNT`: the smart account itself;
 * - a registry name, compared as an address;
 * - `cap:<name>`: an engineering cap fixed at activation;
 * - `tokenId`: the position of a per-position grant;
 * - a bigint literal.
 */
export type RefTemplate = 'ACCOUNT' | 'tokenId' | `cap:${string}` | RegistryName | bigint

export type ParamRuleTemplate = {
  field: string
  /** Word index in the static argument tuple; offset = index * 32 after the selector. */
  index: number
  condition: Exclude<ParamCondition, 'IN_RANGE'>
  ref: RefTemplate
  cumulative?: `cap:${string}`
  /** Code the engine pre-check returns when this rule fails. */
  denial: ReasonCode
}

export type ActionRuleTemplate = {
  target: RegistryName
  /** Full function signature, static arguments only. */
  signature: string
  params: ParamRuleTemplate[]
}

export type GrantName = 'enter-swap' | 'enter-mint' | 'manage' | 'manage-any' | 'convert-any'

/** Grants that cover any position of the pair the account holds, enabled at activation. */
export const MANAGE_ANY_GRANTS = ['manage-any', 'convert-any'] as const satisfies readonly GrantName[]

export type GrantTemplate = {
  name: GrantName
  /** Multi-pool policies: the pool this grant is for. The session key is `${name}:${pool}` (see `grantKey`). */
  pool?: RegistryName
  /** Activated by the owner only for a tokenId already admitted from enter-mint. */
  perPosition: boolean
  usageLimit: number
  actions: ActionRuleTemplate[]
}

export type CapFormula = {
  name: string
  asset: RegistryName
  /** Share of the USDC deposit, in basis points, converted to `asset` at the activation price. */
  bpsOfDeposit: number
}

export type PolicyVersion = {
  policyId: string
  version: string
  preset: 'conservador'
  chain: 'base' | 'fork'
  buckets: { id: 'stables' | 'btc-usdc' | 'risk'; preference: number; pools: RegistryName[] }[]
  savingsAsset: RegistryName
  gasReserveWei: bigint
  harvest: { costFactorBps: number }
  range: {
    widthTicks: number
    adjust: 'off' | 'on_out_of_range'
    cooldownSeconds: number
    /** Width per pool, overriding `widthTicks` (a stable/stable pool wants a narrow range around 1.0). */
    widthTicksByPool?: Record<RegistryName, number>
  }
  /**
   * How `decide` enters. `first-entry` (default, v1): one entry per bucket without a managed position.
   * `target-weights`: every review values each bucket (positions + idle volatile, in the savings asset at the
   * TWAP) against its share of the whole account and proposes the next entry for the most under-weight bucket,
   * so idle savings is always re-invested toward the target mix.
   */
  allocation?: 'first-entry' | 'target-weights'
  /** target-weights: smallest entry, in raw savings units. */
  minEntry?: bigint
  /** target-weights: a bucket is topped up only when it is short of its target by more than this share of it (bps). */
  rebalanceBandBps?: number
  execution: { slippageBps: number; maxTwapDeviationTicks: number; twapWindowSeconds: number; observationTtlSeconds: number }
  session: {
    validitySeconds: number
    renewalWindowSeconds: number
    caps: CapFormula[]
    grants: GrantTemplate[]
  }
  shadow: string[]
}

export type ResolvedParamRule = {
  field: string
  index: number
  condition: Exclude<ParamCondition, 'IN_RANGE'>
  ref: bigint
  cumulativeLimit?: bigint
  denial: ReasonCode
}

export type ResolvedActionRule = {
  target: RegistryName
  targetAddress: Address
  signature: string
  selector: Hex
  nativeValue: 0n
  params: ResolvedParamRule[]
}

/** Plan section 12.1, with `tokenId` in place of the unexpressible `allowedTokenIds` set. */
export type SessionGrant = {
  policyId: string
  policyHash: Hex
  name: GrantName
  pool?: RegistryName
  salt: Hex
  chainId: number
  account: Address
  sessionValidator: 'OwnableValidator'
  sessionKey: Address
  userOp: { validAfter: number; validUntil: number; usageLimit: number }
  permitERC4337Paymaster: false
  erc7739: 'none'
  fallbackAction: 'none'
  tokenId?: bigint
  actions: ResolvedActionRule[]
}
