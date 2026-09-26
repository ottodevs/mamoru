import type { ScenarioTape, TapeFrame, TapeId } from '@mamoru/domain'

// Pure helpers for the Lab replay: tape loading, keyframe navigation, scaling and the harvest comparison.

const ORDER: readonly TapeId[] = ['TAPE-HARVEST', 'TAPE-OUT-OF-RANGE', 'TAPE-POOL-SHOCK']

function isTape(v: unknown): v is ScenarioTape {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Partial<ScenarioTape>
  return typeof t.id === 'string' && typeof t.title === 'string' && Array.isArray(t.frames) && t.frames.length > 0
}

/** Tapes from an import.meta.glob map ({ path: module }), skipping anything that is not a tape, in catalog order. */
export function loadTapes(mods: Record<string, unknown>): ScenarioTape[] {
  const tapes = Object.values(mods)
    .map((m) => (typeof m === 'object' && m !== null && 'default' in m ? (m as { default: unknown }).default : m))
    .filter(isTape)
  const rank = (id: string) => {
    const i = ORDER.indexOf(id as TapeId)
    return i < 0 ? ORDER.length : i
  }
  return tapes.sort((a, b) => rank(a.id) - rank(b.id) || a.title.localeCompare(b.title))
}

export function keyIndices(frames: readonly TapeFrame[]): number[] {
  return frames.flatMap((f, i) => (f.key ? [i] : []))
}

/** First keyframe after i, else the last frame. */
export function nextKey(frames: readonly TapeFrame[], i: number): number {
  return keyIndices(frames).find((k) => k > i) ?? Math.max(0, frames.length - 1)
}

/** Last keyframe before i, else the first frame. */
export function prevKey(frames: readonly TapeFrame[], i: number): number {
  return keyIndices(frames).findLast((k) => k < i) ?? 0
}

/** The keyframe at or before i: the chapter the cursor is in. */
export function currentKey(frames: readonly TapeFrame[], i: number): TapeFrame | null {
  const k = keyIndices(frames).findLast((k) => k <= i)
  return k === undefined ? null : (frames[k] ?? null)
}

export function num(d: string): number | null {
  const n = Number(d)
  return d.trim() !== '' && Number.isFinite(n) ? n : null
}

/** Price extent over pool price and range bounds, padded so the band never touches the edge. */
export function priceDomain(frames: readonly TapeFrame[]): [number, number] {
  const vs = frames.flatMap((f) => [f.pool.price, f.position?.lowerPrice, f.position?.upperPrice]).flatMap((d) => {
    const n = d === undefined ? null : num(d)
    return n === null ? [] : [n]
  })
  if (vs.length === 0) return [0, 1]
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08
  return [lo - pad, hi + pad]
}

/** Value to SVG y: top = domain max, bottom = domain min. */
export function scaleY(v: number, [lo, hi]: [number, number], top: number, bottom: number): number {
  if (hi === lo) return (top + bottom) / 2
  return bottom - ((v - lo) / (hi - lo)) * (bottom - top)
}

/** Frame index to SVG x across [left, right]. */
export function scaleX(i: number, n: number, left: number, right: number): number {
  return n <= 1 ? (left + right) / 2 : left + (i / (n - 1)) * (right - left)
}

export type Harvest = { fees: number; opCost: number; factor: number; line: number; sign: '>' | '<' | '=' }

/** Harvest when fees > opCost × factor; the sign comes from the numbers, never from the decision. */
export function harvestMath(f: TapeFrame): Harvest | null {
  const fees = f.position ? num(f.position.feesValue) : null
  const opCost = num(f.cost.opCost)
  if (fees === null || opCost === null) return null
  const factor = f.cost.factorBps / 10_000
  const line = opCost * factor
  const sign = fees > line ? '>' : fees < line ? '<' : '='
  return { fees, opCost, factor, line, sign }
}

/** Decimal string for display: 2 places from 1 up, 4 significant below. */
export function fmt(n: number): string {
  if (n === 0) return '0'
  if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n.toLocaleString('en-US', { maximumSignificantDigits: 4 })
}

export function fmtDec(d: string): string {
  const n = num(d)
  return n === null ? '—' : fmt(n)
}

export const SPEEDS = [1, 2, 4] as const
export type Speed = (typeof SPEEDS)[number]
export const STEP_MS = 700

export function stepDelay(speed: Speed): number {
  return Math.round(STEP_MS / speed)
}
