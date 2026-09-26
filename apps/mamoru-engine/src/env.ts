import { MultiBaasClient } from '@mamoru/multibaas'

// Worker bindings. Secrets are optional; without them the engine reads the public RPC and skips MultiBaas.

/** The subset of the D1 binding the engine uses. The bun:sqlite adapter in tests implements the same shape. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  run(): Promise<unknown>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

export interface D1Like {
  prepare(sql: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown[]>
}

export type Env = {
  DB: D1Like
  CHAIN_ID: string
  CORE_DRY_RUN: string
  BASE_RPC_PUBLIC: string
  BASE_RPC_URL?: string
  MULTIBAAS_URL?: string
  MULTIBAAS_API_KEY?: string
  /** First block MultiBaas indexes for the curated pool; inferred from the first indexed row when absent. */
  MULTIBAAS_POOL_START_BLOCK?: string
}

/** MultiBaas client and index start blocks from the environment, or nothing when not configured. */
export function multibaasFrom(env: Pick<Env, 'MULTIBAAS_URL' | 'MULTIBAAS_API_KEY' | 'MULTIBAAS_POOL_START_BLOCK'>): { multibaas: MultiBaasClient; startBlocks: Map<string, number> } | null {
  if (!env.MULTIBAAS_URL || !env.MULTIBAAS_API_KEY) return null
  const start = Number(env.MULTIBAAS_POOL_START_BLOCK)
  const startBlocks = new Map<string, number>(Number.isInteger(start) && start > 0 ? [['pool:USDC/cbBTC/500', start]] : [])
  return { multibaas: new MultiBaasClient({ url: env.MULTIBAAS_URL, apiKey: env.MULTIBAAS_API_KEY }), startBlocks }
}
