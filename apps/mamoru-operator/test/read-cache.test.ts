// otto/mamoru#419: the proxy's read cache. Unit rules, then requests per review measured on a fake chain behind the
// proxy, with and without it: 13 accounts reviewed at staggered heads, as the live engines are.
import { describe, expect, test } from 'bun:test'
import { createPublicClient, http } from 'viem'
import type { Address } from '@mamoru/domain'
import { historyCursor, observe, type ObserveInput } from '@mamoru/rpc'
import { FakeChain } from '../../../packages/rpc/test/fake-chain.ts'
import { ReadCache, pinnedBlock } from '../src/read-cache.ts'
import { startRpcProxy } from '../src/rpc-proxy.ts'

const hex = (n: bigint) => `0x${n.toString(16)}`

describe('read cache rules', () => {
  test('only a hex block number pins a read', () => {
    expect(pinnedBlock({ method: 'eth_call', params: [{}, '0x10'] })).toBe(16n)
    expect(pinnedBlock({ method: 'eth_call', params: [{}, 'latest'] })).toBeNull()
    expect(pinnedBlock({ method: 'eth_call', params: [{}, { blockHash: '0xab' }] })).toBeNull()
    expect(pinnedBlock({ method: 'eth_getStorageAt', params: ['0x1', '0x0', '0x20'] })).toBe(32n)
    expect(pinnedBlock({ method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] })).toBeNull()
  })

  test('a pinned read is kept only at or below the finalized block; above it every read reaches the provider', async () => {
    const c = new ReadCache(async () => null)
    c.noteFinal({ number: hex(100n) })
    let asked = 0
    const ask = async () => (asked++, { jsonrpc: '2.0', id: 1, result: '0xaa' })
    const below = { method: 'eth_call', params: [{ to: '0x1' }, hex(100n)] }
    const above = { method: 'eth_call', params: [{ to: '0x1' }, hex(101n)] }
    await c.run(below, ask)
    expect(c.hit(below)).toEqual({ jsonrpc: '2.0', id: 1, result: '0xaa' })
    await c.run(above, ask)
    await c.run(above, ask)
    expect(c.hit(above)).toBeUndefined()
    expect(asked).toBe(3)
  })

  test('errors, null blocks and logs are never kept; a receipt is kept once its block is final', async () => {
    const c = new ReadCache(async () => null)
    c.noteFinal({ number: hex(100n) })
    const err = { method: 'eth_call', params: [{}, hex(50n)] }
    await c.run(err, async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } }))
    expect(c.hit(err)).toBeUndefined()
    const missing = { method: 'eth_getBlockByNumber', params: [hex(50n), false] }
    await c.run(missing, async () => ({ jsonrpc: '2.0', id: 1, result: null }))
    expect(c.hit(missing)).toBeUndefined()
    const recent = { method: 'eth_getTransactionReceipt', params: ['0x01'] }
    await c.run(recent, async () => ({ jsonrpc: '2.0', id: 1, result: { blockNumber: hex(150n) } }))
    expect(c.hit(recent)).toBeUndefined()
    const old = { method: 'eth_getTransactionReceipt', params: ['0x02'] }
    await c.run(old, async () => ({ jsonrpc: '2.0', id: 1, result: { blockNumber: hex(90n) } }))
    expect(c.hit(old)).toBeDefined()
    const logs = { method: 'eth_getLogs', params: [{ fromBlock: hex(1n), toBlock: hex(2n) }] }
    let n = 0
    await c.run(logs, async () => (n++, { jsonrpc: '2.0', id: 1, result: [] }))
    await c.run(logs, async () => (n++, { jsonrpc: '2.0', id: 1, result: [] }))
    expect(n).toBe(2)
  })

  test('identical reads in flight share one answer, then nothing is kept above the finalized block', async () => {
    const c = new ReadCache(async () => null)
    let asked = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ask = async () => (asked++, await gate, { jsonrpc: '2.0', id: 1, result: '0x1' })
    const msg = { method: 'eth_blockNumber', params: [] }
    const all = Promise.all([c.run(msg, ask), c.run(msg, ask), c.run(msg, ask)])
    release()
    expect((await all).map((r) => r.result)).toEqual(['0x1', '0x1', '0x1'])
    expect(asked).toBe(1)
    await c.run(msg, ask)
    expect(asked).toBe(2)
  })

  test('the finalized block is asked at most once per period, and only when a read may fall under it', async () => {
    let asks = 0
    const c = new ReadCache(async () => (asks++, { number: hex(100n) }), 10, 60_000)
    const ok = async () => ({ jsonrpc: '2.0', id: 1, result: '0x' })
    await c.run({ method: 'eth_call', params: [{}, hex(50n)] }, ok)
    await c.run({ method: 'eth_call', params: [{}, hex(51n)] }, ok)
    await Bun.sleep(1)
    expect(asks).toBe(1)
    // Known now: a read far above it (the head, while finality trails it) asks nothing.
    c.noteHead(110n)
    await c.run({ method: 'eth_call', params: [{}, hex(500n)] }, ok)
    expect(asks).toBe(1)
  })
})

/** 13 accounts with code and a USDC balance, reviewed one after another at heads `spacing` blocks apart, `rounds` times. */
async function measure(opts: { cache: boolean; finalLag: bigint; safeLag: bigint; spacing: bigint; rounds: number }): Promise<Record<string, number>> {
  const chain = new FakeChain()
  const accounts = Array.from({ length: 13 }, (_, i) => `0x${(0xa0 + i).toString(16).padStart(40, '0')}` as Address)
  for (const a of accounts) {
    chain.code.set(a.toLowerCase(), '0x6001')
    chain.setBalance('USDC', a, 25_000_000n)
  }
  const up = chain.serve()
  const proxy = startRpcProxy(up.url, { readCache: opts.cache, chainId: 8453, fallbacks: [], trusted: [], logRanges: {}, headLag: 0n })
  const client = createPublicClient({ transport: http(`${proxy.url}c/engine`, { batch: true }) }) as never
  const cursors = accounts.map(() => historyCursor())
  const input = (a: Address, i: number): ObserveInput => ({
    chainId: 8453,
    account: a,
    nonceKey: 0n,
    depositsAfter: 800n,
    sessions: [],
    allowedTokenIds: [],
    historyFromBlock: 800n,
    historyCursor: cursors[i]!,
    intents: { paused: false, exitRequested: false },
    slot: null,
    twapWindowSeconds: 1800,
    opGasUnits: 5_100_000n,
    maxPriorityFeePerGas: 1_000_000n,
    savingsAsset: 'USDC',
    ethPricePool: 'pool:WETH/USDC/3000',
  })
  const set = (h: bigint) => {
    chain.head = h
    chain.safe = h - opts.safeLag
    chain.finalized = h - opts.finalLag
  }
  try {
    let h = 2_000n
    // A first round settles the cursors and deployments; only the rounds after it are counted.
    for (const [i, a] of accounts.entries()) (set((h += opts.spacing)), await observe(client, input(a, i)))
    chain.requests.length = 0
    for (let r = 0; r < opts.rounds; r++) for (const [i, a] of accounts.entries()) (set((h += opts.spacing)), await observe(client, input(a, i)))
    await Bun.sleep(5)
    return { total: chain.count(), ...chain.byMethod() }
  } finally {
    proxy.stop()
    up.stop()
  }
}

describe('requests per review behind the proxy (otto/mamoru#419)', () => {
  test('Base-like: finality ~20 min behind, engines 10 blocks apart', async () => {
    const off = await measure({ cache: false, finalLag: 600n, safeLag: 100n, spacing: 10n, rounds: 3 })
    const on = await measure({ cache: true, finalLag: 600n, safeLag: 100n, spacing: 10n, rounds: 3 })
    console.log(`[measure] base off ${JSON.stringify(off)}`)
    console.log(`[measure] base on  ${JSON.stringify(on)}`)
    expect(on.total!).toBeLessThan(off.total!)
    expect(on.eth_chainId ?? 0).toBe(0)
  })

  test('Monad-like: finality two blocks behind the head, engines 50 blocks apart', async () => {
    const off = await measure({ cache: false, finalLag: 2n, safeLag: 1n, spacing: 50n, rounds: 3 })
    const on = await measure({ cache: true, finalLag: 2n, safeLag: 1n, spacing: 50n, rounds: 3 })
    console.log(`[measure] monad off ${JSON.stringify(off)}`)
    console.log(`[measure] monad on  ${JSON.stringify(on)}`)
    expect(on.total!).toBeLessThan(off.total!)
  })
})
