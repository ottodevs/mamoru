import { join } from 'node:path'
import { createPublicClient, http } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { BASE_CHAIN_ID } from '@mamoru/domain'
import { POLICIES } from '@mamoru/policy'
import { startLiveBundler } from './bundler.ts'
import { Operator } from './operator.ts'
import { Relayer } from './relayer.ts'
import { startRpcProxy } from './rpc-proxy.ts'
import { startServer } from './server.ts'
import { StateStore, loadOrCreateKey } from './state.ts'

export type BootOptions = {
  rpcUrl: string
  secret: string
  stateDir: string
  hostname?: string
  port?: number
  policyId?: string
  reviewMs?: number
  waitBlockMs?: number
  maxWaitBlocks?: number
}

/** Starts the operator: relayer key, state, loopback bundler, HTTP server, and the engine loops that were active. */
export async function bootOperator(o: BootOptions) {
  // Every RPC call of the operator, engine and bundler goes through the loopback proxy (getLogs splitting, no keyed URL in errors).
  const proxy = startRpcProxy(o.rpcUrl)
  o = { ...o, rpcUrl: proxy.url }
  const client = createPublicClient({ transport: http(o.rpcUrl, { batch: true, timeout: 60_000 }) })
  const chainId = await client.getChainId()
  const live = chainId === BASE_CHAIN_ID && process.env.MAMORU_LIVE === '1'
  const policy = POLICIES[o.policyId ?? 'conservador-live-v1']
  if (!policy) throw new Error(`unknown policy ${o.policyId}`)
  const store = new StateStore(o.stateDir)
  const relayer = new Relayer(loadOrCreateKey(join(o.stateDir, 'relayer.key'), generatePrivateKey), client, o.rpcUrl, chainId)
  const bundler = startLiveBundler(client, relayer, chainId)
  const operator = new Operator(
    {
      chainId,
      live,
      rpcUrl: o.rpcUrl,
      bundlerUrl: bundler.url,
      policy,
      reviewMs: o.reviewMs ?? 20_000,
      waitBlockMs: o.waitBlockMs ?? 2_100,
      maxWaitBlocks: o.maxWaitBlocks ?? 150,
    },
    client,
    relayer,
    store,
  )
  const server = startServer(operator, { secret: o.secret, hostname: o.hostname ?? '127.0.0.1', port: o.port ?? 8787 })
  const eth = await client.getBalance({ address: relayer.address })
  console.log(`[operator] chain ${chainId} live=${live} policy ${policy.policyId} relayer ${relayer.address} (${eth} wei) on http://${server.hostname}:${server.port}`)
  operator.resume()
  return {
    operator,
    url: `http://${server.hostname}:${server.port}`,
    stop: () => {
      operator.shutdown()
      server.stop(true)
      bundler.stop()
      proxy.stop()
    },
  }
}
