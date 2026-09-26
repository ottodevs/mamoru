import type { FundingView, Hex0x, OpView, WithdrawAsset } from '@mamoru/domain'
import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useApi } from '../api/client.ts'
import { APY_REFRESH_MS, useApy, useFunding, useOps, usePools, useWithdrawAssets } from '../api/queries.ts'
import { AssetPicker } from '../components/asset-picker.tsx'
import { TokenMark } from '../components/token-mark.tsx'
import { BasescanLink, Brand, Modal, Waiting } from '../components/ui.tsx'
import { downloadJson, kitFilename } from '../lib/download.ts'
import { useDestination } from '../lib/ens.ts'
import { formatUnits, shortHex } from '../lib/format.ts'
import { cbbtcPrice, humanMessage, split, usd, usdInput, type Split } from '../lib/money.ts'
import { activationLive, opLine, opTone, TERMINAL } from '../lib/ops.ts'
import { parseUsdc, useOwnerAction } from '../lib/owner-flow.ts'
import { localTime } from '../lib/time.ts'
import { receiveLine, withdrawOptions } from '../lib/withdraw-assets.ts'
import { DepositDetails, hasMoney } from './add-money.tsx'

export const homeCopy = {
  total: 'Total balance',
  apy: 'Current APY',
  month: 'Monthly average',
  week: '7-day average',
  add: 'Add capital',
  withdraw: 'Withdraw',
  stop: 'Stop allocation',
  start: 'Start',
  working: 'Working capital',
  idle: 'Idle assets',
  history: 'Savings history',
  notRunning: 'Mamoru is not running on this money yet.',
  armFirst: 'Approve once. Mamoru starts when your money lands.',
  starting: 'Approved. Mamoru starts on this deposit shortly.',
  stopBody: 'Mamoru closes every position and swaps back to USDC. Your USDC stays in your account.',
  confirm: 'Confirm with passkey',
}

const GITHUB = 'https://github.com/ottodevs/mamoru#readme'

const KIND: Record<OpView['kind'], string> = { activate: 'Start', enter: 'Position', reduce: 'Position', transfer: 'Withdraw', exit: 'Stop' }

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`)
/** Short caption from the source line: "Pool fees, last hour · GeckoTerminal" -> "GeckoTerminal · 1h". */
const caption = (source: string, window: string) => `${source.split(' · ').at(-1) ?? source} · ${window}`

/** Pool-level fee APR of the plan's live pool (Uniswap v3 USDC/cbBTC 0.05% on Base), sourced upstream. */
function ApyTiles() {
  const { data, dataUpdatedAt } = useApy()
  const weekly = data?.monthlySource.startsWith('7-day') ?? false
  return (
    <>
      <li className="apr apr-live flex-1" title={data?.currentSource}>
        <span className="apr-label whitespace-nowrap">{homeCopy.apy}</span>
        <strong key={dataUpdatedAt} className="apr-fade" data-testid="apy-current">
          {pct(data?.currentPct)}
        </strong>
        {data && <span className="apr-src">{caption(data.currentSource, data.currentWindow)}</span>}
        {data && <span key={dataUpdatedAt} className="apr-tick" style={{ animationDuration: `${APY_REFRESH_MS}ms` }} aria-hidden="true" />}
      </li>
      <li className="apr flex-1" title={data?.monthlySource}>
        <span className="apr-label whitespace-nowrap">{weekly ? homeCopy.week : homeCopy.month}</span>
        <strong data-testid="apy-month">{pct(data?.monthlyPct)}</strong>
        {data && <span className="apr-src">{caption(data.monthlySource, weekly ? '7d' : '30d')}</span>}
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

export function Working({ f, s, onStop }: { f: FundingView; s: Split; onStop: (() => void) | null }) {
  const n = f.positions.length
  const assets = ['USDC', ...(s.workingCbbtc > 0n || s.idleCbbtc > 0n ? ['cbBTC'] : [])]
  return (
    <details className="card fold">
      <summary>
        <span className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-baseline gap-x-[0.7rem]">
            <span className="title heavy">{homeCopy.working}</span>
            <span className="title heavy text-emerald">{usd(s.working)} USDC</span>
          </span>
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
            {f.positions.map((p) => (
              <li key={p.tokenId} className="grid grid-cols-1 items-center gap-1 border-t border-wash pt-[0.45rem] min-[761px]:grid-cols-[auto_1fr_auto] min-[761px]:gap-[0.7rem]">
                <span className="flex items-center">
                  <TokenMark symbol="USDC" />
                  <span className="-ml-[0.45rem]">
                    <TokenMark symbol="cbBTC" />
                  </span>
                </span>
                <span className="flex min-w-0 flex-col gap-[0.05rem]">
                  <span className="text-base">Uniswap v3 · USDC / cbBTC</span>
                  <a className="truncate font-mono text-[0.78rem] text-stone no-underline hover:text-emerald" href={`https://basescan.org/address/${p.pool}`} target="_blank" rel="noreferrer">
                    Base · {shortHex(p.pool)}
                  </a>
                  <span className={`font-mono text-[0.78rem] ${p.inRange ? 'text-stone' : 'text-alert-ink'}`}>{p.inRange ? 'In range' : 'Out of range'}</span>
                </span>
                <span className="font-mono text-[0.85rem] font-medium text-emerald">
                  {usd(p.amountUsdc)} USDC{BigInt(p.amountCbbtc) > 0n ? ` + ${formatUnits(p.amountCbbtc, 'cbBTC')} cbBTC` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
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

export function History({ ops }: { ops: OpView[] }) {
  const sorted = [...ops].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
              <span className={tone === 'failed' ? 'text-alert-ink' : tone === 'pending' ? 'text-stone' : undefined}>{opLine(op)}</span>
              {op.txHash ? (
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

function WithdrawDialog({ accountKey, s, open, onClose }: { accountKey: string; s: Split; open: boolean; onClose: () => void }) {
  const flow = useOwnerAction(accountKey, 'transfer')
  const [amount, setAmount] = useState('')
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
    if (BigInt(raw) > s.total) return setInvalid(`You can withdraw up to ${usd(s.maxWithdraw)} USDC right now.`)
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
          lines={flow.prepared.reduce?.length ? ['Mamoru first takes the missing USDC out of the pool.'] : []}
          busy={flow.busy}
          error={error}
          onApprove={() => void flow.approve()}
        >
          <p className="m-0 text-[2rem] leading-none text-emerald tabular-nums">
            {usd(BigInt(parseUsdc(amount) ?? '0'))} <span className="text-[0.9rem] tracking-[0.12em] text-stone">USDC</span>
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
            <span className="flex items-center gap-2 border border-ink bg-paper px-3 font-mono tracking-[0.1em]">
              <TokenMark symbol="USDC" size={20} />
              USDC
            </span>
            <label className="block min-w-0">
              <span className="sr-only">Amount</span>
              <input className="field" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" autoComplete="off" />
            </label>
            <button type="button" className="chipbtn" onClick={() => setAmount(usdInput(s.maxWithdraw))}>
              Max
            </button>
          </div>
          <p className="m-0 text-[0.85rem] text-stone">{usd(s.maxWithdraw)} USDC available</p>
          <div className="mt-2 grid gap-[0.35rem] text-[0.88rem]">
            <span>Receive as</span>
            <AssetPicker value={asset} options={options} onChange={setAsset} />
            {asset !== 'USDC' ? <p className="m-0 text-[0.8rem] text-stone">Mamoru swaps the USDC to {asset} on Uniswap. You see the quote before your passkey.</p> : null}
          </div>
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
  const [dialog, setDialog] = useState<null | 'add' | 'withdraw' | 'stop'>(null)
  const f = funding.data
  const opList = ops.data?.ops ?? []
  const s = f ? split(f, cbbtcPrice(pools.data)) : null
  const inFlight = opList.some((o) => !TERMINAL.has(o.state))
  const armed = activationLive(opList)
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
      <Balance s={s} onAdd={() => setDialog('add')} onWithdraw={() => setDialog('withdraw')} />
      {!f ? (
        funding.isError ? (
          <p className="err card">Could not load your balance. Retrying.</p>
        ) : (
          <div className="card h-40 animate-pulse" aria-hidden="true" />
        )
      ) : (
        <>
          {!f.active && !inFlight && !armed ? <StartRow accountKey={accountKey} funded={hasMoney(f)} /> : null}
          {hasMoney(f) && !f.active && armed ? (
            <section className="card">
              <Waiting>{homeCopy.starting}</Waiting>
            </section>
          ) : null}
          <Working f={f} s={s as Split} onStop={f.active || f.positions.length > 0 ? () => setDialog('stop') : null} />
          <Idle s={s as Split} />
          <History ops={opList} />
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
          <WithdrawDialog accountKey={accountKey} s={s} open={dialog === 'withdraw'} onClose={() => setDialog(null)} />
          <StopDialog accountKey={accountKey} s={s} open={dialog === 'stop'} onClose={() => setDialog(null)} />
        </>
      ) : null}
    </main>
  )
}
