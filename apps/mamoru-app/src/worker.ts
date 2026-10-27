import { createApp } from './api/app.ts'
import type { Env } from './api/env.ts'
import { DRAIN_PER_CRON, drainFeedback } from './api/feedback.ts'
import { readOpsFlags } from './api/ops-flags.ts'
import { pullOperatorMetrics } from './api/operator-metrics.ts'
import { runOperatorLinkWatch } from './api/operator-link-watch.ts'
import { pullYieldLedger, type OperatorFetch } from './api/yield-ledger.ts'

// mamoru-app Worker (plan §19.1): /api/* runs here first; everything else is the SPA from ASSETS.
const app = createApp()

/**
 * otto/mamoru#129, phase 2 of #136: pulls the operator's snapshot into D1. Off unless the `yield_ledger` ops
 * flag is on (D1, set from /ops) and the operator is configured; a missing answer or an unexpected error never
 * fails the cron. `fetcher` is injectable for tests; the real cron always uses the global fetch.
 */
export async function runYieldLedger(env: Env, fetcher: OperatorFetch = (input, init) => fetch(input, init)): Promise<void> {
  if (!env.OPERATOR_URL || !env.OPERATOR_SECRET) return
  try {
    // Inside the try: a D1 read that fails skips this run like any other error, it never fails the cron.
    if (!(await readOpsFlags(env.DB)).yield_ledger) return
    await pullYieldLedger(env.DB, env.OPERATOR_URL, env.OPERATOR_SECRET, fetcher, new Date())
  } catch (e) {
    console.error('yield-ledger: cron run failed', e instanceof Error ? e.message : String(e))
  }
}

/**
 * otto/mamoru#129 follow-up: pulls the operator's signed /metrics into D1 for the /ops console
 * (operator-metrics.ts), every cron tick regardless of the `yield_ledger` flag — unlike runYieldLedger's
 * /snapshot pull, this one costs the operator nothing beyond its own cached relayer balance read. A missing
 * answer or an unexpected error never fails the cron.
 */
export async function runOperatorMetrics(env: Env, fetcher: OperatorFetch = (input, init) => fetch(input, init)): Promise<void> {
  if (!env.OPERATOR_URL || !env.OPERATOR_SECRET) return
  try {
    await pullOperatorMetrics(env.DB, env.OPERATOR_URL, env.OPERATOR_SECRET, fetcher, new Date())
  } catch (e) {
    console.error('operator-metrics: cron run failed', e instanceof Error ? e.message : String(e))
  }
}

export default {
  fetch: app.fetch,
  // Cron (wrangler.jsonc `triggers`): posts the help and feedback notes that are stored and not yet in Mattermost,
  // then pulls the operator's yield-ledger snapshot (otto/mamoru#129) and its /metrics (otto/mamoru#129 follow-up,
  // ungated) into D1, and probes the link to each operator (otto/mamoru#207).
  scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(drainFeedback(env.DB, (input, init) => fetch(input, init), env, new Date(), DRAIN_PER_CRON))
    ctx.waitUntil(runYieldLedger(env))
    ctx.waitUntil(runOperatorMetrics(env))
    ctx.waitUntil(runOperatorLinkWatch(env, (input, init) => fetch(input, init), new Date()))
  },
}
