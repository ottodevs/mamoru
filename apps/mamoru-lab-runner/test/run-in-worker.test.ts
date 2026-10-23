import { describe, expect, test } from 'bun:test'
import { runInWorker } from '../src/run-in-worker.ts'

const SLOW_WORKER = new URL('./fixtures/slow-worker.ts', import.meta.url)

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
