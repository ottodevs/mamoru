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
import { isChainId, chainOf } from '@mamoru/domain'
import { address, baseRegistry, entryPointV07Abi, nameOf, type Registry } from '@mamoru/registry'
import { inUsdc, nativePricePool } from './chain.ts'
import type { StoredOp } from './state.ts'
import type { Snapshot } from './snapshot.ts'

const poolCollectAbi = parseAbi(['event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)'])
// spec 012 HRV-R5: the ERC-4626 flows of this Safe's own shares (owner = Safe), so vault yield is counted only on the
// shares engine and owner ops explain (yield = shares × the change in assets per share between flows).
const vaultEventsAbi = parseAbi([
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
])
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
  /** spec 012 HRV-R5: the position manager's Collect log index: with the txHash it is the income event's id. */
  logIndex?: number
  /**
   * A piece of a fee the older layout read but never priced: it is never priced now (today's price would rewrite
   * history), so its day stays not counted rather than retro-priced.
   */
  noLatePrice?: true
}

/** spec 012 HRV-R5: one ERC-4626 Deposit or Withdraw of this Safe's own shares, in a registry vault. */
export type VaultFlow = { vault: string; kind: 'deposit' | 'withdraw'; assets: string; shares: string; logIndex: number }

/** The facts layout this reader writes. Facts of an older layout are read again (prices kept), so history gains the new fields. */
export const FACTS_VERSION = 2

export type OpFacts = {
  /** The transaction these facts were read from: a row whose txHash changed is read again. */
  txHash?: string
  /** Block timestamp, ISO: the UTC day the op counts on. */
  at: string
  gasWei: string
  /** otto/mamoru#219: gasWei in raw USDC, set once by the first snapshot that prices the native asset (WETH/USDC). */
  gasUsdc?: string
  fees: FeeFact[]
  /**
   * otto/mamoru#371: the account was in the yield fee's scope both when the op was recorded (StoredOp.feeScoped) and when
   * these facts were taken. Only such facts are the fee's base: yield collected while out of scope is never charged.
   */
  feeable?: true
  /** FACTS_VERSION when read; absent on facts read before spec 012. */
  v?: number
  /** spec 012: the block the receipt was included in (decimal). */
  block?: string
  /** spec 012 HRV-R5: vault flows of this Safe in the op. Absent: none. */
  vaultFlows?: VaultFlow[]
}

/**
 * Reads what a receipt says this Safe paid and collected. Pure: the caller fetched `logs` and the block time.
 * With `userOpHash` (an engine op), only that userOp counts: its gas, and the logs it emitted, which in EntryPoint
 * v0.7 sit after the previous UserOperationEvent of the bundle and before its own. The operator's bundler sends one
 * userOp per handleOps (bundler.ts), so this matters only for a bundle someone else built. Without it (an owner
 * transaction, or an engine op stored before its hash was kept) the whole transaction counts.
 */
export function factsFromLogs(logs: Log[], safe: Address, blockTime: bigint, userOpHash?: Hex, registry: Registry = baseRegistry): OpFacts {
  // otto/mamoru#358: the chain's own contracts; Monad's position manager is another address than Base's.
  const entryPoint = address('EntryPointV07', registry)
  const npm = address('NonfungiblePositionManager', registry)
  const opEvents = parseEventLogs({ abi: entryPointV07Abi, eventName: 'UserOperationEvent', logs: logs.filter((l) => isAddressEqual(l.address, entryPoint)) })
  let gas = 0n
  if (userOpHash) {
    const i = opEvents.findIndex((e) => e.args.userOpHash.toLowerCase() === userOpHash.toLowerCase() && isAddressEqual(e.args.sender, safe))
    const own = opEvents[i]
    if (!own) return { at: new Date(Number(blockTime) * 1000).toISOString(), gasWei: '0', fees: [], v: FACTS_VERSION }
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
  // packages/projector's splitCollect: a collect pays the principal a decrease freed first, never below zero. Decreases
  // and collects are taken together in log order, so principal counts only from the decrease that frees it on, and each
  // collect is its own fee (spec 012: one income event per Collect log).
  const freed = new Map<bigint, [bigint, bigint]>()
  const fees: FeeFact[] = []
  const npmLogs = parseEventLogs({ abi: npmEventsAbi, logs: logs.filter((l) => isAddressEqual(l.address, npm)) }).sort((a, b) => a.logIndex - b.logIndex)
  for (const e of npmLogs) {
    const owed = freed.get(e.args.tokenId) ?? [0n, 0n]
    if (e.eventName === 'DecreaseLiquidity') {
      freed.set(e.args.tokenId, [owed[0] + e.args.amount0, owed[1] + e.args.amount1])
      continue
    }
    if (!isAddressEqual(e.args.recipient, safe)) continue
    const poolAddr = poolCollects.filter((p) => p.logIndex < e.logIndex).at(-1)?.pool
    const pool = poolAddr ? nameOf(poolAddr, registry) : undefined
    if (!pool) continue
    const a = [e.args.amount0, e.args.amount1] as const
    const f = [a[0] > owed[0] ? a[0] - owed[0] : 0n, a[1] > owed[1] ? a[1] - owed[1] : 0n] as const
    freed.set(e.args.tokenId, [owed[0] > a[0] ? owed[0] - a[0] : 0n, owed[1] > a[1] ? owed[1] - a[1] : 0n])
    if (f[0] === 0n && f[1] === 0n) continue
    fees.push({ tokenId: e.args.tokenId.toString(), pool, fee0: f[0].toString(), fee1: f[1].toString(), logIndex: e.logIndex })
  }
  const vaults = registry.entries.filter((x) => x.kind === 'vault')
  // MamoruActionPolicyV4.redeem pulls the Safe's shares and redeems them as their owner, paying the Safe: its Withdraw
  // has owner = V4 and receiver = the Safe. Those are the Safe's shares leaving too.
  const v4 = registry.entries.filter((x) => x.name === 'MamoruActionPolicyV4').map((x) => x.address)
  const vaultFlows: VaultFlow[] = []
  for (const e of parseEventLogs({ abi: vaultEventsAbi, logs: logs.filter((l) => vaults.some((v) => isAddressEqual(l.address, v.address))) })) {
    const viaV4 = e.eventName === 'Withdraw' && isAddressEqual(e.args.receiver, safe) && v4.some((a) => isAddressEqual(e.args.owner, a))
    if (!isAddressEqual(e.args.owner, safe) && !viaV4) continue
    const vault = vaults.find((v) => isAddressEqual(e.address, v.address))!.name
    vaultFlows.push({ vault, kind: e.eventName === 'Deposit' ? 'deposit' : 'withdraw', assets: e.args.assets.toString(), shares: e.args.shares.toString(), logIndex: e.logIndex })
  }
  return { at: new Date(Number(blockTime) * 1000).toISOString(), gasWei: gas.toString(), fees, v: FACTS_VERSION, ...(vaultFlows.length ? { vaultFlows } : {}) }
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
  if (!(op.opId.startsWith('eng-') || op.opId.startsWith('own-')) || !op.txHash) return false
  return op.facts?.txHash?.toLowerCase() !== op.txHash.toLowerCase() || (op.facts.v ?? 1) < FACTS_VERSION
}

/** A receipt not found this many times over at least GIVE_UP_MS stops holding the account's vault state as unknown. */
export const GIVE_UP_MISSES = 20
export const GIVE_UP_MS = 24 * 3_600_000

/** The op's receipt keeps failing (spec 012, #305 review): still retried, but no longer blocks `explained`; the account's vault yield is partial instead. */
export function gaveUp(op: StoredOp): boolean {
  const m = op.factsMisses
  // Misses count for the hash they were recorded against: a replaced transaction starts again.
  return !!m && m.txHash?.toLowerCase() === op.txHash?.toLowerCase() && m.count >= GIVE_UP_MISSES && Date.now() - m.first >= GIVE_UP_MS
}

/**
 * An engine or owner op on its way (no receipt read can exist yet): what it moves is not in any flow until it lands.
 * An engine proposal never sent is dropped by the next engine tick, which proposes a new op: once a later op of the
 * account has landed, the old proposal is not on its way. Kept unknown forever it held one beta account's vault yield
 * unpriced from 6 Nov, which withheld every Stats series.
 */
const inFlight = (op: StoredOp, ops: readonly StoredOp[]): boolean => {
  if (!(op.opId.startsWith('eng-') || op.opId.startsWith('own-')) || op.txHash) return false
  if (op.state === 'submitted') return true
  if (op.state !== 'proposed') return false
  // Times compared as instants: stored ops mix second and millisecond precision, so their strings do not sort.
  const at = Date.parse(op.updatedAt)
  return !(op.opId.startsWith('eng-') && Number.isFinite(at) && ops.some((o) => o.state === 'confirmed' && Date.parse(o.updatedAt) > at))
}

/**
 * Facts read again for a newer layout keep what the old ones had priced: a price is frozen at the first snapshot after
 * the op, and today's would rewrite history.
 */
export function keepPrices(next: OpFacts, prev: OpFacts | undefined): OpFacts {
  if (!prev || prev.txHash?.toLowerCase() !== next.txHash?.toLowerCase()) return next
  const gas = prev.gasUsdc !== undefined && prev.gasWei === next.gasWei ? { gasUsdc: prev.gasUsdc } : {}
  if ((prev.v ?? 1) >= FACTS_VERSION) {
    // Same layout read again (a reorg check): a piece keeps its price only when it is the very same collect.
    const fees = next.fees.map((f) => {
      const same = prev.fees.find((o) => o.tokenId === f.tokenId && o.logIndex === f.logIndex && o.fee0 === f.fee0 && o.fee1 === f.fee1)
      return same?.usdc !== undefined ? { ...f, usdc: same.usdc } : f
    })
    return { ...next, fees, ...gas }
  }
  // An older layout: its per-position totals stay authoritative (#305 review). The re-read only adds where each collect
  // sits (log index): pieces are capped to the legacy amounts in log order, the remainder goes to the first piece, the
  // frozen price goes whole to the first piece and 0 to the rest, a position the old read had no fee for gets none, and
  // a legacy fee never priced is never priced now. Day totals, prices and the yield fee's base do not move.
  const fees: FeeFact[] = []
  for (const legacy of prev.fees) {
    const pieces = next.fees.filter((f) => f.tokenId === legacy.tokenId).sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0))
    let r0 = BigInt(legacy.fee0)
    let r1 = BigInt(legacy.fee1)
    const out: FeeFact[] = []
    for (const p of pieces) {
      const c0 = BigInt(p.fee0) < r0 ? BigInt(p.fee0) : r0
      const c1 = BigInt(p.fee1) < r1 ? BigInt(p.fee1) : r1
      r0 -= c0
      r1 -= c1
      if (c0 === 0n && c1 === 0n) continue
      out.push({ tokenId: legacy.tokenId, pool: legacy.pool, fee0: c0.toString(), fee1: c1.toString(), ...(p.logIndex !== undefined ? { logIndex: p.logIndex } : {}) })
    }
    if (!out.length) {
      fees.push(legacy)
      continue
    }
    out[0] = { ...out[0]!, fee0: (BigInt(out[0]!.fee0) + r0).toString(), fee1: (BigInt(out[0]!.fee1) + r1).toString() }
    out.forEach((f, i) => fees.push(legacy.usdc !== undefined ? { ...f, usdc: i === 0 ? legacy.usdc : '0' } : { ...f, noLatePrice: true }))
  }
  return { ...next, fees, ...gas }
}

/** Sets `gasUsdc`, and `usdc` on every fee, when the snapshot can price them. Returns whether anything changed (the caller saves).
 * Gas is priced by the chain's native pool (chain.ts NATIVE_PRICE_POOLS: WETH/USDC on Base, WMON/USDC on Monad), the
 * native asset and its wrapped token sharing 18 decimals. */
export function priceFees(facts: OpFacts, pools: Snapshot['pools'], registry: Registry = baseRegistry): boolean {
  let changed = false
  const nativePool = nativePricePool(registry)
  const native = pools[nativePool]
  const wrapped = isChainId(registry.chainId) ? chainOf(registry.chainId).wrappedNative : 'WETH'
  if (facts.gasUsdc === undefined && native) {
    facts.gasUsdc = inUsdc(nativePool, wrapped, BigInt(facts.gasWei), native.sqrtPriceX96, registry).toString()
    changed = true
  }
  for (const f of facts.fees) {
    if (f.usdc !== undefined || f.noLatePrice) continue
    const state = pools[f.pool]
    if (!state) continue
    const e = registry.entries.find((x) => x.name === f.pool)
    if (!e?.token0 || !e.token1) continue
    f.usdc = (inUsdc(f.pool, e.token0, BigInt(f.fee0), state.sqrtPriceX96, registry) + inUsdc(f.pool, e.token1, BigInt(f.fee1), state.sqrtPriceX96, registry)).toString()
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
  /** otto/mamoru#371: whether the account is in the yield fee's scope now. Absent: never (no fee on this chain). */
  feeScope?(accountKey: string): boolean
}

export type ReceiptReader = (txHash: Hex) => Promise<{ logs: Log[]; blockNumber: bigint } | null>
export type BlockTimeReader = (block: bigint) => Promise<bigint>
/** The chain's `safe` block number: a receipt at or below it is final. */
export type SafeBlockReader = () => Promise<bigint>

/** Receipts read per snapshot tick at most: a backfill of old ops spreads over a few ticks instead of one burst. */
export const FACTS_PER_TICK = 20

/** spec 012 HRV-R5: one fee income event; `id` = `<txHash>:<logIndex>`, `t` = block time (unix s). */
export type IncomeEventWire = { id: string; t: number; source: 'harvest' | 're-range'; usdc?: string }
export type VaultFlowWire = VaultFlow & { id: string; t: number; block?: number }
/**
 * spec 012 HRV-R5: every vault flow of the account and, per vault, the shares those flows explain (deposits − withdraws).
 * `explained` is null while any op of the account still waits for its receipt: until then the sum may be short.
 */
/** `incomplete`: a receipt was given up on (gaveUp), so `explained` may be short: the Worker counts the vault as partial. */
export type AccountVaultWire = { flows: VaultFlowWire[]; explained: Record<string, string> | null; incomplete?: true }
export type AccountReceiptsWire = { safe: string; days: DayReceiptWire[]; events?: IncomeEventWire[]; vault?: AccountVaultWire }

/** The fee events of stored ops with facts of the current layout; an op's step says whether it was a harvest. */
export function incomeEvents(ops: readonly StoredOp[]): IncomeEventWire[] {
  // One event per id: two stored ops can read the same transaction (an op stored without its userOp hash).
  const out = new Map<string, IncomeEventWire & { block: number; logIndex: number }>()
  for (const op of ops) {
    const f = op.facts
    if (!f?.txHash || (f.v ?? 1) < FACTS_VERSION) continue
    const t = Math.floor(Date.parse(f.at) / 1000)
    for (const fee of f.fees) {
      if (fee.logIndex === undefined) continue
      const id = `${f.txHash.toLowerCase()}:${fee.logIndex}`
      if (!out.has(id)) out.set(id, { id, t, source: op.step === 'harvest' ? 'harvest' : 're-range', ...(fee.usdc !== undefined ? { usdc: fee.usdc } : {}), block: Number(f.block ?? 0), logIndex: fee.logIndex })
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t || a.block - b.block || a.logIndex - b.logIndex).map(({ block: _b, logIndex: _l, ...e }) => e)
}

/** spec 012 HRV-R5: the account's vault flows, oldest first, and the shares they explain per vault. */
export function vaultWire(ops: readonly StoredOp[]): AccountVaultWire | undefined {
  // One flow per id (two stored ops can read the same transaction), in chain order: block, then log index.
  const byId = new Map<string, VaultFlowWire>()
  for (const op of ops) {
    const f = op.facts
    if (!f?.txHash || (f.v ?? 1) < FACTS_VERSION) continue
    const t = Math.floor(Date.parse(f.at) / 1000)
    for (const v of f.vaultFlows ?? []) {
      const id = `${f.txHash.toLowerCase()}:${v.logIndex}`
      if (!byId.has(id)) byId.set(id, { ...v, id, t, block: Number(f.block ?? 0) })
    }
  }
  const flows = [...byId.values()]
  // Unknown while a receipt is due (not given up on) or an engine op is on its way; a receipt given up on makes it partial.
  const pending = ops.some((o) => (needsFacts(o) && !gaveUp(o)) || inFlight(o, ops))
  const incomplete = ops.some((o) => needsFacts(o) && gaveUp(o))
  // No flow read yet but receipts still due: say "unknown", not "none", or a vault held since before would count as unexplained-zero.
  if (!flows.length) return pending ? { flows, explained: null } : incomplete ? { flows, explained: {}, incomplete: true } : undefined
  flows.sort((a, b) => a.t - b.t || (a.block ?? 0) - (b.block ?? 0) || a.logIndex - b.logIndex)
  const explained: Record<string, bigint> = {}
  for (const v of flows) explained[v.vault] = (explained[v.vault] ?? 0n) + (v.kind === 'deposit' ? BigInt(v.shares) : -BigInt(v.shares))
  return { flows, explained: pending ? null : Object.fromEntries(Object.entries(explained).map(([k, n]) => [k, (n < 0n ? 0n : n).toString()])), ...(incomplete && !pending ? { incomplete: true as const } : {}) }
}

/**
 * Reads facts for up to FACTS_PER_TICK ops that need them, prices what the snapshot can, and adds `receipts` for
 * every stored account with an op, whether or not the snapshot read its Safe (an account stopped right after an op
 * still gets that op counted). A receipt counts only once its block is at or below the chain's `safe` block; until
 * then, or when it cannot be read (RPC error, not found, reorged out), the op is tried again later. Ops are taken
 * least recently tried first (`tried`, kept by the caller across ticks), so receipts that keep failing go to the
 * back instead of using every tick. Nothing here throws into the snapshot loop.
 */
export async function withReceipts(snapshot: Snapshot, source: ReceiptSource, readReceipt: ReceiptReader, blockTime: BlockTimeReader, safeBlock: SafeBlockReader, tried: Map<string, number> = new Map(), registry: Registry = baseRegistry): Promise<Snapshot & { receipts: AccountReceiptsWire[] }> {
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
      if (!r) {
        const same = op.factsMisses?.txHash?.toLowerCase() === txHash.toLowerCase()
        op.factsMisses = { txHash, count: (same ? op.factsMisses!.count : 0) + 1, first: same ? op.factsMisses!.first : Date.now() }
        changed = true
        continue
      }
      if (r.blockNumber > safe!) continue
      const t = times.get(r.blockNumber) ?? (await blockTime(r.blockNumber))
      times.set(r.blockNumber, t)
      const read: OpFacts = { txHash, ...factsFromLogs(r.logs, a.safe, t, op.opId.startsWith('eng-') ? op.userOpHash : undefined, registry), block: r.blockNumber.toString() }
      // A layout upgrade keeps the old fee scope too: it was decided when the facts were first taken (#371).
      const upgrade = op.facts?.txHash?.toLowerCase() === txHash.toLowerCase()
      const feeable = upgrade ? op.facts!.feeable === true : !!(op.feeScoped && source.feeScope?.(a.accountKey))
      op.facts = { ...keepPrices(read, op.facts), ...(feeable ? { feeable: true as const } : {}) }
      delete op.factsMisses
      tried.delete(key)
      changed = true
    } catch (e) {
      console.error(`yield-receipts: ${a.accountKey.slice(0, 8)} ${op.opId} receipt not read`, e instanceof Error ? e.message : String(e))
    }
  }
  for (const a of accounts) for (const op of a.ops) if (op.facts && priceFees(op.facts, snapshot.pools, registry)) changed = true
  if (changed) source.save()
  const receipts = accounts
    .map((a) => {
      const events = incomeEvents(a.ops)
      const vault = vaultWire(a.ops)
      return { safe: a.safe, days: dayReceipts(a.ops), ...(events.length ? { events } : {}), ...(vault ? { vault } : {}) }
    })
    // An account with no day yet still goes out when its vault state is unknown: "pending" must reach the Worker, not "none".
    .filter((r) => r.days.length > 0 || r.vault !== undefined || r.events !== undefined)
  return { ...snapshot, receipts }
}
