import { afterEach, describe, expect, test } from 'bun:test'
import { fallbacksFromEnv, startRpcProxy } from '../src/rpc-proxy.ts'

const PRIMARY = 'https://base-mainnet.g.alchemy.com/v2/test-key'
const saved = process.env.MAMORU_RPC_FALLBACKS

afterEach(() => {
  if (saved === undefined) delete process.env.MAMORU_RPC_FALLBACKS
  else process.env.MAMORU_RPC_FALLBACKS = saved
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
  test('MAMORU_RPC_FALLBACKS set after the module was imported is the list the proxy uses', async () => {
    // main.ts loads the env file in its body, after this module was evaluated.
    process.env.MAMORU_RPC_FALLBACKS = 'https://fallback-a.example/rpc, https://fallback-b.example/rpc'
    const up = fakeFetch()
    const proxy = startRpcProxy(PRIMARY, { fetch: up.fetch })
    try {
      expect(await chainId(proxy.url)).toBe('0x2105')
    } finally {
      proxy.stop()
    }
    expect(up.calls).toEqual([PRIMARY, 'https://fallback-a.example/rpc'])
  })

  test('without the variable the public default list applies', () => {
    expect(fallbacksFromEnv({})).toEqual(['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'])
    expect(fallbacksFromEnv({ MAMORU_RPC_FALLBACKS: '' })).toEqual([])
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
