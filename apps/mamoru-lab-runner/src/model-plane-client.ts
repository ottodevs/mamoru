/**
 * Agent Lab runner (spec 008 phase 2, task 5, otto/mamoru#204): a `ModelClient` (packages/lab-agent) over the
 * model-plane gateway on lady (`~/box/src/model-plane`), OpenAI-compatible chat completions with tool calling.
 *
 * AL-30: an ordered list of included resources, treated as peers — the ordering itself lives here (env
 * `LAB_AGENT_MODELS`), not as a model-plane route named literally "agent-lab": model-plane's own fallback
 * concept is a named *alias* with ordered `route_targets` (confirmed by reading its gateway source, see the PR
 * body), but today none of its working aliases support tools (`vertex-flash`/`vertex-argon`/`vertex-pro` all
 * explicitly refuse a request that carries `tools`, by a guard in model-plane's own code — confirmed live,
 * `{"error":"vertex-dev-credits does not support tools"}`). This client is agnostic to that: it tries each
 * configured alias in order against model-plane's one gateway endpoint, and never assumes model-plane has any
 * fallback logic of its own.
 *
 * AL-31: a model that errors, times out (45s) or has no tool support for THIS call is skipped, and the next one
 * in the list is tried. A model marked dead is never retried for the REST of this job (new jobs start clean —
 * model-plane may be healthy again by the next claim).
 *
 * AL-32: no paid API. `LAB_AGENT_MODELS`' default names included/free resources only (see
 * `DEFAULT_LAB_AGENT_MODELS` below) — never anything billed per call.
 */
import { ReasonError } from '@mamoru/domain'
import type { ChatMessage, ModelClient, ModelReply, ToolSchema } from '@mamoru/lab-agent'

export const MODEL_PLANE_DEFAULT_URL = 'http://127.0.0.1:3500'
/** AL-30: "a model that errors/times out (45s)...". */
export const MODEL_CALL_TIMEOUT_MS = 45_000

/**
 * The two Groq models already registered in model-plane with `capabilities: ["text","code","tools"]`, on the
 * `groq-api` connection ("Groq API (from OmniRoute Groq free)", included quota, active) — the only provider this
 * gateway proxies with the plain `OpenAICompatibleAdapter` (tools pass through unmodified, no translation layer
 * to silently drop them). As of this writing NEITHER has a model-plane *alias* yet (creating one needs
 * `POST /v1/aliases`, which currently 500s on live: a pre-existing schema-drift bug, filed as
 * otto/model-plane#93 — a stale NOT NULL `model_aliases.model_id` column the current Drizzle schema no longer
 * declares). Until that is fixed and the two aliases below are created, every call through this default list
 * fails with `LAB_MODEL_UNAVAILABLE` (verified live against the real gateway, see the PR body) — the client
 * itself is correct and will start working the moment the aliases exist, with no mamoru-side change.
 */
export const DEFAULT_LAB_AGENT_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] as const

/** Re-exported so a caller/test never needs its own `@mamoru/domain` import just to check this one code. */
export const ModelPlaneUnavailableCode = 'LAB_MODEL_UNAVAILABLE' as const

/** `LAB_AGENT_MODELS`, comma separated, trimmed, empty entries dropped; `DEFAULT_LAB_AGENT_MODELS` when unset. */
export function labAgentModelsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.LAB_AGENT_MODELS
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_LAB_AGENT_MODELS]
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

type ChatCompletionChoice = { message?: { role?: string; content?: string | null; tool_calls?: unknown }; finish_reason?: string }
type ChatCompletionResponse = { model?: string; choices?: ChatCompletionChoice[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }

type Attempt = { model: string; reason: string }

export type ModelPlaneClientOptions = {
  /** `MODEL_PLANE_DEFAULT_URL` by default — model-plane is loopback-only, trusted with no auth (confirmed: no
   * auth middleware on `/v1/chat/completions` in model-plane's own `server.ts`/`src/api/routes.ts`). */
  baseUrl?: string
  /** AL-30's ordered peer list — model-plane alias names, tried in order. Never empty. */
  models: readonly string[]
  timeoutMs?: number
  /** Test seam: a fake `fetch` (never a real network call in a unit test). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * AL-30/AL-31/AL-32. One instance per job (the runner constructs a fresh one per claimed job): a model marked
 * dead stays dead for the lifetime of this instance, never for longer — a later job gets every model a fresh
 * chance, in case model-plane recovered by then.
 */
export class ModelPlaneClient implements ModelClient {
  readonly #baseUrl: string
  readonly #models: readonly string[]
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch
  readonly #deadForThisJob = new Set<string>()

  constructor(opts: ModelPlaneClientOptions) {
    if (opts.models.length === 0) throw new Error('ModelPlaneClient needs at least one model in LAB_AGENT_MODELS')
    this.#baseUrl = opts.baseUrl ?? MODEL_PLANE_DEFAULT_URL
    this.#models = opts.models
    this.#timeoutMs = opts.timeoutMs ?? MODEL_CALL_TIMEOUT_MS
    this.#fetch = opts.fetchImpl ?? fetch
  }

  /** Which configured models are still live candidates for a later call in this same job (tests + diagnostics). */
  get liveModels(): string[] {
    return this.#models.filter((m) => !this.#deadForThisJob.has(m))
  }

  async complete(input: { messages: ChatMessage[]; tools: ToolSchema[] }): Promise<ModelReply> {
    const attempts: Attempt[] = []
    for (const model of this.#models) {
      if (this.#deadForThisJob.has(model)) continue
      try {
        return await this.#tryOne(model, input)
      } catch (e) {
        this.#deadForThisJob.add(model)
        attempts.push({ model, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    const detail = attempts.length > 0 ? attempts.map((a) => `${a.model}: ${a.reason}`).join('; ') : 'LAB_AGENT_MODELS is empty'
    throw new ReasonError('LAB_MODEL_UNAVAILABLE', `every configured model-plane resource failed for this job — ${detail}`)
  }

  async #tryOne(model: string, input: { messages: ChatMessage[]; tools: ToolSchema[] }): Promise<ModelReply> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const res = await this.#fetch(new URL('/v1/chat/completions', this.#baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: input.messages, tools: input.tools }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`model-plane returned ${res.status} for "${model}": ${text.slice(0, 300)}`)
      }
      const json = (await res.json()) as ChatCompletionResponse
      const choice = json.choices?.[0]
      if (!choice?.message) throw new Error(`model-plane response for "${model}" has no choices[0].message`)
      const message: ChatMessage = {
        role: 'assistant',
        content: choice.message.content ?? null,
        tool_calls: choice.message.tool_calls as ChatMessage['tool_calls'],
      }
      // Claude 5.5 needs its thinking blocks replayed unchanged in the next turn (model-plane carries them here).
      const thinking = (choice.message as { thinking_blocks?: unknown }).thinking_blocks
      if (Array.isArray(thinking) && thinking.length > 0) message.thinking_blocks = thinking
      return {
        message,
        usage: { prompt_tokens: json.usage?.prompt_tokens ?? 0, completion_tokens: json.usage?.completion_tokens ?? 0 },
        // AL-30/AL-40/AL-41 track cost and degradation per configured RESOURCE (the LAB_AGENT_MODELS entry), not
        // the raw provider model id a resource happens to proxy to today — that is what an operator's shadow
        // price table (cost-meter.ts's `ShadowPriceTable.models`) and `/ops/lab`'s per-resource pass rate (AL-41)
        // are keyed by.
        model,
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error(`model-plane call to "${model}" timed out after ${this.#timeoutMs}ms`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}
