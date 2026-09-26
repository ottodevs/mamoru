import { Hono } from 'hono'
import { PRODUCTION_BANNER, LIVE_BANNER, type AppConfig, type SessionView } from '@mamoru/domain'
import type { AppEnv } from './context.ts'
import { ConfigError, liveFunds, readSettings } from './env.ts'
import { apiError } from './errors.ts'
import { DeviceSessionAuth } from './auth/device-session.ts'
import { sameOrigin } from './middleware/origin.ts'
import { onboarding } from './onboarding/routes.ts'
import { accountOfUser } from './accounts/store.ts'
import { accounts } from './accounts/routes.ts'
import { pools } from './pools/routes.ts'
import { operatorRoutes, type OperatorFetch } from './accounts/operator.ts'
import { apyRoutes } from './apy/routes.ts'
import type { ApyCache, Fetcher } from './apy/source.ts'

export type AppOptions = { now?: () => Date; operatorFetch?: OperatorFetch; apyFetch?: Fetcher; apyCache?: () => ApyCache | null }

/** Hard cap per account in live mode, USDC base units (25 USDC). */
export const LIVE_CAP_USDC = '25000000'

export function createApp(options: AppOptions = {}) {
  const now = options.now ?? (() => new Date())
  const app = new Hono<AppEnv>()

  app.use('/api/*', async (c, next) => {
    let settings
    try {
      settings = readSettings(c.env)
    } catch (e) {
      if (e instanceof ConfigError) return apiError(c, 500, 'The app is misconfigured and refuses to serve.', e.code)
      throw e
    }
    c.set('settings', settings)
    c.set('now', now)
    c.set('auth', new DeviceSessionAuth(c.env.DB, settings.sessionSecret, now))
    c.header('cache-control', 'no-store')
    await next()
  })
  app.use('/api/*', sameOrigin)

  app.get('/api/config', (c) => {
    const base: AppConfig = {
      mode: c.var.settings.mode,
      chainId: c.var.settings.chainId,
      banner: { kind: 'simulation', text: PRODUCTION_BANNER },
      fundsGate: 'closed',
      dryRun: true,
    }
    // Live funds: the operator moves funds; the engine Worker stays read-only (CORE_DRY_RUN unchanged).
    const config: AppConfig = liveFunds(c.env) ? { ...base, banner: { kind: 'live', text: LIVE_BANNER }, fundsGate: 'live', dryRun: false, capUsdc: LIVE_CAP_USDC } : base
    return c.json(config)
  })

  app.get('/api/session', async (c) => {
    const session = await c.var.auth.current(c)
    if (!session) return apiError(c, 401, 'No session yet. It starts with onboarding.', 'AUTH_REQUIRED')
    const account = await accountOfUser(c.env.DB, session.userId)
    const view: SessionView = { ...session, ...(account ? { accountKey: account.account_key } : {}) }
    return c.json(view)
  })

  app.route('/api/onboarding', onboarding)
  app.route('/api/accounts', operatorRoutes(options.operatorFetch ?? ((input, init) => fetch(input, init))))
  app.route('/api/accounts', accounts)
  app.route('/api/pools', pools)
  app.route('/api/apy', apyRoutes(options.apyFetch ?? ((input, init) => fetch(input, init)), options.apyCache))

  app.all('/api/*', (c) => apiError(c, 404, 'No such API route.'))
  app.onError((err, c) => {
    console.error('api error', err instanceof Error ? err.message : String(err))
    return apiError(c, 500, 'Something failed on our side. Try again.')
  })
  return app
}
