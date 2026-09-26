import type { Figure, Provenance } from '@mamoru/domain'

/** Engine cron period (plan §19): a projection older than two periods is stale (dashboard.md §5). */
export const CRON_SECONDS = 120
export const STALE_AFTER_MS = 2 * CRON_SECONDS * 1000

// Sources written by the engine's projections; d1 and journal rows are records, not observations, and do not age.
const AGEING: ReadonlySet<Provenance['source']> = new Set(['chain_rpc', 'fork_rpc', 'multibaas', 'estimate'])

export function notObserved<T>(source: Provenance['source'], chainId: number, now: Date, unit?: string): Figure<T> {
  const provenance: Provenance = { source, chainId, observedAt: now.toISOString(), status: 'not_observed' }
  return unit ? { value: null, unit, provenance } : { value: null, provenance }
}

function isProvenance(v: Record<string, unknown>): v is Provenance {
  return typeof v.source === 'string' && typeof v.chainId === 'number' && typeof v.observedAt === 'string' && typeof v.status === 'string'
}

/** Copy of `value` where every fresh projected Provenance older than STALE_AFTER_MS reads as stale. */
export function aged<T>(value: T, now: Date): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v !== 'object' || v === null) return v
    const o = v as Record<string, unknown>
    if (isProvenance(o)) {
      const old = now.getTime() - Date.parse(o.observedAt) > STALE_AFTER_MS
      return o.status === 'fresh' && AGEING.has(o.source) && old ? { ...o, status: 'stale' } : { ...o }
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]))
  }
  return walk(value) as T
}

/** True when no Provenance inside `value` is not_observed. */
export function everythingObserved(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(everythingObserved)
  if (typeof value !== 'object' || value === null) return true
  const o = value as Record<string, unknown>
  if (isProvenance(o)) return o.status !== 'not_observed'
  return Object.values(o).every(everythingObserved)
}
