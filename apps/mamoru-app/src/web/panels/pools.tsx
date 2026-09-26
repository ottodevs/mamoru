import type { DashboardPayload, Figure, PoolSwapView, PoolView, PositionView } from '@mamoru/domain'
import { Code, FigureValue, ProvenanceChip, Row } from '../components/figure.tsx'
import { HexValue } from '../components/hex.tsx'
import { Empty, ErrorNotice, Section, Skeleton, SubTitle } from '../components/section.tsx'
import { TokenMark } from '../components/token-mark.tsx'
import { errors, NOT_OBSERVED, pools as poolCopy, positions as copy } from '../copy/dashboard.ts'
import { formatAmount, formatFraction, formatInteger, formatUtcDateTime } from '../lib/format.ts'

export type PlanPools =
  | { status: 'loading' }
  | { status: 'error'; retry: () => void }
  | { status: 'ready'; pools: PoolView[]; syncedAt: string | null }

const rangeText = (v: 'in_range' | 'out_of_range') => (v === 'in_range' ? copy.inRange : copy.outOfRange)

function feeLabel(fee: number): string {
  return `${(fee / 10_000).toString()}%`
}

function PairMark({ token0, token1 }: { token0: string; token1: string }) {
  return (
    <span className="flex items-center">
      <TokenMark symbol={token0} />
      <span className="-ml-2">
        <TokenMark symbol={token1} />
      </span>
    </span>
  )
}

function Amounts({ a0, a1 }: { a0: Figure<string>; a1: Figure<string> }) {
  return (
    <span className="grid gap-1">
      <FigureValue figure={a0} unitWhenMissing />
      <FigureValue figure={a1} unitWhenMissing />
    </span>
  )
}

function rowAmount(f: Figure<string>): string {
  return f.value === null ? `${f.unit ?? ''} ${NOT_OBSERVED}`.trim() : formatAmount(f.value, f.unit)
}

// History rows carry one chip for the whole row, so their amounts go bare.
function RowAmounts({ a0, a1 }: { a0: Figure<string>; a1: Figure<string> }) {
  return (
    <span className="tabular-nums">
      {rowAmount(a0)} · {rowAmount(a1)}
    </span>
  )
}

function PositionCard({ position: p }: { position: PositionView }) {
  const since = p.outOfRangeSince
  return (
    <li className="sheet grid gap-2 px-4 py-3" data-testid="position">
      <div className="flex flex-wrap items-center gap-3">
        <PairMark token0={p.pool.token0} token1={p.pool.token1} />
        <strong>
          #{p.tokenId} · {p.pool.name}
        </strong>
        <span className={`mono-label text-[0.7rem] ${p.managed ? 'text-emerald' : 'text-stone'}`}>{p.managed ? copy.managed : copy.unmanaged}</span>
        {p.codes.map((c) => (
          <Code key={c} code={c} />
        ))}
      </div>
      <dl className="m-0 grid">
        <Row label="Range">
          <span className="tabular-nums">
            Ticks {p.tickLower} to {p.tickUpper}
          </span>
        </Row>
        <Row label="Range state">
          <FigureValue figure={p.rangeState} format={rangeText} />
        </Row>
        {since ? (
          <Row label="Out of range since">
            <FigureValue
              figure={since}
              format={(v) => (v === 'before_retention' ? copy.beforeRetention : `${formatUtcDateTime(v.at)}, block ${v.block}`)}
            />
          </Row>
        ) : null}
        <Row label="In range, last 24 hours">
          <FigureValue figure={p.timeInRange} format={formatFraction} />
        </Row>
        <Row label="Liquidity now">
          <FigureValue figure={p.liquidity} />
        </Row>
        <Row label="Liquidity from events">
          {p.historyComplete ? (
            <FigureValue figure={p.liquidityFromEvents} />
          ) : (
            <span>
              {copy.historyIncomplete} <Code code="PROJ_INDEXER_MISMATCH" />
            </span>
          )}
        </Row>
        <Row label="Principal">
          <span className="grid gap-1">
            <Amounts a0={p.principal.amount0} a1={p.principal.amount1} />
            <span className="text-[0.85rem] text-stone">
              Value <FigureValue figure={p.principal.value} />
            </span>
          </span>
        </Row>
        <Row label="Uncollected fees">
          <span className="grid gap-1">
            <Amounts a0={p.uncollectedFees.amount0} a1={p.uncollectedFees.amount1} />
            <span className="text-[0.85rem] text-stone">
              Value <FigureValue figure={p.uncollectedFees.value} />
            </span>
          </span>
        </Row>
        <Row label="Collected fees">
          <Amounts a0={p.collectedFees.amount0} a1={p.collectedFees.amount1} />
        </Row>
        <Row label="Fee movement, last 24 hours">
          <span className="grid gap-1">
            <Amounts a0={p.feeMovement.amount0} a1={p.feeMovement.amount1} />
            <span className="text-[0.85rem] text-stone">Since block {p.feeMovement.fromBlock}</span>
          </span>
        </Row>
        <Row label="Value, estimate">
          <FigureValue figure={p.value} />
        </Row>
      </dl>
      <SubTitle>Position events</SubTitle>
      {p.events.length === 0 ? (
        <Empty>No events for this position yet.</Empty>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {p.events.map((e) => (
            <li key={`${e.txHash}:${e.logIndex}`} className="grid gap-1 border-t border-wash pt-1 text-[0.9rem]">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="mono-label text-[0.7rem] text-emerald">{e.kind}</span>
                <time className="text-stone">{formatUtcDateTime(e.at)}</time>
                <span className="text-stone">block {e.block}</span>
                <span className="text-stone">{e.opId ? copy.mamoru : copy.notMamoru}</span>
              </span>
              <RowAmounts a0={e.amount0} a1={e.amount1} />
              <span className="flex flex-wrap items-center gap-2">
                <HexValue hex={e.txHash} kind="tx" />
                <ProvenanceChip provenance={e.provenance} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function swapLegs(s: PoolSwapView): { into: Figure<string>; out: Figure<string> } {
  return s.amount0.value?.startsWith('-') ? { into: s.amount1, out: s.amount0 } : { into: s.amount0, out: s.amount1 }
}

function absAmount(value: string, unit: string | undefined): string {
  return formatAmount(value.replace(/^-/, ''), unit)
}

function PoolCard({ pool: v }: { pool: PoolView }) {
  const s = v.stats
  return (
    <li className="sheet grid gap-2 px-4 py-3" data-testid="pool">
      <div className="flex flex-wrap items-center gap-3">
        <PairMark token0={v.pool.token0} token1={v.pool.token1} />
        <span className="grid">
          <strong>
            Uniswap V3 · {v.pool.token0}/{v.pool.token1} {feeLabel(v.pool.fee)}
          </strong>
          <HexValue hex={v.pool.address} kind="address" linkLabel="View pool" />
        </span>
      </div>
      <dl className="m-0 grid">
        <Row label={`Price of ${v.pool.token1} in ${v.pool.token0}`}>
          <FigureValue figure={v.price} />
        </Row>
        <Row label="Tick">
          <FigureValue figure={v.tick} />
        </Row>
        <Row label="Spot vs TWAP">
          <span className="grid gap-1">
            <span>
              TWAP tick <FigureValue figure={v.twapTick} />
            </span>
            <FigureValue figure={v.twapGuard} format={(g) => (g === 'ok' ? 'Within the policy guard' : 'Above the policy guard')} />
          </span>
        </Row>
        <Row label="Liquidity in range">
          <FigureValue figure={v.liquidity} />
        </Row>
        <Row label="Pool balances">
          <span className="grid gap-1">
            <Amounts a0={v.balances.amount0} a1={v.balances.amount1} />
            <span className="text-[0.85rem] text-stone">
              Value <FigureValue figure={v.balances.value} />
            </span>
          </span>
        </Row>
      </dl>
      <SubTitle>
        Last 24 hours · blocks {v.window.fromBlock} to {v.window.toBlock}
      </SubTitle>
      <dl className="m-0 grid">
        <Row label="Swaps">
          <FigureValue figure={s.swaps} format={formatInteger} />
        </Row>
        <Row label="Volume">
          <span className="grid gap-1">
            <Amounts a0={s.volume0} a1={s.volume1} />
            <span className="text-[0.85rem] text-stone">
              Value <FigureValue figure={s.volumeValue} />
            </span>
          </span>
        </Row>
        <Row label="Fees paid by swaps, estimate">
          <span className="grid gap-1">
            <Amounts a0={s.fees0} a1={s.fees1} />
            <span className="text-[0.85rem] text-stone">
              Value <FigureValue figure={s.feesValue} />
            </span>
          </span>
        </Row>
        <Row label="Tick range">
          <span className="flex flex-wrap gap-3">
            <span>
              Low <FigureValue figure={s.tickMin} />
            </span>
            <span>
              High <FigureValue figure={s.tickMax} />
            </span>
          </span>
        </Row>
        <Row label="Liquidity added">
          <span className="grid gap-1">
            <FigureValue figure={s.added.count} format={(n) => `${formatInteger(n)} changes`} />
            <Amounts a0={s.added.amount0} a1={s.added.amount1} />
          </span>
        </Row>
        <Row label="Liquidity removed">
          <span className="grid gap-1">
            <FigureValue figure={s.removed.count} format={(n) => `${formatInteger(n)} changes`} />
            <Amounts a0={s.removed.amount0} a1={s.removed.amount1} />
          </span>
        </Row>
      </dl>

      <SubTitle>Recent swaps</SubTitle>
      {v.recentSwaps.length === 0 ? (
        <Empty>{poolCopy.noSwaps}</Empty>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {v.recentSwaps.map((sw) => {
            const { into, out } = swapLegs(sw)
            return (
              <li key={`${sw.txHash}:${sw.logIndex}`} data-testid="pool-swap" className="grid gap-1 border-t border-wash pt-1 text-[0.9rem]">
                <span className="flex flex-wrap items-baseline gap-2">
                  <time className="text-stone">{formatUtcDateTime(sw.at)}</time>
                  <span className="text-stone">block {sw.block}</span>
                  <span>
                    In {into.value === null ? NOT_OBSERVED : absAmount(into.value, into.unit)}, out{' '}
                    {out.value === null ? NOT_OBSERVED : absAmount(out.value, out.unit)}
                  </span>
                  <span className="text-stone">tick after {sw.tick}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <HexValue hex={sw.txHash} kind="tx" />
                  <ProvenanceChip provenance={sw.provenance} />
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <SubTitle>Recent liquidity changes</SubTitle>
      {v.recentLiquidity.length === 0 ? (
        <Empty>{poolCopy.noLiquidity}</Empty>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {v.recentLiquidity.map((l) => (
            <li key={`${l.txHash}:${l.logIndex}`} className="grid gap-1 border-t border-wash pt-1 text-[0.9rem]">
              <span className="flex flex-wrap items-baseline gap-2">
                <time className="text-stone">{formatUtcDateTime(l.at)}</time>
                <span className="mono-label text-[0.7rem] text-emerald">{l.kind === 'mint' ? poolCopy.added : poolCopy.removed}</span>
                <span className="text-stone">
                  ticks {l.tickLower} to {l.tickUpper}
                </span>
              </span>
              <RowAmounts a0={l.amount0} a1={l.amount1} />
              <span className="flex flex-wrap items-center gap-2">
                <HexValue hex={l.txHash} kind="tx" />
                <ProvenanceChip provenance={l.provenance} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {v.accountPositions.length > 0 ? (
        <>
          <SubTitle>Your positions in this pool</SubTitle>
          <ul className="m-0 grid list-none gap-1 p-0">
            {v.accountPositions.map((ap) => (
              <li key={ap.tokenId} className="flex flex-wrap gap-2 border-t border-wash pt-1 text-[0.9rem]">
                <span>#{ap.tokenId}</span>
                <FigureValue figure={ap.rangeState} format={rangeText} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </li>
  )
}

export function PoolsPanel({ data, plan }: { data: DashboardPayload; plan: PlanPools }) {
  const positions = data.pools.positions
  const positionsValue = data.portfolio.positions.value
  return (
    <Section id="positions" title="Pools and positions" question="What is happening in my plan's pools and in my positions: swaps, liquidity, fees and range?">
      <SubTitle>Your positions</SubTitle>
      {positions.length === 0 && positionsValue.value === null ? (
        <FigureValue figure={positionsValue} />
      ) : positions.length === 0 ? (
        <Empty>{data.mode === 'lab' ? copy.emptyLab : copy.empty}</Empty>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {positions.map((p) => (
            <PositionCard key={p.tokenId} position={p} />
          ))}
        </ul>
      )}

      <SubTitle>Pools in your plan</SubTitle>
      {plan.status === 'loading' ? <Skeleton /> : null}
      {plan.status === 'error' ? <ErrorNotice message={errors.pools} onRetry={plan.retry} /> : null}
      {plan.status === 'ready' && plan.pools.length === 0 ? <Empty>{poolCopy.notSynced}</Empty> : null}
      {plan.status === 'ready' && plan.syncedAt !== null ? (
        <p className="m-0 text-[0.85rem] text-stone">{poolCopy.syncedAt(formatUtcDateTime(plan.syncedAt))}</p>
      ) : null}
      {plan.status === 'ready' && plan.pools.length > 0 ? (
        <ul className="m-0 grid list-none gap-3 p-0">
          {plan.pools.map((v) => (
            <PoolCard key={v.pool.address} pool={v} />
          ))}
        </ul>
      ) : null}
    </Section>
  )
}
