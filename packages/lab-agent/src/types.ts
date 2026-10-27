// Agent Lab agent (spec 008 phase 2, task 4, otto/mamoru#200): the two seams the agent is injected through —
// the model (OpenAI-compatible tool calling) and the bench (whatever actually runs a BenchSpec). Pure types; no
// network, no filesystem. Task 5 wires ModelClient to the model-plane route `agent-lab`; here `RecordedModel`
// (recorded-model.ts) replays fixtures, and `LabBenchRunner` (tools.ts) wraps `@mamoru/lab-bench`'s `runBench`.
import type { BenchSpec, RunResult } from '@mamoru/lab-bench'

/** OpenAI tool-calling wire shape, kept snake_case so a model-plane proxy response needs no translation. */
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** Required for system/user; assistant may have `null` with only tool_calls; tool carries the call's result. */
  content?: string | null
  tool_calls?: ToolCall[]
  /** Required when role is 'tool': the ToolCall.id this message answers. */
  tool_call_id?: string
  /** The tool name, carried on a 'tool' message for providers that want it (OpenAI ignores it; harmless either way). */
  name?: string
}

export type ToolSchema = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type ModelUsage = { prompt_tokens: number; completion_tokens: number }

export type ModelReply = {
  message: ChatMessage
  usage: ModelUsage
  /** The resource/model id that actually answered (AL-30: one of several included peers). */
  model: string
}

/**
 * AL-30/AL-31: one call, one reply. Retries, provider fallback and the model-plane route itself are the runner's
 * job (task 5) — this seam only ever asks for the next completion given the conversation so far.
 */
export interface ModelClient {
  complete(input: { messages: ChatMessage[]; tools: ToolSchema[] }): Promise<ModelReply>
}

/**
 * AL-10: the tool layer's view of "run this spec and give me back a result". In production this wraps
 * `@mamoru/lab-bench`'s `runBench` (see `LabBenchRunner` in tools.ts) — or, later, a runner queue job. It throws
 * `ReasonError` for `LAB_SPEC_INVALID` / `LAB_HOLDOUT_DENIED` / `LAB_DATASET_MISSING`, exactly as `runBench` does;
 * tools.ts is the only place that catches those and turns them into a tool error object for the model.
 */
export interface BenchRunner {
  run(spec: BenchSpec): RunResult
}

export type { BenchSpec, RunResult }
