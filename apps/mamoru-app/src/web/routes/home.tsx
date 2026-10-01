import type { FundingView, Hex0x, OpView, OverCap, WithdrawAsset } from '@mamoru/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiRequestError, useApi } from '../api/client.ts'
import { APY_REFRESH_MS, queryKeys, useApy, useFunding, useOps, usePools, useWithdrawAssets } from '../api/queries.ts'
import { AssetPicker } from '../components/asset-picker.tsx'
import { TokenMark } from '../components/token-mark.tsx'
import { BasescanLink, Brand, Modal, Waiting } from '../components/ui.tsx'
import { downloadJson, kitFilename } from '../lib/download.ts'
import { useDestination } from '../lib/ens.ts'
import { decimalsOf, formatUnits, shortHex } from '../lib/format.ts'
import { cbbtcPrice, ceilCents, humanMessage, overCapOf, split, usd, usdInput, usdPlain, type Split } from '../lib/money.ts'
import { activationLive, everStarted, historyOps, needsRetry, opLine, opTone, TERMINAL } from '../lib/ops.ts'
import { parseUsdc, useOwnerAction } from '../lib/owner-flow.ts'
import { pairLabel, poolAddress, positionAmounts, positionTokens, progressLine } from '../lib/positions.ts'
import { localTime } from '../lib/time.ts'
import { JPYT_CAPTION, receiveLine, withdrawOptions } from '../lib/withdraw-assets.ts'
import { DepositDetails, hasMoney } from './add-money.tsx'

export const homeCopy = {
  total: 'Total balance',
  apy: 'Current APY',
  month: 'Monthly average',
  add: 'Add capital',
  withdraw: 'Withdraw',
  stop: 'Stop allocation',
  startAllocation: 'Start allocation',
  startBody: 'Mamoru puts your idle USDC back to work in Uniswap v3 USDC/cbBTC. You approve with your passkey.',
  retry: 'Approve again',
  start: 'Start',
  working: 'Working capital',
  idle: 'Idle assets',
  history: 'Savings history',
  notRunning: 'Mamoru is not running on this money yet.',
  armFirst: 'Approve once. Mamoru starts when your money lands.',
  stopBody: 'Mamoru closes every position and swaps back to USDC. Your USDC stays in your account.',
  confirm: 'Confirm with passkey',
  createFirst: 'Your account is created on Base first, then the USDC is sent.',
  overCapTitle: (o: OverCap) => `This account is over the ${usdPlain(o.capUsdc)} USDC cap, so Mamoru has not started.`,
  overCapBody: (o: OverCap) => `It holds ${usd(o.usdc)} USDC. Nothing was moved. Withdraw at least ${usd(ceilCents(BigInt(o.excessUsdc)))} USDC to an address you control, then start Mamoru.`,
  overCapAct: (o: OverCap) => `Withdraw ${usd(ceilCents(BigInt(o.excessUsdc)))} USDC`,
}

const GITHUB = 'https://github.com/ottodevs/mamoru#readme'

const KIND: Record<OpView['kind'], string> = { activate: 'Start', enter: 'Position', reduce: 'Position', transfer: 'Withdraw', exit: 'Stop' }

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`)
/** Short caption from the source line: "Pool fees, last hour · GeckoTerminal" -> "GeckoTerminal · 1h". */
const caption = (source: string, window: string) => `${source.split(' · ').at(-1) ?? source} · ${window}`

/** One current and one monthly APY: the plan's pools weighted by bucket weights until positions earn fees. */
function ApyTiles() {
  const { data, dataUpdatedAt } = useApy()
  return (
    <>
      <li className="apr apr-live flex-1" title={data?.currentSource}>
        <span className="apr-label whitespace-nowrap">{homeCopy.apy}</span>
        <strong key={`v-${dataUpdatedAt}`} className="apr-fade" data-testid="apy-current">
          {pct(data?.currentPct)}
        </strong>
        {data && <span className="apr-src">{caption(data.currentSource, data.currentWindow)}</span>}
        {data && <span key={`t-${dataUpdatedAt}`} className="apr-tick" style={{ animationDuration: `${APY_REFRESH_MS}ms` }} aria-hidden="true" />}
      </li>
      <li className="apr flex-1" title={data?.monthlySource}>
        <span className="apr-label whitespace-nowrap">{homeCopy.month}</span>
        <strong data-testid="apy-month">{pct(data?.monthlyPct)}</strong>
        {data && <span className="apr-src">{caption(data.monthlySource, '30d')}</span>}
      </li>
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
        <ul className="m-0 flex w-full list-none gap-[0.7rem] p-0 self-center min-[761px]:w-auto">
          <ApyTiles />
        </ul>
      </div>
      <div className="mt-[1.15rem] flex flex-wrap gap-[0.7rem]">
        <button type="button" className="act" onClick={onAdd}>
          {homeCopy.add}
        </button>
        <button type="button" className="act" onClick={onWithdraw} disabled={!s || s.total === 0n}>
          {homeCopy.withdraw}
        </button>
      </div>
    </section>
  )
}

export function Working({ f, s, onStop, onStart = null }: { f: FundingView; s: Split; onStop: (() => void) | null; onStart?: (() => void) | null }) {
  const n = f.positions.length
  const assets = [...new Set([...positionTokens(f), ...(s.idleCbbtc > 0n ? ['cbBTC'] : [])])]
  const line = progressLine(f.progress)
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

export function Idle({ s }: { s: Split }) {
  const tokens = (s.idleUsdc > 0n ? 1 : 0) + (s.idleCbbtc > 0n ? 1 : 0)
  return (
    <section className="card" aria-labelledby="idle-title">
      <p className="m-0 flex flex-wrap items-baseline gap-x-[0.7rem]">
        <span className="title" id="idle-title">
          {homeCopy.idle}
        </span>
        <span className="title">{usd(s.idle)} USDC</span>
      </p>
      <p className="sub">
        {plural(tokens, 'token idle', 'tokens idle')}
        {s.idleCbbtc > 0n ? ` · ${formatUnits(String(s.idleCbbtc), 'cbBTC')} cbBTC` : ''}
      </p>
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

function Review({ lines, busy, error, onApprove, children }: { lines: string[]; busy: string | null; error: string | null; onApprove: () => void; children?: ReactNode }) {
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
      <div className="flex justify-end">
        <button type="button" className="cta" onClick={onApprove} disabled={busy !== null}>
          {busy === 'signing' ? 'Waiting for passkey' : homeCopy.confirm}
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
  const dest = useDestination(to)
  const assetsQ = useWithdrawAssets(accountKey, open)
  const options = withdrawOptions(assetsQ.data?.assets)
  const close = () => {
    flow.reset()
    setInvalid(null)
    onClose()
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const raw = parseUsdc(amount)
    if (raw === null) return setInvalid('Enter an amount above zero.')
    if (BigInt(raw) > s.total) return setInvalid(`You can withdraw up to $${usd(s.maxWithdraw)} right now.`)
    if (dest.state !== 'ok') return setInvalid(dest.state === 'invalid' ? dest.message : `Enter where the ${asset} should go.`)
    if (!options.find((o) => o.asset === asset)?.available) return setInvalid(`${asset} is not available right now.`)
    setInvalid(null)
    await flow.prepare({ to: dest.address as Hex0x, amountUsdc: raw, ...(asset === 'USDC' ? {} : { asset }) })
  }
  const error = flow.error ? humanMessage(flow.error, s.maxWithdraw) : null
  const done = flow.result !== null

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
          onApprove={() => void flow.approve()}
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
  const funding = useFunding(accountKey, true)
  const ops = useOps(accountKey, true)
  const pools = usePools()
  const [dialog, setDialog] = useState<null | 'add' | 'withdraw' | 'stop' | 'start'>(null)
  // Amount the withdraw form opens with; a new value remounts the dialog.
  const [withdrawSeed, setWithdrawSeed] = useState('')
  const f = funding.data
  // The session ended while Home was open: ask again, and the first screen offers the sign-in.
  const qc = useQueryClient()
  const signedOut = funding.error instanceof ApiRequestError && funding.error.status === 401
  useEffect(() => {
    if (signedOut) void qc.invalidateQueries({ queryKey: queryKeys.session })
  }, [signedOut, qc])
  const opList = ops.data?.ops ?? []
  const s = f ? split(f, cbbtcPrice(pools.data)) : null
  // An owner prepare that was never signed is not in flight; only armed or sent ops are.
  const inFlight = opList.some((o) => !TERMINAL.has(o.state) && !(o.state === 'proposed' && o.code !== 'ARMED' && !o.txHash))
  const armed = activationLive(opList)
  // Stopped after running: the Working card offers the restart where Stop was, so no Start row too.
  const stopped = !!f && !f.active && f.positions.length === 0 && !inFlight && everStarted(opList)
  // Over the cap the operator refuses Start, so the only action offered is the withdraw that fixes it.
  const over = inFlight ? null : overCapOf(f)
  const canRestart = stopped && !!s && s.idleUsdc > 0n && !over
  const withdraw = (seed = '') => {
    setWithdrawSeed(seed)
    setDialog('withdraw')
  }
  const retry = (kind: OpView['kind']) => (kind === 'transfer' ? withdraw() : setDialog(kind === 'exit' ? 'stop' : 'start'))
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
      <Balance s={s} onAdd={() => setDialog('add')} onWithdraw={() => withdraw()} />
      {!f ? (
        funding.isError ? (
          <p className="err card">Could not load your balance. Retrying.</p>
        ) : (
          <div className="card h-40 animate-pulse" aria-hidden="true" />
        )
      ) : (
        <>
          {over ? (
            <OverCapRow over={over} onWithdraw={() => withdraw(usdInput(ceilCents(BigInt(over.excessUsdc))))} />
          ) : !f.active && !inFlight && !armed && !stopped ? (
            <StartRow accountKey={accountKey} funded={hasMoney(f)} />
          ) : null}
          <Working f={f} s={s as Split} onStop={f.active || f.positions.length > 0 ? () => setDialog('stop') : null} onStart={canRestart ? () => setDialog('start') : null} />
          <Idle s={s as Split} />
          <History ops={opList} onRetry={retry} />
        </>
      )}
      <footer className="mt-auto flex flex-wrap gap-x-5 gap-y-2 border-t border-wash pt-5 text-[0.85rem] text-stone">
        <button type="button" className="text-stone underline decoration-wash underline-offset-4 hover:text-ink" onClick={() => kit.mutate()} disabled={!f || kit.isPending}>
          {kit.isSuccess ? 'Recovery kit saved' : 'Save recovery kit'}
        </button>
        <a className="underline decoration-wash underline-offset-4 hover:text-ink" href={GITHUB} target="_blank" rel="noreferrer">
          How Mamoru works
        </a>
      </footer>

      {f && s ? (
        <>
          <Modal open={dialog === 'add'} onClose={() => setDialog(null)} title={homeCopy.add}>
            <DepositDetails address={f.address} capUsdc={f.capUsdc} />
          </Modal>
          <WithdrawDialog key={withdrawSeed} accountKey={accountKey} s={s} open={dialog === 'withdraw'} onClose={() => setDialog(null)} initialAmount={withdrawSeed} deployed={f.deployed} />
          <StopDialog accountKey={accountKey} s={s} open={dialog === 'stop'} onClose={() => setDialog(null)} />
          <StartDialog accountKey={accountKey} s={s} open={dialog === 'start'} onClose={() => setDialog(null)} />
        </>
      ) : null}
    </main>
  )
}
