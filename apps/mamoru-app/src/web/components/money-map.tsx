import type { FundingView, MoneyChain, MoneyMap } from '@mamoru/domain'
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

const names = (cs: MoneyChain[]) => [...new Set(cs.map((c) => chainLabel(c.chainId)))].join(', ')

/**
 * The line under the balance when the total is not the whole, fresh account: a chain never read (clearly, never as 0), an
 * operator that sends no money map while the account spans chains, a chain showing its last good read, positions not
 * listed, a transfer not confirmed. Several can hold at once and each is said (#350 review r2). Null when none holds.
 */
export function totalScopeNote(f: FundingView | undefined, otherChain: boolean): string | null {
  if (!f) return null
  if (!f.money) return otherChain || isMultichainTarget(f.approval?.policyId) ? moneyCopy.baseOnly : null
  const unread = unreadChains(f.money)
  if (unread.length) return moneyCopy.incomplete(names(unread))
  const notes: string[] = []
  const stale = f.money.chains.filter((c) => c.read.stale)
  if (stale.length) {
    const at = clockTime(stale.map((c) => c.read.at!).sort()[0]!)
    notes.push(at ? moneyCopy.stale(names(stale), at) : moneyCopy.staleNoTime(names(stale)))
  }
  if (!f.money.complete) {
    const partial = f.money.chains.filter((c) => c.partial)
    notes.push(partial.length ? moneyCopy.partial(names(partial)) : f.money.inFlight.some((t) => t.unsure) ? moneyCopy.confirming : moneyCopy.incomplete('A chain'))
  }
  return notes.length ? notes.join(' ') : null
}
