import type { ApyView, FundingView, Hex0x, OpView, OverCap, PriceDivergenceWarning, WithdrawAsset } from '@mamoru/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiRequestError, useApi } from '../api/client.ts'
import { fundingInterval, queryKeys, useApy, useFreshFunding, useFunding, useOps, usePools, useSession, useWithdrawAssets, useYieldLedger } from '../api/queries.ts'
import { AssetPicker } from '../components/asset-picker.tsx'
import { PriceDivergenceNotice } from '../components/price-divergence-notice.tsx'
import { TokenMark } from '../components/token-mark.tsx'
import { Brand, Modal } from '../components/ui.tsx'
import { downloadJson, kitFilename } from '../lib/download.ts'
import { useDestination } from '../lib/ens.ts'
import { decimalsOf, formatUnits, shortHex } from '../lib/format.ts'
import { belowMinimumOf, cbbtcPrice, ceilCents, humanMessage, MIN_ENTRY_USDC, overCapOf, split, usd, usdExactInput, usdInput, usdPlain, type Split } from '../lib/money.ts'
import { activationLive, everStarted, historyOps, needsRetry, opLine, opTone, TERMINAL } from '../lib/ops.ts'
import { parseUsdc, useOwnerAction } from '../lib/owner-flow.ts'
import { pairLabel, poolAddress, poolTokens, positionAmounts, progressLine } from '../lib/positions.ts'
import { activateLine, signatureCopy } from '../lib/signature.ts'
import { currentRate, idleReason, monthlyRate, positionRates, sourceName, type AccountRate, type PositionRate } from '../lib/rates.ts'
import { acceptancePayload, detectLocale, transferConfirmDisabled, waitLabel, withdrawAnywayLabel } from '../lib/price-divergence.ts'
import { localTime } from '../lib/time.ts'
import { explorerAddress, explorerTx, useChain } from '../lib/chain.tsx'
import { JPYT_CAPTION, receiveLine, withdrawOptions } from '../lib/withdraw-assets.ts'
import { DepositDetails, hasMoney } from './add-money.tsx'
import { WrongNetwork } from '../components/other-chain-notice.tsx'
import { FeedbackDialog, feedbackCopy } from '../components/feedback-dialog.tsx'
import { HowItWorks, howCopy } from '../components/how-it-works.tsx'
import { Chevron, Fold, LiveSync, PullToRefresh, TweenPct, TweenUsd } from '../components/motion.tsx'
import { isMultichainTarget, monadCopy, MonadConsentDialog, splitRows } from '../components/monad-consent.tsx'
import { ApprovalBody, ApprovalDialog } from '../components/approval-dialog.tsx'

export const homeCopy = {
  total: 'Total balance',
  // otto/mamoru#208: the live read failed (the operator unreachable, incident #205); the last snapshot stands in.
  pastReading: (ago: string) => `Last reading ${ago} ago`,
  pastTitle: 'Mamoru cannot read your account right now.',
  pastBody: 'Your money stays in your account on-chain. The balance above is the last reading; actions return when the live read does. Retrying.',
  noReading: 'Could not load your balance. Your money stays in your account on-chain. Retrying.',
  // otto/mamoru#198: two rates under the balance, figure over "APY · what"; sources behind (i). The names stay
  // for screen readers and the per-position table.
  monthly: 'Monthly rate',
  current: 'Current rate',
  earnedSoFar: 'earned so far',
  monthlyWhat: '30-day avg',
  // Brais's label, literal (otto/mamoru#198, 23-oct): the figure is the whole balance's last 24 h.
  currentWhat: '24h avg',
  sources: 'Rate sources',
  monthlySource: 'Monthly',
  currentSource: '24h avg',
  planPools: 'plan pools, nothing placed yet',
  na: 'n/a',
  gap: {
    loading: 'loading',
    'no-read': 'no live read',
    'no-positions': 'no position earning now',
    'no-data': 'no rate from the source today',
    'no-value': 'a position has no USDC value yet',
  } as Record<NonNullable<AccountRate['gap']>, string>,
  earnedGap: 'not measured yet',
  add: 'Add capital',
  withdraw: 'Withdraw',
  stop: 'Stop allocation',
  startAllocation: 'Start allocation',
  startBody: 'Mamoru puts your idle USDC back to work in Uniswap v3 USDC/cbBTC. You approve with your passkey.',
  retry: 'Approve again',
  start: 'Start',
  working: 'Working capital',
  idle: 'Idle capital',
  show: 'Show',
  hide: 'Hide',
  colPosition: 'Position',
  colAmount: 'Amount',
  colShare: 'Share',
  target: (pct: number) => (pct === 0 ? 'target 0%, closing' : `target ${pct}%`),
  inRange: 'In range',
  paused: 'Paused: out of range. Mamoru puts it back to work automatically.',
  noRate: 'n/a: no rate source for this pool yet.',
  unpriced: (tokens: string) => `n/a: no USDC price for ${tokens} in this view yet, so its value, its share and the account rates show n/a.`,
  unpricedIdle: (tokens: string) => `${tokens} not priced yet, not counted in the total`,
  nothingPlaced: 'Nothing in a position right now.',
  placing: 'Placing your money. The next step starts in a few seconds.',
  // otto/mamoru#191: right after a deposit the dashboard names the amount on its way in.
  putting: (amount: string) => `Putting ${amount} USDC to work. This takes a few seconds.`,
  upToDate: (time: string) => `Nothing to do right now. Mamoru looks again at ${time}.`,
  waitDepth: (amount: string, pair: string, time: string) => `${amount} USDC is waiting: the ${pair} pool is not deep enough for more right now. Checked at ${time}.`,
  waitFall: (amount: string, pair: string, time: string) => `${amount} USDC is waiting: ${pair} is falling fast, so Mamoru adds nothing there until it settles. Checked at ${time}.`,
  waitMany: (amount: string, n: number, why: string, time: string) => `${amount} USDC is waiting in ${n} pools: ${why}. Checked at ${time}.`,
  // otto/mamoru#212: the cap holds the account's total across every network; above it, new money stays idle.
  overLimit: (amount: string, cap: string) => `${amount} USDC above your ${cap} USDC limit stays idle.`,
  peerUnread: 'Mamoru is adding nothing new right now: your balance on the other network could not be read. It tries again shortly.',
  capRaiseTitle: (cap: string, signed: string) => `Your limit is now ${cap} USDC. Mamoru keeps to the ${signed} USDC you approved until you renew its approval.`,
  whyDepth: 'they are not deep enough for more right now',
  whyFall: 'their markets are falling fast',
  whyBoth: 'some are not deep enough for more right now, some are falling fast',
  history: 'Savings history',
  notRunning: 'Mamoru is not running on this money yet.',
  armFirst: 'Approve once. Mamoru starts when your money lands.',
  stopBody: 'Mamoru closes every position and swaps back to USDC. Your USDC stays in your account.',
  confirm: 'Confirm with passkey',
  renewSoon: (day: string) => `Mamoru's approval ends on ${day}. Renew it so your money keeps working.`,
  renewEnded: 'Mamoru\'s approval has ended. Your money is where it was, but Mamoru cannot manage it until you renew.',
  renewNote: 'One tap with your passkey. Nothing is moved.',
  renew: 'Renew approval',
  renewAskTitle: "Renew Mamoru's approval",
  extendTitle: 'Mamoru is missing part of its approval: in some pools it cannot re-range or collect fees until you add it.',
  extend: 'Approve',
  // Spec 007 T7: the move of a running v2/v3 approval to the on-chain action policy.
  upgradeTitle: 'Mamoru can now be limited on chain: it would trade only near the market price, and only the positions it opened. Renew its approval to turn this on.',
  // otto/mamoru#151, #171: the move to MamoruActionPolicyV2 (conservador-live-v5), from v2/v3 or from v4.
  // otto/mamoru#151: the guardian paused the account; the owner's renewal would end the pause.
  pausedTitle: 'A guardian key has paused Mamoru on this account, so it is not acting. Renewing its approval ends that pause: renew only if you know why it was paused.',
  // otto/mamoru#201, #216: the move to a mix that also works on Monad (conservador-live-v6).
  upgradeMonadTitle: 'Mamoru now works on Monad too. See what changes in your mix, then approve it with two taps.',
  upgradeMonadNote: 'Two taps with your passkey. Nothing moves until you approve both.',
  upgradeMonad: 'See what changes',
  upgradeV5Title: "Mamoru's on-chain limits have a new version: it trades only near the market price and only the positions it opened, adds to a position it already holds instead of opening another, and a guardian key can pause it but never move funds. Renew its approval to turn this on.",
  // otto/mamoru#149: a grant that has used 80% or all of what the approval allows.
  usageSoon: (what: string, pair: string) => `Mamoru has used most of what this approval allows for ${what} in ${pair}. Renew it now so that does not stop.`,
  usageSpent: (what: string, pair: string) => `Mamoru has used all that this approval allows for ${what} in ${pair}, so it has stopped doing that. Renew it to start again.`,
  overCapTitle: (o: OverCap) => `This account is over the ${usdPlain(o.capUsdc)} USDC cap, so Mamoru has not started.`,
  overCapBody: (o: OverCap) => `It holds ${usd(o.usdc)} USDC. Nothing was moved. Withdraw at least ${usd(ceilCents(BigInt(o.excessUsdc)))} USDC to an address you control, then start Mamoru.`,
  belowTitle: (min: bigint) => `Mamoru starts from ${usdPlain(min)} USDC.`,
  belowBody: (usdc: bigint, missing: bigint) => `This account holds ${usd(usdc)} USDC, so it has not started. Add at least ${usd(ceilCents(missing))} USDC more.`,
  overCapAct: (o: OverCap) => `Withdraw ${usd(ceilCents(BigInt(o.excessUsdc)))} USDC`,
}

const KIND: Record<OpView['kind'], string> = { activate: 'Start', enter: 'Position', reduce: 'Position', transfer: 'Withdraw', exit: 'Stop', renew: 'Approval' }

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? homeCopy.na : `${v.toFixed(1)}%`)

/**
 * otto/mamoru#198: what the account has earned, under the balance as its gain (the Robinhood/Revolut pattern).
 * Not measured yet says so, never a guess.
 */
function Earned({ usd: earned }: { usd: string | null | undefined }) {
  const known = earned != null
  return (
    <p className="earned" data-testid="earned-so-far">
      <span className={`earned-value${known ? '' : ' rate-na'}`}>
        {known ? <TweenUsd raw={earned} prefix="+" countUp /> : homeCopy.na}
        {known ? <span className="earned-unit">USDC</span> : null}
      </span>
      <span className="earned-label">{homeCopy.earnedSoFar}</span>
      {known ? null : <span className="earned-why">{homeCopy.earnedGap}</span>}
    </p>
  )
}

/** How long ago an ISO time was, in the largest whole unit: "under a minute", "4 min", "3 h", "2 days". */
export function agoText(iso: string, now: number = Date.now()): string {
  const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} days`
}

export function Balance({
  s,
  earnedSoFarUsd,
  onAdd,
  onWithdraw,
  past = null,
  down = false,
}: {
  s: Split | null
  earnedSoFarUsd?: string | null
  onAdd: () => void
  onWithdraw: () => void
  /** otto/mamoru#208: set only while the live read fails; then it is what the balance shows, marked as past. */
  past?: { totalUsd: string; readAt: string } | null
  /** The live read is failing: both actions are off (their dialogs need it), past reading or not. */
  down?: boolean
}) {
  const shownPast = past
  return (
    <section className="balance" aria-labelledby="total-title">
      <div>
        <p className="kicker text-[0.86rem]! font-bold tracking-[0.14em]! text-ink!" id="total-title">
          {homeCopy.total}
        </p>
        <p className={`sum${shownPast ? ' past' : ''}`} data-testid="total">
          {shownPast ? usd(shownPast.totalUsd) : s ? <TweenUsd raw={s.total} countUp /> : '0.00'}
          <span className="unit">USDC</span>
        </p>
        {shownPast ? (
          <p className="past-reading" data-testid="past-reading">
            {homeCopy.pastReading(agoText(shownPast.readAt))}
          </p>
        ) : null}
        <Earned usd={earnedSoFarUsd} />
      </div>
      <div className="balance-acts">
        {/* otto/mamoru#208: the add dialog needs the live read (address, cap); off while only a past one shows. */}
        <button type="button" className="act" onClick={onAdd} disabled={down || !!shownPast}>
          {homeCopy.add}
        </button>
        {/* otto/mamoru#135: never disabled on the poll's balance, which can be 15-60 s behind a deposit. The
            operator's prepare reads the chain and refuses with a reason the dialog shows. */}
        <button type="button" className="act quiet" data-testid="withdraw-button" onClick={onWithdraw} disabled={!s || down || !!shownPast}>
          {homeCopy.withdraw}
        </button>
      </div>
    </section>
  )
}

/** The label under a rate: "APY · what", then why there is none or what it covers, never the source. */
function RateSub({ name, what, tail, info = null }: { name: string; what: string; tail: string | null; info?: ReactNode }) {
  return (
    <div className="rate-label">
      <p className="rate-sub">
        <span className="sr-only">{name} </span>
        APY
        <span className="rate-what">
          <span className="rate-dot"> · </span>
          {what}
          {tail ? ` · ${tail}` : null}
        </span>
      </p>
      {info}
    </div>
  )
}

/**
 * otto/mamoru#198 (was #193's three indicators): Monthly rate and Current rate, one row under the balance, the
 * figure over its label. The sources sit behind (i). A figure that is not known says n/a and why, never a guess.
 */
export function Indicators({ f, apy, price, noRead = false }: { f: FundingView | undefined; apy: ApyView | undefined; price: bigint | null; noRead?: boolean }) {
  const rows = f ? positionRates(f, apy, price) : []
  const waiting = noRead ? ('no-read' as const) : ('loading' as const)
  const monthly = f ? monthlyRate(rows, apy) : { pct: null, gap: waiting, covered: 0, of: 0, plan: false }
  const current = f ? currentRate(rows, apy, split(f, price)) : { pct: null, gap: waiting, covered: 0, of: 0 }
  const partial = (r: AccountRate) => (r.pct !== null && r.covered < r.of ? `${r.covered} of ${r.of} positions with a rate` : null)
  const monthlySrc = sourceName(apy?.monthlySource)
  const currentSrc = sourceName(apy?.currentSource)
  const monthlyTail = monthly.gap ? homeCopy.gap[monthly.gap] : [monthly.plan ? homeCopy.planPools : null, partial(monthly)].filter(Boolean).join(' · ') || null
  // otto/mamoru#198: the current rate is the whole balance's (paused and idle at 0%), so it needs no scope words.
  const currentTail = current.gap ? homeCopy.gap[current.gap] : partial(current)
  // Brais, 23-oct: the (i) sits right after the label it explains, not floating at the end of the row.
  const info =
    monthlySrc || currentSrc ? (
      <details className="rate-info" data-testid="rate-sources">
        <summary aria-label={homeCopy.sources}>
          <span aria-hidden="true">i</span>
        </summary>
        <p className="rate-sources">
          {monthlySrc ? <span>{homeCopy.monthlySource}: {monthlySrc}</span> : null}
          {currentSrc ? <span>{homeCopy.currentSource}: {currentSrc}</span> : null}
        </p>
      </details>
    ) : null
  return (
    <section className="rates" aria-label="Rates">
      <div className="rate">
        <p className={`rate-value${monthly.pct === null ? ' rate-na' : ''}`} data-testid="rate-monthly">
          {monthly.pct === null ? homeCopy.na : <TweenPct value={monthly.pct} countUp />}
        </p>
        <RateSub name={homeCopy.monthly} what={homeCopy.monthlyWhat} tail={monthlyTail} />
      </div>
      <div className="rate">
        <p className={`rate-value${current.pct === null ? ' rate-na' : ''}`} data-testid="rate-current">
          {current.pct === null ? homeCopy.na : <TweenPct value={current.pct} countUp />}
        </p>
        <RateSub name={homeCopy.current} what={homeCopy.currentWhat} tail={currentTail} info={info} />
      </div>
    </section>
  )
}

/** The pool's pair in pool order, as the venue names it: "USDC/USDT", "WETH/USDC". */
function pair(p: FundingView['positions'][number]): string {
  return poolTokens(p.pool, p.amounts).join('/')
}

function PositionRow({ p, r, i }: { p: FundingView['positions'][number]; r: PositionRate; i: number }) {
  const legs = positionAmounts(p).filter((l) => l.amount !== '0')
  const addr = poolAddress(p.pool)
  const chain = useChain()
  const venue = 'Uniswap v3'
  // otto/mamoru#216: against a target, the share is of the whole account (the target's own base); otherwise of working capital.
  const shown = r.targetPct !== null && r.accountPct !== null ? r.accountPct : r.sharePct
  const share = shown === null ? null : Math.round(shown)
  return (
    <li data-testid="position" className="wc-row" style={{ ['--i' as string]: i }}>
      <span className="wc-marks" aria-hidden="true">
        {poolTokens(p.pool, p.amounts).map((t, i) => (
          <span key={t} className={i > 0 ? '-ml-[0.55rem]' : undefined}>
            <TokenMark symbol={t} size={28} />
          </span>
        ))}
      </span>
      <span className="wc-name">
        <span className="wc-pair">
          {r.bucket} · {pair(p)}
        </span>
        <span className="wc-venue">
          {addr ? (
            <a className="seg" href={explorerAddress(chain, addr)} target="_blank" rel="noreferrer">
              {venue}
            </a>
          ) : (
            <span className="seg">{venue}</span>
          )}
          {' · '}
          <span className="seg" data-testid="position-chain">
            {chain.name}
          </span>
          {p.inRange ? ' · ' : null}
          {p.inRange ? <span className="seg text-emerald">{homeCopy.inRange}</span> : null}
        </span>
      </span>
      <span className="wc-amount">
        <span className="wc-num">
          {r.valueUsdc === null ? (
            homeCopy.na
          ) : (
            <>
              <TweenUsd raw={r.valueUsdc} /> <span className="wc-unit">USDC</span>
            </>
          )}
        </span>
        <span className="wc-legs">
          {legs.map((l, i) => (
            <Fragment key={l.token}>
              {i ? ' · ' : ''}
              <span className="seg">
                {tokenAmount(l.amount, l.token, l.decimals)} {l.token}
              </span>
            </Fragment>
          ))}
        </span>
      </span>
      <span className="wc-share">
        <span className="wc-num">
          <span className="sr-only">{homeCopy.colShare} </span>
          {share === null ? homeCopy.na : `${share}%`}
        </span>
        {r.targetPct !== null && r.accountPct !== null ? (
          <span className="wc-target" data-testid="position-target">
            {homeCopy.target(Math.round(r.targetPct))}
          </span>
        ) : null}
        <span className="wc-bar" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, shown ?? 0))}%` }} />
          {r.targetPct !== null && r.accountPct !== null ? <i className="wc-bar-target" style={{ left: `${Math.min(100, r.targetPct)}%` }} /> : null}
        </span>
      </span>
      {/* Desktop cells and the compact mobile line are never shown together (CSS), so each carries its own
          visually hidden labels and screen readers get the rates at every width. */}
      <span className={`wc-rate wc-num${r.currentPct === 0 || r.currentPct === null ? ' text-stone' : ''}`} data-testid="position-current">
        <span className="sr-only">{homeCopy.current} </span>
        {r.currentPct === 0 ? '0%' : pct(r.currentPct)}
      </span>
      <span className={`wc-rate wc-num${r.monthlyPct === null ? ' text-stone' : ''}`} data-testid="position-monthly">
        <span className="sr-only">{homeCopy.monthly} </span>
        {pct(r.monthlyPct)}
      </span>
      <span className="wc-rates-m" data-testid="position-rates-compact">
        <span className="sr-only">{homeCopy.current} </span>
        <span className={r.currentPct ? undefined : 'text-stone'}>{r.currentPct === 0 ? '0%' : pct(r.currentPct)}</span>
        <span className="sr-only">, {homeCopy.monthly} </span>
        <span className="text-stone">
          <span aria-hidden="true"> · 30d </span>
          {pct(r.monthlyPct)}
        </span>
      </span>
      {r.unpriced.length ? (
        <span className="wc-why" data-testid="position-unpriced">
          {homeCopy.unpriced(r.unpriced.join(', '))}
        </span>
      ) : null}
      {p.inRange ? null : <span className="wc-paused">{homeCopy.paused}</span>}
    </li>
  )
}

/**
 * otto/mamoru#193: Working capital, open by default: one row per position with its bucket and pair, venue and
 * range, value in USDC with each token, share of working capital and the pool's current and monthly rates. A
 * paused (out-of-range) position earns 0% today and says Mamoru puts it back to work.
 */
export function Working({ f, s, apy, price = null, onStop, onStart = null, otherChainsUsdc = 0n }: { f: FundingView; s: Split; apy?: ApyView; price?: bigint | null; onStop: (() => void) | null; onStart?: (() => void) | null; otherChainsUsdc?: bigint | null }) {
  const n = f.positions.length
  // otto/mamoru#216: targets are shares of the whole account, sleeves on other chains included; while their value is
  // unknown (null) no share is set against a target.
  const rows = positionRates(f, apy, price, s.priced && otherChainsUsdc !== null ? s.total + otherChainsUsdc : null)
  const inRange = f.positions.filter((p) => p.inRange).length
  // An operation in flight says what it is; between operations the engine says whether more is coming and when it looks next.
  const line = progressLine(f.progress) ?? engineLine(f)
  const noRate = apy !== undefined && rows.some((r) => r.monthlyPct === null || (r.inRange && r.currentPct === null))
  return (
    <Fold
      defaultOpen
      testId="working"
      head={
        <>
          <span className="dash-title heavy">{homeCopy.working}</span>
          <span className="panel-sum">
            <TweenUsd raw={s.working} /> <span className="panel-unit">USDC</span>
          </span>
          <span className="panel-meta">
            <span className="seg">{plural(n, 'position', 'positions')}</span>
            {n ? ' · ' : null}
            {n ? <span className="seg">{`${inRange} ${homeCopy.inRange.toLowerCase()}`}</span> : null}
          </span>
        </>
      }
      status={
        line ? (
          <p className="progress mono-label text-stone" role="status" aria-live="polite" data-testid="progress">
            <span className="progress-dot" aria-hidden="true" />
            {line}
          </p>
        ) : null
      }
    >
      {n === 0 ? (
        <p className="m-0 pt-3 text-[0.95rem] text-stone">{homeCopy.nothingPlaced}</p>
      ) : (
        <>
          <div className="wc-row wc-cols" aria-hidden="true">
            <span className="wc-name">{homeCopy.colPosition}</span>
            <span className="wc-amount">{homeCopy.colAmount}</span>
            <span className="wc-share">{homeCopy.colShare}</span>
            <span className="wc-rate">{homeCopy.current}</span>
            <span className="wc-rate">{homeCopy.monthly}</span>
          </div>
          <ul className="m-0 list-none p-0">
            {f.positions.map((p, i) => (
              <PositionRow key={p.tokenId} p={p} r={rows[i]!} i={i} />
            ))}
          </ul>
          {noRate ? <p className="m-0 pt-2 font-mono text-[0.72rem] text-stone">{homeCopy.noRate}</p> : null}
        </>
      )}
      {onStop || onStart ? (
        <div className="flex justify-end pt-4">
          <button type="button" className={onStop ? 'act stop' : 'act'} onClick={() => (onStop ?? onStart)!()}>
            {onStop ? homeCopy.stop : homeCopy.startAllocation}
          </button>
        </div>
      ) : null}
    </Fold>
  )
}

/** Base units to a short amount: registry decimals, capped at 6 fraction digits (8 for cbBTC). */
function tokenAmount(raw: string, token: string, decimals: number): string {
  if (decimalsOf(token) !== undefined) return token === 'USDC' || token === 'USDT' || token === 'EURC' ? usd(raw) : formatUnits(raw, token)
  const s = raw.padStart(decimals + 1, '0')
  const frac = s.slice(-decimals).slice(0, 6).replace(/0+$/, '')
  return `${s.slice(0, -decimals) || '0'}${frac ? `.${frac}` : ''}`
}

/** What the engine of a running account says between operations; null when it is not running or says nothing. */
export function engineLine(f: FundingView): string | null {
  if (!f.active || !f.engine) return null
  // Under the smallest entry (10 cents) a remainder is rounding, never named as money on its way (otto/mamoru#194).
  if (f.engine.placing) return BigInt(f.usdc) >= MIN_ENTRY_USDC ? homeCopy.putting(usd(f.usdc)) : homeCopy.placing
  // otto/mamoru#212: past the cap (counted across networks) new money stays idle; gains on what is placed are kept.
  if (f.exposure?.peerUnavailable) return homeCopy.peerUnread
  const over = BigInt(f.exposure?.overUsdc ?? '0')
  const held = over < BigInt(f.usdc) ? over : BigInt(f.usdc)
  if (held >= MIN_ENTRY_USDC) return homeCopy.overLimit(usd(held), usdPlain(f.exposure!.capUsdc))
  // otto/mamoru#128: money held back on purpose says why, so a still account never looks stopped.
  const waits = (f.engine.waiting ?? []).filter((w) => w.code === 'DECIDE_WAIT_DEPTH' || w.code === 'DECIDE_ENTRY_PAUSED_FALL')
  if (waits.length) {
    const time = f.engine.reviewedAt ? new Date(f.engine.reviewedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'the last review'
    if (waits.length > 1) {
      const codes = new Set(waits.map((w) => w.code))
      const why = codes.size > 1 ? homeCopy.whyBoth : codes.has('DECIDE_WAIT_DEPTH') ? homeCopy.whyDepth : homeCopy.whyFall
      return homeCopy.waitMany(usd(waits.reduce((s, w) => s + BigInt(w.amountUsdc), 0n)), waits.length, why, time)
    }
    const w = waits[0]!
    const pair = pairLabel(w.pool ?? undefined).replace(/ /g, '')
    return w.code === 'DECIDE_WAIT_DEPTH' ? homeCopy.waitDepth(usd(w.amountUsdc), pair, time) : homeCopy.waitFall(usd(w.amountUsdc), pair, time)
  }
  if (!f.engine.nextReviewAt) return null
  return homeCopy.upToDate(new Date(f.engine.nextReviewAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))
}

/**
 * otto/mamoru#193: Idle capital on one line, with why it is idle. Everything outside a position is here (USDC
 * and any other token left over), so this replaces the separate token list. It opens per token only when more
 * than one token is idle.
 */
export function Idle({ f, s }: { f: FundingView; s: Split }) {
  // One idle token that is not USDC (cbBTC left over, say) is named on the line itself, since nothing opens.
  const only = s.idleTokens.length === 1 && s.idleTokens[0]!.token !== 'USDC' ? s.idleTokens[0]! : null
  const unpriced = s.idleTokens.filter((t) => t.unpriced).map((t) => t.token)
  const head = (
    <>
      <span className="dash-title heavy" id="idle-title">
        {homeCopy.idle}
      </span>
      <span className="panel-sum">
        <TweenUsd raw={s.idle} /> <span className="panel-unit">USDC</span>
      </span>
      <span className="panel-meta" data-testid="idle-reason">
        {only ? (
          <>
            <span className="seg" data-testid="idle-only">
              {tokenAmount(String(only.amount), only.token, only.decimals)} {only.token}
            </span>
            {' · '}
          </>
        ) : null}
        {idleReason(f, s)}
        {unpriced.length ? ` · ${homeCopy.unpricedIdle(unpriced.join(', '))}` : ''}
      </span>
    </>
  )
  // #226: the same head as every panel; it opens only when there is more than one token to list.
  if (s.idleTokens.length <= 1) {
    return (
      <section className="panel panel-static" aria-labelledby="idle-title" data-testid="idle">
        <div className="panel-head">
          <span className="panel-head-main">{head}</span>
        </div>
      </section>
    )
  }
  return (
    <Fold testId="idle" head={head} labelledBy="idle-title">
      <ul className="idle-list" data-testid="idle-tokens">
        {s.idleTokens.map((t, i) => (
          <li key={t.token} style={{ ['--i' as string]: i }}>
            <TokenMark symbol={t.token} size={22} />
            <span>
              {tokenAmount(String(t.amount), t.token, t.decimals)} {t.token}
            </span>
            {t.token === 'USDC' ? null : <span className="text-stone">{t.unpriced ? `${homeCopy.na} USDC` : `${usd(t.valueUsdc)} USDC`}</span>}
          </li>
        ))}
      </ul>
    </Fold>
  )
}

export function History({ ops, onRetry, loaded = true }: { ops: OpView[]; onRetry?: (kind: OpView['kind']) => void; loaded?: boolean }) {
  const sorted = historyOps(ops)
  const chain = useChain()
  // #235: an event that lands while the page is open glows once; what the first completed read returned does not.
  // The baseline waits for that read (`loaded`), so an account's past events never arrive as new ones.
  const seen = useRef<Set<string> | null>(null)
  // Until when each arrival glows: the class outlives the render that found it, or the next poll would cut it short.
  const glowUntil = useRef(new Map<string, number>())
  const now = Date.now()
  if (seen.current === null) {
    if (loaded) seen.current = new Set(sorted.map((o) => o.opId))
  } else for (const o of sorted) if (!seen.current.has(o.opId) && !glowUntil.current.has(o.opId)) glowUntil.current.set(o.opId, now + 2000)
  const fresh = new Set([...glowUntil.current].filter(([, until]) => until > now).map(([id]) => id))
  useEffect(() => {
    if (seen.current) for (const o of sorted) seen.current.add(o.opId)
  })
  // Nothing to list yet: the same head, with nothing to open.
  if (!sorted.length)
    return (
      <section className="panel panel-static" data-testid="history">
        <div className="panel-head">
          <span className="panel-head-main">
            <span className="dash-title heavy">{homeCopy.history}</span>
            <span className="panel-meta">{plural(0, 'event', 'events')}</span>
          </span>
        </div>
      </section>
    )
  return (
    <Fold
      testId="history"
      defaultOpen={sorted.length > 0 && sorted.length <= 4}
      head={
        <>
          <span className="dash-title heavy">{homeCopy.history}</span>
          <span className="panel-meta">{plural(sorted.length, 'event', 'events')}</span>
        </>
      }
    >
      <ol className="m-0 mt-[0.7rem] grid list-none gap-[0.3rem] p-0">
        {sorted.map((op, i) => {
          const tone = opTone(op)
          return (
            <li
              key={op.opId}
              data-testid="op"
              data-tone={tone}
              style={{ ['--i' as string]: Math.min(i, 8) }}
              className={`op-row grid grid-cols-1 items-baseline gap-1 border-t border-wash pt-[0.35rem] min-[761px]:grid-cols-[9rem_5.5rem_minmax(0,1fr)_auto] min-[761px]:gap-[0.6rem]${fresh.has(op.opId) ? ' is-new' : ''}`}
            >
              <time dateTime={op.updatedAt}>{localTime(op.updatedAt)}</time>
              <span className="op-kind font-mono text-[0.78rem] uppercase tracking-[0.04em] text-emerald">
                <span className="op-dot" aria-hidden="true" />
                {KIND[op.kind]}
              </span>
              <span className={tone === 'done' ? undefined : 'text-stone'}>{opLine(op)}</span>
              {needsRetry(op) && onRetry ? (
                <button type="button" className="chipbtn min-[761px]:justify-self-end" onClick={() => onRetry(op.kind)}>
                  {homeCopy.retry}
                </button>
              ) : op.txHash ? (
                <a
                  className="op-tx font-mono text-[0.8rem] text-emerald min-[761px]:justify-self-end"
                  href={explorerTx(chain, op.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  title={`View on ${chain.explorer.name}`}
                >
                  {shortHex(op.txHash)}
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M9 2h5v5M14 2 7 9M12 10v4H2V4h4" />
                  </svg>
                  <span className="sr-only"> on {chain.explorer.name}</span>
                </a>
              ) : (
                <span />
              )}
            </li>
          )
        })}
      </ol>
    </Fold>
  )
}

/**
 * `onCancel`/`confirmLabel`/`confirmDisabled` are only passed by WithdrawDialog when prepare returned a
 * PriceDivergenceWarning (otto/mamoru#155): a calm "wait" next to the gated confirm, instead of the usual
 * single button. Every other caller omits them and gets exactly today's single centered confirm button.
 *
 * Security review on 1c54819: the buttons below call `onApprove()`/`onCancel()` with no arguments, never
 * `onClick={onApprove}` directly — a raw `onClick={onApprove}` would hand the button's click SyntheticEvent to
 * `onApprove` as its first argument. Every caller today passes an already-wrapped zero-arg closure, so this is
 * currently harmless either way, but `useOwnerAction`'s `approve(accept?)` takes an optional argument now
 * (otto/mamoru#155's acceptDivergence) — a future caller that forwards `flow.approve` unwrapped would leak the
 * event into it. Exported so a regression test can exercise this wiring directly.
 */
export function Review({
  lines,
  busy,
  error,
  onApprove,
  onCancel,
  cancelLabel,
  confirmLabel,
  confirmDisabled = false,
  scope,
  children,
}: {
  /** otto/mamoru#19: one plain line on what this signature does, said before the passkey prompt. */
  scope: ReactNode
  lines: string[]
  busy: string | null
  error: string | null
  onApprove: () => void
  onCancel?: () => void
  cancelLabel?: string
  confirmLabel?: string
  confirmDisabled?: boolean
  children?: ReactNode
}) {
  return (
    <div className="grid min-w-0 gap-3 [overflow-wrap:anywhere]" data-testid="review">
      {children}
      <p className="m-0 text-[0.95rem] leading-[1.45]" data-testid="sign-scope">
        {scope}
      </p>
      {lines.length ? (
        <ul className="m-0 grid gap-1 pl-5 text-[0.95rem]">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="err">{error}</p> : null}
      <div className={onCancel ? 'mt-1 flex justify-between gap-2' : 'flex justify-end'}>
        {onCancel ? (
          <button type="button" className="cta" onClick={() => onCancel()} disabled={busy !== null}>
            {cancelLabel}
          </button>
        ) : null}
        <button type="button" className={onCancel ? 'chipbtn' : 'cta'} onClick={() => onApprove()} disabled={busy !== null || confirmDisabled}>
          {busy === 'signing' ? 'Waiting for passkey' : confirmLabel ?? homeCopy.confirm}
        </button>
      </div>
    </div>
  )
}

function WithdrawDialog({ accountKey, s, open, onClose, initialAmount = '', deployed = true }: { accountKey: string; s: Split; open: boolean; onClose: () => void; initialAmount?: string; deployed?: boolean }) {
  const flow = useOwnerAction(accountKey, 'transfer')
  const [amount, setAmount] = useState(initialAmount)
  const [to, setTo] = useState('')
  const [asset, setAsset] = useState<WithdrawAsset>('USDC')
  const [invalid, setInvalid] = useState<string | null>(null)
  // otto/mamoru#155: which PriceDivergenceWarning object the owner ticked, if any — the exact instance from a
  // prepare response, not its quoteId. Compared by reference against the current `divergence` below rather
  // than cleared explicitly, so any fresh prepare (a new amount, or a stale-rewarn) un-ticks it on its own: a
  // new prepare always returns a new object, so the acceptance never carries over even if an operator were to
  // reuse the same quoteId by mistake.
  const [acceptedWarning, setAcceptedWarning] = useState<PriceDivergenceWarning | null>(null)
  const dest = useDestination(to)
  const chain = useChain()
  const assetsQ = useWithdrawAssets(accountKey, open)
  const options = withdrawOptions(assetsQ.data?.assets)
  const locale = detectLocale()
  const close = () => {
    flow.reset()
    setInvalid(null)
    setAcceptedWarning(null)
    onClose()
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const raw = parseUsdc(amount)
    if (raw === null) return setInvalid('Enter an amount above zero.')
    // otto/mamoru#135: no local check against `s.total`, which can be behind a deposit. prepareTransfer reads
    // the chain, and its refusal (INSUFFICIENT_FUNDS -> humanMessage below) is what the amount field shows.
    if (dest.state !== 'ok') return setInvalid(dest.state === 'invalid' ? dest.message : `Enter where the ${asset} should go.`)
    if (!options.find((o) => o.asset === asset)?.available) return setInvalid(`${asset} is not available right now.`)
    setInvalid(null)
    await flow.prepare({ to: dest.address as Hex0x, amountUsdc: raw, ...(asset === 'USDC' ? {} : { asset }) })
  }
  const error = flow.error ? humanMessage(flow.error, s.maxWithdraw) : null
  const done = flow.result !== null
  const divergence = flow.prepared?.divergence

  return (
    <Modal open={open} onClose={close} title={homeCopy.withdraw}>
      {done ? (
        <div className="grid gap-4">
          <p className="m-0 text-[1.05rem]">Sent. It shows in your history once it settles on {chain.name}.</p>
          <div className="flex justify-end">
            <button type="button" className="cta" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : flow.prepared ? (
        <Review
          scope={signatureCopy.withdraw(asset, { create: !deployed, fromPool: !!flow.prepared.reduce?.length })}
          lines={[]}
          busy={flow.busy}
          error={error}
          onApprove={() => void flow.approve(acceptancePayload(divergence, acceptedWarning))}
          onCancel={divergence ? close : undefined}
          cancelLabel={divergence ? waitLabel(locale) : undefined}
          confirmLabel={divergence ? withdrawAnywayLabel(locale) : undefined}
          confirmDisabled={transferConfirmDisabled(flow.busy, divergence, acceptedWarning)}
        >
          <p className="m-0 text-[2rem] leading-none text-emerald tabular-nums">
            ${usdExactInput(BigInt(parseUsdc(amount) ?? '0'))}
          </p>
          {flow.prepared.receive && flow.prepared.receive.asset !== 'USDC' ? (
            <div className="grid gap-1" data-testid="receive">
              <p className="m-0 flex items-center gap-2 text-[1.05rem]">
                <TokenMark symbol={flow.prepared.receive.asset} size={20} />
                {receiveLine(flow.prepared.receive)}
              </p>
              <p className="m-0 font-mono text-[0.8rem] text-stone">{flow.prepared.receive.route}</p>
            </div>
          ) : null}
          {dest.state === 'ok' ? (
            <div className="grid gap-1">
              <p className="kicker">To</p>
              {dest.name ? <p className="m-0 text-[1.05rem]">{dest.name}</p> : null}
              <p className="m-0 font-mono text-[0.82rem] break-all text-stone">{dest.address}</p>
            </div>
          ) : null}
          {divergence ? (
            <PriceDivergenceNotice
              warning={divergence}
              accepted={acceptedWarning === divergence}
              onAcceptedChange={(v) => setAcceptedWarning(v ? divergence : null)}
              locale={locale}
            />
          ) : null}
        </Review>
      ) : (
        <form className="grid gap-[0.55rem]" onSubmit={submit}>
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-stretch gap-2">
            <AssetPicker value={asset} options={options} onChange={setAsset} />
            <label className="relative block min-w-0">
              <span className="sr-only">Amount in USD</span>
              <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-stone">
                $
              </span>
              <input className="field pl-7" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" autoComplete="off" />
            </label>
            <button type="button" className="chipbtn" onClick={() => setAmount(usdExactInput(s.maxWithdraw))}>
              Max
            </button>
          </div>
          <p className="m-0 text-[0.85rem] text-stone">${usd((s.maxWithdraw / 10_000n) * 10_000n)} available</p>
          {asset !== 'USDC' ? (
            <p className="m-0 flex items-center gap-2 text-[0.88rem]" data-testid="receive-estimate">
              <TokenMark symbol={asset} size={16} />
              You receive {asset === 'JPYC' ? 'JPY*' : asset}. Mamoru swaps on Uniswap and shows the quote before your passkey.
            </p>
          ) : null}
          <label className="mt-2 grid gap-[0.35rem] text-[0.88rem]">
            <span>To</span>
            <input className="field mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x… or name.eth" autoComplete="off" spellCheck={false} autoCapitalize="off" />
          </label>
          <p className="m-0 min-h-[1.3rem] font-mono text-[0.8rem] text-stone" aria-live="polite">
            {dest.state === 'resolving' ? 'Looking up name' : dest.state === 'ok' && dest.name ? <span title={dest.address}>→ {shortHex(dest.address)}</span> : dest.state === 'invalid' && to.trim().length > 3 ? <span className="text-alert-ink">{dest.message}</span> : null}
          </p>
          {invalid || error ? <p className="err">{invalid ?? error}</p> : null}
          <div className="mt-1 flex justify-end">
            <button type="submit" className="cta" disabled={flow.busy !== null || dest.state === 'resolving'}>
              {flow.busy === 'preparing' ? 'Preparing' : homeCopy.withdraw}
            </button>
          </div>
          {asset === 'JPYC' ? <p className="m-0 text-[0.78rem] text-stone">* {JPYT_CAPTION}</p> : null}
        </form>
      )}
    </Modal>
  )
}

function StopDialog({ accountKey, s, open, onClose }: { accountKey: string; s: Split; open: boolean; onClose: () => void }) {
  const flow = useOwnerAction(accountKey, 'stop')
  const close = () => {
    flow.reset()
    onClose()
  }
  return (
    <Modal open={open} onClose={close} title={homeCopy.stop}>
      <p className="m-0 text-[0.88rem] text-stone">{usd(s.working)} USDC working</p>
      <p className="mt-2 mb-0 border border-[color-mix(in_srgb,#9b2c2c_55%,var(--color-wash))] bg-[color-mix(in_srgb,#9b2c2c_8%,var(--color-paper))] px-[0.7rem] py-[0.55rem] text-[0.88rem] leading-[1.4] text-alert-ink">
        {homeCopy.stopBody}
      </p>
      <div className="mt-4">
        {flow.result ? (
          <div className="grid gap-4">
            <p className="m-0">Stopping. It shows in your history as it settles.</p>
            <div className="flex justify-end">
              <button type="button" className="cta" onClick={close}>
                Done
              </button>
            </div>
          </div>
        ) : flow.prepared ? (
          <Review scope={signatureCopy.stop} lines={flow.prepared.tx.summary} busy={flow.busy} error={flow.error} onApprove={() => void flow.approve()} />
        ) : (
          <>
            {flow.error ? <p className="err mb-3">{flow.error}</p> : null}
            <div className="flex justify-end">
              <button type="button" className="cta" onClick={() => void flow.prepare()} disabled={flow.busy !== null}>
                {flow.busy === 'preparing' ? 'Preparing' : homeCopy.stop}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function StartDialog({ accountKey, s, open, onClose }: { accountKey: string; s: Split; open: boolean; onClose: () => void }) {
  const flow = useOwnerAction(accountKey, 'activate')
  const close = () => {
    flow.reset()
    onClose()
  }
  return (
    <Modal open={open} onClose={close} title={homeCopy.startAllocation}>
      <p className="m-0 text-[0.88rem] text-stone">{usd(s.idle)} USDC idle</p>
      <p className="mt-2 mb-0 text-[0.95rem]">{homeCopy.startBody}</p>
      <div className="mt-4">
        {flow.result ? (
          <div className="grid gap-4">
            <p className="m-0">Starting. It shows in your history as it settles.</p>
            <div className="flex justify-end">
              <button type="button" className="cta" onClick={close}>
                Done
              </button>
            </div>
          </div>
        ) : flow.prepared ? (
          <Review scope={<ActivateScope summary={flow.prepared.tx.summary} />} lines={flow.prepared.tx.summary} busy={flow.busy} error={flow.error} onApprove={() => void flow.approve()} />
        ) : (
          <>
            {flow.error ? <p className="err mb-3">{flow.error}</p> : null}
            <div className="flex justify-end">
              <button type="button" className="cta" onClick={() => void flow.prepare()} disabled={flow.busy !== null}>
                {flow.busy === 'preparing' ? 'Preparing' : homeCopy.startAllocation}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** The deposit is above the cap: say what happened and offer the one thing that fixes it. */
export function OverCapRow({ over, onWithdraw }: { over: OverCap; onWithdraw: () => void }) {
  return (
    <section className="card flex flex-wrap items-center justify-between gap-3" data-testid="over-cap" role="status">
      <span className="max-w-[40rem]">
        <span className="title">{homeCopy.overCapTitle(over)}</span>
        <span className="sub">{homeCopy.overCapBody(over)}</span>
      </span>
      <button type="button" className="act" onClick={onWithdraw}>
        {homeCopy.overCapAct(over)}
      </button>
    </section>
  )
}

/** The day an approval ends, as the owner's device writes dates. */
export function approvalDay(validUntil: number): string {
  return new Date(validUntil * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Identity of the approval row: a renewal or an extension that lands changes the approval (a new end date, fewer
 * grants missing), so the row mounts afresh and offers the next approval instead of staying hidden on the last result.
 */
export function approvalRowKey(approval: NonNullable<FundingView['approval']>): string {
  return `${approval.validUntil}-${approval.missing ?? 0}${approval.usage ? `-${approval.usage.spent ? 'spent' : 'used'}` : ''}${approval.upgrade ? `-upgrade-${approval.upgradePolicy ?? ''}` : ''}${approval.paused ? '-paused' : ''}${approval.capRaise ? `-cap-${approval.capRaise.capUsdc}` : ''}`
}

/**
 * otto/mamoru#151 (GPT-6 review P1, round 2): a prepared renewal is shown and approved only while it is what the row
 * offers right now: the same kind (a move to another policy, or a renewal of the account's own) and the same policy
 * (`upgradePolicy` for a move, the account's `policyId` otherwise). A v4 move prepared before the v5 flag came on, or a
 * v5 move prepared before the flag went off, is dropped and prepared again; the operator refuses both as well
 * (APPROVAL_TARGET_CHANGED). A prepare from an operator that names neither is judged on what it does name.
 */
export function preparedFitsRow(approval: NonNullable<FundingView['approval']>, tx: { policyId?: string; move?: boolean }): boolean {
  const move = approval.upgrade === true
  if (tx.move !== undefined && tx.move !== move) return false
  const offered = move ? approval.upgradePolicy : approval.policyId
  if (tx.policyId !== undefined && offered !== undefined && tx.policyId !== offered) return false
  return true
}

/** The renew flow's prepared transaction while it fits the row; one that no longer does is dropped (the next tap prepares). */
function useFittingPrepared(approval: NonNullable<FundingView['approval']>, flow: ReturnType<typeof useOwnerAction>) {
  const fits = !flow.prepared || preparedFitsRow(approval, flow.prepared.tx)
  const { reset } = flow
  useEffect(() => {
    if (!fits) reset()
  }, [fits, reset])
  return fits ? flow.prepared : null
}

const USAGE_WHAT: Record<NonNullable<NonNullable<FundingView['approval']>['usage']>['action'], string> = { collect: 'collecting fees', rerange: 're-ranging', enter: 'adding money' }

/** The row's title: an ended approval first, then a spent grant, a due renewal, a grant near its end, a missing grant. */
export function approvalTitle(approval: NonNullable<FundingView['approval']>): string {
  const u = approval.usage
  const usage = u ? (u.spent ? homeCopy.usageSpent : homeCopy.usageSoon)(USAGE_WHAT[u.action], u.pool ? pairLabel(u.pool) : 'its pools') : null
  if (approval.paused) return homeCopy.pausedTitle
  if (approval.expired) return homeCopy.renewEnded
  if (u?.spent) return usage!
  if (approval.renewDue) return homeCopy.renewSoon(approvalDay(approval.validUntil))
  if (usage) return usage
  if (approval.upgrade && isMultichainTarget(approval.upgradePolicy)) return homeCopy.upgradeMonadTitle
  // otto/mamoru#212: grants still missing are added first, without accepting a raise; the raise is the next tap.
  if (approval.capRaise && !(approval.missing ?? 0)) return homeCopy.capRaiseTitle(usdPlain(approval.capRaise.capUsdc), usdPlain(approval.capRaise.signedUsdc))
  return approval.upgrade ? (approval.upgradePolicy?.includes('-v5') ? homeCopy.upgradeV5Title : homeCopy.upgradeTitle) : homeCopy.extendTitle
}

/**
 * A running account whose approval is in its last weeks, or over, or has a grant that used 80% of what it allows
 * (#149): one tap renews it, nothing is moved. Or one that lacks grants of its plan (left out to fit Base's gas cap):
 * one tap adds them. The renewal, when due, goes first. The row only says so; the approval itself is reviewed and
 * signed in the approval dialog, the same one Home opens on its own when a renewal is due (#176).
 */
export function ApprovalRow({ approval, onOpen }: { approval: NonNullable<FundingView['approval']>; onOpen: () => void }) {
  const monad = approval.upgrade === true && isMultichainTarget(approval.upgradePolicy) && !approval.renewDue && !approval.expired && !approval.usage && !approval.paused
  return (
    <section className="card flex flex-wrap items-center justify-between gap-3" data-testid="renew" role="status">
      <span className="max-w-[40rem]">
        <span className="title">{approvalTitle(approval)}</span>
        <span className="sub">{monad ? homeCopy.upgradeMonadNote : homeCopy.renewNote}</span>
      </span>
      <button type="button" className="act" onClick={onOpen}>
        {monad ? homeCopy.upgradeMonad : approval.renewDue || approval.usage || approval.upgrade || approval.expired || (approval.capRaise && !(approval.missing ?? 0)) ? homeCopy.renew : homeCopy.extend}
      </button>
    </section>
  )
}

/** The dialog's title and one sentence under it, in the same order of precedence as the row's title. */
export function approvalHeading(approval: NonNullable<FundingView['approval']>): { title: string; lead: string } {
  const u = approval.usage
  const what = u ? `${USAGE_WHAT[u.action]} in ${u.pool ? pairLabel(u.pool) : 'its pools'}` : ''
  if (approval.paused) return { title: 'A guardian key has paused Mamoru', lead: 'It is not acting on this account. Renewing its approval ends that pause: renew only if you know why it was paused.' }
  if (approval.expired) return { title: "Mamoru's approval has ended", lead: 'Your money is where it was. Renew it so Mamoru can keep working.' }
  if (u?.spent) return { title: `Mamoru has stopped ${what}`, lead: 'It used all that this approval allows. Renewing restores its limits, counted from zero.' }
  if (approval.renewDue) return { title: homeCopy.renewAskTitle, lead: `It ends on ${approvalDay(approval.validUntil)}. Renewing keeps Mamoru working for you.` }
  if (u) return { title: 'Renew before a limit runs out', lead: `Mamoru has used most of what this approval allows for ${what}. Renew now so that does not stop.` }
  if (approval.capRaise && !(approval.missing ?? 0)) return { title: homeCopy.renewAskTitle, lead: homeCopy.capRaiseTitle(usdPlain(approval.capRaise.capUsdc), usdPlain(approval.capRaise.signedUsdc)) }
  if (approval.upgrade) return { title: homeCopy.renewAskTitle, lead: approval.upgradePolicy?.includes('-v5') ? homeCopy.upgradeV5Title : homeCopy.upgradeTitle }
  return { title: 'Let Mamoru work in every pool', lead: 'Part of the approval is missing: in some pools Mamoru cannot re-range or collect fees until you add it.' }
}

/**
 * otto/mamoru#148: owners cannot be messaged, so an approval in its last weeks (or over) is asked for in a dialog
 * the moment Home opens, once per visit and per approval. The row at the top stays for whoever closes it.
 */
export function renewAskFor(f: FundingView | undefined, renewing: boolean): string | null {
  if (!f || !f.active || !f.approval || renewing) return null
  // #149: a grant that ran out of what its approval allows has stopped the engine there: asked like a due renewal.
  if (f.approval.usage?.spent) return `mamoru:renew-asked:${f.address}:${f.approval.validUntil}:spent`
  if (!f.approval.renewDue) return null
  return `mamoru:renew-asked:${f.address}:${f.approval.validUntil}`
}

/** Keys already asked in this page load: the guarantee holds even when storage is blocked. */
const askedThisLoad = new Set<string>()

type AskStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Even reading `sessionStorage` can throw (a SecurityError getter when the browser denies it). */
function tabStorage(): AskStorage | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage
}

export function askedBefore(key: string, storageOf: () => AskStorage | null = tabStorage): boolean {
  if (askedThisLoad.has(key)) return true
  askedThisLoad.add(key)
  try {
    const storage = storageOf()
    if (storage?.getItem(key)) return true
    storage?.setItem(key, '1')
  } catch {
    // No storage (private mode, blocked): the in-memory set alone keeps it to once per page load.
  }
  return false
}

function RenewDialog({ accountKey, approval, open, onClose, onDone }: { accountKey: string; approval: NonNullable<FundingView['approval']>; open: boolean; onClose: () => void; onDone: (signedKey: string, opId: string) => void }) {
  const flow = useOwnerAction(accountKey, 'renew')
  const prepared = useFittingPrepared(approval, flow)
  const done = !!flow.result && flow.result.state !== 'failed'
  const doneOp = done ? flow.result!.opId : null
  useEffect(() => {
    if (!doneOp) return
    // The key of the approval this dialog signed, not whatever the poll shows by now, and the op that carries it.
    onDone(approvalRowKey(approval), doneOp)
    onClose()
  }, [doneOp, onClose, onDone, approval])
  const { title, lead } = approvalHeading(approval)
  return (
    <ApprovalDialog title={title} open={open && !done} onClose={onClose}>
      <ApprovalBody lead={lead} summary={prepared?.tx.summary ?? null} busy={flow.busy} error={flow.error} onPrepare={() => void flow.prepare()} onApprove={() => void (prepared ? flow.approve() : flow.prepare())} onLater={onClose} />
    </ApprovalDialog>
  )
}

/**
 * otto/mamoru#216: the move to a mix with a share on Monad. Step 1 opens the owner's Safe on Monad (its sleeve: created
 * here when it does not exist yet, then activated with the passkey on Monad's operator); step 2 is the usual renewal on
 * Base, to the target policy. Step 2 is offered only once the Monad Safe runs, and the Worker refuses it otherwise.
 */
function MonadUpgradeDialog({ accountKey, approval, open, onClose, onDone }: { accountKey: string; approval: NonNullable<FundingView['approval']>; open: boolean; onClose: () => void; onDone: (signedKey: string, opId: string) => void }) {
  const api = useApi()
  const qc = useQueryClient()
  const session = useSession()
  const sleeve = (session.data?.sleeves ?? []).find((x) => x.chainId === 143)
  const sleeveFunding = useFunding(sleeve?.accountKey, open && !!sleeve, 15_000)
  const monadFlow = useOwnerAction(sleeve?.accountKey, 'activate')
  const baseFlow = useOwnerAction(accountKey, 'renew')
  const prepared = useFittingPrepared(approval, baseFlow)
  const [opening, setOpening] = useState<string | null>(null)
  // Step 2 opens only on what the chain shows: the Monad Safe running, or its activation confirmed. A submitted or armed
  // op is not enough (it may still fail), and the renewal it unlocks lets Mamoru bridge to that Safe (#142 review).
  const monadDone = sleeveFunding.data?.active === true || monadFlow.result?.state === 'confirmed'
  const monadPending = !monadDone && !!monadFlow.result && monadFlow.result.state !== 'failed'
  const done = !!baseFlow.result && baseFlow.result.state !== 'failed'
  const doneOp = done ? baseFlow.result!.opId : null
  const reported = useRef<string | null>(null)
  useEffect(() => {
    if (!doneOp || reported.current === doneOp) return
    reported.current = doneOp
    onDone(approvalRowKey(approval), doneOp)
    onClose()
  }, [doneOp, onClose, onDone, approval])
  // No sleeve yet: create it (same passkey, same address); the next tap prepares its activation.
  const prepareMonad = async () => {
    setOpening(null)
    if (sleeve) return void monadFlow.prepare()
    setOpening(monadCopy.opening)
    try {
      await api.addSleeve(143)
      await qc.invalidateQueries({ queryKey: queryKeys.session })
      setOpening(null)
    } catch (e) {
      setOpening(e instanceof Error ? e.message : String(e))
    }
  }
  const rows = splitRows(approval.policyId ?? '', approval.upgradePolicy ?? '')
  return (
    <MonadConsentDialog
      open={open && !done}
      rows={rows}
      monadDone={monadDone}
      monadPending={monadPending}
      onClose={onClose}
      monad={{
        busy: opening === monadCopy.opening ? 'preparing' : monadFlow.busy,
        error: opening && opening !== monadCopy.opening ? opening : monadFlow.error,
        summary: monadFlow.prepared?.tx.summary ?? null,
        prepare: () => void prepareMonad(),
        approve: () => void (monadFlow.prepared ? monadFlow.approve() : prepareMonad()),
      }}
      base={{ busy: baseFlow.busy, error: baseFlow.error, summary: prepared?.tx.summary ?? null, prepare: () => void baseFlow.prepare(), approve: () => void (prepared ? baseFlow.approve() : baseFlow.prepare()) }}
    />
  )
}

/** The activation line, with the one thing it never does in bold. */
export function ActivateScope({ summary }: { summary: string[] }) {
  return (
    <>
      {activateLine(summary)} <strong>{signatureCopy.activate.never}</strong>
    </>
  )
}

function StartRow({ accountKey, funded }: { accountKey: string; funded: boolean }) {
  const flow = useOwnerAction(accountKey, 'activate')
  const tap = () => void (flow.prepared ? flow.approve() : flow.prepare())
  if (flow.result) return null
  return (
    <section className="card flex flex-wrap items-center justify-between gap-3" data-testid="start">
      <span>
        <span className="title">{funded ? homeCopy.notRunning : homeCopy.armFirst}</span>
        {flow.prepared ? (
          <span className="mt-1 block text-[0.95rem]" data-testid="sign-scope">
            <ActivateScope summary={flow.prepared.tx.summary} />
          </span>
        ) : null}
        {flow.error ? <span className="err mt-1 block">{flow.error}</span> : null}
      </span>
      <button type="button" className="act" onClick={tap} disabled={flow.busy !== null}>
        {flow.busy === 'signing' ? 'Waiting for passkey' : flow.busy === 'preparing' ? 'Preparing' : flow.prepared ? homeCopy.confirm : funded ? homeCopy.start : 'Approve'}
      </button>
    </section>
  )
}

export function HomeView({ accountKey }: { accountKey: string }) {
  const api = useApi()
  const ops = useOps(accountKey, true)
  const yieldLedger = useYieldLedger(accountKey)
  const opList = ops.data?.ops ?? []
  // An owner prepare that was never signed is not in flight; only armed or sent ops are. Keeps funding polling
  // fast (otto/mamoru#135) while one is on its way: an activation, renewal, transfer or stop.
  const inFlight = opList.some((o) => !TERMINAL.has(o.state) && !(o.state === 'proposed' && o.code !== 'ARMED' && !o.txHash))
  const funding = useFunding(accountKey, true, 30_000, inFlight)
  // otto/mamoru#135: the poll can be 15-60 s behind a deposit. Opening a dialog that shows an amount asks for a
  // read at most 2 s old; nothing waits on it, and nothing is decided on it (prepare reads the chain).
  const refreshFunding = useFreshFunding(accountKey)
  const pools = usePools()
  // otto/mamoru#216: the Monad sleeve's balance, for shares of the whole account against a multichain target.
  const sessionData = useSession().data
  const monadSleeve = (sessionData?.sleeves ?? []).find((x) => x.chainId === 143 && x.accountKey !== accountKey)
  const monadFunding = useFunding(monadSleeve?.accountKey, !!monadSleeve, 60_000)
  const [dialog, setDialog] = useState<null | 'add' | 'withdraw' | 'stop' | 'start'>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [howOpen, setHowOpen] = useState(false)
  const [renewAsked, setRenewAsked] = useState(false)
  // Amount the withdraw form opens with; a new value remounts the dialog.
  const [withdrawSeed, setWithdrawSeed] = useState('')
  // otto/mamoru#208 (reviews of PR #133): the live read is down whenever the last poll failed, cached data or not —
  // TanStack keeps the last good `data` next to the error. While it is down the page shows no cached read as current:
  // `f` is undefined (no cards, no actions, rates say "no live read") and the balance shows a past reading instead.
  // A 401 is a signed-out session, not an outage. Sticky through retries (review round 3): a refetch with no data yet
  // puts the query back to `pending` and clears `error`, so "down" is "the last outcome was a failure", from the two
  // timestamps TanStack keeps, and the last failure's status is remembered across the retry.
  const lastFailure401 = useRef(false)
  if (funding.error) lastFailure401.current = funding.error instanceof ApiRequestError && funding.error.status === 401
  const liveDown = funding.errorUpdatedAt > funding.dataUpdatedAt && !lastFailure401.current
  const cached = funding.data
  // Review round 4: a dialog the owner has open (a signed withdraw, stop, start or renewal may be on its way) is never
  // unmounted by an outage; it keeps the cached read until it is closed, and its own request reports what happened.
  const keepOpen = dialog !== null || renewAsked
  const f = liveDown && !keepOpen ? undefined : cached
  const multichain = isMultichainTarget(f?.approval?.policyId)
  // Unknown until the session has said whether a Monad sleeve exists and, if so, its balance has loaded (#142 review).
  const otherChainsUsdc = !multichain ? 0n : !sessionData ? null : !monadSleeve ? 0n : monadFunding.data ? split(monadFunding.data, null).total : null
  // The session ended while Home was open: ask again, and the first screen offers the sign-in.
  const qc = useQueryClient()
  const signedOut = funding.error instanceof ApiRequestError && funding.error.status === 401
  useEffect(() => {
    if (signedOut) void qc.invalidateQueries({ queryKey: queryKeys.session })
  }, [signedOut, qc])
  const price = cbbtcPrice(pools.data)
  const s = f ? split(f, price) : null
  // The past reading: this tab's last good read, or, with none, the last snapshot in D1. Its total is the one shown
  // while the read was live (review round 4): re-pricing it with a newer pool price would move a "last reading".
  const lastLiveTotal = useRef<bigint | null>(null)
  if (!liveDown && s) lastLiveTotal.current = s.total
  const past = !liveDown
    ? null
    : cached
      ? { totalUsd: (lastLiveTotal.current ?? split(cached, price).total).toString(), readAt: new Date(funding.dataUpdatedAt).toISOString() }
      : (yieldLedger.data?.lastBalance ?? null)
  const apy = useApy()
  const armed = activationLive(opList)
  // A renewal the owner signed is on its way: the row that asks for it steps aside until it settles.
  const renewing = opList.some((o) => o.kind === 'renew' && !TERMINAL.has(o.state))
  const renewAsk = renewAskFor(f, renewing)
  useEffect(() => {
    if (renewAsk && !askedBefore(renewAsk)) setRenewAsked(true)
  }, [renewAsk])
  const closeRenewAsk = useCallback(() => setRenewAsked(false), [])
  const openApproval = useCallback(() => setRenewAsked(true), [])
  // The approval just signed here: its row steps aside until the funding poll shows the next one (a new end date,
  // fewer grants missing), so it never offers a button whose dialog has nothing left to do (#176 review).
  // #176 review (Opus P1 2, 3): the signed approval is tied to its op. If that op fails, the row comes back so the
  // renewal can be tried again; while a renewal is on its way the dialog's gate drops, so the ask is closed too and
  // nothing reopens on its own for an approval just renewed.
  const [signed, setSigned] = useState<{ key: string; opId: string } | null>(null)
  const approvalKey = f?.approval ? approvalRowKey(f.approval) : null
  const markSigned = useCallback((key: string, opId: string) => setSigned({ key, opId }), [])
  const inFlightRenew = opList.find((o) => o.kind === 'renew' && !TERMINAL.has(o.state))?.opId ?? null
  useEffect(() => {
    if (!inFlightRenew) return
    setRenewAsked(false)
    // A renewal sent from elsewhere (another tab) marks the approval shown now as the one it renews.
    setSigned((s) => (s?.opId === inFlightRenew ? s : approvalKey ? { key: approvalKey, opId: inFlightRenew } : s))
  }, [inFlightRenew, approvalKey])
  const signedFailed = !!signed && opList.some((o) => o.opId === signed.opId && o.state === 'failed')
  const approvalOpen = !!f?.approval && (approvalKey !== signed?.key || signedFailed)
  // A confirmed activation exists somewhere in this account's history (Stop and restart only matter once this
  // is true); ops history, not the funding poll, so this is never behind it.
  const ranBefore = everStarted(opList)
  // Stopped after running: the Working card offers the restart where Stop was, so no Start row too.
  const stopped = !!f && !f.active && f.positions.length === 0 && !inFlight && ranBefore
  // Over the cap, the withdraw that clears it is the one notice-worthy thing (a Start would refuse anyway); this
  // state wins over an armed activation. Only a withdraw already on its way hides it. Start itself stays offered
  // next to it (otto/mamoru#135 review): the notice is a read on the same poll as everything else here, up to
  // 60 s behind a withdraw that already cleared the cap, and the operator's own prepare is what actually refuses
  // one that has not.
  const withdrawing = opList.some((o) => o.kind === 'transfer' && !TERMINAL.has(o.state))
  const over = withdrawing ? null : overCapOf(f)
  const below = belowMinimumOf(f)
  // otto/mamoru#135: offered on the operator's own state, not on the poll's idle balance, which can be behind the
  // deposit that makes a restart possible, or the withdraw that clears a cap; the start's prepare reads the
  // chain and says why when it cannot.
  const canRestart = stopped
  const canStart = !!f && !f.active && !inFlight && !armed && !stopped
  // otto/mamoru#135 review: whether this card offers Stop or a restart turns on f.positions, part of the
  // operator's cache (up to 60 s behind) — never invalidated by an engine move this client did not just submit
  // itself (another tab's stop, say). The moment the account looks idle, ask for a fresh (<=2 s) read instead
  // of waiting on the regular poll, so a stale zero positions can never hide Stop behind one that is still
  // really there; the Working card below rereads `f` once this lands.
  useEffect(() => {
    if (f && !f.active && !inFlight && ranBefore) void refreshFunding()
  }, [f?.active, inFlight, ranBefore, refreshFunding])
  const addMoney = () => {
    void refreshFunding()
    setDialog('add')
  }
  const start = () => {
    void refreshFunding()
    setDialog('start')
  }
  const withdraw = (seed = '') => {
    void refreshFunding()
    setWithdrawSeed(seed)
    setDialog('withdraw')
  }
  // A renewal is retried from its own row at the top, which is back as soon as the failed one settles.
  const retry = (kind: OpView['kind']) => (kind === 'renew' ? window.scrollTo({ top: 0, behavior: 'smooth' }) : kind === 'transfer' ? withdraw() : kind === 'exit' ? setDialog('stop') : start())
  // #226: pull down (home-screen app) or tap the live pill: every read on the page again, the balance at most 2 s old.
  const refreshAll = useCallback(
    () =>
      Promise.all([
        refreshFunding(),
        qc.invalidateQueries({ queryKey: queryKeys.ops(accountKey) }),
        qc.invalidateQueries({ queryKey: queryKeys.yieldLedger(accountKey) }),
        qc.invalidateQueries({ queryKey: queryKeys.apy }),
        qc.invalidateQueries({ queryKey: queryKeys.pools }),
      ]),
    [refreshFunding, qc, accountKey],
  )
  const kit = useMutation({
    mutationFn: async () => {
      // The kit is built from stored account data, not the operator (review round 3 of #133): any read of the
      // address will do, so it stays available while the live read is down.
      if (!cached) return
      downloadJson(kitFilename(cached.address), await api.recoveryKit(accountKey))
      await api.ackRecovery(accountKey).catch(() => undefined)
    },
  })

  return (
    <main className="page home enter">
      <title>Mamoru</title>
      <PullToRefresh onRefresh={refreshAll} />
      <header className="mb-7 flex items-center justify-between gap-3">
        <Brand />
        <LiveSync updatedAt={funding.dataUpdatedAt} intervalMs={fundingInterval(funding.data, inFlight, 30_000)} fetching={funding.isFetching} down={liveDown} onRefresh={() => void refreshAll().catch(() => undefined)} />
      </header>
      <Balance
        s={s}
        earnedSoFarUsd={yieldLedger.data?.earnedSoFarUsd}
        onAdd={addMoney}
        onWithdraw={() => withdraw()}
        past={past}
        down={liveDown}
      />
      <Indicators f={f} apy={apy.data} price={price} noRead={!f && liveDown} />
      <WrongNetwork accountKey={accountKey} />
      {past ? (
        <section className="card" data-testid="past-notice" role="status">
          <span className="title">{homeCopy.pastTitle}</span>
          <span className="sub">{homeCopy.pastBody}</span>
        </section>
      ) : null}
      {!f ? (
        liveDown ? (
          past ? null : <p className="err card">{homeCopy.noReading}</p>
        ) : (
          <div className="card h-40 animate-pulse" aria-hidden="true" />
        )
      ) : (
        <>
          {over ? (
            <>
              <OverCapRow over={over} onWithdraw={() => withdraw(usdInput(ceilCents(BigInt(over.excessUsdc))))} />
              {/* otto/mamoru#135 review: this notice reads the same (up to 60 s stale) poll as everything else on
                  this page. Start stays reachable next to it; its prepare reads the chain and is what actually
                  refuses one that is still over the cap, with the real reason. */}
              {canStart ? <StartRow accountKey={accountKey} funded={hasMoney(f)} /> : null}
            </>
          ) : below ? (
            <>
              <section className="card flex flex-wrap items-center justify-between gap-3" data-testid="below-minimum" role="status">
                <span className="max-w-[40rem]">
                  <span className="title">{homeCopy.belowTitle(below.minUsdc)}</span>
                  <span className="sub">{homeCopy.belowBody(below.usdc, below.missingUsdc)}</span>
                </span>
                <button type="button" className="act" onClick={addMoney}>
                  {homeCopy.add}
                </button>
              </section>
              {/* otto/mamoru#135: the top-up that clears this is a deposit, which the poll can be 15-60 s behind:
                  Start stays offered, and its prepare reads the chain and refuses below the minimum. */}
              {canStart ? <StartRow accountKey={accountKey} funded={hasMoney(f)} /> : null}
            </>
          ) : canStart ? (
            <StartRow accountKey={accountKey} funded={hasMoney(f)} />
          ) : f.active && f.approval && approvalOpen && (f.approval.renewDue || (f.approval.missing ?? 0) > 0 || f.approval.usage || f.approval.upgrade || f.approval.capRaise) && !renewing ? (
            <ApprovalRow key={approvalRowKey(f.approval)} approval={f.approval} onOpen={openApproval} />
          ) : null}
          <Working f={f} s={s as Split} apy={apy.data} price={price} otherChainsUsdc={otherChainsUsdc} onStop={f.active || f.positions.length > 0 ? () => setDialog('stop') : null} onStart={canRestart ? start : null} />
          <Idle f={f} s={s as Split} />
          <History ops={opList} onRetry={retry} loaded={ops.isSuccess} />
        </>
      )}
      <footer className="foot">
        <nav className="foot-links" aria-label="Account and help">
          <button type="button" className="foot-link" onClick={() => kit.mutate()} disabled={!cached || kit.isPending}>
            {kit.isSuccess ? 'Recovery kit saved' : 'Save recovery kit'}
            <Chevron dir="right" />
          </button>
          <button type="button" className="foot-link" onClick={() => setFeedbackOpen(true)}>
            {feedbackCopy.trigger}
            <Chevron dir="right" />
          </button>
          <button type="button" className="foot-link" onClick={() => setHowOpen(true)}>
            {howCopy.trigger}
            <Chevron dir="right" />
          </button>
        </nav>
        {/* otto/mamoru#198: the seal signs the page, the only red besides Stop. #226: centred under the links, not squeezed beside them. */}
        <div className="foot-sign">
          <span className="seal" aria-hidden="true">
            <img src="/seal-mamoru.png" width={36} height={36} alt="" />
            <span className="seal-word">MAMORU</span>
          </span>
        </div>
      </footer>
      <HowItWorks open={howOpen} onClose={() => setHowOpen(false)} />
      <FeedbackDialog accountKey={accountKey} open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />

      {f && s ? (
        <>
          <Modal open={dialog === 'add'} onClose={() => setDialog(null)} title={homeCopy.add}>
            <DepositDetails
              address={f.address}
              capUsdc={f.capUsdc}
              onConfirmed={() => {
                // otto/mamoru#191: no Sent screen to close by hand. Base confirmed (and said so): close, read the balance now.
                setDialog(null)
                void qc.invalidateQueries({ queryKey: queryKeys.funding(accountKey) })
              }}
            />
          </Modal>
          <WithdrawDialog key={withdrawSeed} accountKey={accountKey} s={s} open={dialog === 'withdraw'} onClose={() => setDialog(null)} initialAmount={withdrawSeed} deployed={f.deployed} />
          <StopDialog accountKey={accountKey} s={s} open={dialog === 'stop'} onClose={() => setDialog(null)} />
          <StartDialog accountKey={accountKey} s={s} open={dialog === 'start'} onClose={() => setDialog(null)} />
          {f.approval && f.active && !renewing && approvalOpen && (renewAsk || f.approval.renewDue || (f.approval.missing ?? 0) > 0 || f.approval.usage || f.approval.upgrade || f.approval.capRaise) ? (
            // otto/mamoru#142 review: a renewal that moves to the mix with Monad always goes through its consent and the
            // Monad step, due, expired or paused alike: never a one-tap renewal to it, never one the Worker must refuse.
            f.approval.upgrade && isMultichainTarget(f.approval.upgradePolicy) ? (
              <MonadUpgradeDialog onDone={markSigned} key={approvalRowKey(f.approval)} accountKey={accountKey} approval={f.approval} open={renewAsked && dialog === null && !feedbackOpen} onClose={closeRenewAsk} />
            ) : (
              <RenewDialog onDone={markSigned} key={approvalRowKey(f.approval)} accountKey={accountKey} approval={f.approval} open={renewAsked && dialog === null && !feedbackOpen} onClose={closeRenewAsk} />
            )
          ) : null}
        </>
      ) : null}
    </main>
  )
}
