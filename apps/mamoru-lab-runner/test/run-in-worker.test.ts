import { describe, expect, test } from 'bun:test'
import { runInWorker } from '../src/run-in-worker.ts'

const SLOW_WORKER = new URL('./fixtures/slow-worker.ts', import.meta.url)
const BUDGET_WORKER = new URL('./fixtures/budget-worker.ts', import.meta.url)

describe('runInWorker (review of #117 P1: a long run must not starve the heartbeat)', () => {
  test('heartbeats keep firing while the worker is busy-waiting synchronously, off this thread', async () => {
    const ticks: number[] = []
    const heartbeat = async (): Promise<boolean> => {
      ticks.push(Date.now())
      return true
    }
    const outcome = await runInWorker<{ ms: number }, { done: true }>(SLOW_WORKER, { ms: 300 }, { heartbeat, intervalMs: 40 })
    expect(outcome).toEqual({ result: { done: true } })
    // 300ms of real, synchronous blocking on the worker's own thread; a 40ms heartbeat on this thread should still
    // fire several times. If the computation ran on this thread instead (the bug under review), it would fire zero.
    expect(ticks.length).toBeGreaterThanOrEqual(4)
  }, 5_000)

  test('a heartbeat reporting the lease lost terminates the worker at once and resolves without the result', async () => {
    let calls = 0
    const heartbeat = async (): Promise<boolean> => {
      calls++
      return calls < 2 // lost on the second heartbeat
    }
    const started = Date.now()
    // 5s of busy-work: if termination did not really stop it, this test would hang for 5s instead of ~80ms.
    const outcome = await runInWorker<{ ms: number }, { done: true }>(SLOW_WORKER, { ms: 5_000 }, { heartbeat, intervalMs: 30 })
    expect(outcome).toEqual({ leaseLost: true })
    expect(Date.now() - started).toBeLessThan(1_000)
  }, 5_000)
})

describe('runInWorker budget (otto/mamoru#204, AL-04): a wall-clock budget, separate from lease loss', () => {
  test('omitting budgetMs changes nothing — a worker that outlives any reasonable budget still just resolves with its result', async () => {
    const heartbeat = async (): Promise<boolean> => true
    const outcome = await runInWorker<{ ms: number }, { done: true }>(SLOW_WORKER, { ms: 50 }, { heartbeat, intervalMs: 20 })
    expect(outcome).toEqual({ result: { done: true } })
  }, 2_000)

  test('a budget that elapses before the worker finishes terminates it and resolves {timedOut: true}, not leaseLost', async () => {
    const heartbeat = async (): Promise<boolean> => true // the lease is fine throughout; only the budget is tight
    const started = Date.now()
    const outcome = await runInWorker<{ ms: number }, { done: true }>(BUDGET_WORKER, { ms: 5_000 }, { heartbeat, intervalMs: 500, budgetMs: 40 })
    expect(outcome).toEqual({ timedOut: true })
    expect(Date.now() - started).toBeLessThan(1_000) // proves real termination, not waiting out the 5s busy-wait
  }, 5_000)

  test('a worker-sent extend-budget control message re-arms the timer instead of being mistaken for the final result', async () => {
    const heartbeat = async (): Promise<boolean> => true
    const outcome = await runInWorker<{ ms: number; extendToMs?: number }, { done: true }>(
      BUDGET_WORKER,
      { ms: 80, extendToMs: 500 }, // initial budget (40ms) would kill it mid-run; the extension (500ms) lets it finish
      { heartbeat, intervalMs: 20, budgetMs: 40 },
    )
    expect(outcome).toEqual({ result: { done: true } })
  }, 2_000)

  test('a runs-produced control message reaches onRunsProduced and is never mistaken for the final result', async () => {
    const heartbeat = async (): Promise<boolean> => true
    const seen: unknown[] = []
    const outcome = await runInWorker<{ ms: number; emitRuns?: unknown[] }, { done: true }>(
      BUDGET_WORKER,
      { ms: 30, emitRuns: [{ resultHash: 'r1' }, { resultHash: 'r2' }] },
      { heartbeat, intervalMs: 20, onRunsProduced: (runs) => seen.push(...runs) },
    )
    expect(outcome).toEqual({ result: { done: true } })
    expect(seen).toEqual([{ resultHash: 'r1' }, { resultHash: 'r2' }])
  }, 2_000)

  test('runs-produced messages that arrive before a later timeout are still delivered — the caller can publish them even though the job itself never finished', async () => {
    const heartbeat = async (): Promise<boolean> => true
    const seen: unknown[] = []
    const outcome = await runInWorker<{ ms: number; emitRuns?: unknown[] }, { done: true }>(
      BUDGET_WORKER,
      { ms: 5_000, emitRuns: [{ resultHash: 'survives-timeout' }] },
      { heartbeat, intervalMs: 500, budgetMs: 60, onRunsProduced: (runs) => seen.push(...runs) },
    )
    expect(outcome).toEqual({ timedOut: true })
    expect(seen).toEqual([{ resultHash: 'survives-timeout' }])
  }, 5_000)
})
