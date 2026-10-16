import { createApp } from './api/app.ts'
import type { Env } from './api/env.ts'
import { DRAIN_PER_CRON, drainFeedback } from './api/feedback.ts'
import { pullYieldLedger } from './api/yield-ledger.ts'

// mamoru-app Worker (plan §19.1): /api/* runs here first; everything else is the SPA from ASSETS.
const app = createApp()

/** otto/mamoru#129, phase 2 of #136: pulls the operator's snapshot into D1. Off unless YIELD_LEDGER=1 and the operator is configured; a missing answer or an unexpected error never fails the cron. */
async function runYieldLedger(env: Env): Promise<void> {
  if (env.YIELD_LEDGER !== '1' || !env.OPERATOR_URL || !env.OPERATOR_SECRET) return
  try {
    await pullYieldLedger(env.DB, env.OPERATOR_URL, env.OPERATOR_SECRET, (input, init) => fetch(input, init), new Date())
  } catch (e) {
    console.error('yield-ledger: cron run failed', e instanceof Error ? e.message : String(e))
  }
}

export default {
  fetch: app.fetch,
  // Cron (wrangler.jsonc `triggers`): posts the help and feedback notes that are stored and not yet in Mattermost,
  // then pulls the operator's yield-ledger snapshot into D1 (otto/mamoru#129).
  scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(drainFeedback(env.DB, (input, init) => fetch(input, init), env, new Date(), DRAIN_PER_CRON))
    ctx.waitUntil(runYieldLedger(env))
  },
}
