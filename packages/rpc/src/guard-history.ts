import { parseAbi, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { marketOf, type CumulativePoint, type PoolGuardObs } from '@mamoru/decide'
import { uniswapV3PoolAbi, type RegistryName } from '@mamoru/registry'
import { Batch, contractRead } from './multicall.ts'

const observeAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])

const DAY = 86_400

/**
 * Spec 004 (#101), `marketOf`'s own windowing (`packages/decide/src/guard/index.ts`): the exact `secondsAgos`
 * (oldest first, `0` last) that answer every point `marketOf(now, windowSeconds, ...)` will ask `cumulativeAt`
 * for. Empty when `windowSeconds` cannot make a 24 h history (mirrors `marketOf`'s own guard, so a caller never
 * builds a request `marketOf` would reject anyway).
 */
export function guardSecondsAgos(windowSeconds: number): number[] {
  if (windowSeconds <= 0 || DAY % windowSeconds !== 0) return []
  const segments = DAY / windowSeconds
  if (segments < 2) return []
  const out: number[] = []
  for (let m = segments + 1; m >= 0; m--) out.push(m * windowSeconds)
  return out
}

/** One point of the rolling fallback series: a pool's tick-cumulative at a review's block timestamp. */
export type GuardPoint = { time: number; tickCumulative: bigint }

/**
 * The live fallback for a pool whose on-chain oracle cannot answer the full 24.5 h window (FR-LC-002): points fed
 * in from the engine's own reviews, roughly one per `windowSeconds`, oldest first. Persisted by the caller
 * (`@mamoru/decide`'s `fallFreezeOf` and this module both treat a short or gapped series as missing history,
 * never a guess) so an operator restart resumes it instead of starting cold.
 */
export type GuardSeries = { points: readonly GuardPoint[] }

export function emptyGuardSeries(): GuardSeries {
  return { points: [] }
}

/**
 * Folds one review's point into `series`. The moving head (`kept.at(-1)`) is replaced, never appended, as long
 * as doing so would still sit within half a window of the anchor before it (`kept.at(-2)`) — `marketOf` itself
 * never accepts a point `windowSeconds / 2` or more from the time it asked for, so the series must never let two
 * *kept* points drift further apart than that, however often `addGuardPoint` itself is called. A review every
 * few seconds only replaces the head each time; once advancing it would open that gap, the head is frozen (it
 * becomes the next anchor) and a fresh head is appended. The series this produces holds roughly one point per
 * `windowSeconds / 2`, not one per review. Points `maxAgeSeconds` or older than `point.time` are dropped first. A
 * point at or before the last kept one is ignored — a provider that answers an older block, or two reviews
 * landing on the same second, never make the series go backwards.
 */
export function addGuardPoint(series: GuardSeries, point: GuardPoint, windowSeconds: number, maxAgeSeconds: number): GuardSeries {
  const kept = series.points.filter((p) => point.time - p.time < maxAgeSeconds)
  const last = kept.at(-1)
  if (last && point.time <= last.time) return { points: kept }
  const anchor = kept.at(-2)
  if (anchor && point.time - anchor.time < windowSeconds / 2) return { points: [...kept.slice(0, -1), point] }
  return { points: [...kept, point] }
}

/**
 * `cumulativeAt` over a rolling series, exactly as `packages/backtest/src/observe.ts`'s `cumulativeAt` reads a
 * dataset: the last point at or before `t`. `marketOf` itself refuses a point more than half a window early or
 * any point after `t` (FR-LC-002), so a short or gapped series abstains there, not here.
 */
export function cumulativeAtOf(series: GuardSeries): (t: number) => CumulativePoint | null {
  const points = series.points
  return (t: number): CumulativePoint | null => {
    let lo = 0
    let hi = points.length - 1
    if (hi < 0 || points[0]!.time > t) return null
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (points[mid]!.time <= t) lo = mid
      else hi = mid - 1
    }
    const p = points[lo]!
    return { time: p.time, tickCumulative: p.tickCumulative }
  }
}

/** `cumulativeAt` straight from one on-chain `observe(secondsAgos)` answer: every requested offset is an exact point, never an interpolation guess. */
export function cumulativeAtFromObserve(now: number, secondsAgos: readonly number[], tickCumulatives: readonly bigint[]): (t: number) => CumulativePoint | null {
  const at = new Map<number, bigint>()
  secondsAgos.forEach((s, i) => {
    if (tickCumulatives[i] !== undefined) at.set(now - s, tickCumulatives[i]!)
  })
  return (t: number): CumulativePoint | null => {
    const c = at.get(t)
    return c === undefined ? null : { time: t, tickCumulative: c }
  }
}

export type PoolGuardTarget = { name: RegistryName; address: Address }

/** otto/mamoru#172: a pool's fee growth globals (X128, per unit of liquidity) at a review's block timestamp. */
export type FeePoint = { time: number; growth0X128: bigint; growth1X128: bigint }

/**
 * #172: fee growth points per pool for the lazy re-range's cost test (`PoolGuardObs.feeGrowth24h`). One map per
 * operator process, shared by every engine (a pool's fee growth is the same for every account), so an engine that
 * just started (a restart, a session that came back) reads the history the others built. In memory only: after an
 * operator restart the cost test abstains for 12 h, and the buffer and the dwell decide alone.
 */
export type FeeGrowthHistory = Map<RegistryName, readonly FeePoint[]>

/** Kept points are at least this far apart: about 150 per pool over a day, whatever the review cadence. */
export const FEE_POINT_STEP_SECONDS = 600
const FEE_MAX_AGE_SECONDS = DAY + 3_600
const U256 = 1n << 256n

/**
 * Folds one point in, as `addGuardPoint` does: the moving head is replaced until it is a step past the point before
 * it; points older than a day and an hour are dropped; a point at or before the last kept one is ignored (another
 * engine already read this block, or a provider answered an older one).
 */
export function addFeePoint(points: readonly FeePoint[], point: FeePoint): readonly FeePoint[] {
  const kept = points.filter((p) => point.time - p.time < FEE_MAX_AGE_SECONDS)
  const last = kept.at(-1)
  if (last && point.time <= last.time) return kept
  const anchor = kept.at(-2)
  if (anchor && point.time - anchor.time < FEE_POINT_STEP_SECONDS) return [...kept.slice(0, -1), point]
  return [...kept, point]
}

/**
 * Fee growth from the first point at or after 24 h before `cur` to `cur`, as the Lab reads a dataset
 * (`packages/backtest/src/observe.ts` `feeGrowthOf`). Null when the history covers less than 12 h.
 */
export function feeGrowth24hOf(points: readonly FeePoint[], cur: FeePoint): PoolGuardObs['feeGrowth24h'] {
  const old = points.find((p) => p.time >= cur.time - DAY && p.time < cur.time)
  if (!old || cur.time - old.time < DAY / 2) return null
  const growth = (a: bigint, b: bigint) => (((a - b) % U256) + U256) % U256
  return { growth0X128: growth(cur.growth0X128, old.growth0X128), growth1X128: growth(cur.growth1X128, old.growth1X128), seconds: cur.time - old.time }
}

export type GuardHistoryResult = {
  /** `Observation.guard.pools`, one entry per target: `marketOf`'s result, on-chain or from the rolling series. */
  pools: Partial<Record<RegistryName, PoolGuardObs>>
  /** `series`, with this review's point folded in for every target whose own `observe([0])` answered. The caller persists this for the next review. */
  series: ReadonlyMap<RegistryName, GuardSeries>
  /** Targets whose on-chain oracle answered the full 24.5 h window this review (no fallback needed). For logging and the CU estimate only; `pools`/`series` do not depend on it. */
  onChain: ReadonlySet<RegistryName>
}

/** Keep a series a little past what `marketOf` could ever ask for, so a review that lands a few seconds late still has the oldest point it needs. */
function maxAgeOf(secondsAgos: readonly number[], windowSeconds: number): number {
  return (secondsAgos[0] ?? DAY) + windowSeconds
}

/**
 * Spec 004 (#101) LC-T6: `Observation.guard.pools` for `targets`, live, one Multicall3 batch (one `aggregate3`
 * request, `allowFailure` on every call — a revert on one pool never blocks the others or throws) pinned to
 * `blockNumber` like every other read of the observation (FR-RPC-001). Per target:
 *
 * - the 50-point `observe(secondsAgos)` FR-LC-002 needs for the full 24.5 h window — answers it directly when the
 *   pool's oracle can (`onChain`), via `marketOf` fed by `cumulativeAtFromObserve`;
 * - a 1-point `observe([0])` (the pool's current cumulative; always answerable, any cardinality), folded into
 *   `series` every review regardless of whether the long read answered — so the rolling fallback stays warm even
 *   while the on-chain path is working, and is already caught up if it ever stops.
 *
 * A target whose long read fails (cardinality too low, or simply too young — exactly what Base shows today for
 * the two volatile live pools, see the LC-T6 ticket) falls back to `series` via `cumulativeAtOf`: short or gapped
 * history there abstains the same way `marketOf` already does on the dataset path (`packages/backtest/src/observe.ts`),
 * never a guess (FR-LC-007).
 */
export async function observeGuardHistory(
  client: PublicClient,
  multicall3: Address | null,
  targets: readonly PoolGuardTarget[],
  blockNumber: bigint,
  now: number,
  windowSeconds: number,
  series: ReadonlyMap<RegistryName, GuardSeries>,
  /**
   * #172: when given, the same batch also reads each target's fee growth globals, folds them into this shared
   * history (mutated in place) and sets `feeGrowth24h` on every target (null while the history is short or the
   * read failed). Absent: no extra read, and `feeGrowth24h` is never set.
   */
  fees?: FeeGrowthHistory,
): Promise<GuardHistoryResult> {
  const secondsAgos = guardSecondsAgos(windowSeconds)
  const batch = new Batch(client, multicall3, blockNumber)
  const long = targets.map((t) => (secondsAgos.length > 0 ? batch.add(contractRead(client, { address: t.address, abi: observeAbi, functionName: 'observe', args: [secondsAgos], blockNumber })) : null))
  const nowRead = targets.map((t) => batch.add(contractRead(client, { address: t.address, abi: observeAbi, functionName: 'observe', args: [[0]], blockNumber })))
  const feeRead = fees
    ? targets.map((t) => [0, 1].map((i) => batch.add(contractRead(client, { address: t.address, abi: uniswapV3PoolAbi, functionName: i === 0 ? 'feeGrowthGlobal0X128' : 'feeGrowthGlobal1X128', blockNumber }))))
    : null
  if (batch.size > 0) await batch.run()

  const pools: Partial<Record<RegistryName, PoolGuardObs>> = {}
  const nextSeries = new Map(series)
  const onChain = new Set<RegistryName>()
  const maxAge = maxAgeOf(secondsAgos, windowSeconds)

  targets.forEach((t, i) => {
    const longRes = long[i]?.maybe()
    const nowRes = nowRead[i]!.maybe()
    const prior = series.get(t.name) ?? emptyGuardSeries()
    const updated = nowRes ? addGuardPoint(prior, { time: now, tickCumulative: nowRes[0][0]! }, windowSeconds, maxAge) : prior
    nextSeries.set(t.name, updated)
    if (longRes) {
      onChain.add(t.name)
      pools[t.name] = marketOf(now, windowSeconds, cumulativeAtFromObserve(now, secondsAgos, longRes[0]))
    } else {
      pools[t.name] = marketOf(now, windowSeconds, cumulativeAtOf(updated))
    }
    if (fees && feeRead) {
      const [g0, g1] = feeRead[i]!.map((h) => h.maybe())
      if (g0 == null || g1 == null) {
        pools[t.name] = { ...pools[t.name]!, feeGrowth24h: null }
        return
      }
      const cur = { time: now, growth0X128: g0, growth1X128: g1 }
      const before = fees.get(t.name) ?? []
      fees.set(t.name, addFeePoint(before, cur))
      pools[t.name] = { ...pools[t.name]!, feeGrowth24h: feeGrowth24hOf(before, cur) }
    }
  })

  return { pools, series: nextSeries, onChain }
}
