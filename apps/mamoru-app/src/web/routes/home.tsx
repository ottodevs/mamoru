import type { ApyView, FundingView, Hex0x, OpView, OverCap, PriceDivergenceWarning, WithdrawAsset } from '@mamoru/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiRequestError, useApi } from '../api/client.ts'
import { APY_REFRESH_MS, queryKeys, useApy, useFreshFunding, useFunding, useOps, usePools, useWithdrawAssets, useYieldLedger } from '../api/queries.ts'
import { AssetPicker } from '../components/asset-picker.tsx'
import { PriceDivergenceNotice } from '../components/price-divergence-notice.tsx'
import { TokenMark } from '../components/token-mark.tsx'
import { BasescanLink, Brand, InfoPopover, Modal, Waiting } from '../components/ui.tsx'
import { downloadJson, kitFilename } from '../lib/download.ts'
import { useDestination } from '../lib/ens.ts'
import { decimalsOf, formatUnits, shortHex } from '../lib/format.ts'
import { belowMinimumOf, cbbtcPrice, ceilCents, DUST_USDC, holdings, humanMessage, overCapOf, split, usd, usdInput, usdPlain, type Split } from '../lib/money.ts'
import { activationLive, everStarted, historyOps, needsRetry, opLine, opTone, TERMINAL } from '../lib/ops.ts'
import { parseUsdc, useOwnerAction } from '../lib/owner-flow.ts'
import { pairLabel, poolAddress, positionAmounts, positionTokens, progressLine } from '../lib/positions.ts'
import { acceptancePayload, detectLocale, transferConfirmDisabled, waitLabel, withdrawAnywayLabel } from '../lib/price-divergence.ts'
import { localTime } from '../lib/time.ts'
import { JPYT_CAPTION, receiveLine, withdrawOptions } from '../lib/withdraw-assets.ts'
import { DepositDetails, hasMoney } from './add-money.tsx'
import { WrongNetwork } from '../components/other-chain-notice.tsx'
import { FeedbackDialog, feedbackCopy } from '../components/feedback-dialog.tsx'

export const homeCopy = {
  total: 'Total balance',
  apy: 'Current APY',
  month: 'Monthly average',
  apyInfo: 'Sources and method',
  apyByPool: 'By pool',
  add: 'Add capital',
  withdraw: 'Withdraw',
  stop: 'Stop allocation',
  startAllocation: 'Start allocation',
  startBody: 'Mamoru puts your idle USDC back to work in Uniswap v3 USDC/cbBTC. You approve with your passkey.',
  retry: 'Approve again',
  start: 'Start',
  working: 'Working capital',
  idle: 'Idle assets',
  idlePlacing: 'Being placed',
  byToken: 'By token',
  placing: 'Placing your money. The next step starts in a few seconds.',
  upToDate: (time: string) => `Nothing to do right now. Mamoru looks again at ${time}.`,
  waitDepth: (amount: string, pair: string, time: string) => `${amount} USDC is waiting: the ${pair} pool is not deep enough for more right now. Checked at ${time}.`,
  waitFall: (amount: string, pair: string, time: string) => `${amount} USDC is waiting: ${pair} is falling fast, so Mamoru adds nothing there until it settles. Checked at ${time}.`,
  waitMany: (amount: string, n: number, why: string, time: string) => `${amount} USDC is waiting in ${n} pools: ${why}. Checked at ${time}.`,
  whyDepth: 'they are not deep enough for more right now',
  whyFall: 'their markets are falling fast',
  whyBoth: 'some are not deep enough for more right now, some are falling fast',
  history: 'Savings history',
  earnedSoFar: 'Earned so far',
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
  // otto/mamoru#149: a grant that has used 80% or all of what the approval allows.
  usageSoon: (what: string, pair: string) => `Mamoru has used most of what this approval allows for ${what} in ${pair}. Renew it now so that does not stop.`,
  usageSpent: (what: string, pair: string) => `Mamoru has used all that this approval allows for ${what} in ${pair}, so it has stopped doing that. Renew it to start again.`,
  createFirst: 'Your account is created on Base first, then the USDC is sent.',
  overCapTitle: (o: OverCap) => `This account is over the ${usdPlain(o.capUsdc)} USDC cap, so Mamoru has not started.`,
  overCapBody: (o: OverCap) => `It holds ${usd(o.usdc)} USDC. Nothing was moved. Withdraw at least ${usd(ceilCents(BigInt(o.excessUsdc)))} USDC to an address you control, then start Mamoru.`,
  belowTitle: (min: bigint) => `Mamoru starts from ${usdPlain(min)} USDC.`,
  belowBody: (usdc: bigint, missing: bigint) => `This account holds ${usd(usdc)} USDC, so it has not started. Add at least ${usd(ceilCents(missing))} USDC more.`,
  overCapAct: (o: OverCap) => `Withdraw ${usd(ceilCents(BigInt(o.excessUsdc)))} USDC`,
}

const GITHUB = 'https://github.com/ottodevs/mamoru#readme'

const KIND: Record<OpView['kind'], string> = { activate: 'Start', enter: 'Position', reduce: 'Position', transfer: 'Withdraw', exit: 'Stop', renew: 'Approval' }

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`)

/** The sources and method behind the two figures, and the figure behind each pool in the blend, for the info popover. */
function ApyDetail({ data }: { data: ApyView }) {
  return (
    <div className="info-body">
      <p className="info-row">
        <b>{homeCopy.apy}</b>
        {data.currentSource}
      </p>
      <p className="info-row">
        <b>{homeCopy.month}</b>
        {data.monthlySource}
      </p>
      {data.byPool && data.byPool.length > 0 && (
        <div>
          <p className="info-row mb-1">
            <b>{homeCopy.apyByPool}</b>
          </p>
          <table className="info-table">
            <thead>
              <tr>
                <th scope="col">Pool</th>
                <th scope="col">Weight</th>
                <th scope="col">{homeCopy.apy}</th>
                <th scope="col">{homeCopy.month}</th>
              </tr>
            </thead>
            <tbody>
              {data.byPool.map((p) => (
                <tr key={p.pool}>
                  <td>{pairLabel(p.pool).replace(/ /g, '')}</td>
                  <td>{(p.weight / 100).toFixed(0)}%</td>
                  <td>{pct(p.currentPct)}</td>
                  <td>{pct(p.monthlyPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * One current and one monthly APY: the plan's pools weighted by bucket weights until positions earn fees.
 * The info trigger renders outside both tiles (as its own flex item in the caller's list): `.apr-live`
 * clips overflow for its refresh hairline, which would also clip an absolutely positioned popover nested
 * inside it.
 */
function ApyTiles() {
  const { data, dataUpdatedAt } = useApy()
  return (
    <>
      <li className="apr apr-live flex-1">
        <span className="apr-label whitespace-nowrap">{homeCopy.apy}</span>
        <strong key={`v-${dataUpdatedAt}`} className="apr-fade" data-testid="apy-current">
          {pct(data?.currentPct)}
        </strong>
        {data && <span key={`t-${dataUpdatedAt}`} className="apr-tick" style={{ animationDuration: `${APY_REFRESH_MS}ms` }} aria-hidden="true" />}
      </li>
      <li className="apr flex-1">
        <span className="apr-label whitespace-nowrap">{homeCopy.month}</span>
        <strong data-testid="apy-month">{pct(data?.monthlyPct)}</strong>
      </li>
      {data && (
        <li className="flex items-end pb-[0.3rem]">
          <InfoPopover label={homeCopy.apyInfo}>
            <ApyDetail data={data} />
          </InfoPopover>
        </li>
      )}
    </>
  )
}

export function Balance({ s, onAdd, onWithdraw }: { s: Split | null; onAdd: () => void; onWithdraw: () => void }) {
  return (
    <section className="mb-8" aria-labelledby="total-title">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="kicker text-[0.86rem]! font-bold tracking-[0.14em]! text-ink!" id="total-title">
            {homeCopy.total}
          </p>
          <p className="sum" data-testid="total">
            {s ? usd(s.total) : '0.00'}
            <span className="unit">USDC</span>
          </p>
        </div>
        <ul className="m-0 flex w-full flex-wrap gap-[0.7rem] list-none p-0 self-center min-[761px]:w-auto min-[761px]:flex-nowrap">
          <ApyTiles />
        </ul>
      </div>
      <div className="mt-[1.15rem] flex flex-wrap gap-[0.7rem]">
        <button type="button" className="act" onClick={onAdd}>
          {homeCopy.add}
        </button>
        {/* otto/mamoru#135: never disabled on the poll's balance, which can be 15-60 s behind a deposit. The
            operator's prepare reads the chain and refuses with a reason the dialog shows. */}
        <button type="button" className="act" data-testid="withdraw-button" onClick={onWithdraw} disabled={!s}>
          {homeCopy.withdraw}
        </button>
      </div>
    </section>
  )
}

/**
 * otto/mamoru#129: uncollected fees plus anything collected, plain English, no extra claim. Only renders once
 * the yield ledger has a figure (the Worker's cron has pulled at least one operator snapshot for this account);
 * before then this is simply absent, never a placeholder zero.
 */
export function EarnedSoFar({ earnedSoFarUsd }: { earnedSoFarUsd: string | null | undefined }) {
  if (earnedSoFarUsd == null) return null
  return (
    <p className="mb-5 text-[0.9rem] text-stone" data-testid="earned-so-far">
      {homeCopy.earnedSoFar}: <span className="font-medium text-ink">{usd(earnedSoFarUsd)} USDC</span>
    </p>
  )
}

export function Working({ f, s, onStop, onStart = null }: { f: FundingView; s: Split; onStop: (() => void) | null; onStart?: (() => void) | null }) {
  const n = f.positions.length
  const assets = [...new Set([...positionTokens(f), ...(s.idleCbbtc > 0n ? ['cbBTC'] : []), ...s.idleTokens.map((t) => t.token)])]
  // An operation in flight says what it is; between operations the engine says whether more is coming and when it looks next.
  const line = progressLine(f.progress) ?? engineLine(f)
  return (
    <details className="card fold">
      <summary>
        <span className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-baseline gap-x-[0.7rem]">
            <span className="title heavy">{homeCopy.working}</span>
            <span className="title heavy text-emerald">{usd(s.working)} USDC</span>
          </span>
          {line ? (
            <span className="progress mono-label text-stone" role="status" aria-live="polite" data-testid="progress">
              <span className="progress-dot" aria-hidden="true" />
              {line}
            </span>
          ) : null}
          <span className="sub">{plural(n, 'open position', 'open positions')}</span>
        </span>
        {onStop ? (
          <button
            type="button"
            className="act stop ml-auto shrink-0"
            onClick={(e) => {
              e.preventDefault()
              onStop()
            }}
          >
            {homeCopy.stop}
          </button>
        ) : onStart ? (
          <button
            type="button"
            className="act ml-auto shrink-0"
            onClick={(e) => {
              e.preventDefault()
              onStart()
            }}
          >
            {homeCopy.startAllocation}
          </button>
        ) : (
          <span className="ml-auto" />
        )}
      </summary>
      <div className="grid gap-[0.7rem] pt-[0.7rem]">
        <p className="kicker">Assets in use</p>
        <ul className="m-0 flex list-none flex-wrap gap-x-[0.9rem] gap-y-[0.4rem] p-0">
          {assets.map((a) => (
            <li key={a} className="flex items-center gap-[0.45rem] font-mono text-[0.8rem] tracking-[0.06em]">
              <TokenMark symbol={a} />
              {a}
            </li>
          ))}
        </ul>
        <p className="kicker">Where it sits</p>
        {n === 0 ? (
          <p className="m-0 text-[0.92rem] text-stone">Nothing in a pool right now.</p>
        ) : (
          <ul className="m-0 grid list-none gap-[0.4rem] p-0">
            {f.positions.map((p) => {
              const legs = positionAmounts(p)
              const addr = poolAddress(p.pool)
              return (
                <li key={p.tokenId} data-testid="position" className="grid grid-cols-1 items-center gap-1 border-t border-wash pt-[0.45rem] min-[761px]:grid-cols-[auto_1fr_auto] min-[761px]:gap-[0.7rem]">
                  <span className="flex items-center">
                    {legs.map((l, i) => (
                      <span key={l.token} className={i > 0 ? '-ml-[0.45rem]' : undefined}>
                        <TokenMark symbol={l.token} />
                      </span>
                    ))}
                  </span>
                  <span className="flex min-w-0 flex-col gap-[0.05rem]">
                    <span className="text-base">{pairLabel(p.pool, p.amounts)}</span>
                    {addr ? (
                      <a className="truncate font-mono text-[0.78rem] text-stone no-underline hover:text-emerald" href={`https://basescan.org/address/${addr}`} target="_blank" rel="noreferrer">
                        Uniswap v3 · Base · {shortHex(addr)}
                      </a>
                    ) : null}
                    <span className={`font-mono text-[0.78rem] ${p.inRange ? 'text-stone' : 'text-alert-ink'}`}>{p.inRange ? 'In range' : 'Out of range'}</span>
                  </span>
                  <span className="flex flex-col font-mono text-[0.85rem] min-[761px]:items-end">
                    {p.valueUsdc !== undefined ? <span className="font-medium text-emerald">${usd(p.valueUsdc)}</span> : null}
                    <span className={p.valueUsdc !== undefined ? 'text-[0.78rem] text-stone' : 'font-medium text-emerald'}>
                      {legs.map((l) => `${tokenAmount(l.amount, l.token, l.decimals)} ${l.token}`).join(' + ')}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </details>
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
  if (f.engine.placing) return homeCopy.placing
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

/** `placing`: the engine is working through an entry, so what is outside a position is on its way in, not idle. */
export function Idle({ s, placing = false }: { s: Split; placing?: boolean }) {
  const listed = s.idleTokens.length > 0
  // Nothing from a cent up outside a position: say so rather than count the rounding left in each token.
  const tokens = listed ? s.idleTokens.length : s.idle < DUST_USDC ? 0 : (s.idleUsdc > 0n ? 1 : 0) + (s.idleCbbtc > 0n ? 1 : 0)
  return (
    <section className="card" aria-labelledby="idle-title">
      <p className="m-0 flex flex-wrap items-baseline gap-x-[0.7rem]">
        <span className="title" id="idle-title">
          {placing ? homeCopy.idlePlacing : homeCopy.idle}
        </span>
        <span className="title">{usd(s.idle)} USDC</span>
      </p>
      {listed ? (
        <ul className="m-0 mt-[0.35rem] grid list-none gap-[0.3rem] p-0" data-testid="idle-tokens">
          {s.idleTokens.map((t) => (
            <li key={t.token} className="flex items-center gap-[0.5rem] font-mono text-[0.82rem]">
              <TokenMark symbol={t.token} size={20} />
              <span>
                {tokenAmount(String(t.amount), t.token, t.decimals)} {t.token}
              </span>
              {t.token === 'USDC' ? null : <span className="text-stone">${usd(t.valueUsdc)}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="sub">
          {plural(tokens, placing ? 'token' : 'token idle', placing ? 'tokens' : 'tokens idle')}
          {s.idle >= DUST_USDC && s.idleCbbtc > 0n ? ` · ${formatUnits(String(s.idleCbbtc), 'cbBTC')} cbBTC` : ''}
        </p>
      )}
    </section>
  )
}

/** The whole account by token: idle plus both sides of every position, with what each is worth and its share. */
export function ByToken({ f, s }: { f: FundingView; s: Split }) {
  const rows = holdings(f)
  if (!rows || rows.length === 0 || s.total === 0n) return null
  return (
    <section className="card" aria-labelledby="by-token-title" data-testid="by-token">
      <p className="title m-0" id="by-token-title">
        {homeCopy.byToken}
      </p>
      <ul className="m-0 mt-[0.45rem] grid list-none gap-[0.4rem] p-0">
        {rows.map((h) => (
          <li key={h.token} className="grid grid-cols-[auto_1fr_auto] items-center gap-[0.6rem] border-t border-wash pt-[0.4rem] font-mono text-[0.85rem]">
            <TokenMark symbol={h.token} size={22} />
            <span className="flex min-w-0 flex-col">
              <span>
                {tokenAmount(String(h.amount), h.token, h.decimals)} {h.token}
              </span>
              {h.idle > 0n && h.working > 0n ? (
                <span className="text-[0.76rem] text-stone">
                  {tokenAmount(String(h.working), h.token, h.decimals)} in positions · {tokenAmount(String(h.idle), h.token, h.decimals)} outside
                </span>
              ) : (
                <span className="text-[0.76rem] text-stone">{h.working > 0n ? 'In positions' : 'Outside a position'}</span>
              )}
            </span>
            <span className="flex flex-col items-end">
              <span className="font-medium">${usd(h.valueUsdc)}</span>
              <span className="text-[0.76rem] text-stone">{Number((h.valueUsdc * 1000n) / s.total) / 10}%</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function History({ ops, onRetry }: { ops: OpView[]; onRetry?: (kind: OpView['kind']) => void }) {
  const sorted = historyOps(ops)
  return (
    <details className="card fold" open={sorted.length > 0 && sorted.length <= 4}>
      <summary>
        <span>
          <span className="title">{homeCopy.history}</span>
          <span className="sub">{plural(sorted.length, 'event', 'events')}</span>
        </span>
      </summary>
      <ol className="m-0 mt-[0.7rem] grid list-none gap-[0.3rem] p-0">
        {sorted.map((op) => {
          const tone = opTone(op)
          return (
            <li
              key={op.opId}
              data-testid="op"
              className="grid grid-cols-1 items-baseline gap-1 border-t border-wash pt-[0.35rem] min-[761px]:grid-cols-[9rem_5.5rem_minmax(0,1fr)_auto] min-[761px]:gap-[0.6rem]"
            >
              <time dateTime={op.updatedAt}>{localTime(op.updatedAt)}</time>
              <span className="font-mono text-[0.78rem] uppercase tracking-[0.04em] text-emerald">{KIND[op.kind]}</span>
              <span className={tone === 'done' ? undefined : 'text-stone'}>{opLine(op)}</span>
              {needsRetry(op) && onRetry ? (
                <button type="button" className="chipbtn min-[761px]:justify-self-end" onClick={() => onRetry(op.kind)}>
                  {homeCopy.retry}
                </button>
              ) : op.txHash ? (
                <span className="flex items-center gap-1 font-mono text-[0.8rem] text-emerald min-[761px]:justify-self-end">
                  {shortHex(op.txHash)}
                  <BasescanLink tx={op.txHash} />
                </span>
              ) : (
                <span />
              )}
            </li>
          )
        })}
      </ol>
    </details>
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
  children,
}: {
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
          <p className="m-0 text-[1.05rem]">Sent. It shows in your history once it settles on Base.</p>
          <div className="flex justify-end">
            <button type="button" className="cta" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : flow.prepared ? (
        <Review
          lines={[...(deployed ? [] : [homeCopy.createFirst]), ...(flow.prepared.reduce?.length ? ['Mamoru first takes the missing USDC out of the pool.'] : [])]}
          busy={flow.busy}
          error={error}
          onApprove={() => void flow.approve(acceptancePayload(divergence, acceptedWarning))}
          onCancel={divergence ? close : undefined}
          cancelLabel={divergence ? waitLabel(locale) : undefined}
          confirmLabel={divergence ? withdrawAnywayLabel(locale) : undefined}
          confirmDisabled={transferConfirmDisabled(flow.busy, divergence, acceptedWarning)}
        >
          <p className="m-0 text-[2rem] leading-none text-emerald tabular-nums">
            ${usd(BigInt(parseUsdc(amount) ?? '0'))}
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
            <button type="button" className="chipbtn" onClick={() => setAmount(usdInput(s.maxWithdraw))}>
              Max
            </button>
          </div>
          <p className="m-0 text-[0.85rem] text-stone">${usd(s.maxWithdraw)} available</p>
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
          <Review lines={flow.prepared.tx.summary} busy={flow.busy} error={flow.error} onApprove={() => void flow.approve()} />
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
          <Review lines={flow.prepared.tx.summary} busy={flow.busy} error={flow.error} onApprove={() => void flow.approve()} />
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
  return `${approval.validUntil}-${approval.missing ?? 0}${approval.usage ? `-${approval.usage.spent ? 'spent' : 'used'}` : ''}`
}

const USAGE_WHAT: Record<NonNullable<NonNullable<FundingView['approval']>['usage']>['action'], string> = { collect: 'collecting fees', rerange: 're-ranging', enter: 'adding money' }

/** The row's title: an ended approval first, then a spent grant, a due renewal, a grant near its end, a missing grant. */
export function approvalTitle(approval: NonNullable<FundingView['approval']>): string {
  const u = approval.usage
  const usage = u ? (u.spent ? homeCopy.usageSpent : homeCopy.usageSoon)(USAGE_WHAT[u.action], u.pool ? pairLabel(u.pool) : 'its pools') : null
  if (approval.expired) return homeCopy.renewEnded
  if (u?.spent) return usage!
  if (approval.renewDue) return homeCopy.renewSoon(approvalDay(approval.validUntil))
  return usage ?? homeCopy.extendTitle
}

/**
 * A running account whose approval is in its last weeks, or over, or has a grant that used 80% of what it allows
 * (#149): one tap renews it, nothing is moved. Or one that lacks grants of its plan (left out to fit Base's gas cap):
 * one tap adds them. The renewal, when due, goes first.
 */
function RenewRow({ accountKey, approval }: { accountKey: string; approval: NonNullable<FundingView['approval']> }) {
  const flow = useOwnerAction(accountKey, 'renew')
  // A renewal that failed leaves the row in place: this is where it is tried again.
  if (flow.result && flow.result.state !== 'failed') return null
  return <ApprovalCard approval={approval} summary={flow.prepared?.tx.summary ?? null} busy={flow.busy} error={flow.error} onPrepare={() => void flow.prepare()} onApprove={() => void flow.approve()} />
}

/** The approval row itself: what is asked, and once prepared, every line the passkey is about to sign. */
export function ApprovalCard({ approval, summary, busy, error, onPrepare, onApprove }: { approval: NonNullable<FundingView['approval']>; summary: string[] | null; busy: string | null; error: string | null; onPrepare: () => void; onApprove: () => void }) {
  const title = approvalTitle(approval)
  if (summary) {
    return (
      <section className="card grid gap-3" data-testid="renew" role="status">
        <span className="title">{title}</span>
        <Review lines={summary} busy={busy} error={error} onApprove={onApprove} />
      </section>
    )
  }
  return (
    <section className="card flex flex-wrap items-center justify-between gap-3" data-testid="renew" role="status">
      <span className="max-w-[40rem]">
        <span className="title">{title}</span>
        <span className="sub">{homeCopy.renewNote}</span>
        {error ? <span className="err mt-1 block">{error}</span> : null}
      </span>
      <button type="button" className="act" onClick={onPrepare} disabled={busy !== null}>
        {busy === 'preparing' ? 'Preparing' : approval.renewDue || approval.usage ? homeCopy.renew : homeCopy.extend}
      </button>
    </section>
  )
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

function RenewDialog({ accountKey, approval, open, onClose }: { accountKey: string; approval: NonNullable<FundingView['approval']>; open: boolean; onClose: () => void }) {
  const flow = useOwnerAction(accountKey, 'renew')
  const done = !!flow.result && flow.result.state !== 'failed'
  useEffect(() => {
    if (done) onClose()
  }, [done, onClose])
  return (
    <Modal open={open && !done} onClose={onClose} title={homeCopy.renewAskTitle}>
      <div data-testid="renew-dialog">
        <ApprovalCard approval={approval} summary={flow.prepared?.tx.summary ?? null} busy={flow.busy} error={flow.error} onPrepare={() => void flow.prepare()} onApprove={() => void flow.approve()} />
      </div>
    </Modal>
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
  const [dialog, setDialog] = useState<null | 'add' | 'withdraw' | 'stop' | 'start'>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [renewAsked, setRenewAsked] = useState(false)
  // Amount the withdraw form opens with; a new value remounts the dialog.
  const [withdrawSeed, setWithdrawSeed] = useState('')
  const f = funding.data
  // The session ended while Home was open: ask again, and the first screen offers the sign-in.
  const qc = useQueryClient()
  const signedOut = funding.error instanceof ApiRequestError && funding.error.status === 401
  useEffect(() => {
    if (signedOut) void qc.invalidateQueries({ queryKey: queryKeys.session })
  }, [signedOut, qc])
  const s = f ? split(f, cbbtcPrice(pools.data)) : null
  const armed = activationLive(opList)
  // A renewal the owner signed is on its way: the row that asks for it steps aside until it settles.
  const renewing = opList.some((o) => o.kind === 'renew' && !TERMINAL.has(o.state))
  const renewAsk = renewAskFor(f, renewing)
  useEffect(() => {
    if (renewAsk && !askedBefore(renewAsk)) setRenewAsked(true)
  }, [renewAsk])
  const closeRenewAsk = useCallback(() => setRenewAsked(false), [])
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
  const kit = useMutation({
    mutationFn: async () => {
      if (!f) return
      downloadJson(kitFilename(f.address), await api.recoveryKit(accountKey))
      await api.ackRecovery(accountKey).catch(() => undefined)
    },
  })

  return (
    <main className="page enter">
      <title>Mamoru · Home</title>
      <header className="mb-7">
        <Brand />
      </header>
      <Balance s={s} onAdd={addMoney} onWithdraw={() => withdraw()} />
      <EarnedSoFar earnedSoFarUsd={yieldLedger.data?.earnedSoFarUsd} />
      <WrongNetwork accountKey={accountKey} />
      {!f ? (
        funding.isError ? (
          <p className="err card">Could not load your balance. Retrying.</p>
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
          ) : f.active && f.approval && (f.approval.renewDue || (f.approval.missing ?? 0) > 0 || f.approval.usage) && !renewing ? (
            <RenewRow key={approvalRowKey(f.approval)} accountKey={accountKey} approval={f.approval} />
          ) : null}
          <Working f={f} s={s as Split} onStop={f.active || f.positions.length > 0 ? () => setDialog('stop') : null} onStart={canRestart ? start : null} />
          <Idle s={s as Split} placing={f.active && (f.engine?.placing === true || !!f.progress)} />
          <ByToken f={f} s={s as Split} />
          <History ops={opList} onRetry={retry} />
        </>
      )}
      <footer className="mt-auto flex flex-wrap gap-x-5 gap-y-2 border-t border-wash pt-5 text-[0.85rem] text-stone">
        <button type="button" className="text-stone underline decoration-wash underline-offset-4 hover:text-ink" onClick={() => kit.mutate()} disabled={!f || kit.isPending}>
          {kit.isSuccess ? 'Recovery kit saved' : 'Save recovery kit'}
        </button>
        <button type="button" className="text-stone underline decoration-wash underline-offset-4 hover:text-ink" onClick={() => setFeedbackOpen(true)}>
          {feedbackCopy.trigger}
        </button>
        <a className="underline decoration-wash underline-offset-4 hover:text-ink" href={GITHUB} target="_blank" rel="noreferrer">
          How Mamoru works
        </a>
      </footer>
      <FeedbackDialog accountKey={accountKey} open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />

      {f && s ? (
        <>
          <Modal open={dialog === 'add'} onClose={() => setDialog(null)} title={homeCopy.add}>
            <DepositDetails address={f.address} capUsdc={f.capUsdc} />
          </Modal>
          <WithdrawDialog key={withdrawSeed} accountKey={accountKey} s={s} open={dialog === 'withdraw'} onClose={() => setDialog(null)} initialAmount={withdrawSeed} deployed={f.deployed} />
          <StopDialog accountKey={accountKey} s={s} open={dialog === 'stop'} onClose={() => setDialog(null)} />
          <StartDialog accountKey={accountKey} s={s} open={dialog === 'start'} onClose={() => setDialog(null)} />
          {f.approval && renewAsk ? (
            <RenewDialog key={approvalRowKey(f.approval)} accountKey={accountKey} approval={f.approval} open={renewAsked && dialog === null && !feedbackOpen} onClose={closeRenewAsk} />
          ) : null}
        </>
      ) : null}
    </main>
  )
}
