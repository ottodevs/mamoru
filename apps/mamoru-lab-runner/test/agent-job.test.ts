// Agent Lab runner (008 task 5, otto/mamoru#204): an AGENT job end to end — claim -> (model calls + tool calls,
// in the worker) -> publish each produced run -> post the final result — against a fake landing AND a fake
// model-plane server (RecordedModel scripts the model's turns; LabBenchRunner runs real backtests over
// lab-bench's own tiny fixture dataset, same as packages/lab-agent's own tests — no network beyond these two
// local fake servers, no real Lab datasets).
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RecordedModel, submitAnswerCall, toolCall, type ChatMessage, type ModelReply, type ToolSchema } from '@mamoru/lab-agent'
import { basePolicyOf } from '@mamoru/lab-bench'
import { claim, publish, runJob, type AgentClaimedJob } from '../src/cli.ts'

const FIXTURE_DIR = join(import.meta.dir, '../../../packages/lab-bench/src/__fixtures__')

/** Adapts a `RecordedModel` into model-plane's real wire shape, so the ModelPlaneClient (inside the worker) is
 * exercised through an actual HTTP round trip, not a mocked `fetch`. */
function fakeModelPlaneServer(model: RecordedModel): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 })
      const body = (await req.json()) as { model: string; messages: ChatMessage[]; tools: ToolSchema[] }
      let reply: ModelReply
      try {
        reply = await model.complete({ messages: body.messages, tools: body.tools })
      } catch {
        return Response.json({ error: 'RecordedModel exhausted' }, { status: 500 })
      }
      return Response.json({
        id: 'fake',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: reply.message, finish_reason: reply.message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: reply.usage,
      })
    },
  })
}

type LandingState = {
  job: AgentClaimedJob | null
  claims: number
  heartbeats: number
  published: { resultHash: string }[]
  results: Record<string, unknown>[]
  failPublish?: boolean
}

function fakeLandingServer(state: LandingState): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (req.method !== 'POST') return new Response('not found', { status: 404 })
      if (path === '/ops/lab/runner/claim') {
        state.claims++
        if (!state.job || state.claims > 1) return new Response(null, { status: 204 })
        const j = state.job
        return Response.json({ job: { id: j.id, kind: 'agent', leaseId: j.leaseId, threadId: j.threadId, question: j.question, history: j.history } })
      }
      if (path === '/ops/lab/runner/heartbeat') {
        state.heartbeats++
        return Response.json({ ok: true })
      }
      if (path === '/ops/lab/runner/publish') {
        const body = (await req.json()) as { run: { resultHash: string } }
        if (state.failPublish) return new Response('upstream down', { status: 503 })
        state.published.push({ resultHash: body.run.resultHash })
        return Response.json({ ok: true, resultHash: body.run.resultHash })
      }
      if (path === '/ops/lab/runner/result') {
        const body = (await req.json()) as Record<string, unknown>
        state.results.push(body)
        return Response.json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    },
  })
}

describe('agent job, end to end: claim -> publish runs -> result', () => {
  let landing: ReturnType<typeof Bun.serve>
  let modelPlane: ReturnType<typeof Bun.serve>
  let budgetDir: string
  const PREV = {
    url: process.env.LAB_RUNNER_URL,
    secret: process.env.LAB_RUNNER_SECRET,
    datasets: process.env.LAB_DATASETS,
    modelPlane: process.env.MODEL_PLANE_URL,
    models: process.env.LAB_AGENT_MODELS,
    budgetState: process.env.LAB_AGENT_BUDGET_STATE,
    heartbeatMs: process.env.LAB_HEARTBEAT_INTERVAL_MS,
  }

  beforeEach(() => {
    budgetDir = mkdtempSync(join(tmpdir(), 'lab-agent-budget-'))
  })

  afterEach(() => {
    landing?.stop(true)
    modelPlane?.stop(true)
    rmSync(budgetDir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(PREV)) {
      const envKey = {
        url: 'LAB_RUNNER_URL',
        secret: 'LAB_RUNNER_SECRET',
        datasets: 'LAB_DATASETS',
        modelPlane: 'MODEL_PLANE_URL',
        models: 'LAB_AGENT_MODELS',
        budgetState: 'LAB_AGENT_BUDGET_STATE',
        heartbeatMs: 'LAB_HEARTBEAT_INTERVAL_MS',
      }[k]!
      if (v === undefined) delete process.env[envKey]
      else process.env[envKey] = v
    }
  })

  test('a one-round agent job: claims, runs run_backtest for real, publishes the run, posts a verified answer', async () => {
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000 })] },
      { toolCalls: [submitAnswerCall([{ type: 'caveat', md: 'corrida de prueba, sin reclamos.' }])] },
    ])
    modelPlane = fakeModelPlaneServer(model)
    const state: LandingState = {
      job: { kind: 'agent', id: 'job-1', leaseId: 'lease-1', threadId: 'thread-1', question: '¿qué habría pasado en fix-full con live?', history: [] },
      claims: 0,
      heartbeats: 0,
      published: [],
      results: [],
    }
    landing = fakeLandingServer(state)

    process.env.LAB_RUNNER_URL = `http://127.0.0.1:${landing.port}`
    process.env.LAB_RUNNER_SECRET = 'agent-job-test-secret'
    process.env.LAB_DATASETS = FIXTURE_DIR
    process.env.MODEL_PLANE_URL = `http://127.0.0.1:${modelPlane.port}`
    process.env.LAB_AGENT_MODELS = 'fake-alias'
    process.env.LAB_AGENT_BUDGET_STATE = join(budgetDir, 'budget.json')

    const job = await claim()
    expect(job).not.toBeNull()
    expect(job!.kind).toBe('agent')
    await runJob(job!)

    expect(state.published).toHaveLength(1)
    expect(state.results).toHaveLength(1)
    const posted = state.results[0]!
    expect(posted.jobId).toBe('job-1')
    expect(posted.leaseId).toBe('lease-1')
    expect(posted.kind).toBe('agent')
    expect((posted.verifier as { outcome: string }).outcome).toBe('ok')
    expect(posted.runHashes).toEqual([state.published[0]!.resultHash])
    expect((posted.answer as { blocks: unknown[] }).blocks).toHaveLength(1)
    const cost = posted.cost as { modelCalls: unknown[]; toolRounds: number }
    expect(cost.modelCalls).toHaveLength(2) // one investigative round + one submit_answer round
    expect(cost.toolRounds).toBe(1)
  }, 10_000)

  test('a run that never reaches /publish (after retries) keeps the answer from being posted', async () => {
    const model = new RecordedModel([
      { toolCalls: [toolCall('run_backtest', { windowId: 'fix-full', base: 'live', deposit: 1000 })] },
      { toolCalls: [submitAnswerCall([{ type: 'caveat', md: 'corrida de prueba, sin reclamos.' }])] },
    ])
    modelPlane = fakeModelPlaneServer(model)
    const state: LandingState = {
      job: { kind: 'agent', id: 'job-p', leaseId: 'lease-p', threadId: 'thread-p', question: '¿fix-full con live?', history: [] },
      claims: 0,
      heartbeats: 0,
      published: [],
      results: [],
      failPublish: true,
    }
    landing = fakeLandingServer(state)
    process.env.LAB_RUNNER_URL = `http://127.0.0.1:${landing.port}`
    process.env.LAB_RUNNER_SECRET = 'agent-job-test-secret'
    process.env.LAB_DATASETS = FIXTURE_DIR
    process.env.MODEL_PLANE_URL = `http://127.0.0.1:${modelPlane.port}`
    process.env.LAB_AGENT_MODELS = 'fake-alias'
    process.env.LAB_AGENT_BUDGET_STATE = join(budgetDir, 'budget.json')

    const job = await claim()
    await runJob(job!)
    expect(state.published).toHaveLength(0)
    expect(state.results).toHaveLength(0) // left to lease expiry, never an answer citing a missing run
  }, 15_000)

  test('the daily budget guard refuses a job over the limit without running it — no publish, no model call', async () => {
    const model = new RecordedModel([]) // never consulted — a budget refusal must short-circuit before any model call
    modelPlane = fakeModelPlaneServer(model)
    const state: LandingState = {
      job: { kind: 'agent', id: 'job-budget', leaseId: 'lease-budget', threadId: 'thread-1', question: 'pregunta cualquiera', history: [] },
      claims: 0,
      heartbeats: 0,
      published: [],
      results: [],
    }
    landing = fakeLandingServer(state)

    process.env.LAB_RUNNER_URL = `http://127.0.0.1:${landing.port}`
    process.env.LAB_RUNNER_SECRET = 'agent-job-test-secret'
    process.env.LAB_DATASETS = FIXTURE_DIR
    process.env.MODEL_PLANE_URL = `http://127.0.0.1:${modelPlane.port}`
    process.env.LAB_AGENT_MODELS = 'fake-alias'
    const budgetStatePath = join(budgetDir, 'budget.json')
    process.env.LAB_AGENT_BUDGET_STATE = budgetStatePath
    await Bun.write(budgetStatePath, JSON.stringify({ date: new Date().toISOString().slice(0, 10), count: 30 }))

    const job = await claim()
    await runJob(job!)

    expect(state.published).toHaveLength(0)
    expect(state.results).toHaveLength(1)
    expect(state.results[0]).toMatchObject({ jobId: 'job-budget', leaseId: 'lease-budget', error: 'LAB_AGENT_BUDGET' })
  }, 10_000)

  test('a dead-on-arrival model (every model-plane call fails) posts LAB_MODEL_UNAVAILABLE, not a crash', async () => {
    modelPlane = Bun.serve({ port: 0, fetch: () => Response.json({ error: 'No route found for alias' }, { status: 404 }) })
    const state: LandingState = {
      job: { kind: 'agent', id: 'job-dead', leaseId: 'lease-dead', threadId: 'thread-1', question: 'pregunta', history: [] },
      claims: 0,
      heartbeats: 0,
      published: [],
      results: [],
    }
    landing = fakeLandingServer(state)

    process.env.LAB_RUNNER_URL = `http://127.0.0.1:${landing.port}`
    process.env.LAB_RUNNER_SECRET = 'agent-job-test-secret'
    process.env.LAB_DATASETS = FIXTURE_DIR
    process.env.MODEL_PLANE_URL = `http://127.0.0.1:${modelPlane.port}`
    process.env.LAB_AGENT_MODELS = 'alias-a,alias-b'
    process.env.LAB_AGENT_BUDGET_STATE = join(budgetDir, 'budget.json')

    const job = await claim()
    await runJob(job!)

    expect(state.results).toHaveLength(1)
    expect(state.results[0]).toMatchObject({ jobId: 'job-dead', leaseId: 'lease-dead', error: 'LAB_MODEL_UNAVAILABLE' })
  }, 10_000)

  test('heartbeats keep firing during a long model call (CONTRACT: "every 30s through the whole job including model calls")', async () => {
    // A model-plane server that sleeps past several heartbeat ticks before answering — proves the worker-thread
    // split (run-agent-worker.ts) keeps this thread's heartbeat timer free during that wait, not just during a
    // synchronous tool call (already covered by run-in-worker.test.ts's busy-wait fixtures).
    modelPlane = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { model: string }
        await new Promise((resolve) => setTimeout(resolve, 150))
        return Response.json({
          id: 'slow',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [submitAnswerCall([{ type: 'caveat', md: 'lenta pero verificada.' }])] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        })
      },
    })
    const state: LandingState = {
      job: { kind: 'agent', id: 'job-slow', leaseId: 'lease-slow', threadId: 'thread-1', question: 'pregunta lenta', history: [] },
      claims: 0,
      heartbeats: 0,
      published: [],
      results: [],
    }
    landing = fakeLandingServer(state)

    process.env.LAB_RUNNER_URL = `http://127.0.0.1:${landing.port}`
    process.env.LAB_RUNNER_SECRET = 'agent-job-test-secret'
    process.env.LAB_DATASETS = FIXTURE_DIR
    process.env.MODEL_PLANE_URL = `http://127.0.0.1:${modelPlane.port}`
    process.env.LAB_AGENT_MODELS = 'fake-alias'
    process.env.LAB_AGENT_BUDGET_STATE = join(budgetDir, 'budget.json')
    process.env.LAB_HEARTBEAT_INTERVAL_MS = '20' // test-only: proves the tick fires during the 150ms model call

    const job = await claim()
    await runJob(job!)

    expect(state.heartbeats).toBeGreaterThanOrEqual(1)
    expect(state.results).toHaveLength(1)
    expect((state.results[0] as { verifier: { outcome: string } }).verifier.outcome).toBe('ok')
  }, 10_000)
})

// Keeps `basePolicyOf` imported honest against drift — if lab-bench ever renames/removes the base ids this test's
// fixture agent job implicitly relies on (via the catalog built from FIXTURE_DIR), this fails loudly here instead
// of as a confusing agent-loop failure above.
test('sanity: the fixture-independent base ids this suite assumes still exist', () => {
  expect(basePolicyOf('live').policyId).toBeTruthy()
  expect(basePolicyOf('guard').policyId).toBeTruthy()
})
