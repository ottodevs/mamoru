import type { FundingView, Hex0x, OpView, OwnerSignature, OwnerTxToSign, TransferPlan } from '@mamoru/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { ApiRequestError, useApi } from '../api/client.ts'
import { queryKeys, useFunding, useOps } from '../api/queries.ts'
import { Row } from '../components/figure.tsx'
import { HexValue } from '../components/hex.tsx'
import { Empty, ErrorNotice, Section, Skeleton, SubTitle } from '../components/section.tsx'
import { formatAmount, formatUtcDateTime } from '../lib/format.ts'
import { PasskeyError } from '../lib/passkey.ts'
import { isPasskeyCancel, signOwnerTx, storedCredential } from '../lib/passkey-sign.ts'

const TERMINAL = new Set<OpView['state']>(['confirmed', 'failed'])
const USDC_DECIMALS = 6

export const live = {
  send: (cap: string) => `Send USDC on Base to this address. Cap ${formatAmount(cap, 'USDC')}.`,
  cancelled: 'The passkey prompt was closed. Nothing was signed.',
  apiFailed: "Mamoru's API did not answer. Try again.",
  noOps: 'No operations yet.',
  noPositions: 'No positions.',
}

/** "12.5" USDC to base units. Returns null when the text is not a positive amount with at most 6 decimals. */
export function parseUsdc(text: string): string | null {
  const t = text.trim()
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return null
  const [whole = '0', frac = ''] = t.split('.')
  const raw = (whole + frac.padEnd(USDC_DECIMALS, '0')).replace(/^0+(?=\d)/, '')
  return /^0+$/.test(raw) ? null : raw
}

export function isAddress(s: string): s is Hex0x {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim())
}

function errorText(e: unknown): string | null {
  if (isPasskeyCancel(e)) return null
  if (e instanceof ApiRequestError || e instanceof PasskeyError) return e.message
  return e instanceof Error && e.message ? e.message : live.apiFailed
}

// ---------- pure views (tested with static markup) ----------

function yesNo(v: boolean): string {
  return v ? 'Yes' : 'No'
}

function BlockChip({ block }: { block: number }) {
  return (
    <span className="chip" data-testid="chip">
      Base · block {block}
    </span>
  )
}

export function FundingBlock({ f }: { f: FundingView }) {
  return (
    <div className="grid gap-3">
      <div className="sheet grid gap-2 px-4 py-3">
        <p className="kicker m-0">Your Safe on Base</p>
        <HexValue hex={f.address} kind="address" full />
        <p className="m-0 text-[0.92rem]">{live.send(f.capUsdc)}</p>
      </div>
      <dl className="m-0 grid">
        <Row label="USDC">
          <span className="inline-flex flex-wrap items-baseline gap-2">
            <span className="tabular-nums">{formatAmount(f.usdc, 'USDC')}</span>
            <BlockChip block={f.block} />
          </span>
        </Row>
        <Row label="ETH">
          <span className="inline-flex flex-wrap items-baseline gap-2">
            <span className="tabular-nums">{formatAmount(f.eth, 'ETH')}</span>
            <BlockChip block={f.block} />
          </span>
        </Row>
        <Row label="cbBTC">
          <span className="inline-flex flex-wrap items-baseline gap-2">
            <span className="tabular-nums">{formatAmount(f.cbbtc, 'cbBTC')}</span>
            <BlockChip block={f.block} />
          </span>
        </Row>
        <Row label="Safe deployed">{yesNo(f.deployed)}</Row>
        <Row label="Engine active">{yesNo(f.active)}</Row>
      </dl>
    </div>
  )
}

export function PositionsList({ positions }: { positions: FundingView['positions'] }) {
  if (positions.length === 0) return <Empty>{live.noPositions}</Empty>
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {positions.map((p) => (
        <li key={p.tokenId} className="grid gap-1 border-t border-wash pt-2 text-[0.9rem]">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono">#{p.tokenId}</span>
            <span className={p.inRange ? 'text-emerald' : 'text-alert-ink'}>{p.inRange ? 'In range' : 'Out of range'}</span>
          </span>
          <span className="flex flex-wrap gap-3 tabular-nums">
            <span>{formatAmount(p.amountUsdc, 'USDC')}</span>
            <span>{formatAmount(p.amountCbbtc, 'cbBTC')}</span>
          </span>
          <span className="flex flex-wrap gap-3">
            <a className="font-mono text-[0.7rem] uppercase tracking-wider text-emerald" href={`https://app.uniswap.org/positions/v3/base/${p.tokenId}`} target="_blank" rel="noreferrer">
              View on Uniswap
            </a>
            <a className="font-mono text-[0.7rem] uppercase tracking-wider text-emerald" href={`https://basescan.org/address/${p.pool}`} target="_blank" rel="noreferrer">
              Pool on Basescan
            </a>
          </span>
        </li>
      ))}
    </ul>
  )
}

const KIND: Record<OpView['kind'], string> = {
  activate: 'Start allocation',
  enter: 'Enter position',
  reduce: 'Reduce position',
  transfer: 'Transfer out',
  exit: 'Stop allocation',
}

export function ActivityList({ ops }: { ops: OpView[] }) {
  if (ops.length === 0) return <Empty>{live.noOps}</Empty>
  const sorted = [...ops].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return (
    <ol className="m-0 grid list-none gap-2 p-0">
      {sorted.map((op) => (
        <li key={op.opId} className="grid gap-1 border-t border-wash pt-2 text-[0.9rem]" data-testid="op">
          <span className="flex flex-wrap items-baseline gap-2">
            <time className="text-stone">{formatUtcDateTime(op.updatedAt)}</time>
            <span>{KIND[op.kind]}</span>
            <span className={op.state === 'failed' ? 'text-alert-ink' : op.state === 'confirmed' ? 'text-emerald' : 'text-stone'}>
              {op.state[0]?.toUpperCase()}
              {op.state.slice(1)}
            </span>
            {op.code ? <code className="code">{op.code}</code> : null}
            {op.block !== undefined ? <BlockChip block={op.block} /> : null}
          </span>
          {op.txHash ? <HexValue hex={op.txHash} kind="tx" /> : null}
        </li>
      ))}
    </ol>
  )
}

export function ReviewCard({
  title,
  tx,
  reduce,
  busy,
  error,
  onApprove,
  onCancel,
}: {
  title: string
  tx: OwnerTxToSign
  reduce?: TransferPlan['reduce']
  busy: boolean
  error: string | null
  onApprove: () => void
  onCancel: () => void
}) {
  return (
    <div className="sheet grid gap-3 px-4 py-4" data-testid="review">
      <p className="kicker m-0">{title}</p>
      {reduce && reduce.length > 0 ? (
        <ul className="m-0 grid gap-1 pl-5 text-[0.92rem]">
          {reduce.map((r) => (
            <li key={r.tokenId}>
              Reduce position #{r.tokenId} by {(r.liquidityBps / 100).toFixed(r.liquidityBps % 100 === 0 ? 0 : 2)}%
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="m-0 grid gap-1 pl-5 text-[0.92rem]">
        {tx.summary.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="m-0 text-[0.8rem] text-stone">
        Safe transaction <code className="font-mono break-all">{tx.safeTxHash}</code>. Expires {formatUtcDateTime(tx.expiresAt)}.
      </p>
      {error ? <ErrorNotice message={error} /> : null}
      <span className="flex flex-wrap gap-2">
        <button type="button" className="act" onClick={onApprove} disabled={busy}>
          {busy ? 'Waiting for passkey' : 'Approve with passkey'}
        </button>
        <button type="button" className="btn btn-ghost min-w-0 px-3 py-1 text-[0.72rem]" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </span>
    </div>
  )
}

// ---------- owner action flow: prepare, review, passkey, submit ----------

type Pending = { kind: 'activate' | 'transfer' | 'stop'; tx: OwnerTxToSign; reduce?: TransferPlan['reduce'] }

function useOwnerFlow(accountKey: string) {
  const api = useApi()
  const qc = useQueryClient()
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<null | 'preparing' | 'signing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.funding(accountKey) }),
      qc.invalidateQueries({ queryKey: queryKeys.ops(accountKey) }),
    ])

  const prepare = async (kind: Pending['kind'], run: () => Promise<Pending>) => {
    setError(null)
    setNotice(null)
    setBusy('preparing')
    try {
      setPending(await run())
    } catch (e) {
      setError(errorText(e) ?? live.apiFailed)
    } finally {
      setBusy(null)
    }
    return kind
  }

  const approve = async () => {
    if (!pending) return
    setError(null)
    setBusy('signing')
    try {
      const sig: OwnerSignature = await signOwnerTx(pending.tx, storedCredential(accountKey))
      const submit = pending.kind === 'activate' ? api.activate : pending.kind === 'transfer' ? api.transfer : api.stop
      await submit(accountKey, sig)
      setPending(null)
      setNotice('Signed and sent. Progress shows in Activity below.')
      await refresh()
    } catch (e) {
      const msg = errorText(e)
      setError(msg ?? live.cancelled)
    } finally {
      setBusy(null)
    }
  }

  return {
    pending,
    busy,
    error,
    notice,
    approve,
    cancel: () => {
      setPending(null)
      setError(null)
    },
    start: () => prepare('activate', async () => ({ kind: 'activate', tx: await api.activatePrepare(accountKey) })),
    stop: () => prepare('stop', async () => ({ kind: 'stop', tx: await api.stopPrepare(accountKey) })),
    transfer: (to: Hex0x, amountUsdc: string) =>
      prepare('transfer', async () => {
        const plan = await api.transferPrepare(accountKey, { to, amountUsdc })
        return { kind: 'transfer', tx: plan.ownerTx, reduce: plan.reduce }
      }),
  }
}

const TITLES: Record<Pending['kind'], string> = {
  activate: 'Start allocation: review before signing',
  transfer: 'Transfer out: review before signing',
  stop: 'Stop allocation: review before signing',
}

function TransferForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (to: Hex0x, amount: string) => void }) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const raw = parseUsdc(amount)
    if (!isAddress(to)) return setInvalid('Enter a Base address: 0x followed by 40 hex characters.')
    if (raw === null) return setInvalid('Enter a USDC amount above zero, at most 6 decimals.')
    setInvalid(null)
    onSubmit(to.trim() as Hex0x, raw)
  }
  const field = 'w-full min-w-0 border border-wash bg-rice px-3 py-2 font-mono text-[0.85rem]'
  return (
    <form className="grid gap-2" onSubmit={submit}>
      <label className="grid gap-1 text-[0.9rem]">
        <span className="text-stone">To address</span>
        <input className={field} value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
      </label>
      <label className="grid gap-1 text-[0.9rem]">
        <span className="text-stone">Amount, USDC</span>
        <input className={field} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="10" />
      </label>
      {invalid ? <ErrorNotice message={invalid} /> : null}
      <button type="submit" className="act w-fit" disabled={disabled}>
        Review transfer
      </button>
    </form>
  )
}

export function LivePanel({ accountKey }: { accountKey: string }) {
  const funding = useFunding(accountKey, true)
  const ops = useOps(accountKey, true)
  const flow = useOwnerFlow(accountKey)
  const f = funding.data
  const opList = ops.data?.ops ?? []
  const inFlight = opList.some((op) => !TERMINAL.has(op.state))
  const locked = flow.busy !== null || flow.pending !== null || inFlight

  let body: ReactNode
  if (!f) {
    body = funding.isError ? <ErrorNotice message={errorText(funding.error) ?? live.apiFailed} onRetry={() => funding.refetch()} /> : <Skeleton lines={4} />
  } else {
    const hasUsdc = BigInt(f.usdc) > 0n
    body = (
      <>
        {funding.isError ? <ErrorNotice message={errorText(funding.error) ?? live.apiFailed} onRetry={() => funding.refetch()} /> : null}
        <FundingBlock f={f} />
        <span className="flex flex-wrap items-center gap-2">
          {f.active ? (
            <button type="button" className="act" onClick={flow.stop} disabled={locked}>
              {flow.busy === 'preparing' ? 'Preparing' : 'Stop allocation'}
            </button>
          ) : (
            <button type="button" className="act" onClick={flow.start} disabled={locked || !hasUsdc}>
              {flow.busy === 'preparing' ? 'Preparing' : 'Start allocation'}
            </button>
          )}
          {!f.active && !hasUsdc ? <span className="text-[0.85rem] text-stone">Send USDC first. Start allocation opens when it arrives.</span> : null}
          {inFlight ? <span className="text-[0.85rem] text-stone">An operation is in progress.</span> : null}
        </span>
        {flow.pending ? (
          <ReviewCard
            title={TITLES[flow.pending.kind]}
            tx={flow.pending.tx}
            reduce={flow.pending.reduce}
            busy={flow.busy === 'signing'}
            error={flow.error}
            onApprove={flow.approve}
            onCancel={flow.cancel}
          />
        ) : flow.error ? (
          <ErrorNotice message={flow.error} />
        ) : null}
        {flow.notice ? <p className="m-0 text-[0.9rem] text-emerald">{flow.notice}</p> : null}

        <SubTitle>Positions</SubTitle>
        <PositionsList positions={f.positions} />

        <SubTitle>Transfer out</SubTitle>
        <p className="m-0 text-[0.88rem] text-stone">USDC leaves your Safe to the address you enter. If idle USDC is short, Mamoru reduces positions first.</p>
        <TransferForm disabled={locked || !f.deployed} onSubmit={flow.transfer} />
      </>
    )
  }

  return (
    <>
      <Section id="live" title="Your money on Base" question="What does my Safe hold, and what can I do with it now?">
        {body}
      </Section>
      <Section id="activity" title="Activity" question="What has Mamoru sent on Base for this account?">
        {ops.isError ? <ErrorNotice message={errorText(ops.error) ?? live.apiFailed} onRetry={() => ops.refetch()} /> : null}
        {ops.data ? <ActivityList ops={opList} /> : ops.isError ? null : <Skeleton lines={2} />}
      </Section>
    </>
  )
}
