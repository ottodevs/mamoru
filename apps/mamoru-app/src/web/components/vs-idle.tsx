// otto/mamoru#380: the Portfolio's "vs idle USDC" block, as the agreed mock (v8) and the 22 Nov decisions: the net
// against leaving the net deposited USDC idle, its APR · 30-day average, the breakdown that adds up to it, and the
// chart of that net over time against a dashed `deposited` baseline. Figures come from GET .../vs-idle (api/accounts/vs-idle.ts).
// A figure that is not known says n/a; nothing is drawn against a baseline that is wrong.
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { VsIdleView } from '../api/client.ts'
import { InfoPopover } from './ui.tsx'
import { TweenPct, TweenUsd } from './motion.tsx'
import { dayLabel, EMERALD, monotone } from './charts.tsx'

export const vsIdleCopy = {
  label: 'vs idle USDC',
  apr: 'APR · 30-day avg',
  aprTip: 'Yearly % your working money earned in fees. During your first 30 days, this shows the Mamoru average.',
  breakdown: 'Breakdown',
  over: 'Net over time',
  fees: 'Fees earned',
  price: 'Price move',
  fee: 'Mamoru fee 10 %',
  costs: 'Costs',
  net: 'Net',
  deposited: (n: string, short: boolean) => `${short ? 'dep.' : 'deposited'} ${n}`,
  na: 'n/a',
}

const ALERT = '#9b2c2c'
const num = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** A signed figure as the mock writes it: +10.55 and −4.35 (a real minus sign). */
export const signed = (n: number) => `${n < 0 ? '−' : '+'}${num(Math.abs(n))}`

/** Total earned's role in the mock, now vs idle USDC: the net, big, green up and red down, with "since <day>" under it. */
export function VsIdleHead({ v, mamoruAprPct }: { v: VsIdleView | null | undefined; /** The Mamoru average shown during an account's first 30 days. */ mamoruAprPct: number | null }) {
  const net = v?.breakdown?.netUsd ?? null
  const apr = v ? (v.apr.pct ?? (v.apr.reason === 'first-30-days' ? mamoruAprPct : null)) : null
  return (
    <div className="pv-pair">
      <div className="pv-stat" data-testid="vs-idle">
        <p className="pv-lbl">{vsIdleCopy.label}</p>
        <p className={`pv-num${net === null ? ' na' : net < 0 ? ' neg' : ' pos'}`} data-testid="vs-idle-net">
          {net === null ? (
            vsIdleCopy.na
          ) : (
            <>
              <TweenUsd raw={String(Math.round(Math.abs(net) * 1e6))} prefix={net < 0 ? '−' : '+'} countUp />
              <span className="pv-unit">USDC</span>
            </>
          )}
        </p>
        {net !== null && v?.since ? <p className="pv-cap">since {dayLabel(v.since)}</p> : null}
      </div>
      <div className="pv-stat">
        <p className="pv-lbl">
          {vsIdleCopy.apr} <InfoPopover label={`About "${vsIdleCopy.apr}"`}>{vsIdleCopy.aprTip}</InfoPopover>
        </p>
        <p className={`pv-num${apr === null ? ' na' : apr < 0 ? ' neg' : ''}`} data-testid="vs-idle-apr">
          {apr === null ? vsIdleCopy.na : <TweenPct value={apr} countUp />}
        </p>
      </div>
    </div>
  )
}

/** The breakdown rows; they add up to Net by construction (the API). Negative rows stay stone, the Net row goes red. */
export function Breakdown({ v }: { v: VsIdleView }) {
  const b = v.breakdown!
  const row = (label: string, n: number | null, testid: string) => (
    <tr key={label} data-testid={testid}>
      <td>{label}</td>
      <td className={`v ${n === null ? 'neg' : n < 0 ? 'neg' : 'pos'}`}>{n === null ? vsIdleCopy.na : signed(n)}</td>
    </tr>
  )
  return (
    <table className="pv-table" aria-label={vsIdleCopy.breakdown}>
      <tbody>
        {row(vsIdleCopy.fees, b.feesUsd, 'bd-fees')}
        {row(vsIdleCopy.price, b.priceMoveUsd, 'bd-price')}
        {row(vsIdleCopy.costs, b.costsUsd, 'bd-costs')}
        {row(vsIdleCopy.fee, b.mamoruFeeUsd, 'bd-fee')}
        <tr className="tot" data-testid="bd-net">
          <td>{vsIdleCopy.net}</td>
          <td className={`v ${b.netUsd < 0 ? 'alert' : 'pos'}`}>{signed(b.netUsd)}</td>
        </tr>
      </tbody>
    </table>
  )
}

/** The net deposited, as the mock writes it under Total value. */
export const vsIdleDeposited = (v: VsIdleView) => num(v.netDeposited.usd)

/** Breakdown and the net chart on one grid (on a phone the chart goes first and the section headers go). */
export function VsIdleBody({ v }: { v: VsIdleView }) {
  return (
    <div className="pv-body">
      <div className="pv-left">
        <div className="pv-head">
          <span className="pv-h">{vsIdleCopy.breakdown}</span>
        </div>
        <Breakdown v={v} />
      </div>
      <NetChart series={v.series} deposited={v.netDeposited.usd} />
    </div>
  )
}

const RANGES = [
  { v: 7, l: '1W' },
  { v: 30, l: '1M' },
  { v: 0, l: 'ALL' },
]

/** Net by day against the dashed deposited baseline at 0: green above, red below, the end dot without a figure. */
export function NetChart({ series, deposited }: { series: VsIdleView['series']; deposited: number }) {
  const [range, setRange] = useState(30)
  const rows = range ? series.slice(-range) : series
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const gid = useId().replace(/:/g, '')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  })
  const short = typeof window !== 'undefined' && window.innerWidth <= 600
  const H = 260
  const vals = rows.map((r) => r.netUsd)
  const hi = Math.max(0, ...vals)
  const lo = Math.min(0, ...vals)
  const pad = (hi - lo || 1) * 0.06
  const top = hi + pad
  const bot = lo - pad
  const x = (i: number) => (w * i) / Math.max(1, rows.length - 1)
  const y = (n: number) => H * (1 - (n - bot) / (top - bot))
  const pts = rows.map((r, i) => [x(i), y(r.netUsd)] as [number, number])
  const line = pts.length > 1 ? monotone(pts) : ''
  const y0 = y(0)
  const end = pts[pts.length - 1]
  const last = rows[rows.length - 1]
  const negEnd = (last?.netUsd ?? 0) < 0
  return (
    <div className="pv-chart">
      <div className="pv-head">
        <span className="pv-h">{vsIdleCopy.over}</span>
        <div className="rng" role="group" aria-label="Range">
          {RANGES.map((o) => (
            <button key={o.l} type="button" aria-pressed={range === o.v} onClick={() => setRange(o.v)}>
              {o.l}
            </button>
          ))}
        </div>
      </div>
      {rows.length > 1 ? (
        <>
          <div className="pv-plot" ref={ref} style={{ height: H }}>
            {w > 0 ? (
              <svg viewBox={`0 0 ${w} ${H}`} height={H} role="img" aria-label={vsIdleCopy.over} overflow="visible">
                <defs>
                  <linearGradient id={`u${gid}`} x1="0" y1="0" x2="0" y2={y0} gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor={EMERALD} stopOpacity=".24" />
                    <stop offset="1" stopColor={EMERALD} stopOpacity=".02" />
                  </linearGradient>
                  <linearGradient id={`d${gid}`} x1="0" y1={y0} x2="0" y2={H} gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor={ALERT} stopOpacity=".04" />
                    <stop offset="1" stopColor={ALERT} stopOpacity=".26" />
                  </linearGradient>
                  <clipPath id={`cu${gid}`}>
                    <rect x="0" y="0" width={w} height={Math.max(0, y0)} />
                  </clipPath>
                  <clipPath id={`cd${gid}`}>
                    <rect x="0" y={y0} width={w} height={Math.max(0, H - y0)} />
                  </clipPath>
                </defs>
                <path d={`${line} L${pts[pts.length - 1]![0]},${y0} L${pts[0]![0]},${y0} Z`} fill={`url(#u${gid})`} clipPath={`url(#cu${gid})`} />
                <path d={`${line} L${pts[pts.length - 1]![0]},${y0} L${pts[0]![0]},${y0} Z`} fill={`url(#d${gid})`} clipPath={`url(#cd${gid})`} />
                <path d={line} fill="none" stroke={EMERALD} strokeWidth="2.5" strokeLinejoin="round" clipPath={`url(#cu${gid})`} />
                <path d={line} fill="none" stroke={ALERT} strokeWidth="2.5" strokeLinejoin="round" clipPath={`url(#cd${gid})`} />
                <line x1="0" x2={w} y1={y0} y2={y0} stroke="#8a8578" strokeDasharray="5 6" />
                {end ? (
                  <>
                    <circle cx={end[0]} cy={end[1]} r="9" fill={negEnd ? ALERT : EMERALD} opacity=".18" />
                    <circle cx={end[0]} cy={end[1]} r="5" fill={negEnd ? ALERT : EMERALD} data-testid="net-end" />
                  </>
                ) : null}
              </svg>
            ) : null}
            <span className="pv-base" style={{ top: y0 - 9 }}>
              {vsIdleCopy.deposited(num(deposited), short)}
            </span>
          </div>
          <div className="pv-ax">
            <span>{dayLabel(rows[0]!.day).toUpperCase()}</span>
            <span>{dayLabel(rows[rows.length - 1]!.day).toUpperCase()}</span>
          </div>
        </>
      ) : null}
    </div>
  )
}
