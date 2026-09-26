import { createPublicClient, http, type PublicClient, type Transport } from 'viem'
import { base } from 'viem/chains'
import type { Env } from '../env.ts'

/** Keyed RPC when the secret exists, public otherwise. JSON-RPC batching keeps subrequests low. */
export function rpcTransport(env: Pick<Env, 'BASE_RPC_URL' | 'BASE_RPC_PUBLIC'>): { transport: Transport; keyed: boolean } {
  const keyed = Boolean(env.BASE_RPC_URL)
  const url = env.BASE_RPC_URL || env.BASE_RPC_PUBLIC
  return { transport: http(url, { batch: { batchSize: 10, wait: 0 }, retryCount: 1, timeout: 15_000 }), keyed }
}

/** Always the public RPC: used for eth_getLogs ranges. */
export function publicTransport(env: Pick<Env, 'BASE_RPC_PUBLIC'>): Transport {
  return http(env.BASE_RPC_PUBLIC, { batch: { batchSize: 10, wait: 0 }, retryCount: 1, timeout: 15_000 })
}

export function makeClient(transport: Transport): PublicClient {
  return createPublicClient({ chain: base, transport }) as PublicClient
}
