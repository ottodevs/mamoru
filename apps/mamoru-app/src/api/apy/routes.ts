import { Hono } from 'hono'
import type { AppEnv } from '../context.ts'
import { metricsSignature } from '@mamoru/operator-auth'
import { operatorUrlFor } from '../env.ts'
import { apyView, monadOperatorPoolStats, operatorPoolStats, planPools, type ApyCache, type Fetcher } from './source.ts'

/** caches.default on Workers; null where there is no Cache API. */
function workersCache(): ApyCache | null {
  return (globalThis as { caches?: { default?: ApyCache } }).caches?.default ?? null
}

const signPath = (secret: string, path: string) => metricsSignature(secret, 'GET', path, Math.floor(Date.now() / 60_000))

// Public: plan-weighted reference APY (current + monthly), from the Base operator's pool stats (otto/mamoru#248, Monad's pool from its operator, #349), else
// upstream; nulls when every source fails.
export function apyRoutes(fetcher: Fetcher, cache: () => ApyCache | null = workersCache) {
  const apy = new Hono<AppEnv>()
  apy.get('/', async (c) => {
    const store = cache()
    const now = c.var.now()
    const op = operatorPoolStats(c.env.OPERATOR_URL, c.env.OPERATOR_SECRET, c.var.operatorFetch as Fetcher, store, signPath, now)
    // otto/mamoru#349: the Monad sleeve's pool is rated from the Monad operator (OPERATOR_URL_143); unset: absent.
    const monad = monadOperatorPoolStats(operatorUrlFor(c.env, 143) ?? undefined, c.env.OPERATOR_SECRET, c.var.operatorFetch as Fetcher, store, signPath, now)
    return c.json(await apyView(fetcher, store, now, planPools(), op, monad))
  })
  return apy
}
