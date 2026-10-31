import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Observation } from '@mamoru/decide'
import { baseRegistry, entry } from '@mamoru/registry'

/**
 * otto/mamoru#101 phase 1b (shadow only): off-chain pool statistics for Packaging's TVL change and activity rules.
 * - TVL 1d / 7d / 30d ago: first from our own hourly samples of GeckoTerminal's current TVL (kept 31 days in the state
 *   file), else from DefiLlama `yields.llama.fi/chart/<id>` (daily tvlUsd). DefiLlama's yield endpoints need a paid plan
 *   from 2026-11-13: after that the fallback fails quietly and the own series alone carries the rule (no paid API).
 * - GeckoTerminal `/pools/<address>` (reserve_in_usd = current TVL) and `/pools/<address>/ohlcv/day?limit=29` (daily USD
 *   volume, newest first, the first row is the day in progress) -> 7d volume, last full day, 28d daily average.
 * No API keys. Refreshed at most once an hour per pool; a failed fetch keeps the last good value until `staleMs`, then the
 * fields turn null (the rule reports RISK_POOL_STATS_UNREAD, never an exit). Nothing here throws into a review.
 */

type Stats = NonNullable<Observation['poolStats']>[string]
export type PoolStatsPool = { name: string; address: string; llamaId: string }
type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const DAY = 86_400
const LLAMA = 'https://yields.llama.fi/chart/'
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/base/pools/'
const UA = 'mamoru-operator/1.0 (+https://mamoru.lol)'

/** Own TVL samples: kept 31 days, at most this many points per pool. */
const OWN_KEEP_S = 31 * DAY
const OWN_MAX = 1_000
/** An own sample counts for "N days ago" within 2 h of the target (they are hourly). */
const OWN_TOL_S = 2 * 3_600

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

export type LlamaPart = { tvl1dAgoUsd: number | null; tvl7dAgoUsd: number | null; tvl30dAgoUsd: number | null }
export type GeckoPart = { tvlUsd: number | null; volume7dUsd: number | null; volumeLastDayUsd: number | null; volume28dAvgUsd: number | null }

/** TVL N days before now: the nearest daily point, within 12 h of the target (null otherwise, never a point from another day). */
export function parseLlamaChart(json: unknown, nowSec: number): LlamaPart {
  const none: LlamaPart = { tvl1dAgoUsd: null, tvl7dAgoUsd: null, tvl30dAgoUsd: null }
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return none
  const pts = data.flatMap((p) => {
    const t = Date.parse((p as { timestamp?: string })?.timestamp ?? '') / 1000
    const v = num((p as { tvlUsd?: unknown })?.tvlUsd)
    return Number.isFinite(t) && v !== null ? [{ t, v }] : []
  })
  if (!pts.length) return none
  return lookbacksOf(pts, nowSec, DAY / 2)
}

/** The value nearest to `nowSec - N days` for N = 1, 7, 30; null when no point is within `tolS` of that target. */
export function lookbacksOf(pts: readonly { t: number; v: number }[], nowSec: number, tolS: number): LlamaPart {
  const at = (days: number): number | null => {
    if (!pts.length) return null
    const target = nowSec - days * DAY
    const best = pts.reduce((a, b) => (Math.abs(b.t - target) < Math.abs(a.t - target) ? b : a))
    return Math.abs(best.t - target) <= tolS ? best.v : null
  }
  return { tvl1dAgoUsd: at(1), tvl7dAgoUsd: at(7), tvl30dAgoUsd: at(30) }
}

/** Volumes from `ohlcv/day`: complete days only (the row of today's UTC date is dropped); the 28 day average needs 28 of them. */
export function parseGeckoOhlcv(json: unknown, nowSec: number): Pick<GeckoPart, 'volume7dUsd' | 'volumeLastDayUsd' | 'volume28dAvgUsd'> {
  const list = (json as { data?: { attributes?: { ohlcv_list?: unknown } } })?.data?.attributes?.ohlcv_list
  const none = { volume7dUsd: null, volumeLastDayUsd: null, volume28dAvgUsd: null }
  if (!Array.isArray(list)) return none
  const today = Math.floor(nowSec / DAY) * DAY
  const rows = list
    .flatMap((r) => (Array.isArray(r) && typeof r[0] === 'number' && num(r[5]) !== null ? [{ t: r[0] as number, v: r[5] as number }] : []))
    .filter((r) => r.t < today)
    .sort((a, b) => b.t - a.t)
  // Every day of the window must be there: a missing row is unread data (D8), never counted as zero volume.
  const byDay = new Map(rows.map((r) => [r.t, r.v]))
  const days = [...Array(28).keys()].map((i) => byDay.get(today - (i + 1) * DAY))
  const covered = (n: number) => days.slice(0, n).every((v) => v !== undefined)
  const sum = (n: number) => days.slice(0, n).reduce<number>((a, b) => a + (b ?? 0), 0)
  return {
    volume7dUsd: covered(7) ? sum(7) : null,
    volumeLastDayUsd: days[0] ?? null,
    volume28dAvgUsd: covered(28) ? sum(28) / 28 : null,
  }
}

export function parseGeckoPool(json: unknown): number | null {
  return num((json as { data?: { attributes?: { reserve_in_usd?: unknown } } })?.data?.attributes?.reserve_in_usd)
}

type Cached<T> = { at: number; part: T }
type Vols = Pick<GeckoPart, 'volume7dUsd' | 'volumeLastDayUsd' | 'volume28dAvgUsd'>
/** One timestamp per source: a source that keeps failing goes stale on its own while the others stay fresh. */
type PoolCache = { llama?: Cached<LlamaPart>; tvl?: Cached<number>; vols?: Cached<Vols>; own?: { t: number; v: number }[] }

export class PoolStatsCache {
  private readonly cache = new Map<string, PoolCache>()
  private lastTry = new Map<string, number>()
  private inFlight: Promise<void> | null = null
  private readonly fetchFn: Fetch
  private readonly now: () => number
  private readonly refreshMs: number
  private readonly staleMs: number
  private readonly timeoutMs: number
  private readonly gapMs: number
  private readonly retryMs: number
  private readonly stateFile: string | undefined

  constructor(
    private readonly pools: PoolStatsPool[],
    opts: { fetch?: Fetch; now?: () => number; refreshMs?: number; staleMs?: number; timeoutMs?: number; gapMs?: number; retryMs?: number; stateFile?: string } = {},
  ) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init))
    this.now = opts.now ?? Date.now
    this.refreshMs = opts.refreshMs ?? 3_600_000
    this.staleMs = opts.staleMs ?? 6 * 3_600_000
    this.timeoutMs = opts.timeoutMs ?? 10_000
    // GeckoTerminal's free tier answers a burst of calls with 429: space them. A source that failed is tried again sooner.
    this.gapMs = opts.gapMs ?? 7_000
    this.retryMs = opts.retryMs ?? 300_000
    this.stateFile = opts.stateFile
    this.load()
  }

  /** What the engine's `poolStats` callback returns: synchronous, from memory; starts a background refresh when one is due. */
  get(): NonNullable<Observation['poolStats']> {
    this.kick()
    const out: NonNullable<Observation['poolStats']> = {}
    const now = this.now()
    for (const p of this.pools) {
      const c = this.cache.get(p.name)
      const fresh = <T>(x: Cached<T> | undefined) => (x && now - x.at <= this.staleMs ? x : undefined)
      const llama = fresh(c?.llama)
      const tvl = fresh(c?.tvl)
      const vols = fresh(c?.vols)
      const own = lookbacksOf(c?.own ?? [], Math.floor(now / 1000), OWN_TOL_S)
      // Every pool gets an entry, also before the first fetch ends: missing fields are reported unread, never silent.
      out[p.name] = {
        tvlUsd: tvl?.part ?? null,
        tvl1dAgoUsd: own.tvl1dAgoUsd ?? llama?.part.tvl1dAgoUsd ?? null,
        tvl7dAgoUsd: own.tvl7dAgoUsd ?? llama?.part.tvl7dAgoUsd ?? null,
        tvl30dAgoUsd: own.tvl30dAgoUsd ?? llama?.part.tvl30dAgoUsd ?? null,
        volume7dUsd: vols?.part.volume7dUsd ?? null,
        volumeLastDayUsd: vols?.part.volumeLastDayUsd ?? null,
        volume28dAvgUsd: vols?.part.volume28dAvgUsd ?? null,
        asOf: Math.floor(Math.max(llama?.at ?? 0, tvl?.at ?? 0, vols?.at ?? 0) / 1000),
      } satisfies Stats
    }
    return out
  }

  /** Fire and forget; never throws. */
  kick(): void {
    if (this.inFlight) return
    const now = this.now()
    if (!this.pools.some((p) => now - (this.lastTry.get(p.name) ?? -Infinity) >= this.refreshMs)) return
    this.inFlight = this.refresh().catch(() => {}).finally(() => { this.inFlight = null })
  }

  /** Resolves when the refresh in flight (or a new one) is done; for tests and boot. */
  async settled(): Promise<void> {
    this.kick()
    await this.inFlight
  }

  private async refresh(): Promise<void> {
    for (const p of this.pools) {
      const now = this.now()
      if (now - (this.lastTry.get(p.name) ?? -Infinity) < this.refreshMs) continue
      // Marked before the calls: a failing source is retried next hour, not on every review.
      this.lastTry.set(p.name, now)
      const nowSec = Math.floor(now / 1000)
      const entryOf = this.cache.get(p.name) ?? {}
      const llama = await this.getJson(`${LLAMA}${p.llamaId}`)
      if (llama !== undefined) {
        const part = parseLlamaChart(llama, nowSec)
        if (part.tvl1dAgoUsd !== null || part.tvl7dAgoUsd !== null || part.tvl30dAgoUsd !== null) entryOf.llama = { at: now, part }
      }
      await this.pause()
      const pool = await this.getJson(`${GECKO}${p.address}`)
      await this.pause()
      const ohlcv = await this.getJson(`${GECKO}${p.address}/ohlcv/day?limit=29`)
      await this.pause()
      // Each source keeps its last good value and its own timestamp: a failure never refreshes another source's data.
      const tvlUsd = pool === undefined ? null : parseGeckoPool(pool)
      if (tvlUsd !== null) {
        entryOf.tvl = { at: now, part: tvlUsd }
        entryOf.own = [...(entryOf.own ?? []).filter((x) => x.t > nowSec - OWN_KEEP_S), { t: nowSec, v: tvlUsd }].slice(-OWN_MAX)
      }
      // A payload that arrived is the truth now, gaps included (its missing fields are unread): never older values.
      if (ohlcv !== undefined) entryOf.vols = { at: now, part: parseGeckoOhlcv(ohlcv, nowSec) }
      this.cache.set(p.name, entryOf)
      // Llama is only a fallback (and paid from 2026-11-13): its failure alone does not bring the retry forward.
      const complete = entryOf.tvl?.at === now && entryOf.vols?.at === now
      if (!complete) this.lastTry.set(p.name, now - this.refreshMs + this.retryMs)
    }
    this.persist()
  }

  private pause(): Promise<void> {
    return this.gapMs > 0 ? new Promise((r) => setTimeout(r, this.gapMs)) : Promise.resolve()
  }

  /** undefined on any failure (timeout, HTTP error, bad JSON). */
  private async getJson(url: string): Promise<unknown | undefined> {
    try {
      const res = await this.fetchFn(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(this.timeoutMs) })
      if (!res.ok) return undefined
      return await res.json()
    } catch {
      return undefined
    }
  }

  private load(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return
    try {
      const st = statSync(this.stateFile)
      if (!st.isFile() || st.size > 2_000_000) {
        console.error(`[pool-stats] ${this.stateFile} is not a regular file under 2 MB: not read, starting empty`)
        return
      }
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { cache?: Record<string, PoolCache>; lastTry?: Record<string, number> }
      const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
      for (const p of this.pools) {
        const c = raw.cache?.[p.name]
        if (c && typeof c === 'object') {
          const own = Array.isArray(c.own) ? c.own.filter((x) => fin(x?.t) && fin(x?.v) && x.v >= 0).slice(-OWN_MAX) : []
          this.cache.set(p.name, {
            ...(c.llama && fin(c.llama.at) ? { llama: c.llama } : {}),
            ...(c.tvl && fin(c.tvl.at) && fin(c.tvl.part) ? { tvl: c.tvl } : {}),
            ...(c.vols && fin(c.vols.at) ? { vols: c.vols } : {}),
            ...(own.length ? { own } : {}),
          })
        }
        const t = raw.lastTry?.[p.name]
        if (typeof t === 'number' && Number.isFinite(t)) this.lastTry.set(p.name, t)
      }
    } catch {
      /* a corrupt file is a cold start */
    }
  }

  private persist(): void {
    if (!this.stateFile) return
    try {
      const dir = dirname(this.stateFile)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${this.stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ cache: Object.fromEntries(this.cache), lastTry: Object.fromEntries(this.lastTry) }), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.stateFile)
    } catch (e) {
      console.error(`[pool-stats] failed to persist ${this.stateFile}: ${(e as Error)?.message?.split('\n')[0] ?? e}`)
    }
  }
}

/** DefiLlama pool ids of the live pools (same ids as apps/mamoru-app/src/api/apy/source.ts; the operator cannot import the app). */
export const LLAMA_POOL_IDS: Record<string, string> = {
  'pool:USDC/USDT/100': 'ca2132ac-cd06-4b04-8130-ff2cd07ab934',
  'pool:USDC/cbBTC/500': '9c3c95ef-5e04-4c75-b7ec-6a59a9ea904b',
  'pool:WETH/USDC/3000': 'b99bcdf5-1350-4269-981e-0e9b5cccb007',
}

/** The cache for the Base live pools, kept in `stateFile` (the own TVL series survives a restart). Absent: memory only. */
export function livePoolStats(stateFile?: string): PoolStatsCache {
  return new PoolStatsCache(
    Object.entries(LLAMA_POOL_IDS).map(([name, llamaId]) => ({ name, llamaId, address: entry(name as never, baseRegistry).address })),
    stateFile ? { stateFile } : {},
  )
}
