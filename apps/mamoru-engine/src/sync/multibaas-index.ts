import type { IndexHealth, PoolView, Provenance, ReasonCode } from '@mamoru/domain'
import { LINKED, poolActivity, type MultiBaasClient, type QueryRow } from '@mamoru/multibaas'
import type { RegistryEntry } from '@mamoru/registry'
import { rpcFallback } from './history.ts'
import type { PoolEvent } from './logs.ts'
import type { SourcedEvent } from './pool-view.ts'
import { rpcAt, type Anchor } from './provenance.ts'

export type Health = Omit<IndexHealth, 'provider'>

/** The index checks run at most this often; in between, rows keep their last labels (Free plan: 30k calls a month). */
export const MB_SYNC_EVERY_SECONDS = 600
/** RPC rows newer than the last indexed row and within this lag of `H` wait for the index instead of mismatching. */
export const MB_MAX_LAG_BLOCKS = 150

export type PreviousIndexState = { status: Health['status']; checkedAt: string; block: number | null; code: string | null }

export type ResolveArgs = { pool: RegistryEntry; from: number; to: number; rpc: PoolEvent[]; anchor: Anchor; previous: PoolView | null }
export type Resolved = { events: SourcedEvent[]; window: Provenance; source: 'chain_rpc' | 'multibaas' }

const lower = (v: unknown) => String(v).toLowerCase()
const int = (v: unknown) => BigInt(String(v)).toString()

/** Multiset key of a row: block hash, tx hash, event and decoded arguments (dashboard.md §6.5). */
export function rpcKey(e: PoolEvent): string {
  const head = [e.blockHash.toLowerCase(), e.txHash.toLowerCase()]
  if (e.kind === 'swap') {
    return [...head, 'Swap', lower(e.sender), lower(e.recipient), e.amount0, e.amount1, e.sqrtPriceX96, e.liquidity, e.tick].join('|')
  }
  return [...head, e.kind === 'mint' ? 'Mint' : 'Burn', lower(e.owner), e.tickLower, e.tickUpper, e.amount, e.amount0, e.amount1].join('|')
}

export function mbKey(r: QueryRow): string | null {
  const kind = String(r.kind ?? '').split('(')[0]
  const head = [lower(r.blockHash), lower(r.txHash)]
  try {
    if (kind === 'Swap') return [...head, kind, lower(r.sender), lower(r.recipient), int(r.amount0), int(r.amount1), int(r.sqrtPriceX96), int(r.liquidity), int(r.tick)].join('|')
    if (kind === 'Mint' || kind === 'Burn') return [...head, kind, lower(r.owner), int(r.tickLower), int(r.tickUpper), int(r.amount), int(r.amount0), int(r.amount1)].join('|')
  } catch {
    return null
  }
  return null
}

const rowKey = (r: { txHash: string; logIndex: number }) => `${r.txHash.toLowerCase()}:${r.logIndex}`

/** Label of the whole window from its rows and from the part of the range the index does not cover. */
export function windowProvenance(anchor: Anchor, rows: Provenance[], coverageCause?: ReasonCode): Provenance {
  const fallback = coverageCause ?? rows.find((p) => p.detail === 'PROJ_SOURCE_FALLBACK_RPC')?.cause
  if (fallback || rows.some((p) => p.detail === 'PROJ_SOURCE_FALLBACK_RPC')) {
    return rpcAt(anchor, fallback ? { detail: 'PROJ_SOURCE_FALLBACK_RPC', cause: fallback } : { detail: 'PROJ_SOURCE_FALLBACK_RPC' })
  }
  if (rows.some((p) => p.check === 'mismatch')) return rpcAt(anchor, { detail: 'PROJ_INDEXER_MISMATCH' })
  if (rows.some((p) => p.detail === 'PROJ_INDEXER_PENDING')) return rpcAt(anchor, { detail: 'PROJ_INDEXER_PENDING' })
  return { ...rpcAt(anchor), source: 'multibaas', detail: 'PROJ_RECONCILED' }
}

/**
 * Pool history from MultiBaas contrasted row by row with RPC logs (dashboard.md §6.5, §6.6).
 * RPC logs are always read; MultiBaas only labels them. Nothing is written to the deployment.
 */
export class MultiBaasPoolIndex {
  private mode: 'contrast' | 'carry' = 'contrast'
  private state: Health
  /** Rows only MultiBaas returned (MB_QUERY_MISMATCH); logged, never stored. */
  mbOnly = 0

  constructor(
    private readonly mb: MultiBaasClient,
    private readonly opts: { chainId: number; now: Date; previous: PreviousIndexState | null; startBlocks?: ReadonlyMap<string, number> },
  ) {
    this.state = { status: 'indexing', checkedAt: opts.now.toISOString() }
  }

  health(): Health {
    return this.state
  }

  get calls(): number {
    return this.mb.requests
  }

  async begin(anchor: Anchor): Promise<void> {
    const prev = this.opts.previous
    if (prev && prev.status !== 'not_configured' && this.opts.now.getTime() - Date.parse(prev.checkedAt) < MB_SYNC_EVERY_SECONDS * 1000) {
      this.mode = 'carry'
      this.state = { status: prev.status, checkedAt: prev.checkedAt, ...(prev.block === null ? {} : { indexedBlock: prev.block }), ...(prev.code ? { code: prev.code as ReasonCode } : {}) }
      return
    }
    try {
      const cs = await this.mb.chainStatus()
      this.state =
        cs.chainID === this.opts.chainId
          ? { status: 'indexing', checkedAt: anchor.observedAt }
          : { status: 'not_indexing_base', code: 'MB_BASE_INDEXING_ABSENT', checkedAt: anchor.observedAt }
    } catch {
      this.state = { status: 'failing', code: 'MB_QUERY_FAILED', checkedAt: anchor.observedAt }
    }
  }

  async resolve(args: ResolveArgs): Promise<Resolved> {
    return this.mode === 'carry' ? this.carry(args) : this.contrast(args)
  }

  private fallback(rpc: PoolEvent[], anchor: Anchor, cause: ReasonCode): Resolved {
    return { ...rpcFallback(rpc, anchor, cause), source: 'chain_rpc' }
  }

  private async contrast({ pool, from, to, rpc, anchor }: ResolveArgs): Promise<Resolved> {
    if (this.state.status === 'not_indexing_base' || this.state.status === 'failing') return this.fallback(rpc, anchor, this.state.code ?? 'MB_QUERY_FAILED')
    if (!LINKED[pool.name]) return this.fallback(rpc, anchor, 'MB_BASE_INDEXING_ABSENT')
    const configured = this.opts.startBlocks?.get(pool.name)
    const qFrom = Math.max(from, configured ?? from)
    if (qFrom > to) return this.fallback(rpc, anchor, 'MB_BEFORE_START_BLOCK')

    let rows: QueryRow[]
    try {
      rows = await this.mb.query(poolActivity(pool.address, qFrom, to))
    } catch {
      this.state = { status: 'failing', code: 'MB_QUERY_FAILED', checkedAt: anchor.observedAt }
      return this.fallback(rpc, anchor, 'MB_QUERY_FAILED')
    }
    const blocks = rows.map((r) => Number(r.block)).filter(Number.isFinite)
    // Without a configured start, the first indexed row marks where the index begins.
    const start = configured ?? (blocks.length ? Math.min(...blocks) : qFrom)
    const lastIndexed = blocks.length ? Math.max(...blocks) : null
    const counts: Map<string, number> = new Map()
    for (const r of rows) {
      const k = mbKey(r)
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
      else this.mbOnly++
    }

    let lagging = false
    const events: SourcedEvent[] = rpc.map((e) => {
      const at = { blockNumber: e.block, blockHash: e.blockHash }
      if (e.block < start) return { ...e, provenance: rpcAt(anchor, { ...at, detail: 'PROJ_SOURCE_FALLBACK_RPC', cause: 'MB_BEFORE_START_BLOCK' }) }
      const k = rpcKey(e)
      const n = counts.get(k) ?? 0
      if (n > 0) {
        counts.set(k, n - 1)
        return { ...e, provenance: { ...rpcAt(anchor, at), source: 'multibaas', check: 'reconciled', checkedAt: to } }
      }
      if (lastIndexed === null || e.block > lastIndexed) {
        if (e.block > to - MB_MAX_LAG_BLOCKS) return { ...e, provenance: rpcAt(anchor, { ...at, detail: 'PROJ_INDEXER_PENDING' }) }
        lagging = true
        return { ...e, provenance: rpcAt(anchor, { ...at, detail: 'PROJ_SOURCE_FALLBACK_RPC', cause: 'MB_INDEX_LAGGING' }) }
      }
      return { ...e, provenance: rpcAt(anchor, { ...at, check: 'mismatch', detail: 'PROJ_INDEXER_MISMATCH' }) }
    })
    for (const n of counts.values()) this.mbOnly += n

    this.state = lagging
      ? { status: 'behind', code: 'MB_INDEX_LAGGING', checkedAt: anchor.observedAt, ...(lastIndexed === null ? {} : { indexedBlock: lastIndexed }) }
      : { status: 'indexing', checkedAt: anchor.observedAt, indexedBlock: to }
    const window = windowProvenance(anchor, events.map((e) => e.provenance), from < start ? 'MB_BEFORE_START_BLOCK' : undefined)
    const source = events.some((e) => e.provenance.source === 'multibaas') || (events.length === 0 && !lagging) ? 'multibaas' : 'chain_rpc'
    return { events, window, source }
  }

  /** Between index checks: displayed rows keep their last label, newer rows wait for the next check. */
  private carry({ rpc, anchor, previous }: ResolveArgs): Resolved {
    const down = this.state.status === 'not_indexing_base' || this.state.status === 'failing'
    if (down) return this.fallback(rpc, anchor, this.state.code ?? 'MB_QUERY_FAILED')
    const known = new Map<string, Provenance>()
    for (const r of [...(previous?.recentSwaps ?? []), ...(previous?.recentLiquidity ?? [])]) known.set(rowKey(r), r.provenance)
    const events: SourcedEvent[] = rpc.map((e) => {
      const kept = known.get(rowKey(e))
      if (kept && kept.blockHash === e.blockHash) return { ...e, provenance: { ...kept, observedAt: anchor.observedAt } }
      return { ...e, provenance: rpcAt(anchor, { blockNumber: e.block, blockHash: e.blockHash, detail: 'PROJ_INDEXER_PENDING' }) }
    })
    const before = previous?.stats.swaps.provenance.cause === 'MB_BEFORE_START_BLOCK' ? 'MB_BEFORE_START_BLOCK' : undefined
    const window = windowProvenance(anchor, events.map((e) => e.provenance), before)
    return { events, window, source: events.some((e) => e.provenance.source === 'multibaas') ? 'multibaas' : 'chain_rpc' }
  }
}
