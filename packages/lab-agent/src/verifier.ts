// Agent Lab agent (008 task 4, otto/mamoru#200): the deterministic verifier (AL-21, AL-21b) and the AL-22
// partial-render fallback. No LLM judge anywhere in this file — every check is schema, a stored run lookup, or a
// closed word list.
import {
  claimValueMatches,
  isChartKind,
  isMetricKey,
  isProseBlock,
  isVerdictBaseline,
  isVerifiedBlock,
  resolveMetric,
  verdictsComparable,
  type Answer,
  type Block,
  type CaveatBlock,
  type ChartBlock,
  type ClaimBlock,
  type TextBlock,
  type VerdictBlock,
} from './contract.ts'
import type { RunResult } from './types.ts'

export type VerifyErrorKind =
  | 'schema'
  | 'claim-unknown-run'
  | 'claim-bad-metric'
  | 'claim-mismatch'
  | 'verdict-unknown-run'
  | 'verdict-incomparable'
  | 'chart-unknown-run'
  | 'chart-kind-mismatch'
  | 'untraceable-digit'
  | 'directional-term'
  | 'ref-unknown'

export type VerifyError = { kind: VerifyErrorKind; blockIndex: number | null; detail: string }
export type VerifyResult = { ok: boolean; errors: VerifyError[] }

export type VerifyContext = {
  /** The job's own citable run list (AL-21): runs this job's tool calls produced or re-fetched. */
  runStore: ReadonlyMap<string, RunResult>
  /** Dataset/window/policy ids allowed as literal digits in prose (the untraceable-digit check). */
  catalogIds: string[]
}

// ---------------------------------------------------------------------------
// Schema (structural shape only; AL-20's TS type is what this checks against at runtime)
// ---------------------------------------------------------------------------

/**
 * Every field-shape check for one block, shared by `validateAnswerSchema` (the whole-answer schema gate) and
 * `fallbackAnswer` (AL-22's per-block salvage, which must never assume a block it is about to inspect — e.g.
 * read `.type` off, or hand to `claimErrors`/`chartErrors`/`proseErrors` — is actually well-formed: the very
 * candidate it is salvaging from is often the one that just failed this exact check). A block that passes this
 * with zero errors is safe to treat as its `Block` union member: every field `claimErrors`/`verdictErrors`/
 * `chartErrors`/`proseErrors` read is guaranteed the right primitive type, so none of them can throw.
 */
function blockShapeErrors(b: unknown, blockIndex: number | null): VerifyError[] {
  const errors: VerifyError[] = []
  const push = (detail: string): void => {
    errors.push({ kind: 'schema', blockIndex, detail })
  }
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    push('block is not an object')
    return errors
  }
  const blk = b as Record<string, unknown>
  switch (blk.type) {
    case 'text':
    case 'caveat':
      if (typeof blk.md !== 'string' || blk.md.trim() === '') push(`${blk.type} block missing non-empty "md"`)
      break
    case 'claim':
      if (!isMetricKey(blk.metric)) push(`claim block "metric" is invalid: ${JSON.stringify(blk.metric)}`)
      if (typeof blk.runId !== 'string' || blk.runId.trim() === '') push('claim block missing "runId"')
      if (typeof blk.value !== 'number' || !Number.isFinite(blk.value)) push('claim block "value" is not a finite number')
      break
    case 'verdict':
      if (typeof blk.runId !== 'string' || blk.runId.trim() === '') push('verdict block missing "runId"')
      if (typeof blk.against !== 'string' || blk.against.trim() === '') push('verdict block missing "against"')
      break
    case 'chart':
      if (!isChartKind(blk.kind)) push(`chart block "kind" is invalid: ${JSON.stringify(blk.kind)}`)
      if (!Array.isArray(blk.runIds) || blk.runIds.length === 0 || !blk.runIds.every((r) => typeof r === 'string'))
        push('chart block "runIds" must be a non-empty string array')
      if (blk.pool !== undefined && typeof blk.pool !== 'string') push('chart block "pool" must be a string if present')
      break
    default:
      push(`unknown block "type": ${JSON.stringify(blk.type)}`)
  }
  return errors
}

export function validateAnswerSchema(answerRaw: unknown): VerifyError[] {
  const errors: VerifyError[] = []
  const push = (blockIndex: number | null, detail: string): void => {
    errors.push({ kind: 'schema', blockIndex, detail })
  }

  if (typeof answerRaw !== 'object' || answerRaw === null) {
    push(null, 'answer is not an object')
    return errors
  }
  const a = answerRaw as Record<string, unknown>
  if (!Array.isArray(a.blocks)) {
    push(null, '"blocks" is missing or not an array')
    return errors
  }
  if (a.blocks.length === 0) push(null, '"blocks" is empty')

  a.blocks.forEach((b: unknown, i: number) => errors.push(...blockShapeErrors(b, i)))
  return errors
}

// ---------------------------------------------------------------------------
// Untraceable-digit guard (AL-21) and directional-term guard (AL-21b)
// ---------------------------------------------------------------------------

/** `{{c0}}`/`{{v0}}` reference tokens, bare 4-digit years, and catalog (window/policy) ids are allowed digits. */
export function buildAllowedTokenRegex(catalogIds: string[]): RegExp {
  const ids = catalogIds
    .filter(Boolean)
    .sort((a, b) => b.length - a.length) // longest-first: a longer id wins over a shorter one it contains
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // Longer/more-specific alternatives first: regex alternation picks the first one that matches at a position,
  // not the longest, so a catalog id like "calm-2026-04" must be tried before the bare 4-digit-year pattern or
  // the year alone would match its "2026" prefix and strand the rest ("-04") as untraceable digits.
  const alts = [...ids, '\\{\\{c\\d+\\}\\}', '\\{\\{v\\d+\\}\\}', '\\b(19|20)\\d{2}\\b']
  return new RegExp(alts.join('|'), 'g')
}

export function findUntraceableDigits(md: string, allowedTokenRegex: RegExp): boolean {
  const stripped = md.replace(allowedTokenRegex, '')
  return /\d/.test(stripped)
}

/**
 * AL-21b's closed list, es/en (the spec's own examples, plus the most common conjugations). Deliberately
 * incomplete — AL-21a (verdicts rendered apart from prose), not this list, is what actually keeps an unverified
 * conclusion from reading as checked; this is a second, cheap guard that only needs to catch common phrasing.
 */
const DIRECTIONAL_TERMS = [
  'better',
  'worse',
  'beats',
  'beat',
  'loses',
  'lost',
  'gains',
  'gained',
  'outperforms',
  'outperformed',
  'protects',
  'protected',
  'mejor',
  'peor',
  'gana',
  'ganamos',
  'ganaron',
  'ganó',
  'gané',
  'gane',
  'pierde',
  'perdió',
  'perdieron',
  'perdemos',
  'supera',
  'superó',
  'superaron',
  'superamos',
  'protege',
  'protegió',
  'protegieron',
  'protegimos',
] as const

/**
 * Plain `\b` is ASCII-only: `\w` = `[A-Za-z0-9_]`, so it does not treat an accented letter as a "word"
 * character. That makes `\bganó\b` fail to match "ganó" at all when it is followed by a space or the end of a
 * sentence — the `ó` isn't \w, so there is no word/non-word *transition* right after it, and `\b` only matches
 * at a transition (review finding: Spanish conjugations like "ganó"/"superó"/"perdió"/"protegió" were silently
 * never detected). `(?<![\p{L}\p{N}])`/`(?![\p{L}\p{N}])` are Unicode-letter/number-aware boundaries instead —
 * they also correctly still reject matching "supera" as a false positive inside "superávit", since the `á`
 * right after it IS `\p{L}`.
 */
const DIRECTIONAL_TERM_REGEX = new RegExp(
  `(?<![\\p{L}\\p{N}])(${DIRECTIONAL_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
)

export function findDirectionalTerm(md: string): string | null {
  return DIRECTIONAL_TERM_REGEX.exec(md)?.[0] ?? null
}

// ---------------------------------------------------------------------------
// Per-block checks, shared between verify() and the AL-22 fallback
// ---------------------------------------------------------------------------

function claimErrors(block: ClaimBlock, blockIndex: number | null, ctx: VerifyContext): VerifyError[] {
  const run = ctx.runStore.get(block.runId)
  if (!run) return [{ kind: 'claim-unknown-run', blockIndex, detail: `runId "${block.runId}" is not in this job's run list` }]
  const info = resolveMetric(run, block.metric)
  if (!info) return [{ kind: 'claim-bad-metric', blockIndex, detail: `metric "${block.metric}" does not resolve on run ${block.runId}` }]
  if (!claimValueMatches(block.value, info)) {
    return [{ kind: 'claim-mismatch', blockIndex, detail: `claimed ${block.value} != ${info.rawValue.toFixed(info.decimals)} for ${block.metric} on ${block.runId}` }]
  }
  return []
}

function verdictErrors(block: VerdictBlock, blockIndex: number | null, ctx: VerifyContext): VerifyError[] {
  const run = ctx.runStore.get(block.runId)
  if (!run) return [{ kind: 'verdict-unknown-run', blockIndex, detail: `runId "${block.runId}" is not in this job's run list` }]
  if (isVerdictBaseline(block.against)) return [] // comparable by construction (run vs. its own hold/usdc baseline)
  const other = ctx.runStore.get(block.against)
  if (!other) return [{ kind: 'verdict-unknown-run', blockIndex, detail: `against-runId "${block.against}" is not in this job's run list` }]
  if (!verdictsComparable(run, other)) {
    return [{ kind: 'verdict-incomparable', blockIndex, detail: `${block.runId} and ${block.against} differ in window, deposit, savings asset or simVersion` }]
  }
  return []
}

function chartErrors(block: ChartBlock, blockIndex: number | null, ctx: VerifyContext): VerifyError[] {
  const errors: VerifyError[] = []
  const runs: RunResult[] = []
  for (const rid of block.runIds) {
    const r = ctx.runStore.get(rid)
    if (!r) errors.push({ kind: 'chart-unknown-run', blockIndex, detail: `chart runId "${rid}" is not in this job's run list` })
    else runs.push(r)
  }
  if (errors.length > 0) return errors
  if (block.kind === 'pool_range') {
    if (!block.pool) errors.push({ kind: 'chart-kind-mismatch', blockIndex, detail: 'pool_range chart needs "pool"' })
    else {
      for (const r of runs) {
        if (!r.pools.includes(block.pool)) errors.push({ kind: 'chart-kind-mismatch', blockIndex, detail: `run ${r.resultHash} has no pool "${block.pool}"` })
      }
    }
  }
  return errors
}

/**
 * `{{cN}}`/`{{vN}}` are only ever a reference to the Nth claim/verdict block of THIS answer (0-based, in
 * document order — AL-20's own convention). The untraceable-digit check only checks that the *pattern*
 * `{{c\d+}}` is well-formed; it was never checking that claim/verdict `N` actually exists (review finding,
 * P2/verifier.ts:127) — a text block could cite `{{c5}}` with only two claim blocks and pass clean.
 */
function refIndexErrors(block: TextBlock | CaveatBlock, blockIndex: number | null, claimCount: number, verdictCount: number): VerifyError[] {
  const errors: VerifyError[] = []
  for (const m of block.md.matchAll(/\{\{c(\d+)\}\}/g)) {
    const n = Number(m[1])
    if (n >= claimCount) errors.push({ kind: 'ref-unknown', blockIndex, detail: `LAB_REF_UNKNOWN: {{c${n}}} references claim ${n}, but this answer has ${claimCount} claim block(s)` })
  }
  for (const m of block.md.matchAll(/\{\{v(\d+)\}\}/g)) {
    const n = Number(m[1])
    if (n >= verdictCount) errors.push({ kind: 'ref-unknown', blockIndex, detail: `LAB_REF_UNKNOWN: {{v${n}}} references verdict ${n}, but this answer has ${verdictCount} verdict block(s)` })
  }
  return errors
}

function proseErrors(block: TextBlock | CaveatBlock, blockIndex: number | null, allowedTokenRegex: RegExp, claimCount: number, verdictCount: number): VerifyError[] {
  const errors: VerifyError[] = []
  if (findUntraceableDigits(block.md, allowedTokenRegex)) {
    errors.push({ kind: 'untraceable-digit', blockIndex, detail: `"${block.type}" block has a digit not covered by a {{cN}}/{{vN}} reference or a known id/year` })
  }
  const term = findDirectionalTerm(block.md)
  if (term) errors.push({ kind: 'directional-term', blockIndex, detail: `"${block.type}" block uses performance-judgement term "${term}"; use a verdict block instead` })
  errors.push(...refIndexErrors(block, blockIndex, claimCount, verdictCount))
  return errors
}

function blockErrors(block: Block, blockIndex: number | null, ctx: VerifyContext, allowedTokenRegex: RegExp, claimCount: number, verdictCount: number): VerifyError[] {
  if (block.type === 'claim') return claimErrors(block, blockIndex, ctx)
  if (block.type === 'verdict') return verdictErrors(block, blockIndex, ctx)
  if (block.type === 'chart') return chartErrors(block, blockIndex, ctx)
  return proseErrors(block, blockIndex, allowedTokenRegex, claimCount, verdictCount)
}

// ---------------------------------------------------------------------------
// verify() (AL-21)
// ---------------------------------------------------------------------------

export function verify(answerRaw: unknown, ctx: VerifyContext): VerifyResult {
  const schemaErrors = validateAnswerSchema(answerRaw)
  if (schemaErrors.length > 0) return { ok: false, errors: schemaErrors }

  const answer = answerRaw as Answer
  const allowedTokenRegex = buildAllowedTokenRegex(ctx.catalogIds)
  const claimCount = answer.blocks.filter((b) => b.type === 'claim').length
  const verdictCount = answer.blocks.filter((b) => b.type === 'verdict').length
  const errors = answer.blocks.flatMap((block, i) => blockErrors(block, i, ctx, allowedTokenRegex, claimCount, verdictCount))
  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// AL-22 fallback: on a failed repair, keep verified claims/charts; a pure refusal (no claim/verdict blocks at
// all) keeps its caveat/text instead of being emptied — the bug the probe (poc-chat-2026-10-20) hit.
// ---------------------------------------------------------------------------

export type FallbackResult = { answer: Answer; flagged: boolean }

export function fallbackAnswer(candidate: Answer, ctx: VerifyContext): FallbackResult {
  if (!Array.isArray(candidate.blocks)) return { answer: { blocks: [] }, flagged: true } // defensive: see below

  const allowedTokenRegex = buildAllowedTokenRegex(ctx.catalogIds)

  // `candidate` is the very answer that may have just failed validateAnswerSchema (this IS the salvage path for
  // that failure) — its blocks are untrusted JSON, not a trusted `Block[]`. A raw element can be `null`, a
  // number, a string, or a `{type: 'claim', ...}` with garbage field types; none of that is safe to hand to
  // `isVerifiedBlock`/`isProseBlock`/`claimErrors`/`chartErrors`/`proseErrors`, which all assume well-typed
  // fields. Filter to only the blocks that pass the exact same per-block shape check `validateAnswerSchema`
  // uses — every one of those is now guaranteed safe — and drop anything else outright (review finding:
  // `{"blocks":[null]}` used to throw here).
  const blocks = candidate.blocks.filter((b): b is Block => blockShapeErrors(b, null).length === 0)
  const hadVerifiedKind = blocks.some(isVerifiedBlock)
  // {{cN}}/{{vN}} numbering is fixed by the model's own (shape-valid) blocks array, independent of which of
  // those blocks individually survive the checks below.
  const claimCount = blocks.filter((b) => b.type === 'claim').length
  const verdictCount = blocks.filter((b) => b.type === 'verdict').length

  const keptResults = blocks.filter((b) => {
    if (b.type === 'claim') return claimErrors(b, null, ctx).length === 0
    if (b.type === 'chart') return chartErrors(b, null, ctx).length === 0
    return false
  })
  if (keptResults.length > 0) return { answer: { blocks: keptResults }, flagged: true }

  if (!hadVerifiedKind) {
    // A caveat/text block whose {{cN}}/{{vN}} reference doesn't resolve is dropped here too (review finding) —
    // a refusal that cites a claim it never made is not a safe thing to render as "verified" prose either.
    const keptProse = blocks.filter((b) => isProseBlock(b) && proseErrors(b, null, allowedTokenRegex, claimCount, verdictCount).length === 0)
    if (keptProse.length > 0) return { answer: { blocks: keptProse }, flagged: true }
  }
  return { answer: { blocks: [] }, flagged: true }
}
