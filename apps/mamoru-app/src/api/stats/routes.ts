// Spec 013 §4 with amendment A1: GET /api/stats, public (no session; it never sets c.var.accountKey, so no activity is
// recorded). One payload (snapshots, distributions, series), built from D1 only and passed through the k >= 3 guard
// before it is cached or sent.
// The cron builds the view after each yield-ledger pull and stores it in D1 (stats_view), so a request reads one row
// instead of building it from every table: the edge cache is per data center and was cold for most visitors.
// Cached at the edge 300 s; rate-limited per hashed client address (STATS_READ_LIMIT); a D1 failure serves the cached
// copy with its own dataAsOf, else 503 STATS_UNAVAILABLE.
import { Hono } from 'hono'
import type { StatsView } from '@mamoru/domain'
import type { AppEnv } from '../context.ts'
import type { Db } from '../env.ts'
import { apiError } from '../errors.ts'
import { sha256 } from '../auth/webauthn.ts'
import { guardStats, withoutStale } from './privacy.ts'
import { statsInput } from './queries.ts'

export type StatsCache = { match(key: string): Promise<Response | undefined>; put(key: string, res: Response): Promise<void> }

export const STATS_CACHE_KEY = 'https://stats.internal/v1'
export const STATS_TTL_S = 300
/** A stored view older than this is built again on the request: the cron writes one every 10 minutes. */
export const STORED_TTL_S = 15 * 60
const CACHE_CONTROL = 'public, max-age=60, s-maxage=300'

function workersCache(): StatsCache | null {
  return (globalThis as { caches?: { default?: StatsCache } }).caches?.default ?? null
}

export async function buildStatsView(db: Db, now: Date): Promise<StatsView> {
  return guardStats(await statsInput(db, now))
}

export async function storeStatsView(db: Db, view: StatsView, builtMs: number): Promise<void> {
  await db
    .prepare('INSERT INTO stats_view (id, view_json, built_ms) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET view_json = excluded.view_json, built_ms = excluded.built_ms WHERE excluded.built_ms > stats_view.built_ms')
    .bind(JSON.stringify(view), builtMs)
    .run()
}

async function storedStatsView(db: Db): Promise<{ view: StatsView; builtMs: number } | null> {
  try {
    const row = await db.prepare('SELECT view_json, built_ms FROM stats_view WHERE id = 1').first<{ view_json: string; built_ms: number }>()
    return row ? { view: JSON.parse(row.view_json) as StatsView, builtMs: row.built_ms } : null
  } catch {
    return null
  }
}

/** Cron: build the view and store it, so requests never wait for it. A failure leaves the last stored view. */
export async function refreshStatsView(db: Db, now: Date): Promise<void> {
  try {
    await storeStatsView(db, await buildStatsView(db, now), now.getTime())
  } catch (e) {
    console.error('stats: view not refreshed', e instanceof Error ? e.message : String(e))
  }
}

export function statsRoutes(cache: () => StatsCache | null = workersCache) {
  const stats = new Hono<AppEnv>()
  stats.get('/', async (c) => {
    const limiter = c.env.STATS_READ_LIMIT
    if (limiter) {
      const h = await sha256(`mamoru:stats-read:v1\n${c.var.settings.sessionSecret}\n${c.req.header('cf-connecting-ip') ?? 'unknown'}`)
      const ip = Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
      let ok = true
      try {
        ok = (await limiter.limit({ key: ip })).success
      } catch {
        console.error('stats: rate limiter did not answer')
      }
      if (!ok) {
        c.header('retry-after', '60')
        return apiError(c, 429, 'Too many reads of the stats. Wait a minute and try again.', 'READ_RATE_LIMITED')
      }
    }
    const store = cache()
    const cached = await store?.match(STATS_CACHE_KEY).catch(() => undefined)
    const nowMs = c.var.now().getTime()
    const age = cached ? (nowMs - Number(cached.headers.get('x-stats-built') ?? 0)) / 1000 : Infinity
    if (cached && age < STATS_TTL_S) {
      c.header('cache-control', CACHE_CONTROL)
      return c.json(withoutStale((await cached.json()) as StatsView, c.var.now()))
    }
    // Kept at the edge for a day (the route decides freshness from x-stats-built), so a D1 outage can still serve it.
    const put = (view: StatsView, builtMs: number) =>
      store?.put(STATS_CACHE_KEY, new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400', 'x-stats-built': String(builtMs) } })).catch(() => {})
    const stored = await storedStatsView(c.env.DB)
    if (stored && (nowMs - stored.builtMs) / 1000 < STORED_TTL_S) {
      await put(stored.view, stored.builtMs)
      c.header('cache-control', CACHE_CONTROL)
      return c.json(withoutStale(stored.view, c.var.now()))
    }
    let view: StatsView
    try {
      view = await buildStatsView(c.env.DB, c.var.now())
    } catch (e) {
      console.error('stats: not built', e instanceof Error ? e.message : String(e))
      // A copy older than an hour holds figures A1 says to hide (stale): it is not served. The newer copy wins.
      const fresh = (builtMs: number) => nowMs - builtMs <= 3_600_000
      const cachedMs = cached ? nowMs - age * 1000 : -Infinity
      if (stored && stored.builtMs >= cachedMs && fresh(stored.builtMs)) {
        c.header('cache-control', 'no-store')
        return c.json(withoutStale(stored.view, c.var.now()))
      }
      if (cached && fresh(cachedMs)) {
        c.header('cache-control', 'no-store')
        return c.json(withoutStale((await cached.json()) as StatsView, c.var.now()))
      }
      return apiError(c, 503, 'Stats are not available right now. Try again in a minute.', 'STATS_UNAVAILABLE')
    }
    await storeStatsView(c.env.DB, view, nowMs).catch(() => {})
    // The cron may have stored a newer view while this one was built: the newer one is served and cached.
    const after = await storedStatsView(c.env.DB)
    const newest = after && after.builtMs > nowMs ? after : { view, builtMs: nowMs }
    await put(newest.view, newest.builtMs)
    c.header('cache-control', CACHE_CONTROL)
    return c.json(withoutStale(newest.view, c.var.now()))
  })
  return stats
}
