import { beforeEach, describe, expect, test } from 'bun:test'
import type { PoolView } from '@mamoru/domain'
import { MultiBaasClient, SIG, type QueryRow } from '@mamoru/multibaas'
import { address, type Registry } from '@mamoru/registry'
import { sqliteD1 } from '../scripts/sqlite-d1.ts'
import { readPoolEvents, type PoolEvent } from '../src/sync/logs.ts'
import { syncOnce } from '../src/sync/run.ts'
import { FakeChain } from './fake-chain.ts'

const POOL = address('pool:USDC/cbBTC/500')
const W = 100
const SQRT = 2n ** 91n

let chain: FakeChain
let registry: Registry
let db: ReturnType<typeof sqliteD1>
let now: Date
let mbChainId: number
let mbRows: (rows: QueryRow[]) => QueryRow[]
let mbFails: boolean
let mbCalls: string[]

/** What MultiBaas returns for an RPC event: strings, lowercase, no log index. */
function toRow(e: PoolEvent): QueryRow {
  const base = { block: String(e.block), blockHash: e.blockHash, txHash: e.txHash, at: '2026-09-26 18:00:00+00' }
  if (e.kind === 'swap') {
    return { ...base, kind: SIG.Swap, sender: e.sender.toLowerCase(), recipient: e.recipient.toLowerCase(), amount0: String(e.amount0), amount1: String(e.amount1), sqrtPriceX96: String(e.sqrtPriceX96), liquidity: String(e.liquidity), tick: String(e.tick) }
  }
  return { ...base, kind: e.kind === 'mint' ? SIG.Mint : SIG.Burn, owner: e.owner.toLowerCase(), tickLower: String(e.tickLower), tickUpper: String(e.tickUpper), amount: String(e.amount), amount0: String(e.amount0), amount1: String(e.amount1) }
}

async function indexRows(from: number, to: number): Promise<QueryRow[]> {
  const { events } = await readPoolEvents(chain.client(), POOL, from, to)
  return events.map(toRow)
}

function multibaas(): MultiBaasClient {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    mbCalls.push(url.pathname)
    const json = (status: number, result: unknown) => new Response(JSON.stringify({ status, message: status === 200 ? 'success' : 'error', result }), { status })
    if (mbFails && url.pathname.endsWith('/queries')) return json(500, null)
    if (url.pathname.endsWith('/chains/ethereum/status')) return json(200, { chainID: mbChainId, blockNumber: chain.latest })
    if (url.pathname.endsWith('/queries')) {
      const body = JSON.parse(String(init?.body)) as { events: { filter: { children: { fieldType: string; operator: string; value: string }[] } }[] }
      const leaves = body.events[0]!.filter.children
      const from = Number(leaves.find((l) => l.operator === 'greaterthanorequal')!.value)
      const to = Number(leaves.find((l) => l.operator === 'lessthanorequal')!.value)
      const offset = Number(url.searchParams.get('offset'))
      const all = mbRows(await indexRows(from, to))
      return json(200, { rows: all.slice(offset, offset + 50) })
    }
    return json(404, null)
  }) as typeof fetch
  return new MultiBaasClient({ url: 'https://mb.example', apiKey: 'test', fetch: fetcher })
}

function run(startBlocks?: Map<string, number>) {
  return syncOnce({ client: chain.client(), db, chainId: 8453, now: () => now, registry, windowBlocks: W, log: () => {}, multibaas: multibaas(), ...(startBlocks ? { startBlocks } : {}) })
}

function view(): PoolView {
  return JSON.parse((db.sqlite.query('SELECT payload_json FROM proj_pool_state').get() as { payload_json: string }).payload_json) as PoolView
}

function sourceState() {
  return db.sqlite.query('SELECT index_status, index_code, index_block, rpc_status FROM source_state').get()
}

beforeEach(() => {
  chain = new FakeChain()
  registry = chain.registry()
  db = sqliteD1()
  now = new Date('2026-09-26T18:00:00.000Z')
  mbChainId = 8453
  mbRows = (r) => r
  mbFails = false
  mbCalls = []
  chain.pools.set(POOL.toLowerCase(), { sqrtPriceX96: SQRT, tick: -69315, liquidity: 1n, tickCumulatives: [0n, 0n] })
  const H = chain.safe
  chain.addSwap(POOL, H - 90, 1, { amount0: 2_000n, amount1: -1n, sqrtPriceX96: SQRT, liquidity: 1n, tick: -69320 })
  chain.addLiquidity(POOL, 'Mint', H - 60, 2, { tickLower: -70000, tickUpper: -68000, amount: 10n, amount0: 500n, amount1: 7n })
  chain.addSwap(POOL, H - 40, 0, { amount0: -1_000n, amount1: 1n, sqrtPriceX96: SQRT, liquidity: 1n, tick: -69310 })
  chain.addSwap(POOL, H - 40, 5, { amount0: -1_000n, amount1: 1n, sqrtPriceX96: SQRT, liquidity: 1n, tick: -69310 })
})

describe('MultiBaas contrast', () => {
  test('rows the index agrees on are reconciled and the window comes from MultiBaas', async () => {
    await run(new Map([['pool:USDC/cbBTC/500', 1]]))
    const v = view()
    const rows = [...v.recentSwaps, ...v.recentLiquidity]
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(r.provenance).toMatchObject({ source: 'multibaas', check: 'reconciled', checkedAt: chain.safe, blockNumber: r.block })
    // identical rows in one block are matched as a multiset and keep the RPC log index
    expect(v.recentSwaps.slice(0, 2).map((r) => r.logIndex)).toEqual([5, 0])
    expect(v.stats.swaps.provenance).toMatchObject({ source: 'multibaas', detail: 'PROJ_RECONCILED' })
    expect(db.sqlite.query('SELECT source FROM proj_pool_state').get()).toEqual({ source: 'multibaas' })
    expect(sourceState()).toEqual({ index_status: 'indexing', index_code: null, index_block: chain.safe, rpc_status: 'ok' })
    // one status call and one query page
    expect(mbCalls).toEqual(['/api/v0/chains/ethereum/status', '/api/v0/queries'])
  })

  test('history older than the index start comes from RPC logs with MB_BEFORE_START_BLOCK', async () => {
    await run(new Map([['pool:USDC/cbBTC/500', chain.safe - 50]]))
    const v = view()
    const byBlock = new Map([...v.recentSwaps, ...v.recentLiquidity].map((r) => [r.block, r.provenance]))
    expect(byBlock.get(chain.safe - 90)).toMatchObject({ source: 'chain_rpc', detail: 'PROJ_SOURCE_FALLBACK_RPC', cause: 'MB_BEFORE_START_BLOCK' })
    expect(byBlock.get(chain.safe - 60)).toMatchObject({ cause: 'MB_BEFORE_START_BLOCK' })
    expect(byBlock.get(chain.safe - 40)).toMatchObject({ source: 'multibaas', check: 'reconciled' })
    expect(v.stats.swaps.provenance).toMatchObject({ source: 'chain_rpc', detail: 'PROJ_SOURCE_FALLBACK_RPC', cause: 'MB_BEFORE_START_BLOCK' })
  })

  test('without a configured start, the first indexed row marks it', async () => {
    mbRows = (rows) => rows.filter((r) => Number(r.block) >= chain.safe - 60)
    await run()
    const v = view()
    expect(v.recentSwaps.find((r) => r.block === chain.safe - 90)!.provenance.cause).toBe('MB_BEFORE_START_BLOCK')
    expect(v.recentLiquidity[0]!.provenance.check).toBe('reconciled')
  })

  test('a row the index reports differently is a mismatch shown with the RPC value', async () => {
    mbRows = (rows) => rows.map((r) => (Number(r.block) === chain.safe - 90 ? { ...r, amount0: '1' } : r))
    await run(new Map([['pool:USDC/cbBTC/500', 1]]))
    const r = view().recentSwaps.find((x) => x.block === chain.safe - 90)!
    expect(r.provenance).toMatchObject({ source: 'chain_rpc', check: 'mismatch', detail: 'PROJ_INDEXER_MISMATCH' })
    expect(r.amount0.value).toBe('2000')
    expect(view().stats.swaps.provenance.detail).toBe('PROJ_INDEXER_MISMATCH')
  })

  test('rows newer than the last indexed row wait for the index', async () => {
    mbRows = (rows) => rows.filter((r) => Number(r.block) < chain.safe - 40)
    await run(new Map([['pool:USDC/cbBTC/500', 1]]))
    const v = view()
    expect(v.recentSwaps[0]!.provenance).toMatchObject({ source: 'chain_rpc', detail: 'PROJ_INDEXER_PENDING' })
    expect(v.stats.swaps.provenance.detail).toBe('PROJ_INDEXER_PENDING')
    expect((sourceState() as { index_status: string }).index_status).toBe('indexing')
  })

  test('a failing query falls back to RPC logs and marks the index failing', async () => {
    mbFails = true
    await run()
    const v = view()
    expect(v.stats.swaps.value).toBe(3)
    expect(v.recentSwaps[0]!.provenance).toMatchObject({ source: 'chain_rpc', detail: 'PROJ_SOURCE_FALLBACK_RPC', cause: 'MB_QUERY_FAILED' })
    expect(sourceState()).toMatchObject({ index_status: 'failing', index_code: 'MB_QUERY_FAILED' })
  })

  test('a deployment that does not answer chain 8453 is not indexing Base', async () => {
    mbChainId = 1
    await run()
    expect(view().recentSwaps[0]!.provenance.cause).toBe('MB_BASE_INDEXING_ABSENT')
    expect(sourceState()).toMatchObject({ index_status: 'not_indexing_base', index_code: 'MB_BASE_INDEXING_ABSENT' })
    expect(mbCalls).toEqual(['/api/v0/chains/ethereum/status'])
  })

  test('between index checks no MultiBaas call is made and labels carry over', async () => {
    const start = new Map([['pool:USDC/cbBTC/500', 1]])
    await run(start)
    mbCalls = []
    now = new Date(now.getTime() + 120_000)
    chain.safe += 10
    chain.latest += 10
    chain.addSwap(POOL, chain.safe - 1, 0, { amount0: 5n, amount1: -1n, sqrtPriceX96: SQRT, liquidity: 1n, tick: -69311 })
    await run(start)
    expect(mbCalls).toEqual([])
    const v = view()
    expect(v.recentSwaps[0]!.provenance).toMatchObject({ source: 'chain_rpc', detail: 'PROJ_INDEXER_PENDING' })
    expect(v.recentSwaps[1]!.provenance).toMatchObject({ source: 'multibaas', check: 'reconciled' })
    // after the interval, the index is checked again
    now = new Date(now.getTime() + 600_000)
    await run(start)
    expect(mbCalls).toContain('/api/v0/queries')
    expect(view().recentSwaps[0]!.provenance.check).toBe('reconciled')
  })

  test('RPC down leaves the index health unchanged', async () => {
    mbChainId = 1
    await run()
    chain.down = true
    now = new Date(now.getTime() + 700_000)
    await run()
    expect(sourceState()).toMatchObject({ rpc_status: 'unavailable', index_status: 'not_indexing_base' })
  })
})
