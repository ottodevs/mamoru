// Spec 013 STATS-R9: the k >= 3 owner guard. Pure. It is the only way a stats figure leaves the server: the route
// builds a `GuardInput` (every figure with its exact owner count, which never leaves this module) and sends only
// what `guardStats` returns. Below 3 distinct owners a figure becomes null with TOO_FEW_ACCOUNTS; owner counts go out
// as bands; every USD figure is rounded to whole dollars here (plan §3.7), so no caller can skip the rounding.
import type { StatsFigure, StatsOwnersBand, StatsPoint, StatsReason, StatsView } from '@mamoru/domain'

export const MIN_OWNERS = 3

/** A figure as the queries computed it: USD (not rounded) and the exact number of distinct owners behind it. */
export type GuardFigure = { usd: number | null; owners: number; reason?: StatsReason; dataAsOf: string | null; stale?: true }
export type GuardPoint = { day: string; usd: number | null; owners: number; reason?: StatsReason }

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

export function ownersBand(owners: number): StatsOwnersBand | undefined {
  if (owners >= 50) return '50+'
  if (owners >= 25) return '25+'
  if (owners >= 10) return '10+'
  if (owners >= MIN_OWNERS) return '3+'
  return undefined
}

const dollars = (usd: number) => Math.round(usd)

/** A figure with no value keeps its own reason (not counted is not "too few"); one with a value below k is withheld. */
function guardFigure(f: GuardFigure): StatsFigure {
  const base = { dataAsOf: f.dataAsOf, ...(f.stale ? { stale: true as const } : {}) }
  if (f.usd === null) return { usd: null, reason: f.reason ?? 'NOT_COUNTED', ...base }
  if (f.owners < MIN_OWNERS) return { usd: null, reason: 'TOO_FEW_ACCOUNTS', ...base }
  return { usd: dollars(f.usd), ...(f.reason ? { reason: f.reason } : {}), ...base }
}

function guardPoint(p: GuardPoint): StatsPoint {
  if (p.usd === null) return { day: p.day, usd: null, reason: p.reason ?? 'NOT_COUNTED' }
  const owners = ownersBand(p.owners)
  if (!owners) return { day: p.day, usd: null, reason: 'TOO_FEW_ACCOUNTS' }
  return { day: p.day, usd: dollars(p.usd), owners, ...(p.reason ? { reason: p.reason } : {}) }
}

const passes = (p: GuardPoint) => p.usd !== null && p.owners >= MIN_OWNERS

export function guardStats(input: GuardInput): StatsView {
  const f = input.fundedAccounts
  const fundedAccounts: StatsView['fundedAccounts'] =
    f.count === null ? { count: null, reason: f.reason ?? 'NOT_COUNTED', dataAsOf: f.dataAsOf }
    : f.owners < MIN_OWNERS ? { count: null, reason: 'TOO_FEW_ACCOUNTS', dataAsOf: f.dataAsOf }
    : { count: f.count, ...(f.reason ? { reason: f.reason } : {}), dataAsOf: f.dataAsOf }
  // A chain split goes out only when every one of its points passes: a withheld day inside a chain series would
  // let the other chain's total be subtracted from the aggregate.
  const chains = input.chains?.filter((c) => c.tvl.length > 0 && c.tvl.every(passes)).map((c) => ({ chainId: c.chainId, tvl: c.tvl.map(guardPoint) }))
  return {
    tvlNow: guardFigure(input.tvlNow),
    tvl: input.tvl.map(guardPoint),
    monadFrom: input.monadFrom,
    volume: input.volume.map(guardPoint),
    earned24h: { ...guardFigure(input.earned24h), vaultYield: input.earned24h.vaultYield },
    earnedTotal: { ...guardFigure(input.earnedTotal), since: input.earnedTotal.since, vaultYield: input.earnedTotal.vaultYield },
    fundedAccounts,
    ...(chains && chains.length > 0 ? { chains } : {}),
    sources: input.sources,
  }
}
