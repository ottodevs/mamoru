// otto/mamoru#413 (spec 012 savings-layer.md): the savings books of an account. Harvested USDC is savings: `pending` in
// the Safe until a savings deposit puts it into the Stable vault, then vault shares tagged savings, each vault with its
// own cost basis. Derived at every review from the account's stored ops (as harvested.ts does), never kept as a
// separate counter: a restart replays the same history to the same books.
//
// Walking the confirmed ops and the stored cuts in block order:
// - a harvest stored with `savingsIn` adds the USDC side of every fee its receipt collected;
// - a harvest sale stored with `savingsIn` adds the USDC its receipt says the Safe received (`facts.usdcNet`);
// - a savings deposit (`savings`) moves its assets from pending to its vault: the shares its Deposit minted, at a basis
//   of the assets. Before its receipt is read, its shares are counted at the vault rate of the read (`rates`), so the
//   bucket never sees them as its own money in the meantime;
// - a withdrawal stored with `savingsOut` (computed at prepare, savings first) takes that off, never more than held;
// - a Stop (owner `exit`) empties the books and starts a new epoch;
// - a cut (what a balance below the books took off at a read, `clampSavings`) takes that off at its block.
// Ops stored before this code carry none of these flags and count for nothing: no backfill. Every subtraction lowers a
// vault's basis pro rata. The books are a part of what the Safe holds, never an addition to it.

import type { Observation } from '@mamoru/decide'
import type { AccountSavings } from '@mamoru/domain'
import type { Registry } from '@mamoru/registry'
import type { StoredOp } from './state.ts'
import { lostSubmit } from './yield-receipts.ts'

const SAVINGS = 'USDC'

export type SavingsBooks = {
  /** The opId of the Stop that last emptied the books; '' before any. Cuts belong to one epoch. */
  epoch: string
  /** Raw USDC in the Safe tagged savings, not deposited yet. */
  pending: bigint
  /** Per vault: the shares tagged savings and their basis (raw USDC). */
  vaults: Record<string, { shares: bigint; basis: bigint }>
  /** A savings op is confirmed whose receipt is not read yet: a figure may be short until it is. */
  partial: boolean
}

/** Stored on a withdrawal at prepare (SAV-R5): what it takes from the books when it confirms. Raw units. */
export type SavingsOut = { pending: string; shares: Record<string, string> }

/** What a balance below the books took off, at the block of that read. Kept per epoch (AccountState.savingsCuts). */
export type SavingsCut = { block: number; pending?: string; shares?: Record<string, string> }
export type SavingsCuts = { epoch: string; cuts: SavingsCut[] }

/** A vault as read: its shares held and what they are worth. */
export type VaultRead = { name: string; shares: bigint; assets: bigint }

/**
 * An op that may have moved money the books do not show yet: sent and not settled (an op given up on, `lostSubmit`, is
 * not), or confirmed without its block. Prepared owner ops (`proposed`) move nothing until signed and sent.
 */
function inFlight(op: StoredOp, ops: readonly StoredOp[]): boolean {
  if (!(op.opId.startsWith('eng-') || op.opId.startsWith('own-'))) return false
  if (op.state === 'confirmed') return op.block === undefined
  return op.state === 'submitted' && !lostSubmit(op, ops)
}

const empty = (epoch: string): SavingsBooks => ({ epoch, pending: 0n, vaults: {}, partial: false })

/** Takes up to `shares` off a vault's savings, its basis pro rata (rounded up, so the basis left is never overstated). */
function takeShares(b: SavingsBooks, vault: string, shares: bigint): void {
  const v = b.vaults[vault]
  if (!v || shares <= 0n) return
  const out = shares < v.shares ? shares : v.shares
  const basisOut = out === v.shares ? v.basis : (v.basis * out + v.shares - 1n) / v.shares
  const left = { shares: v.shares - out, basis: v.basis - basisOut }
  if (left.shares === 0n) delete b.vaults[vault]
  else b.vaults[vault] = left
}

function takePending(b: SavingsBooks, amount: bigint): void {
  if (amount <= 0n) return
  b.pending = amount < b.pending ? b.pending - amount : 0n
}

/**
 * The books at `atBlock` (ops at or before it, so a read never loses an op it predates). `registry` names each fee's
 * pool tokens; `rates` prices a savings deposit whose receipt is not read yet; `cuts` the stored cuts.
 */
export function savingsOf(ops: readonly StoredOp[], registry: Registry, opts: { atBlock?: number; rates?: readonly VaultRead[]; cuts?: SavingsCuts } = {}): SavingsBooks {
  const tokensOf = (pool: string | undefined): [string | undefined, string | undefined] => {
    const e = pool ? registry.entries.find((x) => x.name === pool) : undefined
    return [e?.token0, e?.token1]
  }
  type Ev = { block: number; seq: number; op?: StoredOp; cut?: SavingsCut }
  const events: Ev[] = []
  let seq = 0
  for (const op of ops) {
    if (op.state !== 'confirmed' || op.block === undefined) continue
    if (opts.atBlock !== undefined && op.block > opts.atBlock) continue
    const stop = op.opId.startsWith('own-') && op.kind === 'exit'
    const relevant = stop || (op.opId.startsWith('own-') && !!op.savingsOut) || (op.opId.startsWith('eng-') && (op.savingsIn || op.savings))
    if (relevant) events.push({ block: op.block, seq: seq++, op })
  }
  // A cut is taken at a read, after every op of its block.
  for (const cut of opts.cuts?.cuts ?? []) events.push({ block: cut.block, seq: Number.MAX_SAFE_INTEGER, cut })
  events.sort((a, b) => a.block - b.block || a.seq - b.seq)
  let books = empty('')
  let partial = false
  for (const e of events) {
    if (e.cut) {
      // Cuts of another epoch (before the last Stop) do not apply.
      if ((opts.cuts?.epoch ?? '') !== books.epoch) continue
      takePending(books, BigInt(e.cut.pending ?? '0'))
      for (const [vault, s] of Object.entries(e.cut.shares ?? {})) takeShares(books, vault, BigInt(s))
      continue
    }
    const op = e.op!
    if (op.opId.startsWith('own-')) {
      if (op.kind === 'exit') {
        books = empty(op.opId)
        partial = false
        continue
      }
      takePending(books, BigInt(op.savingsOut!.pending))
      for (const [vault, s] of Object.entries(op.savingsOut!.shares)) takeShares(books, vault, BigInt(s))
      continue
    }
    if (op.savingsIn && op.step === 'harvest') {
      if (!op.facts) {
        partial = true
        continue
      }
      for (const f of op.facts.fees) {
        const [t0, t1] = tokensOf(f.pool)
        if (t0 === SAVINGS) books.pending += BigInt(f.fee0)
        if (t1 === SAVINGS) books.pending += BigInt(f.fee1)
      }
      continue
    }
    if (op.savingsIn) {
      // A harvest sale: the USDC its swap paid the Safe.
      if (!op.facts) {
        partial = true
        continue
      }
      const net = BigInt(op.facts.usdcNet ?? '0')
      if (net > 0n) books.pending += net
      continue
    }
    if (op.savings) {
      const flows = op.facts?.vaultFlows?.filter((f) => f.kind === 'deposit')
      if (op.facts && flows) {
        for (const f of flows) {
          const cur = books.vaults[f.vault] ?? { shares: 0n, basis: 0n }
          books.vaults[f.vault] = { shares: cur.shares + BigInt(f.shares), basis: cur.basis + BigInt(f.assets) }
          takePending(books, BigInt(f.assets))
        }
        continue
      }
      if (op.facts) continue
      // Receipt not read yet: the intent's assets at the vault rate of the read, floored (never more than it minted).
      partial = true
      const assets = BigInt(op.amountIn ?? '0')
      const vault = op.tokenOut
      const rate = vault ? opts.rates?.find((v) => v.name === vault) : undefined
      takePending(books, assets)
      if (vault && rate && rate.assets > 0n && assets > 0n) {
        const cur = books.vaults[vault] ?? { shares: 0n, basis: 0n }
        books.vaults[vault] = { shares: cur.shares + (assets * rate.shares) / rate.assets, basis: cur.basis + assets }
      }
    }
  }
  return { ...books, partial }
}

/**
 * The spec's clamp made persistent: the books never above what the Safe holds (`usdc`, the vaults' shares). What a read
 * finds missing is stored as a cut at its block, so the books stay down when the balance comes back (a later deposit is
 * never tagged savings). Returns the books after the cut and the cuts to store (the caller saves them when changed).
 */
export function clampSavings(ops: readonly StoredOp[], registry: Registry, read: { block: number; usdc: bigint; vaults: readonly VaultRead[] }, stored?: SavingsCuts): { books: SavingsBooks; cuts: SavingsCuts } {
  const first = savingsOf(ops, registry, { atBlock: read.block, rates: read.vaults, cuts: stored })
  // Cuts of an older epoch are dropped: a Stop emptied what they applied to.
  const kept: SavingsCuts = { epoch: first.epoch, cuts: stored?.epoch === first.epoch ? [...stored.cuts] : [] }
  // An op on its way may already be in the balances and not yet in the books (a withdrawal included, its receipt not
  // settled): a cut taken now would count it twice once it confirms. No cut while one is; decide clips to what is held.
  if (ops.some((o) => inFlight(o, ops))) return { books: first, cuts: kept }
  const cut: SavingsCut = { block: read.block }
  if (first.pending > read.usdc) cut.pending = (first.pending - read.usdc).toString()
  for (const [vault, v] of Object.entries(first.vaults)) {
    // A vault this read did not return (unread, or not read at all) is no sign its shares left: no cut from a missing entry.
    const r = read.vaults.find((x) => x.name === vault)
    if (r && v.shares > r.shares) (cut.shares ??= {})[vault] = (v.shares - r.shares).toString()
  }
  if (!cut.pending && !cut.shares) return { books: first, cuts: kept }
  const cuts = { epoch: first.epoch, cuts: [...kept.cuts, cut] }
  return { books: savingsOf(ops, registry, { atBlock: read.block, rates: read.vaults, cuts }), cuts }
}

/** The books as the engine observes them (`Observation.savings`); empty books: absent, and the observation hashes as before. */
export function savingsObs(books: SavingsBooks): Observation['savings'] | undefined {
  const shares = Object.fromEntries(Object.entries(books.vaults).filter(([, v]) => v.shares > 0n).map(([k, v]) => [k, v.shares]))
  if (books.pending === 0n && Object.keys(shares).length === 0) return undefined
  return { pending: books.pending, shares }
}

/** The per-account figure the app and the fee read (`AccountSavings`), each vault's shares at the rate of `vaults`. */
export function savingsView(books: SavingsBooks, vaults: readonly VaultRead[]): AccountSavings {
  let usdc = books.pending
  let basis = books.pending
  const rows: AccountSavings['vaults'] = []
  for (const [vault, v] of Object.entries(books.vaults).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const r = vaults.find((x) => x.name === vault)
    const value = r && r.shares > 0n ? (r.assets * v.shares) / r.shares : 0n
    usdc += value
    basis += v.basis
    rows.push({ vault, shares: v.shares.toString(), usdc: value.toString(), basisUsdc: v.basis.toString() })
  }
  return { usdc: usdc.toString(), basisUsdc: basis.toString(), pendingUsdc: books.pending.toString(), vaults: rows, status: books.partial ? 'partial' : 'counted' }
}

/**
 * SAV-R5: what a withdrawal of `amount` (what leaves the Safe: the payout plus any fee) takes from the books, savings
 * first: pending, then each vault's savings shares at the rate of the read (rounded up, never above the shares
 * tagged). The rest is bucket money and is not in the books. Absent when it takes nothing.
 */
export function savingsOutOf(books: SavingsBooks, amount: bigint, vaults: readonly VaultRead[]): SavingsOut | undefined {
  let left = amount
  const pending = books.pending < left ? books.pending : left
  left -= pending
  const shares: Record<string, string> = {}
  for (const [vault, v] of Object.entries(books.vaults).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (left <= 0n) break
    const r = vaults.find((x) => x.name === vault)
    if (!r || r.shares === 0n || r.assets === 0n) continue
    const value = (r.assets * v.shares) / r.shares
    if (value <= left) {
      shares[vault] = v.shares.toString()
      left -= value
      continue
    }
    const s = (left * r.shares + r.assets - 1n) / r.assets
    shares[vault] = (s < v.shares ? s : v.shares).toString()
    left = 0n
  }
  if (pending === 0n && Object.keys(shares).length === 0) return undefined
  return { pending: pending.toString(), shares }
}
