import { join } from 'node:path'
import { $ } from 'bun'
import { createPublicClient, http } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { BASE_CHAIN_ID } from '@mamoru/domain'
import { LIVE_CAP_USDC } from '@mamoru/account/live'
import { POLICIES, withTestOverrides, type PolicyVersion } from '@mamoru/policy'
import { rpcBudget } from './budget.ts'
import { startLiveBundler } from './bundler.ts'
import { RpcMetrics } from './metrics.ts'
import { Operator, type OperatorConfig } from './operator.ts'
import { Relayer } from './relayer.ts'
import { startRpcProxy } from './rpc-proxy.ts'
import { startServer } from './server.ts'
import { readSnapshot, SnapshotLoop, snapshotIntervalMs, type Snapshot } from './snapshot.ts'
import { MULTICALL3 } from '@mamoru/rpc'
import { StateStore, loadOrCreateKey } from './state.ts'
import { EntryStore, withHoldValue } from './yield-entries.ts'

/** Wraps a snapshot reader with #129's hold-value baseline, stored in its own file under `stateDir`. */
function withYieldLedger(stateDir: string, read: () => Promise<Snapshot>): () => Promise<Snapshot> {
  const entries = new EntryStore(stateDir)
  return async () => withHoldValue(await read(), entries)
}

/** `git rev-parse --short HEAD` at the operator's cwd, read once at boot. 'unknown' outside a git checkout. */
async function gitShaOnce(cwd: string): Promise<string> {
  try {
    return (await $`git rev-parse --short HEAD`.cwd(cwd).quiet().text()).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

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
  /** MAMORU_CAP_USDC, whole USDC (otto/mamoru#127); absent: LIVE_CAP_USDC. */
  capUsdc?: string
  /** MAMORU_DEPTH = `impactBps,shareBps[,stablesImpactBps]` (otto/mamoru#127); absent: depth sizing off. */
  depth?: string
}

/** Whole USDC from the env, as base units; refuses anything that is not a positive whole number up to 1e9. */
export function parseCapUsdc(v: string | undefined): bigint | undefined {
  if (v === undefined || v === '') return undefined
  if (!/^[1-9][0-9]{0,8}$/.test(v)) throw new Error(`MAMORU_CAP_USDC must be a whole number of USDC, 1 to 999999999: ${v}`)
  return BigInt(v) * 1_000_000n
}

/** `impactBps,shareBps[,stablesImpactBps]`, integers: impact 1 to 500 bps, share 1 to 5000 bps. */
export function parseDepth(v: string | undefined): OperatorConfig['depth'] {
  if (v === undefined || v === '') return undefined
  const parts = v.split(',').map((x) => x.trim())
  if (parts.length < 2 || parts.length > 3 || !parts.every((x) => /^[0-9]+$/.test(x))) throw new Error(`MAMORU_DEPTH must be impactBps,shareBps[,stablesImpactBps]: ${v}`)
  const [impact, share, stables] = parts.map(Number) as [number, number, number | undefined]
  const okImpact = (n: number) => n >= 1 && n <= 500
  if (!okImpact(impact) || share < 1 || share > 5000 || (stables !== undefined && !okImpact(stables))) throw new Error(`MAMORU_DEPTH out of range: ${v}`)
  return { maxImpactBps: impact, maxShareBps: share, ...(stables === undefined ? {} : { maxImpactBpsByPool: { 'pool:USDC/USDT/100': stables } }) }
}

/**
 * A cap above LIVE_CAP_USDC only with depth sizing on: without it, a large account would be entered as the 100 USDC
 * accounts are, whatever the pool can take. Accounts activated before keep the session limits they signed; only new
 * activations (and, in phase 2, an extend approval) get limits sized from the new cap.
 */
export function capAndDepth(o: Pick<BootOptions, 'capUsdc' | 'depth'>, policy: PolicyVersion): Pick<OperatorConfig, 'capUsdc' | 'depth'> {
  const capUsdc = parseCapUsdc(o.capUsdc)
  const depth = parseDepth(o.depth)
  if (capUsdc !== undefined && capUsdc > LIVE_CAP_USDC && !depth) throw new Error('MAMORU_CAP_USDC above the default cap needs MAMORU_DEPTH')
  // Depth sizing applies to target-weights policies only: under any other, a raised cap would be entered unsized.
  if (capUsdc !== undefined && capUsdc > LIVE_CAP_USDC && policy.allocation !== 'target-weights') throw new Error(`MAMORU_CAP_USDC above the default cap needs a target-weights policy, not ${policy.policyId}`)
  return { ...(capUsdc === undefined ? {} : { capUsdc }), ...(depth ? { depth } : {}) }
}

/** Starts the operator: relayer key, state, loopback bundler, HTTP server, and the engine loops that were active. */
export async function bootOperator(o: BootOptions) {
  const bootedAt = Date.now()
  const gitSha = await gitShaOnce(process.cwd())
  const rpcMetrics = new RpcMetrics(o.stateDir)
  // Every RPC call of the operator, engine and bundler goes through the loopback proxy (getLogs splitting, no keyed URL in errors).
  const proxy = startRpcProxy(o.rpcUrl, { metrics: rpcMetrics })
  // One path per component, for the counters only: the proxy serves them all the same way.
  const via = (component: string) => `${proxy.url}c/${component}`
  o = { ...o, rpcUrl: via('engine') }
  const client = createPublicClient({ transport: http(via('operator'), { batch: true, timeout: 60_000 }) })
  const watchClient = createPublicClient({ transport: http(via('watcher'), { batch: true, timeout: 60_000 }) })
  const chainId = await client.getChainId()
  const live = chainId === BASE_CHAIN_ID && process.env.MAMORU_LIVE === '1'
  const named = POLICIES[o.policyId ?? 'conservador-live-v2']
  if (!named) throw new Error(`unknown policy ${o.policyId}`)
  // Test-only (MAMORU_TEST_OVERRIDES=1): the fork E2E may shorten the re-range cooldown.
  const policy = withTestOverrides(named, process.env)
  const store = new StateStore(o.stateDir)
  // The relayer's own reads (gas estimate, nonce, the wait for a receipt) are counted as the relayer's, like its sends.
  const relayerClient = createPublicClient({ transport: http(via('relayer'), { batch: true, timeout: 60_000 }) })
  const relayer = new Relayer(loadOrCreateKey(join(o.stateDir, 'relayer.key'), generatePrivateKey), relayerClient, via('relayer'), chainId)
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
      rpcBudget: rpcBudget(rpcMetrics),
      watchClient,
      ...capAndDepth(o, policy),
    },
    client,
    relayer,
    store,
  )
  // otto/mamoru#136 phase 1: one read of every served Safe and its pools, served on GET /snapshot. Off unless MAMORU_SNAPSHOT=1;
  // nothing decides from it yet.
  let snapshot: SnapshotLoop | null = null
  // Base only for now: the reader takes pools and token addresses from the Base registry (chain.ts USDC_POOLS).
  if (process.env.MAMORU_SNAPSHOT === '1' && MULTICALL3 && chainId === BASE_CHAIN_ID) {
    const snapshotClient = createPublicClient({ transport: http(via('snapshot'), { batch: true, timeout: 60_000 }) })
    const multicall3 = MULTICALL3
    const budget = rpcBudget(rpcMetrics)
    const read = (): Promise<Snapshot> => readSnapshot(snapshotClient, multicall3, chainId, operator.snapshotTargets())
    // otto/mamoru#129: adds each position's hold-value baseline for /ops and the app's "earned so far". Its own
    // flag: MAMORU_SNAPSHOT alone must keep behaving exactly as #136 shipped it.
    const withYield = process.env.MAMORU_YIELD_LEDGER === '1' ? withYieldLedger(o.stateDir, read) : read
    snapshot = new SnapshotLoop(withYield, snapshotIntervalMs(process.env.MAMORU_SNAPSHOT_MS), () => budget.over())
    snapshot.start()
  }
  const server = startServer(operator, { secret: o.secret, hostname: o.hostname ?? '127.0.0.1', port: o.port ?? 8787, rpcMetrics, gitSha, bootedAt, snapshot })
  const eth = await client.getBalance({ address: relayer.address })
  console.log(`[operator] chain ${chainId} live=${live} policy ${policy.policyId} relayer ${relayer.address} (${eth} wei) sha ${gitSha} on http://${server.hostname}:${server.port}`)
  operator.resume()
  return {
    operator,
    url: `http://${server.hostname}:${server.port}`,
    stop: () => {
      operator.shutdown()
      snapshot?.stop()
      server.stop(true)
      bundler.stop()
      proxy.stop()
      rpcMetrics.persist()
    },
  }
}
