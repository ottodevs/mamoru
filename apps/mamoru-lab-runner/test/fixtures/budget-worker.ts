// Test fixture (otto/mamoru#204, AL-04): a worker that busy-waits past its initial budget, optionally sending an
// `extend-budget` control message first — proves `runInWorker`'s budget timer actually fires, and that a real
// control message re-arms it instead of being mistaken for the final result.
export {} // forces module scope — `slow-worker.ts` already declares a global `self: Worker`; without this, two
// such global scripts in the one `tsconfig.json` program collide (TS2451).
declare const self: Worker

self.onmessage = (ev: MessageEvent<{ ms: number; extendToMs?: number; emitRuns?: unknown[] }>): void => {
  const { ms, extendToMs, emitRuns } = ev.data
  if (extendToMs !== undefined) postMessage({ __labControl: 'extend-budget', ms: extendToMs })
  if (emitRuns) for (const r of emitRuns) postMessage({ __labControl: 'runs-produced', runs: [r] })
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* intentional synchronous busy-wait, same shape as runBench/runAgentJob's tool calls */
  }
  postMessage({ done: true })
}
