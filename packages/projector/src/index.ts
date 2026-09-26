import { isAddressEqual, parseAbi, parseEventLogs, type Hex, type Log } from 'viem'
import type { Address, Provenance, ReasonCode, SavingsRowView } from '@mamoru/domain'
import { address } from '@mamoru/registry'

export const positionEventsAbi = parseAbi([
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
])
export const poolSwapAbi = parseAbi(['event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'])

export type Pair = readonly [bigint, bigint]

export type CollectSplit = { principal: Pair; fees: Pair; pendingAfter: Pair }

/**
 * FR-PRJ-003: a Collect first pays the principal still owed for the tokenId,
 * never below zero. Only what is collected above it is fees.
 */
export function splitCollect(pending: Pair, collected: Pair): CollectSplit {
  const principal = [collected[0] < pending[0] ? collected[0] : pending[0], collected[1] < pending[1] ? collected[1] : pending[1]] as const
  return {
    principal,
    fees: [collected[0] - principal[0], collected[1] - principal[1]],
    pendingAfter: [pending[0] - principal[0], pending[1] - principal[1]],
  }
}

export type PositionEvent =
  | { kind: 'decrease'; tokenId: bigint; amount0: bigint; amount1: bigint; logIndex: number }
  | { kind: 'collect'; tokenId: bigint; amount0: bigint; amount1: bigint; logIndex: number }

/** Collect and DecreaseLiquidity of the NonfungiblePositionManager, in log order. */
export function positionEvents(logs: Log[]): PositionEvent[] {
  const npm = address('NonfungiblePositionManager')
  return parseEventLogs({ abi: positionEventsAbi, logs: logs.filter((l) => isAddressEqual(l.address, npm)) }).map((e) => ({
    kind: e.eventName === 'Collect' ? 'collect' : 'decrease',
    tokenId: e.args.tokenId,
    amount0: e.args.amount0,
    amount1: e.args.amount1,
    logIndex: e.logIndex,
  }))
}

/** Principal owed per tokenId after a batch of position events: decreases add, collects pay it back first. */
export function applyPrincipal(owed: ReadonlyMap<bigint, Pair>, events: PositionEvent[]): Map<bigint, Pair> {
  const next = new Map(owed)
  for (const e of events) {
    const cur = next.get(e.tokenId) ?? [0n, 0n]
    next.set(e.tokenId, e.kind === 'decrease' ? [cur[0] + e.amount0, cur[1] + e.amount1] : splitCollect(cur, [e.amount0, e.amount1]).pendingAfter)
  }
  return next
}

export type SwapFill = { pool: Address; amountIn: bigint; amountOut: bigint; tick: number; logIndex: number }

/** Swap events of `pool` in these logs, as positive in and out amounts. */
export function swapFills(logs: Log[], pool: Address): SwapFill[] {
  return parseEventLogs({ abi: poolSwapAbi, logs: logs.filter((l) => isAddressEqual(l.address, pool)) }).map((e) => ({
    pool,
    amountIn: e.args.amount0 > 0n ? e.args.amount0 : e.args.amount1,
    amountOut: e.args.amount0 < 0n ? -e.args.amount0 : -e.args.amount1,
    tick: e.args.tick,
    logIndex: e.logIndex,
  }))
}

export type SavingsLogRow = {
  kind: 'harvest'
  opId: string
  tokenId: bigint
  chainId: number
  block: bigint
  blockHash: Hex
  txHash: Hex
  logIndex: number
  at: string
  principal: Pair
  fees: Pair
  conversion: { amountIn: bigint; amountOut: bigint } | null
  /** Savings asset credited to the ledger. Only harvests credit (FR-PRJ-004). */
  credited: bigint
  status: 'confirmed'
  code: ReasonCode
  provenance: Provenance[]
}

export type HarvestProjection = {
  opId: string
  tokenId: bigint
  chainId: number
  block: bigint
  blockHash: Hex
  txHash: Hex
  at: string
  logs: Log[]
  pool: Address
  /** Principal owed for the tokenId before this operation. */
  pendingBefore: Pair
  savingsIsToken0: boolean
}

/**
 * FR-PRJ-003 and FR-PRJ-004: the Savings Log row of a confirmed harvest.
 * Fees come from the Collect event after the principal owed, the conversion
 * from the Swap event, and only fees in the savings asset are credited.
 */
export function harvestRow(h: HarvestProjection): SavingsLogRow {
  const collect = positionEvents(h.logs).find((e) => e.kind === 'collect' && e.tokenId === h.tokenId)
  if (!collect) throw new Error(`no Collect for tokenId ${h.tokenId} in ${h.txHash}`)
  const split = splitCollect(h.pendingBefore, [collect.amount0, collect.amount1])
  const swap = swapFills(h.logs, h.pool)[0] ?? null
  const feesInSavings = h.savingsIsToken0 ? split.fees[0] : split.fees[1]
  const provenance: Provenance[] = [
    { source: 'journal', chainId: h.chainId, observedAt: h.at, status: 'fresh', detail: 'PROJ_CONFIRMED' },
    { source: 'fork_rpc', chainId: h.chainId, blockNumber: Number(h.block), blockHash: h.blockHash, observedAt: h.at, status: 'fresh' },
  ]
  return {
    kind: 'harvest',
    opId: h.opId,
    tokenId: h.tokenId,
    chainId: h.chainId,
    block: h.block,
    blockHash: h.blockHash,
    txHash: h.txHash,
    logIndex: collect.logIndex,
    at: h.at,
    principal: split.principal,
    fees: split.fees,
    conversion: swap ? { amountIn: swap.amountIn, amountOut: swap.amountOut } : null,
    credited: feesInSavings + (swap?.amountOut ?? 0n),
    status: 'confirmed',
    code: 'PROJ_CONFIRMED',
    provenance,
  }
}

export function ledgerTotal(rows: readonly SavingsLogRow[]): bigint {
  return rows.reduce((s, r) => s + r.credited, 0n)
}

/** The row as the dashboard contract shows it. */
export function savingsRowView(r: SavingsLogRow): SavingsRowView {
  return {
    kind: 'harvest',
    block: Number(r.block),
    blockHash: r.blockHash,
    txHash: r.txHash,
    logIndex: r.logIndex,
    at: r.at,
    opId: r.opId,
    amount: { value: r.credited.toString(), unit: 'USDC', provenance: r.provenance[1]! },
    code: r.code,
    provenance: r.provenance[0]!,
  }
}
