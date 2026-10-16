/**
 * otto/mamoru#135: a home tab polls GET /funding every few seconds; without this, each call pays for its own
 * readSafe. One readSafe answer is shared by every open tab and every poll of the same account + Safe, as long as
 * it is younger than the `maxAgeMs` the caller asks for (the operator asks 15 s, 60 s while the keyed RPC
 * provider is over its hourly budget, 2 s for a `fresh` read). Concurrent callers for a key with nothing young
 * enough cached share one fetch instead of each starting their own. An entry is stamped when its fetch completes.
 *
 * `invalidate` drops one key's entry and pending fetch and bumps its generation: the operator calls it whenever
 * anything of that account moves (an owner op, an engine journal move, the engine starting or ending an entry), so
 * a poll never pairs the account's new state with a balance read before it. A fetch that started before an
 * invalidation is written back nowhere, and a caller waiting on it loops and reads the key again, however many
 * invalidations land while it waits, until one attempt's generation holds for its whole wait.
 *
 * Memory: one small slot per key (its generation must outlive its entry, or a waiter could not see an
 * invalidation), bounded by the accounts the operator serves; a cached value older than `retainMs` is dropped
 * whenever another one is written.
 */
type Slot<T> = { gen: number; entry?: { at: number; value: T }; pending?: Promise<T> }

export class FundingCache<T> {
  private readonly slots = new Map<string, Slot<T>>()

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly retainMs = 60_000,
  ) {}

  private slot(key: string): Slot<T> {
    let s = this.slots.get(key)
    if (!s) this.slots.set(key, (s = { gen: 0 }))
    return s
  }

  /** A value for `key` no older than `maxAgeMs`, fetched with `fetch` otherwise (shared across concurrent callers). */
  async get(key: string, maxAgeMs: number, fetch: () => Promise<T>): Promise<T> {
    const s = this.slot(key)
    for (;;) {
      // Read the clock on every attempt: a loop after an invalidation must not judge age by when it first came in.
      if (s.entry && this.clock() - s.entry.at < maxAgeMs) return s.entry.value
      const gen = s.gen
      // A pending fetch always belongs to the current generation: invalidate() drops it.
      if (!s.pending) {
        let started: Promise<T>
        try {
          started = fetch()
        } catch (e) {
          started = Promise.reject(e)
        }
        const p: Promise<T> = started.then(
          (value) => {
            if (s.pending === p) s.pending = undefined
            if (s.gen === gen) {
              s.entry = { at: this.clock(), value }
              this.prune()
            }
            return value
          },
          (err) => {
            if (s.pending === p) s.pending = undefined
            throw err
          },
        )
        s.pending = p
      }
      const value = await s.pending
      // Invalidated while this waited: `value` may be from before what moved. Read again.
      if (s.gen === gen) return value
    }
  }

  /** Drops `key`'s entry and pending fetch and bumps its generation (see the class comment). */
  invalidate(key: string): void {
    const s = this.slot(key)
    s.entry = undefined
    s.pending = undefined
    s.gen++
  }

  /** invalidate() on every key `match` accepts that has ever been read (one with no slot has no waiter and no entry). */
  invalidateWhere(match: (key: string) => boolean): void {
    for (const key of this.slots.keys()) if (match(key)) this.invalidate(key)
  }

  private prune(): void {
    const now = this.clock()
    for (const s of this.slots.values()) if (s.entry && now - s.entry.at >= this.retainMs) s.entry = undefined
  }

  /** How many keys hold a cached value. */
  get size(): number {
    let n = 0
    for (const s of this.slots.values()) if (s.entry) n++
    return n
  }
}

/** One account's funding is cached under its key plus its Safe, so a stale context can never read another account's cache. */
export function fundingCacheKey(accountKey: string, safe: string): string {
  return `${accountKey}:${safe.toLowerCase()}`
}

/** Whether `key` (a fundingCacheKey) belongs to `accountKey`, whatever Safe it was read for. */
export function isAccountKey(key: string, accountKey: string): boolean {
  return key.startsWith(`${accountKey}:`) && !key.slice(accountKey.length + 1).includes(':')
}
