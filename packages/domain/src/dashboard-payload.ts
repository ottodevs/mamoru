// Dashboard payload contract. Source: specs/001-mamoru-v1/dashboard.md §5 and §9.
// Shared by the API (writer) and the SPA (reader). Only the integrator changes this file.
import type { ReasonCode } from './reason-codes.ts'

export type Hex0x = `0x${string}`

export type Provenance = {
  source: 'chain_rpc' | 'fork_rpc' | 'multibaas' | 'journal' | 'd1' | 'estimate'
  chainId: number
  blockNumber?: number
  blockHash?: Hex0x
  observedAt: string
  status: 'fresh' | 'stale' | 'not_observed'
  detail?: ReasonCode
  cause?: ReasonCode
  check?: 'reconciled' | 'mismatch'
  checkedAt?: number
}

export type Figure<T> = { value: T | null; unit?: string; provenance: Provenance }

export type ChainRef = { chainId: number; name: 'Base' | 'Base fork'; observed: true }

export type IndexHealth = {
  provider: 'multibaas' | 'fork_index'
  status: 'indexing' | 'behind' | 'not_indexing_base' | 'failing' | 'not_configured'
  indexedBlock?: number
  code?: ReasonCode
  checkedAt: string
}

export type PoolRef = {
  address: Hex0x
  token0: string
  token1: string
  fee: number
  tickSpacing: number
  name: string
}

export type GateStep = { gate: string; verdict: 'GO' | 'NO_GO' | 'EXIT' | 'SKIP'; reason: ReasonCode }
export type ShadowNote = { code: ReasonCode; note: string }

// History rows (§9 closing paragraph). Amounts are integer strings in token base units.
export type HistoryRowBase = {
  block: number
  blockHash: Hex0x
  txHash: Hex0x
  logIndex: number
  at: string
  opId?: string
  provenance: Provenance
}
export type AccountOpView = HistoryRowBase & { kind: string; state: string; code?: ReasonCode }
export type AccountSwapView = HistoryRowBase & { tokenIn: string; tokenOut: string; amountIn: Figure<string>; amountOut: Figure<string> }
export type PositionEventView = HistoryRowBase & { kind: 'mint' | 'increase' | 'decrease' | 'collect' | 'burn'; amount0: Figure<string>; amount1: Figure<string> }
export type PoolSwapView = HistoryRowBase & { amount0: Figure<string>; amount1: Figure<string>; tick: number }
export type PoolLiquidityView = HistoryRowBase & { kind: 'mint' | 'burn'; amount0: Figure<string>; amount1: Figure<string>; tickLower: number; tickUpper: number }
export type SavingsRowView = HistoryRowBase & { kind: 'harvest' | 'convert' | 'withdraw'; amount: Figure<string>; code?: ReasonCode }

export type ActionItem = {
  id: string
  code: ReasonCode
  kind: 'critical' | 'decide' | 'understand'
  subject: { kind: 'account' | 'session' | 'position' | 'token' | 'savings' | 'exit'; ref?: string }
  title: string
  body: string
  cause?: ReasonCode
  action?:
    | { type: 'intent'; intent: 'pause' | 'exit' | 'renew_session'; params?: { paused: boolean } }
    | { type: 'link'; target: 'current-action' | 'portfolio' | 'treasury' | 'position' | 'savings' | 'savings-log' | 'leave' | 'walk-04'; ref?: string }
  since: Figure<string>
  sources: Provenance[]
}

export type TokenHolding = {
  token: 'USDC' | 'cbBTC' | 'WETH' | 'ETH'
  role: 'plan' | 'gas' | 'outside_plan'
  amount: Figure<string>
  value: Figure<string>
  code?: ReasonCode
}

export type PositionView = {
  tokenId: string
  pool: PoolRef
  managed: boolean
  tickLower: number
  tickUpper: number
  rangeState: Figure<'in_range' | 'out_of_range'>
  outOfRangeSince?: Figure<{ block: number; at: string } | 'before_retention'>
  timeInRange: Figure<string>
  liquidity: Figure<string>
  liquidityFromEvents: Figure<string>
  historyComplete: boolean
  principal: { amount0: Figure<string>; amount1: Figure<string>; value: Figure<string> }
  uncollectedFees: { amount0: Figure<string>; amount1: Figure<string>; value: Figure<string> }
  collectedFees: { amount0: Figure<string>; amount1: Figure<string> }
  feeMovement: { amount0: Figure<string>; amount1: Figure<string>; value: Figure<string>; fromBlock: number }
  value: Figure<string>
  codes: ReasonCode[]
  events: PositionEventView[]
  nextEvents?: string
}

export type PoolView = {
  pool: PoolRef
  block: number
  price: Figure<string>
  tick: Figure<number>
  twapTick: Figure<number>
  twapGuard: Figure<'ok' | 'above_guard'>
  liquidity: Figure<string>
  balances: { amount0: Figure<string>; amount1: Figure<string>; value: Figure<string> }
  window: { fromBlock: number; toBlock: number }
  stats: {
    swaps: Figure<number>
    volume0: Figure<string>; volume1: Figure<string>; volumeValue: Figure<string>
    fees0: Figure<string>; fees1: Figure<string>; feesValue: Figure<string>
    tickMin: Figure<number>; tickMax: Figure<number>
    added: { count: Figure<number>; amount0: Figure<string>; amount1: Figure<string> }
    removed: { count: Figure<number>; amount0: Figure<string>; amount1: Figure<string> }
  }
  recentSwaps: PoolSwapView[]
  recentLiquidity: PoolLiquidityView[]
  accountPositions: { tokenId: string; rangeState: Figure<'in_range' | 'out_of_range'> }[]
}

export type DashboardPayload = {
  mode: 'production' | 'lab'
  chainId: number
  chains: ChainRef[]
  sources: {
    rpc: { status: 'ok' | 'unavailable'; block?: number; safeBlock?: number; observedAt: string }
    index: IndexHealth
  }
  banner: { kind: 'simulation' | 'lab'; text: string; block?: number }
  account: {
    key: string
    address: Figure<Hex0x>
    deployed: Figure<boolean>
    preset: 'conservador'
    policyVersion: string
    fundsGate: 'closed' | 'lab'
    totalValue: Figure<string>
    totalMissing: string[]
  }
  actions: { items: ActionItem[]; complete: boolean; notObserved: string[] }
  currentAction: {
    op?: { opId: string; kind: string; state: string; code: ReasonCode; updatedAt: string; txHash?: Hex0x }
    decision?: {
      decisionId: string; kind: string; code: ReasonCode; block: number
      trail: GateStep[]; shadow: ShadowNote[]
      positions: { tokenId: string; codes: ReasonCode[] }[]
    }
    recentDecisions: { decisionId: string; kind: string; code: ReasonCode; block: number; at: string }[]
    chainOps: AccountOpView[]
    session: Figure<'active' | 'renewal_due' | 'expired' | 'revoked' | 'missing'>
    sessionValidUntil?: Figure<string>
    paused: Figure<boolean>
    exit?: { status: 'in_progress' | 'pending' | 'completed'; cause?: ReasonCode }
    nextReviewAt: Figure<string>
    notes: ReasonCode[]
  }
  portfolio: {
    tokens: TokenHolding[]
    // counts are figures: unknown is null with not_observed, never zero
    positions: { managed: Figure<number>; unmanaged: Figure<number>; value: Figure<string> }
    // preference and actual are basis points (5000 = 50%)
    allocation: { bucket: string; preference: number; actual: Figure<number>; code: ReasonCode }[]
    unmanaged: { kind: 'token' | 'position'; ref: string; code: ReasonCode }[]
    total: Figure<string>
  }
  treasury: {
    idle: { usdc: Figure<string>; cbBTC: Figure<string>; value: Figure<string>; code?: ReasonCode }
    lp: Figure<string>
    savings: Figure<string>
    gasReserve: Figure<string>
    outsidePlan: Figure<string>
    convert: {
      route: { protocol: 'uniswap-v3'; pool: PoolRef; router: 'SwapRouter02'; method: 'exactInputSingle'; quoter: 'QuoterV2' }
      pending: Figure<string>
      quote: Figure<string>
      state: 'nothing_to_convert' | 'held_for_entry' | 'converting' | 'held'
      code?: ReasonCode
      cause?: ReasonCode
    }
    swaps: AccountSwapView[]
  }
  pools: { positions: PositionView[]; plan: PoolView[] }
  savings: {
    ledgerTotal: Figure<string>
    usdcBalance: Figure<string>
    available: Figure<string>
    pending: Figure<string>
    lastHarvest?: Figure<string>
  }
  savingsLog: { rows: SavingsRowView[]; next?: string }
  provenanceComplete: boolean
}

export const PRODUCTION_BANNER =
  'Simulation mode. Mamoru plans and simulates. It does not sign or send transactions. Deposits are closed.'
