import type { FundingView, MoneyChain, MoneyMap } from '@mamoru/domain'
import { shortHex } from '../lib/format.ts'
import { usd } from '../lib/money.ts'
import { chainLabel } from '../lib/positions.ts'
import { clockTime } from '../lib/time.ts'
import { isMultichainTarget } from './monad-consent.tsx'

// otto/mamoru#269: the balance is the whole money, chain by chain and in flight. otto/mamoru#350 (Brais, 3 Nov): the
// "Where your money is" card is gone; each Working capital row names its chain's Safe, and only the line under the
// balance is left here. The app ships its Home copy in English only.
export const moneyCopy = {
  incomplete: (chains: string) => `${chains} could not be read yet, so it is not in this total.`,
  baseOnly: 'Showing Base only. Your other chains are not in this total yet.',
  confirming: 'The total is being confirmed.',
  // Brais, 3 Nov (literal): a bridge in progress is part of the total and says so under it.
  moving: (amount: string, from: string, to: string) => `${amount} USDC moving from ${from} to ${to}`,
  // #350 review r1: the card used to say this per chain; a chain read that failed keeps its last value, and says so.
  stale: (chain: string, at: string) => `${chain} could not be read just now. Showing its last value, read at ${at}.`,
  staleNoTime: (chain: string) => `${chain} could not be read just now. Showing its last value.`,
  partial: (chains: string) => `Some positions on ${chains} could not be listed, so the total may be short.`,
  pastScope: 'May not include other chains.',
}

/** Chains whose money is not in the total at all: never read. */
export function unreadChains(m: MoneyMap): MoneyChain[] {
  return m.chains.filter((c) => c.read.at === null)
}

/** A chain by name; a Safe by chain and address when the chain has more than one Safe (#350 review r4). */
function names(cs: MoneyChain[], all: MoneyChain[]): string {
  const label = (c: MoneyChain) => (all.filter((o) => o.chainId === c.chainId).length > 1 ? `${chainLabel(c.chainId)} Safe ${shortHex(c.safe)}` : chainLabel(c.chainId))
  return [...new Set(cs.map(label))].join(', ')
}

/**
 * The line under the balance when the total is not the whole, fresh account: an operator that sends no money map while
 * the account spans chains, or, each said on its own when several hold (#350 review r2, r3): a chain never read (clearly,
 * never as 0), a chain showing its last good read, positions not listed, a transfer not confirmed. Null when none holds.
 */
export function totalScopeNote(f: FundingView | undefined, otherChain: boolean): string | null {
  if (!f) return null
  if (!f.money) return otherChain || isMultichainTarget(f.approval?.policyId) ? moneyCopy.baseOnly : null
  const notes: string[] = []
  // One line per transfer on its way (not arrived, not failed): already counted in the total, absent from Working and Idle.
  for (const t of f.money.inFlight.filter((t) => t.stage !== 'minted' && t.stage !== 'failed')) notes.push(moneyCopy.moving(usd(t.amountUsdc), chainLabel(t.from), chainLabel(t.to)))
  const unread = unreadChains(f.money)
  if (unread.length) notes.push(moneyCopy.incomplete(names(unread, f.money.chains)))
  // A chain never read is stale too; it is said once, as unread.
  const stale = f.money.chains.filter((c) => c.read.stale && c.read.at !== null)
  // One sentence per stale chain, each with its own read time (#350 review r6).
  for (const c of stale) {
    const at = clockTime(c.read.at!)
    notes.push(at ? moneyCopy.stale(names([c], f.money.chains), at) : moneyCopy.staleNoTime(names([c], f.money.chains)))
  }
  const partial = f.money.chains.filter((c) => c.partial)
  if (partial.length) notes.push(moneyCopy.partial(names(partial, f.money.chains)))
  if (f.money.inFlight.some((t) => t.unsure)) notes.push(moneyCopy.confirming)
  // Incomplete for a reason none of the above names: still never presented as the whole money.
  if (!f.money.complete && notes.length === 0) notes.push(moneyCopy.incomplete('A chain'))
  return notes.length ? notes.join(' ') : null
}
