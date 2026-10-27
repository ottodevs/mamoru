import type { OpView } from '@mamoru/domain'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { shortHex } from '../lib/format.ts'
import { feesOf, gasLabel, gasOf, moveLine, moveReason, moveState, rangeLabel, small, stepLine, type Move } from '../lib/moves.ts'
import { opLine } from '../lib/ops.ts'
import { pairLabel } from '../lib/positions.ts'
import { localTime } from '../lib/time.ts'
import { BasescanLink } from './ui.tsx'

/**
 * otto/mamoru#219: the detail of one history entry, as a side sheet on a wide screen and a bottom drawer on a
 * phone (the /ops console's account drawer is the reference). Native <dialog>: Escape and a backdrop tap close it,
 * focus starts on the title and returns to the row that opened it.
 */
export function Sheet({ open, onClose, kicker, title, children }: { open: boolean; onClose: () => void; kicker: string; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal?.()
      titleRef.current?.focus({ preventScroll: true })
    }
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      {open ? (
        <div className="sheet-in">
          <span className="sheet-grip" aria-hidden="true" />
          <header className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <span className="font-mono text-[0.72rem] uppercase tracking-[0.06em] text-emerald">{kicker}</span>
              <h2 id={titleId} ref={titleRef} tabIndex={-1} className="title heavy xfer-title">
                {title}
              </h2>
            </div>
            <button type="button" className="xfer-close" onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </header>
          {children}
        </div>
      ) : null}
    </dialog>
  )
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="sheet-fact">
      <dt>{label}</dt>
      <dd>
        {value}
        {note ? <span className="block font-serif text-[0.8rem] text-muted">{note}</span> : null}
      </dd>
    </div>
  )
}

function TxLink({ op }: { op: OpView }) {
  if (!op.txHash) return <span className="text-[0.8rem] text-stone">Not on chain yet</span>
  return (
    <span className="flex items-center gap-1 font-mono text-[0.8rem] text-emerald">
      {shortHex(op.txHash)}
      <BasescanLink tx={op.txHash} />
    </span>
  )
}

const STATE: Record<OpView['state'], string> = { proposed: 'Prepared', submitted: 'Sent', confirmed: 'Done', failed: 'Did not go through' }

/** A range move: why, what it cost, what the closed range earned, old → new range, and each transaction. */
export function MoveDetail({ move }: { move: Move }) {
  const gas = gasOf(move.ops)
  const fees = feesOf(move.close)
  const from = rangeLabel(move.pool, move.close.tickLower, move.close.tickUpper)
  const to = move.open ? rangeLabel(move.pool, move.open.tickLower, move.open.tickUpper) : null
  const state = moveState(move)
  return (
    <div className="grid gap-5">
      <p className="m-0 text-[1rem] leading-[1.55]">{moveReason(move.why)}</p>
      <dl className="sheet-facts">
        <Fact label="Status" value={state === 'done' ? 'Done' : state === 'failed' ? 'Stopped: a step did not go through' : 'In progress'} />
        {gas ? <Fact label="Network fees" value={gasLabel(gas)} note={`${gas.count} transaction${gas.count === 1 ? '' : 's'}, paid from this account`} /> : <Fact label="Network fees" value="Not read yet" />}
        {fees !== null ? <Fact label="Earned by the closed range" value={`${small(fees)} USDC`} note="Fees collected when it closed" /> : null}
        {from ? <Fact label="Previous range" value={from} /> : null}
        {to ? <Fact label="New range" value={to} /> : null}
      </dl>
      <section className="grid gap-2" aria-label="Steps">
        <h3 className="m-0 font-mono text-[0.72rem] uppercase tracking-[0.06em] text-stone">Steps</h3>
        <ol className="m-0 grid list-none gap-0 p-0">
          {move.ops.map((op, i) => {
            const g = gasOf([op])
            return (
              <li key={op.opId} className="sheet-step">
                <span className="sheet-step-n" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="grid gap-[0.15rem]">
                  <span className={op.state === 'confirmed' ? undefined : 'text-stone'}>{stepLine(op, move.why)}</span>
                  <span className="text-[0.8rem] text-muted">
                    <time dateTime={op.updatedAt}>{localTime(op.updatedAt)}</time>
                    {op.state === 'confirmed' ? '' : ` · ${STATE[op.state]}`}
                    {g ? ` · gas ${gasLabel(g)}` : ''}
                  </span>
                </div>
                <TxLink op={op} />
              </li>
            )
          })}
          {move.open ? null : (
            <li className="sheet-step text-stone">
              <span className="sheet-step-n" aria-hidden="true">
                {move.ops.length + 1}
              </span>
              <span>Open a position in range</span>
              <span />
            </li>
          )}
        </ol>
      </section>
    </div>
  )
}

/** Any other entry: what happened, when, its cost and its transaction. */
export function OpDetail({ op }: { op: OpView }) {
  const gas = gasOf([op])
  const fees = feesOf(op)
  const range = rangeLabel(op.pool, op.tickLower, op.tickUpper)
  return (
    <div className="grid gap-5">
      <dl className="sheet-facts">
        <Fact label="When" value={localTime(op.updatedAt)} />
        <Fact label="Status" value={STATE[op.state]} />
        {op.pool ? <Fact label="Pool" value={pairLabel(op.pool)} /> : null}
        {range ? <Fact label="Range" value={range} /> : null}
        {gas ? <Fact label="Network fees" value={gasLabel(gas)} /> : null}
        {fees !== null && fees > 0n ? <Fact label="Fees collected" value={`${small(fees)} USDC`} /> : null}
      </dl>
      <div className="flex items-center justify-between gap-3 border-t border-wash pt-3">
        <span className="text-[0.85rem] text-muted">Transaction</span>
        <TxLink op={op} />
      </div>
    </div>
  )
}

/** Title and kicker of the sheet for an entry. */
export function detailHead(e: { type: 'op'; op: OpView } | { type: 'move'; move: Move }): { kicker: string; title: string } {
  if (e.type === 'move') return { kicker: 'Range move', title: moveLine(e.move) }
  return { kicker: 'Activity', title: opLine(e.op) }
}
