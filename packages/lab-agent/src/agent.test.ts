// Agent Lab agent (008 task 4, otto/mamoru#200): the agent loop, end to end, offline — RecordedModel scripts
// the model's turns, LabBenchRunner runs real backtests over lab-bench's own tiny fixture dataset (no network,
// no real Lab datasets: CI has neither). One test per required scenario (spec.md "Scenarios"): LAB-AL-01, 02, 03,
// 04, 05, 09, 10, 11, 14, 15, 16 — plus AL-15 (the round cap) and AL-03 (thread history) as their own units.
import { describe, expect, test } from 'bun:test'
import { buildCatalogPrompt } from './catalog.ts'
import { displayValue, resolveMetric, type Answer } from './contract.ts'
import { RecordedModel, submitAnswerCall, toolCall } from './recorded-model.ts'
import { LabBenchRunner } from './tools.ts'
import { renderAnswerForHistory, runAgentJob, type JobContext } from './agent.ts'
import type { ChatMessage, ModelClient, ModelReply, RunResult, ToolSchema } from './types.ts'

const FIXTURE_DIR = `${import.meta.dir}/../../lab-bench/src/__fixtures__`
const runner = new LabBenchRunner(FIXTURE_DIR)
const catalog = buildCatalogPrompt(FIXTURE_DIR)

/**
 * P1-1 regression guard: wraps a `ModelClient` so every `complete()` call first asserts the `messages` it is
 * about to send is well-formed for an OpenAI-compatible API — every tool_call of every earlier assistant
 * message has a matching `role: 'tool'` response, with nothing else in between. `ctxWith` wraps every model in
 * this suite with it, so any test that drives a repair turn or a round-limit/sequence violation doubles as a
 * check that `runAgentJob` never leaves a tool_call unanswered.
 */
class ValidatingModel implements ModelClient {
  constructor(private readonly inner: ModelClient) {}
  async complete(input: { messages: ChatMessage[]; tools: ToolSchema[] }): Promise<ModelReply> {
    assertWellFormedToolCallSequence(input.messages)
    return this.inner.complete(input)
  }
}

function assertWellFormedToolCallSequence(messages: ChatMessage[]): void {
  let pending: Set<string> | null = null
  for (const m of messages) {
    if (pending && pending.size > 0) {
      if (m.role !== 'tool') throw new Error(`malformed history: pending tool_call id(s) [${[...pending].join(', ')}] were never answered before a "${m.role}" message`)
      if (m.tool_call_id) pending.delete(m.tool_call_id)
      continue
    }
    pending = m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 ? new Set(m.tool_calls.map((c) => c.id)) : null
  }
  if (pending && pending.size > 0) throw new Error(`malformed history: pending tool_call id(s) [${[...pending].join(', ')}] were never answered by the end of the sent history`)
}

function ctxWith(model: ModelClient, maxToolRounds?: number): JobContext {
  return { model: new ValidatingModel(model), runner, systemPrompt: catalog.systemPrompt, catalogIds: catalog.catalogIds, maxToolRounds, datasetsDir: FIXTURE_DIR }
}

// Real runs over the fixture, precomputed once — deterministic (AL-16), so the agent's own run_backtest calls
// during a job produce byte-for-byte the same RunResult (same resultHash) as these.
const liveRun = runner.run({ windowId: 'fix-full', base: 'live', widthTicks: 2000, deposit: 1000 })
const guardRun = runner.run({ windowId: 'fix-full', base: 'guard', widthTicks: 2000, deposit: 1000 })
const liveW4000Run = runner.run({ windowId: 'fix-full', base: 'live', widthTicks: 4000, deposit: 1000 })
const liveDeposit5000Run = runner.run({ windowId: 'fix-full', base: 'live', widthTicks: 2000, deposit: 5000 })

function val(r: RunResult, metric: Parameters<typeof resolveMetric>[1]): number {
  return displayValue(resolveMetric(r, metric)!)
}

describe('runAgentJob — required scenarios (spec 008, otto/mamoru#200)', () => {
  test('LAB-AL-01: one run_backtest; claims for end/vsHodl/fees/gas match the run; equity+decomposition charts', async () => {
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000 })] },
      {
        toolCalls: [
          submitAnswerCall([
            { type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') },
            { type: 'claim', metric: 'vsHodl', runId: liveRun.resultHash, value: val(liveRun, 'vsHodl') },
            { type: 'claim', metric: 'fees', runId: liveRun.resultHash, value: val(liveRun, 'fees') },
            { type: 'claim', metric: 'gas', runId: liveRun.resultHash, value: val(liveRun, 'gas') },
            { type: 'verdict', runId: liveRun.resultHash, against: 'hold' },
            { type: 'chart', kind: 'equity', runIds: [liveRun.resultHash] },
            { type: 'chart', kind: 'decomposition', runIds: [liveRun.resultHash] },
            { type: 'text', md: 'Con el depósito simulado en fix-full terminaste con {{c0}}: {{v0}}. Comisiones {{c2}}, gas {{c3}}.' },
          ]),
        ],
      },
    ])
    const result = await runAgentJob({ question: '¿Qué habría pasado con 1000 USDC en la ventana fix-full con la política live?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('ok')
    expect(result.flagged).toBeNull()
    expect(result.toolRounds).toBe(1)
    expect(result.runs).toHaveLength(1)
    expect(result.answer.blocks).toHaveLength(8)
  })

  test('LAB-AL-02: one compare round with 3+ runs, no list_* tool anywhere in the catalog', async () => {
    expect(/\blist_\w+/.test(catalog.systemPrompt)).toBe(false)
    const model = new RecordedModel([
      {
        toolCalls: [
          toolCall('compare', {
            runs: [
              { windowId: 'fix-full', base: 'live', deposit: 1000 },
              { windowId: 'fix-full', base: 'live', deposit: 1000, overrides: { widthTicks: 4000 } },
              { windowId: 'fix-full', base: 'guard', deposit: 1000 },
            ],
          }),
        ],
      },
      {
        toolCalls: [
          submitAnswerCall([
            { type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') },
            { type: 'claim', metric: 'end', runId: liveW4000Run.resultHash, value: val(liveW4000Run, 'end') },
            { type: 'claim', metric: 'end', runId: guardRun.resultHash, value: val(guardRun, 'end') },
            { type: 'verdict', runId: liveRun.resultHash, against: guardRun.resultHash },
            { type: 'chart', kind: 'equity', runIds: [liveRun.resultHash, liveW4000Run.resultHash, guardRun.resultHash] },
          ]),
        ],
      },
    ])
    const result = await runAgentJob({ question: 'Compara ancho 2000, ancho 4000 y guard en fix-full con la política actual.' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('ok')
    expect(result.toolRounds).toBe(1)
    expect(result.runs).toHaveLength(3)
  })

  test('LAB-AL-03: an unknown override key is a tool error reported as a caveat; the agent does not retry', async () => {
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000, overrides: { notAKnob: 1 } })] },
      { toolCalls: [submitAnswerCall([{ type: 'caveat', md: 'La clave de override pedida no existe; no se ejecutó ningún backtest.' }])] },
    ])
    const result = await runAgentJob({ question: '¿Y si pongo notAKnob a 1?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('ok')
    expect(result.toolRounds).toBe(1) // one failed attempt, no retry with an unrelated policy/window
    expect(result.runs).toHaveLength(0)
  })

  test('LAB-AL-04: a future-prediction question gets a caveat-only answer — valid, never emptied', async () => {
    const model = new RecordedModel([
      { toolCalls: [submitAnswerCall([{ type: 'caveat', md: 'No puedo predecir el rendimiento del próximo mes; el backtest solo repite historia ya vivida.' }])] },
    ])
    const result = await runAgentJob({ question: '¿Cuánto rendirá el mes que viene?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('ok')
    expect(result.flagged).toBeNull()
    expect(result.toolRounds).toBe(0)
    expect(result.answer.blocks).toHaveLength(1)
  })

  test('LAB-AL-05: a forged claim fails verification; the repair does not fix it; the render is partial and flagged', async () => {
    const wrongVsHodl = val(liveRun, 'vsHodl') + 50 // not a rounding slip — clearly forged
    const badSubmit = submitAnswerCall([
      { type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') },
      { type: 'claim', metric: 'vsHodl', runId: liveRun.resultHash, value: wrongVsHodl },
    ])
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000 })] },
      { toolCalls: [badSubmit] },
      { toolCalls: [badSubmit] }, // repair turn: the model resubmits the same forged claim, unable to fix it
    ])
    const result = await runAgentJob({ question: '¿Qué habría pasado con 1000 USDC en fix-full?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('partial')
    expect(result.flagged).toBe('LAB_ANSWER_PARTIAL')
    expect(result.meter.repairUsed).toBe(true)
    expect(result.answer.blocks).toEqual([{ type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') }])
  })

  test('LAB-AL-09: the same spec called twice in one job gives the same resultHash', async () => {
    const spec = { windowId: 'fix-full', base: 'live', deposit: 1000 }
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', spec), toolCall('run_backtest', spec)] },
      { toolCalls: [submitAnswerCall([{ type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') }])] },
    ])
    const result = await runAgentJob({ question: 'Corre fix-full dos veces con la misma configuración.' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('ok')
    expect(result.toolRounds).toBe(1) // both calls happened in the same round
    expect(result.runs).toHaveLength(1) // same hash -> one entry in the run store, not two
    expect(result.runs[0]!.resultHash).toBe(liveRun.resultHash)
  })

  test('LAB-AL-10: a Monad question gets a caveat naming the missing data — no run produced', async () => {
    const model = new RecordedModel([{ toolCalls: [submitAnswerCall([{ type: 'caveat', md: 'El Lab todavía no tiene datos históricos de Monad.' }])] }])
    const result = await runAgentJob({ question: '¿Y en Monad?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('ok')
    expect(result.runs).toHaveLength(0)
  })

  test('LAB-AL-11: metrics.gas submitted as "net", and a directional text, are rejected; repair asks for a verdict', async () => {
    const badSubmit = submitAnswerCall([
      { type: 'claim', metric: 'net', runId: liveRun.resultHash, value: val(liveRun, 'gas') }, // wrong metric name
      { type: 'text', md: 'Mamoru gana la comparación.' }, // standalone directional-term text
    ])
    const fixedSubmit = submitAnswerCall([
      { type: 'claim', metric: 'net', runId: liveRun.resultHash, value: val(liveRun, 'net') },
      { type: 'verdict', runId: liveRun.resultHash, against: 'hold' },
    ])
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000 })] },
      { toolCalls: [badSubmit] },
      { toolCalls: [fixedSubmit] },
    ])
    const result = await runAgentJob({ question: '¿Cómo le fue a la política en fix-full?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('repaired')
    expect(result.answer.blocks).toEqual([
      { type: 'claim', metric: 'net', runId: liveRun.resultHash, value: val(liveRun, 'net') },
      { type: 'verdict', runId: liveRun.resultHash, against: 'hold' },
    ])
  })

  test('LAB-AL-14: citing a stored run this job never produced or fetched is rejected, then repaired', async () => {
    const badSubmit = submitAnswerCall([{ type: 'claim', metric: 'end', runId: guardRun.resultHash, value: val(guardRun, 'end') }])
    const fixedSubmit = submitAnswerCall([{ type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') }])
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000 })] }, // only produces liveRun
      { toolCalls: [badSubmit] }, // cites guardRun — this job never ran or fetched it
      { toolCalls: [fixedSubmit] },
    ])
    const result = await runAgentJob({ question: '¿Cuánto terminó?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('repaired')
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]!.resultHash).toBe(liveRun.resultHash)
  })

  test('LAB-AL-15: a verdict between two different-deposit runs is LAB_VERDICT_INCOMPARABLE; repaired against hold', async () => {
    const badSubmit = submitAnswerCall([{ type: 'verdict', runId: liveRun.resultHash, against: liveDeposit5000Run.resultHash }])
    const fixedSubmit = submitAnswerCall([{ type: 'verdict', runId: liveRun.resultHash, against: 'hold' }])
    const model = new RecordedModel([
      {
        toolCalls: [
          toolCall('compare', {
            runs: [
              { windowId: 'fix-full', base: 'live', deposit: 1000 },
              { windowId: 'fix-full', base: 'live', deposit: 5000 },
            ],
          }),
        ],
      },
      { toolCalls: [badSubmit] },
      { toolCalls: [fixedSubmit] },
    ])
    const result = await runAgentJob({ question: '¿Es mejor con 1000 o con 5000 depositados?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('repaired')
    expect(result.answer.blocks).toEqual([{ type: 'verdict', runId: liveRun.resultHash, against: 'hold' }])
  })

  test('LAB-AL-16: run_backtest on a TEST window is LAB_HOLDOUT_DENIED; the catalog never lists it', async () => {
    expect(catalog.windowIds).not.toContain('fix-test')
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-test', base: 'live', deposit: 1000 })] },
      { toolCalls: [submitAnswerCall([{ type: 'caveat', md: 'fix-test es la retención del gate de release; el Lab no la usa.' }])] },
    ])
    const result = await runAgentJob({ question: '¿Y en la ventana fix-test?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('ok')
    expect(result.runs).toHaveLength(0)
  })
})

describe('runAgentJob — loop mechanics (AL-15, AL-03)', () => {
  test('AL-15: a 5th investigative tool call past the round cap is never executed; the model still finishes once it submits', async () => {
    const toolTurn = { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000 })] }
    const model = new RecordedModel([
      toolTurn,
      toolTurn,
      toolTurn,
      toolTurn, // 4 investigative rounds — the cap
      toolTurn, // 5th attempt, after the round-limit notice: must be answered as skipped, never actually run
      { toolCalls: [submitAnswerCall([{ type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') }])] },
    ])
    const result = await runAgentJob({ question: 'sigue probando otra variante' }, ctxWith(model))
    expect(result.toolRounds).toBe(4) // the 5th call never dispatched — only 4 real rounds ran
    expect(result.verifierOutcome).toBe('ok') // the model recovered within the round-limit nudge, no repair needed
    expect(result.meter.repairUsed).toBe(false)
  })

  test('AL-15 + P1-1: a model that never stops calling tools past the cap still gets a well-formed history and eventually falls to repair', async () => {
    const toolTurn = { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000 })] }
    // 4 real rounds + 7 more stubborn attempts (all blocked) exhausts the loop's ceiling (maxRounds + 6 = 10
    // model calls) without ever submitting — rawAnswer stays {blocks: []}, which only the repair turn can fix.
    const model = new RecordedModel([
      toolTurn,
      toolTurn,
      toolTurn,
      toolTurn,
      toolTurn,
      toolTurn,
      toolTurn,
      toolTurn,
      toolTurn,
      toolTurn, // 10th and last model call the loop allows itself — still just a tool call, never submit_answer
      { toolCalls: [submitAnswerCall([{ type: 'caveat', md: 'Se alcanzó el límite de rondas sin una respuesta final.' }])] }, // the repair turn
    ])
    const result = await runAgentJob({ question: 'sigue, sigue, sigue' }, ctxWith(model))
    expect(result.toolRounds).toBe(4)
    expect(result.verifierOutcome).toBe('repaired')
    expect(result.meter.repairUsed).toBe(true)
  })

  test('P2-5: after a tool error in a round, the rest of that round is skipped and the next turn must be submit_answer', async () => {
    const model = new RecordedModel([
      // one round, two calls: the first fails (unknown override), so the second must never execute.
      {
        toolCalls: [
          toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000, overrides: { notAKnob: 1 } }),
          toolCall('run_backtest', { windowId: 'fix-full', base: 'guard', deposit: 1000 }),
        ],
      },
      // violates the "must submit next" rule: tries another investigative call instead — must be refused and
      // burn a round, never actually run.
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000 })] },
      { toolCalls: [submitAnswerCall([{ type: 'caveat', md: 'La clave de override pedida no existe; no se ejecutó ningún backtest.' }])] },
    ])
    const result = await runAgentJob({ question: '¿Y con notAKnob?' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('ok')
    expect(result.runs).toHaveLength(0) // neither the skipped sibling call nor the sequence-violating retry ever ran
    expect(result.toolRounds).toBe(2) // the failed round, plus the sequence-violation attempt (counted, not run)
  })

  test('LAB-AL-07 (sweep, now real): a sweep over the TRAIN windows returns a per-row table; naming a TEST window is LAB_HOLDOUT_DENIED before any run', async () => {
    const model = new RecordedModel([
      { toolCalls: [toolCall('sweep', { base: 'live', widthTicks: [2000, 4000], deposit: 1000 })] },
      {
        toolCalls: [
          submitAnswerCall([
            { type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') },
            { type: 'claim', metric: 'end', runId: liveW4000Run.resultHash, value: val(liveW4000Run, 'end') },
          ]),
        ],
      },
    ])
    const result = await runAgentJob({ question: 'Haz un sweep de ancho 2000 y 4000 en live.' }, ctxWith(model))
    expect(result.verifierOutcome).toBe('ok')
    expect(result.toolRounds).toBe(1)
    expect(result.runs).toHaveLength(2)

    const testWindowModel = new RecordedModel([
      { toolCalls: [toolCall('sweep', { base: 'live', widthTicks: [2000], deposit: 1000, windows: ['fix-test'] })] },
      { toolCalls: [submitAnswerCall([{ type: 'caveat', md: 'fix-test es la retención del gate de release; el Lab no la usa.' }])] },
    ])
    const testWindowResult = await runAgentJob({ question: '¿Y en fix-test?' }, ctxWith(testWindowModel))
    expect(testWindowResult.verifierOutcome).toBe('ok')
    expect(testWindowResult.runs).toHaveLength(0)
  })

  test('AL-03: a follow-up turn carries the prior verified answer as context; citing its run again needs a fresh fetch', async () => {
    const priorAnswer: Answer = { blocks: [{ type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') }] }
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000, overrides: { widthTicks: 4000 } })] },
      { toolCalls: [submitAnswerCall([{ type: 'claim', metric: 'end', runId: liveW4000Run.resultHash, value: val(liveW4000Run, 'end') }])] },
    ])
    const result = await runAgentJob(
      {
        question: '¿Y con el doble de ancho?',
        priorTurns: [{ question: '¿Qué habría pasado con 1000 USDC en fix-full?', answer: priorAnswer, runs: [liveRun] }],
      },
      ctxWith(model),
    )
    expect(result.verifierOutcome).toBe('ok')
    // a new job's run list starts empty — the prior turn's run is context, not automatically citable here too.
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]!.resultHash).toBe(liveW4000Run.resultHash)
  })

  test('renderAnswerForHistory turns a verified answer into plain prose, resolving {{cN}}/{{vN}} refs', () => {
    const answer: Answer = {
      blocks: [
        { type: 'claim', metric: 'end', runId: liveRun.resultHash, value: val(liveRun, 'end') },
        { type: 'verdict', runId: liveRun.resultHash, against: 'hold' },
        { type: 'text', md: 'Terminaste con {{c0}}: {{v0}}' },
      ],
    }
    const text = renderAnswerForHistory(answer, [liveRun])
    expect(text).toContain(String(val(liveRun, 'end')))
    expect(text).toContain('mantener la mezcla')
  })
})
