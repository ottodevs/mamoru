import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeeGrowthHistory, FeePoint, GuardPoint, GuardSeries, SharedGuardState } from '@mamoru/rpc'
import type { RegistryName } from '@mamoru/registry'

const DAY = 86_400
/** Kept fee points are a day and an hour back at most (`addFeePoint`), 600 s apart at least. */
const FEE_MAX_AGE = DAY + 3_600
const FEE_MAX_POINTS = (2 * DAY) / 600 + 8
const MAX_POOLS = 32
const MAX_WINDOWS = 8
/** A saved point stamped this far in the future is not trusted. */
const FUTURE_SLACK = 300
const POOL = /^pool:[A-Za-z0-9]+\/[A-Za-z0-9]+\/\d+$/
const UINT = /^\d{1,78}$/
const INT = /^-?\d{1,78}$/
const U256 = 1n << 256n

type Saved = {
  fees: Record<string, { time: number; growth0X128: string; growth1X128: string }[]>
  series: Record<string, Record<string, { time: number; tickCumulative: string }[]>>
}

const isTime = (t: unknown): t is number => typeof t === 'number' && Number.isInteger(t) && t > 0

/** Valid windows are the ones `guardSecondsAgos` can make a 24 h history with. */
const isWindow = (w: number) => Number.isInteger(w) && w >= 60 && w <= DAY / 2 && DAY % w === 0

/** Sorted by time, one point per time (the last), the newest `max` only. */
function tidy<T extends { time: number }>(points: T[], max: number): T[] {
  points.sort((a, b) => a.time - b.time)
  return points.filter((p, i) => i === points.length - 1 || p.time !== points[i + 1]!.time).slice(-max)
}

function poolEntries(raw: unknown): [RegistryName, unknown[]][] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>)
    .filter((e): e is [string, unknown[]] => POOL.test(e[0]) && Array.isArray(e[1]))
    .slice(0, MAX_POOLS) as [RegistryName, unknown[]][]
}

/**
 * otto/mamoru#172: what `SharedGuardReads` knows, kept across operator restarts in `stateDir/guard-reads.json`: the
 * fee history (the cost test's fees) and the fallback series per TWAP window (its volatility for a pool whose long
 * `observe` cannot answer). Written by the operator process only, at most once a minute, 0600, tmp + rename.
 * Loaded strictly: malformed entries, unknown pools or windows, points older than the histories ever keep or stamped
 * in the future are dropped, and each list is capped at what the histories hold, so a stale or hand-edited file can
 * only mean less history (fail closed: the lazy rule holds), never a made-up one. A gap while the operator was down
 * is not filled: fee growth globals only grow, so the 24 h difference stays right; a series gap makes `marketOf`
 * abstain until it ages out, as for any gap.
 */
export class GuardReadsState {
  private readonly file: string
  private lastPersistAt = -Infinity

  constructor(private readonly stateDir: string) {
    this.file = join(stateDir, 'guard-reads.json')
  }

  /** `now`: unix seconds the ages are measured against. */
  load(now: number = Math.floor(Date.now() / 1000)): SharedGuardState {
    const fees: FeeGrowthHistory = new Map()
    const series = new Map<number, Map<RegistryName, GuardSeries>>()
    const empty = { fees, series }
    if (!existsSync(this.file)) return empty
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return empty
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
    const o = raw as Record<string, unknown>
    const fresh = (t: number, maxAge: number) => now - t <= maxAge && t <= now + FUTURE_SLACK
    for (const [name, points] of poolEntries(o.fees)) {
      const ok: FeePoint[] = []
      for (const p of points as Record<string, unknown>[]) {
        if (!p || typeof p !== 'object' || !isTime(p.time) || !fresh(p.time, FEE_MAX_AGE)) continue
        if (typeof p.growth0X128 !== 'string' || typeof p.growth1X128 !== 'string' || !UINT.test(p.growth0X128) || !UINT.test(p.growth1X128)) continue
        const g0 = BigInt(p.growth0X128)
        const g1 = BigInt(p.growth1X128)
        if (g0 >= U256 || g1 >= U256) continue
        ok.push({ time: p.time, growth0X128: g0, growth1X128: g1 })
      }
      if (ok.length) fees.set(name, tidy(ok, FEE_MAX_POINTS))
    }
    const windows = o.series && typeof o.series === 'object' && !Array.isArray(o.series) ? Object.entries(o.series as Record<string, unknown>) : []
    for (const [key, pools] of windows.slice(0, MAX_WINDOWS)) {
      const w = Number(key)
      if (String(w) !== key || !isWindow(w)) continue
      // What `observeGuardHistory` keeps (`maxAgeOf`): the 24.5 h window plus one more, about one point per half window.
      const maxAge = DAY + 2 * w
      const maxPoints = (4 * DAY) / w + 8
      const byPool = new Map<RegistryName, GuardSeries>()
      for (const [name, points] of poolEntries(pools)) {
        const ok: GuardPoint[] = []
        for (const p of points as Record<string, unknown>[]) {
          if (!p || typeof p !== 'object' || !isTime(p.time) || !fresh(p.time, maxAge)) continue
          if (typeof p.tickCumulative !== 'string' || !INT.test(p.tickCumulative)) continue
          ok.push({ time: p.time, tickCumulative: BigInt(p.tickCumulative) })
        }
        if (ok.length) byPool.set(name, { points: tidy(ok, maxPoints) })
      }
      if (byPool.size) series.set(w, byPool)
    }
    return { fees, series }
  }

  /** Persists, throttled to once a minute (`nowMs`, injectable for tests). */
  update(state: SharedGuardState, nowMs: number = Date.now()): void {
    if (nowMs - this.lastPersistAt < 60_000) return
    this.lastPersistAt = nowMs
    const out: Saved = { fees: {}, series: {} }
    for (const [name, points] of state.fees) out.fees[name] = points.map((p) => ({ time: p.time, growth0X128: p.growth0X128.toString(), growth1X128: p.growth1X128.toString() }))
    for (const [w, pools] of state.series) {
      const byPool: Saved['series'][string] = {}
      for (const [name, s] of pools) byPool[name] = s.points.map((p) => ({ time: p.time, tickCumulative: p.tickCumulative.toString() }))
      out.series[String(w)] = byPool
    }
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[guard-reads] failed to persist ${this.file}: ${(e as Error)?.message?.split('\n')[0] ?? e}`)
    }
  }
}
