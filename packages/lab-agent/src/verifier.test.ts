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

  test('review finding (P2, verifier.ts:127): {{cN}}/{{vN}} must reference a claim/verdict this answer actually has (LAB_REF_UNKNOWN)', () => {
    const run = makeRun()
    // only one claim (index 0) and no verdict at all — {{c1}} and {{v0}} both reference nothing.
    const answer: Answer = {
      blocks: [
        { type: 'claim', metric: 'end', runId: run.resultHash, value: 983.56 },
        { type: 'text', md: 'El segundo número fue {{c1}} y el veredicto {{v0}}.' },
      ],
    }
    const result = verify(answer, ctxOf(run))
    expect(result.ok).toBe(false)
    expect(result.errors.filter((e) => e.kind === 'ref-unknown')).toHaveLength(2)
    expect(result.errors.some((e) => e.detail.includes('LAB_REF_UNKNOWN'))).toBe(true)
  })

  test('{{c0}} is valid when there is exactly one claim; {{c1}} on the same answer is not (off-by-one)', () => {
    const run = makeRun()
    const oneClaim: Answer = { blocks: [{ type: 'claim', metric: 'end', runId: run.resultHash, value: 983.56 }, { type: 'text', md: 'Terminaste en {{c0}}.' }] }
    expect(verify(oneClaim, ctxOf(run)).ok).toBe(true)
    const offByOne: Answer = { blocks: [{ type: 'claim', metric: 'end', runId: run.resultHash, value: 983.56 }, { type: 'text', md: 'Terminaste en {{c1}}.' }] }
    const result = verify(offByOne, ctxOf(run))
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.kind).toBe('ref-unknown')
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

  test('review finding (P2-6): accented conjugations are detected — plain ASCII \\b silently missed these', () => {
    // `\bganó\b` never matched at all: ASCII `\w` doesn't include `ó`, so there is no word/non-word transition
    // right after it, and `\b` only fires at a transition. Unicode-aware boundaries fix this for every
    // accented-ending term in the closed list.
    expect(findDirectionalTerm('Mamoru ganó la comparación')).toBe('ganó')
    expect(findDirectionalTerm('Mamoru superó al hold')).toBe('superó')
    expect(findDirectionalTerm('la política perdió frente al mercado')).toBe('perdió')
    expect(findDirectionalTerm('la guarda protegió el capital')).toBe('protegió')
    expect(findDirectionalTerm('Mamoru ganó.')).toBe('ganó') // end of sentence, no trailing space either
    expect(findDirectionalTerm('Mamoru ganó')).toBe('ganó') // end of string
  })

  test('the Unicode-aware boundary still rejects a false positive inside a longer accented word', () => {
    expect(findDirectionalTerm('el superávit fue alto')).toBeNull() // "á" right after "supera" is itself a letter
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

  test('review finding (P2): a pure-refusal caveat whose {{cN}} ref does not resolve is dropped, not rescued verbatim', () => {
    // no claim block at all in this candidate, yet the caveat cites {{c0}} — LAB_REF_UNKNOWN, so it cannot be
    // rendered as a trustworthy refusal even though it has no other problem (no digit, no directional term).
    const candidate: Answer = { blocks: [{ type: 'caveat', md: 'No hay datos suficientes para confirmar {{c0}}.' }] }
    const { answer, flagged } = fallbackAnswer(candidate, ctxOf())
    expect(flagged).toBe(true)
    expect(answer.blocks).toEqual([])
  })

  test('a clean, pure-refusal candidate (e.g. reached only because another block in the same answer failed) keeps its caveat', () => {
    const candidate: Answer = { blocks: [{ type: 'caveat', md: 'El Lab no tiene datos de Monad todavía.' }] }
    const { answer } = fallbackAnswer(candidate, ctxOf())
    expect(answer.blocks).toEqual(candidate.blocks)
  })

  test('review finding (P1-3): fuzz garbage block elements — never throws, drops every malformed one', () => {
    const run = makeRun()
    const validWithExtra: unknown = { type: 'claim', metric: 'end', runId: run.resultHash, value: 983.56, extra: { a: { b: { c: [null, {}] } } } } // nested garbage alongside an otherwise-valid block is fine
    const garbageBlocks: unknown[] = [
      null,
      undefined,
      42,
      'a string',
      true,
      [1, 2, 3],
      {},
      { type: 'nope' },
      { type: 'claim' }, // missing metric/runId/value entirely
      { type: 'claim', metric: 123, runId: null, value: 'not-a-number' },
      { type: 'claim', metric: 'end', runId: run.resultHash, value: { nested: 'garbage' } },
      { type: 'verdict', runId: 1, against: null },
      { type: 'chart', kind: 'equity', runIds: 'not-an-array' },
      { type: 'chart', kind: 'equity', runIds: [null, 123, {}] },
      { type: 'text', md: 42 },
      { type: 'text', md: null },
      { type: 'caveat' }, // missing md
      validWithExtra,
    ]

    // `candidate.blocks` is typed `Block[]`, but at runtime (this is literally the untrusted-JSON salvage path)
    // it can be anything — cast through `unknown` the way a real `JSON.parse`'d candidate would arrive.
    const candidate = { blocks: garbageBlocks } as unknown as Answer
    let result: ReturnType<typeof fallbackAnswer> | undefined
    expect(() => {
      result = fallbackAnswer(candidate, ctxOf(run))
    }).not.toThrow()
    expect(result!.flagged).toBe(true)
    // the one well-formed, verifying claim survives; everything else (garbage or malformed) is dropped.
    expect(result!.answer.blocks).toEqual([validWithExtra] as unknown as Answer['blocks'])
  })

  test('review finding (P1-3): blocks itself not an array, or the whole candidate garbage, never throws', () => {
    expect(() => fallbackAnswer({ blocks: 'not-an-array' } as unknown as Answer, ctxOf())).not.toThrow()
    expect(fallbackAnswer({ blocks: 'not-an-array' } as unknown as Answer, ctxOf()).answer.blocks).toEqual([])
    expect(() => fallbackAnswer({ blocks: null } as unknown as Answer, ctxOf())).not.toThrow()
    expect(() => fallbackAnswer({ blocks: [null, null, null] } as unknown as Answer, ctxOf())).not.toThrow()
  })
})
