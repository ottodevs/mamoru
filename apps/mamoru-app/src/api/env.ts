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
  // Live funds (sprint amendment 2026-09-26 21:40): LIVE_FUNDS is a var; OPERATOR_URL and OPERATOR_SECRET are secrets.
  LIVE_FUNDS?: string
  OPERATOR_URL?: string
  OPERATOR_SECRET?: string
  // Secret. Read-only Ethereum Mainnet RPC pool for the wrong-network notice (accounts/other-chains.ts): https URLs
  // separated by commas, tried in order (docs/process/rpc-providers.md). Unset: nothing is read.
  ETHEREUM_RPC_URLS?: string
  // Workers Rate Limiting binding (wrangler.jsonc `ratelimits`): reads of the Ethereum RPC per account, counted per
  // Cloudflare location and not per isolate. Absent in tests and local runs.
  OTHER_CHAINS_LIMIT?: RateLimiter
  // In-app feedback (feedback.ts, otto/mamoru#72). Workers Rate Limiting binding, keyed by device session when
  // there is one, else a hash of the connecting IP. Absent in tests and local runs.
  FEEDBACK_LIMIT?: RateLimiter
  // Mattermost fan-out for feedback (feedback.ts). All secrets, all optional: unset, a row is still stored and
  // nothing is posted. MATTERMOST_BOT_TOKEN is never logged.
  MATTERMOST_URL?: string
  MATTERMOST_BOT_TOKEN?: string
  MATTERMOST_SUPPORT_CHANNEL_ID?: string
  MATTERMOST_FEEDBACK_CHANNEL_ID?: string
}

/** The part of the Workers Rate Limiting binding the app uses. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
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

/** Live funds are on only when the var says so and an operator is configured. */
export function liveFunds(env: Env): boolean {
  return env.LIVE_FUNDS === '1' && !!env.OPERATOR_URL
}
