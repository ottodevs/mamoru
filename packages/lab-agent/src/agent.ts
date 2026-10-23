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
  type ClaimBlock,
  type VerdictBlock,
} from './contract.ts'
import { newCostMeter, recordModelCall, recordToolRound, type CostMeter, type VerifierOutcome as MeterVerifierOutcome } from './cost-meter.ts'
import { AGENT_TOOL_SCHEMAS, compareTool, runBacktestTool, sweepTool, type RunStore, type ToolOutcome } from './tools.ts'
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

function dispatchTool(name: string, args: unknown, runner: BenchRunner, runStore: RunStore, meter: CostMeter): ToolOutcome<unknown> {
  if (name === 'run_backtest') return runBacktestTool(args, runner, runStore, meter)
  if (name === 'compare') return compareTool(args, runner, runStore, meter)
  if (name === 'sweep') return sweepTool()
  return { ok: false, error: { code: 'LAB_TOOL_UNAVAILABLE', message: `unknown tool "${name}"` } }
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

function renderVerdictText(block: VerdictBlock, runStore: RunStore): string {
  const run = runStore.get(block.runId)
  if (!run) return ''
  if (isVerdictBaseline(block.against)) return writeVerdictSentence(run, block.against)
  const other = runStore.get(block.against)
  try {
    return writeVerdictSentence(run, block.against, other)
  } catch {
    return ''
  }
}

function renderClaimText(block: ClaimBlock, runStore: RunStore): string {
  const run = runStore.get(block.runId)
  const info = run ? resolveMetric(run, block.metric) : undefined
  if (!info) return ''
  const suffix = info.unit === 'USDC' ? ' USDC' : info.unit === '%' ? '%' : info.unit === 'days' ? ' días' : ' ops'
  return `${info.label.es}: ${displayValue(info)}${suffix}`
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

/** Flattens a verified `Answer` into plain prose for thread history — never shown to a verifier again. */
export function renderAnswerForHistory(answer: Answer, runs: RunResult[]): string {
  const runStore = runsMapOf(runs)
  const claims = answer.blocks.filter((b): b is ClaimBlock => b.type === 'claim')
  const verdicts = answer.blocks.filter((b): b is VerdictBlock => b.type === 'verdict')
  const lines = answer.blocks
    .map((b: Block): string => {
      if (b.type === 'text' || b.type === 'caveat') return substituteRefs(b.md, claims, verdicts, runStore)
      if (b.type === 'claim') return renderClaimText(b, runStore)
      if (b.type === 'verdict') return renderVerdictText(b, runStore)
      return `[gráfico ${b.kind}]`
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
  let forcedFinal = false

  for (let turn = 0; turn < maxRounds + 2; turn++) {
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
    const submitCall = calls.find((c) => c.function.name === 'submit_answer')
    if (submitCall) {
      rawAnswer = safeJsonParse(submitCall.function.arguments)
      break
    }

    const investigative = calls.filter((c) => c.function.name !== 'submit_answer')
    if (investigative.length === 0) {
      if (forcedFinal) {
        rawAnswer = { blocks: [] }
        break
      }
      messages.push({ role: 'user', content: 'Debes llamar a una herramienta (run_backtest, compare, sweep) o a submit_answer. No respondas en texto plano.' })
      continue
    }

    // AL-15 is a hard cap, not just a prompt nudge: a model that ignores the round-limit notice and tries a 5th
    // investigative round gets none of them executed. The job still gets its one repair turn afterwards (below),
    // which is the model's real second chance to submit — this just guarantees at most `maxRounds` real runs.
    if (forcedFinal) {
      rawAnswer = { blocks: [] }
      break
    }

    investigativeRounds += 1
    recordToolRound(meter)
    for (const call of investigative) {
      const args = safeJsonParse(call.function.arguments) ?? {}
      const outcome = dispatchTool(call.function.name, args, ctx.runner, runStore, meter)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
      })
    }
  }

  if (rawAnswer === null) rawAnswer = { blocks: [] }

  const verifyCtx = { runStore, catalogIds: ctx.catalogIds }
  const firstVerify = verify(rawAnswer, verifyCtx)

  let outcome: VerifierOutcome = firstVerify.ok ? 'ok' : 'error'
  let finalAnswer: Answer = firstVerify.ok ? (rawAnswer as Answer) : { blocks: [] }
  let flagged: 'LAB_ANSWER_PARTIAL' | null = null

  if (!firstVerify.ok) {
    meter.repairUsed = true
    const errorsText = firstVerify.errors.map((e) => `[bloque ${e.blockIndex ?? '-'}] ${e.kind}: ${e.detail}`).join('\n')
    messages.push({
      role: 'user',
      content: `Tu submit_answer no pasó la verificación. Corrígelo y vuelve a llamar a submit_answer con un array "blocks" corregido. Errores:\n${errorsText}`,
    })

    const repairReply = await ctx.model.complete({ messages, tools })
    recordModelCall(meter, {
      model: repairReply.model,
      promptTokens: repairReply.usage.prompt_tokens,
      completionTokens: repairReply.usage.completion_tokens,
    })
    messages.push(repairReply.message)

    const repairSubmit = (repairReply.message.tool_calls ?? []).find((c) => c.function.name === 'submit_answer')
    const repaired = repairSubmit ? safeJsonParse(repairSubmit.function.arguments) : safeJsonParse(repairReply.message.content ?? null)
    const secondVerify = repaired !== null ? verify(repaired, verifyCtx) : { ok: false, errors: [] }

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

  return { answer: finalAnswer, verifierOutcome: outcome, flagged, runs: [...runStore.values()], toolRounds: investigativeRounds, meter }
}
