// Lab sweep (spec 004, #101): one policy variant over every Lab window and deposit, metrics per cell, TRAIN and TEST
// reported apart. Pure parts live here (overrides, metrics, tables); cli/sweep.ts runs the cells in parallel.
import { POLICIES, type PolicyVersion } from '@mamoru/policy'
import { entry } from '@mamoru/registry'
import type { RunResult } from './types.ts'
import type { LabWindow, Split } from './windows.ts'

const DAY = 86_400

/** A policy of `POLICIES` with parameters replaced. Its id is `<base>+<name>` so a result names the variant. */
export type Variant = { name: string; policy: string; overrides?: Record<string, unknown> }

/**
 * Deep merge for parameter overrides: objects merge key by key, anything else (arrays included) replaces. A string
 * `"123n"` becomes a bigint, so overrides can come from JSON. A key is accepted when the base policy has it or the
 * shape of the optional parameters names it; anything else is refused, so a typo never runs as the baseline under a
 * new name. A rule the base policy lacks must be given whole.
 */
export function applyOverrides<T>(base: T, overrides: Record<string, unknown>, path = '', shape: Shape | undefined = OPTIONAL): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(overrides)) {
    const at = path ? `${path}.${k}` : k
    const sub = isShapeNode(shape) ? (shape[k] ?? (MAP_KEYS[path] === undefined || MAP_KEYS[path]!.includes(k) ? shape['*'] : undefined)) : undefined
    if (!(k in out) && sub === undefined) throw new Error(`override ${at}: the policy has no such parameter`)
    if (Array.isArray(out[k]) && !ARRAYS.has(at)) throw new Error(`override ${at}: lists are not overridden here; write a policy in POLICIES`)
    const cur = out[k]
    const wantsObject = isPlainObject(cur) || isShapeNode(sub)
    if (wantsObject !== isPlainObject(v)) throw new Error(`override ${at}: want ${wantsObject ? 'an object' : 'a value'}, got ${JSON.stringify(v)}`)
    if (isPlainObject(v)) {
      // A parameter the base lacks is given whole: every key of its shape, unless it is keyed by pool or bucket.
      if (cur === undefined && isShapeNode(sub) && !('*' in sub) && !CONTAINERS.has(at)) {
        const left = Object.keys(sub).filter((x) => !(x in v))
        if (left.length > 0) throw new Error(`override ${at}: the policy has no ${k} to merge into; give ${left.join(', ')} too`)
      }
      out[k] = applyOverrides(cur ?? {}, v, at, sub)
      continue
    }
    const value = typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v
    // The value must be of the parameter's type: the base value's, or the shape's for a parameter the base lacks.
    const want = ENUMS[at.replace(/^guards\.byBucket\.[^.]+\./, 'guards.byBucket.*.')] ?? (cur !== undefined ? (Array.isArray(cur) ? 'array' : typeof cur) : sub)
    const ok = Array.isArray(want) ? want.includes(value as string) : want === 'array' ? Array.isArray(value) && validBuckets(value) : typeof value === want
    if (!ok) throw new Error(`override ${at}: want ${Array.isArray(want) ? want.join(' | ') : want}, got ${JSON.stringify(v)}`)
    out[k] = value
  }
  return out as T
}

type Leaf = 'number' | 'bigint' | 'boolean' | readonly string[]
type Shape = Leaf | { [key: string]: Shape }
function isShapeNode(s: Shape | undefined): s is { [key: string]: Shape } {
  return typeof s === 'object' && !Array.isArray(s)
}
const ENUMS: Record<string, readonly string[]> = { allocation: ['first-entry', 'target-weights'], 'range.adjust': ['off', 'on_out_of_range'], 'geometry.skew.regime': ['ret24h', 'ema7d'] }
const BUCKET_IDS = ['stables', 'btc-usdc', 'risk'] as const
/** Maps keyed by name: which keys they take (undefined: any, e.g. a pool name). */
const MAP_KEYS: Record<string, readonly string[]> = { 'guards.byBucket': BUCKET_IDS }
/** Optional groups whose rules are each optional: a rule inside is given whole, the group need not hold them all. */
const CONTAINERS = new Set(['geometry'])
/** The only list an override may replace: the buckets, to try other weights or pools. */
const ARRAYS = new Set(['buckets'])
function validBuckets(v: unknown[]): boolean {
  return v.every((b) => isPlainObject(b) && BUCKET_IDS.includes(b.id as never) && typeof b.preference === 'number' && Array.isArray(b.pools) && b.pools.every((p) => typeof p === 'string'))
}
const BUCKET_RULES: Shape = { fallFreeze: { fallBps: 'number', volBps: 'number' } }
/** Optional parameters of `PolicyVersion` an override may add although the base policy does not set them. `*`: any pool. */
const OPTIONAL: Shape = {
  allocation: ENUMS.allocation!,
  minEntry: 'bigint',
  rebalanceBandBps: 'number',
  range: { widthTicksByPool: { '*': 'number' } },
  guards: { byBucket: { '*': BUCKET_RULES } },
  // Lab range geometry (#101): given whole, every key of the rule.
  geometry: {
    skew: { belowShareBps: 'number', regime: ENUMS['geometry.skew.regime']!, fallBps: 'number', mirror: 'boolean' },
    volWidth: { k: 'number', horizonSeconds: 'number', minTicks: 'number', maxTicks: 'number', earlyRatio: 'number' },
  },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof v !== 'bigint'
}

export function policyOf(v: Variant): PolicyVersion {
  const base = POLICIES[v.policy]
  if (!base) throw new Error(`unknown policy ${v.policy}; known: ${Object.keys(POLICIES).join(', ')}`)
  if (!v.overrides || Object.keys(v.overrides).length === 0) return v.name === v.policy ? base : { ...base, policyId: `${base.policyId}+${v.name}` }
  return { ...applyOverrides(base, v.overrides), policyId: `${base.policyId}+${v.name}` }
}

/** `a.b.c=value` into `{ a: { b: { c: value } } }`; the value is JSON when it parses, a string otherwise. */
export function overridesFromAssignments(sets: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of sets) {
    const eq = s.indexOf('=')
    if (eq <= 0) throw new Error(`--set ${s}: want path=value`)
    const keys = s.slice(0, eq).split('.')
    const raw = s.slice(eq + 1)
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      value = raw
    }
    let node = out
    for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>
    node[keys.at(-1)!] = value
  }
  return out
}

/** Worst fall of the value from a high of the previous 24 hours, in basis points (a fall is positive). */
export function worstDayBps(time: number[], value: bigint[]): number {
  let worst = 0
  // Indexes of the last 24 hours whose value no later sample in the window exceeds: the front is the window's high.
  const highs: number[] = []
  let head = 0
  for (let i = 0; i < value.length; i++) {
    while (head < highs.length && time[i]! - time[highs[head]!]! > DAY) head++
    const top = head < highs.length ? value[highs[head]!]! : 0n
    if (top > value[i]!) worst = Math.max(worst, Number(((top - value[i]!) * 1_000_000n) / top) / 100)
    while (highs.length > head && value[highs.at(-1)!]! <= value[i]!) highs.pop()
    highs.push(i)
  }
  return worst
}

/** One cell's numbers, in the savings asset (floats, for tables) and in basis points. */
export type CellMetrics = {
  returnPct: number
  vsHoldPct: number
  end: number
  hold: number
  maxDrawdownPct: number
  worstDayPct: number
  ops: number
  opsByKind: Record<string, number>
  refused: number
  gas: number
  fees: number
  /** 100 minus the value-weighted share of LP in range, averaged over the samples with a position; null with no mint. */
  outOfRangePct: number | null
  /** Samples replayed, and samples stepped over because a pool the policy needs was not read there. */
  samples: number
  gaps: number
  resultHash: string
}

export function cellMetrics(r: RunResult, decimals: number): CellMetrics {
  const m = r.metrics
  const unit = 10 ** decimals
  const n = (v: bigint) => Number(v) / unit
  const ops = Object.values(m.operations).reduce((a, b) => a + b, 0)
  return {
    returnPct: m.returnBps / 100,
    vsHoldPct: m.start === 0n ? 0 : Number((m.vsHodl * 1_000_000n) / m.start) / 10_000,
    end: n(m.end),
    hold: n(m.hodl),
    maxDrawdownPct: m.maxDrawdownBps / 100,
    worstDayPct: worstDayBps(r.series.time, r.series.value) / 100,
    ops,
    opsByKind: { ...m.operations },
    refused: m.refused,
    gas: n(m.gas),
    fees: n(m.fees),
    outOfRangePct: m.operations.enter_mint === 0 ? null : (10_000 - m.timeInRangeBps) / 100,
    samples: r.window.samples,
    gaps: r.window.gaps,
    resultHash: r.resultHash,
  }
}

export function decimalsOf(policy: PolicyVersion): number {
  return entry(policy.savingsAsset).decimals ?? 6
}

export type Cell = { window: string; split: Split; regime: string; deposit: number; variant: string; policyId: string } & ({ status: 'ok'; metrics: CellMetrics } | { status: 'skipped'; reason: string })

/** Cells in a fixed order (window order of the Lab set, then variant, then deposit), whatever order they finished in. */
export function sortCells(cells: Cell[], windows: readonly LabWindow[], variants: Variant[], deposits: number[]): Cell[] {
  const wi = new Map(windows.map((w, i) => [w.id, i]))
  const vi = new Map(variants.map((v, i) => [v.name, i]))
  const di = new Map(deposits.map((d, i) => [d, i]))
  return [...cells].sort((a, b) => wi.get(a.window)! - wi.get(b.window)! || vi.get(a.variant)! - vi.get(b.variant)! || di.get(a.deposit)! - di.get(b.deposit)!)
}

export type Aggregate = { variant: string; split: Split; deposit: number; cells: number; meanReturnPct: number; meanVsHoldPct: number; worstReturnPct: number; worstDrawdownPct: number; worstDayPct: number; ops: number; gas: number }

/** Per variant, split and deposit: mean and worst over the windows that ran. */
export function aggregate(cells: Cell[]): Aggregate[] {
  const groups = new Map<string, Extract<Cell, { status: 'ok' }>[]>()
  for (const c of cells) {
    if (c.status !== 'ok') continue
    const k = `${c.variant}\u0000${c.split}\u0000${c.deposit}`
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  return [...groups.values()].map((g) => {
    const ms = g.map((c) => c.metrics)
    const mean = (f: (m: CellMetrics) => number) => ms.reduce((a, m) => a + f(m), 0) / ms.length
    return {
      variant: g[0]!.variant,
      split: g[0]!.split,
      deposit: g[0]!.deposit,
      cells: g.length,
      meanReturnPct: mean((m) => m.returnPct),
      meanVsHoldPct: mean((m) => m.vsHoldPct),
      worstReturnPct: Math.min(...ms.map((m) => m.returnPct)),
      worstDrawdownPct: Math.max(...ms.map((m) => m.maxDrawdownPct)),
      worstDayPct: Math.max(...ms.map((m) => m.worstDayPct)),
      ops: ms.reduce((a, m) => a + m.ops, 0),
      gas: ms.reduce((a, m) => a + m.gas, 0),
    }
  })
}

const f2 = (x: number) => x.toFixed(2)

export function markdown(cells: Cell[], aggs: Aggregate[]): string {
  const out: string[] = []
  for (const split of ['train', 'test'] as const) {
    const rows = cells.filter((c) => c.split === split)
    if (rows.length === 0) continue
    out.push(`### ${split.toUpperCase()}`, '', '| Window | Regime | Deposit | Variant | Return % | vs hold % | Max DD % | Worst day % | Ops | Gas | Fees | Out of range % |', '|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const c of rows) {
      if (c.status !== 'ok') out.push(`| ${c.window} | ${c.regime} | ${c.deposit} | ${c.variant} | skipped: ${c.reason} | | | | | | | |`)
      else {
        const m = c.metrics
        out.push(`| ${c.window} | ${c.regime} | ${c.deposit} | ${c.variant} | ${f2(m.returnPct)} | ${f2(m.vsHoldPct)} | ${f2(m.maxDrawdownPct)} | ${f2(m.worstDayPct)} | ${m.ops} | ${f2(m.gas)} | ${f2(m.fees)} | ${m.outOfRangePct === null ? 'n/a' : f2(m.outOfRangePct)}${m.gaps > 0 ? ` (${m.gaps} gaps)` : ''} |`)
      }
    }
    out.push('')
  }
  out.push('### Per split', '', '| Split | Deposit | Variant | Windows | Mean return % | Mean vs hold % | Worst return % | Worst max DD % | Worst day % | Ops | Gas |', '|---|---|---|---|---|---|---|---|---|---|---|')
  for (const a of aggs) out.push(`| ${a.split} | ${a.deposit} | ${a.variant} | ${a.cells} | ${f2(a.meanReturnPct)} | ${f2(a.meanVsHoldPct)} | ${f2(a.worstReturnPct)} | ${f2(a.worstDrawdownPct)} | ${f2(a.worstDayPct)} | ${a.ops} | ${f2(a.gas)} |`)
  return `${out.join('\n')}\n`
}
