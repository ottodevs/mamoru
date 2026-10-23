// Test fixture (review of #117 P1): a worker that busy-waits *synchronously* for `ms` before replying — the same
// shape of blocking as `runBench` (no awaits inside), on purpose, so the test proves heartbeats on the main thread
// survive a genuinely blocking computation on another thread, not just an async-but-cheap one.
declare const self: Worker

self.onmessage = (ev: MessageEvent<{ ms: number }>): void => {
  const until = Date.now() + ev.data.ms
  while (Date.now() < until) {
    /* intentional synchronous busy-wait */
  }
  postMessage({ done: true })
}
