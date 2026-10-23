/**
 * Runs a payload in a separate Bun `Worker` thread while a heartbeat ticks on this one (otto/mamoru#199, review
 * of #117 P1). `runBench` is a long, synchronous, CPU-bound call: on the same thread as the heartbeat's
 * `setInterval`, it starves the timer for its whole duration, so anything slower than one heartbeat tick looks
 * like an abandoned job to the landing even while it is genuinely still running. A worker thread keeps this
 * thread's event loop free to heartbeat throughout; the moment a heartbeat reports the lease lost, the worker is
 * terminated at once (a real OS-level stop, verified against a busy-looping worker — it does not wait for the
 * computation to finish wasted work) and this resolves without the result.
 */
export type WorkerOutcome<TResult> = { result: TResult } | { leaseLost: true } | { timedOut: true }

/**
 * otto/mamoru#204 (task 5, AL-04): reserved control messages a worker may post INSTEAD of its final result —
 * never settle the outer promise, just notify the caller:
 *   - `extend-budget`: (re)arm the wall-clock budget — e.g. the agent worker extends 120s to 15 minutes once a
 *     `sweep` tool call starts.
 *   - `runs-produced`: a run (or runs) the agent job just produced, pushed out AS SOON AS it exists — so the
 *     main thread can publish it right away (`/ops/lab/runner/publish`, idempotent), on the MAIN thread's own
 *     network stack. That is the point: a `worker.terminate()` (budget timeout OR lease loss) kills the worker's
 *     OWN in-flight work, but never a fetch the main thread already started from an earlier `runs-produced`
 *     message — so a run finished before a timeout still lands in the store even though the job itself didn't.
 * Distinguished from a real `TResult` by the `__labControl` field: no existing `RunWorkerResult`
 * (`{kind: 'run'|'reason'|'bug', ...}`) or agent worker result shape carries it, so this can never collide with
 * a genuine final message.
 */
export type WorkerBudgetControl = { __labControl: 'extend-budget'; ms: number }
export type WorkerRunsProgress = { __labControl: 'runs-produced'; runs: unknown[] }
export type WorkerControlMessage = WorkerBudgetControl | WorkerRunsProgress

function asControlMessage(x: unknown): WorkerControlMessage | null {
  if (typeof x !== 'object' || x === null) return null
  const c = (x as Record<string, unknown>).__labControl
  if (c === 'extend-budget' || c === 'runs-produced') return x as WorkerControlMessage
  return null
}

export async function runInWorker<TPayload, TResult>(
  workerUrl: string | URL,
  payload: TPayload,
  opts: { heartbeat: () => Promise<boolean>; intervalMs: number; budgetMs?: number; onRunsProduced?: (runs: unknown[]) => void },
): Promise<WorkerOutcome<TResult>> {
  const worker = new Worker(workerUrl)
  let settled = false
  let budgetTimer: ReturnType<typeof setTimeout> | null = null
  return await new Promise<WorkerOutcome<TResult>>((resolve, reject) => {
    const ticker = setInterval(() => {
      void opts.heartbeat().then((ok) => {
        if (ok || settled) return
        settled = true
        clearInterval(ticker)
        if (budgetTimer) clearTimeout(budgetTimer)
        worker.terminate()
        resolve({ leaseLost: true })
      })
    }, opts.intervalMs)
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearInterval(ticker)
      if (budgetTimer) clearTimeout(budgetTimer)
      worker.terminate()
      fn()
    }
    // Only ever armed when the caller opts in (`opts.budgetMs` set) — omitting it (every existing bench-job call
    // site) keeps this identical to before: no timer, no new way to settle, same two outcomes as always.
    const armBudget = (ms: number): void => {
      if (budgetTimer) clearTimeout(budgetTimer)
      budgetTimer = setTimeout(() => finish(() => resolve({ timedOut: true })), ms)
    }
    if (opts.budgetMs !== undefined) armBudget(opts.budgetMs)
    worker.onmessage = (ev: MessageEvent<TResult | WorkerControlMessage>) => {
      const control = asControlMessage(ev.data)
      if (control?.__labControl === 'extend-budget') {
        armBudget(control.ms)
        return
      }
      if (control?.__labControl === 'runs-produced') {
        opts.onRunsProduced?.(control.runs)
        return
      }
      finish(() => resolve({ result: ev.data as TResult }))
    }
    worker.onerror = (ev: ErrorEvent) => finish(() => reject(new Error(ev.message || 'worker error')))
    worker.postMessage(payload)
  })
}
