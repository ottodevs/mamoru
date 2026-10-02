import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ---- Alchemy compute-unit estimate -----------------------------------------------------------

/** Per-method CU cost, Alchemy's published table restricted to the methods this operator calls. An estimate, not a bill. */
export const CU_TABLE: Record<string, number> = {
  eth_call: 26,
  eth_getLogs: 75,
  eth_blockNumber: 10,
  eth_getBalance: 19,
  eth_getBlockByNumber: 16,
  eth_getTransactionReceipt: 15,
  eth_getCode: 19,
  eth_chainId: 0,
  eth_estimateGas: 87,
  eth_sendRawTransaction: 250,
  eth_gasPrice: 19,
}
export const DEFAULT_CU = 26

export function cuFor(method: string): number {
  return CU_TABLE[method] ?? DEFAULT_CU
}

/** Methods this operator actually calls. An unexpected method name (a bug, or any future caller
 * that is not careful) folds into "other" instead of creating a new permanent bucket, so the
 * number of method buckets per provider is always bounded. */
const KNOWN_METHODS = new Set(Object.keys(CU_TABLE))
const OTHER_METHOD = 'other'
function methodKey(method: string): string {
  return KNOWN_METHODS.has(method) ? method : OTHER_METHOD
}

// ---- RPC traffic counters ---------------------------------------------------------------------

export type ErrorClass = 'rateCapacity' | 'invalidParams' | 'timeout' | 'other'

// ---- redaction -----------------------------------------------------------------------------

/**
 * Coerces anything to a string without ever throwing. A plain `String(x)`/template coercion
 * assumes `x` has a usable `toString`/`valueOf`/`Symbol.toPrimitive` — false for a null-prototype
 * object (no inherited `toString` at all), an object whose `toString`/`Symbol.toPrimitive` throws
 * on purpose, or a revoked `Proxy` (every operation on one throws, including `instanceof` and
 * property reads). This is the one place in the file that turns an arbitrary, possibly hostile or
 * malformed, `unknown` value into a string: every classifier and logger below that has to handle
 * "whatever a caught exception, a decoded revert reason, or a replayed state file happens to be"
 * goes through this first. `JSON.stringify` (not `String`) is used for objects because it only
 * needs their own enumerable data properties, never a `toString`/`valueOf` call — so it already
 * sidesteps the null-prototype/missing-toString case; the single `try/catch` around the whole body
 * catches everything else (a throwing `toJSON`, a circular structure, a revoked proxy at any step).
 */
function safeStringify(v: unknown): string {
  try {
    if (v == null) return ''
    if (typeof v === 'string') return v
    if (v instanceof Error) return typeof v.message === 'string' ? v.message : safeStringify(v.message)
    return typeof v === 'object' ? (JSON.stringify(v) ?? '') : String(v)
  } catch {
    return ''
  }
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi
const KEYVAL_RE = /\b(key|token|secret|apikey|api_key|auth|authorization)\s*[:=]\s*[^\s&"']+/gi
/** A run of 24+ opaque characters (no spaces/punctuation that would break up ordinary prose) — the shape of an API key, a hash, or a long hex blob, not of an English sentence. */
const LONG_OPAQUE_RE = /\b[A-Za-z0-9_-]{24,}\b/g
const REDACT_MAX_LEN = 160

/**
 * Strips anything secret-shaped out of an upstream error message (or our own log line) before it
 * is kept for /metrics or printed: a URL collapses to its scheme+host (an Alchemy URL's path is
 * where the API key lives), a `key=`/`token=`/`secret=`-shaped fragment is redacted, and any other
 * long opaque run (a key or hash not wrapped in a URL) is redacted too. Capped to a fixed length.
 * Takes `unknown`, not just `string`, and never throws regardless of what is handed in (see `safeStringify`).
 */
export function redactSecrets(message: unknown): string {
  let out = safeStringify(message)
  out = out.replace(URL_RE, (url) => {
    try {
      const u = new URL(url)
      return `${u.protocol}//${u.hostname}`
    } catch {
      return '[url]'
    }
  })
  out = out.replace(KEYVAL_RE, (_m, k: string) => `${k}=[redacted]`)
  out = out.replace(LONG_OPAQUE_RE, '[redacted]')
  return out.length > REDACT_MAX_LEN ? `${out.slice(0, REDACT_MAX_LEN)}…` : out
}

/** The `${redacted first line}` fragment `logErr` builds, exposed so this file's own failure paths
 * (persistence, load, metrics recording) can use the low-level redactor directly instead of calling
 * `logErr` — those paths run precisely when something already went wrong, so they must not depend
 * on any more machinery than `safeStringify`/`redactSecrets` themselves. */
function redactedLine(v: unknown): string {
  return redactSecrets(safeStringify(v).split('\n')[0]?.trim() ?? '')
}

/** Classifies an upstream failure for the metrics counters. Order matters: invalid-params and
 * timeout are checked before the broader rate/capacity pattern, which also matches the word
 * "timeout" in some provider messages. Never throws: `err` (or `err.code`/`err.message`) can be
 * anything — a revoked Proxy, a null-prototype object — so even reading the properties is wrapped,
 * not just coercing them (see `safeStringify`). */
export function classifyRpcError(status: number | undefined, err: { code?: number; message?: unknown } | null | undefined): ErrorClass {
  let code: unknown
  let rawMessage: unknown
  try {
    code = err?.code
    rawMessage = err?.message
  } catch {
    code = undefined
    rawMessage = undefined
  }
  const msg = safeStringify(rawMessage)
  if (code === -32602 || /invalid param/i.test(msg)) return 'invalidParams'
  if (/time ?out|aborted/i.test(msg)) return 'timeout'
  if (status === 429 || code === 429 || code === -32005 || /rate|capacity|limit exceeded|compute units|too many|throughput|temporar/i.test(msg)) return 'rateCapacity'
  return 'other'
}

/**
 * The one way an engine/review/armed/reconcile/owner/bundler/relayer log line prints an error or a
 * revert/review detail: `${tag} ${redacted first line}` via console.error. `e` may be an Error, a
 * plain string, or anything else — whatever shape a catch block or a decoded revert reason happens
 * to be, including a hostile or malformed one (see `safeStringify`). Never logs more than one line,
 * never logs it unredacted, and never itself throws — a logging call must not be able to crash the
 * code path it was logging a failure for.
 */
export function logErr(tag: string, e: unknown): void {
  const line = redactedLine(e)
  console.error(line ? `${tag} ${line}` : tag)
}

/** Runs `fn`; any throw is logged and swallowed. Metrics must never break the request/review they are measuring. */
export function safeMetrics(fn: () => void): void {
  try {
    fn()
  } catch (e) {
    console.error(`[metrics] recording failed, ignored: ${redactedLine(e)}`)
  }
}

type ErrorCounts = { rateCapacity: number; invalidParams: number; timeout: number; other: number }
export type RpcCounters = { requests: number; errors: ErrorCounts; fallbacks: number; getLogsChunks: number; cuEstimate: number }
/** JSON-safe shape, used only for the persisted file and the public payload: provider host label -> method -> counters. */
export type RpcSnapshot = Record<string, Record<string, RpcCounters>>
type HourEntry = { hourStart: number; data: RpcSnapshot }

const HOUR_MS = 3_600_000
const RING_HOURS = 48
/** Distinct provider labels retained; beyond this every further new label folds into "other" too.
 * The provider list is operator-controlled (the upstream URL + MAMORU_RPC_FALLBACKS), so this is
 * defense in depth rather than a response to an untrusted input, matching the method allowlist. */
const MAX_PROVIDERS = 16
const OTHER_PROVIDER = 'other'

/** How a logical eth_getLogs range ended on the provider that read it: accepted with a witness, or why it was rejected. */
export type LogRangeOutcome = 'accepted' | 'no_witness' | 'hash_mismatch' | 'provider_error'
export type LogRangeCounters = Record<LogRangeOutcome, number>

function emptyCounters(): RpcCounters {
  return { requests: 0, errors: { rateCapacity: 0, invalidParams: 0, timeout: 0, other: 0 }, fallbacks: 0, getLogsChunks: 0, cuEstimate: 0 }
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

const ERROR_KEYS = ['rateCapacity', 'invalidParams', 'timeout', 'other'] as const

/** True only for a well-formed counters object; anything else is dropped on load rather than trusted (a hand-edited or corrupted state file must not crash the operator). */
function isValidCounters(v: unknown): v is RpcCounters {
  if (!v || typeof v !== 'object') return false
  const c = v as Partial<RpcCounters>
  if (!isFiniteNonNegative(c.requests) || !isFiniteNonNegative(c.fallbacks) || !isFiniteNonNegative(c.getLogsChunks) || !isFiniteNonNegative(c.cuEstimate)) return false
  const e = c.errors as Partial<ErrorCounts> | null | undefined
  if (!e || typeof e !== 'object') return false
  return ERROR_KEYS.every((k) => isFiniteNonNegative(e[k]))
}

/**
 * Map<provider, Map<method, counters>>: the only representation ever mutated at runtime. A plain
 * object keyed by caller-influenced strings (`{}[method]`) inherits `Object.prototype` members
 * (`toString`, `constructor`, `__proto__`, ...): a method or provider label equal to one of those
 * names reads back a function/object instead of `undefined`, so `??=` never initializes real
 * counters and the first counter mutation throws. `Map` has no such inherited-key hazard — every
 * key, including "toString" or "__proto__", behaves like any other string. Bounded by the method
 * allowlist and MAX_PROVIDERS regardless.
 */
class Buckets {
  private providers = new Map<string, Map<string, RpcCounters>>()

  private providerKey(provider: string): string {
    if (this.providers.has(provider) || this.providers.size < MAX_PROVIDERS) return provider
    return OTHER_PROVIDER
  }

  get(provider: string, method: string): RpcCounters {
    const pKey = this.providerKey(provider)
    const mKey = methodKey(method)
    let byMethod = this.providers.get(pKey)
    if (!byMethod) this.providers.set(pKey, (byMethod = new Map()))
    let c = byMethod.get(mKey)
    if (!c) byMethod.set(mKey, (c = emptyCounters()))
    return c
  }

  /** Merges in validated counters loaded from disk (used once, at construction). Malformed entries are dropped silently. */
  load(json: RpcSnapshot): void {
    for (const [provider, byMethod] of Object.entries(json)) {
      if (!byMethod || typeof byMethod !== 'object') continue
      for (const [method, counters] of Object.entries(byMethod)) {
        if (!isValidCounters(counters)) continue
        const dest = this.get(provider, method)
        dest.requests += counters.requests
        dest.fallbacks += counters.fallbacks
        dest.getLogsChunks += counters.getLogsChunks
        dest.cuEstimate += counters.cuEstimate
        for (const k of ERROR_KEYS) dest.errors[k] += counters.errors[k]
      }
    }
  }

  toJSON(): RpcSnapshot {
    const out: RpcSnapshot = Object.create(null) as RpcSnapshot
    for (const [provider, byMethod] of this.providers) {
      const outMethod: Record<string, RpcCounters> = Object.create(null) as Record<string, RpcCounters>
      for (const [method, counters] of byMethod) outMethod[method] = { ...counters, errors: { ...counters.errors } }
      out[provider] = outMethod
    }
    return out
  }
}

/**
 * RPC traffic counters for the loopback proxy: cumulative since the state file was created (not
 * just since this process booted — the ring and the cumulative totals both survive a restart),
 * plus a rolling per-hour ring for the last 48h. Persisted to `stateDir/rpc-usage.json`, written
 * at most once a minute and always atomically (tmp file + rename, like state.ts).
 */
export class RpcMetrics {
  private cumulative = new Buckets()
  private ring = new Map<number, Buckets>()
  private lastPersistAt = 0
  private readonly file: string
  /** Log ranges per provider since this process started (in memory only, like the engine health). */
  private logRanges = new Map<string, LogRangeCounters>()

  constructor(private readonly stateDir: string) {
    this.file = join(stateDir, 'rpc-usage.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { cumulative?: unknown; ring?: unknown }
      if (raw.cumulative && typeof raw.cumulative === 'object' && !Array.isArray(raw.cumulative)) this.cumulative.load(raw.cumulative as RpcSnapshot)
      if (Array.isArray(raw.ring)) {
        for (const e of raw.ring) {
          if (!e || typeof e !== 'object') continue
          const hourStart = (e as { hourStart?: unknown }).hourStart
          const data = (e as { data?: unknown }).data
          if (typeof hourStart !== 'number' || !Number.isFinite(hourStart) || !data || typeof data !== 'object' || Array.isArray(data)) continue
          const b = new Buckets()
          b.load(data as RpcSnapshot)
          this.ring.set(hourStart, b)
        }
      }
      this.pruneRing(Date.now())
    } catch (e) {
      console.error(`[metrics] failed to load ${this.file}, starting empty: ${redactedLine(e)}`)
    }
  }

  private pruneRing(now: number): void {
    const cutoff = now - RING_HOURS * HOUR_MS
    for (const h of this.ring.keys()) if (h < cutoff) this.ring.delete(h)
  }

  private hourBuckets(now: number): Buckets {
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS
    let b = this.ring.get(hourStart)
    if (!b) {
      b = new Buckets()
      this.ring.set(hourStart, b)
      this.pruneRing(now)
    }
    return b
  }

  /** One attempt sent to `provider` for `method` (whatever the outcome). `isChunk` marks a sub-request of a split eth_getLogs range. */
  recordRequest(provider: string, method: string, isChunk: boolean, now: number = Date.now()): void {
    for (const b of [this.cumulative, this.hourBuckets(now)]) {
      const c = b.get(provider, method)
      c.requests++
      if (isChunk) c.getLogsChunks++
      // CU estimate only makes sense against Alchemy's billed usage; other providers are free-tier/public and are not billed per-request.
      if (/alchemy/i.test(provider)) c.cuEstimate += cuFor(method)
    }
    this.maybePersist(now)
  }

  recordError(provider: string, method: string, cls: ErrorClass, now: number = Date.now()): void {
    for (const b of [this.cumulative, this.hourBuckets(now)]) b.get(provider, method).errors[cls]++
    this.maybePersist(now)
  }

  /** `provider` is the one just abandoned (its attempts failed), not the one picked up next. */
  recordFallback(provider: string, method: string, now: number = Date.now()): void {
    for (const b of [this.cumulative, this.hourBuckets(now)]) b.get(provider, method).fallbacks++
    this.maybePersist(now)
  }

  /** One logical eth_getLogs range read from `provider`: accepted, or rejected and why. */
  recordLogRange(provider: string, outcome: LogRangeOutcome): void {
    const key = this.logRanges.has(provider) || this.logRanges.size < MAX_PROVIDERS ? provider : OTHER_PROVIDER
    let c = this.logRanges.get(key)
    if (!c) this.logRanges.set(key, (c = { accepted: 0, no_witness: 0, hash_mismatch: 0, provider_error: 0 }))
    c[outcome]++
  }

  private maybePersist(now: number): void {
    if (now - this.lastPersistAt >= 60_000) this.persist(now)
  }

  /** Atomic write (tmp + rename), bypassing the once-a-minute throttle. Call on shutdown so the last minute is not lost. */
  persist(now: number = Date.now()): void {
    this.lastPersistAt = now
    this.pruneRing(now)
    const ring: HourEntry[] = [...this.ring.entries()].sort(([a], [b]) => a - b).map(([hourStart, b]) => ({ hourStart, data: b.toJSON() }))
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ cumulative: this.cumulative.toJSON(), ring }, null, 1), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[metrics] failed to persist ${this.file}: ${redactedLine(e)}`)
    }
  }

  /** CU estimate charged to `provider` in the clock hour of `now`. */
  cuThisHour(provider: string, now: number = Date.now()): number {
    const byMethod = this.ring.get(Math.floor(now / HOUR_MS) * HOUR_MS)?.toJSON()[provider]
    let total = 0
    for (const c of Object.values(byMethod ?? {})) total += c.cuEstimate
    return total
  }

  cuEstimateTotal(): number {
    let total = 0
    const snap = this.cumulative.toJSON()
    for (const byMethod of Object.values(snap)) for (const c of Object.values(byMethod)) total += c.cuEstimate
    return total
  }

  /** `last48h` oldest first, ISO hour-start timestamps; only hours with recorded activity are present (sparse, not zero-filled). */
  snapshot(now: number = Date.now()): { cumulative: RpcSnapshot; cuEstimateTotal: number; last48h: { hourStart: string; data: RpcSnapshot }[]; logRanges: Record<string, LogRangeCounters> } {
    this.pruneRing(now)
    return {
      cumulative: this.cumulative.toJSON(),
      cuEstimateTotal: this.cuEstimateTotal(),
      last48h: [...this.ring.entries()].sort(([a], [b]) => a - b).map(([hourStart, b]) => ({ hourStart: new Date(hourStart).toISOString(), data: b.toJSON() })),
      logRanges: Object.fromEntries([...this.logRanges].map(([provider, c]) => [provider, { ...c }])),
    }
  }
}

// ---- Engine health per account -----------------------------------------------------------------

/**
 * A closed, secret-free bucket for what kind of thing went wrong in an engine review. Free text
 * (a provider's message, a revert reason) never reaches /metrics at all — heuristic redaction
 * cannot *guarantee* a secret-free payload, a closed enum can. The redacted free text still goes to
 * the journal only, via `logErr`.
 */
export type EngineErrorClass = 'rpc_rate_limit' | 'rpc_invalid_params' | 'rpc_timeout' | 'rpc_other' | 'bundler_rejected' | 'simulation_reverted' | 'observation_inconsistent' | 'internal'

const RPC_CLASS_TO_ENGINE: Record<ErrorClass, EngineErrorClass> = {
  rateCapacity: 'rpc_rate_limit',
  invalidParams: 'rpc_invalid_params',
  timeout: 'rpc_timeout',
  other: 'rpc_other',
}

/**
 * Buckets an engine review failure into `EngineErrorClass`. `code` is a `ReasonCode` from an
 * observation failure, or the synthetic `'REVIEW_ERROR'` for a thrown exception. `detail` is only
 * ever used to tell an RPC-shaped failure apart from the rest (the same heuristic as
 * `classifyRpcError`) — its text itself is never stored or returned, only which of four RPC buckets
 * it looks like, or none.
 *
 * Total: `code` is typed `string | null` for every real call site, but this function is on the
 * boundary of whatever the engine/journal hands it (a replayed state file, a future caller), so it
 * is written to never throw regardless of what actually arrives at runtime — a non-string, non-null
 * `code` (a number, an object, an array, a boolean, `undefined`) is treated the same as `null` and
 * maps to `internal`, never an uncaught `TypeError` from `.startsWith` on a non-string.
 */
export function classifyEngineError(code: string | null, detail?: unknown): EngineErrorClass {
  const safeCode = typeof code === 'string' && code.length > 0 ? code : null
  if (safeCode === 'OBS_RPC_UNAVAILABLE') return 'rpc_other'
  if (safeCode === 'REVIEW_ERROR' && detail != null) {
    const rpcClass = classifyRpcError(undefined, { message: detail })
    if (rpcClass !== 'other') return RPC_CLASS_TO_ENGINE[rpcClass]
  }
  if (!safeCode) return 'internal'
  if (safeCode.startsWith('BUNDLER_')) return 'bundler_rejected'
  if (safeCode.startsWith('EHG_SIM') || safeCode === 'EXEC_INNER_REVERT' || safeCode === 'CHAIN_REVERTED_EXECUTION') return 'simulation_reverted'
  if (safeCode.startsWith('OBS_') || safeCode.startsWith('RECON_') || safeCode.startsWith('CHAIN_')) return 'observation_inconsistent'
  return 'internal'
}

export type EngineHealthSnapshot = {
  account: string
  lastReviewAt: string | null
  lastDecisionCode: string | null
  consecutiveErrors: number
  lastErrorClass: EngineErrorClass | null
  lastErrorAt: string | null
  reviewsLastHour: number
  errorsLastHour: number
}

type AccountHealth = { lastAt: number; lastCode: string | null; consecutiveErrors: number; lastErrorClass: EngineErrorClass | null; lastErrorAt: number | null; hourStart: number; reviews: number; errors: number }

/** Per-account engine review stats, in-memory only (reset on operator restart; the journal in state.ts is the durable record). Keyed by a `Map` (see `Buckets` above for why, applies equally to an attacker- or bug-influenced accountKey). */
export class EngineHealthTracker {
  private byAccount = new Map<string, AccountHealth>()

  /** One `engine.review()` pass finished: `ok` false for an observation failure or a thrown error. `errorClass` is a closed enum, never free text (see `classifyEngineError`). */
  record(accountKey: string, ok: boolean, code: string | null, errorClass: EngineErrorClass | undefined, now: number = Date.now()): void {
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS
    const prev = this.byAccount.get(accountKey)
    const h: AccountHealth =
      prev && prev.hourStart === hourStart
        ? prev
        : { lastAt: 0, lastCode: null, consecutiveErrors: prev?.consecutiveErrors ?? 0, lastErrorClass: prev?.lastErrorClass ?? null, lastErrorAt: prev?.lastErrorAt ?? null, hourStart, reviews: 0, errors: 0 }
    h.lastAt = now
    h.lastCode = code
    h.reviews++
    if (ok) h.consecutiveErrors = 0
    else {
      h.consecutiveErrors++
      h.errors++
      if (errorClass) {
        h.lastErrorClass = errorClass
        h.lastErrorAt = now
      }
    }
    this.byAccount.set(accountKey, h)
  }

  snapshot(accountKey: string, now: number = Date.now()): EngineHealthSnapshot {
    const h = this.byAccount.get(accountKey)
    const fresh = !!h && now - h.hourStart < HOUR_MS
    return {
      account: accountKey.slice(0, 8),
      lastReviewAt: h ? new Date(h.lastAt).toISOString() : null,
      lastDecisionCode: h?.lastCode ?? null,
      consecutiveErrors: h?.consecutiveErrors ?? 0,
      lastErrorClass: h?.lastErrorClass ?? null,
      lastErrorAt: h?.lastErrorAt ? new Date(h.lastErrorAt).toISOString() : null,
      reviewsLastHour: fresh ? h!.reviews : 0,
      errorsLastHour: fresh ? h!.errors : 0,
    }
  }
}
