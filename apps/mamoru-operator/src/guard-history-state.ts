import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GuardSeries } from '@mamoru/rpc'
import type { RegistryName } from '@mamoru/registry'

type PersistedPoint = { time: number; tickCumulative: string }
type Persisted = Record<string, PersistedPoint[]>

function isValidPoint(v: unknown): v is PersistedPoint {
  if (!v || typeof v !== 'object') return false
  const p = v as { time?: unknown; tickCumulative?: unknown }
  return typeof p.time === 'number' && Number.isFinite(p.time) && typeof p.tickCumulative === 'string' && /^-?\d+$/.test(p.tickCumulative)
}

function toPersisted(series: ReadonlyMap<RegistryName, GuardSeries>): Persisted {
  const out: Persisted = Object.create(null) as Persisted
  for (const [name, s] of series) out[name] = s.points.map((p) => ({ time: p.time, tickCumulative: p.tickCumulative.toString() }))
  return out
}

/** Drops anything malformed rather than trusting it: a hand-edited or corrupted state file must not crash the operator (same rule as `metrics.ts`'s `isValidCounters`). */
function fromPersisted(raw: unknown): Map<RegistryName, GuardSeries> {
  const out = new Map<RegistryName, GuardSeries>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, points] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(points)) continue
    const valid = points.filter(isValidPoint).map((p) => ({ time: p.time, tickCumulative: BigInt(p.tickCumulative) }))
    out.set(name, { points: valid })
  }
  return out
}

/**
 * Spec 004 (#101) LC-T6: persists `Engine.guardSeries` (the rolling 24 h fallback for a pool whose on-chain
 * oracle cannot answer the full window) to `stateDir/guard-history.json`, atomically (tmp file + rename, 0600)
 * like `state.ts`'s account file and `metrics.ts`'s `rpc-usage.json`. A restart loads it back with `snapshot()`
 * and passes it as `EngineConfig.guardHistory.series`, so the series resumes instead of starting cold — a short
 * or gapped one just abstains until it is long enough again (FR-LC-007), never a guess.
 *
 * Not wired into the live operator process yet: `conservador-live-v2` sets no `guards`, so nothing reads
 * `Observation.guard` today. Whoever enables it live (LC-T7, `guards.mode: 'shadow'`) constructs one of these
 * per process, seeds the engines' `guardHistory.series` from `snapshot()`, and calls `update()` with
 * `Engine.guardSeries` after each review.
 */
export class GuardHistoryStore {
  private readonly file: string
  private series: Map<RegistryName, GuardSeries>
  /** `-Infinity` so the first `update()` always persists, whatever clock `now` it is given (real time or a test's own). */
  private lastPersistAt = -Infinity

  constructor(private readonly stateDir: string) {
    this.file = join(stateDir, 'guard-history.json')
    this.series = this.load()
  }

  private load(): Map<RegistryName, GuardSeries> {
    if (!existsSync(this.file)) return new Map()
    try {
      return fromPersisted(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return new Map()
    }
  }

  snapshot(): ReadonlyMap<RegistryName, GuardSeries> {
    return this.series
  }

  /** Replaces the whole series (what `Engine.guardSeries` holds after a review) and persists it, throttled to once a minute like `RpcMetrics`; `flush()` bypasses the throttle for a clean shutdown. */
  update(series: ReadonlyMap<RegistryName, GuardSeries>, now: number = Date.now()): void {
    this.series = new Map(series)
    if (now - this.lastPersistAt >= 60_000) this.flush(now)
  }

  flush(now: number = Date.now()): void {
    this.lastPersistAt = now
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(toPersisted(this.series)), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[guard-history] failed to persist ${this.file}: ${(e as Error)?.message?.split('\n')[0] ?? e}`)
    }
  }
}
