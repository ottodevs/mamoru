import type { FundingView, MoneyChain, MoneyInFlight, MoneyMap } from '@mamoru/domain'
import { safeLink, sleeveChain, txLink } from '../lib/chain.tsx'
import { formatUnits, shortHex } from '../lib/format.ts'
import { usd } from '../lib/money.ts'
import { chainLabel } from '../lib/positions.ts'
import { clockOrDate, clockTime } from '../lib/time.ts'
import { isMultichainTarget } from './monad-consent.tsx'
import { Fold, TweenUsd } from './motion.tsx'

// otto/mamoru#269: where the whole money is, chain by chain, and what is on its way between chains. The app ships its
// Home copy in English only (price-divergence is the one localized notice); every string of this card is here.
export const moneyCopy = {
  title: 'Where your money is',
  idle: 'Idle',
  positions: 'In positions',
  notRead: 'Not read yet',
  notReadBody: (chain: string) => `${chain} could not be read yet, so its money is not counted here. It will be when it can.`,
  lastRead: (at: string) => `Could not read just now. Showing the last value, read at ${at}.`,
  lastReadNoTime: 'Could not read just now. Showing the last value.',
  safe: 'Safe',
  safeLabel: (chain: string, safe: string) => `Your Safe on ${chain}, ${safe}`,
  incomplete: (chains: string) => `${chains} could not be read yet, so it is not in this total.`,
  baseOnly: 'Showing Base only. Your other chains are not in this total yet.',
  moving: (amount: string, from: string, to: string) => `Moving ${amount} USDC from ${from} to ${to}`,
  arrived: (amount: string, from: string, to: string) => `${amount} USDC from ${from} arrived on ${to}`,
  failedTitle: (amount: string, from: string, to: string) => `${amount} USDC from ${from} to ${to}`,
  // An operator newer than this app may send a stage it does not know: generic words, never an error.
  stageUnknown: 'On its way',
  stage: {
    sending: 'Sending',
    burned: 'Left {from}, being confirmed',
    attested: 'Confirmed, arriving on {to}',
    minting: 'Arriving on {to}',
    minted: 'Updating the balance',
    failed: 'Did not complete. Not counted in your total.',
  },
  unsure: 'Being confirmed · counted in your total',
  confirming: 'The total is being confirmed.',
  partial: (chains: string) => `Some positions on ${chains} could not be listed, so the total may be short.`,
  partialRow: (chain: string) => `Some positions on ${chain} could not be listed, so this may be short.`,
  pastScope: 'May not include other chains.',
  detailArrived: 'Sent over Circle CCTP. Already counted in your total.',
  eta: (a: string, b: string) => `Expected between ${a} and ${b}`,
  late: (b: string) => `Taking longer than expected (it was due by ${b}). Your money is counted in the total.`,
  detail: 'Sent over Circle CCTP. Counted in your total while it travels.',
  sentOn: (explorer: string) => `Sent: view on ${explorer}`,
  arrivedOn: (explorer: string) => `Arrived: view on ${explorer}`,
  gas: 'Gas reserve, not part of your total',
}

type Position = MoneyChain['positions'][number]

const positionValue = (p: Position): bigint => BigInt(p.valueUsdc ?? p.amountUsdc)

/** Idle money and positions of a chain, USDC base units. */
export function chainParts(c: MoneyChain): { idle: bigint; placed: bigint } {
  return { idle: c.idle.reduce((a, t) => a + BigInt(t.valueUsdc), 0n), placed: c.positions.reduce((a, p) => a + positionValue(p), 0n) }
}

/** Chains whose money is not in the total at all: never read. */
export function unreadChains(m: MoneyMap): MoneyChain[] {
  return m.chains.filter((c) => c.read.at === null)
}

/**
 * The one line under the balance when the total is not the whole account: a chain never read (clearly, never as 0), or an
 * operator that sends no money map while the account spans chains. Null when the total is the whole money.
 */
export function totalScopeNote(f: FundingView | undefined, otherChain: boolean): string | null {
  if (!f) return null
  if (!f.money) return otherChain || isMultichainTarget(f.approval?.policyId) ? moneyCopy.baseOnly : null
  const unread = unreadChains(f.money)
  if (unread.length) return moneyCopy.incomplete(unread.map((c) => chainLabel(c.chainId)).join(', '))
  if (f.money.complete) return null
  const partial = f.money.chains.filter((c) => c.partial)
  if (partial.length) return moneyCopy.partial(partial.map((c) => chainLabel(c.chainId)).join(', '))
  return f.money.inFlight.some((t) => t.unsure) ? moneyCopy.confirming : moneyCopy.incomplete('A chain')
}

/** Card shown when there is more to say than "one chain, read fine": several chains, a transfer, a stale or unread chain. */
export function travelling(t: MoneyInFlight): boolean {
  return t.stage !== 'minted' && t.stage !== 'failed'
}

/** The late flag from the operator, or from the clock: the window's end has passed (a tab left open still flips). */
export function isLate(t: MoneyInFlight, now: number): boolean {
  return !!t.eta && (t.eta.late || (Number.isFinite(Date.parse(t.eta.to)) && Date.parse(t.eta.to) < now))
}

export function showsMoneyMap(m: MoneyMap | undefined): m is MoneyMap {
  return !!m && (m.chains.length > 1 || m.inFlight.length > 0 || !m.complete || m.chains.some((c) => c.read.stale || c.read.at === null || c.partial))
}

function stageText(t: MoneyInFlight): string {
  const raw: string = (moneyCopy.stage as Record<string, string>)[t.stage] ?? moneyCopy.stageUnknown
  return raw.replace('{from}', chainLabel(t.from)).replace('{to}', chainLabel(t.to))
}

function TxLink({ chainId, tx, label }: { chainId: number; tx: string | undefined; label: (explorer: string) => string }) {
  const href = tx ? txLink(chainId, tx) : null
  if (!href) return null
  const text = label(sleeveChain(chainId).explorer.name)
  return (
    <a className="mm-link" href={href} target="_blank" rel="noreferrer" aria-label={text}>
      {text}
      <ExternalMark />
    </a>
  )
}

function ExternalMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M9 2h5v5M14 2 7 9M12 10v4H2V4h4" />
    </svg>
  )
}

function native(amount: string, symbol: string): string {
  return /^\d+$/.test(amount) ? `${formatUnits(amount, 'ETH')} ${symbol}` : ''
}

function ChainRow({ c }: { c: MoneyChain }) {
  const name = chainLabel(c.chainId)
  const never = c.read.at === null
  const { idle, placed } = chainParts(c)
  const at = c.read.at ? clockTime(c.read.at) : ''
  const link = safeLink(c.chainId, c.safe)
  return (
    <li className="mm-chain" data-testid={`money-chain-${c.chainId}`} data-stale={c.read.stale ? 'true' : 'false'}>
      <div className="mm-head">
        <span className="mm-name">{name}</span>
        {link ? (
          <a className="mm-link" href={link} target="_blank" rel="noreferrer" aria-label={moneyCopy.safeLabel(name, c.safe)}>
            {moneyCopy.safe} {shortHex(c.safe)}
            <ExternalMark />
          </a>
        ) : null}
        <span className="mm-sum" data-testid={`money-chain-${c.chainId}-total`}>
          {never ? <span className="mm-unread">{moneyCopy.notRead}</span> : <><TweenUsd raw={c.totalUsdc} /> <span className="panel-unit">USDC</span></>}
        </span>
      </div>
      {never ? (
        <p className="mm-note" role="status">{moneyCopy.notReadBody(name)}</p>
      ) : (
        <>
          <p className="panel-meta">
            <span className="seg">{moneyCopy.idle} {usd(idle)}</span>
            {' · '}
            <span className="seg">{moneyCopy.positions} {usd(placed)}</span>
          </p>
          {c.partial ? <p className="mm-note" role="status">{moneyCopy.partialRow(name)}</p> : null}
          {c.read.stale ? <p className="mm-note" role="status">{at ? moneyCopy.lastRead(at) : moneyCopy.lastReadNoTime}</p> : null}
        </>
      )}
    </li>
  )
}

function FlightRow({ t, now }: { t: MoneyInFlight; now: number }) {
  const from = chainLabel(t.from)
  const to = chainLabel(t.to)
  const done = t.stage === 'minted'
  const failed = t.stage === 'failed'
  const eta = t.eta && travelling(t) ? t.eta : null
  const late = isLate(t, now)
  const nowDate = new Date(now)
  const amount = usd(t.amountUsdc)
  return (
    <li className="mm-flight" data-testid="money-inflight" data-stage={t.stage}>
      <div className="mm-head">
        <span className="mm-name">{done ? moneyCopy.arrived(amount, from, to) : failed ? moneyCopy.failedTitle(amount, from, to) : moneyCopy.moving(amount, from, to)}</span>
      </div>
      <p className="progress mono-label text-stone" role="status" data-testid="money-inflight-stage">
        {done || failed ? null : <span className="progress-dot" aria-hidden="true" />}
        {t.unsure && !failed ? moneyCopy.unsure : stageText(t)}
      </p>
      {eta ? (
        <p className={`panel-meta${late ? ' mm-late' : ''}`} data-testid="money-inflight-eta">
          {late ? moneyCopy.late(clockOrDate(eta.to, nowDate)) : moneyCopy.eta(clockOrDate(eta.from, nowDate), clockOrDate(eta.to, nowDate))}
        </p>
      ) : null}
      <p className="mm-links">
        <TxLink chainId={t.from} tx={t.burnTx} label={moneyCopy.sentOn} />
        <TxLink chainId={t.to} tx={t.mintTx} label={moneyCopy.arrivedOn} />
      </p>
      {t.kind === 'cctp' && !failed ? <p className="panel-meta">{done ? moneyCopy.detailArrived : moneyCopy.detail}</p> : null}
    </li>
  )
}

/** "Where your money is": per chain its total, idle and positions, its Safe; each transfer in flight; the gas apart. */
export function MoneyMapCard({ money, now = Date.now() }: { money: MoneyMap; now?: number }) {
  const gas = money.chains.map((c) => ({ c, text: native(c.gas.amount, c.gas.symbol) })).filter((g) => g.text)
  return (
    <Fold
      defaultOpen
      testId="money-map"
      labelledBy="money-map-title"
      head={
        <>
          <span className="dash-title heavy" id="money-map-title">{moneyCopy.title}</span>
          <span className="panel-sum">
            <TweenUsd raw={money.totalUsdc} /> <span className="panel-unit">USDC</span>
          </span>
          <span className="panel-meta">{money.chains.map((c) => chainLabel(c.chainId)).join(' · ')}{money.inFlight.filter(travelling).length ? ` · ${money.inFlight.filter(travelling).length} moving` : ''}</span>
        </>
      }
    >
      <ul className="mm-list">
        {money.chains.map((c) => (
          <ChainRow key={c.chainId} c={c} />
        ))}
        {money.inFlight.map((t) => (
          <FlightRow key={t.id} t={t} now={now} />
        ))}
      </ul>
      {gas.length ? (
        <p className="mm-gas panel-meta" data-testid="money-gas">
          {moneyCopy.gas}: {gas.map((g) => `${g.text} on ${chainLabel(g.c.chainId)}`).join(' · ')}
        </p>
      ) : null}
    </Fold>
  )
}
