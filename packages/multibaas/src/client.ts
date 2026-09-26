// Read-only REST client for MultiBaas /api/v0 (plan §23.4). It never creates, links or deletes anything.
import type { ReasonCode } from '@mamoru/domain'
import type { EventQuery } from './queries.ts'

export class MultiBaasError extends Error {
  readonly code: ReasonCode = 'MB_QUERY_FAILED'
  constructor(readonly path: string, readonly httpStatus: number | null, message: string) {
    super(`${path}: ${message}`)
    this.name = 'MultiBaasError'
  }
}

export type ChainStatus = { chainID: number; blockNumber: number }

export type ContractStatus = {
  startBlockNumber: number
  latestBlockNumber: number
  latestBlockHash: string
  isProcessingPastLogs: boolean
  updatedAt: string
}

export type TxEvent = {
  triggeredAt: string
  event: { name: string; signature: string; inputs: { name: string; value: unknown }[]; contract: { address: string; label?: string; alias?: string }; indexInLog: number }
  transaction: { txHash: string; blockNumber: number; blockHash: string }
}

export type QueryRow = Record<string, unknown>

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export type MultiBaasConfig = {
  url: string
  apiKey: string
  pageLimit?: number
  /** Stop paging after this many pages; the caller treats a cut result as a failed query. */
  maxPages?: number
  fetch?: Fetcher
}

// Largest `limit` the deployment accepts (MB-02, 2026-09-26: 51 is rejected).
export const MB_PAGE_LIMIT = 50

type Envelope<T> = { status: number; message: string; result: T }

export class MultiBaasClient {
  private readonly base: string
  private readonly fetcher: Fetcher
  readonly pageLimit: number
  readonly maxPages: number
  requests = 0

  constructor(private readonly config: MultiBaasConfig) {
    this.base = `${config.url.replace(/\/+$/, '')}/api/v0`
    // Workers reject a fetch detached from globalThis (Illegal invocation), so the default is wrapped.
    this.fetcher = config.fetch ?? ((input, init) => fetch(input, init))
    this.pageLimit = config.pageLimit ?? MB_PAGE_LIMIT
    this.maxPages = config.maxPages ?? 10
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    this.requests++
    let res: Response
    try {
      res = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      throw new MultiBaasError(path, null, err instanceof Error ? err.name : 'network')
    }
    let env: Envelope<T>
    try {
      env = (await res.json()) as Envelope<T>
    } catch {
      throw new MultiBaasError(path, res.status, 'invalid json')
    }
    if (!res.ok || env.status !== 200) throw new MultiBaasError(path, res.status, env.message ?? `status ${env.status}`)
    return env.result
  }

  chainStatus(): Promise<ChainStatus> {
    return this.call('GET', '/chains/ethereum/status')
  }

  contractStatus(alias: string, label: string): Promise<ContractStatus> {
    return this.call('GET', `/chains/ethereum/addresses/${encodeURIComponent(alias)}/contracts/${encodeURIComponent(label)}/status`)
  }

  /** Arbitrary event query, not saved in the deployment. All pages until one is short. */
  async query(body: EventQuery): Promise<QueryRow[]> {
    const rows: QueryRow[] = []
    for (let page = 0; page < this.maxPages; page++) {
      const offset = page * this.pageLimit
      const result = await this.call<{ rows: QueryRow[] }>('POST', `/queries?limit=${this.pageLimit}&offset=${offset}`, body)
      rows.push(...result.rows)
      if (result.rows.length < this.pageLimit) return rows
    }
    throw new MultiBaasError('/queries', null, `more than ${this.maxPages} pages`)
  }

  /** MBQ-06: decoded events of one transaction on the linked contracts. */
  txEvents(txHash: string): Promise<TxEvent[]> {
    return this.call('GET', `/events?tx_hash=${encodeURIComponent(txHash)}&limit=${this.pageLimit}`)
  }
}
