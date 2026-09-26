import { Hono } from 'hono'
import type { AppEnv } from '../context.ts'
import { apyView, type ApyCache, type Fetcher } from './source.ts'

/** caches.default on Workers; null where there is no Cache API. */
function workersCache(): ApyCache | null {
  return (globalThis as { caches?: { default?: ApyCache } }).caches?.default ?? null
}

// Public: pool-level fee APR of the plan's live pool, sourced upstream; nulls when a source fails.
export function apyRoutes(fetcher: Fetcher, cache: () => ApyCache | null = workersCache) {
  const apy = new Hono<AppEnv>()
  apy.get('/', async (c) => c.json(await apyView(fetcher, cache(), c.var.now())))
  return apy
}
