import { Hono } from 'hono'
import type { PoolsResponse } from '@mamoru/domain'
import type { AppEnv } from '../context.ts'
import { aged } from '../provenance.ts'
import { planPools } from './store.ts'

export const pools = new Hono<AppEnv>()

// Public: the plan's pools as the engine last projected them, with stale rows marked.
pools.get('/', async (c) => {
  const { chainId } = c.var.settings
  const { pools: rows, syncedAt } = await planPools(c.env.DB, chainId)
  const body: PoolsResponse = { chainId, pools: aged(rows, c.var.now()), syncedAt }
  return c.json(body)
})
