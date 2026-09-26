import type { AccountSwapView, DashboardPayload } from '@mamoru/domain'
import { Code, FigureValue, ProvenanceChip, Row } from '../components/figure.tsx'
import { HexValue } from '../components/hex.tsx'
import { Empty, Section, SubTitle } from '../components/section.tsx'
import { convertText, treasury as copy } from '../copy/dashboard.ts'
import { formatUtcDateTime } from '../lib/format.ts'

function SwapRow({ swap }: { swap: AccountSwapView }) {
  return (
    <li className="grid gap-1 border-t border-wash pt-1 text-[0.9rem]">
      <span className="flex flex-wrap items-baseline gap-2">
        <time className="text-stone">{formatUtcDateTime(swap.at)}</time>
        <span>
          {swap.tokenIn} to {swap.tokenOut}
        </span>
        <span className="text-stone">{swap.opId ? 'Mamoru' : 'Not from Mamoru'}</span>
      </span>
      <span className="flex flex-wrap gap-3">
        <span>
          In <FigureValue figure={swap.amountIn} />
        </span>
        <span>
          Out <FigureValue figure={swap.amountOut} />
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <HexValue hex={swap.txHash} kind="tx" />
        <ProvenanceChip provenance={swap.provenance} />
      </span>
    </li>
  )
}

export function TreasuryPanel({ data }: { data: DashboardPayload }) {
  const t = data.treasury
  const c = t.convert
  const empty = [t.idle.usdc, t.idle.cbBTC, t.lp, t.savings].every((f) => f.value === '0')
  return (
    <Section id="treasury" title="Treasury" question="How is my money split between idle, LP and the savings drawer, and how does it return to USDC?">
      {empty ? <Empty>{copy.empty}</Empty> : null}
      <dl className="m-0 grid">
        <Row label="Idle">
          <span className="grid gap-1">
            <FigureValue figure={t.idle.usdc} />
            <FigureValue figure={t.idle.cbBTC} />
            <span className="text-[0.85rem] text-stone">
              Value <FigureValue figure={t.idle.value} />
            </span>
            {t.idle.code ? <Code code={t.idle.code} /> : null}
          </span>
        </Row>
        <Row label="LP">
          <FigureValue figure={t.lp} />
        </Row>
        <Row label="Savings drawer, available">
          <FigureValue figure={t.savings} />
        </Row>
        <Row label="Gas reserve, outside the split">
          <FigureValue figure={t.gasReserve} />
        </Row>
        <Row label="Outside your plan">
          <FigureValue figure={t.outsidePlan} />
        </Row>
      </dl>

      <SubTitle>Path back to USDC</SubTitle>
      <p className="m-0 font-mono text-[0.78rem] tracking-[0.03em]">{copy.route}</p>
      <dl className="m-0 grid">
        <Row label="Pending conversion">
          <FigureValue figure={c.pending} />
        </Row>
        <Row label="Quote to USDC, estimate">
          <FigureValue figure={c.quote} />
        </Row>
        <Row label="Conversion">
          <span className="inline-flex flex-wrap items-baseline gap-2">
            <span>{convertText(c.state, c.cause !== undefined)}</span>
            {c.cause ? <Code code={c.cause} /> : null}
            {c.code ? <Code code={c.code} /> : null}
          </span>
        </Row>
      </dl>
      <p className="m-0 text-[0.85rem] text-stone">{copy.feesNote}</p>
      <p className="m-0 text-[0.85rem] text-stone">{copy.outsideNote}</p>

      <SubTitle>Swaps from your account</SubTitle>
      {t.swaps.length === 0 ? (
        <Empty>{copy.noSwaps}</Empty>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {t.swaps.map((s) => (
            <SwapRow key={`${s.txHash}:${s.logIndex}`} swap={s} />
          ))}
        </ul>
      )}
      <p className="m-0 flex gap-4 font-mono text-[0.75rem] uppercase tracking-[0.06em]">
        <a className="text-emerald" href="#current-action">
          Exit from Current Action
        </a>
        <a className="text-emerald" href="#leave">
          Leave without Mamoru
        </a>
      </p>
    </Section>
  )
}
