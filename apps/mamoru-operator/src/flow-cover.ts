// otto/mamoru#438: the operator vouches for an account's flows, so the Worker can call its net deposited complete.
//
// What it vouches, per account and chain (`FlowCoverWire` on the snapshot's receipts entry):
// - `from`: the block from which every incoming USDC Transfer to the Safe has been read without a hole, AND before which
//   the Safe held nothing: at from - 1 it had no code yet (so it had opened no position, vault or pool of its own) and a
//   dust USDC balance (both read once, verifyCovers), and no op of the account is older than `from`. So every USDC the
//   Safe ever received is a recorded deposit or a listed mint. The deposit look
//   (operator.ts lookForDeposits) sets it where a Safe's first look starts, and moves it up to where a look starts again
//   after a hole (depositRange skips a Safe nobody looked at for longer than its backfill). A start that is not proven
//   (a balance there, an op before it, or a look that began before this field existed) is read back by the log
//   backfill below, 30 days further each time, until it is.
// - `through`: the snapshot's block, when the deposit look's final cursor plus one read of (cursor, block] found no
//   deposit and no mint the operator has not recorded yet. Absent: something arrived that is not on the wire yet.
// - `open`: what the operator cannot vouch for right now (a deposit or mint list at its cap, a withdrawal whose receipt
//   has not given it a date). Sent whole on every snapshot, so a reason that clears is gone at the next pull.
// - `mints`: USDC minted to the Safe (CCTP), which the deposit look never counts as a deposit. The Worker matches each
//   one with a transfer between the owner's own Safes; one that matches none is money it cannot place.
//
// The log backfill: one job per operator (chain), the incoming USDC Transfers to every Safe that needs it in one
// topic-OR filter, BACKFILL_PAGES_PER_TICK pages per snapshot tick and none over the RPC budget. When the job has read
// its range, each of its accounts is covered from the job's start.
import { parseAbiItem, type Address, type Hex } from 'viem'
import type { Registry } from '@mamoru/registry'
import { DEPOSIT_MIN_USDC, DEPOSIT_PAGE_BLOCKS, DEPOSITS_KEPT, depositsOf, mergeDeposits, type DepositRow } from './deposits.ts'
import { accountFlows } from './flows.ts'
import type { Snapshot } from './snapshot.ts'
import type { AccountState, StoredOp } from './state.ts'
import type { AccountReceiptsWire } from './yield-receipts.ts'

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const ZERO = '0x0000000000000000000000000000000000000000'
const BALANCE_OF = [parseAbiItem('function balanceOf(address) view returns (uint256)')]

/** USDC minted to the Safe (a CCTP leg). `at`: the block's time (ISO), or when it was found if the node gave none. */
export type MintRow = { txHash: Hex; logIndex: number; block: string; amountUsdc: string; at: string }
/** Where the account's flows are vouched from. `backfill`: the look started again after a hole; the job must read it. */
export type FlowCover = { safe: string; fromBlock: string; backfill?: true; /** The Safe held only dust at fromBlock - 1 and no op is older (verifyCovers). */ verified?: true }
/** The log backfill in progress: [from, to] for these Safes, read up to `next` - 1. */
export type FlowBackfillJob = { from: string; to: string; next: string; accounts: { accountKey: string; safe: string }[] }
export type FlowCoverWire = { from: number; through?: number; open: string[]; mints: { block: number; t: number; usdc: string }[] }

/** Mint rows kept per account. At the cap the cover says `mints-cap`: one more could not be listed. */
export const MINTS_KEPT = 200
/** How far before an account's first known block the backfill starts: 30 days of Base blocks (2 s). */
export const BACKFILL_MARGIN_BLOCKS = 1_296_000n
/** At most this many pages for one job; a longer history starts at to - BACKFILL_MAX_PAGES pages. */
export const BACKFILL_MAX_PAGES = 4_000n
/** Pages of the backfill read per snapshot tick (5 min): about 120 eth_getLogs an hour while a job runs. */
export const BACKFILL_PAGES_PER_TICK = 10
/** Pages the `through` check may read per tick; an account whose cursor is further behind is not vouched this tick. */
export const SWEEP_MAX_PAGES = 4n

type TransferLog = { args?: { from?: Address; to?: Address; value?: bigint }; transactionHash?: Hex | null; logIndex?: number | null; blockNumber?: bigint | null; blockTimestamp?: bigint | number | null }

/** The mints among USDC Transfer logs to `safe`, not of the account's own transactions; dust left out (DEPOSIT_MIN_USDC). */
export function mintsOf(logs: readonly TransferLog[], safe: Address, foundAt: string, ownTx: ReadonlySet<string> = new Set()): MintRow[] {
  const out: MintRow[] = []
  for (const l of logs) {
    const value = l.args?.value
    if (l.args?.from?.toLowerCase() !== ZERO || typeof value !== 'bigint' || value < DEPOSIT_MIN_USDC || !l.transactionHash || l.logIndex == null || l.blockNumber == null) continue
    if (l.args?.to?.toLowerCase() !== safe.toLowerCase() || ownTx.has(l.transactionHash.toLowerCase())) continue
    const ts = l.blockTimestamp == null ? null : Number(l.blockTimestamp)
    out.push({ txHash: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber.toString(), amountUsdc: value.toString(), at: ts ? new Date(ts * 1000).toISOString() : foundAt })
  }
  return out
}

/** `kept` with the rows of `found` it does not hold yet, in chain order, at most `max` (the oldest kept: the cover says when it is full). */
export function mergeMints(kept: readonly MintRow[], found: readonly MintRow[], max = MINTS_KEPT): MintRow[] {
  const id = (m: MintRow) => `${m.txHash.toLowerCase()}:${m.logIndex}`
  const have = new Set(kept.map(id))
  const added = found.filter((m) => !have.has(id(m)) && (have.add(id(m)), true))
  if (!added.length) return [...kept]
  return [...kept, ...added].sort((a, b) => (BigInt(a.block) === BigInt(b.block) ? a.logIndex - b.logIndex : BigInt(a.block) < BigInt(b.block) ? -1 : 1)).slice(0, max)
}

/**
 * The cover after a deposit look read from `rangeFrom` on, its cursor having been `cursor` before (undefined: no cursor
 * for this Safe). A first look covers from where it started; a look that starts past cursor + 1 skipped a hole and
 * covers only from there, until the backfill reads the hole. A look that goes on from its cursor changes nothing; an
 * account whose cursor predates the cover keeps none (the backfill gives it one).
 */
export function coverAfterLook(cover: FlowCover | undefined, safe: string, cursor: bigint | undefined, rangeFrom: bigint): FlowCover | undefined {
  const at = safe.toLowerCase()
  if (cursor === undefined) return { safe: at, fromBlock: rangeFrom.toString() }
  if (rangeFrom > cursor + 1n) return { safe: at, fromBlock: rangeFrom.toString(), backfill: true }
  return cover?.safe === at ? cover : undefined
}

/** A confirmed owner withdrawal flows.ts cannot date yet (no receipt facts, or none ever): not on the wire, so not vouched. */
function undatedOut(op: StoredOp): boolean {
  if (op.kind !== 'transfer' || op.state !== 'confirmed' || !op.opId.startsWith('own-') || !op.amountUsdc || !/^\d+$/.test(op.amountUsdc) || BigInt(op.amountUsdc) <= 0n) return false
  const at = op.txHash && op.facts?.txHash?.toLowerCase() === op.txHash.toLowerCase() ? op.facts.at : undefined
  return at === undefined || !Number.isFinite(Date.parse(at))
}

const seconds = (iso: string): number | null => {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** What the account's receipts entry carries: undefined without a cover for its current Safe or while its hole is unread. */
export function coverWire(acc: Pick<AccountState, 'deposits' | 'ops' | 'flowCover' | 'flowMints'>, safe: string, through: bigint | undefined): FlowCoverWire | undefined {
  const c = acc.flowCover
  if (!c || c.safe !== safe.toLowerCase() || c.backfill || !c.verified) return undefined
  const open: string[] = []
  if ((acc.deposits?.length ?? 0) >= DEPOSITS_KEPT) open.push('deposits-cap')
  if ((acc.flowMints?.length ?? 0) >= MINTS_KEPT) open.push('mints-cap')
  for (const op of acc.ops) if (undatedOut(op)) open.push(`out:${op.opId}`)
  const mints = (acc.flowMints ?? []).flatMap((m) => {
    const t = seconds(m.at)
    return t === null ? [] : [{ block: Number(m.block), t, usdc: m.amountUsdc }]
  })
  if (mints.length < (acc.flowMints?.length ?? 0)) open.push('mint-undated')
  return { from: Number(c.fromBlock), ...(through !== undefined ? { through: Number(through) } : {}), open, mints }
}

/** One account as the cover reads it: its state and the USDC it counts (the policy's savings asset). */
export type CoverAccount = { acc: AccountState; usdc: Address }
export type CoverSource = {
  accounts(): CoverAccount[]
  registry: Registry
  /** Incoming USDC Transfer logs to any of `safes` in [from, to] (one topic-OR request). */
  readLogs(usdc: Address, safes: Address[], from: bigint, to: bigint): Promise<TransferLog[]>
  /** A block's time (unix seconds), for a row whose log the node served without one. */
  blockTime(block: bigint): Promise<bigint>
  /** The Safe's USDC balance at the end of `block` (an archive read). */
  balanceAt(usdc: Address, safe: Address, block: bigint): Promise<bigint>
  /** Whether the Safe had code at the end of `block` (an archive read). */
  deployedAt(safe: Address, block: bigint): Promise<boolean>
  job(): FlowBackfillJob | undefined
  setJob(job: FlowBackfillJob | undefined): void
  save(): void
  overBudget(): boolean
}

const ownTxOf = (acc: AccountState) => new Set(acc.ops.flatMap((o) => (o.txHash ? [o.txHash.toLowerCase()] : [])))
/** The oldest block the account is known to have acted at: its activation, any op of it. */
function firstOp(acc: AccountState): bigint | undefined {
  const known = [...(BigInt(acc.historyFromBlock || '0') > 0n ? [BigInt(acc.historyFromBlock)] : []), ...acc.ops.flatMap((o) => (o.block !== undefined && /^\d+$/.test(String(o.block)) ? [BigInt(o.block)] : []))]
  return known.length ? known.reduce((a, b) => (b < a ? b : a)) : undefined
}
const cursorOf = (acc: AccountState): bigint | undefined => (acc.depositsSeen && acc.depositsSeen.safe === acc.ctx.address.toLowerCase() ? BigInt(acc.depositsSeen.block) : undefined)

/**
 * A new backfill job, or undefined when no account needs one. Needs one: an account whose look has a cursor but no cover
 * (its look began before the cover existed), whose look skipped a hole or found a balance before its start (`backfill`),
 * or whose cover starts after an op of the account. Its range starts BACKFILL_MARGIN_BLOCKS before the earliest block
 * known of any of them (an op, the activation, the cursor, the cover's start) and ends at the latest cursor (or the
 * block before the cover). A start that is still not proven after the job is read back again (verifyCovers).
 */
export function planBackfill(accounts: readonly CoverAccount[]): FlowBackfillJob | undefined {
  let from: bigint | undefined
  let to = 0n
  const need: { accountKey: string; safe: string }[] = []
  for (const { acc } of accounts) {
    const safe = acc.ctx.address.toLowerCase()
    const cursor = cursorOf(acc)
    if (cursor === undefined) continue
    const c = acc.flowCover?.safe === safe ? acc.flowCover : undefined
    const op = firstOp(acc)
    const known = [cursor, ...(op !== undefined ? [op] : []), ...(c ? [BigInt(c.fromBlock)] : [])]
    const first = known.reduce((a, b) => (b < a ? b : a))
    // A cover from before every op of the account waits for its balance check; one that starts after an op (its first
    // look came late) cannot be proven, so it is read back.
    if (c && !c.backfill && (op === undefined || BigInt(c.fromBlock) <= op)) continue
    const end = c ? BigInt(c.fromBlock) - 1n : cursor
    const start = first > BACKFILL_MARGIN_BLOCKS ? first - BACKFILL_MARGIN_BLOCKS : 0n
    from = from === undefined || start < from ? start : from
    if (end > to) to = end
    need.push({ accountKey: acc.accountKey, safe })
  }
  if (!need.length || from === undefined) return undefined
  const max = BACKFILL_MAX_PAGES * DEPOSIT_PAGE_BLOCKS
  if (to - from + 1n > max) from = to - max + 1n
  return { from: from.toString(), to: to.toString(), next: from.toString(), accounts: need }
}

/** When the job has read its range: each of its accounts still on that Safe is covered from the job's start, if no hole opened after the job's end. */
export function finishBackfill(job: FlowBackfillJob, accounts: readonly CoverAccount[]): void {
  const byKey = new Map(accounts.map((a) => [a.acc.accountKey, a.acc]))
  for (const j of job.accounts) {
    const acc = byKey.get(j.accountKey)
    if (!acc || acc.ctx.address.toLowerCase() !== j.safe) continue
    const c = acc.flowCover?.safe === j.safe ? acc.flowCover : undefined
    // No cover: the look has gone on from a cursor at or below the job's end. A cover that started again after a hole
    // is covered only if the job reached the block before it; a later hole waits for the next job.
    if (!c || BigInt(c.fromBlock) <= BigInt(job.to) + 1n) acc.flowCover = { safe: j.safe, fromBlock: job.from }
  }
}

/** Runs up to `pages` pages of the backfill (planning one when none runs). Never throws: a failed page is read again next tick. */
export async function backfillTick(src: CoverSource, pages = BACKFILL_PAGES_PER_TICK): Promise<void> {
  if (src.overBudget()) return
  const accounts = src.accounts()
  let job = src.job()
  if (!job) {
    job = planBackfill(accounts)
    if (!job) return
    src.setJob(job)
    src.save()
    console.log(`[flow-cover] backfill of ${job.accounts.length} Safe${job.accounts.length === 1 ? '' : 's'}, blocks ${job.from}..${job.to}`)
  }
  const inJob = accounts.filter((a) => job!.accounts.some((j) => j.accountKey === a.acc.accountKey && j.safe === a.acc.ctx.address.toLowerCase()))
  const byUsdc = new Map<string, CoverAccount[]>()
  for (const a of inJob) byUsdc.set(a.usdc.toLowerCase(), [...(byUsdc.get(a.usdc.toLowerCase()) ?? []), a])
  const foundAt = new Date().toISOString()
  try {
    for (let i = 0; i < pages && BigInt(job.next) <= BigInt(job.to); i++) {
      const from = BigInt(job.next)
      const to = from + DEPOSIT_PAGE_BLOCKS - 1n < BigInt(job.to) ? from + DEPOSIT_PAGE_BLOCKS - 1n : BigInt(job.to)
      for (const [, group] of byUsdc) {
        const logs = await src.readLogs(group[0]!.usdc, group.map((a) => a.acc.ctx.address as Address), from, to)
        // Rows are dated before any is kept: a row dated when it was found would be a months-old deposit dated today.
        const rows = group.map(({ acc }) => ({ acc, ...rowsOf(acc, logs, src.registry, foundAt) }))
        const times = new Map<string, string>()
        for (const r of rows) for (const x of [...r.deposits, ...r.mints]) if (x.at === foundAt && !times.has(x.block)) times.set(x.block, new Date(Number(await src.blockTime(BigInt(x.block))) * 1000).toISOString())
        for (const r of rows) {
          for (const x of [...r.deposits, ...r.mints]) if (x.at === foundAt) x.at = times.get(x.block)!
          keep(r.acc, r.deposits, r.mints)
        }
      }
      job.next = (to + 1n).toString()
    }
  } catch (e) {
    console.error('[flow-cover] backfill page failed', e instanceof Error ? e.message : String(e))
  }
  if (BigInt(job.next) > BigInt(job.to)) {
    finishBackfill(job, accounts)
    src.setJob(undefined)
    console.log(`[flow-cover] backfill done, blocks ${job.from}..${job.to}`)
  }
  src.save()
}

/** The deposits and mints of `logs` for `acc`'s Safe. */
function rowsOf(acc: AccountState, logs: readonly TransferLog[], registry: Registry, foundAt: string) {
  const safe = acc.ctx.address as Address
  const ownTx = ownTxOf(acc)
  const mine = logs.filter((l) => l.args?.to?.toLowerCase() === safe.toLowerCase())
  return { deposits: depositsOf(mine, safe, registry, foundAt, ownTx), mints: mintsOf(mine, safe, foundAt, ownTx) }
}

/** Merges rows into the account's lists. */
function keep(acc: AccountState, deposits: DepositRow[], mints: MintRow[]): void {
  if (deposits.length) {
    const { rows, added } = mergeDeposits(acc.deposits ?? [], deposits)
    if (added.length) acc.deposits = rows
  }
  if (mints.length) acc.flowMints = mergeMints(acc.flowMints ?? [], mints)
}

/** At most this many starts verified per snapshot tick (two archive reads each); a failed one waits VERIFY_RETRY_MS. */
export const VERIFY_PER_TICK = 5
export const VERIFY_RETRY_MS = 3_600_000
const verifyFailedAt = new WeakMap<AccountState, number>()

/**
 * Proves each unproven cover's start: no op of the account older than it, and at fromBlock - 1 the Safe had no code and
 * its USDC was under DEPOSIT_MIN_USDC. Code or a balance there sends the start back to the backfill (the job reads
 * BACKFILL_MARGIN_BLOCKS further back, down to before the Safe existed). VERIFY_PER_TICK starts per tick, none over the
 * RPC budget; a read that fails is tried again after VERIFY_RETRY_MS (a node without history keeps the cover unsent).
 */
export async function verifyCovers(src: CoverSource, now = Date.now()): Promise<void> {
  let changed = false
  let reads = 0
  for (const { acc, usdc } of src.accounts()) {
    if (reads >= VERIFY_PER_TICK || src.overBudget()) break
    if (now - (verifyFailedAt.get(acc) ?? -Infinity) < VERIFY_RETRY_MS) continue
    const c = acc.flowCover
    const safe = acc.ctx.address.toLowerCase()
    if (!c || c.safe !== safe || c.backfill || c.verified) continue
    const op = firstOp(acc)
    const from = BigInt(c.fromBlock)
    if (op !== undefined && from > op) continue // planBackfill reads it back
    let empty = true
    try {
      if (from > 0n) {
        reads++
        const deployed = await src.deployedAt(acc.ctx.address as Address, from - 1n)
        empty = !deployed && (await src.balanceAt(usdc, acc.ctx.address as Address, from - 1n)) < DEPOSIT_MIN_USDC
      }
    } catch (e) {
      verifyFailedAt.set(acc, now)
      console.error(`[flow-cover] ${acc.accountKey} start ${from - 1n} not read`, e instanceof Error ? e.message : String(e))
      continue
    }
    if (acc.flowCover !== c) continue // a look moved it meanwhile
    // A new object either way: a later start never inherits `verified`.
    acc.flowCover = empty ? { safe: c.safe, fromBlock: c.fromBlock, verified: true } : { safe: c.safe, fromBlock: c.fromBlock, backfill: true }
    changed = true
  }
  if (changed) src.save()
}

/**
 * The block each covered account is vouched through: the snapshot's block when (cursor, block] holds no deposit or mint
 * (one topic-OR read for every such Safe, at most SWEEP_MAX_PAGES pages). An account with an arrival there, or whose
 * cursor is further behind, is not vouched this tick (the next look records the arrival once it is final).
 */
export async function sweepThrough(src: CoverSource, block: bigint): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  const due: { a: CoverAccount; cursor: bigint }[] = []
  for (const a of src.accounts()) {
    const cursor = cursorOf(a.acc)
    if (cursor === undefined || !a.acc.flowCover?.verified || a.acc.flowCover.backfill) continue
    if (cursor >= block) out.set(a.acc.accountKey, block)
    else if (block - cursor <= SWEEP_MAX_PAGES * DEPOSIT_PAGE_BLOCKS) due.push({ a, cursor })
  }
  const byUsdc = new Map<string, typeof due>()
  for (const d of due) byUsdc.set(d.a.usdc.toLowerCase(), [...(byUsdc.get(d.a.usdc.toLowerCase()) ?? []), d])
  for (const [, group] of byUsdc) {
    const start = group.reduce((m, d) => (d.cursor < m ? d.cursor : m), block) + 1n
    const logs: TransferLog[] = []
    try {
      for (let from = start; from <= block; from += DEPOSIT_PAGE_BLOCKS) {
        const to = from + DEPOSIT_PAGE_BLOCKS - 1n < block ? from + DEPOSIT_PAGE_BLOCKS - 1n : block
        logs.push(...(await src.readLogs(group[0]!.a.usdc, group.map((d) => d.a.acc.ctx.address as Address), from, to)))
      }
    } catch (e) {
      console.error('[flow-cover] through check failed', e instanceof Error ? e.message : String(e))
      continue
    }
    for (const { a, cursor } of group) {
      const safe = a.acc.ctx.address as Address
      const after = logs.filter((l) => l.args?.to?.toLowerCase() === safe.toLowerCase() && l.blockNumber != null && l.blockNumber > cursor)
      const ownTx = ownTxOf(a.acc)
      if (!depositsOf(after, safe, src.registry, '', ownTx).length && !mintsOf(after, safe, '', ownTx).length) out.set(a.acc.accountKey, block)
    }
  }
  return out
}

/**
 * The snapshot with each covered account's cover on its receipts entry (one is added for an account with none). The
 * entry's flows are built again at the same moment as its cover: a deposit look or a backfill page that recorded rows
 * after the receipts were built moved the cursor the cover vouches from, so the flows must hold those rows too.
 */
export async function withCover<S extends Snapshot & { receipts?: AccountReceiptsWire[] }>(snapshot: S, src: CoverSource): Promise<S> {
  try {
    await backfillTick(src)
  } catch (e) {
    console.error('[flow-cover] backfill tick failed', e instanceof Error ? e.message : String(e))
  }
  let through = new Map<string, bigint>()
  // Over the RPC budget nothing is read: no cover is vouched through this snapshot (partial until the budget is back).
  if (!src.overBudget()) {
    try {
      await verifyCovers(src)
      through = await sweepThrough(src, snapshot.block)
    } catch (e) {
      console.error('[flow-cover] through check failed', e instanceof Error ? e.message : String(e))
    }
  }
  const receipts = [...(snapshot.receipts ?? [])]
  for (const { acc } of src.accounts()) {
    const cover = coverWire(acc, acc.ctx.address, through.get(acc.accountKey))
    if (!cover) continue
    const flows = accountFlows(acc.deposits, acc.ops)
    const i = receipts.findIndex((r) => r.safe.toLowerCase() === acc.ctx.address.toLowerCase())
    const entry: AccountReceiptsWire = { ...(i >= 0 ? receipts[i]! : { safe: acc.ctx.address, days: [] }), cover }
    if (flows.length) entry.flows = flows
    else delete entry.flows
    if (i >= 0) receipts[i] = entry
    else receipts.push(entry)
  }
  return { ...snapshot, receipts }
}

/** The topic-OR read of incoming USDC Transfers for a viem client. */
export function transfersTo(client: { getLogs(args: unknown): Promise<unknown> }): CoverSource['readLogs'] {
  return async (usdc, safes, from, to) => (await client.getLogs({ address: usdc, event: TRANSFER, args: { to: safes }, fromBlock: from, toBlock: to })) as TransferLog[]
}

/** The CoverSource of an operator: its state file, its accounts and one log reader. */
export function coverSource(
  store: { state: { flowBackfill?: FlowBackfillJob }; save(): void },
  operator: { coverAccounts(): CoverAccount[] },
  readLogs: CoverSource['readLogs'],
  blockTime: CoverSource['blockTime'],
  balanceAt: CoverSource['balanceAt'],
  deployedAt: CoverSource['deployedAt'],
  registry: Registry,
  overBudget: () => boolean,
): CoverSource {
  return {
    accounts: () => operator.coverAccounts(),
    registry,
    readLogs,
    blockTime,
    balanceAt,
    deployedAt,
    job: () => store.state.flowBackfill,
    setJob: (job) => {
      store.state.flowBackfill = job
    },
    save: () => store.save(),
    overBudget,
  }
}

/** The archive balance read for a viem client. */
export function usdcBalanceAt(client: { readContract(args: unknown): Promise<unknown> }): CoverSource['balanceAt'] {
  return async (usdc, safe, block) => (await client.readContract({ address: usdc, abi: BALANCE_OF, functionName: 'balanceOf', args: [safe], blockNumber: block })) as bigint
}

/** The archive code read for a viem client. */
export function codeAt(client: { getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined> }): CoverSource['deployedAt'] {
  return async (safe, block) => {
    const code = await client.getCode({ address: safe, blockNumber: block })
    return !!code && code !== '0x'
  }
}
