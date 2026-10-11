import { createApp } from './api/app.ts'
import type { Env } from './api/env.ts'
import { DRAIN_PER_CRON, drainFeedback } from './api/feedback.ts'

// mamoru-app Worker (plan §19.1): /api/* runs here first; everything else is the SPA from ASSETS.
const app = createApp()

export default {
  fetch: app.fetch,
  // Cron (wrangler.jsonc `triggers`): posts the help and feedback notes that are stored and not yet in Mattermost.
  scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(drainFeedback(env.DB, (input, init) => fetch(input, init), env, new Date(), DRAIN_PER_CRON))
  },
}
