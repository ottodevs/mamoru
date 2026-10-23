// Agent Lab agent (008 task 4, otto/mamoru#200): a `ModelClient` that replays a fixed, ordered script instead of
// calling a real model. Task 5 wires `ModelClient` to the model-plane route `agent-lab`; this is what every test
// in this package uses instead, so the agent loop is exercised offline and deterministically (no network, as the
// ticket requires).
import type { ChatMessage, ModelClient, ModelReply, ModelUsage, ToolCall, ToolSchema } from './types.ts'

export type RecordedTurn = {
  content?: string | null
  toolCalls?: ToolCall[]
  usage?: Partial<ModelUsage>
  model?: string
}

export class RecordedModel implements ModelClient {
  readonly #turns: readonly RecordedTurn[]
  #i = 0

  constructor(turns: readonly RecordedTurn[]) {
    this.#turns = turns
  }

  /** How many `complete()` calls have been consumed so far — tests assert round counts against this. */
  get callsMade(): number {
    return this.#i
  }

  async complete(_input: { messages: ChatMessage[]; tools: ToolSchema[] }): Promise<ModelReply> {
    const turn = this.#turns[this.#i]
    if (!turn) throw new Error(`RecordedModel exhausted after ${this.#i} scripted turn(s)`)
    this.#i += 1
    return {
      message: { role: 'assistant', content: turn.content ?? null, tool_calls: turn.toolCalls },
      usage: { prompt_tokens: turn.usage?.prompt_tokens ?? 0, completion_tokens: turn.usage?.completion_tokens ?? 0 },
      model: turn.model ?? 'recorded-test-model',
    }
  }
}

let nextCallId = 0

/** One OpenAI-shaped tool call for a scripted turn — ids only need to be unique within the turn that uses them. */
export function toolCall(name: string, args: unknown): ToolCall {
  nextCallId += 1
  return { id: `call_${nextCallId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** Convenience: the one tool call that ends a job (AL-15: the model's only way to finish). */
export function submitAnswerCall(blocks: unknown[]): ToolCall {
  return toolCall('submit_answer', { blocks })
}
