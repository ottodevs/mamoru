import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { specKey, type RunResult } from '@mamoru/lab-bench'
import { cmdSeed, publish, seedExitCode } from '../src/cli.ts'

/** A real seed run over every TRAIN window, against a local mock — several real backtests. */
const SLOW = 90_000

describe('publish / cmdSeed (review of #117 P2: publish must throw on non-2xx; seed counts failures and exits non-zero)', () => {
  let server: ReturnType<typeof Bun.serve>
  let publishedKeys: string[]
  let failSpecKey: string | null
  const PREVIOUS_ENV = { url: process.env.LAB_RUNNER_URL, secret: process.env.LAB_RUNNER_SECRET }

  beforeAll(() => {
    publishedKeys = []
    failSpecKey = null
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== '/ops/lab/runner/publish') return new Response('not found', { status: 404 })
        const body = (await req.json()) as { run: RunResult }
        if (body.run.specKey === failSpecKey) return new Response('simulated failure', { status: 500 })
        publishedKeys.push(body.run.specKey)
        return Response.json({ ok: true })
      },
    })
    process.env.LAB_RUNNER_URL = `http://127.0.0.1:${server.port}`
    process.env.LAB_RUNNER_SECRET = 'seed-test-secret'
  })

  afterAll(() => {
    server.stop(true)
    if (PREVIOUS_ENV.url === undefined) delete process.env.LAB_RUNNER_URL
    else process.env.LAB_RUNNER_URL = PREVIOUS_ENV.url
    if (PREVIOUS_ENV.secret === undefined) delete process.env.LAB_RUNNER_SECRET
    else process.env.LAB_RUNNER_SECRET = PREVIOUS_ENV.secret
  })

  test('publish resolves on 200 and the body actually lands on the mock', async () => {
    publishedKeys = []
    failSpecKey = null
    const run = { specKey: 'ok|live|2000|1000' } as unknown as RunResult
    await expect(publish(run)).resolves.toBeUndefined()
    expect(publishedKeys).toEqual(['ok|live|2000|1000'])
  })

  test('publish throws on a non-2xx status, with the status in the message — it no longer just logs and returns', async () => {
    const run = { specKey: 'bad|live|2000|1000' } as unknown as RunResult
    failSpecKey = 'bad|live|2000|1000'
    await expect(publish(run)).rejects.toThrow(/status 500/)
    failSpecKey = null
  })

  test('cmdSeed: published/skipped/failed are counted apart, and that count is what decides the exit code', async () => {
    publishedKeys = []
    // sep2026 x {live, 2000} x 1000: the first spec cmdSeed actually attempts (the three aug2024 variants are
    // skipped before ever reaching publish, so failing one of those would prove nothing about this code path).
    const failing = specKey({ windowId: 'sep2026', base: 'live', widthTicks: 2000, deposit: 1000 })
    failSpecKey = failing
    let summary: { published: number; skipped: number; failed: number }
    try {
      summary = await cmdSeed()
    } finally {
      failSpecKey = null
    }

    // aug2024 x {live 2000, live 4000, guard 2000} is always skipped (B-03); we forced exactly one more failure.
    expect(summary).toEqual({ published: 20, skipped: 3, failed: 1 })
    expect(publishedKeys).not.toContain(failing)
    // `cmdSeed` never touches the real `process.exitCode` itself (review of #117 P2 follow-up: a prior version of
    // this test set and "restored" it directly and corrupted the whole `bun test` process's own exit code — Bun
    // does not actually clear `process.exitCode` on a later `= undefined` assignment, confirmed against a minimal
    // repro). `main` is the only thing that ever assigns it, from this pure function instead:
    expect(seedExitCode(summary)).toBe(1)
    expect(seedExitCode({ published: 21, skipped: 3, failed: 0 })).toBe(0)
  }, SLOW)
})
