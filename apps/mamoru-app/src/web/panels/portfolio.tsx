import type { DashboardPayload } from '@mamoru/domain'
import { Code, FigureValue, Row } from '../components/figure.tsx'
import { Empty, Section, SubTitle } from '../components/section.tsx'
import { TokenMark } from '../components/token-mark.tsx'
import { portfolio as copy } from '../copy/dashboard.ts'
import { formatBps, formatInteger } from '../lib/format.ts'

export function PortfolioPanel({ data }: { data: DashboardPayload }) {
  const p = data.portfolio
  // only an observed zero on both counts means no positions
  const noPositions = p.positions.managed.value === 0 && p.positions.unmanaged.value === 0 && p.positions.value.value !== null
  return (
    <Section id="portfolio" title="Portfolio" question="What is in my smart account on Base and what is it worth?">
      {p.tokens.length === 0 ? <Empty>{copy.noBalances}</Empty> : null}
      <ul className="m-0 grid list-none gap-2 p-0">
        {p.tokens.map((t) => (
          <li key={t.token} data-testid="token-row" className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 border-t border-wash pt-2 sm:grid-cols-[auto_12rem_minmax(0,1fr)]">
            <TokenMark symbol={t.token} />
            <span className="grid">
              <span className="font-mono text-[0.85rem] tracking-[0.06em]">{t.token}</span>
              <span className="text-[0.8rem] text-stone">{copy.roles[t.role]}</span>
              {t.code ? <Code code={t.code} /> : null}
            </span>
            <span className="col-span-2 grid gap-1 sm:col-span-1">
              <FigureValue figure={t.amount} />
              <span className="text-[0.85rem] text-stone">
                Value <FigureValue figure={t.value} />
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-[0.85rem] text-stone">{copy.registryOnly}</p>

      <dl className="m-0 grid">
        <Row label="Positions">
          {noPositions ? (
            <span>{copy.noPositions}</span>
          ) : p.positions.value.value === null ? (
            <FigureValue figure={p.positions.value} />
          ) : (
            <span className="grid gap-1">
              <span>
                <FigureValue figure={p.positions.managed} format={formatInteger} /> managed,{' '}
                <FigureValue figure={p.positions.unmanaged} format={formatInteger} /> not managed
              </span>
              <FigureValue figure={p.positions.value} />
            </span>
          )}
        </Row>
        <Row label="Total, estimate">
          <FigureValue figure={p.total} />
        </Row>
      </dl>

      <SubTitle>Allocation against preference</SubTitle>
      <ul className="m-0 grid list-none gap-1 p-0">
        {p.allocation.map((a) => (
          <li key={a.bucket} className="grid gap-2 border-t border-wash pt-1 text-[0.9rem] sm:grid-cols-[8rem_9rem_minmax(0,1fr)_auto]">
            <span className="font-mono">{a.bucket}</span>
            <span className="text-stone">Preference {formatBps(a.preference)}</span>
            <span>
              Actual <FigureValue figure={a.actual} format={(v) => formatBps(v)} />
            </span>
            <span className="grid justify-items-end">
              {a.code === 'PLAN_BUCKET_NO_EXECUTABLE_POOL' ? <span className="text-stone">{copy.idleNoPool}</span> : null}
              <Code code={a.code} />
            </span>
          </li>
        ))}
      </ul>

      {p.unmanaged.length > 0 ? (
        <>
          <SubTitle>Not managed by Mamoru</SubTitle>
          <ul className="m-0 grid list-none gap-1 p-0">
            {p.unmanaged.map((u) => (
              <li key={`${u.kind}:${u.ref}`} className="flex flex-wrap gap-2 border-t border-wash pt-1 text-[0.9rem]">
                <span>{u.kind === 'position' ? `Position #${u.ref}` : u.ref}</span>
                <Code code={u.code} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="m-0 flex gap-4 font-mono text-[0.75rem] uppercase tracking-[0.06em]">
        <a className="text-emerald" href="#treasury">
          Open Treasury
        </a>
        <a className="text-emerald" href="#positions">
          Open Pools and positions
        </a>
      </p>
    </Section>
  )
}
