import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiError, ReasonCode } from '@mamoru/domain'

/** App-local codes not (yet) in the domain catalog. */
export type LocalCode = 'OPERATOR_UNAVAILABLE' | 'BODY_TOO_LARGE' | 'AUTH_SIGNIN_FAILED' | 'AUTH_RATE_LIMITED' | 'ONB_PASSKEY_REFUSED'

export function apiError(c: Context, status: ContentfulStatusCode, error: string, code?: ReasonCode | LocalCode) {
  const body: ApiError = code ? { error, code } : { error }
  return c.json(body, status)
}

/** Unknown or foreign account: the same 404 either way, so a key never leaks whether it exists (TEN). */
export function accountNotFound(c: Context) {
  return apiError(c, 404, 'Account not found.')
}
