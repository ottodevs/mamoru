import { createPublicClient, createTransport, http, type PublicClient, type Transport } from 'viem'
import { base } from 'viem/chains'
import type { Env } from '../env.ts'

type FetchFn = typeof fetch

const stateHttp = (url: string, retryCount: number, fetchFn?: FetchFn) => http(url, { batch: { batchSize: 10, wait: 0 }, retryCount, timeout: 15_000, ...(fetchFn ? { fetchFn } : {}) })

/** A node answer about the call itself (a revert, a rejected transaction): asking another provider would say the same. */
function isCallError(err: unknown): boolean {
  for (let e = err as { code?: unknown; message?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (typeof e.message === 'string' && /execution reverted/i.test(e.message)) return true
    if (e.code === 3 || e.code === -32003 || e.code === 4001 || e.code === 5000) return true
  }
  return false
}

/**
 * `first` until it fails once, then `second` for the rest of this transport's life. The engine builds one transport
 * per sync, so a provider that is out of quota costs one failed request per sync, not one per read, and every read
 * after the failure comes from the same provider.
 */
export function stickyFallback(first: Transport, second: Transport): Transport {
  return (opts) => {
    const a = first({ ...opts, retryCount: 0 })
    const b = second(opts)
    let failed = false
    const request = (async (args: Parameters<typeof a.request>[0]) => {
      if (!failed) {
        try {
          return await a.request(args)
        } catch (err) {
          if (isCallError(err)) throw err
          failed = true
        }
      }
      return b.request(args)
    }) as typeof a.request
    return createTransport({ key: 'stickyFallback', name: 'Sticky fallback', type: 'fallback', retryCount: 0, request })
  }
}

/**
 * Keyed RPC first when the secret exists, with the public endpoint behind it. A keyed provider that is out of quota
 * or down answers every request with an error; without the public endpoint the read model stops until someone
 * changes the secret. The sync checks the hash of its anchor block again before it writes, so a sync that changed
 * provider halfway never records one provider's reads under the other's block. JSON-RPC batching keeps subrequests low.
 */
export function rpcTransport(env: Pick<Env, 'BASE_RPC_URL' | 'BASE_RPC_PUBLIC'>, fetchFn?: FetchFn): { transport: Transport; keyed: boolean } {
  const keyed = Boolean(env.BASE_RPC_URL)
  const publicRpc = stateHttp(env.BASE_RPC_PUBLIC, 1, fetchFn)
  return { transport: env.BASE_RPC_URL ? stickyFallback(stateHttp(env.BASE_RPC_URL, 0, fetchFn), publicRpc) : publicRpc, keyed }
}

/** Always the public RPC. */
export function publicTransport(env: Pick<Env, 'BASE_RPC_PUBLIC'>): Transport {
  return http(env.BASE_RPC_PUBLIC, { batch: { batchSize: 10, wait: 0 }, retryCount: 1, timeout: 15_000 })
}

/**
 * Where eth_getLogs goes, tried in order until one answers the whole range.
 * `maxRange` is the widest range the provider accepts; `maxWindow` caps the window when the range is tiny.
 * Measured 2026-09-26: publicnode and mainnet.base.org accept 2,000 blocks; Alchemy free 10.
 * Rejected: drpc (fails parallel 100-block chunks), 1rpc (50), blastapi (10), llamarpc and omniatech (5xx), meowrpc (no getLogs).
 */
export type LogSource = { name: string; client: PublicClient; maxRange: number; maxWindow?: number }

// No JSON-RPC batching for logs: one range per request keeps provider errors per chunk.
const logsHttp = (url: string) => http(url, { retryCount: 1, timeout: 15_000 })

export const PUBLIC_LOG_PROVIDERS = [
  { name: 'publicnode', url: 'https://base-rpc.publicnode.com', maxRange: 1000 },
  { name: 'base-public', url: 'https://mainnet.base.org', maxRange: 500 },
] as const

export function logSources(env: Pick<Env, 'BASE_LOGS_RPC_URL' | 'BASE_RPC_URL'>): LogSource[] {
  const sources: LogSource[] = []
  if (env.BASE_LOGS_RPC_URL) sources.push({ name: 'configured', client: makeClient(logsHttp(env.BASE_LOGS_RPC_URL)), maxRange: 1000 })
  for (const p of PUBLIC_LOG_PROVIDERS) sources.push({ name: p.name, client: makeClient(logsHttp(p.url)), maxRange: p.maxRange })
  // Last resort: the keyed free tier, 10 blocks per request, batched, over a shorter window.
  if (env.BASE_RPC_URL) {
    sources.push({ name: 'keyed', client: makeClient(http(env.BASE_RPC_URL, { batch: { batchSize: 10, wait: 0 }, retryCount: 1, timeout: 15_000 })), maxRange: 10, maxWindow: 300 })
  }
  return sources
}

export function makeClient(transport: Transport): PublicClient {
  return createPublicClient({ chain: base, transport }) as PublicClient
}
