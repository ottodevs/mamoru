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
  /** Block timestamp, ISO: the UTC day the op counts on. */
  at: string
  gasWei: string
  fees: FeeFact[]
}

/** Reads what a receipt says this Safe paid and collected. Pure: the caller fetched `logs` and the block time. */
export function factsFromLogs(logs: Log[], safe: Address, blockTime: bigint): OpFacts {
  const entryPoint = address('EntryPointV07', baseRegistry)
  const npm = address('NonfungiblePositionManager', baseRegistry)
  let gas = 0n
  for (const e of parseEventLogs({ abi: entryPointV07Abi, eventName: 'UserOperationEvent', logs: logs.filter((l) => isAddressEqual(l.address, entryPoint)) })) {
    if (isAddressEqual(e.args.sender, safe)) gas += e.args.actualGasCost
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

/** An engine op whose transaction reached the chain and has no facts yet. */
export function needsFacts(op: StoredOp): boolean {
  return op.opId.startsWith('eng-') && !!op.txHash && !op.facts
}

/** Sets `usdc` on every fee the snapshot can price. Returns whether anything changed (the caller saves). */
export function priceFees(facts: OpFacts, pools: Snapshot['pools']): boolean {
  let changed = false
  for (const f of facts.fees) {
    if (f.usdc !== undefined) continue
    const state = pools[f.pool]
    if (!state) continue
    const e = baseRegistry.entries.find((x) => x.name === f.pool)
    if (!e?.token0 || !e.token1) continue
    f.usdc = (inUsdc(f.pool, e.token0, BigInt(f.fee0), state.sqrtPriceX96) + inUsdc(f.pool, e.token1, BigInt(f.fee1), state.sqrtPriceX96)).toString()
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

/** Days a snapshot carries, counting the snapshot's own: a day's totals are final once its ops have facts, and the ledger's rows start 18-oct anyway. Bounds the payload and the Worker's writes per pull. */
export const RECEIPT_DAYS = 7

/** Per-day totals of one account's ops from `since` (UTC YYYY-MM-DD) on, oldest day first. Days with no op that reached the chain are absent. */
export function dayReceipts(ops: readonly StoredOp[], since = ''): DayReceiptWire[] {
  const days = new Map<string, { gas: bigint; usdc: bigint; priced: boolean; positions: Map<string, { c0: bigint; c1: bigint; usdc: bigint; priced: boolean }> }>()
  for (const op of ops) {
    const f = op.facts
    if (!f) continue
    const day = f.at.slice(0, 10)
    if (day < since) continue
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

/** What the snapshot wrapper needs from the operator: the stored ops per account, and a way to persist them. */
export type ReceiptSource = {
  opsOf(accountKey: string): StoredOp[] | undefined
  save(): void
}

export type ReceiptReader = (txHash: Hex) => Promise<{ logs: Log[]; blockNumber: bigint } | null>
export type BlockTimeReader = (block: bigint) => Promise<bigint>

/** Receipts read per snapshot tick at most: a backfill of old ops spreads over a few ticks instead of one burst. */
export const FACTS_PER_TICK = 20

/**
 * Reads facts for up to FACTS_PER_TICK ops that lack them, prices what the snapshot can, and adds `receipts` to
 * every safe. A receipt that cannot be read now (RPC error, not found) is tried again next tick; nothing here
 * throws into the snapshot loop.
 */
export async function withReceipts(snapshot: Snapshot, source: ReceiptSource, readReceipt: ReceiptReader, blockTime: BlockTimeReader): Promise<Snapshot & { safes: (Snapshot['safes'][number] & { receipts: DayReceiptWire[] })[] }> {
  let budget = FACTS_PER_TICK
  let changed = false
  const times = new Map<bigint, bigint>()
  for (const safe of snapshot.safes) {
    for (const op of source.opsOf(safe.accountKey) ?? []) {
      if (budget > 0 && needsFacts(op)) {
        budget--
        try {
          const r = await readReceipt(op.txHash as Hex)
          if (r) {
            const t = times.get(r.blockNumber) ?? (await blockTime(r.blockNumber))
            times.set(r.blockNumber, t)
            op.facts = factsFromLogs(r.logs, safe.safe, t)
            changed = true
          }
        } catch (e) {
          console.error(`yield-receipts: ${safe.accountKey.slice(0, 8)} ${op.opId} receipt not read`, e instanceof Error ? e.message : String(e))
        }
      }
      if (op.facts && priceFees(op.facts, snapshot.pools)) changed = true
    }
  }
  if (changed) source.save()
  const since = new Date(Date.parse(snapshot.readAt) - (RECEIPT_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
  return { ...snapshot, safes: snapshot.safes.map((s) => ({ ...s, receipts: dayReceipts(source.opsOf(s.accountKey) ?? [], since) })) }
}
