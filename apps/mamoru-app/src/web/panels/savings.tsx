import type { DashboardPayload, SavingsRowView } from '@mamoru/domain'
import { Code, FigureValue, ProvenanceChip, Row } from '../components/figure.tsx'
import { HexValue } from '../components/hex.tsx'
import { Empty, Section } from '../components/section.tsx'
import { savings as copy, savingsLog as logCopy } from '../copy/dashboard.ts'
import { formatUtcDateTime } from '../lib/format.ts'

export function SavingsPanel({ data }: { data: DashboardPayload }) {
  const s = data.savings
  const empty = s.ledgerTotal.value === '0' && data.savingsLog.rows.length === 0
  return (
    <Section id="savings" title="Savings" question="How much have I saved and how much can I use?">
      {empty ? <Empty>{copy.empty}</Empty> : null}
      <dl className="m-0 grid">
        <Row label="Ledger total">
          <FigureValue figure={s.ledgerTotal} />
        </Row>
        <Row label="USDC balance">
          <FigureValue figure={s.usdcBalance} />
        </Row>
        <Row label="Available">
          <FigureValue figure={s.available} />
        </Row>
        <Row label={copy.pending}>
          <FigureValue figure={s.pending} />
        </Row>
        <Row label="Last harvest">
          {s.lastHarvest ? <FigureValue figure={s.lastHarvest} format={(v) => formatUtcDateTime(v)} /> : <span className="text-stone">{copy.noHarvests}</span>}
        </Row>
      </dl>
      <p className="m-0 font-mono text-[0.75rem] uppercase tracking-[0.06em]">
        <a className="text-emerald" href="#savings-log">
          Open the Savings Log
        </a>
      </p>
    </Section>
  )
}

function LogRow({ row }: { row: SavingsRowView }) {
  return (
    <li data-testid="savings-row" className="grid gap-1 border-t border-wash pt-1 text-[0.9rem] md:grid-cols-[12rem_6rem_minmax(0,1fr)_auto] md:items-baseline md:gap-3">
      <time className="text-stone">{formatUtcDateTime(row.at)}</time>
      <span className="mono-label text-[0.72rem] text-emerald">{logCopy.kinds[row.kind]}</span>
      <span className="flex flex-wrap items-baseline gap-2">
        <FigureValue figure={row.amount} />
        {row.code ? <Code code={row.code} /> : null}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-stone">block {row.block}</span>
        <HexValue hex={row.txHash} kind="tx" />
        <ProvenanceChip provenance={row.provenance} />
      </span>
    </li>
  )
}

export function SavingsLogPanel({ data }: { data: DashboardPayload }) {
  const rows = data.savingsLog.rows
  return (
    <Section id="savings-log" title="Savings Log" question="Where does each savings figure come from, harvest by harvest?">
      {rows.length === 0 ? (
        <Empty>{data.mode === 'production' ? logCopy.emptyProduction : logCopy.empty}</Empty>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {rows.map((r) => (
            <LogRow key={`${r.txHash}:${r.logIndex}`} row={r} />
          ))}
        </ul>
      )}
    </Section>
  )
}
