// Agent Lab agent (008 task 4, otto/mamoru#200): the agent loop (AL-15, AL-22) — up to 4 investigative tool
// rounds, a forced final round, `submit_answer` as the only way to finish, one repair turn on a failed check,
// and the AL-22 partial-render fallback when the repair also fails. Pure and offline: `ModelClient` and
// `BenchRunner` are both injected (task 5 wires the real model-plane route and `LabBenchRunner`).
import {
  displayValue,
  isVerdictBaseline,
  resolveMetric,
  SUBMIT_ANSWER_TOOL_SCHEMA,
  writeVerdictSentence,
  type Answer,
  type Block,
  type ChartBlock,
  type ClaimBlock,
  type VerdictBlock,
} from './contract.ts'
import { newCostMeter, recordModelCall, recordToolRound, type CostMeter, type VerifierOutcome as MeterVerifierOutcome } from './cost-meter.ts'
import { AGENT_TOOL_SCHEMAS, compareTool, LAB_TOOL_UNAVAILABLE, runBacktestTool, sweepTool, type RunStore, type ToolOutcome } from './tools.ts'
import { fallbackAnswer, verify } from './verifier.ts'
import type { BenchRunner, ChatMessage, ModelClient, RunResult, ToolSchema } from './types.ts'

/** AL-15: max 4 tool rounds per job; then the agent must answer with what it has. */
export const MAX_TOOL_ROUNDS = 4

export type PriorTurn = { question: string; answer: Answer; runs: RunResult[] }

export type JobInput = {
  question: string
  /** AL-03: the thread's earlier turns — questions and verified answers, never raw tool output. */
  priorTurns?: PriorTurn[]
}

export type JobContext = {
  model: ModelClient
  runner: BenchRunner
  /** AL-14: built once per job by `buildCatalogPrompt` (catalog.ts) and passed in here. */
  systemPrompt: string
  catalogIds: string[]
  maxToolRounds?: number
  /** Only `sweep` needs this (it resolves a TRAIN window list independent of `runner`) — pass the same value given to `buildCatalogPrompt`/`LabBenchRunner`. Omit for the real datasets dir. */
  datasetsDir?: string
}

export type VerifierOutcome = MeterVerifierOutcome

export type JobResult = {
  answer: Answer
  verifierOutcome: VerifierOutcome
  flagged: 'LAB_ANSWER_PARTIAL' | null
  /** AL-21: this job's own citable run list — every run a tool call produced, in production order. */
  runs: RunResult[]
  toolRounds: number
  meter: CostMeter
  /**
   * The full conversation this job sent/received, in order — useful for logging (task 5/6), and lets a caller
   * (or a test) check the truly final state for well-formedness. A `ModelClient` wrapper that only validates
   * what it is handed at each `complete()` call can never see what happens to the LAST reply once the loop
   * returns without calling `complete()` again (e.g. a clean first-pass success) — this field closes that gap.
   */
  messages: ChatMessage[]
}

function safeJsonParse(s: string | null | undefined): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function isAnswerShaped(x: unknown): x is Answer {
  return typeof x === 'object' && x !== null && Array.isArray((x as Record<string, unknown>).blocks)
}

/** Tool-local protocol codes (never a `ReasonError`, never added to the domain's closed `ReasonCode` enum) for a tool_call this loop refuses to execute — always still answered (P1-1), never silently dropped. */
export const LAB_TOOL_SKIPPED = 'LAB_TOOL_SKIPPED'
export const LAB_TOOL_SEQUENCE = 'LAB_TOOL_SEQUENCE'
export const LAB_TOOL_IGNORED = 'LAB_TOOL_IGNORED'

function dispatchTool(name: string, args: unknown, runner: BenchRunner, runStore: RunStore, meter: CostMeter, datasetsDir: string | undefined): ToolOutcome<unknown> {
  if (name === 'run_backtest') return runBacktestTool(args, runner, runStore, meter)
  if (name === 'compare') return compareTool(args, runner, runStore, meter)
  if (name === 'sweep') return sweepTool(args, runner, runStore, meter, datasetsDir)
  return { ok: false, error: { code: LAB_TOOL_UNAVAILABLE, message: `unknown tool "${name}"` } }
}

function skipMessage(call: { id: string; function: { name: string } }, code: string, message: string): ChatMessage {
  return { role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify({ error: { code, message } }) }
}

// ---------------------------------------------------------------------------
// AL-03: rendering a prior, already-verified answer back into the conversation as plain assistant content — the
// model can read it for a follow-up, but cannot cite its runs in a new claim without re-fetching them this job.
// ---------------------------------------------------------------------------

function runsMapOf(runs: RunResult[]): RunStore {
  const m: RunStore = new Map()
  for (const r of runs) m.set(r.resultHash, r)
  return m
}

/**
 * Review finding (P2, agent.ts:127): the old rendering kept only a claim's label/value, losing which run (and
 * which spec) produced it — a follow-up like "double that width" has nothing to resolve "that" against.
 * `run.specKey` is already `windowId|base|widthTicks|deposit` (lab-bench's own `specKey()`), so this tag alone
 * is enough for the model to reconstruct the spec it should vary.
 */
function runTag(run: RunResult): string {
  return `(run ${run.resultHash}, spec ${run.specKey})`
}

function renderVerdictText(block: VerdictBlock, runStore: RunStore): string {
  const run = runStore.get(block.runId)
  if (!run) return ''
  if (isVerdictBaseline(block.against)) {
    const sentence = writeVerdictSentence(run, block.against)
    return `${sentence} ${runTag(run)} vs ${block.against}`
  }
  const other = runStore.get(block.against)
  let sentence: string
  try {
    sentence = writeVerdictSentence(run, block.against, other)
  } catch {
    return ''
  }
  return `${sentence} ${runTag(run)} vs ${other ? runTag(other) : block.against}`
}

function renderClaimText(block: ClaimBlock, runStore: RunStore): string {
  const run = runStore.get(block.runId)
  const info = run ? resolveMetric(run, block.metric) : undefined
  if (!run || !info) return ''
  const suffix = info.unit === 'USDC' ? ' USDC' : info.unit === '%' ? '%' : info.unit === 'days' ? ' días' : ' ops'
  return `${info.label.es}: ${displayValue(info)}${suffix} ${runTag(run)}`
}

function renderChartText(block: ChartBlock, runStore: RunStore): string {
  const refs = block.runIds.map((id) => {
    const run = runStore.get(id)
    return run ? runTag(run) : id
  })
  return `[gráfico ${block.kind}: ${refs.join(', ')}]`
}

function substituteRefs(md: string, claims: ClaimBlock[], verdicts: VerdictBlock[], runStore: RunStore): string {
  return md
    .replace(/\{\{c(\d+)\}\}/g, (whole, n: string) => {
      const c = claims[Number(n)]
      return c ? renderClaimText(c, runStore) || whole : whole
    })
    .replace(/\{\{v(\d+)\}\}/g, (whole, n: string) => {
      const v = verdicts[Number(n)]
      return v ? renderVerdictText(v, runStore) || whole : whole
    })
}

/**
 * Flattens a verified `Answer` into plain prose for thread history — never shown to a verifier again. Every
 * claim/verdict/chart line carries the run(s) it cites, by `resultHash` and `specKey`, so a follow-up question
 * can resolve "that run"/"double that width" against a concrete spec instead of just a rendered number.
 */
export function renderAnswerForHistory(answer: Answer, runs: RunResult[]): string {
  const runStore = runsMapOf(runs)
  const claims = answer.blocks.filter((b): b is ClaimBlock => b.type === 'claim')
  const verdicts = answer.blocks.filter((b): b is VerdictBlock => b.type === 'verdict')
  const lines = answer.blocks
    .map((b: Block): string => {
      if (b.type === 'text' || b.type === 'caveat') return substituteRefs(b.md, claims, verdicts, runStore)
      if (b.type === 'claim') return renderClaimText(b, runStore)
      if (b.type === 'verdict') return renderVerdictText(b, runStore)
      return renderChartText(b, runStore)
    })
    .filter((s) => s.length > 0)
  return lines.length > 0 ? lines.join('\n') : '(respuesta verificada previa sin texto)'
}

function buildMessages(systemPrompt: string, priorTurns: PriorTurn[] | undefined, question: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const turn of priorTurns ?? []) {
    messages.push({ role: 'user', content: turn.question })
    messages.push({ role: 'assistant', content: renderAnswerForHistory(turn.answer, turn.runs) })
  }
  messages.push({ role: 'user', content: question })
  return messages
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runAgentJob(input: JobInput, ctx: JobContext): Promise<JobResult> {
  const maxRounds = ctx.maxToolRounds ?? MAX_TOOL_ROUNDS
  const meter = newCostMeter()
  const runStore: RunStore = new Map()
  const wallStart = performance.now()
  const messages = buildMessages(ctx.systemPrompt, input.priorTurns, input.question)
  const tools: ToolSchema[] = [...AGENT_TOOL_SCHEMAS, SUBMIT_ANSWER_TOOL_SCHEMA as unknown as ToolSchema]

  let investigativeRounds = 0
  let rawAnswer: unknown = null
  let submitCallId: string | null = null
  let forcedFinal = false
  // AL-13: "the agent must report [a tool error], not try another policy" — once any dispatched round ends in
  // a tool error, every later turn must be submit_answer for the rest of the job, not just the next one.
  let mustSubmitNext = false

  // A generous ceiling, not a real spec number: `maxRounds` genuine rounds, the round-limit notice's own reply,
  // and a few extra turns so a model that violates AL-15's cap or the "stop after an error" rule (P2-5) still
  // gets several chances to find its way to submit_answer before the job falls through to the repair turn
  // below. Every violation still gets a real tool-role response (P1-1) and never actually runs anything.
  for (let turn = 0; turn < maxRounds + 6; turn++) {
    if (!forcedFinal && investigativeRounds >= maxRounds) {
      messages.push({
        role: 'user',
        content: `Has llegado al límite de ${maxRounds} rondas de herramientas. Llama a submit_answer AHORA con lo que tengas (añade un bloque "caveat" si el análisis quedó incompleto).`,
      })
      forcedFinal = true
    }

    const reply = await ctx.model.complete({ messages, tools })
    recordModelCall(meter, { model: reply.model, promptTokens: reply.usage.prompt_tokens, completionTokens: reply.usage.completion_tokens })
    messages.push(reply.message)

    const calls = reply.message.tool_calls ?? []
    if (calls.length === 0) {
      if (forcedFinal) {
        rawAnswer = { blocks: [] }
        break
      }
      messages.push({ role: 'user', content: 'Debes llamar a una herramienta (run_backtest, compare, sweep) o a submit_answer. No respondas en texto plano.' })
      continue
    }

    const submitCalls = calls.filter((c) => c.function.name === 'submit_answer')
    const investigative = calls.filter((c) => c.function.name !== 'submit_answer')

    if (submitCalls.length > 0) {
      // P1-1: every tool_call in THIS message needs a tool-role response before any further message is sent —
      // an OpenAI-compatible API refuses a history where one doesn't. A model that (wrongly) mixes
      // submit_answer with investigative calls in the same turn gets those others answered as skipped. A
      // model that calls submit_answer TWICE in one turn (review finding, P1/agent.ts:199: the old code used
      // `.find()`, which silently left the second tool_call id unanswered — malformed for the repair request
      // that could follow) gets every extra one answered "ignored", and only the first is actually used.
      const [primarySubmit, ...extraSubmits] = submitCalls
      for (const c of investigative) messages.push(skipMessage(c, LAB_TOOL_SKIPPED, 'skipped: a submit_answer call was present in the same turn'))
      for (const c of extraSubmits) messages.push(skipMessage(c, LAB_TOOL_IGNORED, 'ignored: only one submit_answer per turn'))
      rawAnswer = safeJsonParse(primarySubmit!.function.arguments)
      submitCallId = primarySubmit!.id
      break
    }

    // A purely investigative turn, blocked (never executed) when the round cap was already hit (AL-15) or when
    // a previous round already ended in a tool error and this turn should have been submit_answer instead
    // (P2-5). Either way every call still gets answered — P1-1 — and a P2-5 violation still burns a round so a
    // model can't thrash its way around the "stop after an error" rule.
    if (forcedFinal || mustSubmitNext) {
      const [code, detail] = forcedFinal
        ? [LAB_TOOL_UNAVAILABLE, `round limit reached (${maxRounds}); call submit_answer now`]
        : [LAB_TOOL_SEQUENCE, 'a previous tool call in this job already failed; call submit_answer (with a caveat if needed) instead of retrying']
      for (const c of investigative) messages.push(skipMessage(c, code, detail))
      if (mustSubmitNext && !forcedFinal) {
        investigativeRounds += 1
        recordToolRound(meter)
      }
      continue
    }

    investigativeRounds += 1
    recordToolRound(meter)
    let roundHadError = false
    for (const call of investigative) {
      if (roundHadError) {
        messages.push(skipMessage(call, LAB_TOOL_SKIPPED, 'skipped: a previous tool call in this round already failed'))
        continue
      }
      const args = safeJsonParse(call.function.arguments) ?? {}
      const outcome = dispatchTool(call.function.name, args, ctx.runner, runStore, meter, ctx.datasetsDir)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
      })
      if (!outcome.ok) roundHadError = true
    }
    if (roundHadError) mustSubmitNext = true
  }

  if (rawAnswer === null) rawAnswer = { blocks: [] }

  const verifyCtx = { runStore, catalogIds: ctx.catalogIds }
  const firstVerify = verify(rawAnswer, verifyCtx)

  // P1-1: answer the pending submit_answer tool_call now — with the verifier's own result. This IS the repair
  // prompt (no separate "user" message): the model reads its own tool result to see what to fix.
  if (submitCallId) {
    messages.push({
      role: 'tool',
      tool_call_id: submitCallId,
      name: 'submit_answer',
      content: JSON.stringify(firstVerify.ok ? { ok: true } : { ok: false, errors: firstVerify.errors }),
    })
  }

  let outcome: VerifierOutcome = firstVerify.ok ? 'ok' : 'error'
  let finalAnswer: Answer = firstVerify.ok ? (rawAnswer as Answer) : { blocks: [] }
  let flagged: 'LAB_ANSWER_PARTIAL' | null = null

  if (!firstVerify.ok) {
    meter.repairUsed = true

    const repairReply = await ctx.model.complete({ messages, tools })
    recordModelCall(meter, {
      model: repairReply.model,
      promptTokens: repairReply.usage.prompt_tokens,
      completionTokens: repairReply.usage.completion_tokens,
    })
    messages.push(repairReply.message)

    const repairCalls = repairReply.message.tool_calls ?? []
    const repairSubmits = repairCalls.filter((c) => c.function.name === 'submit_answer')
    const repairOthers = repairCalls.filter((c) => c.function.name !== 'submit_answer')
    // The repair turn's only valid action is submit_answer — a repair is not another chance to run backtests.
    // Still answered (P1-1), never executed. Same P1 fix as the main loop: a second submit_answer call here
    // must also be answered, not silently left dangling.
    const [repairSubmit, ...repairExtraSubmits] = repairSubmits
    for (const c of repairOthers) messages.push(skipMessage(c, LAB_TOOL_SKIPPED, 'skipped: the repair turn must call submit_answer'))
    for (const c of repairExtraSubmits) messages.push(skipMessage(c, LAB_TOOL_IGNORED, 'ignored: only one submit_answer per turn'))

    const repaired = repairSubmit ? safeJsonParse(repairSubmit.function.arguments) : safeJsonParse(repairReply.message.content ?? null)
    const secondVerify = repaired !== null ? verify(repaired, verifyCtx) : { ok: false, errors: [] }

    if (repairSubmit) {
      messages.push({
        role: 'tool',
        tool_call_id: repairSubmit.id,
        name: 'submit_answer',
        content: JSON.stringify(secondVerify.ok ? { ok: true } : { ok: false, errors: secondVerify.errors }),
      })
    }

    if (secondVerify.ok) {
      outcome = 'repaired'
      finalAnswer = repaired as Answer
    } else {
      outcome = 'partial'
      flagged = 'LAB_ANSWER_PARTIAL'
      const candidate = repaired ?? rawAnswer
      const fb = fallbackAnswer(isAnswerShaped(candidate) ? candidate : { blocks: [] }, verifyCtx)
      finalAnswer = fb.answer
    }
  }

  meter.wallMs = Math.round(performance.now() - wallStart)
  meter.verifierOutcome = outcome

  return { answer: finalAnswer, verifierOutcome: outcome, flagged, runs: [...runStore.values()], toolRounds: investigativeRounds, meter, messages }
}
