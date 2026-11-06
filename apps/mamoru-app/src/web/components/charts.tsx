// Hand-written SVG charts for Stats and the Portfolio (spec 013 amendment A1, mockups in PR #302). No chart library:
// a smooth area line, day bars/dots/line on a band axis, and a donut. Each measures its own width, so it redraws on
// resize, and shows a tooltip with the value and the day on hover or tap.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export const EMERALD = '#2f5d50'
/** Distribution colours in fixed order; labels carry identity, colour only separates. */
export const CATS = ['#2f5d50', '#c08a3e', '#5b7a99', '#8a8578']

export const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Round axis: steps of 1, 2, 2.5 or 5 x 10^n, 3 to 6 intervals, top within 30 % of the data. */
export function scale(vmax: number): { top: number; ticks: number[] } {
  const v = vmax > 0 ? vmax : 1
  const p = 10 ** Math.floor(Math.log10(v / 4))
  const steps = [1, 2, 2.5, 5, 10, 20, 25, 50].map((m) => m * p)
  const step =
    steps.find((s) => {
      const k = Math.ceil(v / s)
      return k >= 3 && k <= 6 && (k * s) / v <= 1.3
    }) ??
    steps.find((s) => Math.ceil(v / s) <= 6) ??
    steps[steps.length - 1]!
  const top = Math.ceil(v / step) * step
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) }
}

/** Monotone cubic (Fritsch-Carlson): smooth, never overshoots, so a flat stretch stays flat. */
function monotone(pts: [number, number][]): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M${pts[0]![0]},${pts[0]![1]}`
  const dx: number[] = []
  const dy: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1]![0] - pts[i]![0]
    dy[i] = (pts[i + 1]![1] - pts[i]![1]) / dx[i]!
  }
  m[0] = dy[0]!
  m[n - 1] = dy[n - 2]!
  for (let i = 1; i < n - 1; i++) m[i] = dy[i - 1]! * dy[i]! <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / dy[i - 1]! + (dx[i]! + 2 * dx[i - 1]!) / dy[i]!)
  let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3
    const a = pts[i]!
    const b = pts[i + 1]!
    d += ` C${(a[0] + h).toFixed(1)},${(a[1] + m[i]! * h).toFixed(1)} ${(b[0] - h).toFixed(1)},${(b[1] - m[i + 1]! * h).toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`
  }
  return d
}

/** The element's width, kept current. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** The path's length for the draw-in animation (CSS var --len). */
function useDrawIn(dep: string) {
  const ref = useRef<SVGPathElement>(null)
  useEffect(() => {
    const p = ref.current
    if (p && typeof p.getTotalLength === 'function') p.style.setProperty('--len', String(p.getTotalLength()))
  }, [dep])
  return ref
}

function Tip({ at, w, children }: { at: { x: number; y: number } | null; w: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  useLayoutEffect(() => {
    if (!at || !ref.current) return
    const tw = ref.current.offsetWidth
    const th = ref.current.offsetHeight
    setPos({ left: Math.min(Math.max(0, at.x - tw / 2), Math.max(0, w - tw)), top: Math.max(-th - 4, at.y - th - 14) })
  }, [at, w, children])
  return (
    <div ref={ref} className={`cx-tip${at ? ' on' : ''}`} style={{ left: pos.left, top: pos.top }} aria-hidden="true">
      {children}
    </div>
  )
}

export type AreaRow = { day: string; v: number }

/**
 * Area chart: smooth line, soft gradient fill, end-point marker, draw-in, hover or tap tooltip with value and day.
 * `axes: false` is the Portfolio's schematic form: no grid, no axis labels.
 */
export function AreaChart({ rows, h, axes, label, fmtAxis, fmtTip, when = (r) => dayLabel(r.day) }: { rows: AreaRow[]; h: number; axes: boolean; label: string; fmtAxis?: (v: number) => string; fmtTip: (v: number) => string; when?: (r: AreaRow) => string }) {
  const [box, W] = useWidth<HTMLDivElement>()
  const gid = useId().replace(/:/g, '')
  const [hover, setHover] = useState<number | null>(null)
  const L = axes ? 46 : 6
  const R = 10
  const T = axes ? 12 : 14
  const B = axes ? 24 : 10
  const vals = rows.map((r) => r.v)
  const sc = scale(Math.max(0, ...vals))
  const lo = axes ? 0 : Math.min(...vals) * 0.92
  const hi = axes ? sc.top : Math.max(...vals) * 1.04
  const x = (i: number) => L + ((W - L - R) * i) / Math.max(1, rows.length - 1)
  const y = (v: number) => T + (h - T - B) * (1 - (v - lo) / (hi - lo || 1))
  const pts = rows.map((r, i) => [x(i), y(r.v)] as [number, number])
  const line = monotone(pts)
  const lineRef = useDrawIn(`${W}:${line}`)
  const end = pts[pts.length - 1]
  const every = Math.max(1, Math.ceil(rows.length / (W < 500 ? 4 : 6)))
  const pick = (clientX: number, svg: SVGSVGElement) => {
    const r = svg.getBoundingClientRect()
    const cx = (clientX - r.left) * (W / r.width)
    setHover(Math.max(0, Math.min(rows.length - 1, Math.round(((cx - L) / (W - L - R)) * (rows.length - 1)))))
  }
  const hp = hover === null ? null : pts[hover]
  return (
    <div className="cx-plot" ref={box}>
      {W > 0 && rows.length > 1 ? (
        <svg
          viewBox={`0 0 ${W} ${h}`}
          height={h}
          role="img"
          aria-label={label}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={EMERALD} stopOpacity={axes ? 0.22 : 0.26} />
              <stop offset="100%" stopColor={EMERALD} stopOpacity={0} />
            </linearGradient>
          </defs>
          {axes
            ? sc.ticks.map((t) => (
                <g key={t}>
                  <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'base' : 'grid'} />
                  <text x={L - 8} y={y(t) + 3.5} textAnchor="end">
                    {fmtAxis ? fmtAxis(t) : t}
                  </text>
                </g>
              ))
            : null}
          {axes
            ? rows.map((r, i) =>
                (rows.length - 1 - i) % every ? null : (
                  <text key={r.day} x={x(i)} y={h - 6} textAnchor="middle">
                    {dayLabel(r.day)}
                  </text>
                ),
              )
            : null}
          <path d={`${line} L${end![0]},${y(lo)} L${pts[0]![0]},${y(lo)} Z`} fill={`url(#${gid})`} className="cx-fill" />
          <path ref={lineRef} d={line} fill="none" stroke={EMERALD} strokeWidth={axes ? 2 : 2.25} strokeLinecap="round" strokeLinejoin="round" className="cx-draw" />
          <circle cx={end![0]} cy={end![1]} r={7} fill={EMERALD} opacity={0.14} className="cx-pulse" />
          <circle cx={end![0]} cy={end![1]} r={3.6} fill="#f8f5ef" stroke={EMERALD} strokeWidth={2} className="cx-end" />
          {hp ? (
            <>
              <line x1={hp[0]} x2={hp[0]} y1={T} y2={h - B} className="hair" />
              <circle cx={hp[0]} cy={hp[1]} r={4.5} fill={EMERALD} stroke="#f8f5ef" strokeWidth={2} />
            </>
          ) : null}
        </svg>
      ) : null}
      <Tip at={hp ? { x: hp[0], y: hp[1] } : null} w={W}>
        {hover !== null && rows[hover] ? (
          <>
            <b>{fmtTip(rows[hover]!.v)}</b>
            {when(rows[hover]!)}
          </>
        ) : null}
      </Tip>
    </div>
  )
}

export type DaySeries = { key: string; kind: 'line' | 'dots' | 'bars' }

/** Day chart on a band axis: bars (earned per day) or dots + a line (APR and its 7-day average). */
export function DayChart<Row extends { day: string }>({ rows, h, series, label, fmtAxis, tip }: { rows: Row[]; h: number; series: DaySeries[]; label: string; fmtAxis: (v: number) => string; tip: (r: Row) => ReactNode }) {
  const [box, W] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const L = 44
  const R = 8
  const T = 10
  const B = 24
  const get = (r: Row, k: string) => (r as unknown as Record<string, number | undefined>)[k]
  const vals = rows.flatMap((r) => series.map((s) => get(r, s.key))).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const sc = scale(Math.max(0, ...vals))
  const n = rows.length
  const band = (W - L - R) / Math.max(1, n)
  const x = (i: number) => L + band * i + band / 2
  const y = (v: number) => T + (h - T - B) * (1 - v / sc.top)
  const every = Math.max(1, Math.ceil(n / (W < 500 ? 4 : 7)))
  const lineSeries = series.find((s) => s.kind === 'line')
  let d = ''
  if (lineSeries) {
    let pen = false
    rows.forEach((r, i) => {
      const v = get(r, lineSeries.key)
      if (typeof v !== 'number') {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
      pen = true
    })
  }
  const lineRef = useDrawIn(`${W}:${d}`)
  const bw = Math.max(3, Math.min(18, band * 0.62))
  return (
    <div className="cx-plot" ref={box}>
      {W > 0 && n > 0 ? (
        <svg viewBox={`0 0 ${W} ${h}`} height={h} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
          {sc.ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'base' : 'grid'} />
              <text x={L - 8} y={y(t) + 3.5} textAnchor="end">
                {fmtAxis(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) =>
            (n - 1 - i) % every ? null : (
              <text key={r.day} x={x(i)} y={h - 6} textAnchor="middle">
                {dayLabel(r.day)}
              </text>
            ),
          )}
          {series.map((s) =>
            s.kind === 'bars'
              ? rows.map((r, i) => {
                  const v = get(r, s.key)
                  if (typeof v !== 'number' || v <= 0) return null
                  const bh = Math.max(1, y(0) - y(v))
                  return <path key={`${s.key}${r.day}`} d={`M${x(i) - bw / 2},${y(0)} v${-(bh - 2)} q0,-2 2,-2 h${bw - 4} q2,0 2,2 v${bh - 2} z`} fill={EMERALD} />
                })
              : s.kind === 'dots'
                ? rows.map((r, i) => {
                    const v = get(r, s.key)
                    return typeof v === 'number' ? <circle key={`${s.key}${r.day}`} cx={x(i)} cy={y(v)} r={3} fill="#8a8578" /> : null
                  })
                : null,
          )}
          {lineSeries ? <path ref={lineRef} d={d} fill="none" stroke={EMERALD} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="cx-draw" /> : null}
          {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={T} y2={h - B} className="hair" /> : null}
          {rows.map((r, i) => (
            <rect key={`hit${r.day}`} x={L + band * i} y={T} width={band} height={h - T - B} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
          ))}
        </svg>
      ) : null}
      <Tip at={hover === null ? null : { x: x(hover), y: 6 }} w={W}>
        {hover !== null && rows[hover] ? tip(rows[hover]!) : null}
      </Tip>
    </div>
  )
}

export type DonutRow = { name: string; usd: number; pct: number; note?: string }

/** Donut with 2 px gaps, a centre label, and a legend with share and dollars. */
export function Donut({ rows, centre, fmtUsd }: { rows: DonutRow[]; centre: { value: string; label: string }; fmtUsd: (v: number) => string }) {
  const S = 168
  const w = 18
  const rr = S / 2 - 2 - w / 2
  const C = 2 * Math.PI * rr
  const total = rows.reduce((a, r) => a + r.usd, 0) || 1
  const gap = rows.length > 1 ? 2.5 : 0
  let acc = 0
  return (
    <div className="cx-donut">
      <div className="cx-ring" style={{ width: S, height: S }}>
        <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} role="img" aria-label={rows.map((r) => `${r.name} ${r.pct.toFixed(1)}%`).join(', ')}>
          {rows.map((r, i) => {
            const len = (r.usd / total) * C
            const off = -acc
            acc += len
            return (
              <circle
                key={r.name}
                cx={S / 2}
                cy={S / 2}
                r={rr}
                fill="none"
                stroke={CATS[i % CATS.length]}
                strokeWidth={w}
                strokeDasharray={`${Math.max(0.5, len - gap)} ${C}`}
                strokeDashoffset={off}
                transform={`rotate(-90 ${S / 2} ${S / 2})`}
                className="seg-arc"
                style={{ animationDelay: `${i * 70}ms` }}
              />
            )
          })}
        </svg>
        <div className="centre">
          <b>{centre.value}</b>
          <span>{centre.label}</span>
        </div>
      </div>
      <ul className="cx-legend">
        {rows.map((r, i) => (
          <li key={r.name}>
            <span className="sw" style={{ background: CATS[i % CATS.length] }} />
            <span className="n">
              {r.name}
              {r.note ? <small>{r.note}</small> : null}
            </span>
            <span className="p">{r.pct.toFixed(1)}%</span>
            <span className="v">{fmtUsd(r.usd)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
