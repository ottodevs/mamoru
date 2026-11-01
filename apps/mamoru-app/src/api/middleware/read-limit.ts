import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../context.ts'
import { apiError } from '../errors.ts'
import { sha256 } from '../auth/webauthn.ts'

/**
 * #255: reads of one account, counted per account and client address (ACCOUNT_READ_LIMIT, wrangler.jsonc: 180 per
 * minute). The page reads far less than that, even with a few tabs open and an op in flight (about 50 a minute per
 * tab at its fastest), and its own refresh is throttled; a script reading in a loop gets 429 instead of an operator
 * or D1 read each time. Keyed by address too, so nobody can spend another owner's allowance. Only GETs: an owner
 * action is never refused here. No binding (tests, local runs) or a limiter that does not answer: let through.
 */
export const accountReadLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limiter = c.env.ACCOUNT_READ_LIMIT
  if (c.req.method !== 'GET' || !limiter) return next()
  const h = await sha256(`mamoru:account-read:v1\n${c.var.settings.sessionSecret}\n${c.req.header('cf-connecting-ip') ?? 'unknown'}`)
  const ip = Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
  let ok = true
  try {
    ok = (await limiter.limit({ key: `${c.req.param('accountKey')}:${ip}` })).success
  } catch {
    console.error('account reads: rate limiter did not answer')
  }
  if (ok) return next()
  c.header('retry-after', '60')
  return apiError(c, 429, 'Too many reads of this account. Wait a minute and try again.', 'READ_RATE_LIMITED')
}
