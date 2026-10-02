import { createPublicClient, createTransport, http, type PublicClient, type Transport } from 'viem'
import { base } from 'viem/chains'
import type { Env } from '../env.ts'

type FetchFn = typeof fetch

const stateHttp = (url: string, retryCount: number, fetchFn?: FetchFn) => http(url, { batch: { batchSize: 10, wait: 0 }, retryCount, timeout: 15_000, ...(fetchFn ? { fetchFn } : {}) })

/** JSON-RPC codes that describe the request, not the provider: parse, invalid request, unknown method, invalid params, rejected transaction. */
const CALL_ERROR_CODES: readonly unknown[] = [3, -32700, -32600, -32601, -32602, -32003, 4001, 5000]

/** A node answer about the call itself (a revert, a method or parameters it does not accept): another provider would say the same. */
function isCallError(err: unknown): boolean {
  for (let e = err as { code?: unknown; message?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (typeof e.message === 'string' && /execution reverted/i.test(e.message)) return true
    if (CALL_ERROR_CODES.includes(e.code)) return true
  }
  return false
}

/**
 * The transports in order: each one until it fails once, then the next for the rest of this transport's life. The
 * engine builds one transport per sync, so a provider that is out of quota or refuses the Worker costs one failed
 * request per sync, not one per read, and every read after a failure comes from the same provider. `onSwitch` hears
 * the position of the provider that takes over.
 */
export function stickyFallback(transports: readonly Transport[], onSwitch?: (index: number) => void): Transport {
  if (transports.length === 0) throw new Error('stickyFallback needs at least one transport')
  return (opts) => {
    // Only the last one keeps its own retries: before it, the next provider is the retry.
    const built = transports.map((t, i) => t(i < transports.length - 1 ? { ...opts, retryCount: 0 } : opts))
    let at = 0
    const request = (async (args: Parameters<(typeof built)[0]['request']>[0]) => {
      for (;;) {
        const used = at
        try {
          return await built[used]!.request(args)
        } catch (err) {
          if (isCallError(err) || used === built.length - 1) throw err
          // The requests of one batch fail together: only the first of them moves on, the others follow it.
          if (at === used) {
            at = used + 1
            onSwitch?.(at)
          }
        }
      }
    }) as (typeof built)[0]['request']
    return createTransport({ key: 'stickyFallback', name: 'Sticky fallback', type: 'fallback', retryCount: 0, request })
  }
}

/** The public endpoints of `BASE_RPC_PUBLIC`: one URL or several separated by commas, tried in that order. */
export function publicUrls(env: Pick<Env, 'BASE_RPC_PUBLIC'>): string[] {
  return env.BASE_RPC_PUBLIC.split(',').map((u) => u.trim()).filter(Boolean)
}

/**
 * Keyed RPC first when the secret exists, with the public endpoints behind it. A keyed provider that is out of quota
 * or down answers every request with an error, and a public endpoint may refuse the Worker's addresses; with the
 * list behind it the read model keeps going on the first one that answers. The sync checks the hash of its anchor
 * block again before it writes, so a sync that changed provider halfway never records one provider's reads under
 * another's block. JSON-RPC batching keeps subrequests low. `served` is the position of the provider in use.
 */
export function rpcTransport(env: Pick<Env, 'BASE_RPC_URL' | 'BASE_RPC_PUBLIC'>, fetchFn?: FetchFn): { transport: Transport; keyed: boolean; served: () => number; providers: number } {
  const keyed = Boolean(env.BASE_RPC_URL)
  const urls = [...(env.BASE_RPC_URL ? [env.BASE_RPC_URL] : []), ...publicUrls(env)]
  let at = 0
  const transport = stickyFallback(urls.map((url, i) => stateHttp(url, i < urls.length - 1 ? 0 : 1, fetchFn)), (i) => (at = i))
  return { transport, keyed, served: () => at, providers: urls.length }
}

/** Always the public RPC. */
export function publicTransport(env: Pick<Env, 'BASE_RPC_PUBLIC'>): Transport {
  return stickyFallback(publicUrls(env).map((url, i, all) => stateHttp(url, i < all.length - 1 ? 0 : 1)))
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
