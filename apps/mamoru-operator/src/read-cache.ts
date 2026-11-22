// otto/mamoru#419: reads the proxy can answer without asking a provider again.
//
// Two layers, both behind the proxy's own provider rules (an answer is only ever one a trusted provider gave to the same
// request, and eth_getLogs, sends and filters never pass through here):
// Both layers serve only reads pinned to an explicit block number that was already at or below the chain's finalized
// block (as a trusted provider last reported it) when the request was sent:
// - In flight: an identical such read that arrives while the first is still out shares its answer.
// - Kept: its good answer is served again for FINAL_KEEP_MS.
// Reorg safety: a finalized block is never replaced unless the chain's finality itself fails (an L1 finality violation for
// Base, a BFT safety failure for Monad), so a read pinned there has one right answer, the one any honest provider gives.
// The check is made when the request is sent, never when its answer lands: an answer computed on a fork that lost before
// the block was finalized is never kept. Nothing above the finalized block is shared or kept, however briefly: the
// engine's hash checks (the pinned block read again at the end of an observation, a cursor's block re-read) and every
// `latest` read always reach a provider, so a reorg under them is seen as before. The keep time bounds how long a
// provider that broke finality could be repeated. Receipts are never kept (their block hash is not checked here). The
// finalized head is learned from answers to the `finalized` tag that pass through, and asked for at most every
// FINAL_REFRESH_MS, only when a pinned read is likely to fall under it.
//
// A third layer serves `latest` state reads (calls, code, balances, storage) again for LATEST_KEEP_MS, a few blocks:
// an answer that old is what a provider's node a few blocks behind gives anyway, and the proxy already serves `latest`
// heads MAMORU_HEAD_LAG blocks behind the tip. Anything that changes state the operator reads drops it at once: a
// transaction sent through the proxy, or a receipt found for one. Nonces, gas prices, estimates, simulations and
// `pending` reads are never kept.

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
/**
 * Blocks under the finalized head a read must be to be kept: a load-balanced provider's node can trail the one that
 * reported finality, and answer a block it does not have yet with "0x" or zero. Larger than any node spread seen
 * (a few blocks on Base, a few dozen on Monad's 0.4 s blocks).
 */
export const FINAL_MARGIN = 64n
/** How long a kept answer is served. */
export const FINAL_KEEP_MS = 10 * 60_000
/** How long a `latest` state read is served again: 5 Base blocks, 3 Monad blocks. */
export const LATEST_KEEP_MS = 1_000
/** `latest` reads whose answer is the chain's state at the tip and nothing else. */
const LATEST_READS = new Set(['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_getStorageAt'])

type Req = { method: string; params?: unknown[] }

export function isRead(method: string): boolean {
  return READS.has(method)
}

/** The raw block param of a method that has one (eth_getBlockByNumber's first, a call's second...), else undefined. */
export function blockParam(msg: Req): unknown {
  const i = BLOCK_PARAM[msg.method]
  return i === undefined ? undefined : msg.params?.[i]
}

/** The explicit block a request is pinned to, or null (a tag, a hash, an object, or none). */
export function pinnedBlock(msg: Req): bigint | null {
  const i = BLOCK_PARAM[msg.method]
  if (i === undefined) return null
  const p = msg.params?.[i]
  return typeof p === 'string' && /^0x[0-9a-fA-F]+$/.test(p) ? BigInt(p) : null
}

/**
 * An answer a node that lacks the block could also give: null, "0x" (no code, an empty return), or a zero quantity
 * (a balance or nonce of 0). Served once, never kept: the next read asks a provider again.
 */
export function emptyLooking(result: unknown): boolean {
  if (result === null || result === undefined) return true
  return typeof result === 'string' && /^0x0*$/.test(result)
}

export function keyOf(msg: Req): string {
  return `${msg.method}:${JSON.stringify(msg.params ?? [])}`
}

/** A `latest` state read with no block param or the `latest` tag (a call with state overrides is never one). */
export function latestRead(msg: Req): boolean {
  if (!LATEST_READS.has(msg.method)) return false
  const i = BLOCK_PARAM[msg.method]!
  const p = msg.params ?? []
  if (p.length > i + 1) return false
  return p[i] === undefined || p[i] === 'latest'
}

/**
 * `latestRepeats`: latest reads that reached a provider although the same read had been asked less than REPEAT_WINDOW_MS
 * before: what a longer keep time would save, measured before choosing one.
 */
export type ReadCacheStats = { inflightShared: number; finalHits: number; latestHits: number; latestRepeats: number; headShared?: number; kept: number; finalized: string | null }

/** The window `latestRepeats` counts in: one operator tick. */
export const REPEAT_WINDOW_MS = 60_000

export class ReadCache {
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly kept = new Map<string, { r: unknown; at: number }>()
  private readonly latest = new Map<string, { r: unknown; at: number }>()
  private readonly latestInflight = new Map<string, Promise<unknown>>()
  /** Bumped by every state change: a `latest` read sent before it is neither shared nor kept after it. */
  private epoch = 0
  private final: bigint | null = null
  /** The head known when `final` was learned: how far finality has likely moved since is the head's move. */
  private headAtFinal: bigint | null = null
  private head: bigint | null = null
  private finalAskedAt = Number.NEGATIVE_INFINITY
  private stats = { inflightShared: 0, finalHits: 0, latestHits: 0, latestRepeats: 0 }
  private readonly lastAsked = new Map<string, number>()

  constructor(
    private readonly askFinalized: () => Promise<unknown>,
    private readonly max = READ_CACHE_MAX,
    private readonly refreshMs = FINAL_REFRESH_MS,
    private readonly keepMs = FINAL_KEEP_MS,
    private readonly latestMs = LATEST_KEEP_MS,
  ) {}

  /** State the operator reads may have changed (a send, a receipt found): no `latest` answer from before is served. */
  changed(): void {
    this.epoch++
    this.latest.clear()
    this.latestInflight.clear()
  }

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
    if (latestRead(msg)) {
      const k = keyOf(msg)
      const v = this.latest.get(k)
      if (v === undefined) return undefined
      if (Date.now() - v.at >= this.latestMs) {
        this.latest.delete(k)
        return undefined
      }
      this.stats.latestHits++
      return v.r
    }
    const k = this.cacheable(msg)
    if (k === null) return undefined
    const v = this.kept.get(k)
    if (v === undefined) return undefined
    if (Date.now() - v.at >= this.keepMs) {
      this.kept.delete(k)
      return undefined
    }
    // Most recently used last: the oldest falls out first.
    this.kept.delete(k)
    this.kept.set(k, v)
    this.stats.finalHits++
    return v.r
  }

  /**
   * Runs `ask` for this request, sharing it with identical requests already in flight, and keeps a good answer that
   * is pinned under the finalized block. `ask` returns the JSON-RPC response object; errors and null results are
   * never kept.
   */
  async run(msg: Req, ask: () => Promise<any>): Promise<any> {
    if (!isRead(msg.method)) return ask()
    if (latestRead(msg)) return this.runLatest(msg, ask)
    // Decided now, at send time: a block finalized only after this request went out does not make its answer keepable.
    const k = this.cacheable(msg)
    if (k === null) {
      this.maybeRefresh(msg)
      const r = await ask()
      if (msg.method === 'eth_getBlockByNumber' && msg.params?.[0] === 'finalized' && r && !r.error) this.noteFinal(r.result)
      return r
    }
    const pending = this.inflight.get(k)
    if (pending) {
      this.stats.inflightShared++
      return pending
    }
    const p = ask().finally(() => this.inflight.delete(k))
    this.inflight.set(k, p)
    const r = await p
    if (r && !r.error && !emptyLooking(r.result)) this.keep(k, r)
    return r
  }

  private async runLatest(msg: Req, ask: () => Promise<any>): Promise<any> {
    const k = keyOf(msg)
    const pending = this.latestInflight.get(k)
    if (pending) {
      this.stats.inflightShared++
      return pending
    }
    const epoch = this.epoch
    const at = Date.now()
    const before = this.lastAsked.get(k)
    if (before !== undefined && at - before < REPEAT_WINDOW_MS) this.stats.latestRepeats++
    this.lastAsked.delete(k)
    this.lastAsked.set(k, at)
    while (this.lastAsked.size > this.max) this.lastAsked.delete(this.lastAsked.keys().next().value as string)
    const p = ask().finally(() => {
      if (this.latestInflight.get(k) === p) this.latestInflight.delete(k)
    })
    this.latestInflight.set(k, p)
    const r = await p
    // Kept from when it was sent, and only if nothing changed meanwhile.
    if (epoch === this.epoch && r && !r.error && !emptyLooking(r.result)) {
      this.latest.delete(k)
      this.latest.set(k, { r, at })
      while (this.latest.size > this.max) this.latest.delete(this.latest.keys().next().value as string)
    }
    return r
  }

  snapshot(): ReadCacheStats {
    return { ...this.stats, kept: this.kept.size, finalized: this.final === null ? null : this.final.toString() }
  }

  /** The key under which this request may be shared and kept, or null: pinned at or below the finalized block. */
  private cacheable(msg: Req): string | null {
    if (this.final === null) return null
    const n = pinnedBlock(msg)
    return n !== null && n + FINAL_MARGIN <= this.final ? keyOf(msg) : null
  }

  private keep(k: string, r: unknown): void {
    this.kept.delete(k)
    this.kept.set(k, { r, at: Date.now() })
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
