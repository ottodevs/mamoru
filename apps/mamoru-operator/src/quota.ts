// otto/mamoru#418: a provider whose monthly quota is spent answers 429 to every request until its plan resets, and
// before this every request still went to it first (counted as a rate limit, the same as a one-second burst). The
// book marks such a provider down until its plan resets (Alchemy: the first of the month, UTC; a provider whose answer
// names its reset, at that time; MAMORU_RPC_QUOTA_RESET_DAY for a billing cycle on another day) and the proxy passes
// it over. One request a day asks it again, so a plan that is raised mid-month is back within a day. A burst limit
// (an ordinary 429) or a failure keeps the provider out of the read spread for a few seconds only (#420). State is kept
// per endpoint by a hash of its URL (a URL can carry a key, so it is never written), on disk across restarts for the
// spent quotas, and shared by every proxy of one operator.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logErr } from './metrics.ts'

type Env = Record<string, string | undefined>

/** While a provider is parked until its reset, one request this often asks it again (a plan raised mid-month). */
export const QUOTA_RECHECK_MS = 24 * 60 * 60_000
/** While that one request is out, everyone else still passes the provider over; past this it may be asked again. */
export const QUOTA_PROBE_MS = 60_000
/** An ordinary rate limit (a burst 429): out of the read spread this long, then back. */
export const BURST_BACKOFF_MS = 10_000
/** A provider that failed (5xx, timeout, no answer): out of the read spread this long, then back. */
export const FAIL_BACKOFF_MS = 30_000

/**
 * A refusal that says the plan's quota is spent, not that the provider is busy for a second: Alchemy's "Monthly
 * capacity limit exceeded", credit errors, a 402, and the usual quota and credit wordings. A burst limit
 * ("too many requests", "exceeded its throughput", QuickNode's "Per-second request limit reached") is not one of them.
 */
const QUOTA_RE = /monthly capacity|capacity limit exceeded|monthly (request |compute unit |cu )?(limit|quota)|quota (exceeded|exhausted|reached)|out of (credits|compute units)|(credit|credits) (limit|exhausted|exceeded)|insufficient credits|upgrade your (plan|scaling policy)|payment required/i

export function quotaExhausted(status: number | undefined, err: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (status === 402 || err?.code === 402) return true
  const message = String(err?.message ?? '')
  // A revert carries the contract's own words, which can say anything: never a reason to drop a provider.
  if (err?.code === 3 || /revert/i.test(message)) return false
  return QUOTA_RE.test(message)
}

/** The provider part of a host-free label: `alchemy.com#2` is `alchemy.com`. */
export function domainOfLabel(label: string): string {
  return label.replace(/#\d+$/, '').toLowerCase()
}

/**
 * MAMORU_RPC_QUOTA_RESET_DAY="quiknode.pro=14,alchemy.com=1": the day of the month (UTC, 1 to 28) each provider's
 * quota resets on, by provider domain. A provider not named resets on the first. Invalid pairs are ignored.
 */
export function resetDaysFromEnv(env: Env = process.env): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pair of (env.MAMORU_RPC_QUOTA_RESET_DAY ?? '').split(',')) {
    const [host, day] = pair.split('=').map((x) => x.trim())
    const n = Number(day)
    if (host && Number.isInteger(n) && n >= 1 && n <= 28) out[host.toLowerCase()] = n
  }
  return out
}

/** The start of the quota cycle `now` is in: the latest reset day at 00:00 UTC at or before `now`. */
export function cycleStart(domain: string, now: number, days: Record<string, number> = {}): number {
  const day = days[domain] ?? 1
  const d = new Date(now)
  const thisMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day)
  return thisMonth <= now ? thisMonth : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, day)
}

/** The next reset after `now`: the reset day at 00:00 UTC, strictly later. */
export function nextReset(domain: string, now: number, days: Record<string, number> = {}): number {
  const start = new Date(cycleStart(domain, now, days))
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate())
}

/** No reset the answer names is believed further out than this: a garbled date must not park a provider for a year. */
const MAX_ANSWER_RESET_MS = 40 * 24 * 60 * 60_000

/**
 * A reset time the refusal itself gives: a Retry-After header (seconds, or an HTTP date), or an ISO date after the
 * word "reset" in its message. Only a time in the future and within 40 days; otherwise null (the configured cycle).
 */
export function resetFromAnswer(message: unknown, retryAfter: string | null | undefined, now: number): number | null {
  const ok = (t: number) => (Number.isFinite(t) && t > now && t - now <= MAX_ANSWER_RESET_MS ? t : null)
  const ra = retryAfter?.trim()
  if (ra) {
    const t = /^\d+$/.test(ra) ? ok(now + Number(ra) * 1000) : ok(Date.parse(ra))
    if (t !== null) return t
  }
  const m = /reset\w*\D{0,20}?(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)/i.exec(typeof message === 'string' ? message.slice(0, 2000) : '')
  if (!m) return null
  const s = m[1]!
  // A date with no zone is UTC.
  return ok(Date.parse(/[T ]\d{2}:\d{2}/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? `${s.replace(' ', 'T')}Z` : s))
}

/**
 * `since`: the first refusal of this run of refusals. `markedAt`: the latest one (an answer to a request sent before
 * it says nothing about the plan now). `until`: the plan's reset. `probeAt`: the next single request that asks again.
 */
type Entry = { label: string; since: number; markedAt: number; until: number; probeAt?: number }

export type QuotaSnapshot = { label: string; state: 'exhausted'; since: string; until: string; recheckAt: string }[]
export type ProviderState = 'ok' | 'burst_limited' | 'failing' | 'exhausted'
export type ProviderSnapshot = { proxy: string; label: string; state: ProviderState; until: string | null }[]

export class QuotaBook {
  private readonly entries = new Map<string, Entry>()
  /** Short, in-memory backoffs (#420): a burst limit or a failure keeps a provider out of the read spread briefly. */
  private readonly cool = new Map<string, { label: string; state: 'burst_limited' | 'failing'; until: number }>()
  /** Every provider a proxy uses, by key: so /metrics can say `ok` for those with nothing to report. */
  private readonly known = new Map<string, { proxy: string; label: string }>()
  /** When every provider of a list is parked: the last single request that asked one of them, by list. */
  private readonly poolProbes = new Map<string, number>()
  private readonly file: string | null

  constructor(stateDir?: string, private readonly recheckMs: number = QUOTA_RECHECK_MS) {
    this.file = stateDir ? join(stateDir, 'rpc-quota.json') : null
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Entry>
      for (const [k, e] of Object.entries(saved)) if (typeof e?.until === 'number' && typeof e.label === 'string') this.entries.set(k, e)
    } catch {}
  }

  private static key(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 16)
  }

  /** A provider a proxy uses, with its host-free label and the proxy's name (`chain`, `monad`, `l1`). */
  register(url: string, label: string, proxy: string = 'chain'): void {
    this.known.set(QuotaBook.key(url), { proxy, label })
  }

  /** True while `url` is marked spent and its plan has not reset. */
  down(url: string, now: number = Date.now()): boolean {
    const e = this.entries.get(QuotaBook.key(url))
    return !!e && now < e.until
  }

  /** When `url`'s plan resets, while it is marked spent; else null. */
  until(url: string): number | null {
    return this.entries.get(QuotaBook.key(url))?.until ?? null
  }

  /**
   * Whether this request should pass `url` over. At its reset, or at the daily recheck, the first caller gets false and
   * is the one request that asks again; for QUOTA_PROBE_MS everyone else still passes it over.
   */
  skip(url: string, now: number = Date.now()): boolean {
    const e = this.entries.get(QuotaBook.key(url))
    if (!e) return false
    const due = Math.min(e.until, e.probeAt ?? e.until)
    if (now < due) return true
    e.probeAt = now + QUOTA_PROBE_MS
    if (now >= e.until) e.until = now + QUOTA_PROBE_MS
    return false
  }

  /**
   * Every provider of a list is parked. One of them (the one refused longest ago) may take one request every
   * QUOTA_PROBE_MS, so a misread refusal or a raised plan is found within a minute; every other request gets none and
   * fails at once, instead of each one being refused by a provider that has nothing left.
   */
  probeOne(urls: readonly string[], now: number = Date.now()): string | null {
    if (!urls.length) return null
    const pool = urls.map((u) => QuotaBook.key(u)).sort().join(',')
    const last = this.poolProbes.get(pool)
    if (last !== undefined && now - last < QUOTA_PROBE_MS && now >= last) return null
    this.poolProbes.set(pool, now)
    let best = urls[0]!
    for (const u of urls) if ((this.entries.get(QuotaBook.key(u))?.markedAt ?? 0) < (this.entries.get(QuotaBook.key(best))?.markedAt ?? 0)) best = u
    return best
  }

  /**
   * Marks `url` spent until `resetAt`. Alerts on the first refusal only; a recheck that is refused again moves the next
   * one out quietly (and the reset to `resetAt`, when the old one has passed).
   */
  mark(url: string, label: string, words: string, resetAt: number, now: number = Date.now()): void {
    const k = QuotaBook.key(url)
    const was = this.entries.get(k)
    const until = Math.max(resetAt, now + QUOTA_PROBE_MS)
    this.entries.set(k, { label, since: was?.since ?? now, markedAt: now, until, probeAt: Math.min(until, now + this.recheckMs) })
    this.cool.delete(k)
    // Saved before the page: a restart reloads the mark and does not page again.
    this.save()
    if (!was) logErr('[alert]', `RPC provider ${label} out of quota until ${new Date(until).toISOString()} (its reset), asked again once a day: ${words}`)
  }

  /** A burst limit or a failure (#420): out of the read spread for a few seconds. A spent quota is not touched. */
  backoff(url: string, label: string, state: 'burst_limited' | 'failing', now: number = Date.now()): void {
    const k = QuotaBook.key(url)
    if (this.entries.has(k)) return
    this.cool.set(k, { label, state, until: now + (state === 'burst_limited' ? BURST_BACKOFF_MS : FAIL_BACKOFF_MS) })
  }

  /** True while `url` is in a short backoff: weight 0 in the read spread. (A parked provider is left out before that.) */
  cooling(url: string, now: number = Date.now()): boolean {
    const k = QuotaBook.key(url)
    const c = this.cool.get(k)
    if (!c) return false
    if (now < c.until) return true
    this.cool.delete(k)
    return false
  }

  /** A good answer from `url` to a request sent at `sentAt`: the mark is gone, unless a refusal came in after it was sent. */
  clear(url: string, sentAt: number): void {
    const k = QuotaBook.key(url)
    this.cool.delete(k)
    const was = this.entries.get(k)
    // Same millisecond as the refusal: no telling which came first, so the mark stays.
    if (!was || sentAt <= (was.markedAt ?? was.since)) return
    this.entries.delete(k)
    logErr('[rpc]', `RPC provider ${was.label} answers again after running out of quota`)
    this.save()
  }

  snapshot(): QuotaSnapshot {
    return [...this.entries.values()].map((e) => ({ label: e.label, state: 'exhausted', since: new Date(e.since).toISOString(), until: new Date(e.until).toISOString(), recheckAt: new Date(Math.min(e.until, e.probeAt ?? e.until)).toISOString() }))
  }

  /** Each provider's state for /metrics, by host-free label only: ok, burst_limited, failing, or exhausted until its reset. */
  providers(now: number = Date.now()): ProviderSnapshot {
    const out = new Map<string, ProviderSnapshot[number]>()
    const who = (k: string, label: string) => this.known.get(k) ?? { proxy: '?', label }
    for (const [k, w] of this.known) out.set(k, { ...w, state: 'ok', until: null })
    for (const [k, c] of this.cool) if (now < c.until) out.set(k, { ...who(k, c.label), state: c.state, until: new Date(c.until).toISOString() })
    for (const [k, e] of this.entries) out.set(k, { ...who(k, e.label), state: 'exhausted', until: new Date(e.until).toISOString() })
    return [...out.values()].sort((a, b) => a.proxy.localeCompare(b.proxy) || a.label.localeCompare(b.label))
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      logErr('[rpc] quota book not saved:', e)
    }
  }
}
