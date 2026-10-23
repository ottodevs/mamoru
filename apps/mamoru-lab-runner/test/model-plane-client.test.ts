// Agent Lab runner (008 task 5, otto/mamoru#204): ModelPlaneClient against a real, local, fake HTTP server (not a
// mocked `fetch`) — same pattern `test/seed.test.ts` uses for `publish`, so this exercises the real request/
// response wire shape (status codes, JSON parsing, an actually-slow response for the timeout case).
import { afterEach, describe, expect, test } from 'bun:test'
import { ModelPlaneUnavailableCode, ModelPlaneClient, labAgentModelsFromEnv, DEFAULT_LAB_AGENT_MODELS } from '../src/model-plane-client.ts'
import type { ChatMessage, ToolSchema } from '@mamoru/lab-agent'

const TOOLS: ToolSchema[] = [{ type: 'function', function: { name: 'run_backtest', description: 'd', parameters: { type: 'object', properties: {} } } }]
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hola' }]

function okCompletion(model: string, content = 'pong'): Response {
  return Response.json({
    id: 'x',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  })
}

describe('ModelPlaneClient (AL-30/AL-31/AL-32)', () => {
  let server: ReturnType<typeof Bun.serve> | null = null
  afterEach(() => {
    server?.stop(true)
    server = null
  })

  test('calls the first configured model and parses its reply, including which resource answered', async () => {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { model: string; tools?: unknown }
        expect(body.tools).toEqual(TOOLS)
        return okCompletion(body.model)
      },
    })
    const client = new ModelPlaneClient({ baseUrl: `http://127.0.0.1:${server.port}`, models: ['alias-a', 'alias-b'] })
    const reply = await client.complete({ messages: MESSAGES, tools: TOOLS })
    expect(reply.model).toBe('alias-a') // AL-30/40/41: the configured resource, not whatever raw provider id it proxies to
    expect(reply.message).toEqual({ role: 'assistant', content: 'pong', tool_calls: undefined })
    expect(reply.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3 })
  })

  test('a dead-on-arrival first model (model-plane 404, "no route for alias") is skipped; the second one answers', async () => {
    let hits: string[] = []
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { model: string }
        hits.push(body.model)
        if (body.model === 'alias-a') return Response.json({ error: 'No route found for alias: alias-a' }, { status: 404 })
        return okCompletion(body.model)
      },
    })
    const client = new ModelPlaneClient({ baseUrl: `http://127.0.0.1:${server.port}`, models: ['alias-a', 'alias-b'] })
    const reply = await client.complete({ messages: MESSAGES, tools: TOOLS })
    expect(reply.model).toBe('alias-b')
    expect(hits).toEqual(['alias-a', 'alias-b'])

    // AL-30: a model marked dead this job is never retried for the rest of THIS job — the next complete() call
    // goes straight to alias-b, alias-a is never hit again.
    hits = []
    const reply2 = await client.complete({ messages: MESSAGES, tools: TOOLS })
    expect(reply2.model).toBe('alias-b')
    expect(hits).toEqual(['alias-b'])
    expect(client.liveModels).toEqual(['alias-b'])
  })

  test('a model that explicitly refuses tools (model-plane\'s real vertex-dev-credits error shape) is skipped like any other failure', async () => {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { model: string }
        if (body.model === 'alias-a') return Response.json({ error: 'vertex-dev-credits does not support tools' }, { status: 400 })
        return okCompletion(body.model)
      },
    })
    const client = new ModelPlaneClient({ baseUrl: `http://127.0.0.1:${server.port}`, models: ['alias-a', 'alias-b'] })
    const reply = await client.complete({ messages: MESSAGES, tools: TOOLS })
    expect(reply.model).toBe('alias-b')
  })

  test('a model that never responds (timeout) is skipped once the budget elapses; the next model answers', async () => {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { model: string }
        if (body.model === 'alias-a') {
          await new Promise((resolve) => setTimeout(resolve, 300))
          return okCompletion(body.model)
        }
        return okCompletion(body.model)
      },
    })
    const client = new ModelPlaneClient({ baseUrl: `http://127.0.0.1:${server.port}`, models: ['alias-a', 'alias-b'], timeoutMs: 30 })
    const started = Date.now()
    const reply = await client.complete({ messages: MESSAGES, tools: TOOLS })
    expect(reply.model).toBe('alias-b')
    expect(Date.now() - started).toBeLessThan(290) // proves it moved on at ~30ms, not after waiting out the 300ms
  }, 2_000)

  test('every model exhausted throws a ReasonError with code LAB_MODEL_UNAVAILABLE, naming every attempt', async () => {
    server = Bun.serve({
      port: 0,
      fetch: async () => Response.json({ error: 'No route found for alias' }, { status: 404 }),
    })
    const client = new ModelPlaneClient({ baseUrl: `http://127.0.0.1:${server.port}`, models: ['alias-a', 'alias-b'] })
    let caught: unknown
    try {
      await client.complete({ messages: MESSAGES, tools: TOOLS })
    } catch (e) {
      caught = e
    }
    expect((caught as { code?: string } | undefined)?.code).toBe(ModelPlaneUnavailableCode)
    expect((caught as Error).message).toContain('alias-a')
    expect((caught as Error).message).toContain('alias-b')
  })

  test('constructing with an empty model list throws synchronously, before any network call', () => {
    expect(() => new ModelPlaneClient({ models: [] })).toThrow(/LAB_AGENT_MODELS/)
  })
})

describe('labAgentModelsFromEnv', () => {
  test('splits, trims and drops empty entries', () => {
    expect(labAgentModelsFromEnv({ LAB_AGENT_MODELS: ' a , b ,,c ' })).toEqual(['a', 'b', 'c'])
  })
  test('falls back to DEFAULT_LAB_AGENT_MODELS when unset or blank', () => {
    expect(labAgentModelsFromEnv({})).toEqual([...DEFAULT_LAB_AGENT_MODELS])
    expect(labAgentModelsFromEnv({ LAB_AGENT_MODELS: '   ' })).toEqual([...DEFAULT_LAB_AGENT_MODELS])
  })
})
