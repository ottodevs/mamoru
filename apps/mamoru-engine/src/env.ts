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
}
