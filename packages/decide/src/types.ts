import type { Address, Hex, ReasonCode } from '@mamoru/domain'
import type { Registry, RegistryName } from '@mamoru/registry'

/** Plan §8.1. Every chain read is pinned to `block`. */
export type Observation = {
  chainId: number
  /**
   * The registry the observation was read against. The gates compare every pool identity with it and `decide`
   * never resolves it from a chain id or a constant. Optional only while the registry default exists: an observation
   * without one is a Base observation (`baseRegistry`). It becomes required when the default is retired.
   */
  registry?: Registry
  block: { number: bigint; hash: Hex; timestamp: bigint }
  safeBlock: { number: bigint; hash: Hex }
  account: { address: Address; deployed: boolean; nonceKey: bigint; nonce: bigint }
  sessions: SessionObs[]
  native: bigint
  balances: Record<RegistryName, bigint>
  positions: PositionObs[]
  pools: PoolObs[]
  /** Price source for the gas cost in the savings asset: WETH/USDC 0.3% slot0. */
  ethPrice: { pool: RegistryName; sqrtPriceX96: bigint; token0: RegistryName }
  /** The fee per gas the engine would bid, and the gas budget of one userOp. */
  gas: { maxFeePerGas: bigint; opGasUnits: bigint }
  deposits: DepositObs[]
  intents: { paused: boolean; exitRequested: boolean }
  slot: { opId: string; state: string } | null
  /** Block timestamp of the last confirmed re-range, for the policy cooldown. Absent or null: none yet. */
  lastRerangeAt?: bigint | null
  /**
   * Spec 004: 24 h history per pool, from TWAP samples (see `marketOf`). Read only by a policy with `guards`;
   * absent or null fields make the guard rules abstain.
   */
  guard?: {
    pools: Partial<Record<RegistryName, PoolGuardObs>>
    /** Lab (#101 CPPI): the highest account value seen, in raw savings units. Absent: the current value. */
    peakValue?: bigint
    /** Lab (#101 round 3 depeg guard): the guard's state as the engine keeps it (`pegStep`). Absent: not tripped. */
    peg?: { tripped: boolean; deviationBps: number | null }
    /** Lab (#101 round 3 staged exits): thirds each volatile bucket holds out (0-3), as the engine keeps them (`stageStep`). */
    stages?: Partial<Record<string, number>>
  }
  /** Lab (#101): history for `policy.geometry`. Absent: geometry rules abstain (centred range, policy width). */
  geometry?: { pools: Partial<Record<RegistryName, PoolGeometryObs>> }
}

export type PoolGuardObs = {
  twap24hAgoTick: number | null
  realizedVol24hBps: number | null
  /**
   * Lab (#101 lazy re-range): growth of the pool's fee growth globals over about the last 24 h (per unit of active
   * liquidity, X128) and the seconds it covers. Absent or null: the cost test abstains.
   */
  feeGrowth24h?: { growth0X128: bigint; growth1X128: bigint; seconds: number } | null
}

/**
 * Lab (#101, range geometry): market history per pool, read only by a policy with `geometry`. Volatilities are
 * annualized, in bps, from 10-minute TWAP means over the last hour, 24 h and 7 days (or what history exists, at
 * least 24 h). `emaTick`: exponential mean of the TWAP tick, 7-day span. Null: not enough history; the rule abstains.
 */
export type PoolGeometryObs = {
  twap24hAgoTick: number | null
  emaTick: number | null
  vol1hBps: number | null
  vol24hBps: number | null
  vol7dBps: number | null
}

/** What a guard rule measured and held, per bucket, for the app and /ops. `metric` is null when history is missing. */
export type GuardNote = {
  bucket: string
  pool: RegistryName
  code: ReasonCode
  metric: { fallBps: number; volBps: number } | null
  threshold: { fallBps: number; volBps: number }
}

export type SessionObs = {
  grant: string
  permissionId: Hex
  tokenId?: bigint
  validUntil: number
  active: boolean
  /** otto/mamoru#149: userOps the grant has left before its usage limit. Absent: not known (no gate on it). */
  usesLeft?: number
}

export type PositionObs = {
  tokenId: bigint
  /** Registry name of the pool, or null when the pool is not in the registry. */
  pool: RegistryName | null
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** What a static `collect` from the account would return. */
  collectable0: bigint
  collectable1: bigint
  /** FR-PRJ-003: principal still owed from decreases, from the journal. */
  principalOwed0: bigint
  principalOwed1: bigint
  /** The tokenId is in the account's allowedTokenIds. */
  managed: boolean
  /**
   * Spec 007, set only when the engine runs a session that can increase (MamoruActionPolicyV2): the policy admitted this
   * tokenId for the account in its pool, read at the observation block. Absent: not read; never treated as admitted.
   */
  admitted?: boolean
  /** Lab (#101 lazy re-range): block time since which the price has been out of the range without coming back. */
  outOfRangeSince?: bigint | null
}

export type PoolObs = {
  name: RegistryName
  address: Address
  token0: RegistryName
  token1: RegistryName
  fee: number
  tickSpacing: number
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  /** Time-weighted tick over the policy window, or null when `observe` cannot answer. */
  twapTick: number | null
  /**
   * Harmonic-mean in-range liquidity over the same window (from `secondsPerLiquidityCumulativeX128`), or null when
   * `observe` cannot answer. Not movable inside one block, unlike `liquidity`: depth sizing reads the smaller of the two.
   */
  twapLiquidity?: bigint | null
  /** What the chain says about the pool, for Purga's identity check. */
  identity: { factoryPool: Address; token0: Address; token1: Address; fee: number; tickSpacing: number }
}

export type DepositObs = { token: RegistryName; amount: bigint; block: bigint; txHash: Hex; logIndex: number; safe: boolean }

export type GateVerdict = 'GO' | 'NO_GO' | 'EXIT' | 'SKIP'
export type GateStep = { gate: string; verdict: GateVerdict; reason: ReasonCode }
export type ShadowNote = { code: ReasonCode; note: string }

export type EnterSwapProposal = {
  kind: 'enter_swap'
  /** `enter-swap`, or `enter-swap:<pool>` on a multi-pool policy; `convert-any[:<pool>]` sends the volatile side back to savings before a re-mint. */
  grant: 'enter-swap' | `enter-swap:${string}` | 'convert-any' | `convert-any:${string}` | 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenIn: RegistryName
  tokenOut: RegistryName
  fee: number
  amountIn: bigint
}

export type EnterMintProposal = {
  kind: 'enter_mint'
  /** `manage-any[:<pool>]`: re-mints after a re-range are not bounded by enter-mint's one-time cumulative cap. */
  grant: 'enter-mint' | `enter-mint:${string}` | 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
}

/**
 * otto/mamoru#171: an entry added to a position the account already holds in the pool, instead of a second NFT:
 * approvals of MamoruActionPolicyV2 + MamoruActionPolicyV2.increase(tokenId) (spec 007: only a policy whose manage-any
 * carries that action proposes it, and only for a position the policy admitted). `tickLower`/`tickUpper` are the
 * position's own range, which the amounts are split for; the engine checks them against the chain before it builds
 * the call.
 */
export type IncreaseLiquidityProposal = {
  kind: 'increase_liquidity'
  /** The pool's manage-any session (v5): no grant per position. */
  grant: 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenId: bigint
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
}

export type HarvestProposal = {
  kind: 'harvest'
  grant: `manage:${string}` | 'convert-any' | `convert-any:${string}` | 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenId: bigint
  /** Fees only: collectable minus principal owed. */
  fees0: bigint
  fees1: bigint
  /** The fee token that is not the savings asset, and how much of it to convert. */
  convert: { token: RegistryName; amount: bigint } | null
}

/** Whole position back to the Safe: decreaseLiquidity(all) + collect(to the Safe) + burn. */
export type RerangeProposal = {
  kind: 'rerange'
  grant: 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenId: bigint
  liquidity: bigint
}

/** Part of an over-weight bucket's position back to the Safe: decreaseLiquidity(part) + collect(to the Safe). */
export type ReduceProposal = {
  kind: 'reduce'
  grant: 'manage-any' | `manage-any:${string}`
  pool: RegistryName
  tokenId: bigint
  liquidity: bigint
}

export type Proposal = EnterSwapProposal | EnterMintProposal | IncreaseLiquidityProposal | HarvestProposal | RerangeProposal | ReduceProposal

export type DecisionKind = 'hold' | Proposal['kind']

/** Plan §8.3. */
export type Decision = {
  decisionId: Hex
  /** Hash of the decision without the observation block, for FR-ENG-015 dedupe. */
  premiseHash: Hex
  observationRef: { block: bigint; hash: Hex }
  policyRef: { policyId: string; version: string; hash: Hex }
  observationCodes: ReasonCode[]
  kind: DecisionKind
  code: 'DECIDE_HOLD' | 'DECIDE_ENTER' | 'DECIDE_HARVEST' | 'DECIDE_RANGE_ADJUST' | 'STRATEGY_PREFERENCE_DEVIATION'
  reason: ReasonCode
  trail: GateStep[]
  proposal: Proposal | null
  shadow: ShadowNote[]
  buckets: { bucket: string; code: ReasonCode }[]
  positions: { tokenId: bigint; codes: ReasonCode[] }[]
  /** Present only when the policy sets `guards` (FR-LC-001: absent, the decision is byte-identical). */
  guards?: GuardNote[]
  /** Lab (#101 experiment 6): bucket preferences after the volatility target or CPPI. Present only with one of them. */
  targets?: { bucket: string; preference: number }[]
  /**
   * Lab (#101 round 3): depeg guard tripped (`value`: deviation in bps) and staged exits in force (`value`: thirds
   * out), per bucket. Present only with `depegGuard` or `stagedExit` and something to report.
   */
  labGuards?: { bucket: string; code: 'RISK_DEPEG_PAIRED' | 'RISK_STAGED_EXIT'; value: number }[]
  /**
   * otto/mamoru#127, #128: savings held back on purpose, per bucket, with why. Outside the premise hash and the id
   * (the amounts move with every price). Absent when nothing waits.
   */
  waiting?: { bucket: string; code: 'DECIDE_WAIT_DEPTH' | 'DECIDE_ENTRY_PAUSED_FALL'; amount: bigint }[]
}
