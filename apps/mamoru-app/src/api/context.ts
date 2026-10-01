import type { AppSettings, Env } from './env.ts'
import type { ProductAuthPort } from './auth/port.ts'

export type AppEnv = {
  Bindings: Env
  // accountKey: set by a route once it resolves the session to an account; read by the activity-tracking middleware.
  Variables: { settings: AppSettings; auth: ProductAuthPort; now: () => Date; accountKey?: string }
}
