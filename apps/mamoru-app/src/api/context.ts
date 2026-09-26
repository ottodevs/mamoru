import type { AppSettings, Env } from './env.ts'
import type { ProductAuthPort } from './auth/port.ts'

export type AppEnv = {
  Bindings: Env
  Variables: { settings: AppSettings; auth: ProductAuthPort; now: () => Date }
}
