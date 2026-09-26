import type { Context } from 'hono'

/**
 * Product login (plan, ProductAuthPort). A login identifies a person; it never
 * signs, never owns the account and has no authority over funds (FR-ONB-001).
 */
export type ProductSession = { userId: string; email?: string }

export interface ProductAuthPort {
  /** The session carried by the request, or null. */
  current(c: Context): Promise<ProductSession | null>
  /** The current session, or a new one bound to the response. */
  ensure(c: Context): Promise<ProductSession>
}
