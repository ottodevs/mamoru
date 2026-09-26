import { BASE_CHAIN_ID, type ReasonCode } from '@mamoru/domain'

// Subset of the D1 API the app uses. Cloudflare D1 and the test adapter both satisfy it.
export type DbValue = string | number | null
export interface DbStatement {
  bind(...values: DbValue[]): DbStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}
export interface Db {
  prepare(sql: string): DbStatement
}

export type Env = {
  DB: Db
  ASSETS?: { fetch(request: Request): Promise<Response> }
  MODE?: string
  CHAIN_ID?: string
  CORE_DRY_RUN?: string
  SESSION_SECRET?: string
}

export type AppSettings = { mode: 'production'; chainId: typeof BASE_CHAIN_ID; sessionSecret: string }

export class ConfigError extends Error {
  constructor(readonly code: ReasonCode, message: string) {
    super(message)
  }
}

const MIN_SECRET_LENGTH = 32

/** The app only runs in production mode on Base with CORE_DRY_RUN=true; anything else refuses every request. */
export function readSettings(env: Env): AppSettings {
  if (env.MODE !== 'production') throw new ConfigError('CONFIG_MODE_INVALID', `MODE must be production, got ${env.MODE ?? 'unset'}`)
  if (env.CHAIN_ID !== String(BASE_CHAIN_ID)) throw new ConfigError('CONFIG_MODE_INVALID', `CHAIN_ID must be ${BASE_CHAIN_ID} in production`)
  if (env.CORE_DRY_RUN !== 'true') throw new ConfigError('CONFIG_DRY_RUN_REQUIRED', 'CORE_DRY_RUN must be true')
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < MIN_SECRET_LENGTH) {
    throw new ConfigError('CONFIG_MODE_INVALID', `SESSION_SECRET must be set, at least ${MIN_SECRET_LENGTH} characters`)
  }
  return { mode: 'production', chainId: BASE_CHAIN_ID, sessionSecret: env.SESSION_SECRET }
}
