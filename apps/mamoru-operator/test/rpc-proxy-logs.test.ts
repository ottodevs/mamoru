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
type Provider = { limit: number; head: number; down?: boolean; failAt?: (from: number, to: number) => boolean; calls: { method: string; from?: number; to?: number }[] }

const hex = (n: number) => `0x${n.toString(16)}`
const log = (block: number, index: number): Log => ({ blockNumber: hex(block), logIndex: hex(index), data: `0x${block.toString(16)}${index}` })

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
    const body = JSON.parse(String(init.body))
    const answer = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result })
    const refuse = (code: number, message: string, status = 200) => Response.json({ jsonrpc: '2.0', id: body.id, error: { code, message } }, { status })
    if (body.method === 'eth_blockNumber') {
      p.calls.push({ method: body.method })
      return p.down ? refuse(-32603, 'service unavailable', 503) : answer(hex(p.head))
    }
    const [from, to] = [Number(body.params[0].fromBlock), Number(body.params[0].toBlock)]
    p.calls.push({ method: body.method, from, to })
    if (p.down) return refuse(-32603, 'service unavailable', 503)
    if (to - from + 1 > p.limit) return refuse(-32602, `query exceeds max block range ${p.limit}`)
    if (p.failAt?.(from, to)) return refuse(-32000, 'Archive requests require a personal token')
    return answer(logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to))
  }
  const logsCalls = (url: string) => providers[url]!.calls.filter((c) => c.method === 'eth_getLogs')
  return { providers, fetch, logsCalls }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function getLogs(w: ReturnType<typeof world>, from: number, to: number, metrics?: RpcMetrics): Promise<{ result?: Log[]; error?: { code: number; message: string } }> {
  const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, fallbacks: FALLBACKS, logRanges: {}, metrics })
  try {
    const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: '0x01', fromBlock: hex(from), toBlock: hex(to) }] }) })
    return (await res.json()) as { result?: Log[]; error?: { code: number; message: string } }
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
    expect(w.providers[PUBLICNODE]!.calls.length).toBe(0)
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

  test('a provider that fails one chunk of several is dropped whole: no partial or doubled logs', async () => {
    const w = world(LOGS)
    w.providers[DRPC]!.down = true
    // publicnode serves [1000,2999] and [5000,5999] but refuses the middle chunk.
    w.providers[PUBLICNODE]!.failAt = (from) => from === 3000
    const r = await getLogs(w, 1000, 5999)
    expect(r.result).toEqual(inOrder(1000, 5999))
    expect(w.logsCalls(PUBLICNODE).length).toBe(3)
    expect(w.logsCalls(BASE_ORG).map((c) => [c.from, c.to])).toEqual([[1000, 2999], [3000, 4999], [5000, 5999]])
  })

  test('with every fallback down the upstream serves the range in 10-block chunks, merged in block and log order', async () => {
    const w = world(LOGS)
    for (const url of FALLBACKS) w.providers[url]!.down = true
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-rpc-logs-'))
    dirs.push(dir)
    const metrics = new RpcMetrics(dir)
    const r = await getLogs(w, 1000, 1149, metrics)
    expect(r.result).toEqual(inOrder(1000, 1149))
    expect(r.result!.map((l) => [Number(l.blockNumber), Number(l.logIndex)])).toEqual([[1005, 0], [1005, 2], [1017, 1], [1100, 0], [1149, 3]])
    const calls = w.logsCalls(ALCHEMY)
    expect(calls.length).toBe(15)
    expect(calls.every((c) => c.to! - c.from! + 1 <= 10)).toBe(true)
    const counted = metrics.snapshot().cumulative['alchemy.com']!.eth_getLogs!
    expect(counted.requests).toBe(15)
    expect(counted.getLogsChunks).toBe(15)
    // Each fallback was asked for its head, failed, and was left behind: no eth_getLogs reached it.
    const publicnode = metrics.snapshot().cumulative['publicnode.com']!
    expect(publicnode.eth_getLogs!.requests).toBe(0)
    expect(publicnode.eth_getLogs!.fallbacks).toBe(1)
    expect(publicnode.eth_blockNumber!.requests).toBe(1)
  })

  test('a fallback whose head has not reached the range end is skipped: it could answer with logs missing', async () => {
    const w = world(LOGS)
    w.providers[PUBLICNODE]!.head = 1100
    const r = await getLogs(w, 1000, 1149)
    expect(r.result).toEqual(inOrder(1000, 1149))
    expect(w.logsCalls(PUBLICNODE).length).toBe(0)
    expect(w.logsCalls(DRPC).length).toBe(1)
  })

  test('the head of a fallback is asked once while it covers the ranges', async () => {
    const w = world(LOGS)
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, fallbacks: FALLBACKS, logRanges: {} })
    try {
      for (const to of [1149, 1100, 1149]) {
        await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: hex(1000), toBlock: hex(to) }] }) })
      }
    } finally {
      proxy.stop()
    }
    expect(w.providers[PUBLICNODE]!.calls.filter((c) => c.method === 'eth_blockNumber').length).toBe(1)
    expect(w.logsCalls(PUBLICNODE).length).toBe(3)
  })

  test('when no provider answers, the caller gets a JSON-RPC error, not an empty list', async () => {
    const w = world(LOGS)
    for (const p of Object.values(w.providers)) p.down = true
    const r = await getLogs(w, 1000, 1149)
    expect(r.result).toBeUndefined()
    expect(r.error!.code).toBe(-32603)
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
      expect(((await res.json()) as { result: Log[] }).result).toEqual(inOrder(1000, 1149))
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
