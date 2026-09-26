import type { PoolView } from '@mamoru/domain'
import type { Db } from '../env.ts'

/** Pool rows of the plan as the engine projected them (payload_json is a PoolView), for one chain only. */
export async function planPools(db: Db, chainId: number): Promise<{ pools: PoolView[]; syncedAt: string | null }> {
  const { results } = await db
    .prepare('SELECT payload_json, observed_at FROM proj_pool_state WHERE chain_id = ? ORDER BY pool_address')
    .bind(chainId)
    .all<{ payload_json: string; observed_at: string }>()
  const syncedAt = results.reduce<string | null>((max, r) => (max === null || r.observed_at > max ? r.observed_at : max), null)
  return { pools: results.map((r) => JSON.parse(r.payload_json) as PoolView), syncedAt }
}
