import type { ActionItem, DashboardPayload } from '@mamoru/domain'
import { Code, FigureValue } from '../components/figure.tsx'
import { IntentButton } from '../components/intent-button.tsx'
import { Empty, Section } from '../components/section.tsx'
import { actions as copy, GUIDE_URL } from '../copy/dashboard.ts'
import { formatUtcDateTime } from '../lib/format.ts'

const KIND_LABEL: Record<ActionItem['kind'], string> = { critical: 'Critical', decide: 'Decide', understand: 'Understand' }

const INTENT_LABEL = { pause: 'Resume', exit: 'Exit', renew_session: 'Renew session' } as const

const LINK: Record<Extract<ActionItem['action'], { type: 'link' }>['target'], { href: string; label: string }> = {
  'current-action': { href: '#current-action', label: 'Open Current Action' },
  portfolio: { href: '#portfolio', label: 'Open Portfolio' },
  treasury: { href: '#treasury', label: 'Open Treasury' },
  position: { href: '#positions', label: 'Open the position' },
  savings: { href: '#savings', label: 'Open Savings' },
  'savings-log': { href: '#savings-log', label: 'Open the Savings Log' },
  leave: { href: '#leave', label: 'Leave without Mamoru' },
  'walk-04': { href: GUIDE_URL, label: 'Open the guide' },
}

function ItemAction({ item, fundsGate }: { item: ActionItem; fundsGate: DashboardPayload['account']['fundsGate'] }) {
  const a = item.action
  if (!a) return null
  if (a.type === 'intent') {
    const label = a.intent === 'pause' && a.params?.paused === true ? 'Pause' : INTENT_LABEL[a.intent]
    return <IntentButton label={label} fundsGate={fundsGate} />
  }
  const link = LINK[a.target]
  const external = link.href.startsWith('http')
  return (
    <a className="font-mono text-[0.75rem] uppercase tracking-[0.06em] text-emerald" href={link.href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
      {link.label}
    </a>
  )
}

export function ActionsPanel({ data }: { data: DashboardPayload }) {
  const { items, complete, notObserved } = data.actions
  return (
    <Section id="actions" title="Actions" question="What do I need to decide or understand now?">
      {!complete ? <p className="m-0 text-[0.95rem] text-alert-ink">{copy.incomplete + notObserved.join(', ')}</p> : null}
      {items.length === 0 && complete ? <Empty>{copy.empty}</Empty> : null}
      {items.length > 0 ? (
        <ul className="m-0 grid list-none gap-3 p-0">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="action-item"
              className={`sheet grid gap-2 px-4 py-3 ${item.kind === 'critical' ? 'border-alert' : ''}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="text-[1.02rem]">{item.title}</strong>
                <span className="inline-flex items-center gap-2">
                  <span className={`mono-label text-[0.68rem] ${item.kind === 'critical' ? 'text-alert' : 'text-emerald'}`}>
                    {KIND_LABEL[item.kind]}
                  </span>
                  <Code code={item.code} />
                </span>
              </div>
              <p className="m-0 leading-snug">{item.body}</p>
              {item.cause ? (
                <p className="m-0 text-[0.85rem] text-stone">
                  Cause: <Code code={item.cause} />
                </p>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <ItemAction item={item} fundsGate={data.account.fundsGate} />
                <span className="text-[0.8rem] text-stone">
                  Since <FigureValue figure={item.since} format={(v) => formatUtcDateTime(v)} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  )
}
