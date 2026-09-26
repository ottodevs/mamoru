import { multibaasFrom, type Env } from './env.ts'
import { makeClient, publicTransport, rpcTransport } from './sync/client.ts'
import { syncOnce } from './sync/run.ts'

type ScheduledEvent = { cron: string; scheduledTime: number }
type Ctx = { waitUntil(promise: Promise<unknown>): void }

export default {
  // No public routes (plan §19.2).
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 })
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: Ctx): Promise<void> {
    if (env.CORE_DRY_RUN !== 'true') {
      console.log(JSON.stringify({ msg: 'sync.refused', code: 'CONFIG_DRY_RUN_REQUIRED' }))
      return
    }
    const { transport, keyed } = rpcTransport(env)
    const mb = multibaasFrom(env)
    console.log(JSON.stringify({ msg: 'sync.start', rpc: keyed ? 'keyed' : 'public', multibaas: mb ? 'configured' : 'not_configured' }))
    ctx.waitUntil(syncOnce({ client: makeClient(transport), logsClient: makeClient(publicTransport(env)), db: env.DB, chainId: Number(env.CHAIN_ID), now: () => new Date(), ...(mb ?? {}) }))
  },
}
