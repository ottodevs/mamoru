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
  grant: 'enter-swap'
  pool: RegistryName
  tokenIn: RegistryName
  tokenOut: RegistryName
  fee: number
  amountIn: bigint
}

export type EnterMintProposal = {
  kind: 'enter_mint'
  grant: 'enter-mint'
  pool: RegistryName
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
}

export type HarvestProposal = {
  kind: 'harvest'
  grant: `manage:${string}`
  pool: RegistryName
  tokenId: bigint
  /** Fees only: collectable minus principal owed. */
  fees0: bigint
  fees1: bigint
  /** The fee token that is not the savings asset, and how much of it to convert. */
  convert: { token: RegistryName; amount: bigint } | null
}

export type Proposal = EnterSwapProposal | EnterMintProposal | HarvestProposal

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
  code: 'DECIDE_HOLD' | 'DECIDE_ENTER' | 'DECIDE_HARVEST'
  reason: ReasonCode
  trail: GateStep[]
  proposal: Proposal | null
  shadow: ShadowNote[]
  buckets: { bucket: string; code: ReasonCode }[]
  positions: { tokenId: bigint; codes: ReasonCode[] }[]
}
