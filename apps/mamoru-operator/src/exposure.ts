import { metricsSignature } from '@mamoru/operator-auth'

/**
 * otto/mamoru#212: the cap is the total an account holds with Mamoru across every chain, idle and placed. One chain's
 * share of it, USDC base units, valued at the prices the operator already reads (funding's `idle` and `positions`).
 */
export type ChainExposure = {
  chainId: number
  /** USDC in the Safe, plus USDC on its way to it (a move from Ethereum, bridge-out). */
  idleUsdc: bigint
  /** Positions (with what they can collect) and idle tokens other than USDC: what the engine placed. */
  placedUsdc: bigint
  /** The engine runs this account on that chain. */
  active: boolean
  /**
   * otto/mamoru#332: the Safe and the block of `chainId` it was read at: a peer's answer, or (otto/mamoru#355) a sibling
   * Safe read on this chain. Every consumer matches `chainId` as well as the Safe: a block of one chain never covers a
   * mint on another.
   */
  at?: { safe: string; block: bigint }
  /**
   * otto/mamoru#355, the Monad side of the return leg: the releases of this Safe sending or burned (not in `idleUsdc`), so
   * the home operator counts those it does not count itself yet. `block`: the burn's block there; absent while sending.
   */
  releases?: ReleaseWire[]
  /**
   * otto/mamoru#355, the home side: returns to this Safe the answer positively holds (its journal has them burned, counted
   * in `idleUsdc` as on their way, or minted, counted there until the Safe read holds them). The burning operator stops
   * counting exactly these ids; one not listed is never taken as held.
   */
  returns?: string[]
}

/** otto/mamoru#355: one release of a remote Safe as its operator reports it. Amounts are base-unit strings. */
export type ReleaseWire = {
  id: string
  amount: string
  /** Out of the Safe by this block: the burn's block, or for a sending one the block of a read that sees its nonce used. */
  block?: string
  /** The burn's Monad tx, once burned: the home resolves on chain a release its journal does not hold (otto/mamoru#355). */
  tx?: string
  /** Sending, and a read at this block sees its nonce unused: the Safe's read up to this block still holds it (display). */
  notLandedAt?: string
}

export function totalOf(e: Pick<ChainExposure, 'idleUsdc' | 'placedUsdc'>): bigint {
  return e.idleUsdc + e.placedUsdc
}

/** One chain's exposure from funding's own valuation: idle tokens (each with its value in USDC) and position values. */
export function exposureOf(chainId: number, idle: readonly { token: string; valueUsdc: string }[], positionsUsdc: readonly bigint[], inFlightUsdc: bigint, active: boolean): ChainExposure {
  let idleUsdc = inFlightUsdc
  let placedUsdc = 0n
  for (const t of idle) {
    if (t.token === 'USDC') idleUsdc += BigInt(t.valueUsdc)
    else placedUsdc += BigInt(t.valueUsdc)
  }
  for (const v of positionsUsdc) placedUsdc += v
  return { chainId, idleUsdc, placedUsdc, active }
}

/**
 * What an engine on this chain counts as taken elsewhere: everything the other chains hold for the account, placed
 * and idle (USDC in flight included). Idle money on another chain counts as committed to that chain, whether or not
 * its engine runs: two chains reading each other can then never both place the same headroom, however their reviews
 * interleave. A chain's own deposit is in the other's read from the moment it lands, before anything places it, and a
 * chain places only its own money. The price is conservative: when the idle money across chains is above the cap,
 * less than the cap may end up placed (a soft cap; the app shows the excess). Null when another chain could not be
 * read: nothing new is placed.
 */
export function elsewhereOf(peers: PeerRead): bigint | null {
  if (!peers.ok) return null
  return peers.chains.reduce((s, e) => s + totalOf(e), 0n)
}

/** Two reads of the account's other Safes and chains, as one: failed when either failed. */
export function joinReads(a: PeerRead, b: PeerRead): PeerRead {
  if (!a.ok) return a
  if (!b.ok) return b
  return { ok: true, chains: [...a.chains, ...b.chains] }
}

export type PeerOperator = { chainId: number; url: string }

/**
 * MAMORU_PEER_OPERATORS: `chainId=url` pairs, comma separated (`143=http://127.0.0.1:8788,8453=http://127.0.0.1:8787`),
 * the operators that run the same accounts on the other chains. The entry of this operator's own chain is skipped, so
 * both units can carry the same value. http only to a loopback host; anything else must be https. Unset or empty: none,
 * this operator counts its own chain only.
 */
export function parsePeerOperators(v: string | undefined, ownChainId: number): PeerOperator[] {
  if (v === undefined || v.trim() === '') return []
  const out: PeerOperator[] = []
  const seen = new Set<number>()
  for (const raw of v.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([0-9]{1,10})=(.+)$/.exec(raw)
    if (!m) throw new Error('MAMORU_PEER_OPERATORS: an entry is not chainId=url')
    const chainId = Number(m[1])
    let u: URL
    try {
      u = new URL(m[2]!)
    } catch {
      throw new Error(`MAMORU_PEER_OPERATORS: the url of chain ${chainId} is not a URL`)
    }
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`MAMORU_PEER_OPERATORS: chain ${chainId} is not https`)
    if (seen.has(chainId)) throw new Error(`MAMORU_PEER_OPERATORS: chain ${chainId} is listed twice`)
    seen.add(chainId)
    if (chainId === ownChainId) continue
    out.push({ chainId, url: u.origin })
  }
  return out
}

/** The internal read a peer operator answers: the account at `address` on its chain, signed like GET /metrics. */
export const EXPOSURE_PATH = '/internal/exposure/'

/**
 * otto/mamoru#332: the caller's own read of its Safe on its chain, used in the same total as the peer's answer. The Base
 * operator stops counting a CCTP burn minted to `safe` on `chainId` once this read is at or after the mint's block.
 */
export type Covered = { chainId: number; safe: string; block: bigint }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * otto/mamoru#332: `/internal/exposure/<address>`, or with the caller's read `/internal/exposure/<address>/<chainId>/<safe>/<block>`.
 * The covered read is in the path, so the pathname signature covers it. A peer running older code answers 400 to the
 * longer shape: the Base operator deploys first (it accepts both), then the Monad operator, the only one that sends it.
 */
export function exposurePath(address: string, covered?: Covered): string {
  return covered ? `${EXPOSURE_PATH}${address}/${covered.chainId}/${covered.safe.toLowerCase()}/${covered.block}` : `${EXPOSURE_PATH}${address}`
}

/** The Safe and the covered read of an exposure path; null when it is not one of the two shapes. */
export function parseExposurePath(pathname: string): { safe: string; covered?: Covered } | null {
  if (!pathname.startsWith(EXPOSURE_PATH)) return null
  const parts = pathname.slice(EXPOSURE_PATH.length).split('/')
  const safe = parts[0]!
  if (!ADDRESS.test(safe)) return null
  if (parts.length === 1) return { safe }
  if (parts.length !== 4) return null
  const [, chainId, coveredSafe, block] = parts as [string, string, string, string]
  if (!/^[0-9]{1,10}$/.test(chainId) || !ADDRESS.test(coveredSafe) || !/^[0-9]{1,20}$/.test(block)) return null
  return { safe, covered: { chainId: Number(chainId), safe: coveredSafe.toLowerCase(), block: BigInt(block) } }
}

/**
 * otto/mamoru#332: whether an answer the peer gave for `had` may stand for a read asked with `want`. An answer computed
 * without a covered read counts every burn minted (never less than asked). One computed for a covered read counts the
 * burns minted after it: it stands only for a read of the same Safe at the same or a later block (a later read holds
 * those mints already; an earlier one may not).
 */
export function coversAsked(had: Covered | undefined, want: Covered | undefined): boolean {
  if (had === undefined) return true
  if (want === undefined) return false
  return had.chainId === want.chainId && had.safe.toLowerCase() === want.safe.toLowerCase() && had.block <= want.block
}

/**
 * What GET /internal/exposure/<address> answers. Amounts are base-unit strings. otto/mamoru#355: `releases` (a remote
 * Safe's operator) and `returns` (the home's), both optional: a peer on older code sends neither and ignores both.
 */
export type ExposureWire = { chainId: number; address: string; block: string; idleUsdc: string; placedUsdc: string; active: boolean; releases?: ReleaseWire[]; returns?: string[] }

export type PeerRead = { ok: true; chains: ChainExposure[] } | { ok: false; chainId: number }

type CacheEntry = { at: number; done: number; value: PeerRead; covered?: Covered }
/** Answers kept per Safe: one per cover a caller is using at once (funding, Start, the engine) is plenty. */
const CACHE_PER_SAFE = 4
/** How long a failed read of a peer is answered from memory before the peer is asked again. */
const FAILED_TTL_MS = 5_000
const UINT = /^[0-9]{1,40}$/
/** otto/mamoru#355: release ids as release.ts takes them; at most this many in one answer. */
const RELEASE_ID = /^[A-Za-z0-9-]{1,64}$/
export const MAX_LISTED = 64
const TX = /^0x[0-9a-fA-F]{64}$/

/** otto/mamoru#355: the optional lists of an answer, checked; null when one is there and malformed (the read fails). */
function listsOf(w: Partial<ExposureWire>): Pick<ChainExposure, 'releases' | 'returns'> | null {
  const out: Pick<ChainExposure, 'releases' | 'returns'> = {}
  if (w.releases !== undefined) {
    if (!Array.isArray(w.releases) || w.releases.length > MAX_LISTED) return null
    for (const x of w.releases as unknown[]) {
      const r = x as Partial<ReleaseWire> | null
      const uintOpt = (v: unknown) => v === undefined || (typeof v === 'string' && UINT.test(v))
      if (typeof r?.id !== 'string' || !RELEASE_ID.test(r.id) || typeof r.amount !== 'string' || !UINT.test(r.amount) || !uintOpt(r.block) || !uintOpt(r.notLandedAt) || (r.tx !== undefined && (typeof r.tx !== 'string' || !TX.test(r.tx)))) return null
    }
    out.releases = (w.releases as ReleaseWire[]).map((r) => ({ id: r.id, amount: r.amount, ...(r.block !== undefined ? { block: r.block } : {}), ...(r.tx !== undefined ? { tx: r.tx } : {}), ...(r.notLandedAt !== undefined ? { notLandedAt: r.notLandedAt } : {}) }))
  }
  if (w.returns !== undefined) {
    if (!Array.isArray(w.returns) || w.returns.length > MAX_LISTED || !(w.returns as unknown[]).every((id) => typeof id === 'string' && RELEASE_ID.test(id))) return null
    out.returns = [...(w.returns as string[])]
  }
  return out
}

/**
 * otto/mamoru#212: what the peer operators hold for one Safe address (the same CREATE2 address on every chain), read
 * over their signed internal endpoint and kept briefly. Any peer that does not answer, answers late, or answers
 * something malformed makes the whole read fail: the callers then place nothing new (fail closed) and never hold
 * back a withdrawal, a stop or the re-range of what is already placed.
 */
export class PeerExposure {
  /**
   * A few answers per Safe (otto/mamoru#332 r2): `at` when the read started (its age), `done` when it completed (which of
   * two answers is newer), `covered` the read it was asked with. Reads with different covers can complete in any order:
   * an answer is dropped only by one at least as broad (coversAsked) and completed later, so a narrower or older answer
   * never replaces a broader or newer one.
   */
  private readonly cache = new Map<string, CacheEntry[]>()
  private readonly inFlight = new Map<string, { covered?: Covered; p: Promise<PeerRead> }>()

  constructor(
    readonly peers: readonly PeerOperator[],
    private readonly secret: string,
    private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 3_000,
  ) {}

  get configured(): boolean {
    return this.peers.length > 0
  }

  /**
   * The last read of `address` if it is at most `maxAgeMs` old (a failed one at most FAILED_TTL_MS) and was asked with a
   * covered read that stands for `covered` (coversAsked; a failed one always does), else undefined.
   */
  cached(address: string, maxAgeMs: number, covered?: Covered): PeerRead | undefined {
    const now = this.now()
    let best: CacheEntry | undefined
    for (const c of this.cache.get(address.toLowerCase()) ?? []) {
      if (now - c.at >= (c.value.ok ? maxAgeMs : Math.min(maxAgeMs, FAILED_TTL_MS))) continue
      if (c.value.ok && !coversAsked(c.covered, covered)) continue
      // The newest usable answer; a failure newer than every success wins (fail closed).
      if (!best || c.done > best.done) best = c
    }
    return best?.value
  }

  /** Keeps `e` beside the answers it does not supersede (see `cache`); at most CACHE_PER_SAFE, the oldest dropped. */
  private remember(address: string, e: CacheEntry): void {
    const broader = (a: CacheEntry, b: CacheEntry) => !a.value.ok || (b.value.ok && coversAsked(a.covered, b.covered))
    const list = this.cache.get(address) ?? []
    // Superseded: an answer at least as broad and completed no earlier is already there.
    if (list.some((x) => broader(x, e) && x.done >= e.done)) return
    const kept = list.filter((x) => !(broader(e, x) && e.done >= x.done))
    kept.push(e)
    kept.sort((x, y) => y.done - x.done)
    this.cache.delete(address)
    this.cache.set(address, kept.slice(0, CACHE_PER_SAFE))
    if (this.cache.size > 5_000) this.cache.delete(this.cache.keys().next().value!)
  }

  /**
   * Every peer's exposure for `address`, at most `maxAgeMs` old. No peers: an empty, successful read. `covered`
   * (otto/mamoru#332): the caller's own read of its Safe in the same total, sent in the path.
   */
  async read(address: string, maxAgeMs: number, covered?: Covered): Promise<PeerRead> {
    if (!this.configured) return { ok: true, chains: [] }
    const key = address.toLowerCase()
    const hit = this.cached(key, maxAgeMs, covered)
    if (hit) return hit
    const running = this.inFlight.get(key)
    if (running && coversAsked(running.covered, covered)) return running.p
    const p: Promise<PeerRead> = this.readAll(key, covered).finally(() => {
      if (this.inFlight.get(key)?.p === p) this.inFlight.delete(key)
    })
    this.inFlight.set(key, { ...(covered ? { covered } : {}), p })
    return p
  }

  /**
   * Boot check: every peer answers a signed read (of the zero address) with its own chain id. One line per peer that
   * does not, saying why: unreachable, refused (401: OPERATOR_SECRET differs, or the peer runs code without the route:
   * 404), or another chain. Never throws and never blocks the boot: reads fail closed on their own. `covered`: probe the
   * path shape this operator's reads use (otto/mamoru#332: the Monad operator's, with a covered read; 400 from a peer
   * that runs older code).
   */
  async check(covered?: Covered): Promise<{ chainId: number; ok: boolean; why?: string }[]> {
    const zero = `0x${'0'.repeat(40)}`
    return Promise.all(
      this.peers.map(async (peer) => {
        const path = exposurePath(zero, covered)
        try {
          const sig = await metricsSignature(this.secret, 'GET', path, Math.floor(this.now() / 60_000))
          const res = await this.fetchFn(`${peer.url}${path}`, { method: 'GET', headers: { 'x-mamoru-sig': sig, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs * 3) })
          if (res.status === 401) return { chainId: peer.chainId, ok: false, why: 'refused (401): OPERATOR_SECRET differs' }
          if (res.status === 404) return { chainId: peer.chainId, ok: false, why: 'no /internal/exposure route (404): the peer runs older code' }
          if (res.status === 400 && covered) return { chainId: peer.chainId, ok: false, why: 'refuses the covered-read path (400): the peer runs older code' }
          if (!res.ok) return { chainId: peer.chainId, ok: false, why: `answered ${res.status}` }
          const w = (await res.json()) as Partial<ExposureWire>
          return w.chainId === peer.chainId ? { chainId: peer.chainId, ok: true } : { chainId: peer.chainId, ok: false, why: `answers for chain ${String(w.chainId)}` }
        } catch {
          return { chainId: peer.chainId, ok: false, why: 'unreachable' }
        }
      }),
    )
  }

  private async readAll(address: string, covered: Covered | undefined): Promise<PeerRead> {
    const at = this.now()
    const results = await Promise.all(this.peers.map((peer) => this.readOne(peer, address, covered)))
    const failed = results.findIndex((r) => r === null)
    const value: PeerRead = failed >= 0 ? { ok: false, chainId: this.peers[failed]!.chainId } : { ok: true, chains: results as ChainExposure[] }
    this.remember(address, { at, done: this.now(), value, ...(covered ? { covered } : {}) })
    return value
  }

  private async readOne(peer: PeerOperator, address: string, covered: Covered | undefined): Promise<ChainExposure | null> {
    const path = exposurePath(address, covered)
    try {
      const sig = await metricsSignature(this.secret, 'GET', path, Math.floor(this.now() / 60_000))
      const res = await this.fetchFn(`${peer.url}${path}`, { method: 'GET', headers: { 'x-mamoru-sig': sig, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) })
      if (!res.ok) {
        console.log(`[peer] chain ${peer.chainId} exposure read answered ${res.status}`)
        return null
      }
      const w = (await res.json()) as Partial<ExposureWire>
      if (w.chainId !== peer.chainId || typeof w.address !== 'string' || w.address.toLowerCase() !== address || typeof w.idleUsdc !== 'string' || !UINT.test(w.idleUsdc) || typeof w.placedUsdc !== 'string' || !UINT.test(w.placedUsdc) || typeof w.active !== 'boolean' || typeof w.block !== 'string' || !UINT.test(w.block)) {
        console.log(`[peer] chain ${peer.chainId} exposure read malformed`)
        return null
      }
      const lists = listsOf(w)
      if (!lists) {
        console.log(`[peer] chain ${peer.chainId} exposure read malformed (releases or returns)`)
        return null
      }
      return { chainId: peer.chainId, idleUsdc: BigInt(w.idleUsdc), placedUsdc: BigInt(w.placedUsdc), active: w.active, at: { safe: address, block: BigInt(w.block) }, ...lists }
    } catch (e) {
      // Fixed text only: an error may quote the URL.
      console.log(`[peer] chain ${peer.chainId} exposure read failed (${e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'unreachable'})`)
      return null
    }
  }
}
