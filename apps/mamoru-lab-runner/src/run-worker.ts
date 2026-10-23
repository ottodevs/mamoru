/**
 * Bun Worker entry (otto/mamoru#199, review of #117 P1): computes one `BenchSpec` off the CLI's main thread, so
 * `runJob`'s heartbeat keeps ticking while this runs. Holds no network access of its own — it only reads local
 * dataset files through `@mamoru/lab-bench` and replies with the outcome; `cli.ts` is the one that talks to the
 * landing.
 */
import { ReasonError } from '@mamoru/domain'
import { runBench, type BenchSpec, type RunResult } from '@mamoru/lab-bench'

export type RunWorkerPayload = { spec: BenchSpec; datasetsDir: string }
export type RunWorkerResult = { kind: 'run'; run: RunResult } | { kind: 'reason'; code: string } | { kind: 'bug'; message: string }

declare const self: Worker

self.onmessage = (ev: MessageEvent<RunWorkerPayload>): void => {
  const { spec, datasetsDir } = ev.data
  let result: RunWorkerResult
  try {
    result = { kind: 'run', run: runBench(spec, datasetsDir) }
  } catch (e) {
    result = e instanceof ReasonError ? { kind: 'reason', code: e.code } : { kind: 'bug', message: e instanceof Error ? e.message : String(e) }
  }
  postMessage(result)
}
