import type { MiddlewareHandler } from 'hono'
import { apiError } from '../errors.ts'

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Every state-changing request must come from the app's own origin (AUTH_ORIGIN_REJECTED). */
export const sameOrigin: MiddlewareHandler = async (c, next) => {
  if (UNSAFE.has(c.req.method)) {
    const origin = c.req.header('origin')
    if (!origin || origin !== new URL(c.req.url).origin) return apiError(c, 403, 'Request refused: it did not come from this app.', 'AUTH_ORIGIN_REJECTED')
  }
  await next()
}
