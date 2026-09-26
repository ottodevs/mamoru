import type { TapeFrame } from '@mamoru/domain'
import { harvestMath, num, priceDomain, scaleX, scaleY } from './tape.ts'

const W = 640
const H = 250
const L = 8
const R = W - 8
const TOP = 10
const BOT = 170
const FEE_TOP = 190
const FEE_BOT = 240

/** Runs of consecutive frames that hold a position, so the band breaks where there is none. */
export function bandRuns(frames: readonly TapeFrame[]): number[][] {
  const runs: number[][] = []
  let cur: number[] = []
  frames.forEach((f, i) => {
    if (f.position && num(f.position.lowerPrice) !== null && num(f.position.upperPrice) !== null) cur.push(i)
    else if (cur.length) {
      runs.push(cur)
      cur = []
    }
  })
  if (cur.length) runs.push(cur)
  return runs
}

/** Pool price with the position range, keyframe ticks and the cursor; below it, fees against the harvest line. */
export function TapeChart({ frames, at }: { frames: readonly TapeFrame[]; at: number }) {
  const n = frames.length
  const dom = priceDomain(frames)
  const x = (i: number) => scaleX(i, n, L, R)
  const y = (v: number) => scaleY(v, dom, TOP, BOT)
  const price = frames.map((f, i) => {
    const p = num(f.pool.price)
    return p === null ? null : `${x(i).toFixed(1)},${y(p).toFixed(1)}`
  })
  const bands = bandRuns(frames).map((run) => {
    const up = run.map((i) => `${x(i).toFixed(1)},${y(num(frames[i]!.position!.upperPrice)!).toFixed(1)}`)
    const lo = run.map((i) => `${x(i).toFixed(1)},${y(num(frames[i]!.position!.lowerPrice)!).toFixed(1)}`).reverse()
    return [...up, ...lo].join(' ')
  })
  const math = frames.map(harvestMath)
  const feeMax = Math.max(1e-9, ...math.flatMap((m) => (m ? [m.fees, m.line] : [])))
  const fy = (v: number) => scaleY(v, [0, feeMax], FEE_TOP, FEE_BOT)
  const bar = Math.max(2, Math.min(14, ((R - L) / Math.max(1, n)) * 0.6))
  const cur = frames[at]
  const curPrice = cur ? num(cur.pool.price) : null
  const line = math
    .map((m, i) => (m ? `${x(i).toFixed(1)},${fy(m.line).toFixed(1)}` : null))
    .filter((p): p is string => p !== null)
    .join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Pool price over the run, with the position range and fees against the harvest line" data-testid="lab-chart">
      {bands.map((pts, i) => (
        <polygon key={i} points={pts} fill="var(--color-emerald)" fillOpacity={0.1} stroke="var(--color-emerald)" strokeOpacity={0.35} strokeWidth={1} data-testid="lab-band" />
      ))}
      <polyline points={price.filter((p): p is string => p !== null).join(' ')} fill="none" stroke="var(--color-ink)" strokeWidth={1.5} strokeLinejoin="round" />
      {frames.map((f, i) =>
        f.key ? <line key={i} x1={x(i)} x2={x(i)} y1={BOT - 6} y2={BOT + 4} stroke="var(--color-stone)" strokeWidth={1} data-testid="lab-tick" /> : null,
      )}
      <line x1={L} x2={R} y1={BOT + 4} y2={BOT + 4} stroke="var(--color-wash)" strokeWidth={1} />
      {math.map((m, i) =>
        m ? (
          <rect key={i} x={x(i) - bar / 2} width={bar} y={fy(m.fees)} height={Math.max(0, FEE_BOT - fy(m.fees))} fill={m.sign === '>' ? 'var(--color-emerald)' : 'var(--color-wash)'} opacity={i === at ? 1 : 0.75} />
        ) : null,
      )}
      {line ? <polyline points={line} fill="none" stroke="var(--color-alert)" strokeWidth={1} strokeDasharray="3 3" /> : null}
      <text x={L} y={FEE_TOP - 6} fontFamily="var(--font-mono)" fontSize={9} letterSpacing="0.08em" fill="var(--color-stone)">
        FEES · HARVEST LINE
      </text>
      <line x1={x(at)} x2={x(at)} y1={TOP} y2={FEE_BOT} stroke="var(--color-ink)" strokeOpacity={0.35} strokeWidth={1} data-testid="lab-cursor" />
      {curPrice !== null ? <circle cx={x(at)} cy={y(curPrice)} r={4} fill={cur?.position?.inRange === false ? 'var(--color-alert)' : 'var(--color-emerald)'} /> : null}
    </svg>
  )
}
