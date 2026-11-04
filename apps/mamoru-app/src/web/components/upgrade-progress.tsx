import { txLink, sleeveChain } from '../lib/chain.tsx'
import { shortHex } from '../lib/format.ts'
import { clockOrDate } from '../lib/time.ts'
import { upgradeCopy, type StepState, type Upgrade, type UpgradeStep } from '../lib/upgrade-steps.ts'
import { Fold } from './motion.tsx'
import { SafeRef } from './safe-ref.tsx'
import { TransferSteps } from './transfer-row.tsx'

// otto/mamoru#263: while the account moves to the mix with Monad, Home says what step it is on, how far it got, and, when
// opened, every step with its state, time and transactions on their own chain's explorer. Done, it stays a day.

function Dot({ state }: { state: StepState }) {
  if (state === 'active') return <span className="progress-dot block h-[0.6rem]! w-[0.6rem]!" />
  const cls =
    state === 'done'
      ? 'bg-emerald'
      : state === 'failed'
        ? 'bg-alert'
        : state === 'waiting'
          ? 'border-2 border-emerald bg-transparent'
          : 'border border-stone bg-transparent'
  return <span className={`block h-[0.6rem] w-[0.6rem] rounded-full ${cls}`} />
}

const SR: Record<StepState, string> = { done: 'Done: ', active: 'Now: ', waiting: 'Waiting: ', pending: 'Next: ', failed: 'Needs you: ' }

function Ext() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M9 2h5v5M14 2 7 9M12 10v4H2V4h4" />
    </svg>
  )
}

function StepRow({ s, now }: { s: UpgradeStep; now: number }) {
  const live = s.state === 'active' || s.state === 'waiting'
  return (
    <li className="grid grid-cols-[1.1rem_minmax(0,1fr)] gap-x-3 border-t border-wash py-3 first:border-t-0" data-testid="upgrade-step" data-state={s.state} data-step={s.id}>
      <span aria-hidden="true" className="pt-[0.45rem]">
        <Dot state={s.state} />
      </span>
      <span className="grid min-w-0 gap-[0.3rem]">
        <span className={`text-[1rem] leading-[1.4] ${s.state === 'pending' ? 'text-stone' : s.state === 'failed' ? 'text-alert-ink' : 'text-ink'}`}>
          <span className="sr-only">{SR[s.state]}</span>
          {s.label}
          {s.at ? <span className="font-mono text-[0.72rem] tracking-[0.04em] text-stone"> · {clockOrDate(s.at)}</span> : null}
        </span>
        {s.detail ? <span className={`text-[0.92rem] leading-[1.45] ${s.state === 'failed' ? 'text-alert-ink' : 'text-muted'}`}>{s.detail}</span> : null}
        {s.id === 'arrive' && live && s.transfer ? (
          <span className="block pt-1">
            <TransferSteps t={s.transfer} now={now} />
          </span>
        ) : null}
        {s.safe ? <SafeRef chainId={s.safe.chainId} safe={s.safe.address} /> : null}
        {s.links.length ? (
          <span className="mm-links">
            {s.links.map((l) => {
              const href = txLink(l.chainId, l.tx)
              return href ? (
                <a key={l.tx} className="mm-link inline!" href={href} target="_blank" rel="noreferrer" title={`View on ${sleeveChain(l.chainId).explorer.name}`}>
                  {l.text}{' '}
                  <span className="whitespace-nowrap">
                    {shortHex(l.tx)} <Ext />
                  </span>
                </a>
              ) : null
            })}
          </span>
        ) : null}
      </span>
    </li>
  )
}

/** The status card: current step in words, "Step n of 6", a bar, and the steps folded under it. */
export function UpgradeProgress({ upgrade, now = Date.now() }: { upgrade: Upgrade; now?: number }) {
  const n = upgrade.steps.length
  const doneCount = upgrade.steps.filter((s) => s.state === 'done').length
  const cur = upgrade.steps[upgrade.current]!
  const stuck = cur.state === 'failed'
  return (
    <Fold
      testId="upgrade"
      head={
        <>
          <span className="dash-title text-[1.25rem]! leading-[1.3]!" data-testid="upgrade-title">
            {upgrade.title}
          </span>
          <span className="panel-meta">
            <span className="seg">{upgrade.done ? upgradeCopy.step(n, n) : upgradeCopy.step(upgrade.current + 1, n)}</span>
            {' · '}
            <span className="seg">started {clockOrDate(upgrade.startedAt)}</span>
          </span>
        </>
      }
      status={
        <div className="mb-2 h-[3px] w-full bg-wash" role="progressbar" aria-valuemin={0} aria-valuemax={n} aria-valuenow={doneCount} aria-label={upgradeCopy.step(upgrade.current + 1, n)} data-testid="upgrade-bar">
          <div className={`h-full ${stuck ? 'bg-alert' : 'bg-emerald'} transition-[width] duration-700`} style={{ width: `${Math.round((doneCount / n) * 100)}%` }} />
        </div>
      }
    >
      <ol className="m-0 list-none p-0 pt-1" aria-live="polite">
        {upgrade.steps.map((s) => (
          <StepRow key={s.id} s={s} now={now} />
        ))}
      </ol>
    </Fold>
  )
}
