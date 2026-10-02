import type { Hex, ReasonCode } from '@mamoru/domain'
import type { GateStep, Proposal } from '@mamoru/decide'
import type { RegistryName } from '@mamoru/registry'

/** One pool at one block: what `pool_snapshots` stores. */
export type PoolSample = {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  feeGrowthGlobal0X128: bigint
  feeGrowthGlobal1X128: bigint
  /** Null when the pool oracle could not answer; the TWAP then falls back to the tick. */
  tickCumulative: bigint | null
}

/** Every pool of the dataset at one block. `pools[i]` belongs to `Dataset.pools[i]`; null when that pool was not read. */
export type Sample = { block: number; hash: Hex; time: number; baseFeeWei: bigint; pools: (PoolSample | null)[] }

/** Chain history a run replays. `id` is the hash of everything else, so a result names exactly the data it used. */
export type Dataset = { id: Hex; chainId: number; pools: RegistryName[]; samples: Sample[] }

export type OpKind = Proposal['kind']

/**
 * What an executed operation costs. `decide` prices a harvest with the userOp gas budget, as the live engine does;
 * the account is charged these units instead.
 */
export type GasModel = { unitsByKind: Record<OpKind, bigint>; priorityFeeWei: bigint; l1FeeWei: bigint }

export type SimConfig = {
  /** Savings asset deposited at the first sample, raw units. */
  deposit: bigint
  /** `decide` runs every this many samples. Default 1. */
  reviewEvery?: number
  gas?: Partial<GasModel>
  /**
   * `enforce` (default): an operation whose grant has no uses left in its session window is refused, as the chain
   * would refuse it. `report`: every operation runs and the overuse is only reported.
   */
  sessions?: 'enforce' | 'report'
  /**
   * `renewed` (default): the owner renews every session when it lapses, so each `validitySeconds` window starts with
   * all its uses. `once`: nobody renews; after the first window every operation is refused, as on an account whose
   * owner never comes back. Either way the run assumes every grant of the policy was enabled at activation.
   */
  sessionRenewal?: 'renewed' | 'once'
  /** Later deposits of the savings asset: `at` is a sample index, the amount lands before that sample's review. */
  topUps?: { at: number; amount: bigint }[]
  /** First and last sample to replay, inclusive. Default: the whole dataset. */
  from?: number
  to?: number
}

export type OpEntry = {
  /** Sample index and its block. */
  i: number
  block: number
  time: number
  kind: OpKind
  pool: RegistryName
  grant: string
  code: string
  reason: ReasonCode
  trail: GateStep[]
  /** False when the operation could not be built (a mint with a zero side, for instance). */
  ok: boolean
  detail?: string
  /** Gas of this operation in raw savings units. */
  gasCost: bigint
  /** Fees taken out of the position by this operation, in raw savings units. */
  feesValue: bigint
}

export type SessionUse = { grant: string; limit: number | null; uses: number; peakPerWindow: number; exhausted: boolean }

export type Metrics = {
  days: number
  /** Everything deposited over the run, raw savings units. */
  start: bigint
  end: bigint
  /** Value net of gas, minus the deposits. */
  net: bigint
  /** Holding the first entry mix of every bucket without providing liquidity. */
  hodl: bigint
  vsHodl: bigint
  /** Fees accrued by all positions, collected or not. */
  fees: bigint
  gas: bigint
  operations: Record<OpKind, number>
  discarded: number
  /** Operations refused because their grant had no uses left in the session window. */
  refused: number
  /** Share of position value in range, averaged over the samples with a position. Basis points. */
  timeInRangeBps: number
  maxDrawdownBps: number
  worstWeekBps: number
  /** Net return over the window, not annualized. Basis points of the deposit. */
  returnBps: number
}

export type RunResult = {
  simVersion: string
  datasetId: Hex
  policyId: string
  policyHash: Hex
  /** `gaps`: samples stepped over because a pool the policy needs was not read at that block. */
  window: { fromBlock: number; toBlock: number; fromTime: number; toTime: number; samples: number; gaps: number }
  /** One point per sample, raw savings units. `value` is net of gas. */
  series: { time: number[]; value: bigint[]; hodl: bigint[] }
  ops: OpEntry[]
  /** How many reviews ended in each reason code. */
  reasons: Record<string, number>
  sessions: SessionUse[]
  metrics: Metrics
  /** Hash of the integer facts above. Same dataset, policy and simulator version give the same hash on any machine. */
  resultHash: Hex
}
