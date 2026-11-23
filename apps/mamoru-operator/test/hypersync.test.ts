import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperSyncError, hypersyncFromEnv, hypersyncLogs, MinuteLimiter, rpmFromEnv, sameLogs, selectionOf, toRpcLog, type HyperSyncConfig } from '../src/hypersync.ts'
import { RpcMetrics } from '../src/metrics.ts'
import { HYPERSYNC_LABEL, startRpcProxy } from '../src/rpc-proxy.ts'

// A fake token: never a real one in a test.
const TOKEN = 'test-token-not-real'
const HS = 'https://8453.hypersync.xyz'
const UPSTREAM = 'https://base.rpc-upstream.test/k'
const WITNESS = 'https://base-rpc.publicnode.com'
const ADDR = '0x00000000000000000000000000000000000000aa'
const TOPIC = `0x${'dd'.repeat(32)}`

const hex = (n: number) => `0x${n.toString(16)}`
const blockHash = (n: number) => `0x${'b'.repeat(8)}${n.toString(16).padStart(56, '0')}`
type Chain = { block: number; index: number; data?: string }
/** A log as eth_getLogs answers it. */
const rpcLog = (l: Chain) => ({
  address: ADDR,
  topics: [TOPIC],
  data: l.data ?? `0x${l.block.toString(16)}`,
  blockNumber: hex(l.block),
  blockHash: blockHash(l.block),
  transactionHash: `0x${'c'.repeat(56)}${l.block.toString(16).padStart(8, '0')}`,
  transactionIndex: '0x0',
  logIndex: hex(l.index),
  removed: false,
})
/** The same log as HyperSync answers it (numbers as numbers, topics apart). */
const hsLog = (l: Chain) => {
  const r = rpcLog(l)
  return { address: r.address, data: r.data, block_number: l.block, block_hash: r.blockHash, transaction_hash: r.transactionHash, transaction_index: 0, log_index: l.index, topic0: TOPIC, topic1: null, topic2: null, topic3: null, removed: false }
}

type HsAnswer = (body: any) => Response | Promise<Response>
/** HyperSync over `logs`, `page` blocks per answer, archive up to `archive`; `override` answers a request instead. */
function hyperWorld(logs: Chain[], o: { page?: number; archive?: number; override?: HsAnswer } = {}) {
  const bodies: any[] = []
  const headers: Record<string, string>[] = []
  const fetch = async (url: string, init: RequestInit) => {
    expect(url).toBe(`${HS}/query`)
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    headers.push(init.headers as Record<string, string>)
    if (o.override) return o.override(body)
    const archive = o.archive ?? 1_000_000
    const end = Math.min(body.to_block, body.from_block + (o.page ?? 1_000_000), archive + 1)
    const rows = logs.filter((l) => l.block >= body.from_block && l.block < end).map(hsLog)
    return Response.json({ data: [{ logs: rows }], archive_height: archive, next_block: end, total_execution_time: 1 })
  }
  return { fetch, bodies, headers }
}

const cfg = (fetch: (u: string, i: RequestInit) => Promise<Response>, limiter = new MinuteLimiter(100)): HyperSyncConfig => ({ url: HS, token: TOKEN, limiter, fetch })

describe('HyperSync client', () => {
  test('to_block is sent exclusive for an inclusive eth_getLogs range, and logs come back in the eth_getLogs shape', async () => {
    const w = hyperWorld([{ block: 100, index: 1 }, { block: 100, index: 0 }, { block: 150, index: 2 }, { block: 201, index: 0 }])
    const r = await hypersyncLogs(cfg(w.fetch), { address: ADDR, topics: [TOPIC] }, 100n, 200n)
    expect(w.bodies[0].from_block).toBe(100)
    expect(w.bodies[0].to_block).toBe(201)
    expect(w.bodies[0].logs).toEqual([{ address: [ADDR], topics: [[TOPIC]] }])
    expect(w.headers[0]!.authorization).toBe(`Bearer ${TOKEN}`)
    expect(r.covered).toBe(200n)
    expect(r.logs).toEqual([rpcLog({ block: 100, index: 0 }), rpcLog({ block: 100, index: 1 }), rpcLog({ block: 150, index: 2 })])
  })

  test('pages follow next_block until the range is covered', async () => {
    const logs = [{ block: 10, index: 0 }, { block: 45, index: 0 }, { block: 99, index: 3 }]
    const w = hyperWorld(logs, { page: 40 })
    const r = await hypersyncLogs(cfg(w.fetch), { address: ADDR }, 10n, 99n)
    expect(w.bodies.map((b) => b.from_block)).toEqual([10, 50, 90])
    expect(r.requests).toBe(3)
    expect(r.covered).toBe(99n)
    expect(r.logs).toEqual(logs.map(rpcLog))
  })

  test('the archive ending before the range stops the read there; covered says where', async () => {
    const w = hyperWorld([{ block: 10, index: 0 }, { block: 95, index: 0 }], { archive: 80 })
    const r = await hypersyncLogs(cfg(w.fetch), { address: ADDR }, 10n, 99n)
    expect(r.covered).toBe(80n)
    expect(r.logs).toEqual([rpcLog({ block: 10, index: 0 })])
    expect(w.bodies.length).toBe(1)
  })

  test('more pages than allowed is no answer', async () => {
    const w = hyperWorld([], { page: 10 })
    await expect(hypersyncLogs({ ...cfg(w.fetch), maxPages: 2 }, { address: ADDR }, 0n, 99n)).rejects.toBeInstanceOf(HyperSyncError)
  })

  test('429 pauses HyperSync for the time it gives, then the limiter refuses without sending', async () => {
    let t = 1_000_000
    const limiter = new MinuteLimiter(100)
    const w = hyperWorld([], { override: () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }) })
    const err = await hypersyncLogs(cfg(w.fetch, limiter), { address: ADDR }, 0n, 99n, { now: () => t }).catch((e) => e)
    expect(err).toBeInstanceOf(HyperSyncError)
    expect(err.kind).toBe('rate')
    expect(limiter.paused(t + 29_000)).toBe(true)
    expect(limiter.paused(t + 31_000)).toBe(false)
    t += 1_000
    await expect(hypersyncLogs(cfg(w.fetch, limiter), { address: ADDR }, 0n, 99n, { now: () => t })).rejects.toBeInstanceOf(HyperSyncError)
    expect(w.bodies.length).toBe(1)
  })

  test('a 5xx, a timeout and an unreadable answer are errors, never a partial list', async () => {
    for (const override of [() => new Response('bad', { status: 502 }), () => Response.json({ nothing: true }), () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))] as HsAnswer[]) {
      const w = hyperWorld([], { override })
      await expect(hypersyncLogs(cfg(w.fetch), { address: ADDR }, 0n, 99n)).rejects.toBeInstanceOf(HyperSyncError)
    }
  })

  test('the limiter allows rpm requests a sliding minute', () => {
    const l = new MinuteLimiter(2)
    expect([l.take(0), l.take(1), l.take(2)]).toEqual([true, true, false])
    expect(l.take(60_001)).toBe(true)
  })

  test('selection: null topic positions match anything, trailing ones are dropped; a filter that selects everything is none', () => {
    expect(selectionOf({ address: [ADDR.toUpperCase().replace('0X', '0x')], topics: [TOPIC, null, [TOPIC], null] })).toEqual({ address: [ADDR], topics: [[TOPIC], [], [TOPIC]] })
    expect(selectionOf({})).toBeNull()
    expect(selectionOf({ topics: [null] })).toBeNull()
    expect(selectionOf({ address: 'nope' })).toBeNull()
  })

  test('unset token, a chain without HyperSync or MAMORU_HYPERSYNC=off: disabled', () => {
    expect(hypersyncFromEnv(8453, {})).toBeNull()
    expect(hypersyncFromEnv(8453, { ENVIO_API_TOKEN: '  ' })).toBeNull()
    expect(hypersyncFromEnv(1, { ENVIO_API_TOKEN: TOKEN })).toBeNull()
    expect(hypersyncFromEnv(143, { ENVIO_API_TOKEN: TOKEN, MAMORU_HYPERSYNC: 'off' })).toBeNull()
    expect(hypersyncFromEnv(143, { ENVIO_API_TOKEN: TOKEN })?.url).toBe('https://143.hypersync.xyz')
    expect(rpmFromEnv({})).toBe(6)
    expect(rpmFromEnv({ MAMORU_HYPERSYNC_RPM: '3' })).toBe(3)
    expect(rpmFromEnv({ MAMORU_HYPERSYNC_RPM: 'x' })).toBe(6)
  })

  test('sameLogs compares every field, order aside', () => {
    const a = [rpcLog({ block: 1, index: 0 }), rpcLog({ block: 2, index: 0 })]
    expect(sameLogs(a, [...a].reverse())).toBe(true)
    expect(sameLogs(a, [a[0]!, rpcLog({ block: 2, index: 0, data: '0xff' })])).toBe(false)
    expect(sameLogs(a, [a[0]!])).toBe(false)
    expect(toRpcLog(hsLog({ block: 7, index: 1 }))).toEqual(rpcLog({ block: 7, index: 1 }))
  })
})

// ---- Through the RPC proxy ---------------------------------------------------------------------

/** Two RPC providers (upstream and a witness) over `logs`; HyperSync over `hsLogs` (default the same). */
function proxyWorld(logs: Chain[], o: { hsLogs?: Chain[]; archive?: number; override?: HsAnswer } = {}) {
  const hs = hyperWorld(o.hsLogs ?? logs, o)
  const rpcCalls: { url: string; from: number; to: number }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    if (url.startsWith(HS)) return hs.fetch(url, init)
    const body = JSON.parse(String(init.body))
    const answer = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result })
    if (body.method === 'eth_chainId') return answer('0x2105')
    if (body.method === 'eth_blockNumber') return answer(hex(10_000))
    if (body.method === 'eth_getBlockByNumber') return answer({ number: body.params[0], hash: blockHash(Number(body.params[0])) })
    const [from, to] = [Number(body.params[0].fromBlock), Number(body.params[0].toBlock)]
    rpcCalls.push({ url, from, to })
    return answer(logs.filter((l) => l.block >= from && l.block <= to).map(rpcLog))
  }
  return { fetch, hs, rpcCalls }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const newMetrics = () => {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-hs-'))
  dirs.push(d)
  return new RpcMetrics(d)
}

async function scan(w: ReturnType<typeof proxyWorld>, from: number, to: number, o: { hypersync?: HyperSyncConfig | null; metrics?: RpcMetrics } = {}) {
  const hypersync = o.hypersync === undefined ? cfg(w.fetch) : o.hypersync
  const proxy = startRpcProxy(UPSTREAM, { fetch: w.fetch, fallbacks: [WITNESS], logRanges: {}, chunkLogs: false, hypersync, hypersyncMinBlocks: 100, hypersyncSpotBlocks: 10, metrics: o.metrics })
  try {
    const res = await fetch(`${proxy.url}c/deposits`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: ADDR, topics: [TOPIC], fromBlock: hex(from), toBlock: hex(to) }] }) })
    return (await res.json()) as { result?: unknown[]; error?: unknown }
  } finally {
    proxy.stop()
  }
}

const LOGS: Chain[] = [{ block: 1_000, index: 0 }, { block: 3_000, index: 1 }, { block: 4_995, index: 0 }, { block: 4_999, index: 2 }]
const expected = (from: number, to: number) => LOGS.filter((l) => l.block >= from && l.block <= to).map(rpcLog)

describe('eth_getLogs through the proxy with HyperSync', () => {
  test('a wide range is one HyperSync request plus one RPC page over its last blocks', async () => {
    const w = proxyWorld(LOGS)
    const metrics = newMetrics()
    const r = await scan(w, 1_000, 4_999, { metrics })
    expect(r.result).toEqual(expected(1_000, 4_999))
    expect(w.hs.bodies.length).toBe(1)
    expect(w.rpcCalls).toEqual([{ url: UPSTREAM, from: 4_990, to: 4_999 }])
    const snap = metrics.snapshot()
    expect(snap.cumulative[HYPERSYNC_LABEL]?.eth_getLogs?.requests).toBe(1)
    expect(snap.logRanges[HYPERSYNC_LABEL]?.accepted).toBe(1)
    expect(snap.byComponent.cumulative.deposits?.eth_getLogs?.requests).toBeGreaterThanOrEqual(2)
  })

  test('a narrow range never asks HyperSync', async () => {
    const w = proxyWorld(LOGS)
    const r = await scan(w, 4_950, 4_999)
    expect(r.result).toEqual(expected(4_950, 4_999))
    expect(w.hs.bodies.length).toBe(0)
  })

  test('no HyperSync (unset token): the providers read the whole range, as before', async () => {
    const w = proxyWorld(LOGS)
    const r = await scan(w, 1_000, 4_999, { hypersync: null })
    expect(r.result).toEqual(expected(1_000, 4_999))
    expect(w.hs.bodies.length).toBe(0)
    expect(w.rpcCalls).toEqual([{ url: UPSTREAM, from: 1_000, to: 4_999 }])
  })

  test('HyperSync 429: the providers read the whole range and the error is counted', async () => {
    const w = proxyWorld(LOGS, { override: () => new Response('', { status: 429 }) })
    const metrics = newMetrics()
    const r = await scan(w, 1_000, 4_999, { metrics })
    expect(r.result).toEqual(expected(1_000, 4_999))
    expect(w.rpcCalls).toEqual([{ url: UPSTREAM, from: 1_000, to: 4_999 }])
    expect(metrics.snapshot().cumulative[HYPERSYNC_LABEL]?.eth_getLogs?.errors.rateCapacity).toBe(1)
  })

  test('the last blocks differ from the providers: warning, counted, and the providers answer the range', async () => {
    const w = proxyWorld(LOGS, { hsLogs: LOGS.filter((l) => l.block !== 4_995) })
    const metrics = newMetrics()
    const r = await scan(w, 1_000, 4_999, { metrics })
    expect(r.result).toEqual(expected(1_000, 4_999))
    expect(w.rpcCalls).toEqual([{ url: UPSTREAM, from: 4_990, to: 4_999 }, { url: UPSTREAM, from: 1_000, to: 4_989 }])
    expect(metrics.snapshot().logRanges[HYPERSYNC_LABEL]?.hash_mismatch).toBe(1)
  })

  test('HyperSync behind the range: the providers read what its archive does not have, from the spot blocks on', async () => {
    const w = proxyWorld(LOGS, { archive: 4_996 })
    const r = await scan(w, 1_000, 4_999)
    expect(r.result).toEqual(expected(1_000, 4_999))
    expect(w.rpcCalls).toEqual([{ url: UPSTREAM, from: 4_987, to: 4_999 }])
  })
})
