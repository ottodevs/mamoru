// otto/mamoru#420: reads spread across the trusted providers by weight, not upstream-first; the trust split, the send
// order and the head a decision reads at stay as they were.
import { describe, expect, test } from 'bun:test'
import { QuotaBook } from '../src/quota.ts'
import { startRpcProxy, weightsFromEnv } from '../src/rpc-proxy.ts'

const A = 'https://a-node.quiknode.pro/key-a/'
const B = 'https://eth-mainnet.g.alchemy.com/v2/key-b'
const PUBLIC = 'https://base-rpc.publicnode.com'
const host = (u: string) => (u === A ? 'A' : u === B ? 'B' : u === PUBLIC ? 'P' : '?')
const ADDR = '0x0000000000000000000000000000000000000001'

/** Each provider has a tip; it answers eth_blockNumber with it and any read at or under it. */
function world(tipOf: Record<string, number>) {
  const calls: { who: string; method: string }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params?: unknown[] }
    calls.push({ who: host(url), method: body.method })
    const tip = tipOf[url] ?? 0
    if (body.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: body.id, result: `0x${tip.toString(16)}` })
    if (body.method === 'eth_sendRawTransaction') return Response.json({ jsonrpc: '2.0', id: body.id, result: `0x${'ab'.repeat(32)}` })
    if (body.method === 'eth_getBlockByNumber') {
      const n = Number(body.params?.[0])
      return Response.json({ jsonrpc: '2.0', id: body.id, result: n <= tip ? { number: `0x${n.toString(16)}`, hash: `0x${'11'.repeat(32)}` } : null })
    }
    const at = body.params?.[1]
    if (typeof at === 'string' && at.startsWith('0x') && Number(at) > tip) return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'header not found' } })
    return Response.json({ jsonrpc: '2.0', id: body.id, result: `0x${host(url) === 'A' ? 'aa' : 'bb'}` })
  }
  return { fetch, calls }
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return res.json()
}

/** A draw that walks a fixed sequence, so the spread is deterministic. */
const draws = (xs: number[]) => {
  let i = 0
  return () => xs[i++ % xs.length]!
}

describe('weights from env', () => {
  test('label or domain = weight, 0 allowed, anything else ignored', () => {
    expect(weightsFromEnv({ MAMORU_RPC_WEIGHTS: 'quiknode.pro=3, Alchemy.com#2=0, x=-1, y=abc, z=' })).toEqual({ 'quiknode.pro': 3, 'alchemy.com#2': 0 })
    expect(weightsFromEnv({})).toEqual({})
  })
})

describe('weighted read spread (otto/mamoru#420)', () => {
  test('heads are drawn by weight; every read pinned to a head starts where that head came from; older blocks spread', async () => {
    const w = world({ [A]: 100, [B]: 100 })
    const proxy = startRpcProxy(A, { fetch: w.fetch, trusted: [B], fallbacks: [PUBLIC], logRanges: {}, headLag: 0n, quota: new QuotaBook(), random: draws([0.1, 0.9]) })
    try {
      // Both tips become known: one head from each.
      expect((await rpc(proxy.url, 'eth_blockNumber')).result).toBe('0x64')
      expect((await rpc(proxy.url, 'eth_blockNumber')).result).toBe('0x64')
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'B'])
      w.calls.length = 0
      // A decision on head 100 (A gave it first): its reads and its simulation all start at A.
      for (let i = 0; i < 3; i++) await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x64'])
      await rpc(proxy.url, 'eth_simulateV1', [{ blockStateCalls: [] }, '0x64'])
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'A', 'A', 'A'])
      w.calls.length = 0
      // A block that is not a served head, which both have: drawn by weight.
      for (let i = 0; i < 4; i++) await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x60'])
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'B', 'A', 'B'])
      expect(w.calls.some((c) => c.who === 'P')).toBe(false)
    } finally {
      proxy.stop()
    }
  })

  test('a decision on a head from B reads at B; when B fails mid-decision it falls back to a trusted provider with the block', async () => {
    const w = world({ [A]: 100, [B]: 101 })
    const down = new Set<string>()
    const fetch = async (url: string, init: RequestInit) => (down.has(url) ? (w.calls.push({ who: host(url), method: 'down' }), new Response('bad gateway', { status: 502 })) : w.fetch(url, init))
    const proxy = startRpcProxy(A, { fetch, trusted: [B], fallbacks: [PUBLIC], logRanges: {}, headLag: 1n, quota: new QuotaBook(), random: draws([0.1, 0.9]) })
    try {
      await rpc(proxy.url, 'eth_blockNumber')
      // B's head 101, served at 100 (lag 1).
      expect((await rpc(proxy.url, 'eth_blockNumber')).result).toBe('0x64')
      w.calls.length = 0
      await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x64'])
      expect(w.calls.map((c) => c.who)).toEqual(['B'])
      // Its guard simulation, pinned to the same head, goes to B as well: one provider's view for the whole decision.
      w.calls.length = 0
      expect((await rpc(proxy.url, 'eth_simulateV1', [{ blockStateCalls: [] }, '0x64'])).result).toBe('0xbb')
      expect((await rpc(proxy.url, 'eth_estimateGas', [{ to: ADDR }, '0x64'])).result).toBe('0xbb')
      expect(w.calls.map((c) => c.who)).toEqual(['B', 'B'])
      down.add(B)
      w.calls.length = 0
      expect((await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x64'])).result).toBe('0xaa')
      expect(w.calls.map((c) => c.who)).toEqual(['B', 'A'])
    } finally {
      proxy.stop()
    }
  })

  test('weights from env shape the draw: weight 0 never starts a read but is still a fallback', async () => {
    const w = world({ [A]: 100, [B]: 100 })
    const proxy = startRpcProxy(A, { fetch: w.fetch, trusted: [B], fallbacks: [], logRanges: {}, headLag: 0n, quota: new QuotaBook(), weights: { 'quiknode.pro': 0 }, random: draws([0, 0.5, 0.99]) })
    try {
      for (let i = 0; i < 3; i++) await rpc(proxy.url, 'eth_blockNumber')
      expect(w.calls.map((c) => c.who)).toEqual(['B', 'B', 'B'])
    } finally {
      proxy.stop()
    }
  })

  test('a read pinned past a provider tip never starts there: the head and its reads stay on one consistent view', async () => {
    // B is 10 blocks behind A.
    const w = world({ [A]: 110, [B]: 100 })
    const proxy = startRpcProxy(A, { fetch: w.fetch, trusted: [B], fallbacks: [], logRanges: {}, headLag: 0n, quota: new QuotaBook(), random: draws([0.1, 0.9]) })
    try {
      expect((await rpc(proxy.url, 'eth_blockNumber')).result).toBe(`0x${(110).toString(16)}`)
      // B answers a lower head: the served head does not step back.
      expect((await rpc(proxy.url, 'eth_blockNumber')).result).toBe(`0x${(110).toString(16)}`)
      w.calls.length = 0
      for (let i = 0; i < 4; i++) expect((await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, `0x${(110).toString(16)}`])).result).toBe('0xaa')
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'A', 'A', 'A'])
      // `latest` blocks go through the served head, so they too go where that block is.
      w.calls.length = 0
      const blk = await rpc(proxy.url, 'eth_getBlockByNumber', ['latest', false])
      expect(blk.result?.number).toBe(`0x${(110).toString(16)}`)
      expect(w.calls.filter((c) => c.method === 'eth_getBlockByNumber').map((c) => c.who)).toEqual(['A'])
      // An older block both have: spread again.
      w.calls.length = 0
      for (let i = 0; i < 2; i++) await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x60'])
      expect(w.calls.map((c) => c.who).sort()).toEqual(['A', 'B'])
    } finally {
      proxy.stop()
    }
  })

  test('a simulation pinned to a block follows the same rule as the reads of its decision', async () => {
    const w = world({ [A]: 110, [B]: 100 })
    const proxy = startRpcProxy(A, { fetch: w.fetch, trusted: [B], fallbacks: [], logRanges: {}, headLag: 0n, quota: new QuotaBook(), random: draws([0.1, 0.9]) })
    try {
      await rpc(proxy.url, 'eth_blockNumber')
      await rpc(proxy.url, 'eth_blockNumber')
      w.calls.length = 0
      for (let i = 0; i < 3; i++) await rpc(proxy.url, 'eth_simulateV1', [{ blockStateCalls: [] }, `0x${(105).toString(16)}`])
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'A', 'A'])
    } finally {
      proxy.stop()
    }
  })

  test('no tip known yet: the configured order, upstream first, as before', async () => {
    const w = world({ [A]: 100, [B]: 100 })
    const proxy = startRpcProxy(A, { fetch: w.fetch, trusted: [B], fallbacks: [], logRanges: {}, headLag: 0n, quota: new QuotaBook(), random: draws([0.9]) })
    try {
      for (let i = 0; i < 3; i++) await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x50'])
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'A', 'A'])
    } finally {
      proxy.stop()
    }
  })

  test('reads not pinned to a block keep the configured order, even with the upstream in a backoff; sends keep theirs too', async () => {
    const w = world({ [A]: 100, [B]: 100 })
    const quota = new QuotaBook()
    const proxy = startRpcProxy(A, { fetch: w.fetch, trusted: [B], fallbacks: [PUBLIC], logRanges: {}, headLag: 0n, quota, random: draws([0.99]) })
    try {
      quota.backoff(A, 'quiknode.pro', 'failing')
      await rpc(proxy.url, 'eth_getTransactionCount', [ADDR, 'pending'])
      await rpc(proxy.url, 'eth_getTransactionReceipt', [`0x${'22'.repeat(32)}`])
      await rpc(proxy.url, 'eth_sendRawTransaction', ['0x02'])
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'A', 'A'])
    } finally {
      proxy.stop()
    }
  })

  test('a provider out of quota, burst-limited or failing gets weight 0; a good answer brings it back', async () => {
    const quota = new QuotaBook()
    const w = world({ [A]: 100, [B]: 100 })
    const proxy = startRpcProxy(A, { fetch: w.fetch, trusted: [B], fallbacks: [], logRanges: {}, headLag: 0n, quota, random: draws([0.1, 0.9]) })
    const pinned = () => rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x60'])
    try {
      await rpc(proxy.url, 'eth_blockNumber')
      await rpc(proxy.url, 'eth_blockNumber')
      // Failing: whatever the draw, B starts.
      quota.backoff(A, 'quiknode.pro', 'failing')
      w.calls.length = 0
      await pinned()
      await pinned()
      expect(w.calls.map((c) => c.who)).toEqual(['B', 'B'])
      // Burst-limited: the same, the other way round.
      quota.clear(A, Date.now())
      quota.backoff(B, 'alchemy.com', 'burst_limited')
      w.calls.length = 0
      await pinned()
      await pinned()
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'A'])
      // Both cooling: the configured order; the one that answers is back in the draw.
      quota.backoff(A, 'quiknode.pro', 'failing')
      w.calls.length = 0
      await pinned()
      expect(w.calls.map((c) => c.who)).toEqual(['A'])
      expect(quota.cooling(A)).toBe(false)
      // Parked for its quota: left out entirely while another trusted provider answers.
      quota.clear(B, Date.now())
      quota.mark(B, 'alchemy.com', 'Monthly capacity limit exceeded', Date.now() + 86_400_000)
      w.calls.length = 0
      for (let i = 0; i < 3; i++) await pinned()
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'A', 'A'])
    } finally {
      proxy.stop()
    }
  })

  test('a provider that fails is passed over within the same read and kept out of the next draws for its backoff', async () => {
    const quota = new QuotaBook()
    const w = world({ [A]: 100, [B]: 100 })
    const down = new Set<string>()
    const fetch = async (url: string, init: RequestInit) => (down.has(url) ? new Response('bad gateway', { status: 502 }) : w.fetch(url, init))
    const proxy = startRpcProxy(A, { fetch, trusted: [B], fallbacks: [PUBLIC], logRanges: {}, headLag: 0n, quota, random: draws([0.1, 0.9]) })
    try {
      await rpc(proxy.url, 'eth_blockNumber')
      await rpc(proxy.url, 'eth_blockNumber')
      down.add(B)
      w.calls.length = 0
      // Draw 0.1 picks A; draw 0.9 picks B, which fails: the read falls back to A, never to the public node.
      expect((await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x60'])).result).toBe('0xaa')
      expect((await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x60'])).result).toBe('0xaa')
      expect(quota.providers().find((p) => p.label === 'alchemy.com')?.state).toBe('failing')
      w.calls.length = 0
      // B cooling: every draw starts at A now.
      for (let i = 0; i < 2; i++) await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x60'])
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'A'])
    } finally {
      proxy.stop()
    }
  })

  test('a spent public fallback due for its recheck never jumps ahead of the upstream for a send', async () => {
    const quota = new QuotaBook(undefined, 0)
    const w = world({ [A]: 100, [B]: 100 })
    const proxy = startRpcProxy(A, { fetch: w.fetch, trusted: [B], fallbacks: [PUBLIC], logRanges: {}, headLag: 0n, quota })
    try {
      quota.mark(PUBLIC, 'publicnode.com', 'quota exceeded', Date.now() + 86_400_000)
      await Bun.sleep(2)
      await rpc(proxy.url, 'eth_sendRawTransaction', ['0x02'])
      expect(w.calls.map((c) => c.who)).toEqual(['A'])
    } finally {
      proxy.stop()
    }
  })

  test('a provider that answers it does not have a block it showed is put back under it (a reorg, a lagging node)', async () => {
    const tipOf: Record<string, number> = { [A]: 100, [B]: 100 }
    const w = world(tipOf)
    const proxy = startRpcProxy(A, { fetch: w.fetch, trusted: [B], fallbacks: [], logRanges: {}, headLag: 0n, quota: new QuotaBook(), random: draws([0.9, 0.1]) })
    try {
      // Head 100 from B first, then from A.
      await rpc(proxy.url, 'eth_blockNumber')
      await rpc(proxy.url, 'eth_blockNumber')
      // B rolls back to 98: its read at 100 says header not found.
      tipOf[B] = 98
      w.calls.length = 0
      expect((await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x64'])).error?.message).toBe('header not found')
      expect(w.calls.map((c) => c.who)).toEqual(['B'])
      // From now on reads at 100 start at A, the one provider that still has the block.
      w.calls.length = 0
      for (let i = 0; i < 2; i++) expect((await rpc(proxy.url, 'eth_call', [{ to: ADDR, data: '0x' }, '0x64'])).result).toBe('0xaa')
      expect(w.calls.map((c) => c.who)).toEqual(['A', 'A'])
    } finally {
      proxy.stop()
    }
  })
})
