// Spec 013 STATS-R9: the k >= 3 owner guard. Pure. It is the only way a stats figure leaves the server: the route
// builds a `GuardInput` (every figure with its exact owner count, which never leaves this module) and sends only
// what `guardStats` returns. Below 3 distinct owners a figure becomes null with TOO_FEW_ACCOUNTS; owner counts behind
// a figure go out as bands; every USD figure is rounded to whole dollars here (plan §3.7), so no caller can skip it.
// Two things are public on purpose (owners' decisions, spec 013): the Funded accounts count is exact (STATS-R7b, the
// "users" figure the pitch cites), and two readings can be subtracted (accepted risk, plan §3.7). Malformed input
// (a non-finite amount, a non-integer count) is never published: it goes out as NOT_COUNTED.
import type { StatsFigure, StatsOwnersBand, StatsPoint, StatsReason, StatsView } from '@mamoru/domain'

export const MIN_OWNERS = 3

/** A figure as the queries computed it: USD (not rounded) and the exact number of distinct owners behind it. */
export type GuardFigure = { usd: number | null; owners: number; reason?: StatsReason; dataAsOf: string | null; stale?: true }
export type GuardPoint = { day: string; usd: number | null; owners: number; reason?: StatsReason; dataAsOf?: string }

export type GuardInput = {
  tvlNow: GuardFigure
  tvl: GuardPoint[]
  monadFrom: string | null
  volume: GuardPoint[]
  earned24h: GuardFigure & { vaultYield: 'counted' | 'not_counted' }
  earnedTotal: GuardFigure & { since: string; vaultYield: 'counted' | 'not_counted' }
  /** `count` = funded accounts; `owners` = distinct owners behind them. */
  fundedAccounts: { count: number | null; owners: number; reason?: StatsReason; dataAsOf: string | null }
  chains?: { chainId: number; tvl: GuardPoint[] }[]
  sources: StatsView['sources']
}

/** Allow-if: only a whole number of owners at or above k publishes. NaN, undefined, negatives and fractions withhold. */
export const enoughOwners = (owners: unknown): owners is number => Number.isInteger(owners) && (owners as number) >= MIN_OWNERS

export function ownersBand(owners: number): StatsOwnersBand | undefined {
  if (!enoughOwners(owners)) return undefined
  if (owners >= 50) return '50+'
  if (owners >= 25) return '25+'
  if (owners >= 10) return '10+'
  return '3+'
}

const dollars = (usd: number) => Math.round(usd)
const finite = (usd: number | null | undefined): usd is number => typeof usd === 'number' && Number.isFinite(usd)

/** A figure with no value keeps its own reason (not counted is not "too few"); one with a value below k is withheld. */
function guardFigure(f: GuardFigure): StatsFigure {
  const base = { dataAsOf: f.dataAsOf, ...(f.stale ? { stale: true as const } : {}) }
  if (f.usd === null) return { usd: null, reason: f.reason ?? 'NOT_COUNTED', ...base }
  if (!finite(f.usd)) return { usd: null, reason: 'NOT_COUNTED', ...base }
  if (!enoughOwners(f.owners)) return { usd: null, reason: 'TOO_FEW_ACCOUNTS', ...base }
  return { usd: dollars(f.usd), ...(f.reason ? { reason: f.reason } : {}), ...base }
}

function guardPoint(p: GuardPoint): StatsPoint {
  const at = p.dataAsOf ? { dataAsOf: p.dataAsOf } : {}
  if (p.usd === null) return { day: p.day, usd: null, reason: p.reason ?? 'NOT_COUNTED', ...at }
  if (!finite(p.usd)) return { day: p.day, usd: null, reason: 'NOT_COUNTED', ...at }
  const owners = ownersBand(p.owners)
  if (!owners) return { day: p.day, usd: null, reason: 'TOO_FEW_ACCOUNTS', ...at }
  return { day: p.day, usd: dollars(p.usd), owners, ...(p.reason ? { reason: p.reason } : {}), ...at }
}

const passes = (p: GuardPoint) => finite(p.usd) && enoughOwners(p.owners)

/**
 * The chain split may go out only if it is the whole split: every chain passes on every day, each chain covers every
 * total day from its first one on, the total passes on those days, and the chains add up to the total (so no chain is
 * missing from the set the caller passed). Otherwise total − published chains could reveal a withheld one.
 */
function splitPublishable(chains: readonly { chainId: number; tvl: GuardPoint[] }[], total: readonly GuardPoint[]): boolean {
  if (!chains.length || !chains.every((c) => c.tvl.length > 0 && c.tvl.every(passes))) return false
  const byDay = new Map(total.map((p) => [p.day, p]))
  for (const c of chains) {
    const first = c.tvl.reduce((a, p) => (p.day < a ? p.day : a), c.tvl[0]!.day)
    const days = new Set(c.tvl.map((p) => p.day))
    for (const t of total) if (t.day >= first && !days.has(t.day)) return false
    for (const p of c.tvl) if (!byDay.has(p.day)) return false
  }
  for (const t of total) {
    const parts = chains.map((c) => c.tvl.find((p) => p.day === t.day)).filter((p): p is GuardPoint => p !== undefined)
    if (!parts.length) continue
    if (!passes(t)) return false
    const sum = parts.reduce((a, p) => a + (p.usd as number), 0)
    if (Math.abs(sum - (t.usd as number)) > 0.5) return false
  }
  return true
}

export function guardStats(input: GuardInput): StatsView {
  const f = input.fundedAccounts
  const fundedAccounts: StatsView['fundedAccounts'] =
    f.count === null ? { count: null, reason: f.reason ?? 'NOT_COUNTED', dataAsOf: f.dataAsOf }
    : !Number.isInteger(f.count) || f.count < 0 ? { count: null, reason: 'NOT_COUNTED', dataAsOf: f.dataAsOf }
    : !enoughOwners(f.owners) ? { count: null, reason: 'TOO_FEW_ACCOUNTS', dataAsOf: f.dataAsOf }
    : { count: f.count, ...(f.reason ? { reason: f.reason } : {}), dataAsOf: f.dataAsOf }
  // The chain split goes out whole or not at all: if any chain fails on any day, publishing the others would let
  // the withheld chain be computed as total minus the published chains (complementary suppression).
  const all = input.chains ?? []
  const chains = splitPublishable(all, input.tvl) ? all.map((c) => ({ chainId: c.chainId, tvl: c.tvl.map(guardPoint) })) : undefined
  return {
    tvlNow: guardFigure(input.tvlNow),
    tvl: input.tvl.map(guardPoint),
    monadFrom: input.monadFrom,
    volume: input.volume.map(guardPoint),
    earned24h: { ...guardFigure(input.earned24h), vaultYield: input.earned24h.vaultYield },
    earnedTotal: { ...guardFigure(input.earnedTotal), since: input.earnedTotal.since, vaultYield: input.earnedTotal.vaultYield },
    fundedAccounts,
    ...(chains ? { chains } : {}),
    sources: input.sources,
  }
}
