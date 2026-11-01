import { Hono } from 'hono'
import type { AppEnv } from '../context.ts'
import { metricsSignature } from '@mamoru/operator-auth'
import { apyView, operatorPoolStats, planPools, type ApyCache, type Fetcher } from './source.ts'

/** caches.default on Workers; null where there is no Cache API. */
function workersCache(): ApyCache | null {
  return (globalThis as { caches?: { default?: ApyCache } }).caches?.default ?? null
}

const signPath = (secret: string, path: string) => metricsSignature(secret, 'GET', path, Math.floor(Date.now() / 60_000))

// Public: plan-weighted reference APY (current + monthly), from the Base operator's pool stats (otto/mamoru#248), else
// upstream; nulls when every source fails.
export function apyRoutes(fetcher: Fetcher, cache: () => ApyCache | null = workersCache) {
  const apy = new Hono<AppEnv>()
  apy.get('/', async (c) => {
    const store = cache()
    const op = operatorPoolStats(c.env.OPERATOR_URL, c.env.OPERATOR_SECRET, c.var.operatorFetch as Fetcher, store, signPath)
    return c.json(await apyView(fetcher, store, c.var.now(), planPools(), op))
  })
  return apy
}
