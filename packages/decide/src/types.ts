import type { Address, Hex, ReasonCode } from '@mamoru/domain'
import type { RegistryName } from '@mamoru/registry'

/** Plan §8.1. Every chain read is pinned to `block`. */
export type Observation = {
  chainId: number
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
  guard?: { pools: Partial<Record<RegistryName, PoolGuardObs>> }
}

export type PoolGuardObs = { twap24hAgoTick: number | null; realizedVol24hBps: number | null }

/** What a guard rule measured and held, per bucket, for the app and /ops. `metric` is null when history is missing. */
export type GuardNote = {
  bucket: string
  pool: RegistryName
  code: ReasonCode
  metric: { fallBps: number; volBps: number } | null
  threshold: { fallBps: number; volBps: number }
}

export type SessionObs = { grant: string; permissionId: Hex; tokenId?: bigint; validUntil: number; active: boolean }

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
  grant: 'enter-swap' | `enter-swap:${string}` | 'convert-any' | `convert-any:${string}`
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

export type HarvestProposal = {
  kind: 'harvest'
  grant: `manage:${string}` | 'convert-any' | `convert-any:${string}`
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

export type Proposal = EnterSwapProposal | EnterMintProposal | HarvestProposal | RerangeProposal | ReduceProposal

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
  /**
   * otto/mamoru#127, #128: savings held back on purpose, per bucket, with why. Outside the premise hash and the id
   * (the amounts move with every price). Absent when nothing waits.
   */
  waiting?: { bucket: string; code: 'DECIDE_WAIT_DEPTH' | 'DECIDE_ENTRY_PAUSED_FALL'; amount: bigint }[]
}
