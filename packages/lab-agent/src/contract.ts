// Agent Lab agent (008 task 4, otto/mamoru#200): the answer contract (AL-20...AL-20c) — the TS type for a
// verified answer, the closed metric enum mapped to a run in code (AL-20a), and the verdict sentences the server
// writes from two comparable runs (AL-20b, AL-20c). The deterministic verifier that checks a candidate answer
// against this contract is verifier.ts; this file only defines the shape and the pure lookups/sentences.
import { ReasonError } from '@mamoru/domain'
import { basePolicyOf } from '@mamoru/lab-bench'
import type { RunResult } from './types.ts'

// ---------------------------------------------------------------------------
// Blocks (AL-20)
// ---------------------------------------------------------------------------

export type TextBlock = { type: 'text'; md: string }
export type ClaimBlock = { type: 'claim'; metric: MetricKey; runId: string; value: number }
/** `against`: `'hold'` (vs. holding the mix), `'usdc'` (vs. never depositing), or another run's `runId`. */
export type VerdictBlock = { type: 'verdict'; runId: string; against: VerdictAgainst }
export type ChartKind = 'equity' | 'decomposition' | 'pool_range'
export type ChartBlock = { type: 'chart'; kind: ChartKind; runIds: string[]; pool?: string }
export type CaveatBlock = { type: 'caveat'; md: string }
export type Block = TextBlock | ClaimBlock | VerdictBlock | ChartBlock | CaveatBlock
export type Answer = { blocks: Block[] }

export type VerdictBaseline = 'hold' | 'usdc'
export type VerdictAgainst = VerdictBaseline | string
export const VERDICT_BASELINES: readonly VerdictBaseline[] = ['hold', 'usdc']
export function isVerdictBaseline(x: string): x is VerdictBaseline {
  return (VERDICT_BASELINES as readonly string[]).includes(x)
}

/** AL-21a: only `claim` and `verdict` blocks are verified results; `text`/`caveat` are the agent's prose. */
export function isVerifiedBlock(b: Block): b is ClaimBlock | VerdictBlock {
  return b.type === 'claim' || b.type === 'verdict'
}
export function isProseBlock(b: Block): b is TextBlock | CaveatBlock {
  return b.type === 'text' || b.type === 'caveat'
}

const CHART_KINDS: readonly ChartKind[] = ['equity', 'decomposition', 'pool_range']
export function isChartKind(x: unknown): x is ChartKind {
  return typeof x === 'string' && (CHART_KINDS as readonly string[]).includes(x)
}

// ---------------------------------------------------------------------------
// Metric enum (AL-20a): closed base keys, plus `operations.<kind>` for whatever op kinds a run actually counted.
// The model never writes a label, unit or path — only picks a key from this list; resolveMetric does the rest.
// ---------------------------------------------------------------------------

export const METRIC_BASE_KEYS = [
  'end',
  'net',
  'vsHodl',
  'vsUsdc',
  'fees',
  'gas',
  'priceMove',
  'timeInRange',
  'maxDrawdown',
  'return',
  'days',
] as const
export type MetricBaseKey = (typeof METRIC_BASE_KEYS)[number]
export type MetricKey = MetricBaseKey | `operations.${string}`

export function isMetricKey(x: unknown): x is MetricKey {
  if (typeof x !== 'string' || x.length === 0) return false
  return (METRIC_BASE_KEYS as readonly string[]).includes(x) || x.startsWith('operations.')
}

export type MetricUnit = 'USDC' | '%' | 'ops' | 'days'
export type MetricLabel = { es: string; en: string }
export type MetricInfo = { rawValue: number; unit: MetricUnit; decimals: number; label: MetricLabel }

const LABELS: Record<MetricBaseKey, MetricLabel> = {
  end: { es: 'Saldo final', en: 'Ending balance' },
  net: { es: 'Resultado neto', en: 'Net result' },
  vsHodl: { es: 'Vs. mantener la mezcla', en: 'Vs. holding the mix' },
  vsUsdc: { es: 'Vs. quedarte en USDC', en: 'Vs. staying in USDC' },
  fees: { es: 'Comisiones ganadas', en: 'Fees earned' },
  gas: { es: 'Gas gastado', en: 'Gas spent' },
  priceMove: { es: 'Movimiento de precio (BTC)', en: 'Price move (BTC)' },
  timeInRange: { es: 'Tiempo en rango', en: 'Time in range' },
  maxDrawdown: { es: 'Caída máxima', en: 'Max drawdown' },
  return: { es: 'Retorno', en: 'Return' },
  days: { es: 'Días', en: 'Days' },
}

/** `window.market`'s real shape (dataset manifest, not shipped to CI): fractions, not already in a unit. */
type MarketMove = { move?: unknown }
type Market = { btc?: MarketMove }
function marketBtcMovePct(market: unknown): number | undefined {
  if (typeof market !== 'object' || market === null) return undefined
  const btc = (market as Market).btc
  if (typeof btc !== 'object' || btc === null) return undefined
  const move = btc.move
  return typeof move === 'number' && Number.isFinite(move) ? move * 100 : undefined
}

/**
 * AL-20a: the one place a metric key turns into a number out of a stored run. Returns `undefined` when the
 * metric does not apply to this run (e.g. `priceMove` on a window with no market stats, or `operations.<kind>`
 * for a kind this run never counted) — callers (verifier.ts) must treat that as the claim being unresolvable,
 * never as zero.
 */
export function resolveMetric(run: RunResult, metric: MetricKey): MetricInfo | undefined {
  const m = run.metrics
  switch (metric) {
    case 'end':
      return { rawValue: m.end, unit: 'USDC', decimals: 2, label: LABELS.end }
    case 'net':
      return { rawValue: m.net, unit: 'USDC', decimals: 2, label: LABELS.net }
    case 'vsHodl':
      return { rawValue: m.vsHodl, unit: 'USDC', decimals: 2, label: LABELS.vsHodl }
    case 'vsUsdc':
      return { rawValue: m.end - run.deposit, unit: 'USDC', decimals: 2, label: LABELS.vsUsdc }
    case 'fees':
      return { rawValue: m.fees, unit: 'USDC', decimals: 2, label: LABELS.fees }
    case 'gas':
      return { rawValue: m.gas, unit: 'USDC', decimals: 2, label: LABELS.gas }
    case 'priceMove': {
      const pct = marketBtcMovePct(run.window.market)
      return pct === undefined ? undefined : { rawValue: pct, unit: '%', decimals: 1, label: LABELS.priceMove }
    }
    case 'timeInRange':
      return { rawValue: m.timeInRangeBps / 100, unit: '%', decimals: 1, label: LABELS.timeInRange }
    case 'maxDrawdown':
      return { rawValue: m.maxDrawdownBps / 100, unit: '%', decimals: 1, label: LABELS.maxDrawdown }
    case 'return':
      return { rawValue: m.returnBps / 100, unit: '%', decimals: 1, label: LABELS.return }
    case 'days':
      return { rawValue: m.days, unit: 'days', decimals: 0, label: LABELS.days }
    default: {
      if (!metric.startsWith('operations.')) return undefined
      const kind = metric.slice('operations.'.length)
      if (!(kind in m.operations)) return undefined
      return {
        rawValue: m.operations[kind]!,
        unit: 'ops',
        decimals: 0,
        label: { es: `Operaciones: ${kind}`, en: `Operations: ${kind}` },
      }
    }
  }
}

/** AL-21: the display precision a claim is checked against — USDC to 2 decimals, percentages to 1, exact. */
export function displayValue(info: MetricInfo): number {
  return Number(info.rawValue.toFixed(info.decimals))
}

/** AL-21: a claim is correct only when its value equals the display-rounded metric exactly — no tolerance. */
export function claimValueMatches(claimed: number, info: MetricInfo): boolean {
  return claimed === displayValue(info)
}

// ---------------------------------------------------------------------------
// Verdict sentences (AL-20b, AL-20c): written by code, in Spanish; the model only picks runId + against.
// ---------------------------------------------------------------------------

/** `metrics.end`'s rounding is already 4 decimals (B-02); USDC prose rounds to 2, same rule as a claim. */
function fmtUsdc(n: number): string {
  return Math.abs(n).toFixed(2)
}

function directionWord(delta: number): 'arriba' | 'abajo' | 'igual' {
  if (Math.abs(delta) <= 0.01) return 'igual'
  return delta > 0 ? 'arriba' : 'abajo'
}

/** The savings asset a run's base policy settles in — used by AL-20c's comparability check. */
function savingsAssetOf(run: RunResult): string {
  return basePolicyOf(run.spec.base).savingsAsset
}

/**
 * AL-20c: two runs may carry a verdict only when they share window bounds, deposit, savings asset and
 * `simVersion` — they may differ in policy/overrides (that is the point of comparing two strategies). `window.id`
 * stands in for "dataset id": one window is one dataset slice in this manifest format.
 */
export function verdictsComparable(a: RunResult, b: RunResult): boolean {
  return (
    a.window.id === b.window.id &&
    a.window.from === b.window.from &&
    a.window.to === b.window.to &&
    a.deposit === b.deposit &&
    a.simVersion === b.simVersion &&
    savingsAssetOf(a) === savingsAssetOf(b)
  )
}

/**
 * AL-20b: the sentence a verdict block renders. A run vs. its own `hold`/`usdc` baseline is comparable by
 * construction; a run vs. another run throws `LAB_VERDICT_INCOMPARABLE` (AL-20c) when `verdictsComparable` fails
 * — callers that must not throw (verifier.ts) check `verdictsComparable` themselves before calling this.
 */
export function writeVerdictSentence(run: RunResult, against: VerdictAgainst, other?: RunResult): string {
  if (against === 'hold') {
    const delta = run.metrics.vsHodl
    const dir = directionWord(delta)
    if (dir === 'igual') return `Terminó igual que mantener la mezcla (diferencia menor a 0.01 USDC).`
    return `Terminó ${fmtUsdc(delta)} USDC por ${dir === 'arriba' ? 'encima de' : 'debajo de'} mantener la mezcla (hold).`
  }
  if (against === 'usdc') {
    const delta = run.metrics.end - run.deposit
    const dir = directionWord(delta)
    if (dir === 'igual') return `Terminó igual que quedarte en USDC (diferencia menor a 0.01 USDC).`
    return `Terminó ${fmtUsdc(delta)} USDC por ${dir === 'arriba' ? 'encima de' : 'debajo de'} quedarte en USDC.`
  }
  if (!other) throw new ReasonError('LAB_VERDICT_INCOMPARABLE', `verdict against run ${against} needs that run's record`)
  if (!verdictsComparable(run, other)) {
    throw new ReasonError(
      'LAB_VERDICT_INCOMPARABLE',
      `run ${run.resultHash} and ${other.resultHash} differ in window, deposit, savings asset or simVersion`,
    )
  }
  const delta = run.metrics.end - other.metrics.end
  const dir = directionWord(delta)
  if (dir === 'igual') return `Terminó igual que ${other.variantLabel} (diferencia menor a 0.01 USDC).`
  return `Terminó ${fmtUsdc(delta)} USDC por ${dir === 'arriba' ? 'encima de' : 'debajo de'} ${other.variantLabel}.`
}

// ---------------------------------------------------------------------------
// Tool-calling schema for the model's only way to finish: one `submit_answer` call (AL-15, AL-20).
// ---------------------------------------------------------------------------

export const SUBMIT_ANSWER_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'submit_answer',
    description:
      'Deliver the final answer as structured blocks. This is the ONLY way to finish a job — never answer in plain text.',
    parameters: {
      type: 'object',
      properties: {
        blocks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['text', 'claim', 'verdict', 'chart', 'caveat'] },
              md: {
                type: 'string',
                description:
                  'Required for type=text|caveat. Prose, in Spanish. No digits except {{cN}} (the Nth claim block) and {{vN}} (the Nth verdict block) reference tokens, bare 4-digit years, window ids or policy ids.',
              },
              metric: {
                type: 'string',
                description:
                  'Required for type=claim. One of: end, net, vsHodl, vsUsdc, fees, gas, priceMove, timeInRange, maxDrawdown, return, days, or operations.<kind> for a kind that appeared in the cited run.',
              },
              runId: { type: 'string', description: 'Required for type=claim|verdict. A resultHash a tool call produced or fetched this job.' },
              value: { type: 'number', description: 'Required for type=claim. Must equal the run\'s metric, rounded to its display precision, exactly.' },
              against: { type: 'string', description: 'Required for type=verdict. "hold", "usdc", or another runId from this job.' },
              kind: { type: 'string', enum: [...CHART_KINDS], description: 'Required for type=chart.' },
              runIds: { type: 'array', items: { type: 'string' }, description: 'Required for type=chart. Non-empty.' },
              pool: { type: 'string', description: 'Required for type=chart when kind=pool_range.' },
            },
            required: ['type'],
          },
        },
      },
      required: ['blocks'],
      additionalProperties: false,
    },
  },
} as const
