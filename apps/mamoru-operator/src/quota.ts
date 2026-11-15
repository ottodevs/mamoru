// otto/mamoru#418: a provider whose monthly quota is spent answers 429 to every request until its plan resets, and
// before this every request still went to it first (counted as a rate limit, the same as a one-second burst). The
// book marks such a provider down and the proxy passes it over; one request an hour asks it again, so a plan that
// resets or is raised is back within the hour. State is kept per endpoint by a hash of its URL (a URL can carry a
// key, so it is never written), on disk across restarts, and shared by every proxy of one operator.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logErr } from './metrics.ts'

/** How long a spent provider is passed over before one request asks it again. */
export const QUOTA_RECHECK_MS = 60 * 60_000

/**
 * A refusal that says the plan's quota is spent, not that the provider is busy for a second: Alchemy's "Monthly
 * capacity limit exceeded", QuickNode's credit errors, a 402, and the usual quota and credit wordings. A burst limit
 * ("too many requests", "exceeded its throughput") is not one of them.
 */
const QUOTA_RE = /monthly capacity|capacity limit exceeded|monthly (request |compute unit |cu )?(limit|quota)|quota (exceeded|exhausted|reached)|out of (credits|compute units)|(credit|credits) (limit|exhausted|exceeded)|insufficient (credits|balance)|upgrade your (plan|scaling policy)|payment required/i

export function quotaExhausted(status: number | undefined, err: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (status === 402 || err?.code === 402) return true
  const message = String(err?.message ?? '')
  // A revert carries the contract's own words, which can say anything: never a reason to drop a provider.
  if (err?.code === 3 || /revert/i.test(message)) return false
  return QUOTA_RE.test(message)
}

type Entry = { label: string; since: number; until: number }

export type QuotaSnapshot = { label: string; state: 'exhausted'; since: string; recheckAt: string }[]

export class QuotaBook {
  private readonly entries = new Map<string, Entry>()
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

  /** True while `url` is marked spent and its recheck time has not come. From then on it is asked again, and the first refusal marks it for another period. */
  down(url: string, now: number = Date.now()): boolean {
    const e = this.entries.get(QuotaBook.key(url))
    return !!e && now < e.until
  }

  /** Marks `url` spent. Alerts on the first refusal only; a recheck that is refused again pushes the next one out quietly. */
  mark(url: string, label: string, words: string, now: number = Date.now()): void {
    const k = QuotaBook.key(url)
    const was = this.entries.get(k)
    this.entries.set(k, { label, since: was?.since ?? now, until: now + this.recheckMs })
    if (!was) logErr('[alert]', `RPC provider ${label} is out of quota (${words}): passed over, asked again every ${Math.round(this.recheckMs / 60_000)} min`)
    this.save()
  }

  /** A good answer from `url`: whatever mark it had is gone. */
  clear(url: string): void {
    const k = QuotaBook.key(url)
    const was = this.entries.get(k)
    if (!was) return
    this.entries.delete(k)
    logErr('[rpc]', `RPC provider ${was.label} answers again after running out of quota`)
    this.save()
  }

  snapshot(): QuotaSnapshot {
    return [...this.entries.values()].map((e) => ({ label: e.label, state: 'exhausted', since: new Date(e.since).toISOString(), recheckAt: new Date(e.until).toISOString() }))
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
