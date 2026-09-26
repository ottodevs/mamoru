// One sync against Base into a local SQLite D1 (default .local/engine.sqlite). Prints counts and the pool figures.
// Uses BASE_RPC_URL from the environment when set, the public RPC otherwise. Never prints the URL.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolView } from '@mamoru/domain'
import { makeClient, rpcTransport } from '../src/sync/client.ts'
import { syncOnce } from '../src/sync/run.ts'
import { sqliteD1 } from './sqlite-d1.ts'

const dir = join(import.meta.dir, '../.local')
mkdirSync(dir, { recursive: true })
const db = sqliteD1(process.env.ENGINE_SQLITE ?? join(dir, 'engine.sqlite'))
const { transport, keyed } = rpcTransport({ BASE_RPC_URL: process.env.BASE_RPC_URL, BASE_RPC_PUBLIC: 'https://mainnet.base.org' })
console.log(`rpc: ${keyed ? 'keyed' : 'public'}`)

const started = performance.now()
const summary = await syncOnce({ client: makeClient(transport), db, chainId: 8453, now: () => new Date(), debug: Boolean(process.env.ENGINE_DEBUG) })
console.log(`took ${Math.round(performance.now() - started)} ms`)

const rows = db.sqlite.query('SELECT pool_address, block, source, payload_json FROM proj_pool_state').all() as { pool_address: string; block: number; source: string; payload_json: string }[]
for (const r of rows) {
  const v = JSON.parse(r.payload_json) as PoolView
  const s = v.stats
  console.log({
    pool: v.pool.name, block: r.block, source: r.source, price: v.price.value, tick: v.tick.value, twapTick: v.twapTick.value, twapGuard: v.twapGuard.value,
    liquidity: v.liquidity.value, balance0: v.balances.amount0.value, balance1: v.balances.amount1.value, balanceValue: v.balances.value.value,
    window: v.window, swaps: s.swaps.value, volume0: s.volume0.value, volume1: s.volume1.value, volumeValue: s.volumeValue.value, feesValue: s.feesValue.value,
    tickRange: [s.tickMin.value, s.tickMax.value], added: s.added.count.value, removed: s.removed.count.value,
    recentSwaps: v.recentSwaps.length, recentLiquidity: v.recentLiquidity.length, lastSwap: v.recentSwaps[0] && { block: v.recentSwaps[0].block, at: v.recentSwaps[0].at, tx: v.recentSwaps[0].txHash },
  })
}
console.log('source_state', db.sqlite.query('SELECT * FROM source_state').all())
console.log('accounts projected', summary.accounts)
