// Spec 013 §4 with amendment A1: GET /api/stats, public (no session; it never sets c.var.accountKey, so no activity is
// recorded). One payload (snapshots, distributions, series), built from D1 only and passed through the k >= 3 guard
// before it is cached or sent.
// Cached at the edge 300 s; rate-limited per hashed client address (STATS_READ_LIMIT); a D1 failure serves the cached
// copy with its own dataAsOf, else 503 STATS_UNAVAILABLE.
import { Hono } from 'hono'
import type { StatsView } from '@mamoru/domain'
import type { AppEnv } from '../context.ts'
import { apiError } from '../errors.ts'
import { sha256 } from '../auth/webauthn.ts'
import { guardStats } from './privacy.ts'
import { statsInput } from './queries.ts'

export type StatsCache = { match(key: string): Promise<Response | undefined>; put(key: string, res: Response): Promise<void> }

export const STATS_CACHE_KEY = 'https://stats.internal/v1'
export const STATS_TTL_S = 300
const CACHE_CONTROL = 'public, max-age=60, s-maxage=300'

function workersCache(): StatsCache | null {
  return (globalThis as { caches?: { default?: StatsCache } }).caches?.default ?? null
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
      return c.json((await cached.json()) as StatsView)
    }
    let view: StatsView
    try {
      view = guardStats(await statsInput(c.env.DB, c.var.now()))
    } catch (e) {
      console.error('stats: not built', e instanceof Error ? e.message : String(e))
      // A copy older than an hour holds figures A1 says to hide (stale): it is not served.
      if (cached && age <= 3600) {
        c.header('cache-control', 'no-store')
        return c.json((await cached.json()) as StatsView)
      }
      return apiError(c, 503, 'Stats are not available right now. Try again in a minute.', 'STATS_UNAVAILABLE')
    }
    // Stored for a day (the route decides freshness from x-stats-built), so a D1 outage can still serve the last copy.
    await store?.put(STATS_CACHE_KEY, new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400', 'x-stats-built': String(nowMs) } })).catch(() => {})
    c.header('cache-control', CACHE_CONTROL)
    return c.json(view)
  })
  return stats
}
