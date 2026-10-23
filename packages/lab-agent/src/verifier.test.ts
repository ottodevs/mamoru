import { describe, expect, test } from 'bun:test'
import type { Answer } from './contract.ts'
import type { RunResult } from './types.ts'
import { fallbackAnswer, findDirectionalTerm, findUntraceableDigits, buildAllowedTokenRegex, validateAnswerSchema, verify, type VerifyContext } from './verifier.ts'

function makeRun(over: Partial<RunResult> = {}): RunResult {
  return {
    specKey: 'fix-full|live|2000|1000',
    spec: { windowId: 'fix-full', base: 'live', widthTicks: 2000, deposit: 1000 },
    variantLabel: 'Política actual',
    policyId: 'conservador-live-v2',
    resultHash: '0xaaa',
    simVersion: 'backtest-1',
    window: { id: 'fix-full', label: 'fixture', regime: 'calm', split: 'train', from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z', market: { note: 'fixture' } },
    deposit: 1000,
    pools: ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'],
    metrics: { days: 7, end: 983.56, net: -16.44, hodl: 999.9996, vsHodl: -16.44, fees: 12.3, gas: 1.08, timeInRangeBps: 9821, maxDrawdownBps: 412, returnBps: -164, operations: { enter_swap: 3, enter_mint: 3, harvest: 2, rerange: 0 } },
    reasons: {},
    ops: [],
    series: [],
    ...over,
  }
}

function ctxOf(...runs: RunResult[]): VerifyContext {
  const runStore = new Map(runs.map((r) => [r.resultHash, r]))
  return { runStore, catalogIds: ['fix-full', 'fix-nobtc', 'conservador-live-v2', 'conservador-lab-guards-v1'] }
}

describe('validateAnswerSchema', () => {
  test('a well-formed answer has no schema errors', () => {
    const answer: Answer = { blocks: [{ type: 'claim', metric: 'end', runId: '0xaaa', value: 983.56 }] }
    expect(validateAnswerSchema(answer)).toEqual([])
  })

  test('empty blocks, a non-object answer, and an unknown block type are all schema errors', () => {
    expect(validateAnswerSchema({ blocks: [] })[0]?.kind).toBe('schema')
    expect(validateAnswerSchema(null)[0]?.kind).toBe('schema')
    expect(validateAnswerSchema({ blocks: [{ type: 'nope' }] })[0]?.kind).toBe('schema')
  })
})

describe('verify (AL-21)', () => {
  test('a caveat-only refusal with no digits passes clean — never emptied, never needs a claim', () => {
    const answer: Answer = { blocks: [{ type: 'caveat', md: 'El Lab no predice precios futuros, solo repite historia.' }] }
    const result = verify(answer, ctxOf())
    expect(result.ok).toBe(true)
  })

  test('LAB-AL-14 shape: a claim citing a run this job never produced or fetched is rejected', () => {
    const run = makeRun()
    const answer: Answer = { blocks: [{ type: 'claim', metric: 'end', runId: '0xnever-fetched', value: 983.56 }] }
    const result = verify(answer, ctxOf(run)) // run store has 0xaaa, not 0xnever-fetched
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.kind).toBe('claim-unknown-run')
  })

  test('LAB-AL-11 shape: metrics.gas submitted under metric "net" is a claim-mismatch, not silently accepted', () => {
    const run = makeRun()
    const answer: Answer = { blocks: [{ type: 'claim', metric: 'net', runId: run.resultHash, value: run.metrics.gas }] }
    const result = verify(answer, ctxOf(run))
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.kind).toBe('claim-mismatch')
  })

  test('LAB-AL-11 shape: a text block saying "Mamoru gana" is rejected for a directional term, asked for a verdict instead', () => {
    const answer: Answer = { blocks: [{ type: 'text', md: 'Mamoru gana la comparación.' }] }
    const result = verify(answer, ctxOf())
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.kind === 'directional-term')).toBe(true)
  })

  test('LAB-AL-15 shape: a verdict between two incomparable runs is LAB_VERDICT_INCOMPARABLE', () => {
    const a = makeRun({ resultHash: '0xa', deposit: 1000 })
    const bigger = makeRun({ resultHash: '0xb', deposit: 5000 })
    const answer: Answer = { blocks: [{ type: 'verdict', runId: a.resultHash, against: bigger.resultHash }] }
    const result = verify(answer, ctxOf(a, bigger))
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.kind).toBe('verdict-incomparable')
  })

  test('a verdict against "hold"/"usdc" is always comparable (its own baseline, by construction)', () => {
    const run = makeRun()
    const answer: Answer = { blocks: [{ type: 'verdict', runId: run.resultHash, against: 'hold' }] }
    expect(verify(answer, ctxOf(run)).ok).toBe(true)
  })

  test('a chart citing an unknown run, or a pool_range chart whose pool is not in the run, fails', () => {
    const run = makeRun()
    expect(verify({ blocks: [{ type: 'chart', kind: 'equity', runIds: ['0xghost'] }] }, ctxOf(run)).errors[0]?.kind).toBe('chart-unknown-run')
    expect(verify({ blocks: [{ type: 'chart', kind: 'pool_range', runIds: [run.resultHash], pool: 'pool:NOPE/USDC/100' }] }, ctxOf(run)).errors[0]?.kind).toBe('chart-kind-mismatch')
    expect(verify({ blocks: [{ type: 'chart', kind: 'pool_range', runIds: [run.resultHash], pool: 'pool:USDC/USDT/100' }] }, ctxOf(run)).ok).toBe(true)
  })

  test('a bare digit in text with no {{cN}}/{{vN}} reference or known id/year is untraceable', () => {
    const answer: Answer = { blocks: [{ type: 'text', md: 'El retorno fue -3.33%.' }] }
    expect(verify(answer, ctxOf()).errors[0]?.kind).toBe('untraceable-digit')
  })

  test('{{c0}}/{{v0}} references, 4-digit years and catalog ids are allowed digits in text', () => {
    const run = makeRun()
    const answer: Answer = {
      blocks: [
        { type: 'claim', metric: 'end', runId: run.resultHash, value: 983.56 },
        { type: 'verdict', runId: run.resultHash, against: 'hold' },
        { type: 'text', md: 'En 2025, sobre fix-full con conservador-live-v2, terminaste en {{c0}}: {{v0}}' },
      ],
    }
    expect(verify(answer, ctxOf(run)).ok).toBe(true)
  })
})

describe('buildAllowedTokenRegex / findUntraceableDigits / findDirectionalTerm', () => {
  test('the longest catalog id wins over a shorter one it contains', () => {
    const re = buildAllowedTokenRegex(['2026-04', '2026'])
    expect(findUntraceableDigits('calma de 2026-04 aquí', re)).toBe(false)
  })

  test('findDirectionalTerm matches the closed es/en list, case-insensitively', () => {
    expect(findDirectionalTerm('Mamoru supera al hold')).toBe('supera')
    expect(findDirectionalTerm('Mamoru OUTPERFORMS hold')).toBe('OUTPERFORMS')
    expect(findDirectionalTerm('el resultado total fue positivo')).toBeNull()
  })
})

describe('fallbackAnswer (AL-22)', () => {
  test('keeps claims and charts that still verify, drops the rest, and flags the result', () => {
    const run = makeRun()
    const candidate: Answer = {
      blocks: [
        { type: 'claim', metric: 'end', runId: run.resultHash, value: 983.56 }, // correct
        { type: 'claim', metric: 'vsHodl', runId: run.resultHash, value: 999 }, // forged (LAB-AL-05 shape)
        { type: 'text', md: 'Mamoru gana.' }, // directional term, dropped too
      ],
    }
    const { answer, flagged } = fallbackAnswer(candidate, ctxOf(run))
    expect(flagged).toBe(true)
    expect(answer.blocks).toEqual([{ type: 'claim', metric: 'end', runId: run.resultHash, value: 983.56 }])
  })

  test('a pure refusal (no claim/verdict at all) with a bad digit in its caveat is NOT emptied — the probe bug this fixes', () => {
    const candidate: Answer = { blocks: [{ type: 'caveat', md: 'No se puede responder: el dato 42 no existe en ningún catálogo.' }] }
    const { answer, flagged } = fallbackAnswer(candidate, ctxOf())
    expect(flagged).toBe(true)
    // the caveat itself still has an untraceable digit, so it cannot be rescued verbatim either — but a
    // refusal WITH a clean caveat must survive (this is the shape LAB-AL-04/LAB-AL-10 exercise end to end):
    expect(answer.blocks).toEqual([])
  })

  test('a clean, pure-refusal candidate (e.g. reached only because another block in the same answer failed) keeps its caveat', () => {
    const candidate: Answer = { blocks: [{ type: 'caveat', md: 'El Lab no tiene datos de Monad todavía.' }] }
    const { answer } = fallbackAnswer(candidate, ctxOf())
    expect(answer.blocks).toEqual(candidate.blocks)
  })
})
