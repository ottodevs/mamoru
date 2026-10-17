/**
 * otto/mamoru#140 (part2 #7): what the operator's HTTP side admits before any work is done for a request. A caller
 * with network access and no secret must not be able to make the operator buffer large bodies or hold many requests
 * open; a caller with the secret (a compromised app Worker) must not be able to turn prepares, which read the chain
 * and simulate, into unbounded RPC load.
 *
 * Stop has a bucket of its own (`'stop'`) for every limit here: no amount of other traffic, prepares or in-flight
 * requests, can keep an owner from revoking the engine. Its own bounds are what limits abuse of it.
 */
export type Bucket = 'stop' | 'other'

export type AdmissionLimits = {
  /** Largest request body accepted, in bytes. Owner bodies are a passkey assertion (~1 KB); prepares send a few fields. */
  maxBodyBytes: number
  /** Largest x-mamoru-account header (a base64url account context). */
  maxHeaderBytes: number
  /** Account requests being handled at once, across all accounts. */
  maxInFlight: number
  /** Account requests being handled at once for one account (after the signature is checked). */
  maxInFlightPerAccount: number
  /** Prepares per account per minute. */
  preparesPerMinute: number
  /** Prepares per minute across all accounts. */
  preparesPerMinuteAll: number
  /** The same four limits for Stop's own bucket. */
  maxInFlightStop: number
  maxInFlightPerAccountStop: number
  stopPreparesPerMinute: number
  stopPreparesPerMinuteAll: number
  /** How long a request body may take to arrive (a slow sender holds a slot only this long). */
  bodyTimeoutMs: number
}

export const DEFAULT_ADMISSION: AdmissionLimits = {
  maxBodyBytes: 16 * 1024,
  maxHeaderBytes: 4 * 1024,
  maxInFlight: 64,
  maxInFlightPerAccount: 4,
  preparesPerMinute: 10,
  preparesPerMinuteAll: 120,
  maxInFlightStop: 16,
  maxInFlightPerAccountStop: 2,
  stopPreparesPerMinute: 6,
  stopPreparesPerMinuteAll: 60,
  bodyTimeoutMs: 5_000,
}

const MINUTE_MS = 60_000

/** Shape of the auth headers, checked before the body is read: anything else cannot carry a valid signature. */
export function authFraming(limits: AdmissionLimits, header: string | null, sig: string | null, ts: string | null): boolean {
  if (!header || header.length > limits.maxHeaderBytes || !/^[A-Za-z0-9_-]+={0,2}$/.test(header)) return false
  if (!sig || !/^[0-9a-f]{64}$/.test(sig)) return false
  return ts === null || /^\d{1,12}$/.test(ts)
}

/**
 * The body as text, at most `max` bytes. A declared Content-Length over it is refused without reading; a body
 * that turns out longer than declared (or than `max`, when nothing was declared) is cut off and refused.
 */
export async function boundedText(req: Request, max: number, timeoutMs = DEFAULT_ADMISSION.bodyTimeoutMs): Promise<string | null> {
  const declared = req.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), Math.max(0, deadline - Date.now()))))
    const next = await Promise.race([reader.read(), late]).finally(() => clearTimeout(timer))
    if (next === 'late') {
      await reader.cancel().catch(() => undefined)
      return null
    }
    const { done, value } = next
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

/** In-flight counts and prepare rates, per bucket. One instance per server. */
export class Admission {
  private readonly inFlight: Record<Bucket, number> = { stop: 0, other: 0 }
  private readonly perAccount = new Map<string, number>()
  private readonly prepares = new Map<string, number[]>()
  private readonly preparesAll: Record<Bucket, number[]> = { stop: [], other: [] }

  constructor(readonly limits: AdmissionLimits = DEFAULT_ADMISSION) {}

  private maxInFlight(b: Bucket): number {
    return b === 'stop' ? this.limits.maxInFlightStop : this.limits.maxInFlight
  }

  /** A slot for one account request, before its body is read; false when the bucket is at its limit. */
  enter(b: Bucket = 'other'): boolean {
    if (this.inFlight[b] >= this.maxInFlight(b)) return false
    this.inFlight[b]++
    return true
  }

  leave(b: Bucket = 'other'): void {
    this.inFlight[b] = Math.max(0, this.inFlight[b] - 1)
  }

  /** A slot for an authenticated request for Safe `safe`; false when that Safe already has its share of the bucket open. */
  enterAccount(safe: string, b: Bucket = 'other'): boolean {
    const k = `${b}|${safe}`
    const n = this.perAccount.get(k) ?? 0
    if (n >= (b === 'stop' ? this.limits.maxInFlightPerAccountStop : this.limits.maxInFlightPerAccount)) return false
    this.perAccount.set(k, n + 1)
    return true
  }

  leaveAccount(safe: string, b: Bucket = 'other'): void {
    const k = `${b}|${safe}`
    const n = (this.perAccount.get(k) ?? 1) - 1
    if (n <= 0) this.perAccount.delete(k)
    else this.perAccount.set(k, n)
  }

  /** Counts one prepare of `safe` in bucket `b` at `now`; false (and not counted) over either rate. */
  allowPrepare(safe: string, now = Date.now(), b: Bucket = 'other'): boolean {
    const since = now - MINUTE_MS
    const k = `${b}|${safe}`
    const mine = (this.prepares.get(k) ?? []).filter((t) => t > since)
    this.preparesAll[b] = this.preparesAll[b].filter((t) => t > since)
    const [perAccount, all] = b === 'stop' ? [this.limits.stopPreparesPerMinute, this.limits.stopPreparesPerMinuteAll] : [this.limits.preparesPerMinute, this.limits.preparesPerMinuteAll]
    if (mine.length >= perAccount || this.preparesAll[b].length >= all) {
      this.prepares.set(k, mine)
      return false
    }
    mine.push(now)
    this.prepares.set(k, mine)
    this.preparesAll[b].push(now)
    // Accounts with nothing in the window are forgotten, so the map does not grow with every key ever seen.
    if (this.prepares.size > 1_000) for (const [key, ts] of this.prepares) if (!ts.some((t) => t > since)) this.prepares.delete(key)
    return true
  }
}
