import type { MoneyInFlight } from '@mamoru/domain'
import { knownChain, sleeveChain, txLink } from '../lib/chain.tsx'
import { shortHex } from '../lib/format.ts'
import { usd } from '../lib/money.ts'
import { chainLabel } from '../lib/positions.ts'
import { clockOrDate } from '../lib/time.ts'
import { transferCopy, transferLate, transferNow, transferOfFlight, type Transfer } from '../lib/transfer.ts'
import { moneyCopy } from './money-map.tsx'
import { SafeRef } from './safe-ref.tsx'

// otto/mamoru#264: a transfer between the owner's Safes, under the balance that already counts it. Closed, it is Brais's
// one line (3 Nov, literal: "X USDC moving from Base to Monad") plus where it is and when it arrives; open, the Safe it
// goes to, the three steps with their times, and both transactions on their own chain's explorers.

function Ext() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M9 2h5v5M14 2 7 9M12 10v4H2V4h4" />
    </svg>
  )
}

/** "waiting for Circle to confirm · arrives 10:36 to 10:42", or that it is late; nothing more once arrived. */
export function transferSummary(t: Transfer, now: number = Date.now()): string {
  if (t.step === 3) return transferCopy.updating
  const where = transferNow(t)
  const parts = [`${where.charAt(0).toLowerCase()}${where.slice(1)}`]
  if (transferLate(t, now)) parts.push('taking longer than usual')
  else if (t.eta && t.step >= 1 && t.step <= 2) parts.push(transferCopy.eta(clockOrDate(t.eta.from), clockOrDate(t.eta.to)))
  return parts.join(' · ')
}

function Step({ label, state, at, detail, link }: { label: string; state: 'done' | 'active' | 'pending'; at?: string; detail?: string | null; link?: { href: string; text: string } | null }) {
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2" data-state={state} data-testid="transfer-step">
      <span aria-hidden="true" className="pt-[0.3rem]">
        {state === 'done' ? (
          <span className="block h-[0.55rem] w-[0.55rem] rounded-full bg-emerald" />
        ) : state === 'active' ? (
          <span className="progress-dot block h-[0.55rem]! w-[0.55rem]!" />
        ) : (
          <span className="block h-[0.55rem] w-[0.55rem] rounded-full border border-stone" />
        )}
      </span>
      <span className="grid gap-[0.15rem]">
        <span className={state === 'pending' ? 'text-stone' : 'text-ink'}>
          <span className="sr-only">{state === 'done' ? 'Done: ' : state === 'active' ? 'Now: ' : 'Next: '}</span>
          {label}
          {at ? <span className="text-stone"> · {clockOrDate(at)}</span> : null}
        </span>
        {detail ? <span className="text-stone">{detail}</span> : null}
        {link ? (
          <a className="mm-link" href={link.href} target="_blank" rel="noreferrer">
            {link.text}
            <Ext />
          </a>
        ) : null}
      </span>
    </li>
  )
}

/** The three steps of a transfer, with times, what it waits for now and the transactions; shared with the upgrade view (#263). */
export function TransferSteps({ t, now = Date.now() }: { t: Transfer; now?: number }) {
  const [leave, confirm, arrive] = transferCopy.steps(chainLabel(t.from), chainLabel(t.to))
  const state = (i: number): 'done' | 'active' | 'pending' => (t.step > i ? 'done' : t.step === i ? 'active' : 'pending')
  const burn = t.burnTx ? txLink(t.from, t.burnTx) : null
  const mint = t.mintTx ? txLink(t.to, t.mintTx) : null
  const late = transferLate(t, now)
  const waitDetail = late ? transferCopy.late : t.eta ? `${transferCopy.usually} ${transferCopy.etaLong(clockOrDate(t.eta.from), clockOrDate(t.eta.to))}` : transferCopy.usually
  return (
    <ol className="m-0 grid list-none gap-[0.55rem] p-0 font-mono text-[0.75rem] leading-[1.45] tracking-[0.03em]" data-testid="transfer-steps">
      <Step label={leave!} state={state(0)} at={t.burnedAt} link={burn && knownChain(t.from) ? { href: burn, text: `${transferCopy.sent(sleeveChain(t.from).explorer.name)} ${shortHex(t.burnTx!)}` } : null} />
      <Step label={confirm!} state={state(1)} at={t.attestedAt} detail={t.step === 1 ? waitDetail : null} />
      <Step label={arrive!} state={state(2)} at={t.mintedAt} detail={t.step === 2 ? (late ? transferCopy.late : t.eta ? transferCopy.etaLong(clockOrDate(t.eta.from), clockOrDate(t.eta.to)) : null) : null} link={mint && knownChain(t.to) ? { href: mint, text: `${transferCopy.arrived(sleeveChain(t.to).explorer.name)} ${shortHex(t.mintTx!)}` } : null} />
    </ol>
  )
}

/** One transfer the total counts: the closed line under the balance, and its detail when opened. */
export function TransferRow({ flight, now = Date.now() }: { flight: MoneyInFlight; now?: number }) {
  const t = transferOfFlight(flight, now)
  if (t.step < 0) return null
  const line = (t.step === 3 ? transferCopy.arrivedLine : moneyCopy.moving)(usd(t.amountUsdc), chainLabel(t.from), chainLabel(t.to))
  return (
    <details className="mm-diy mm-transfer" data-testid="transfer" data-step={t.step}>
      <summary>
        <span>
          <span className="text-ink">{line}</span>
          <span> · {transferSummary(t, now)}</span>
        </span>
      </summary>
      <div className="mm-diy-body gap-3!">
        {t.recipient ? (
          <p className="m-0 grid gap-1 font-mono text-[0.72rem] tracking-[0.04em] text-stone">
            <span>{transferCopy.to(chainLabel(t.to))}</span>
            <SafeRef chainId={t.to} safe={t.recipient} />
          </p>
        ) : null}
        <TransferSteps t={t} now={now} />
        <p className="m-0 font-mono text-[0.72rem] tracking-[0.04em] text-stone">{t.step === 3 ? transferCopy.countedArrived : transferCopy.counted}</p>
      </div>
    </details>
  )
}
