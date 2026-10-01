import { ReasonError, type IndexHealth, type PoolRef, type PoolView, type ReasonCode } from '@mamoru/domain'
import { conservadorV1, type PolicyVersion } from '@mamoru/policy'
import type { MultiBaasClient } from '@mamoru/multibaas'
import { baseRegistry, entry, readCodeHash, type Registry, type RegistryEntry } from '@mamoru/registry'
import { getAddress, type Address, type PublicClient } from 'viem'
import { insertPoolSnapshot, listAccounts, markRpcUnavailable, previousIndexState, previousPoolView, upsertAccountState, upsertPoolState, upsertSourceState, type SourceStateRow } from '../d1.ts'
import type { D1Like, D1Statement } from '../env.ts'
import { poolReadAbi } from './abis.ts'
import { readAccountState } from './accounts.ts'
import { readHead } from './head.ts'
import { rpcFallback } from './history.ts'
import type { LogSource } from './client.ts'
import { errorInfo, readPoolEventsFrom } from './logs.ts'
import { rateFromSqrtPrice, UNIT_RATE, type Rate } from './math.ts'
import { readPoolSnapshots, snapshotPools } from './pool-snapshot.ts'
import { readPoolState, type PoolState } from './pool-state.ts'
import { MultiBaasPoolIndex } from './multibaas-index.ts'
import { buildPoolView, displayedBlocks, type PoolHistory } from './pool-view.ts'
import type { Anchor } from './provenance.ts'

/** Stats window: 1,800 blocks, about one hour at two seconds per block on Base. */
export const WINDOW_BLOCKS = 1800

/** Pool used only to value WETH and ETH in USDC. It is not a pool of the plan. */
export const VALUATION_POOLS = ['pool:WETH/USDC/3000'] as const


export type SyncDeps = {
  client: PublicClient
  /** eth_getLogs sources in order. Defaults to the state client with 500-block chunks. */
  logSources?: LogSource[]
  db: D1Like
  chainId: number
  now: () => Date
  registry?: Registry
  policy?: PolicyVersion
  /** MultiBaas client when its URL and key are configured. */
  multibaas?: MultiBaasClient
  /** Start block of the index per registry pool name, when known. */
  startBlocks?: ReadonlyMap<string, number>
  windowBlocks?: number
  log?: (line: Record<string, unknown>) => void
  /** Local runs only: adds raw error text to logs. The Worker never sets it. */
  debug?: boolean
}

export type SyncSummary = {
  rpc: 'ok' | 'unavailable'
  code?: ReasonCode
  block?: number
  safeBlock?: number
  index?: IndexHealth['status']
  pools: { name: string; swaps: number | null; liquidity: number | null; identity: 'ok' | 'mismatch' }[]
  accounts: number
  logRequests: number
  /** Rows offered to the pool history this sync; 0 when the read or the write failed. */
  snapshots: number
}

type PoolPlan = { name: string; entry: RegistryEntry; t0: RegistryEntry; t1: RegistryEntry }

function planOf(name: string, registry: Registry): PoolPlan {
  const e = entry(name, registry)
  if (e.kind !== 'pool' || !e.token0 || !e.token1) throw new ReasonError('POLICY_TARGET_NOT_IN_REGISTRY', name)
  return { name, entry: e, t0: entry(e.token0, registry), t1: entry(e.token1, registry) }
}

/** Pool code and both token codes match the registry at `H`. */
async function identityOk(client: PublicClient, p: PoolPlan, block: bigint): Promise<boolean> {
  const hashes = await Promise.all([p.entry, p.t0, p.t1].map((e) => readCodeHash(client, e.address, block)))
  return [p.entry, p.t0, p.t1].every((e, i) => e.codeHash !== null && hashes[i] === e.codeHash)
}

function refOf(p: PoolPlan): PoolRef {
  return { address: p.entry.address, token0: p.t0.name, token1: p.t1.name, fee: p.entry.fee ?? 0, tickSpacing: p.entry.tickSpacing ?? 0, name: p.name }
}

/** USDC rate of the other token of a USDC pool, from its price. */
function addRate(rates: Map<string, Rate>, p: PoolPlan, sqrtPriceX96: bigint | null): void {
  if (sqrtPriceX96 === null || sqrtPriceX96 === 0n) return
  if (p.t0.name === 'USDC') rates.set(p.t1.name, rateFromSqrtPrice(sqrtPriceX96, false))
  else if (p.t1.name === 'USDC') rates.set(p.t0.name, rateFromSqrtPrice(sqrtPriceX96, true))
}

async function blockTimes(client: PublicClient, blocks: number[]): Promise<Map<number, string>> {
  const got = await Promise.all(blocks.map((n) => client.getBlock({ blockNumber: BigInt(n) })))
  return new Map(got.map((b) => [Number(b.number), new Date(Number(b.timestamp) * 1000).toISOString()]))
}

/** One sync of the Base read model: head, plan pools, accounts, source health (plan §23, sprint cadence). */
export async function syncOnce(deps: SyncDeps): Promise<SyncSummary> {
  const { client, db, chainId } = deps
  const registry = deps.registry ?? baseRegistry
  const policy = deps.policy ?? conservadorV1
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)))
  const observedAt = deps.now().toISOString()
  const W = deps.windowBlocks ?? WINDOW_BLOCKS

  const notConfigured: Omit<IndexHealth, 'provider'> = { status: 'not_configured', checkedAt: observedAt }
  const sourceRow = (h: Omit<IndexHealth, 'provider'>): Omit<SourceStateRow, 'rpcStatus' | 'block' | 'safeBlock'> => ({
    chainId, observedAt, indexProvider: 'multibaas', indexStatus: h.status, indexBlock: h.indexedBlock ?? null, indexCode: h.code ?? null, indexCheckedAt: h.checkedAt,
  })

  let head
  try {
    head = await readHead(client, chainId)
  } catch (err) {
    const code: ReasonCode = err instanceof ReasonError ? err.code : 'OBS_RPC_UNAVAILABLE'
    await markRpcUnavailable(db, chainId, observedAt, Boolean(deps.multibaas)).run()
    log({ msg: 'sync.rpc_unavailable', code })
    return { rpc: 'unavailable', code, pools: [], accounts: 0, logRequests: 0, snapshots: 0 }
  }

  const anchor: Anchor = { chainId, blockNumber: head.safe.number, blockHash: head.safe.hash, observedAt }
  const H = BigInt(anchor.blockNumber)
  const index = deps.multibaas
    ? new MultiBaasPoolIndex(deps.multibaas, { chainId, now: deps.now(), previous: await previousIndexState(db, chainId), startBlocks: deps.startBlocks })
    : null
  if (index) await index.begin(anchor)

  const planPools = [...new Set(policy.buckets.flatMap((b) => b.pools))].map((n) => planOf(n, registry))
  const valuationPools = VALUATION_POOLS.map((n) => planOf(n, registry))

  // Identity and state of every pool at H.
  const read = async (p: PoolPlan, full: boolean) => {
    const ok = await identityOk(client, p, H)
    if (!ok) return { p, ok, state: null as PoolState | null }
    const state = full
      ? await readPoolState(client, p.entry.address, p.t0.address, p.t1.address, H, policy.execution.twapWindowSeconds)
      : { sqrtPriceX96: (await client.readContract({ address: p.entry.address, abi: poolReadAbi, functionName: 'slot0', blockNumber: H }))[0], tick: null, liquidity: null, twapTick: null, balance0: null, balance1: null }
    return { p, ok, state }
  }
  const [planReads, valuationReads] = await Promise.all([
    Promise.all(planPools.map((p) => read(p, true))),
    Promise.all(valuationPools.map((p) => read(p, false).catch(() => ({ p, ok: false, state: null })))),
  ])
  const rates = new Map<string, Rate>([['USDC', UNIT_RATE]])
  for (const r of [...planReads, ...valuationReads]) addRate(rates, r.p, r.state?.sqrtPriceX96 ?? null)

  const statements: D1Statement[] = []
  const summaryPools: SyncSummary['pools'] = []
  let logRequests = 0
  const sources = deps.logSources ?? [{ name: 'state', client, maxRange: 500 }]
  const from = anchor.blockNumber - W + 1

  for (const { p, ok, state } of planReads) {
    let history: PoolHistory | null = null
    let historyCode: ReasonCode | undefined
    let source: 'chain_rpc' | 'multibaas' = 'chain_rpc'
    // The window starts where the log source could read from; a short-range fallback shortens it.
    let window = { fromBlock: from, toBlock: anchor.blockNumber }
    if (ok) {
      let stage = 'logs'
      try {
        const read = await readPoolEventsFrom(sources, p.entry.address, from, anchor.blockNumber)
        logRequests += read.requests
        window = { fromBlock: read.fromBlock, toBlock: anchor.blockNumber }
        log({ msg: 'sync.logs', pool: p.name, source: read.source, fromBlock: read.fromBlock, events: read.events.length, requests: read.requests, failures: read.failures })
        stage = 'index'
        const resolved = index
          ? await index.resolve({ pool: p.entry, from: read.fromBlock, to: anchor.blockNumber, rpc: read.events, anchor, previous: await previousPoolView(db, chainId, p.entry.address) })
          : { ...rpcFallback(read.events, anchor), source: 'chain_rpc' as const }
        source = resolved.source
        stage = 'block_times'
        history = { events: resolved.events, window: resolved.window, blockTimes: await blockTimes(client, displayedBlocks(resolved.events)) }
      } catch (err) {
        // Error class, HTTP status and RPC code only: messages can carry the RPC URL.
        const failures = (err as { failures?: unknown }).failures
        log({ msg: 'sync.history_failed', pool: p.name, stage, ...errorInfo(err), ...(failures ? { failures } : {}), ...(deps.debug ? { debug: String(err) } : {}) })
        historyCode = 'OBS_RPC_UNAVAILABLE'
      }
    }
    const view: PoolView = buildPoolView({
      ref: refOf(p),
      token0: { symbol: p.t0.name, decimals: p.t0.decimals ?? 0 },
      token1: { symbol: p.t1.name, decimals: p.t1.decimals ?? 0 },
      anchor,
      state,
      identityCode: ok ? undefined : 'PURGA_IDENTITY_MISMATCH',
      history,
      historyCode,
      window,
      rates,
      maxTwapDeviationTicks: policy.execution.maxTwapDeviationTicks,
    })
    statements.push(upsertPoolState(db, anchor, source, view))
    summaryPools.push({
      name: p.name,
      identity: ok ? 'ok' : 'mismatch',
      swaps: view.stats.swaps.value,
      liquidity: view.stats.added.count.value === null || view.stats.removed.count.value === null ? null : view.stats.added.count.value + view.stats.removed.count.value,
    })
  }

  // Accounts: read only, never written here except their chain projection.
  const accounts = await listAccounts(db, chainId)
  const tokens = { USDC: entry('USDC', registry).address, cbBTC: entry('cbBTC', registry).address, WETH: entry('WETH', registry).address }
  let accountsRead = 0
  for (const a of accounts) {
    let address: Address
    try {
      address = getAddress(a.address)
    } catch {
      continue
    }
    try {
      const s = await readAccountState(client, address, tokens, anchor, rates)
      statements.push(upsertAccountState(db, anchor, a.account_key, s))
      accountsRead++
    } catch {
      // Keeps the last projection; the API shows it stale by age.
    }
  }

  const health = index ? index.health() : notConfigured
  statements.push(upsertSourceState(db, { ...sourceRow(health), rpcStatus: 'ok', block: head.latest.number, safeBlock: head.safe.number }))
  await db.batch(statements)

  // Pool history for the Lab. Its own batch, after the read model: a failure here never costs the projection.
  let snapshots = 0
  try {
    const pools = snapshotPools(registry)
    const rows = await readPoolSnapshots(client, pools, anchor)
    // viem reports a reverted aggregate as every call failed, not as a throw.
    if (rows.length < pools.length) log({ msg: 'sync.snapshots_partial', read: rows.length, pools: pools.length })
    if (rows.length > 0) await db.batch(rows.map((r) => insertPoolSnapshot(db, anchor, head.safe.timestamp, head.safe.baseFeePerGas, r)))
    snapshots = rows.length
  } catch (err) {
    log({ msg: 'sync.snapshots_failed', ...errorInfo(err), ...(deps.debug ? { debug: String(err) } : {}) })
  }

  const summary: SyncSummary = {
    rpc: 'ok', block: head.latest.number, safeBlock: head.safe.number, index: health.status, pools: summaryPools, accounts: accountsRead, logRequests, snapshots,
  }
  log({ msg: 'sync.done', block: summary.block, safeBlock: summary.safeBlock, index: summary.index, pools: summaryPools, accounts: accountsRead, accountsTotal: accounts.length, logRequests, snapshots, mbCalls: index?.calls ?? 0, mbOnlyRows: index?.mbOnly ?? 0 })
  return summary
}
