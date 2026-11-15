// otto/mamoru#419: reads the proxy can answer without asking a provider again.
//
// Two layers, both behind the proxy's own provider rules (an answer is only ever one a trusted provider gave to the same
// request, and eth_getLogs, sends and filters never pass through here):
// - In flight: identical read requests that arrive while the first is still out share its answer. Nothing is kept
//   after it lands, so this is the same as one request answered to every asker at once.
// - Final: an answer pinned to an explicit block number at or below the chain's finalized block, as a trusted provider
//   last reported it, is kept and served again. Reorg safety: a finalized block is never replaced unless the chain's
//   finality itself fails (an L1 finality violation for Base, a BFT safety failure for Monad), so a pinned read there has
//   one right answer forever, the one any honest provider gives. Blocks above it are never kept, however short the
//   time: the engine's hash checks (the pinned block read again at the end of an observation, a cursor's block re-read)
//   always reach a provider, and a reorg under them is seen as before. The finalized head is learned from answers to
//   the `finalized` tag that pass through, and asked for at most every FINAL_REFRESH_MS, only when a pinned read is
//   likely to fall under it.

/** Methods whose answer depends only on their params (no sends, no filters, no logs). */
const READS = new Set([
  'eth_call',
  'eth_getCode',
  'eth_getBalance',
  'eth_getStorageAt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_blockNumber',
  'eth_chainId',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_estimateGas',
  'eth_simulateV1',
])

/** Where each method carries its block (a hex number is the only form kept under `final`). */
const BLOCK_PARAM: Record<string, number> = { eth_call: 1, eth_getCode: 1, eth_getBalance: 1, eth_getStorageAt: 2, eth_getTransactionCount: 1, eth_getBlockByNumber: 0 }

export const FINAL_REFRESH_MS = 60_000
export const READ_CACHE_MAX = 5_000

type Req = { method: string; params?: unknown[] }

export function isRead(method: string): boolean {
  return READS.has(method)
}

/** The explicit block a request is pinned to, or null (a tag, a hash, an object, or none). */
export function pinnedBlock(msg: Req): bigint | null {
  const i = BLOCK_PARAM[msg.method]
  if (i === undefined) return null
  const p = msg.params?.[i]
  return typeof p === 'string' && /^0x[0-9a-fA-F]+$/.test(p) ? BigInt(p) : null
}

export function keyOf(msg: Req): string {
  return `${msg.method}:${JSON.stringify(msg.params ?? [])}`
}

export type ReadCacheStats = { inflightShared: number; finalHits: number; kept: number; finalized: string | null }

export class ReadCache {
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly kept = new Map<string, unknown>()
  private final: bigint | null = null
  /** The head known when `final` was learned: how far finality has likely moved since is the head's move. */
  private headAtFinal: bigint | null = null
  private head: bigint | null = null
  private finalAskedAt = Number.NEGATIVE_INFINITY
  private stats = { inflightShared: 0, finalHits: 0 }

  constructor(
    private readonly askFinalized: () => Promise<unknown>,
    private readonly max = READ_CACHE_MAX,
    private readonly refreshMs = FINAL_REFRESH_MS,
  ) {}

  /** The provider's tip as the proxy last read it. */
  noteHead(n: bigint): void {
    if (this.head === null || n > this.head) this.head = n
  }

  /** A finalized block a trusted provider reported (an answer to the `finalized` tag). */
  noteFinal(block: unknown): void {
    const n = (block as { number?: unknown } | null)?.number
    if (typeof n !== 'string') return
    const v = BigInt(n)
    if (this.final === null || v > this.final) {
      this.final = v
      this.headAtFinal = this.head
    }
  }

  /** A kept answer for this request, or undefined. */
  hit(msg: Req): unknown {
    const k = this.cacheable(msg)
    if (k === null) return undefined
    const v = this.kept.get(k)
    if (v === undefined) return undefined
    // Most recently used last: the oldest falls out first.
    this.kept.delete(k)
    this.kept.set(k, v)
    this.stats.finalHits++
    return v
  }

  /**
   * Runs `ask` for this request, sharing it with identical requests already in flight, and keeps a good answer that
   * is pinned under the finalized block. `ask` returns the JSON-RPC response object; errors and null results are
   * never kept.
   */
  async run(msg: Req, ask: () => Promise<any>): Promise<any> {
    if (!isRead(msg.method)) return ask()
    const k = keyOf(msg)
    const pending = this.inflight.get(k)
    if (pending) {
      this.stats.inflightShared++
      return pending
    }
    this.maybeRefresh(msg)
    const p = ask().finally(() => this.inflight.delete(k))
    this.inflight.set(k, p)
    const r = await p
    if (msg.method === 'eth_getBlockByNumber' && msg.params?.[0] === 'finalized' && r && !r.error) this.noteFinal(r.result)
    if (r && !r.error && r.result !== null && r.result !== undefined && this.cacheable(msg, r.result) !== null) this.keep(k, r)
    return r
  }

  snapshot(): ReadCacheStats {
    return { ...this.stats, kept: this.kept.size, finalized: this.final === null ? null : this.final.toString() }
  }

  /** The key under which this request may be kept, or null. A receipt counts once its own block is final. */
  private cacheable(msg: Req, result?: unknown): string | null {
    if (this.final === null) return null
    if (msg.method === 'eth_getTransactionReceipt') {
      if (result === undefined) return keyOf(msg)
      const b = (result as { blockNumber?: unknown } | null)?.blockNumber
      return typeof b === 'string' && BigInt(b) <= this.final ? keyOf(msg) : null
    }
    const n = pinnedBlock(msg)
    return n !== null && n <= this.final ? keyOf(msg) : null
  }

  private keep(k: string, r: unknown): void {
    this.kept.delete(k)
    this.kept.set(k, r)
    while (this.kept.size > this.max) this.kept.delete(this.kept.keys().next().value as string)
  }

  /**
   * Asks for the finalized block in the background when a pinned read above the known one may fall under the real one
   * by now (its block at or below the known finalized block plus the head's move since), at most every refreshMs.
   */
  private maybeRefresh(msg: Req): void {
    const n = pinnedBlock(msg)
    if (n === null || (this.final !== null && n <= this.final)) return
    if (this.final !== null && this.head !== null && this.headAtFinal !== null && n > this.final + (this.head - this.headAtFinal)) return
    const now = Date.now()
    if (now - this.finalAskedAt < this.refreshMs) return
    this.finalAskedAt = now
    void this.askFinalized()
      .then((b) => this.noteFinal(b))
      .catch(() => {})
  }
}
