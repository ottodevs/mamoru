import { beforeEach, describe, expect, test } from 'bun:test'
import type { PoolView, TokenHolding } from '@mamoru/domain'
import { address, type Registry } from '@mamoru/registry'
import { sqliteD1 } from '../scripts/sqlite-d1.ts'
import { custom, HttpRequestError } from 'viem'
import { makeClient } from '../src/sync/client.ts'
import { syncOnce } from '../src/sync/run.ts'
import { FakeChain } from './fake-chain.ts'

const POOL = address('pool:USDC/cbBTC/500')
const WETH_POOL = address('pool:WETH/USDC/3000')
const USDC = address('USDC')
const CBBTC = address('cbBTC')
const WETH = address('WETH')
const NOW = new Date('2026-09-26T18:00:00.000Z')
const W = 100

// 1 cbBTC = 102,400 USDC: raw cbBTC per raw USDC is 1/1024, so sqrtPriceX96 = 2^96 / 32.
const CBBTC_SQRT = 2n ** 91n
// 1 WETH = 3,814,697.265625 USDC: raw USDC per raw WETH is 2^-18, so sqrtPriceX96 = 2^96 / 2^9.
const WETH_SQRT = 2n ** 87n

let chain: FakeChain
let registry: Registry
let db: ReturnType<typeof sqliteD1>
const logs: Record<string, unknown>[] = []

function run() {
  return syncOnce({ client: chain.client(), db, chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: (l) => logs.push(l) })
}

function poolView(): PoolView {
  const row = db.sqlite.query('SELECT payload_json FROM proj_pool_state WHERE pool_address = ?').get(POOL) as { payload_json: string } | null
  if (!row) throw new Error('no pool row')
  return JSON.parse(row.payload_json) as PoolView
}

/** Every Figure in a payload carries Provenance on Base. */
function figures(node: unknown, out: { value: unknown; provenance: { chainId: number; status: string } }[] = []) {
  if (Array.isArray(node)) node.forEach((n) => figures(n, out))
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    if ('value' in o && 'provenance' in o) out.push(o as never)
    Object.values(o).forEach((n) => figures(n, out))
  }
  return out
}

beforeEach(() => {
  chain = new FakeChain()
  registry = chain.registry()
  db = sqliteD1()
  logs.length = 0
  chain.pools.set(POOL.toLowerCase(), { sqrtPriceX96: CBBTC_SQRT, tick: -69315, liquidity: 5_000_000n, tickCumulatives: [-69_300n * 1_000_000n, -69_300n * 1_000_000n - 69_310n * 1800n] })
  chain.pools.set(WETH_POOL.toLowerCase(), { sqrtPriceX96: WETH_SQRT, tick: -124766, liquidity: 1n })
  chain.setBalance(USDC, POOL, 1_000_000_000n)
  chain.setBalance(CBBTC, POOL, 50_000n)
  const H = chain.safe
  chain.addSwap(POOL, H - 150, 0, { amount0: 999n, amount1: -1n, sqrtPriceX96: CBBTC_SQRT, liquidity: 1n, tick: -1 }) // before the window
  chain.addSwap(POOL, H - 90, 1, { amount0: 2_000_000n, amount1: -1_900n, sqrtPriceX96: CBBTC_SQRT, liquidity: 5_000_000n, tick: -69320 })
  chain.addSwap(POOL, H - 50, 3, { amount0: -1_000_000n, amount1: 1_000n, sqrtPriceX96: CBBTC_SQRT, liquidity: 5_000_000n, tick: -69310 })
  chain.addLiquidity(POOL, 'Mint', H - 60, 2, { tickLower: -70000, tickUpper: -68000, amount: 10n, amount0: 500n, amount1: 7n })
  chain.addLiquidity(POOL, 'Burn', H - 40, 4, { tickLower: -70000, tickUpper: -68000, amount: 0n, amount0: 0n, amount1: 0n }) // fee poke
  chain.addLiquidity(POOL, 'Burn', H - 10, 5, { tickLower: -70000, tickUpper: -68000, amount: 4n, amount0: 200n, amount1: 3n })
})

describe('pool state sync', () => {
  test('writes the PoolView of the plan pool at the safe block', async () => {
    const summary = await run()
    expect(summary.rpc).toBe('ok')
    expect(summary.safeBlock).toBe(chain.safe)
    const v = poolView()
    expect(v.block).toBe(chain.safe)
    expect(v.pool).toMatchObject({ token0: 'USDC', token1: 'cbBTC', fee: 500, tickSpacing: 10 })
    expect(v.price).toMatchObject({ value: '102400000000', unit: 'USDC' })
    expect(v.price.provenance).toMatchObject({ source: 'chain_rpc', chainId: 8453, blockNumber: chain.safe, blockHash: chain.hashOf(chain.safe), status: 'fresh' })
    expect(v.tick.value).toBe(-69315)
    expect(v.twapTick.value).toBe(-69310)
    expect(v.twapGuard.value).toBe('ok')
    expect(v.liquidity.value).toBe('5000000')
    expect(v.balances.amount0.value).toBe('1000000000')
    // 1,000 USDC + 0.0005 cbBTC at 102,400 = 1,051.2 USDC
    expect(v.balances.value).toMatchObject({ value: '1051200000', unit: 'USDC' })
    expect(v.balances.value.provenance.source).toBe('estimate')
    expect(v.window).toEqual({ fromBlock: chain.safe - W + 1, toBlock: chain.safe })
    // only pools of the policy are written
    expect((db.sqlite.query('SELECT COUNT(*) n FROM proj_pool_state').get() as { n: number }).n).toBe(1)
  })

  test('computes window stats and recent rows from RPC logs with fallback provenance', async () => {
    await run()
    const { stats, recentSwaps, recentLiquidity } = poolView()
    expect(stats.swaps.value).toBe(2)
    expect(stats.volume0.value).toBe('2000000')
    expect(stats.volume1.value).toBe('1000')
    expect(stats.fees0.value).toBe('1000')
    expect(stats.fees0.provenance.source).toBe('estimate')
    expect(stats.tickMin.value).toBe(-69320)
    expect(stats.tickMax.value).toBe(-69310)
    expect(stats.added.count.value).toBe(1)
    expect(stats.removed).toMatchObject({ count: { value: 1 }, amount0: { value: '200' }, amount1: { value: '3' } })
    expect(stats.swaps.provenance).toMatchObject({ source: 'chain_rpc', detail: 'PROJ_SOURCE_FALLBACK_RPC' })
    expect(stats.swaps.provenance.cause).toBeUndefined()
    expect(recentSwaps.map((r) => r.block)).toEqual([chain.safe - 50, chain.safe - 90])
    expect(recentSwaps[0]).toMatchObject({ logIndex: 3, blockHash: chain.hashOf(chain.safe - 50), tick: -69310, at: new Date(chain.timeOf(chain.safe - 50) * 1000).toISOString() })
    expect(recentSwaps[0]!.amount0).toMatchObject({ value: '-1000000', unit: 'USDC' })
    expect(recentSwaps[0]!.provenance).toMatchObject({ source: 'chain_rpc', blockNumber: chain.safe - 50, detail: 'PROJ_SOURCE_FALLBACK_RPC' })
    expect(recentLiquidity.map((r) => r.kind)).toEqual(['burn', 'mint'])
    expect(recentLiquidity[1]).toMatchObject({ tickLower: -70000, tickUpper: -68000 })
  })

  test('every figure carries Base provenance', async () => {
    await run()
    const all = figures(poolView())
    expect(all.length).toBeGreaterThan(20)
    for (const f of all) {
      expect(f.provenance.chainId).toBe(8453)
      if (f.value === null) expect(f.provenance.status).toBe('not_observed')
    }
  })

  test('writes source_state with RPC ok and MultiBaas not configured', async () => {
    await run()
    const s = db.sqlite.query('SELECT * FROM source_state').get() as Record<string, unknown>
    expect(s).toMatchObject({ chain_id: 8453, rpc_status: 'ok', block: chain.latest, safe_block: chain.safe, index_provider: 'multibaas', index_status: 'not_configured', index_code: null })
  })

  test('a code hash that does not match the registry leaves the pool not observed', async () => {
    registry = { ...registry, entries: registry.entries.map((e) => (e.name === 'pool:USDC/cbBTC/500' ? { ...e, codeHash: `0x${'00'.repeat(32)}` } : e)) }
    const summary = await run()
    expect(summary.pools[0]!.identity).toBe('mismatch')
    const v = poolView()
    for (const f of [v.price, v.tick, v.twapTick, v.liquidity, v.balances.amount0, v.stats.swaps]) {
      expect(f.value).toBeNull()
      expect(f.provenance).toMatchObject({ status: 'not_observed', detail: 'PURGA_IDENTITY_MISMATCH' })
    }
    expect(v.recentSwaps).toEqual([])
    expect(chain.calls).not.toContain('eth_getLogs')
  })

  test('without an observation window the TWAP is not observed', async () => {
    chain.pools.get(POOL.toLowerCase())!.tickCumulatives = undefined
    await run()
    const v = poolView()
    expect(v.twapTick).toMatchObject({ value: null, provenance: { status: 'not_observed', detail: 'EHG_TWAP_UNAVAILABLE' } })
    expect(v.twapGuard.value).toBeNull()
    expect(v.tick.value).toBe(-69315)
  })

  test('a TWAP farther than the policy guard is above_guard', async () => {
    chain.pools.get(POOL.toLowerCase())!.tickCumulatives = [0n, -69_100n * 1800n]
    await run()
    expect(poolView().twapGuard.value).toBe('above_guard')
  })

  test('RPC down: source_state unavailable, last blocks kept, pool rows untouched', async () => {
    await run()
    const before = poolView()
    chain.down = true
    const summary = await run()
    expect(summary.rpc).toBe('unavailable')
    const s = db.sqlite.query('SELECT rpc_status, block, safe_block FROM source_state').get()
    expect(s).toEqual({ rpc_status: 'unavailable', block: chain.latest, safe_block: chain.safe })
    expect(poolView()).toEqual(before)
  })

  test('a foreign chain id is refused', async () => {
    chain.chainId = 1
    const summary = await run()
    expect(summary).toMatchObject({ rpc: 'unavailable', code: 'OBS_CHAIN_MISMATCH' })
  })

  test('logs carry counts, never account addresses', async () => {
    const acct = '0x3333333333333333333333333333333333333333'
    seedAccount('acct-1', acct)
    await run()
    const text = JSON.stringify(logs).toLowerCase()
    expect(text).not.toContain(acct.slice(2))
    expect(logs.at(-1)).toMatchObject({ msg: 'sync.done', accounts: 1, accountsTotal: 1 })
  })
})

function seedAccount(key: string, addr: string) {
  db.sqlite.run("INSERT OR IGNORE INTO users (user_id, created_at) VALUES ('u1', '2026-09-26T00:00:00Z')")
  db.sqlite.run(
    "INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at) VALUES (?, 'u1', 8453, ?, '[]', ?, 'x', 'y', '0', 'conservador-v1', '2026-09-26T00:00:00Z')",
    // One credential id per account: (chain_id, passkey_credential_id) is unique since migration 0005.
    [key, addr, `c-${key}`],
  )
}

describe('account state sync', () => {
  const A = '0x4444444444444444444444444444444444444444' as const
  const B = '0x5555555555555555555555555555555555555555' as const

  test('balances, deployment and USDC value at the safe block', async () => {
    seedAccount('acct-a', A)
    seedAccount('acct-b', B)
    chain.code.set(A.toLowerCase(), '0x60806040')
    chain.setBalance(USDC, A, 5_000_000n)
    chain.setBalance(CBBTC, A, 1_000n) // 0.00001 cbBTC = 1.024 USDC
    chain.setBalance(WETH, A, 262_144n) // 2^18 wei WETH = 1 raw USDC
    chain.setBalance('ETH', A, 524_288n) // 2 raw USDC
    await run()
    const rows = db.sqlite.query('SELECT * FROM proj_account_state ORDER BY account_key').all() as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    const a = rows[0]!
    expect(a).toMatchObject({ account_key: 'acct-a', chain_id: 8453, block: chain.safe, block_hash: chain.hashOf(chain.safe), deployed: 1, total_value: String(5_000_000 + 1_024_000 + 1 + 2) })
    const tokens = JSON.parse(a.tokens_json as string) as TokenHolding[]
    expect(tokens.map((t) => [t.token, t.role, t.amount.value, t.value.value])).toEqual([
      ['USDC', 'plan', '5000000', '5000000'],
      ['cbBTC', 'plan', '1000', '1024000'],
      ['WETH', 'outside_plan', '262144', '1'],
      ['ETH', 'gas', '524288', '2'],
    ])
    expect(tokens[2]!.code).toBe('OBS_UNMANAGED_ASSET')
    expect(tokens[1]!.value.provenance.source).toBe('estimate')
    expect(tokens[0]!.amount.provenance).toMatchObject({ source: 'chain_rpc', blockNumber: chain.safe })
    expect(rows[1]).toMatchObject({ account_key: 'acct-b', deployed: 0, total_value: '0' })
  })

  const addr = (i: number) => `0x${(0x1000 + i).toString(16).padStart(40, '0')}` as const
  const count = (method: string) => chain.calls.filter((m) => m === method).length

  test('60 accounts cost three Multicall3 requests, not five requests each', async () => {
    for (let i = 0; i < 60; i++) seedAccount(`acct-${String(i).padStart(2, '0')}`, addr(i))
    chain.setBalance(USDC, addr(7), 3_000_000n)
    chain.setBalance('ETH', addr(41), 524_288n)
    // What a run costs with no account at all: the pools and the head.
    const empty = sqliteD1()
    await syncOnce({ client: chain.client(), db: empty, chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: () => {} })
    const before = { call: count('eth_call'), code: count('eth_getCode') }
    chain.calls.length = 0
    await run()
    expect(count('eth_call') - before.call).toBe(3)
    expect(count('eth_getBalance')).toBe(0)
    // None is known to be deployed yet: the code of each is read, once.
    expect(count('eth_getCode') - before.code).toBe(60)
    const rows = db.sqlite.query('SELECT account_key, total_value, tokens_json FROM proj_account_state ORDER BY account_key').all() as { account_key: string; total_value: string; tokens_json: string }[]
    expect(rows).toHaveLength(60)
    expect(rows[7]).toMatchObject({ account_key: 'acct-07', total_value: '3000000' })
    expect((JSON.parse(rows[41]!.tokens_json) as TokenHolding[]).find((t) => t.token === 'ETH')!.amount.value).toBe('524288')
    expect(logs.at(-1)).toMatchObject({ msg: 'sync.done', accounts: 60, accountsTotal: 60 })
  })

  test('the code of an account already projected as deployed is not read again; an undeployed one is', async () => {
    seedAccount('acct-a', A)
    seedAccount('acct-b', B)
    chain.code.set(A.toLowerCase(), '0x60806040')
    await run()
    const codeReads = () => count('eth_getCode')
    chain.calls.length = 0
    const baseline = sqliteD1()
    await syncOnce({ client: chain.client(), db: baseline, chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: () => {} })
    const withoutAccounts = codeReads()
    chain.calls.length = 0
    await run()
    // One read: acct-b, still undeployed. acct-a is known.
    expect(codeReads() - withoutAccounts).toBe(1)
    chain.code.set(B.toLowerCase(), '0x60806040')
    await run()
    chain.calls.length = 0
    await run()
    expect(codeReads() - withoutAccounts).toBe(0)
    const rows = db.sqlite.query('SELECT account_key, deployed FROM proj_account_state ORDER BY account_key').all()
    expect(rows).toEqual([{ account_key: 'acct-a', deployed: 1 }, { account_key: 'acct-b', deployed: 1 }])
  })

  test('a projection whose block was replaced since does not vouch for the code: it is read, and the account is no longer deployed', async () => {
    seedAccount('acct-a', A)
    chain.code.set(A.toLowerCase(), '0x60806040')
    await run()
    const seenAt = chain.safe
    expect(db.sqlite.query('SELECT deployed, block FROM proj_account_state').all()).toEqual([{ deployed: 1, block: seenAt }])
    // A reorg between runs: the block of that projection now has another hash, and on this chain the Safe was never deployed.
    chain.forkAt = seenAt
    chain.code.delete(A.toLowerCase())
    chain.safe += 5
    chain.latest += 5
    chain.calls.length = 0
    const out = await run()
    expect(out.rpc).toBe('ok')
    expect(db.sqlite.query('SELECT deployed, block, block_hash FROM proj_account_state').all()).toEqual([{ deployed: 0, block: chain.safe, block_hash: chain.hashOf(chain.safe) }])
  })

  test('a projection whose block is still on the chain vouches for the code, and asking costs no request', async () => {
    seedAccount('acct-a', A)
    seedAccount('acct-b', B)
    chain.code.set(A.toLowerCase(), '0x60806040')
    chain.code.set(B.toLowerCase(), '0x60806040')
    await run()
    // What a run with no accounts asks (the registry's own code checks, the head, the anchor check).
    chain.calls.length = 0
    await syncOnce({ client: chain.client(), db: sqliteD1(), chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: () => {} })
    const bare = { code: count('eth_getCode'), blocks: count('eth_getBlockByNumber'), call: count('eth_call') }
    for (const step of [0, 5]) {
      // The same safe block again, then a later one: the hash of the earlier block rides in the pools' request.
      chain.safe += step
      chain.latest += step
      chain.calls.length = 0
      await run()
      expect(count('eth_getCode') - bare.code).toBe(0)
      expect(count('eth_getBlockByNumber') - bare.blocks).toBe(0)
      expect(count('eth_call') - bare.call).toBe(1)
    }
  })

  test('a stored hash of zeroes is never proof, in reach of BLOCKHASH or out of it', async () => {
    seedAccount('acct-a', A)
    chain.code.set(A.toLowerCase(), '0x60806040')
    await run()
    chain.calls.length = 0
    await syncOnce({ client: chain.client(), db: sqliteD1(), chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: () => {} })
    const bare = count('eth_getCode')
    for (const step of [5, 300]) {
      db.sqlite.run(`UPDATE proj_account_state SET block_hash = '0x${'00'.repeat(32)}'`)
      chain.code.delete(A.toLowerCase())
      chain.safe += step
      chain.latest += step
      chain.calls.length = 0
      await run()
      expect(count('eth_getCode') - bare).toBe(1)
      expect(db.sqlite.query('SELECT deployed FROM proj_account_state').all()).toEqual([{ deployed: 0 }])
      db.sqlite.run('UPDATE proj_account_state SET deployed = 1')
    }
  })

  test('a projection more than 256 blocks back vouches for nothing: the code is read once, and the next run is steady again', async () => {
    seedAccount('acct-a', A)
    chain.code.set(A.toLowerCase(), '0x60806040')
    await run()
    chain.calls.length = 0
    await syncOnce({ client: chain.client(), db: sqliteD1(), chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: () => {} })
    const bare = count('eth_getCode')
    chain.safe += 300
    chain.latest += 300
    chain.calls.length = 0
    await run()
    expect(count('eth_getCode') - bare).toBe(1)
    chain.safe += 5
    chain.latest += 5
    chain.calls.length = 0
    await run()
    expect(count('eth_getCode') - bare).toBe(0)
    expect(db.sqlite.query('SELECT deployed FROM proj_account_state').all()).toEqual([{ deployed: 1 }])
  })

  test('with earlier projections a run costs the same requests as without: 25, 50 and 60 accounts', async () => {
    for (const [n, requests] of [[25, 1], [50, 2], [60, 3]] as const) {
      db.sqlite.run('DELETE FROM proj_account_state')
      db.sqlite.run('DELETE FROM accounts')
      for (let i = 0; i < n; i++) {
        seedAccount(`acct-${String(i).padStart(2, '0')}`, addr(i))
        chain.code.set(addr(i).toLowerCase(), '0x60806040')
      }
      await run()
      chain.calls.length = 0
      await syncOnce({ client: chain.client(), db: sqliteD1(), chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: () => {} })
      const bare = { code: count('eth_getCode'), call: count('eth_call'), blocks: count('eth_getBlockByNumber') }
      chain.safe += 5
      chain.latest += 5
      chain.calls.length = 0
      await run()
      expect(count('eth_call') - bare.call).toBe(requests)
      expect(count('eth_getCode') - bare.code).toBe(0)
      expect(count('eth_getBlockByNumber') - bare.blocks).toBeLessThanOrEqual(0)
      expect(db.sqlite.query('SELECT COUNT(*) AS n FROM proj_account_state WHERE deployed = 1 AND block = ?').get(chain.safe)).toEqual({ n })
    }
  })

  test('a projection from a later block than this run does not vouch for the code: it is read', async () => {
    seedAccount('acct-a', A)
    chain.code.set(A.toLowerCase(), '0x60806040')
    await run()
    // As if the row had been written by a run that saw a later block than the provider has today.
    db.sqlite.run('UPDATE proj_account_state SET block = block + 1000')
    const baseline = sqliteD1()
    chain.calls.length = 0
    await syncOnce({ client: chain.client(), db: baseline, chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: () => {} })
    const withoutAccounts = count('eth_getCode')
    chain.calls.length = 0
    await run()
    expect(count('eth_getCode') - withoutAccounts).toBe(1)
  })

  test('the request of a whole group fails: its accounts keep their last projection and the sync still finishes', async () => {
    seedAccount('acct-a', A)
    chain.setBalance(USDC, A, 1_000_000n)
    await run()
    chain.setBalance(USDC, A, 7_000_000n)
    chain.safe += 5
    chain.latest += 5
    chain.multicallDown = true
    await run()
    const row = db.sqlite.query('SELECT block, total_value FROM proj_account_state').get() as { block: number; total_value: string }
    expect(row.total_value).toBe('1000000')
    expect(row.block).toBeLessThan(chain.safe)
    expect(logs.at(-1)).toMatchObject({ msg: 'sync.done', accounts: 0, accountsTotal: 1 })
  })

  test('an account with a read that fails keeps its last projection; the others in the request are written', async () => {
    seedAccount('acct-a', A)
    seedAccount('acct-b', B)
    chain.setBalance(USDC, A, 1_000_000n)
    chain.setBalance(USDC, B, 2_000_000n)
    await run()
    chain.setBalance(USDC, A, 9_000_000n)
    chain.setBalance(USDC, B, 8_000_000n)
    chain.balanceReverts.add(A.toLowerCase())
    chain.safe += 5
    chain.latest += 5
    await run()
    const rows = db.sqlite.query('SELECT account_key, block, total_value FROM proj_account_state ORDER BY account_key').all() as { account_key: string; block: number; total_value: string }[]
    expect(rows[0]).toMatchObject({ account_key: 'acct-a', total_value: '1000000' })
    expect(rows[0]!.block).toBeLessThan(rows[1]!.block)
    expect(rows[1]).toMatchObject({ account_key: 'acct-b', total_value: '8000000', block: chain.safe })
    expect(logs.at(-1)).toMatchObject({ msg: 'sync.done', accounts: 1, accountsTotal: 2 })
  })

  test('without the WETH price, WETH and ETH values are not observed and the total is null', async () => {
    seedAccount('acct-a', A)
    chain.pools.delete(WETH_POOL.toLowerCase())
    await run()
    const a = db.sqlite.query('SELECT tokens_json, total_value FROM proj_account_state').get() as { tokens_json: string; total_value: string | null }
    expect(a.total_value).toBeNull()
    const tokens = JSON.parse(a.tokens_json) as TokenHolding[]
    expect(tokens.find((t) => t.token === 'ETH')!.value).toMatchObject({ value: null, provenance: { status: 'not_observed' } })
    expect(tokens.find((t) => t.token === 'USDC')!.value.value).toBe('0')
  })
})

describe('log sources', () => {
  const failing = () =>
    makeClient(
      custom({ request: async () => { throw new HttpRequestError({ url: 'https://secret.example/key123', status: 503 }) } }, { retryCount: 0 }),
    )

  test('falls through to the next source and logs the failure without URLs', async () => {
    const sources = [{ name: 'first', client: failing(), maxRange: 1000 }, { name: 'second', client: chain.client(), maxRange: 30 }]
    await syncOnce({ client: chain.client(), logSources: sources, db, chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: (l) => logs.push(l) })
    expect(poolView().stats.swaps.value).toBe(2)
    const line = logs.find((l) => l.msg === 'sync.logs')!
    expect(line).toMatchObject({ source: 'second', requests: 1 + 4, failures: [{ source: 'first', error: 'HttpRequestError', status: 503 }] })
    expect(JSON.stringify(logs)).not.toContain('secret.example')
  })

  test('a short-range last resort reads a shorter window and says so', async () => {
    const sources = [{ name: 'first', client: failing(), maxRange: 1000 }, { name: 'keyed', client: chain.client(), maxRange: 10, maxWindow: 55 }]
    await syncOnce({ client: chain.client(), logSources: sources, db, chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: (l) => logs.push(l) })
    const v = poolView()
    expect(v.window).toEqual({ fromBlock: chain.safe - 54, toBlock: chain.safe })
    expect(v.stats.swaps.value).toBe(1)
  })

  test('when every source fails the history is not observed and the log names each failure', async () => {
    const sources = [{ name: 'a', client: failing(), maxRange: 1000 }, { name: 'b', client: failing(), maxRange: 500 }]
    await syncOnce({ client: chain.client(), logSources: sources, db, chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: (l) => logs.push(l) })
    expect(poolView().stats.swaps).toMatchObject({ value: null, provenance: { status: 'not_observed', detail: 'OBS_RPC_UNAVAILABLE' } })
    expect(logs.find((l) => l.msg === 'sync.history_failed')).toMatchObject({ stage: 'logs', error: 'LogSourcesFailed', failures: [{ source: 'a', status: 503 }, { source: 'b', status: 503 }] })
  })
})

describe('pool history', () => {
  type Row = {
    pool_address: string; block: number; block_hash: string; block_time: number; sqrt_price_x96: string; tick: number; liquidity: string
    fee_growth_global0_x128: string; fee_growth_global1_x128: string; tick_cumulative: string | null; fee_protocol: number; base_fee_wei: string | null
  }
  const rows = () => db.sqlite.query('SELECT * FROM pool_snapshots ORDER BY block, pool_address').all() as Row[]
  const FG: [bigint, bigint] = [2n ** 200n + 7n, 2n ** 130n + 3n]

  beforeEach(() => {
    const p = chain.pools.get(POOL.toLowerCase())!
    chain.pools.set(POOL.toLowerCase(), { ...p, feeGrowth: FG, feeProtocol: 68 })
    chain.pools.set(WETH_POOL.toLowerCase(), { ...chain.pools.get(WETH_POOL.toLowerCase())!, feeGrowth: [1n, 2n], feeProtocol: 102 })
    chain.baseFee = 5_000_000n
  })

  test('appends one row per readable registry pool at the safe block, in one eth_call', async () => {
    chain.latest = chain.safe + 500
    const summary = await run()
    // One Multicall3 request for every registry pool, pinned to the safe block and not to the head.
    expect(chain.multicalls).toEqual([chain.safe])
    expect(summary.snapshots).toBe(2)
    const [a] = rows().filter((r) => r.pool_address === POOL)
    expect(a).toMatchObject({
      block: chain.safe, block_hash: chain.hashOf(chain.safe), block_time: chain.timeOf(chain.safe), sqrt_price_x96: CBBTC_SQRT.toString(), tick: -69315,
      liquidity: '5000000', fee_growth_global0_x128: FG[0].toString(), fee_growth_global1_x128: FG[1].toString(), fee_protocol: 68, base_fee_wei: '5000000',
    })
    expect(a!.tick_cumulative).toBe((-69_300n * 1_000_000n - 69_310n * 1800n).toString())
    // The WETH pool has no oracle answer in this fixture: the row is kept, the cumulative is null.
    expect(rows().find((r) => r.pool_address === WETH_POOL)).toMatchObject({ tick_cumulative: null, fee_protocol: 102 })
    // Registry pools the chain does not serve are left out, not written as zeros.
    expect(rows()).toHaveLength(2)
    expect(logs.filter((l) => l.msg === 'sync.snapshots_failed')).toHaveLength(0)
  })

  test('keeps the retention window and drops the rows below it', async () => {
    const keep = 100
    const sync = () => syncOnce({ client: chain.client(), db, chainId: 8453, now: () => NOW, registry, windowBlocks: W, log: (l) => logs.push(l), snapshotRetentionBlocks: keep })
    await sync()
    const first = chain.safe
    chain.safe += keep
    chain.latest += keep
    await sync()
    expect(rows().filter((r) => r.pool_address === POOL).map((r) => r.block)).toEqual([first, chain.safe])
    chain.safe += 1
    chain.latest += 1
    await sync()
    expect(rows().filter((r) => r.pool_address === POOL).map((r) => r.block)).toEqual([chain.safe - 1, chain.safe])
    expect(rows().filter((r) => r.pool_address === WETH_POOL).map((r) => r.block)).toEqual([chain.safe - 1, chain.safe])
  })

  test('a second sync on the same safe block keeps the first row; a new safe block adds one', async () => {
    await run()
    chain.pools.set(POOL.toLowerCase(), { ...chain.pools.get(POOL.toLowerCase())!, tick: -69000 })
    await run()
    expect(rows().filter((r) => r.pool_address === POOL).map((r) => r.tick)).toEqual([-69315])
    chain.safe += 60
    chain.latest += 60
    await run()
    expect(rows().filter((r) => r.pool_address === POOL).map((r) => [r.block, r.tick])).toEqual([[chain.safe - 60, -69315], [chain.safe, -69000]])
  })

  test('a failed history read or a missing table never costs the read model', async () => {
    chain.multicallDown = true
    const s1 = await run()
    expect(s1.rpc).toBe('ok')
    expect(s1.snapshots).toBe(0)
    expect(poolView().block).toBe(chain.safe)
    // The aggregate failed twice: the second try names the cause instead of reporting six silent failures.
    expect(logs.find((l) => l.msg === 'sync.snapshots_failed')).toMatchObject({ stage: 'read' })
    expect(chain.multicalls).toHaveLength(2)

    chain.multicallDown = false
    logs.length = 0
    db.sqlite.exec('DROP TABLE pool_snapshots')
    chain.safe += 10
    chain.latest += 10
    const s2 = await run()
    expect(s2.rpc).toBe('ok')
    expect(s2.snapshots).toBe(0)
    expect(poolView().block).toBe(chain.safe)
    expect(logs.find((l) => l.msg === 'sync.snapshots_failed')).toMatchObject({ stage: 'write' })
  })

  test('the history is the first read after the head, before the log reads', async () => {
    chain.calls.length = 0
    await run()
    const firstCall = chain.calls.indexOf('eth_call')
    const firstLogs = chain.calls.indexOf('eth_getLogs')
    expect(chain.multicalls).toEqual([chain.safe])
    expect(firstCall).toBeGreaterThan(-1)
    expect(firstCall).toBeLessThan(firstLogs)
  })

  test('a node that omits the base fee still gets its row', async () => {
    chain.baseFee = null
    await run()
    expect(rows().find((r) => r.pool_address === POOL)).toMatchObject({ base_fee_wei: null })
  })
})

describe('anchor consistency', () => {
  test('a different hash for the anchor block at the end of the sync writes nothing', async () => {
    await run()
    const before = poolView().block
    chain.safe += 20
    chain.latest += 20
    chain.forkAt = chain.safe
    const s = await run()
    expect(s).toMatchObject({ rpc: 'unavailable', code: 'OBS_BLOCK_INCONSISTENT' })
    expect(poolView().block).toBe(before)
    expect(db.sqlite.query('SELECT rpc_status FROM source_state').get()).toEqual({ rpc_status: 'unavailable' })
    expect(logs.some((l) => l.msg === 'sync.block_inconsistent')).toBe(true)
  })

  test('no answer for the anchor block is an outage, not an inconsistency', async () => {
    await run()
    const before = poolView().block
    chain.safe += 20
    chain.latest += 20
    chain.numberedBlocksDown = true
    const s = await run()
    expect(s).toMatchObject({ rpc: 'unavailable', code: 'OBS_RPC_UNAVAILABLE' })
    expect(poolView().block).toBe(before)
    expect(logs.some((l) => l.msg === 'sync.block_inconsistent')).toBe(false)
  })
})
