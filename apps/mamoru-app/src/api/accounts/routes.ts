import { LIVE_BANNER } from '@mamoru/domain'
import { liveFunds } from '../env.ts'
import { Hono } from 'hono'
import type { AppEnv } from '../context.ts'
import { accountNotFound, apiError } from '../errors.ts'
import { ACCOUNT_KEY } from '../onboarding/account.ts'
import { buildDashboard, loadDashboardInput } from './dashboard.ts'
import { ownedAccount } from './store.ts'

export const accounts = new Hono<AppEnv>()

// TEN: an account is reachable only from the session that owns it; anything else is the same 404.
accounts.get('/:accountKey/dashboard', async (c) => {
  const session = await c.var.auth.current(c)
  if (!session) return apiError(c, 401, 'Sign in first.', 'AUTH_REQUIRED')
  const accountKey = c.req.param('accountKey')
  if (!ACCOUNT_KEY.test(accountKey)) return accountNotFound(c)
  const account = await ownedAccount(c.env.DB, session.userId, accountKey)
  if (!account) return accountNotFound(c)
  const payload = buildDashboard(await loadDashboardInput(c.env.DB, account), c.var.now())
  if (liveFunds(c.env)) payload.banner = { ...payload.banner, kind: 'live', text: LIVE_BANNER }
  return c.json(payload)
})
