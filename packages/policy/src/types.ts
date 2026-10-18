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
 * - `cap:<name>`: an engineering cap fixed at activation; `cap:<a>|<b>` the larger of two (a v4 swap action takes
 *   either token of its pool, spec 007);
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
  /**
   * Spec 007: on a grant with an `actionPolicy`, this action carries UniActionPolicy only. Set on the swap deadline
   * (SwapRouter02.multicall(deadline, []), whose rules already pin it to execute nothing): MamoruActionPolicy refuses
   * every call it does not know, that one included.
   */
  uniOnly?: true
}

/**
 * `engine` (spec 007, policy v4): one session per pool for everything the engine does there (enter, mint, increase,
 * re-range, reduce, harvest, convert), bounded on chain by MamoruActionPolicy next to UniActionPolicy.
 */
export type GrantName = 'enter-swap' | 'enter-mint' | 'manage' | 'manage-any' | 'convert-any' | 'engine'

/** What a proposal needs a session for. Under v4 the pool's `engine` grant covers every role (see `grantKeyFor`). */
export type GrantRole = 'enter-swap' | 'enter-mint' | 'manage-any' | 'convert-any' | 'increase'

/**
 * Spec 007 (otto/mamoru#151): MamoruActionPolicy's Init for one pool, owner-signed with the grant. Caps are names of
 * the policy's `session.caps`, sized at activation like every other cap.
 */
export type ActionPolicyTemplate = {
  pool: RegistryName
  twapWindowSeconds: number
  bandTicks: number
  budgetWindowSeconds: number
  perWindow0: `cap:${string}`
  perWindow1: `cap:${string}`
  total0: `cap:${string}`
  total1: `cap:${string}`
}

/**
 * Spec 007 parameters of a v4 policy, in one place: the grants, caps and the engine's bounds all derive from these.
 * Per pool: the band in ticks, and the budgets as multiples of the pool's share of the account cap (C_p, its bucket
 * preference) in bps, 10000 = 1 x C_p: `perWindowBps` per budget window, `totalBps` over the approval.
 */
export type ActionPolicyParams = {
  twapWindowSeconds: number
  budgetWindowSeconds: number
  byPool: Record<RegistryName, { bandTicks: number; perWindowBps: number; totalBps: number }>
}

/** Grants that cover any position of the pair the account holds, enabled at activation. */
export const MANAGE_ANY_GRANTS = ['manage-any', 'convert-any'] as const satisfies readonly GrantName[]

export type GrantTemplate = {
  name: GrantName
  /** Multi-pool policies: the pool this grant is for. The session key is `${name}:${pool}` (see `grantKey`). */
  pool?: RegistryName
  /** Activated by the owner only for a tokenId already admitted from enter-mint. */
  perPosition: boolean
  /** Spec 007: MamoruActionPolicy on every action (but `uniOnly` ones), with this Init. Absent: UniActionPolicy only. */
  actionPolicy?: ActionPolicyTemplate
  /** userOps one approval allows under this grant. With `usageByCap`, the limit of an account cap under its first tier. */
  usageLimit: number
  /**
   * otto/mamoru#149: the usage limit by the account cap the grant is sized at (raw savings units), so one approval lasts
   * its whole validity at that size. Ascending by `upToUsdc`; the first tier at or above the cap applies, the last one
   * above every tier. Never above MAX_USAGE_LIMIT. Absent: `usageLimit` for every cap.
   */
  usageByCap?: readonly UsageTier[]
  actions: ActionRuleTemplate[]
}

export type UsageTier = { upToUsdc: bigint; usageLimit: number }

/**
 * Hard ceiling of any grant's usage limit (#149). A usage limit is not what bounds a leaked session key's reach: every
 * collect, mint and swap pays the account (pinned recipient), so a key can only lose value through bad prices, at most a
 * per-call cap per userOp, and 64 convert-any uses (2.0.0) already reached past a whole pair. It bounds how many userOps
 * the account's gas pays for, so it is never unbounded.
 */
export const MAX_USAGE_LIMIT = 100_000

/** Share of a grant's usage limit after which the app offers the renewal (#149): before it is spent, never after. */
export const USAGE_RENEW_BPS = 8_000

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
    /** Lab only (#101 experiment 4): re-range only when it pays. Absent: today's trigger byte for byte. */
    lazy?: LazyRerange
    /**
     * otto/mamoru#171, read only where the policy can add to a position (a v4 `engine` grant for the pool, spec 007):
     * an entry adds to a held position instead of minting when each edge of it is within this share (bps) of the new
     * range's width from the new range's edge. Absent: DEFAULT_INCREASE_TOLERANCE_BPS (see `reusablePosition` in
     * @mamoru/decide).
     */
    increaseToleranceBps?: number
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
  /**
   * target-weights, otto/mamoru#127: size every entry to the depth of its pool instead of a fixed account cap. An entry
   * swap may move the pool price by at most `maxImpactBps` (average execution against the active liquidity), and the
   * account's positions may hold at most `maxShareBps` of the pool's active liquidity. What does not fit waits as savings
   * with DECIDE_WAIT_DEPTH. Absent: entries are sized as before.
   */
  depth?: { maxImpactBps: number; maxShareBps: number; maxImpactBpsByPool?: Record<string, number> }
  execution: { slippageBps: number; maxTwapDeviationTicks: number; twapWindowSeconds: number; observationTtlSeconds: number }
  /** Spec 007 (v4): the on-chain action policy's parameters. Absent: v1/v2 grants, UniActionPolicy only. */
  actionPolicy?: ActionPolicyParams
  session: {
    validitySeconds: number
    renewalWindowSeconds: number
    caps: CapFormula[]
    grants: GrantTemplate[]
  }
  shadow: string[]
  /** Spec 004 loss control. Absent: today's behaviour byte for byte (FR-LC-001). */
  guards?: { byBucket: Partial<Record<BucketId, { fallFreeze?: FallFreezeRule }>> }
  /**
   * Lab only (#101, range geometry): where a new range sits around the price and how wide it is. Absent: the
   * centred range of `range.widthTicks` / `widthTicksByPool`, byte for byte. A pool with a `widthTicksByPool` entry
   * (the stables pool) keeps that width and is never skewed.
   */
  geometry?: { skew?: SkewRule; volWidth?: VolWidthRule }
  /** Lab only (#101 experiment 6): volatile bucket weights scaled to a volatility target. Absent: the preferences as set. */
  volTarget?: VolTarget
  /** Lab only (#101 experiment 6): CPPI on the volatile share against a floor under the account's peak. Absent: off. */
  cppi?: Cppi
  /** Lab only (#101 round 3): stables depeg guard on the `stables` bucket's pool. Absent: off. */
  depegGuard?: DepegGuard
  /** Lab only (#101 round 3): staged exits of the volatile buckets on a fall from the 7-day high. Absent: off. */
  stagedExit?: StagedExit
}

/**
 * Stables depeg guard (#101 round 3, spec 004 `RISK_DEPEG_PAIRED` without the oracle the Lab does not have): the
 * deviation is the stables pool's TWAP price against 1.0, in bps, either side. It trips when the deviation has been
 * at or over `thresholdBps` for `holdSeconds` without a break, and releases when it has been under `releaseBps` for
 * `releaseSeconds`. Tripped, `freeze`: no entry, top-up, re-range, reduce, convert or harvest in the stables pool;
 * the stables share waits as savings. `exit`: the same, and the stables position is closed and its non-savings token
 * sold to savings, each sale sized to `exitImpactBps` of price impact against the pool's active liquidity.
 */
export type DepegGuard = { thresholdBps: number; holdSeconds: number; action: 'freeze' | 'exit'; releaseBps: number; releaseSeconds: number; exitImpactBps: number }

/**
 * Staged exits (#101 round 3, research note experiment 3): each volatile bucket gives up a third of its preference
 * (to the stables bucket, as CPPI does) when its pool's TWAP price falls `step1Bps`, `step2Bps` and `step3Bps` from
 * the high (the 7-day high, or the high since the last re-entry if that is later). The bucket over its new target is
 * reduced at a 1-point drift band and the freed volatile token is converted, through the ordinary reduce and convert.
 * Re-entry, `ema`: every third comes back once the TWAP has been under its 7-day EMA since the first step and crosses
 * back over it. `ladder`: each third comes back when the price falls `ladderGapBps` below the price that third was
 * sold at (a buy order under the price); all of them when the price recovers to within `step1Bps` of the high.
 */
export type StagedExit = { step1Bps: number; step2Bps: number; step3Bps: number; reentry: 'ema' | 'ladder'; ladderGapBps: number }

/**
 * Downside-skewed placement in a falling regime: the new range holds `belowShareBps` of its width below the price
 * (in the volatile token's price), so it starts mostly in the savings asset and buys only if the fall goes on.
 * Regime: `ret24h`, the 24 h TWAP change is a fall of at least `fallBps`; `ema7d`, the TWAP is under the 7-day EMA.
 * `mirror`: in the opposite regime (a 24 h rise of `fallBps`, or the TWAP over the EMA) the range is skewed upward
 * the same amount. Otherwise, or with history missing, the range is centred.
 */
export type SkewRule = { belowShareBps: number; regime: 'ret24h' | 'ema7d'; fallBps: number; mirror: boolean }

/**
 * Volatility-scaled width: `k * sigma * sqrt(horizonSeconds)` in ticks, clamped to [minTicks, maxTicks], with sigma
 * the 24 h realized volatility of the pool. `earlyRatio` > 0: while the 1 h volatility is more than that many times
 * the 7-day one, sigma is the larger of the 24 h and 1 h figures, and an in-range position narrower than two thirds
 * of that width is re-ranged (cooldown applies). With history missing, the policy width.
 */
export type VolWidthRule = { k: number; horizonSeconds: number; minTicks: number; maxTicks: number; earlyRatio: number }

/**
 * Lazy, cost-aware re-range (#101, experiment 4), in place of the out-of-range-or-within-10%-of-an-edge trigger:
 * - the price must be outside the range by at least `edgeBufferTicks` (0: just out), and
 * - have been out of range for at least `minDwellSeconds` without coming back, and
 * - the fees a new centred range of the same value would earn over `horizonSeconds` (pool fee growth of the last 24 h,
 *   diluted by the pool's active liquidity) must exceed the cost of doing it: three operations of gas at the engine's
 *   userOp budget, the pool fee on the half that the ratio convert swaps, and the LVR of the new range over the horizon
 *   (sigma^2/4 * L * sqrt(P), sigma from the 24 h realized volatility), weighted by `lvrWeightBps` (10000 = all of it).
 * Missing fee or volatility history: the cost test abstains and the first two conditions decide alone.
 */
export type LazyRerange = { edgeBufferTicks: number; minDwellSeconds: number; horizonSeconds: number; lvrWeightBps: number }

/**
 * Volatility target (#101, experiment 6): a volatile bucket's weight is its preference times
 * min(1, targetVolBps / realized 24 h volatility of its pool). The stables bucket takes what the volatile buckets
 * give up. The scale moves on a grid of `stepBps` (2500: 0, 25, 50, 75 or 100% of the preference), with hysteresis
 * that uses the holdings as its state: of the grid levels between the scale at a volatility `bandBps` higher and the
 * one at a volatility `bandBps` lower, the bucket takes the one nearest its current weight. So an estimate that
 * jitters around the target, or a price move of the holdings, does not move money between buckets at every review.
 * Missing volatility: that bucket keeps its preference.
 */
export type VolTarget = { targetVolBps: number; bandBps: number; stepBps: number }

/**
 * CPPI (#101, experiment 6): floor = `floorBps` of the highest account value seen; the volatile buckets together may
 * hold at most `multiplier` times the cushion (value above the floor), never more than their preferences. The stables
 * bucket takes the rest. With `volTarget` too, each bucket takes the smaller of the two.
 */
export type Cppi = { floorBps: number; multiplier: number }

export type BucketId = PolicyVersion['buckets'][number]['id']

/**
 * No new money into a fall (spec 004 FREEZE, #101): while the 24 h TWAP change of the bucket's pool is a fall of at
 * least `fallBps` and its 24 h realized volatility (annualized) is at least `volBps`, the bucket gets no entry or
 * top-up. Re-ranges, harvests and the other buckets run as before. It lifts by itself when either condition clears.
 */
export type FallFreezeRule = { fallBps: number; volBps: number }

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
  /** See ActionRuleTemplate.uniOnly. Present only on v4 grants. */
  uniOnly?: true
}

/** MamoruActionPolicy.Init (contracts/action-policy/src/MamoruActionPolicy.sol), field for field. */
export type MamoruActionPolicyInit = {
  pool: Address
  twapWindow: number
  bandTicks: number
  generation: bigint
  budgetWindow: number
  perWindow0: bigint
  perWindow1: bigint
  total0: bigint
  total1: bigint
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
  /** Spec 007 (v4 grants only): the MamoruActionPolicy every action but the `uniOnly` ones carries, and its Init. */
  actionPolicy?: { address: Address; init: MamoruActionPolicyInit }
}
