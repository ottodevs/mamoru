import { Hono } from 'hono'
import { PRODUCTION_BANNER, type AppConfig, type SessionView } from '@mamoru/domain'
import type { AppEnv } from './context.ts'
import { ConfigError, readSettings } from './env.ts'
import { apiError } from './errors.ts'
import { DeviceSessionAuth } from './auth/device-session.ts'
import { sameOrigin } from './middleware/origin.ts'
import { onboarding } from './onboarding/routes.ts'
import { accountOfUser } from './accounts/store.ts'

export type AppOptions = { now?: () => Date }

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
    const config: AppConfig = {
      mode: c.var.settings.mode,
      chainId: c.var.settings.chainId,
      banner: { kind: 'simulation', text: PRODUCTION_BANNER },
      fundsGate: 'closed',
      dryRun: true,
    }
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

  app.all('/api/*', (c) => apiError(c, 404, 'No such API route.'))
  return app
}
