// Public Stats (spec 013 amendment A1): the one payload `GET /api/stats` returns. Aggregates only: no account key,
// address, user id or per-account row ever appears here. A figure, slice set or series that is not complete, is stale
// (data older than 1 h) or is backed by fewer than 3 owners is absent: the page hides that block. There is no
// "not counted" state in the payload.

/** One snapshot figure. `value`: USD (whole dollars, or cents for earned), a percent (one decimal) or a count. */
export type StatsFigure = { value: number; dataAsOf: string }

/** One slice of a distribution: USD (whole dollars) and its share of the whole, in percent (one decimal). */
export type StatsSlice = { key: string; usd: number; pct: number }

export type StatsAprPoint = { day: string; apr: number; apr7d?: number }

export type StatsView = {
  /** The oldest chain read behind the published figures (ISO). */
  dataAsOf: string | null
  snapshots: {
    /** S1: idle + positions + vaults + uncollected fees + USDC in flight, every chain. */
    totalDeposits?: StatsFigure
    /** S2: positions + vaults. */
    moneyWorking?: StatsFigure
    /** S3: Safe balances not placed. */
    idleCapital?: StatsFigure
    /** S4, S5: fees collected + fees accrued + vault yield, USD to the cent. */
    earned24h?: StatsFigure
    totalEarned?: StatsFigure
    /** S6: capital-weighted APR over the last 7 days, percent. */
    apr7d?: StatsFigure
    /** S7: accounts created. */
    totalAccounts?: StatsFigure
    /** S8: S1 / accounts holding more than $1. */
    averageAccount?: StatsFigure
    /** S9: the largest account's value, the number only. */
    largestAccount?: StatsFigure
    /** S10: share of S1 in USD stablecoins, percent. */
    inStablecoins?: StatsFigure
  }
  /** D1 by token, D2 by chain, D3 by place. Slices backed by < 3 owners are merged into "Other". */
  distributions: { byToken?: StatsSlice[]; byChain?: StatsSlice[]; byPlace?: StatsSlice[] }
  series: {
    /** T1: daily APR and its 7-day figure, all chains and per chain. */
    apr?: { all: StatsAprPoint[]; base?: StatsAprPoint[]; monad?: StatsAprPoint[] }
    /** T2: USD earned per day (cents), and the part collected that day (absent when fewer than 3 owners collected). */
    earnedPerDay?: { day: string; usd: number; collectedUsd?: number }[]
    /** T3: S1 at each UTC day's close (whole dollars). */
    totalDeposits?: { day: string; usd: number }[]
  }
}
