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
 * Who goes first when two chains both run the account and both hold savings to place: Base, then the lower chain id.
 * The other one leaves room for what the first may still place, so both together never place past the cap.
 */
export function placesFirst(a: number, b: number): boolean {
  if (a === 8453) return true
  if (b === 8453) return false
  return a < b
}

/**
 * What an engine on chain `own` counts as placed elsewhere: what every other chain has placed, plus the savings a chain
 * that places first could still place there (it is running). Null when another chain could not be read.
 */
export function elsewhereOf(own: number, peers: PeerRead): bigint | null {
  if (!peers.ok) return null
  let sum = 0n
  for (const e of peers.chains) {
    sum += e.placedUsdc
    if (e.active && placesFirst(e.chainId, own)) sum += e.idleUsdc
  }
  return sum
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

/** What GET /internal/exposure/<address> answers. Amounts are base-unit strings. */
export type ExposureWire = { chainId: number; address: string; block: string; idleUsdc: string; placedUsdc: string; active: boolean }

export type PeerRead = { ok: true; chains: ChainExposure[] } | { ok: false; chainId: number }

/** How long a failed read of a peer is answered from memory before the peer is asked again. */
const FAILED_TTL_MS = 5_000
const UINT = /^[0-9]{1,40}$/

/**
 * otto/mamoru#212: what the peer operators hold for one Safe address (the same CREATE2 address on every chain), read
 * over their signed internal endpoint and kept briefly. Any peer that does not answer, answers late, or answers
 * something malformed makes the whole read fail: the callers then place nothing new (fail closed) and never hold
 * back a withdrawal, a stop or the re-range of what is already placed.
 */
export class PeerExposure {
  private readonly cache = new Map<string, { at: number; value: PeerRead }>()
  private readonly inFlight = new Map<string, Promise<PeerRead>>()

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

  /** The last read of `address` if it is at most `maxAgeMs` old (a failed one at most FAILED_TTL_MS), else undefined. */
  cached(address: string, maxAgeMs: number): PeerRead | undefined {
    const c = this.cache.get(address.toLowerCase())
    if (!c) return undefined
    const age = this.now() - c.at
    return age <= (c.value.ok ? maxAgeMs : Math.min(maxAgeMs, FAILED_TTL_MS)) ? c.value : undefined
  }

  /** Every peer's exposure for `address`, at most `maxAgeMs` old. No peers: an empty, successful read. */
  async read(address: string, maxAgeMs: number): Promise<PeerRead> {
    if (!this.configured) return { ok: true, chains: [] }
    const key = address.toLowerCase()
    const hit = this.cached(key, maxAgeMs)
    if (hit) return hit
    const running = this.inFlight.get(key)
    if (running) return running
    const p = this.readAll(key).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, p)
    return p
  }

  private async readAll(address: string): Promise<PeerRead> {
    const at = this.now()
    const results = await Promise.all(this.peers.map((peer) => this.readOne(peer, address)))
    const failed = results.findIndex((r) => r === null)
    const value: PeerRead = failed >= 0 ? { ok: false, chainId: this.peers[failed]!.chainId } : { ok: true, chains: results as ChainExposure[] }
    this.cache.set(address, { at, value })
    if (this.cache.size > 5_000) this.cache.delete(this.cache.keys().next().value!)
    return value
  }

  private async readOne(peer: PeerOperator, address: string): Promise<ChainExposure | null> {
    const path = `${EXPOSURE_PATH}${address}`
    try {
      const sig = await metricsSignature(this.secret, 'GET', path, Math.floor(this.now() / 60_000))
      const res = await this.fetchFn(`${peer.url}${path}`, { method: 'GET', headers: { 'x-mamoru-sig': sig, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) })
      if (!res.ok) {
        console.log(`[peer] chain ${peer.chainId} exposure read answered ${res.status}`)
        return null
      }
      const w = (await res.json()) as Partial<ExposureWire>
      if (w.chainId !== peer.chainId || typeof w.address !== 'string' || w.address.toLowerCase() !== address || typeof w.idleUsdc !== 'string' || !UINT.test(w.idleUsdc) || typeof w.placedUsdc !== 'string' || !UINT.test(w.placedUsdc) || typeof w.active !== 'boolean') {
        console.log(`[peer] chain ${peer.chainId} exposure read malformed`)
        return null
      }
      return { chainId: peer.chainId, idleUsdc: BigInt(w.idleUsdc), placedUsdc: BigInt(w.placedUsdc), active: w.active }
    } catch (e) {
      // Fixed text only: an error may quote the URL.
      console.log(`[peer] chain ${peer.chainId} exposure read failed (${e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'unreachable'})`)
      return null
    }
  }
}
