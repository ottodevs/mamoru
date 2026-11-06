// Public Stats (spec 013): the one payload `GET /api/stats` returns. Aggregates only: no account key, address or
// per-account row ever appears here. Every figure has passed the k >= 3 owner guard (`api/stats/privacy.ts`) before
// it is cached or sent; a figure that did not pass is `null` with its reason.

/** Why a figure is not a number, or why it is not complete. */
export type StatsReason = 'TOO_FEW_ACCOUNTS' | 'NOT_COUNTED' | 'PARTIAL'

/** Owner count of a point, sent only as a band, never exact. */
export type StatsOwnersBand = '3+' | '10+' | '25+' | '50+'

/** One headline figure, in whole USD. `dataAsOf` is the oldest chain read behind it (ISO), never the request time. */
export type StatsFigure = { usd: number | null; reason?: StatsReason; dataAsOf: string | null; stale?: true }

/**
 * One day of a series (`day` = UTC `YYYY-MM-DD`), in whole USD. `dataAsOf` = the oldest chain read behind the point
 * (ISO); it differs from the day's close when a value was carried forward or the day is still open.
 */
export type StatsPoint = { day: string; usd: number | null; reason?: StatsReason; owners?: StatsOwnersBand; dataAsOf?: string }

export type StatsView = {
  tvlNow: StatsFigure
  /** Daily close, all history; the client slices 1W / 1M / 3M / ALL. */
  tvl: StatsPoint[]
  /** The day Monad tracking was deployed (a system date, never an owner's first activity). Earlier points are Base only. */
  monadFrom: string | null
  volume: StatsPoint[]
  earned24h: StatsFigure & { vaultYield: 'counted' | 'not_counted' }
  earnedTotal: StatsFigure & { since: string; vaultYield: 'counted' | 'not_counted' }
  fundedAccounts: { count: number | null; reason?: StatsReason; dataAsOf: string | null }
  /** Per-chain TVL, present only when every point of that chain passes the guard. */
  chains?: { chainId: number; tvl: StatsPoint[] }[]
  sources: { tvl: string; volume: string; earned: string }
}
