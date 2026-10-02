import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcMetrics } from '../src/metrics.ts'
import { logRangeOf, logRangesFromEnv, startRpcProxy } from '../src/rpc-proxy.ts'

const ALCHEMY = 'https://base-mainnet.g.alchemy.com/v2/test-key'
const PUBLICNODE = 'https://base-rpc.publicnode.com'
const DRPC = 'https://base.drpc.org'
const BASE_ORG = 'https://mainnet.base.org'
const FALLBACKS = [PUBLICNODE, DRPC, BASE_ORG]

type Log = { blockNumber: string; logIndex: string; data: string }
type Call = { method: string; from?: number; to?: number; block?: number }
type Provider = {
  limit: number
  /** Last block this provider has. Logs above it are silently missing from its answers, as on a node that is behind. */
  head: number
  /** Blocks from here on have another hash than on the canonical chain, and carry `forkLogs` instead. */
  forkFrom?: number
  forkLogs?: Log[]
  down?: boolean
  failAt?: (from: number, to: number) => boolean
  calls: Call[]
}

const hex = (n: number) => `0x${n.toString(16)}`
const log = (block: number, index: number): Log => ({ blockNumber: hex(block), logIndex: hex(index), data: `0x${block.toString(16)}${index}` })
const hashOf = (n: number, fork = false) => `0x${(fork ? 'f' : 'a').repeat(8)}${n.toString(16).padStart(56, '0')}`

/** Four providers with the range limits of the real ones, over one list of logs. A range over the limit is refused. */
function world(logs: Log[]) {
  const providers: Record<string, Provider> = {
    [ALCHEMY]: { limit: 10, head: 10_000, calls: [] },
    [PUBLICNODE]: { limit: 2_000, head: 10_000, calls: [] },
    [DRPC]: { limit: 10_000, head: 10_000, calls: [] },
    [BASE_ORG]: { limit: 2_000, head: 10_000, calls: [] },
  }
  const fetch = async (url: string, init: RequestInit) => {
    const p = providers[url]!
    // One node answers one request: its fork point is read once.
    const forkFrom = p.forkFrom
    const body = JSON.parse(String(init.body))
    const answer = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result })
    const refuse = (code: number, message: string, status = 200) => Response.json({ jsonrpc: '2.0', id: body.id, error: { code, message } }, { status })
    if (body.method === 'eth_blockNumber') {
      p.calls.push({ method: body.method })
      return p.down ? refuse(-32603, 'service unavailable', 503) : answer(hex(p.head))
    }
    if (body.method === 'eth_getBlockByNumber') {
      const n = Number(body.params[0])
      p.calls.push({ method: body.method, block: n })
      if (p.down) return refuse(-32603, 'service unavailable', 503)
      return answer(n > p.head ? null : { number: hex(n), hash: hashOf(n, forkFrom !== undefined && n >= forkFrom) })
    }
    const [from, to] = [Number(body.params[0].fromBlock), Number(body.params[0].toBlock)]
    p.calls.push({ method: body.method, from, to })
    if (p.down) return refuse(-32603, 'service unavailable', 503)
    if (to - from + 1 > p.limit) return refuse(-32602, `query exceeds max block range ${p.limit}`)
    if (p.failAt?.(from, to)) return refuse(-32000, 'Archive requests require a personal token')
    const visible = forkFrom === undefined ? logs : [...logs.filter((l) => Number(l.blockNumber) < forkFrom), ...(p.forkLogs ?? [])]
    const last = Math.min(to, p.head)
    return answer(visible.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= last))
  }
  const logsCalls = (url: string) => providers[url]!.calls.filter((c) => c.method === 'eth_getLogs')
  const blockCalls = (url: string) => providers[url]!.calls.filter((c) => c.method === 'eth_getBlockByNumber').map((c) => c.block)
  return { providers, fetch, logsCalls, blockCalls }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type Answer = { result?: Log[]; error?: { code: number; message: string } }

async function getLogs(w: ReturnType<typeof world>, from: number, to: number, metrics?: RpcMetrics): Promise<Answer> {
  const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, fallbacks: FALLBACKS, logRanges: {}, metrics })
  try {
    const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: '0x01', fromBlock: hex(from), toBlock: hex(to) }] }) })
    return (await res.json()) as Answer
  } finally {
    proxy.stop()
  }
}

const LOGS = [log(1005, 2), log(1005, 0), log(1017, 1), log(1100, 0), log(1149, 3), log(3500, 0), log(5999, 1)]
const inOrder = (from: number, to: number) => LOGS.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to).sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex))

describe('eth_getLogs routing by provider range', () => {
  test('a 150-block range is one request to the first provider that takes it whole, none to the 10-block upstream', async () => {
    const w = world(LOGS)
    const r = await getLogs(w, 1000, 1149)
    expect(r.result).toEqual(inOrder(1000, 1149))
    expect(w.logsCalls(PUBLICNODE)).toEqual([{ method: 'eth_getLogs', from: 1000, to: 1149 }])
    expect(w.logsCalls(ALCHEMY).length + w.logsCalls(DRPC).length + w.logsCalls(BASE_ORG).length).toBe(0)
  })

  test('a range the upstream takes in one request stays on the upstream', async () => {
    const w = world(LOGS)
    const r = await getLogs(w, 1000, 1009)
    expect(r.result).toEqual(inOrder(1000, 1009))
    expect(w.logsCalls(ALCHEMY)).toEqual([{ method: 'eth_getLogs', from: 1000, to: 1009 }])
    // The first fallback only witnesses the hash of the range's last block.
    expect(w.providers[PUBLICNODE]!.calls).toEqual([{ method: 'eth_getBlockByNumber', block: 1009 }])
  })

  test('a 5000-block range goes to the provider that needs one request, before the ones that need three', async () => {
    const w = world(LOGS)
    const r = await getLogs(w, 1000, 5999)
    expect(r.result).toEqual(inOrder(1000, 5999))
    expect(w.logsCalls(DRPC)).toEqual([{ method: 'eth_getLogs', from: 1000, to: 5999 }])
    expect(w.logsCalls(PUBLICNODE).length).toBe(0)
  })

  test('a provider error falls through to the next provider, and the answer is the same', async () => {
    const w = world(LOGS)
    w.providers[PUBLICNODE]!.failAt = () => true
    const r = await getLogs(w, 1000, 1149)
    expect(r.result).toEqual(inOrder(1000, 1149))
    expect(w.logsCalls(PUBLICNODE).length).toBe(1)
    expect(w.logsCalls(DRPC)).toEqual([{ method: 'eth_getLogs', from: 1000, to: 1149 }])
  })

  test('a provider that fails midway through a chunked range is dropped whole: the next one reads the whole range, no gaps, no duplicates', async () => {
    const w = world(LOGS)
    w.providers[DRPC]!.down = true
    // publicnode serves [1000,2999] and [5000,5999] but refuses the middle chunk.
    w.providers[PUBLICNODE]!.failAt = (from) => from === 3000
    const r = await getLogs(w, 1000, 5999)
    expect(r.result).toEqual(inOrder(1000, 5999))
    expect(new Set(r.result!.map((l) => l.data)).size).toBe(r.result!.length)
    expect(w.logsCalls(PUBLICNODE).length).toBe(3)
    expect(w.logsCalls(BASE_ORG).map((c) => [c.from, c.to])).toEqual([[1000, 2999], [3000, 4999], [5000, 5999]])
    // One check for the whole range, on the provider that served it, at the range's last block.
    expect(w.blockCalls(BASE_ORG)).toEqual([5999])
    expect(w.blockCalls(PUBLICNODE)).toEqual([])
  })

  test('with every fallback refusing the range the upstream serves it in 10-block chunks, merged in block and log order', async () => {
    const w = world(LOGS)
    for (const url of FALLBACKS) w.providers[url]!.failAt = () => true
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-rpc-logs-'))
    dirs.push(dir)
    const metrics = new RpcMetrics(dir)
    const r = await getLogs(w, 1000, 1149, metrics)
    expect(r.result).toEqual(inOrder(1000, 1149))
    expect(r.result!.map((l) => [Number(l.blockNumber), Number(l.logIndex)])).toEqual([[1005, 0], [1005, 2], [1017, 1], [1100, 0], [1149, 3]])
    const calls = w.logsCalls(ALCHEMY)
    expect(calls.length).toBe(15)
    expect(calls.every((c) => c.to! - c.from! + 1 <= 10)).toBe(true)
    const snap = metrics.snapshot()
    const counted = snap.cumulative['alchemy.com']!.eth_getLogs!
    expect(counted.requests).toBe(15)
    expect(counted.getLogsChunks).toBe(15)
    // Each fallback was asked for the logs, failed, and was left behind; the first one then witnessed the upstream's range.
    const publicnode = snap.cumulative['publicnode.com']!
    expect(publicnode.eth_getLogs!.requests).toBe(1)
    expect(publicnode.eth_getLogs!.fallbacks).toBe(1)
    expect(snap.logRanges).toEqual({
      'publicnode.com': { accepted: 0, no_witness: 0, hash_mismatch: 0, provider_error: 1 },
      'drpc.org': { accepted: 0, no_witness: 0, hash_mismatch: 0, provider_error: 1 },
      'base.org': { accepted: 0, no_witness: 0, hash_mismatch: 0, provider_error: 1 },
      'alchemy.com': { accepted: 1, no_witness: 0, hash_mismatch: 0, provider_error: 0 },
    })
  })

  test('when no provider answers, the caller gets a JSON-RPC error, not an empty list', async () => {
    const w = world(LOGS)
    for (const p of Object.values(w.providers)) p.down = true
    const r = await getLogs(w, 1000, 1149)
    expect(r.result).toBeUndefined()
    expect(r.error!.code).toBe(-32603)
  })
})

describe('a log range needs an independent witness', () => {
  test('logs from a fallback: the fallback and the upstream are asked directly for the last block, after the read, and agree', async () => {
    const w = world(LOGS)
    const r = await getLogs(w, 1000, 1149)
    expect(r.result).toEqual(inOrder(1000, 1149))
    expect(w.providers[PUBLICNODE]!.calls).toEqual([{ method: 'eth_getLogs', from: 1000, to: 1149 }, { method: 'eth_getBlockByNumber', block: 1149 }])
    expect(w.providers[ALCHEMY]!.calls).toEqual([{ method: 'eth_getBlockByNumber', block: 1149 }])
    expect(w.providers[DRPC]!.calls.length + w.providers[BASE_ORG]!.calls.length).toBe(0)
  })

  test('a provider 3 blocks behind answers with an incomplete range: rejected, the next provider serves it', async () => {
    const w = world(LOGS)
    w.providers[PUBLICNODE]!.head = 1146
    const r = await getLogs(w, 1000, 1149)
    // publicnode answered successfully, without the log of block 1149.
    expect(w.logsCalls(PUBLICNODE).length).toBe(1)
    expect(r.result).toEqual(inOrder(1000, 1149))
    expect(r.result!.some((l) => Number(l.blockNumber) === 1149)).toBe(true)
    expect(w.logsCalls(DRPC).length).toBe(1)
  })

  test('nothing about a provider is remembered between requests: it is checked again on every range', async () => {
    const w = world(LOGS)
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, fallbacks: FALLBACKS, logRanges: {} })
    const ask = async (to: number) =>
      ((await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: hex(1000), toBlock: hex(to) }] }) })).json()) as Answer).result
    try {
      expect(await ask(1149)).toEqual(inOrder(1000, 1149))
      // The same provider now answers from a node that is behind.
      w.providers[PUBLICNODE]!.head = 1090
      expect(await ask(1149)).toEqual(inOrder(1000, 1149))
      expect(await ask(1100)).toEqual(inOrder(1000, 1100))
    } finally {
      proxy.stop()
    }
    expect(w.blockCalls(PUBLICNODE)).toEqual([1149, 1149, 1100])
    // The witness is asked again for the same block on the next request.
    expect(w.blockCalls(ALCHEMY)).toEqual([1149, 1149, 1100])
    expect(w.logsCalls(DRPC).length).toBe(2)
    expect(w.providers[PUBLICNODE]!.calls.some((c) => c.method === 'eth_blockNumber')).toBe(false)
  })

  test('ranges of one request that end at the same block share one witness answer; the next request asks again', async () => {
    const w = world(LOGS)
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, fallbacks: FALLBACKS, logRanges: {} })
    const range = (id: number, from: number) => ({ jsonrpc: '2.0', id, method: 'eth_getLogs', params: [{ fromBlock: hex(from), toBlock: hex(1149) }] })
    try {
      // A first range fills the memo of this request; the other two end at the same block.
      const batch = [range(1, 1000), range(2, 1020), range(3, 1100)]
      const first = (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify(batch) })).json()) as Answer[]
      expect(first.map((r) => r.result!.length)).toEqual([5, 2, 2])
      expect(w.blockCalls(PUBLICNODE)).toEqual([1149, 1149, 1149])
      expect(w.blockCalls(ALCHEMY).length).toBeLessThanOrEqual(3)
      const before = w.blockCalls(ALCHEMY).length
      await fetch(proxy.url, { method: 'POST', body: JSON.stringify(range(4, 1000)) })
      expect(w.blockCalls(ALCHEMY).length).toBe(before + 1)
    } finally {
      proxy.stop()
    }
  })

  test('a provider on another fork has another hash at the end of the range: rejected, its logs never reach the caller', async () => {
    const w = world(LOGS)
    w.providers[PUBLICNODE]!.forkFrom = 1140
    w.providers[PUBLICNODE]!.forkLogs = [log(1145, 9)]
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-rpc-logs-'))
    dirs.push(dir)
    const metrics = new RpcMetrics(dir)
    const r = await getLogs(w, 1000, 1149, metrics)
    expect(w.logsCalls(PUBLICNODE).length).toBe(1)
    expect(r.result).toEqual(inOrder(1000, 1149))
    expect(r.result!.some((l) => Number(l.blockNumber) === 1145)).toBe(false)
    expect(metrics.snapshot().logRanges['publicnode.com']).toEqual({ accepted: 0, no_witness: 0, hash_mismatch: 1, provider_error: 0 })
    expect(metrics.snapshot().logRanges['drpc.org']!.accepted).toBe(1)
  })

  test('logs from an upstream node that is behind on a stale block: the witness disagrees, rejected; a fallback serves and the upstream witnesses', async () => {
    const w = world(LOGS)
    // The range fits the upstream in one request. A stale node of the upstream serves the logs and the block read
    // that follows; its healthy node answers afterwards.
    let stale = 2
    const upstream = w.providers[ALCHEMY]!
    Object.defineProperty(upstream, 'forkFrom', { get: () => (stale-- > 0 ? 1148 : undefined) })
    upstream.forkLogs = []
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, fallbacks: [PUBLICNODE, BASE_ORG], logRanges: {} })
    try {
      const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: hex(1145), toBlock: hex(1149) }] }) })
      // The stale node had no log at 1149; the answer has it.
      expect(((await res.json()) as Answer).result).toEqual(inOrder(1145, 1149))
    } finally {
      proxy.stop()
    }
    expect(w.providers[ALCHEMY]!.calls).toEqual([
      { method: 'eth_getLogs', from: 1145, to: 1149 },
      { method: 'eth_getBlockByNumber', block: 1149 },
      // As the witness of publicnode's range.
      { method: 'eth_getBlockByNumber', block: 1149 },
    ])
    expect(w.logsCalls(PUBLICNODE)).toEqual([{ method: 'eth_getLogs', from: 1145, to: 1149 }])
  })

  test('the upstream is never its own witness: with no other provider answering, its range is rejected', async () => {
    const w = world(LOGS)
    for (const url of FALLBACKS) w.providers[url]!.down = true
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-rpc-logs-'))
    dirs.push(dir)
    const metrics = new RpcMetrics(dir)
    // The upstream has the block and would agree with itself.
    const r = await getLogs(w, 1000, 1009, metrics)
    expect(r.result).toBeUndefined()
    expect(r.error!.message).toContain('witness')
    expect(w.logsCalls(ALCHEMY).length).toBe(2)
    expect(metrics.snapshot().logRanges['alchemy.com']).toEqual({ accepted: 0, no_witness: 2, hash_mismatch: 0, provider_error: 0 })
    expect(metrics.snapshot().logRanges['publicnode.com']!.provider_error).toBe(2)
  })

  test('a witness that does not have the block yet is skipped: the next one decides', async () => {
    const w = world(LOGS)
    w.providers[PUBLICNODE]!.head = 1005
    const r = await getLogs(w, 1000, 1009)
    expect(r.result).toEqual(inOrder(1000, 1009))
    expect(w.logsCalls(ALCHEMY).length).toBe(1)
    expect(w.blockCalls(PUBLICNODE)).toEqual([1009])
    expect(w.blockCalls(DRPC)).toEqual([1009])
    expect(w.blockCalls(BASE_ORG)).toEqual([])
  })

  test('the first witness that has the block decides: a disagreement is not put to a vote', async () => {
    const w = world(LOGS)
    w.providers[PUBLICNODE]!.forkFrom = 1005
    const r = await getLogs(w, 1000, 1009)
    // The upstream is rejected against publicnode; publicnode against the upstream; drpc agrees with the upstream.
    expect(r.result).toEqual(inOrder(1000, 1009))
    expect(w.logsCalls(DRPC).length).toBe(1)
    expect(w.blockCalls(BASE_ORG)).toEqual([])
  })

  test('every provider fails the check: an error, never a short list', async () => {
    const w = world(LOGS)
    for (const url of FALLBACKS) w.providers[url]!.head = 1146
    w.providers[ALCHEMY]!.head = 1146
    const r = await getLogs(w, 1000, 1149)
    expect(r.result).toBeUndefined()
    expect(r.error!.message).toContain('1149')
  })

  test('a loopback upstream (a fork) is one node and has no witness by construction: its own block is the check', async () => {
    const w = world(LOGS)
    w.providers['http://127.0.0.1:9/'] = { limit: 1_000_000, head: 1100, calls: [] }
    const proxy = startRpcProxy('http://127.0.0.1:9/', { fetch: w.fetch })
    const ask = async (to: number) => (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: hex(1000), toBlock: hex(to) }] }) })).json()) as Answer
    try {
      expect((await ask(1100)).result).toEqual(inOrder(1000, 1100))
      expect((await ask(1149)).error).toBeDefined()
    } finally {
      proxy.stop()
    }
  })

  test('a remote upstream with no fallback cannot be witnessed: eth_getLogs is refused without reading anything', async () => {
    const w = world(LOGS)
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-rpc-logs-'))
    dirs.push(dir)
    const metrics = new RpcMetrics(dir)
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, fallbacks: [], logRanges: {}, metrics })
    try {
      const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: hex(1000), toBlock: hex(1009) }] }) })
      const r = (await res.json()) as Answer
      expect(r.result).toBeUndefined()
      expect(r.error!.message).toContain('MAMORU_RPC_FALLBACKS')
      // Every other call still works.
      const head = (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: [hex(1009), false] }) })).json()) as { result: { number: string } }
      expect(head.result.number).toBe(hex(1009))
    } finally {
      proxy.stop()
    }
    expect(w.logsCalls(ALCHEMY).length).toBe(0)
    expect(metrics.snapshot().logRanges['alchemy.com']).toEqual({ accepted: 0, no_witness: 1, hash_mismatch: 0, provider_error: 0 })
  })
})

describe('log range per provider', () => {
  test('the table: Alchemy free 10, publicnode and mainnet.base.org 2000, drpc 10000, anything else unlimited', () => {
    expect(logRangeOf(ALCHEMY)).toBe(10)
    expect(logRangeOf(PUBLICNODE)).toBe(2_000)
    expect(logRangeOf(BASE_ORG)).toBe(2_000)
    expect(logRangeOf(DRPC)).toBe(10_000)
    expect(logRangeOf('http://127.0.0.1:8545/')).toBe(Number.POSITIVE_INFINITY)
    expect(logRangeOf('https://notalchemy.com.example/rpc')).toBe(Number.POSITIVE_INFINITY)
  })

  test('MAMORU_LOG_RANGES, read when the proxy starts, overrides and extends the table', async () => {
    expect(logRangesFromEnv({ MAMORU_LOG_RANGES: 'publicnode.com=500, rpc.example=50,broken=x' })).toEqual({ 'publicnode.com': 500, 'rpc.example': 50 })
    expect(logRangeOf(PUBLICNODE, { 'publicnode.com': 500 })).toBe(500)
    const saved = process.env.MAMORU_LOG_RANGES
    process.env.MAMORU_LOG_RANGES = 'publicnode.com=100'
    const w = world(LOGS)
    w.providers[DRPC]!.down = true
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, fallbacks: FALLBACKS })
    try {
      const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: hex(1000), toBlock: hex(1149) }] }) })
      expect(((await res.json()) as Answer).result).toEqual(inOrder(1000, 1149))
    } finally {
      proxy.stop()
      if (saved === undefined) delete process.env.MAMORU_LOG_RANGES
      else process.env.MAMORU_LOG_RANGES = saved
    }
    // drpc and mainnet.base.org need one request, publicnode two at 100 blocks: drpc is down, so mainnet.base.org serves it.
    expect(w.logsCalls(BASE_ORG).length).toBe(1)
    expect(w.logsCalls(PUBLICNODE).length).toBe(0)
  })
})

describe('a witness must be another operator, not another URL', () => {
  test('sameOperator ignores scheme, port, path, key and subdomain', async () => {
    const { sameOperator } = await import('../src/rpc-proxy.ts')
    expect(sameOperator('https://base-mainnet.g.alchemy.com/v2/keyA', 'https://base-mainnet.g.alchemy.com/v2/keyB')).toBe(true)
    expect(sameOperator('https://base-mainnet.g.alchemy.com/v2/keyA', 'http://eth-mainnet.g.alchemy.com:8443/v2/keyA/')).toBe(true)
    expect(sameOperator('https://base-mainnet.g.alchemy.com/v2/keyA', 'https://BASE-MAINNET.G.ALCHEMY.COM/v2/keyA')).toBe(true)
    expect(sameOperator('https://base-mainnet.g.alchemy.com/v2/keyA', 'https://base-rpc.publicnode.com')).toBe(false)
    expect(sameOperator('http://127.0.0.1:8545', 'http://127.0.0.1:9545/')).toBe(true)
    expect(sameOperator('https://cloudflare-eth.com', 'https://cloudflare-eth.com.')).toBe(true)
    expect(sameOperator('https://base-rpc.publicnode.com.', 'https://Base-RPC.PublicNode.com')).toBe(true)
    expect(sameOperator('https://a.example.co.uk', 'https://b.example.co.uk.')).toBe(true)
    expect(sameOperator('https://a.example.co.uk', 'https://a.other.co.uk')).toBe(false)
  })

  test('a second key of the upstream provider is not a witness: eth_getLogs is refused and nothing is read', async () => {
    const w = world(LOGS)
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-rpc-logs-'))
    dirs.push(dir)
    const metrics = new RpcMetrics(dir)
    const otherKey = `${new URL(ALCHEMY).origin}/v2/another-key`
    const respelled = `${ALCHEMY.replace(/\/$/, '')}/`
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, fallbacks: [otherKey, respelled], logRanges: {}, metrics })
    try {
      const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: hex(1000), toBlock: hex(1009) }] }) })
      const r = (await res.json()) as Answer
      expect(r.result).toBeUndefined()
      expect(r.error!.message).toContain('another operator')
    } finally {
      proxy.stop()
    }
    expect(w.logsCalls(ALCHEMY).length).toBe(0)
    expect(metrics.snapshot().logRanges['alchemy.com#1']).toEqual({ accepted: 0, no_witness: 1, hash_mismatch: 0, provider_error: 0 })
  })
})
