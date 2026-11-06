// Spec 013 STATS-R9 with amendment A1: the k >= 3 owner guard, and the only way a stats figure leaves the server. The
// queries build a GuardInput (every figure with the set of owners behind it and whether it is complete); the route
// sends only what `guardStats` returns. A figure is published only if it is complete, finite, fresh (data at most 1 h
// old) and backed by at least 3 distinct owners (allow-if: anything else withholds). Withheld means absent: A1 has no
// "not counted" state. Distributions merge slices below k into "Other"; if that leaves "Other" itself below k (one
// hidden slice, or a few tiny ones) the whole split is withheld, so a slice can never be read as total minus the rest.
// Series keep their longest run of valid days ending at the last one. Accepted on purpose (owners' decisions): the
// largest account's value (S9) and the accounts count (S7) are exact, and two readings can be subtracted (plan §3.7).
import type { StatsAprPoint, StatsFigure, StatsSlice, StatsView } from '@mamoru/domain'

export const MIN_OWNERS = 3
export const STALE_MS = 60 * 60 * 1000

/** Allow-if: only a whole number of owners at or above k publishes. NaN, undefined, negatives and fractions withhold. */
export const enoughOwners = (owners: unknown): owners is number => Number.isInteger(owners) && (owners as number) >= MIN_OWNERS

export type Rounding = 'dollars' | 'cents' | 'pct' | 'count'
/** A figure as the queries computed it: plain number (USD, percent or count) with the owners behind it. */
export type GuardFigure = { value: number; owners: ReadonlySet<string>; complete: boolean; dataAsOf: string | null }
export type GuardSlice = { key: string; usd: number; owners: ReadonlySet<string> }
export type GuardSplit = { slices: GuardSlice[]; complete: boolean; dataAsOf: string | null }
export type GuardAprDay = { day: string; earned: number; capital: number; owners: ReadonlySet<string>; complete: boolean }
export type GuardEarnedDay = { day: string; usd: number; collectedUsd: number; owners: ReadonlySet<string>; complete: boolean }
export type GuardDepositsDay = { day: string; usd: number; owners: ReadonlySet<string>; complete: boolean }

export type SnapshotKey = keyof StatsView['snapshots']
export const ROUNDING: Record<SnapshotKey, Rounding> = {
  totalDeposits: 'dollars', moneyWorking: 'dollars', idleCapital: 'dollars', earned24h: 'cents', totalEarned: 'cents',
  apr7d: 'pct', totalAccounts: 'count', averageAccount: 'dollars', largestAccount: 'dollars', inStablecoins: 'pct',
}

export type GuardInput = {
  now: Date
  snapshots: Partial<Record<SnapshotKey, GuardFigure>>
  distributions: Partial<Record<keyof StatsView['distributions'], GuardSplit>>
  apr: { all: GuardAprDay[]; base?: GuardAprDay[]; monad?: GuardAprDay[] }
  earnedPerDay: GuardEarnedDay[]
  totalDeposits: GuardDepositsDay[]
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const round = (v: number, r: Rounding): number => (r === 'cents' ? Math.round(v * 100) / 100 : r === 'pct' ? Math.round(v * 10) / 10 : Math.round(v))
const fresh = (dataAsOf: string | null, now: Date) => dataAsOf !== null && Number.isFinite(Date.parse(dataAsOf)) && now.getTime() - Date.parse(dataAsOf) <= STALE_MS

export function guardFigure(f: GuardFigure | undefined, r: Rounding, now: Date): StatsFigure | undefined {
  if (!f || !f.complete || !finite(f.value) || f.value < 0 || !enoughOwners(f.owners.size) || !fresh(f.dataAsOf, now)) return undefined
  return { value: round(f.value, r), dataAsOf: f.dataAsOf! }
}

export function guardSplit(s: GuardSplit | undefined, now: Date): StatsSlice[] | undefined {
  if (!s || !s.complete || !fresh(s.dataAsOf, now)) return undefined
  const slices = s.slices.filter((x) => finite(x.usd) && x.usd > 0)
  if (!slices.length || s.slices.some((x) => !finite(x.usd) || x.usd < 0)) return undefined
  const shown = slices.filter((x) => enoughOwners(x.owners.size))
  const hidden = slices.filter((x) => !enoughOwners(x.owners.size))
  const out = shown.map((x) => ({ key: x.key, usd: x.usd }))
  if (hidden.length) {
    const owners = new Set(hidden.flatMap((x) => [...x.owners]))
    if (!enoughOwners(owners.size)) return undefined
    out.push({ key: 'Other', usd: hidden.reduce((a, x) => a + x.usd, 0) })
  }
  const total = out.reduce((a, x) => a + x.usd, 0)
  return out.sort((a, b) => (a.key === 'Other' ? 1 : b.key === 'Other' ? -1 : b.usd - a.usd)).map((x) => ({ key: x.key, usd: round(x.usd, 'dollars'), pct: round((x.usd / total) * 100, 'pct') }))
}

/** The longest run of valid points that ends at the last point; nothing if the last point is not valid. */
export function validSuffix<T>(points: readonly T[], ok: (p: T) => boolean): T[] {
  let i = points.length
  while (i > 0 && ok(points[i - 1]!)) i--
  return points.slice(i)
}

const aprOk = (p: GuardAprDay) => p.complete && finite(p.earned) && finite(p.capital) && p.capital > 0 && enoughOwners(p.owners.size)

/** Daily APR (percent) and, once 7 valid days exist, the 7-day figure from 7-day sums (capital-weighted, no compounding). */
export function guardApr(days: readonly GuardAprDay[] | undefined): StatsAprPoint[] | undefined {
  const run = validSuffix(days ?? [], aprOk)
  if (!run.length) return undefined
  return run.map((p, i) => {
    const point: StatsAprPoint = { day: p.day, apr: round((p.earned / p.capital) * 365 * 100, 'pct') }
    if (i >= 6) {
      const w = run.slice(i - 6, i + 1)
      const owners = new Set(w.flatMap((x) => [...x.owners]))
      if (enoughOwners(owners.size)) point.apr7d = round((w.reduce((a, x) => a + x.earned, 0) / w.reduce((a, x) => a + x.capital, 0)) * 365 * 100, 'pct')
    }
    return point
  })
}

export function guardStats(input: GuardInput): StatsView {
  const now = input.now
  const snapshots: StatsView['snapshots'] = {}
  for (const key of Object.keys(ROUNDING) as SnapshotKey[]) {
    const f = guardFigure(input.snapshots[key], ROUNDING[key], now)
    if (f) snapshots[key] = f
  }
  const distributions: StatsView['distributions'] = {}
  for (const key of ['byToken', 'byChain', 'byPlace'] as const) {
    const d = guardSplit(input.distributions[key], now)
    if (d) distributions[key] = d
  }
  const all = guardApr(input.apr.all)
  const base = guardApr(input.apr.base)
  const monad = guardApr(input.apr.monad)
  const earnedPerDay = validSuffix(input.earnedPerDay, (p) => p.complete && finite(p.usd) && finite(p.collectedUsd) && enoughOwners(p.owners.size)).map((p) => ({ day: p.day, usd: round(p.usd, 'cents'), collectedUsd: round(p.collectedUsd, 'cents') }))
  const totalDeposits = validSuffix(input.totalDeposits, (p) => p.complete && finite(p.usd) && enoughOwners(p.owners.size)).map((p) => ({ day: p.day, usd: round(p.usd, 'dollars') }))
  const series: StatsView['series'] = {}
  if (all) series.apr = { all, ...(base ? { base } : {}), ...(monad ? { monad } : {}) }
  if (earnedPerDay.length) series.earnedPerDay = earnedPerDay
  if (totalDeposits.length) series.totalDeposits = totalDeposits
  const times = [...Object.values(snapshots).map((f) => f.dataAsOf)].sort()
  return { dataAsOf: times[0] ?? null, snapshots, distributions, series }
}
