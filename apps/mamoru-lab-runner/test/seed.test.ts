import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { specKey, type RunResult } from '@mamoru/lab-bench'
import { cmdSeed, publish, seedExitCode } from '../src/cli.ts'

/** A seed run over every TRAIN window of the fixture manifest, against a local mock. */
const SLOW = 90_000

/**
 * Committed, synthetic, tiny (review of #117 round 2: CI has no `~/.local/share/mamoru-lab/datasets`; `cmdSeed`
 * resolves its dataset dir from `LAB_DATASETS`, so pointing that at the fixture directory `@mamoru/lab-bench`'s
 * own tests use is enough — no change to `cmdSeed` itself). Two TRAIN windows: `fix-full` (both bases run) and
 * `fix-nobtc` (neither does, aug2024-shaped) — so the expected matrix is 3 skipped (fix-nobtc) + 3 attempted
 * (fix-full), one of which this file forces to fail.
 */
const FIXTURE_DIR = join(import.meta.dir, '../../../packages/lab-bench/src/__fixtures__')

describe('publish / cmdSeed (review of #117 P2: publish must throw on non-2xx; seed counts failures and exits non-zero)', () => {
  let server: ReturnType<typeof Bun.serve>
  let publishedKeys: string[]
  let failSpecKey: string | null
  const PREVIOUS_ENV = { url: process.env.LAB_RUNNER_URL, secret: process.env.LAB_RUNNER_SECRET, datasets: process.env.LAB_DATASETS }

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
    process.env.LAB_DATASETS = FIXTURE_DIR
  })

  afterAll(() => {
    server.stop(true)
    if (PREVIOUS_ENV.url === undefined) delete process.env.LAB_RUNNER_URL
    else process.env.LAB_RUNNER_URL = PREVIOUS_ENV.url
    if (PREVIOUS_ENV.secret === undefined) delete process.env.LAB_RUNNER_SECRET
    else process.env.LAB_RUNNER_SECRET = PREVIOUS_ENV.secret
    if (PREVIOUS_ENV.datasets === undefined) delete process.env.LAB_DATASETS
    else process.env.LAB_DATASETS = PREVIOUS_ENV.datasets
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
    // fix-full x {live, 2000} x 1000: one of the three specs cmdSeed actually attempts (the fix-nobtc variants are
    // skipped before ever reaching publish, so failing one of those would prove nothing about this code path).
    const failing = specKey({ windowId: 'fix-full', base: 'live', widthTicks: 2000, deposit: 1000 })
    failSpecKey = failing
    let summary: { published: number; skipped: number; failed: number }
    try {
      summary = await cmdSeed()
    } finally {
      failSpecKey = null
    }

    // fix-nobtc x {live 2000, live 4000, guard 2000} is always skipped (B-03); we forced one more to fail.
    expect(summary).toEqual({ published: 2, skipped: 3, failed: 1 })
    expect(publishedKeys).not.toContain(failing)
    // `cmdSeed` never touches the real `process.exitCode` itself (review of #117 P2 follow-up: a prior version of
    // this test set and "restored" it directly and corrupted the whole `bun test` process's own exit code — Bun
    // does not actually clear `process.exitCode` on a later `= undefined` assignment, confirmed against a minimal
    // repro). `main` is the only thing that ever assigns it, from this pure function instead:
    expect(seedExitCode(summary)).toBe(1)
    expect(seedExitCode({ published: 21, skipped: 3, failed: 0 })).toBe(0)
  }, SLOW)
})
