import { afterEach, describe, expect, test } from 'bun:test'
import { BASE_PUBLIC_FALLBACKS, chainIdOf, fallbacksFromEnv, L1_PUBLIC_FALLBACKS, MONAD_PUBLIC_FALLBACKS, startRpcProxy, trustedFromEnv } from '../src/rpc-proxy.ts'

const PRIMARY = 'https://base-mainnet.g.alchemy.com/v2/test-key'
const saved = process.env.MAMORU_RPC_FALLBACKS
const savedTrusted = process.env.MAMORU_RPC_TRUSTED

afterEach(() => {
  if (saved === undefined) delete process.env.MAMORU_RPC_FALLBACKS
  else process.env.MAMORU_RPC_FALLBACKS = saved
  if (savedTrusted === undefined) delete process.env.MAMORU_RPC_TRUSTED
  else process.env.MAMORU_RPC_TRUSTED = savedTrusted
})

/** Upstream transport: the primary refuses with 429, every other URL answers; records the URLs called. */
function fakeFetch() {
  const calls: string[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push(url)
    const body = JSON.parse(String(init.body))
    if (url === PRIMARY) return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: 429, message: 'Monthly capacity limit exceeded' } }, { status: 429 })
    return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x2105' })
  }
  return { fetch, calls }
}

async function chainId(proxyUrl: string): Promise<unknown> {
  const res = await fetch(proxyUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
  return ((await res.json()) as { result?: unknown }).result
}

describe('rpc proxy configuration', () => {
  test('MAMORU_RPC_TRUSTED set after the module was imported is the list a decision read falls back to', async () => {
    // main.ts loads the env file in its body, after this module was evaluated.
    process.env.MAMORU_RPC_FALLBACKS = 'https://fallback-a.example/rpc, https://fallback-b.example/rpc'
    process.env.MAMORU_RPC_TRUSTED = 'https://trusted.example/rpc'
    const up = fakeFetch()
    const proxy = startRpcProxy(PRIMARY, { fetch: up.fetch })
    try {
      expect(await chainId(proxy.url)).toBe('0x2105')
    } finally {
      proxy.stop()
    }
    expect(up.calls).toEqual([PRIMARY, 'https://trusted.example/rpc'])
  })

  test('a decision read never falls back to MAMORU_RPC_FALLBACKS: with no trusted provider left it fails', async () => {
    process.env.MAMORU_RPC_FALLBACKS = 'https://fallback-a.example/rpc'
    delete process.env.MAMORU_RPC_TRUSTED
    const up = fakeFetch()
    const proxy = startRpcProxy(PRIMARY, { fetch: up.fetch })
    let answer: { result?: unknown; error?: { code: number } }
    try {
      answer = (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, 'latest'] }) })).json()) as typeof answer
    } finally {
      proxy.stop()
    }
    expect(answer.result).toBeUndefined()
    expect(answer.error?.code).toBe(429)
    expect(up.calls.every((u) => u === PRIMARY)).toBe(true)
  })

  test('trustedFromEnv: comma separated, blanks dropped, unset is none', () => {
    expect(trustedFromEnv({})).toEqual([])
    expect(trustedFromEnv({ MAMORU_RPC_TRUSTED: ' https://a.example/x , ,https://b.example/y ' })).toEqual(['https://a.example/x', 'https://b.example/y'])
  })

  test('without the variable the public list of the proxy chain applies (otto/mamoru#261)', () => {
    const list = (s: string) => s.split(',')
    expect(fallbacksFromEnv({}, 8453)).toEqual(['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'])
    expect(fallbacksFromEnv({}, 8453)).toEqual(list(BASE_PUBLIC_FALLBACKS))
    expect(fallbacksFromEnv({}, 143)).toEqual(list(MONAD_PUBLIC_FALLBACKS))
    expect(fallbacksFromEnv({}, 1)).toEqual(list(L1_PUBLIC_FALLBACKS))
    // Another chain's RPCs are never a default: an unlisted chain, or none known, gets no public fallback.
    expect(fallbacksFromEnv({}, 31337)).toEqual([])
    expect(fallbacksFromEnv({})).toEqual([])
    expect(fallbacksFromEnv({ MAMORU_RPC_FALLBACKS: '' }, 8453)).toEqual([])
    expect(fallbacksFromEnv({ MAMORU_RPC_FALLBACKS: 'https://x.example/rpc' }, 143)).toEqual(['https://x.example/rpc'])
  })

  test('chainIdOf: the first RPC that answers names the chain; none answering is null', async () => {
    const send = (answers: Record<string, unknown>) => async (url: string) => {
      const a = answers[url]
      if (a instanceof Error) throw a
      return Response.json(a)
    }
    expect(await chainIdOf(['https://a', 'https://b'], send({ 'https://a': { result: '0x8f' }, 'https://b': { result: '0x2105' } }))).toBe(143)
    expect(await chainIdOf(['https://a', 'https://b'], send({ 'https://a': new Error('down'), 'https://b': { result: '0x2105' } }))).toBe(8453)
    expect(await chainIdOf(['https://a'], send({ 'https://a': { error: { code: 429 } } }))).toBeNull()
    expect(await chainIdOf([], send({}))).toBeNull()
  })

  test('with a chain id and no MAMORU_RPC_FALLBACKS, a log read falls back only to that chain\'s public RPCs', async () => {
    delete process.env.MAMORU_RPC_FALLBACKS
    delete process.env.MAMORU_RPC_TRUSTED
    const calls: string[] = []
    const upstream = async (url: string, init: RequestInit) => {
      calls.push(url)
      const body = JSON.parse(String(init.body))
      if (body.method === 'eth_chainId') return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x8f' })
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: 429, message: 'request limit reached' } }, { status: 429 })
    }
    const proxy = startRpcProxy('https://monad-primary.example/rpc', { fetch: upstream, chainId: 143, providerTimeoutMs: 1_000 })
    try {
      await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] }) }).catch(() => null)
    } finally {
      proxy.stop()
    }
    const monad = new Set(['https://monad-primary.example/rpc', ...MONAD_PUBLIC_FALLBACKS.split(',')])
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((u) => monad.has(u))).toBe(true)
  })

  test('a loopback upstream (anvil) never falls back to a remote provider', async () => {
    process.env.MAMORU_RPC_FALLBACKS = 'https://fallback-a.example/rpc'
    const calls: string[] = []
    const proxy = startRpcProxy('http://127.0.0.1:9/', {
      fetch: async (url, init) => {
        calls.push(url)
        return Response.json({ jsonrpc: '2.0', id: JSON.parse(String(init.body)).id, error: { code: 429, message: 'rate limit' } }, { status: 429 })
      },
    })
    try {
      await chainId(proxy.url)
    } finally {
      proxy.stop()
    }
    expect(new Set(calls)).toEqual(new Set(['http://127.0.0.1:9/']))
  })
})
