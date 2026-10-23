/**
 * Runs a payload in a separate Bun `Worker` thread while a heartbeat ticks on this one (otto/mamoru#199, review
 * of #117 P1). `runBench` is a long, synchronous, CPU-bound call: on the same thread as the heartbeat's
 * `setInterval`, it starves the timer for its whole duration, so anything slower than one heartbeat tick looks
 * like an abandoned job to the landing even while it is genuinely still running. A worker thread keeps this
 * thread's event loop free to heartbeat throughout; the moment a heartbeat reports the lease lost, the worker is
 * terminated at once (a real OS-level stop, verified against a busy-looping worker — it does not wait for the
 * computation to finish wasted work) and this resolves without the result.
 */
export type WorkerOutcome<TResult> = { result: TResult } | { leaseLost: true }

export async function runInWorker<TPayload, TResult>(
  workerUrl: string | URL,
  payload: TPayload,
  opts: { heartbeat: () => Promise<boolean>; intervalMs: number },
): Promise<WorkerOutcome<TResult>> {
  const worker = new Worker(workerUrl)
  let settled = false
  return await new Promise<WorkerOutcome<TResult>>((resolve, reject) => {
    const ticker = setInterval(() => {
      void opts.heartbeat().then((ok) => {
        if (ok || settled) return
        settled = true
        clearInterval(ticker)
        worker.terminate()
        resolve({ leaseLost: true })
      })
    }, opts.intervalMs)
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearInterval(ticker)
      worker.terminate()
      fn()
    }
    worker.onmessage = (ev: MessageEvent<TResult>) => finish(() => resolve({ result: ev.data }))
    worker.onerror = (ev: ErrorEvent) => finish(() => reject(new Error(ev.message || 'worker error')))
    worker.postMessage(payload)
  })
}
