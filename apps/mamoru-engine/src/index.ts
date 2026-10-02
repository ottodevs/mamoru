import { multibaasFrom, type Env } from './env.ts'
import { logSources, makeClient, rpcTransport } from './sync/client.ts'
import { syncOnce } from './sync/run.ts'

type ScheduledEvent = { cron: string; scheduledTime: number }

export default {
  // No public routes (plan §19.2).
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 })
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (env.CORE_DRY_RUN !== 'true') {
      console.log(JSON.stringify({ msg: 'sync.refused', code: 'CONFIG_DRY_RUN_REQUIRED' }))
      return
    }
    const { transport, keyed, served, providers } = rpcTransport(env)
    const mb = multibaasFrom(env)
    console.log(JSON.stringify({ msg: 'sync.start', rpc: keyed ? 'keyed' : 'public', multibaas: mb ? 'configured' : 'not_configured' }))
    await syncOnce({ client: makeClient(transport), logSources: logSources(env), db: env.DB, chainId: Number(env.CHAIN_ID), now: () => new Date(), ...(mb ?? {}) })
    // Position only, never a URL: 0 is the first provider of the list, the keyed one when the secret exists.
    console.log(JSON.stringify({ msg: 'sync.provider', served: served(), providers }))
  },
}
