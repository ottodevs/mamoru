import type { DashboardPayload } from '@mamoru/domain'
import { Code, FigureValue, ProvenanceChip, Row } from '../components/figure.tsx'
import { HexValue } from '../components/hex.tsx'
import { IntentButton } from '../components/intent-button.tsx'
import { Empty, Section, SubTitle } from '../components/section.tsx'
import { currentAction as copy, opNotes, opStateText, sessionText } from '../copy/dashboard.ts'
import { formatUtcDateTime, formatUtcTime } from '../lib/format.ts'

const VERDICT_CLASS = { GO: 'text-emerald', NO_GO: 'text-alert', EXIT: 'text-alert', SKIP: 'text-stone' } as const

export function CurrentActionPanel({ data }: { data: DashboardPayload }) {
  const ca = data.currentAction
  const fundsGate = data.account.fundsGate
  const validUntil = ca.sessionValidUntil?.value ? formatUtcTime(ca.sessionValidUntil.value) : undefined
  return (
    <Section id="current-action" title="Current Action" question="What will Mamoru do, what is it doing or what did it do, and why?">
      {ca.op ? (
        <div className="sheet grid gap-1 px-4 py-3" data-testid="current-op">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <strong>{ca.op.kind}</strong>
            <span className="inline-flex items-center gap-2">
              <span className="mono-label text-emerald">{opStateText(ca.op.state, ca.op.code)}</span>
              <Code code={ca.op.code} />
            </span>
          </div>
          <span className="text-[0.85rem] text-stone">Updated {formatUtcDateTime(ca.op.updatedAt)}</span>
          {ca.op.txHash ? <HexValue hex={ca.op.txHash} kind="tx" /> : null}
        </div>
      ) : null}
      {ca.notes.map((code) => (
        <p key={code} className="m-0 text-[0.95rem]">
          {opNotes[code] ?? code} <Code code={code} />
        </p>
      ))}

      {ca.decision ? (
        <div className="grid gap-2" data-testid="decision">
          <SubTitle>Last decision</SubTitle>
          <p className="m-0">
            {ca.decision.kind} <Code code={ca.decision.code} />{' '}
            <span className="text-[0.85rem] text-stone">at block {ca.decision.block}</span>
          </p>
          <ol className="m-0 grid list-none gap-1 p-0">
            {ca.decision.trail.map((step) => (
              <li key={step.gate} className="grid grid-cols-[10rem_4.5rem_minmax(0,1fr)] gap-2 border-t border-wash pt-1 text-[0.9rem]">
                <span>{step.gate}</span>
                <span className={`mono-label text-[0.7rem] ${VERDICT_CLASS[step.verdict]}`}>{step.verdict.replace('_', ' ')}</span>
                <Code code={step.reason} />
              </li>
            ))}
          </ol>
          {ca.decision.shadow.length > 0 ? (
            <div className="grid gap-1">
              <p className="kicker">{copy.shadow}</p>
              {ca.decision.shadow.map((s) => (
                <p key={s.code} className="m-0 text-[0.9rem] text-stone">
                  {s.note} <Code code={s.code} />
                </p>
              ))}
            </div>
          ) : null}
          {ca.decision.positions.map((p) => (
            <p key={p.tokenId} className="m-0 text-[0.9rem]">
              Position #{p.tokenId}:{' '}
              {p.codes.map((c) => (
                <Code key={c} code={c} />
              ))}
            </p>
          ))}
        </div>
      ) : (
        <Empty>{copy.noDecision}</Empty>
      )}

      <dl className="m-0 grid">
        <Row label="Session">
          <FigureValue figure={ca.session} format={(v) => sessionText(v, validUntil)} />
        </Row>
        <Row label="Pause">
          <FigureValue figure={ca.paused} format={(v) => (v ? copy.paused : 'Running')} />
        </Row>
        {ca.exit ? (
          <Row label="Exit">
            <span>
              {ca.exit.status === 'in_progress'
                ? copy.exitInProgress
                : ca.exit.status === 'pending'
                  ? copy.exitPending
                  : copy.exitCompleted}
              {ca.exit.cause ? <Code code={ca.exit.cause} /> : null}
            </span>
          </Row>
        ) : null}
        <Row label="Next review">
          <FigureValue figure={ca.nextReviewAt} format={(v) => formatUtcTime(v)} />
        </Row>
      </dl>

      <div className="flex flex-wrap gap-3">
        {ca.paused.value === true ? null : <IntentButton label="Pause" fundsGate={fundsGate} />}
        <IntentButton label="Exit" fundsGate={fundsGate} />
      </div>

      <SubTitle>{copy.recentDecisions}</SubTitle>
      {ca.recentDecisions.length === 0 ? (
        <Empty>{copy.noDecision}</Empty>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {ca.recentDecisions.map((d) => (
            <li key={d.decisionId} className="grid gap-2 border-t border-wash pt-1 text-[0.9rem] sm:grid-cols-[12rem_8rem_minmax(0,1fr)_auto]">
              <time className="text-stone">{formatUtcDateTime(d.at)}</time>
              <span>{d.kind}</span>
              <Code code={d.code} />
              <span className="text-stone">block {d.block}</span>
            </li>
          ))}
        </ul>
      )}

      <SubTitle>{copy.chainOps}</SubTitle>
      {ca.chainOps.length === 0 ? (
        <Empty>{copy.noChainOps}</Empty>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {ca.chainOps.map((op) => (
            <li key={`${op.txHash}:${op.logIndex}`} className="grid gap-1 border-t border-wash pt-1 text-[0.9rem]">
              <span className="flex flex-wrap items-baseline gap-2">
                <span>{op.kind}</span>
                <span className="mono-label text-[0.7rem] text-emerald">{op.state}</span>
                {op.code ? <Code code={op.code} /> : null}
                <span className="text-stone">{op.opId ? 'Mamoru' : 'Not from Mamoru'}</span>
                <span className="text-stone">block {op.block}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <HexValue hex={op.txHash} kind="tx" />
                <ProvenanceChip provenance={op.provenance} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
