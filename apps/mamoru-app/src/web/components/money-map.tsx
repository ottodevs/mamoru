import type { FundingView, MoneyChain, MoneyInFlight, MoneyMap } from '@mamoru/domain'
import { WALKAWAY_URL } from '../lib/signin.ts'
import { sleeveChain, txLink } from '../lib/chain.tsx'
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
  // otto/mamoru#245: a burn past its deadline. Brais, 4 Nov (literal): one sentence, no reason code, no amount.
  stuck: 'Taking longer than usual, Mamoru is trying. Your money is safe.',
  diy: 'Finish it yourself',
  diyBody: 'Circle signs every transfer. With that signature, any wallet with a little MON can complete it on Monad, without Mamoru.',
  diyBurn: (explorer: string) => `The transfer on ${explorer}`,
  diyGuide: 'Step by step guide',
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
  // One line per transfer the total counts outside Working and Idle: on its way, or minted before the destination's read
  // catches up (#350 review r9). A failed one is not in the total and says nothing here.
  for (const t of f.money.inFlight.filter((t) => t.stage !== 'failed')) notes.push(moneyCopy.moving(usd(t.amountUsdc), chainLabel(t.from), chainLabel(t.to)))
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

/**
 * The burn landed on Base for these, so Circle has a message to finish by hand. An allowlist: a code this app does not
 * know, or none, never offers it (not_sent and burn_unmatched mean no burn landed).
 */
const BURN_LANDED = new Set<string>(['no_attestation', 'mint_pending', 'mint_reverted', 'gas_ceiling', 'mint_budget', 'relayer_unfunded', 'mint_off', 'monad_unreachable'])

/** The walkaway section that finishes a Base to Monad transfer by hand. */
export const DIY_MINT_URL = `${WALKAWAY_URL}#a-transfer-to-monad-that-never-arrives`

/** Flagged stuck by the operator while still on its way; once minted or failed the flag no longer applies. */
export function isStuck(t: Pick<MoneyInFlight, 'stuckAt' | 'stage'>): boolean {
  return !!t.stuckAt && travelling(t)
}

/** Still on its way: not minted, not failed. */
export function travelling(t: Pick<MoneyInFlight, 'stage'>): boolean {
  return t.stage !== 'minted' && t.stage !== 'failed'
}

/**
 * otto/mamoru#245: a transfer past its deadline says so and that the money is safe; for a burn on its way to Monad, a closed
 * disclosure with the burn and the guide to mint it by hand (CCTP V2 lets anyone call receiveMessage there).
 */
export function StuckNote({ reason, from, to, burnTx, landed }: { reason: string | undefined; from: number; to: number; burnTx: string | undefined; landed: boolean }) {
  const burn = burnTx ? txLink(from, burnTx) : null
  return (
    <>
      <p className="mm-note mm-note-stuck" role="status" data-testid="stuck-note">
        {moneyCopy.stuck}
      </p>
      {burn && landed && to === 143 && BURN_LANDED.has(reason ?? '') ? (
        <details className="mm-diy" data-testid="stuck-diy">
          <summary>{moneyCopy.diy}</summary>
          <div className="mm-diy-body">
            <p className="panel-meta">{moneyCopy.diyBody}</p>
            <p className="mm-links">
              <a className="mm-link" href={burn} target="_blank" rel="noreferrer">
                {moneyCopy.diyBurn(sleeveChain(from).explorer.name)} {shortHex(burnTx!)}
                <ExternalMark />
              </a>
              <a className="mm-link" href={DIY_MINT_URL} target="_blank" rel="noreferrer">
                {moneyCopy.diyGuide}
                <ExternalMark />
              </a>
            </p>
          </div>
        </details>
      ) : null}
    </>
  )
}

function ExternalMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M9 2h5v5M14 2 7 9M12 10v4H2V4h4" />
    </svg>
  )
}
