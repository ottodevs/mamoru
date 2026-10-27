// Gas paid and fees collected per account and UTC day for the yield ledger (otto/mamoru#129, phase 2 of the /ops
// redesign). The operator has no D1 binding (specs/003-snapshot-loop/spec.md): every engine op that reached the
// chain gets its receipt read once, the facts are kept on its stored row (accounts.json, so a restart or a new
// deploy never reads it again), and every snapshot GET /snapshot serves carries the per-day totals. The Worker
// writes them into account_daily.collected_usdc/gas_paid_wei and yield_ledger_position_daily.collected_*.
//
// The same path backfills ops confirmed before this existed: they have a txHash and no facts yet.
//
// What counts:
// - gas: the UserOperationEvent.actualGasCost of this Safe's userOp in the transaction (the Safe pays it, there is
//   no paymaster: bundler.ts). A reverted userOp still paid, so failed ops with a txHash count too.
// - fees: per tokenId, what Collect paid to this Safe above what a DecreaseLiquidity of the same transaction freed
//   (packages/projector's splitCollect: a collect pays owed principal first). Principal a decrease left owed in an
//   earlier transaction is not tracked here and would count as fees; the engine always collects in the same batch.
// - USD: priced at the first snapshot read after the facts were taken (minutes after the op for a new one, today's
//   price for a backfilled one), then frozen on the row. A fee whose pool no snapshot prices stays unpriced, and
//   that day's collectedUsdc is left out rather than written short.

import { isAddressEqual, parseAbi, parseEventLogs, type Address, type Hex, type Log } from 'viem'
import { address, baseRegistry, entryPointV07Abi, nameOf } from '@mamoru/registry'
import { inUsdc } from './chain.ts'
import type { StoredOp } from './state.ts'
import type { Snapshot } from './snapshot.ts'

const poolCollectAbi = parseAbi(['event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)'])
const npmEventsAbi = parseAbi([
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
])

export type FeeFact = {
  tokenId: string
  /** Registry name of the pool (pool:USDC/cbBTC/500), from the pool's own Collect right before the manager's. */
  pool: string
  fee0: string
  fee1: string
  /** Raw USDC, set once by the first snapshot that prices the pool. */
  usdc?: string
}

export type OpFacts = {
  /** The transaction these facts were read from: a row whose txHash changed is read again. */
  txHash?: string
  /** Block timestamp, ISO: the UTC day the op counts on. */
  at: string
  gasWei: string
  /** otto/mamoru#219: gasWei in raw USDC, set once by the first snapshot that prices the native asset (WETH/USDC). */
  gasUsdc?: string
  fees: FeeFact[]
}

/**
 * Reads what a receipt says this Safe paid and collected. Pure: the caller fetched `logs` and the block time.
 * With `userOpHash` (an engine op), only that userOp counts: its gas, and the logs it emitted, which in EntryPoint
 * v0.7 sit after the previous UserOperationEvent of the bundle and before its own. The operator's bundler sends one
 * userOp per handleOps (bundler.ts), so this matters only for a bundle someone else built. Without it (an owner
 * transaction, or an engine op stored before its hash was kept) the whole transaction counts.
 */
export function factsFromLogs(logs: Log[], safe: Address, blockTime: bigint, userOpHash?: Hex): OpFacts {
  const entryPoint = address('EntryPointV07', baseRegistry)
  const npm = address('NonfungiblePositionManager', baseRegistry)
  const opEvents = parseEventLogs({ abi: entryPointV07Abi, eventName: 'UserOperationEvent', logs: logs.filter((l) => isAddressEqual(l.address, entryPoint)) })
  let gas = 0n
  if (userOpHash) {
    const i = opEvents.findIndex((e) => e.args.userOpHash.toLowerCase() === userOpHash.toLowerCase() && isAddressEqual(e.args.sender, safe))
    const own = opEvents[i]
    if (!own) return { at: new Date(Number(blockTime) * 1000).toISOString(), gasWei: '0', fees: [] }
    gas = own.args.actualGasCost
    const from = i > 0 ? opEvents[i - 1]!.logIndex : -1
    logs = logs.filter((l) => l.logIndex !== null && l.logIndex > from && l.logIndex < own.logIndex)
  } else {
    for (const e of opEvents) if (isAddressEqual(e.args.sender, safe)) gas += e.args.actualGasCost
  }

  // The pool emits its Collect right before the manager's: the nearest one earlier in the log names the pool.
  const poolCollects = parseEventLogs({ abi: poolCollectAbi, logs: logs.filter((l) => !isAddressEqual(l.address, npm)) })
    .filter((e) => isAddressEqual(e.args.owner, npm))
    .map((e) => ({ logIndex: e.logIndex, pool: e.address }))
  const freed = new Map<bigint, [bigint, bigint]>()
  const collected = new Map<bigint, { pool: string; amounts: [bigint, bigint] }>()
  for (const e of parseEventLogs({ abi: npmEventsAbi, logs: logs.filter((l) => isAddressEqual(l.address, npm)) })) {
    if (e.eventName === 'DecreaseLiquidity') {
      const cur = freed.get(e.args.tokenId) ?? [0n, 0n]
      freed.set(e.args.tokenId, [cur[0] + e.args.amount0, cur[1] + e.args.amount1])
      continue
    }
    if (!isAddressEqual(e.args.recipient, safe)) continue
    const poolAddr = poolCollects.filter((p) => p.logIndex < e.logIndex).at(-1)?.pool
    const pool = poolAddr ? nameOf(poolAddr, baseRegistry) : undefined
    if (!pool) continue
    const cur = collected.get(e.args.tokenId)?.amounts ?? [0n, 0n]
    collected.set(e.args.tokenId, { pool, amounts: [cur[0] + e.args.amount0, cur[1] + e.args.amount1] })
  }
  const fees: FeeFact[] = []
  for (const [tokenId, c] of collected) {
    // packages/projector's splitCollect: the collect pays the freed principal first, never below zero.
    const owed = freed.get(tokenId) ?? [0n, 0n]
    const f = [c.amounts[0] > owed[0] ? c.amounts[0] - owed[0] : 0n, c.amounts[1] > owed[1] ? c.amounts[1] - owed[1] : 0n] as const
    if (f[0] === 0n && f[1] === 0n) continue
    fees.push({ tokenId: tokenId.toString(), pool: c.pool, fee0: f[0].toString(), fee1: f[1].toString() })
  }
  return { at: new Date(Number(blockTime) * 1000).toISOString(), gasWei: gas.toString(), fees }
}

/**
 * An op with a transaction and no facts for that transaction yet, whatever its stored state: an engine op stored
 * `submitted` whose engine stopped before confirming it is still read here, and so is an owner op (a stop or a
 * withdrawal collects the positions' fees to the Safe too; its gas is the relayer's or a refund, not a userOp's, so
 * it counts no gas here: the relayer's side is in acc.sponsored). Finality is not taken from the state
 * but checked on the receipt itself (withReceipts: at or below the chain's `safe` block), so a reorged inclusion
 * is never frozen and an account stopped mid-confirmation still gets its op counted.
 */
export function needsFacts(op: StoredOp): boolean {
  return (op.opId.startsWith('eng-') || op.opId.startsWith('own-')) && !!op.txHash && op.facts?.txHash?.toLowerCase() !== op.txHash.toLowerCase()
}

/** The pool that prices Base gas (chain.ts NATIVE_PRICE_POOLS): ETH and WETH share 18 decimals. */
const NATIVE_POOL = 'pool:WETH/USDC/3000'

/** Sets `gasUsdc`, and `usdc` on every fee, when the snapshot can price them. Returns whether anything changed (the caller saves). */
export function priceFees(facts: OpFacts, pools: Snapshot['pools']): boolean {
  let changed = false
  const native = pools[NATIVE_POOL]
  if (facts.gasUsdc === undefined && native) {
    facts.gasUsdc = inUsdc(NATIVE_POOL, 'WETH', BigInt(facts.gasWei), native.sqrtPriceX96, baseRegistry).toString()
    changed = true
  }
  for (const f of facts.fees) {
    if (f.usdc !== undefined) continue
    const state = pools[f.pool]
    if (!state) continue
    const e = baseRegistry.entries.find((x) => x.name === f.pool)
    if (!e?.token0 || !e.token1) continue
    f.usdc = (inUsdc(f.pool, e.token0, BigInt(f.fee0), state.sqrtPriceX96, baseRegistry) + inUsdc(f.pool, e.token1, BigInt(f.fee1), state.sqrtPriceX96, baseRegistry)).toString()
    changed = true
  }
  return changed
}

export type PositionReceiptWire = { tokenId: string; collected0: string; collected1: string; collectedUsdc?: string }
export type DayReceiptWire = {
  day: string
  gasWei: string
  /** Absent when a fee of the day is not priced yet: the reader leaves the column as it was. */
  collectedUsdc?: string
  positions: PositionReceiptWire[]
}

/**
 * Per-day totals of one account's ops, oldest day first, the whole history: the Worker writes only the days whose
 * digest changed, so a day recovered late (a receipt read after an outage) is still delivered. Days with no op
 * that reached the chain are absent.
 */
export function dayReceipts(ops: readonly StoredOp[]): DayReceiptWire[] {
  const days = new Map<string, { gas: bigint; usdc: bigint; priced: boolean; positions: Map<string, { c0: bigint; c1: bigint; usdc: bigint; priced: boolean }> }>()
  for (const op of ops) {
    const f = op.facts
    if (!f) continue
    const day = f.at.slice(0, 10)
    const d = days.get(day) ?? { gas: 0n, usdc: 0n, priced: true, positions: new Map() }
    days.set(day, d)
    d.gas += BigInt(f.gasWei)
    for (const fee of f.fees) {
      const p = d.positions.get(fee.tokenId) ?? { c0: 0n, c1: 0n, usdc: 0n, priced: true }
      d.positions.set(fee.tokenId, p)
      p.c0 += BigInt(fee.fee0)
      p.c1 += BigInt(fee.fee1)
      if (fee.usdc === undefined) {
        p.priced = false
        d.priced = false
      } else {
        p.usdc += BigInt(fee.usdc)
        d.usdc += BigInt(fee.usdc)
      }
    }
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, d]) => ({
      day,
      gasWei: d.gas.toString(),
      ...(d.priced ? { collectedUsdc: d.usdc.toString() } : {}),
      positions: [...d.positions.entries()].map(([tokenId, p]) => ({ tokenId, collected0: p.c0.toString(), collected1: p.c1.toString(), ...(p.priced ? { collectedUsdc: p.usdc.toString() } : {}) })),
    }))
}

/** What the snapshot wrapper needs from the operator: every account it has stored (stopped ones too), and a way to persist them. */
export type ReceiptSource = {
  accounts(): { accountKey: string; safe: Address; ops: StoredOp[] }[]
  save(): void
}

export type ReceiptReader = (txHash: Hex) => Promise<{ logs: Log[]; blockNumber: bigint } | null>
export type BlockTimeReader = (block: bigint) => Promise<bigint>
/** The chain's `safe` block number: a receipt at or below it is final. */
export type SafeBlockReader = () => Promise<bigint>

/** Receipts read per snapshot tick at most: a backfill of old ops spreads over a few ticks instead of one burst. */
export const FACTS_PER_TICK = 20

export type AccountReceiptsWire = { safe: string; days: DayReceiptWire[] }

/**
 * Reads facts for up to FACTS_PER_TICK ops that need them, prices what the snapshot can, and adds `receipts` for
 * every stored account with an op, whether or not the snapshot read its Safe (an account stopped right after an op
 * still gets that op counted). A receipt counts only once its block is at or below the chain's `safe` block; until
 * then, or when it cannot be read (RPC error, not found, reorged out), the op is tried again later. Ops are taken
 * least recently tried first (`tried`, kept by the caller across ticks), so receipts that keep failing go to the
 * back instead of using every tick. Nothing here throws into the snapshot loop.
 */
export async function withReceipts(snapshot: Snapshot, source: ReceiptSource, readReceipt: ReceiptReader, blockTime: BlockTimeReader, safeBlock: SafeBlockReader, tried: Map<string, number> = new Map()): Promise<Snapshot & { receipts: AccountReceiptsWire[] }> {
  const accounts = source.accounts()
  const due = accounts
    .flatMap((a) => a.ops.filter(needsFacts).map((op) => ({ a, op, key: `${a.accountKey}:${op.opId}` })))
    .sort((x, y) => (tried.get(x.key) ?? -1) - (tried.get(y.key) ?? -1))
    .slice(0, FACTS_PER_TICK)
  let changed = false
  let safe: bigint | null = null
  if (due.length) {
    try {
      safe = await safeBlock()
    } catch (e) {
      console.error('yield-receipts: safe block not read', e instanceof Error ? e.message : String(e))
    }
  }
  const times = new Map<bigint, bigint>()
  for (const { a, op, key } of safe === null ? [] : due) {
    tried.set(key, Date.now())
    try {
      const txHash = op.txHash as Hex
      const r = await readReceipt(txHash)
      if (!r || r.blockNumber > safe!) continue
      const t = times.get(r.blockNumber) ?? (await blockTime(r.blockNumber))
      times.set(r.blockNumber, t)
      op.facts = { txHash, ...factsFromLogs(r.logs, a.safe, t, op.opId.startsWith('eng-') ? op.userOpHash : undefined) }
      tried.delete(key)
      changed = true
    } catch (e) {
      console.error(`yield-receipts: ${a.accountKey.slice(0, 8)} ${op.opId} receipt not read`, e instanceof Error ? e.message : String(e))
    }
  }
  for (const a of accounts) for (const op of a.ops) if (op.facts && priceFees(op.facts, snapshot.pools)) changed = true
  if (changed) source.save()
  const receipts = accounts.map((a) => ({ safe: a.safe, days: dayReceipts(a.ops) })).filter((r) => r.days.length > 0)
  return { ...snapshot, receipts }
}
