import { describe, expect, test } from 'bun:test'
import { L1_PUBLIC_FALLBACKS, MONAD_PUBLIC_FALLBACKS, startRpcProxy, urlsFromEnv } from '../src/rpc-proxy.ts'

// otto/mamoru#285: Ethereum and the Monad leg are never served by one RPC alone.
describe('per-chain pools (otto/mamoru#285)', () => {
  test('urlsFromEnv reads the named list, else the default; blanks dropped', () => {
    expect(urlsFromEnv('X', 'https://a,https://b', { X: ' https://c , ,https://d' })).toEqual(['https://c', 'https://d'])
    expect(urlsFromEnv('X', 'https://a,https://b', {})).toEqual(['https://a', 'https://b'])
    expect(urlsFromEnv('X', '', {})).toEqual([])
  })

  test('the public defaults are several distinct https hosts per chain, with no key in them', () => {
    for (const list of [L1_PUBLIC_FALLBACKS, MONAD_PUBLIC_FALLBACKS]) {
      const urls = list.split(',')
      expect(urls.length).toBeGreaterThanOrEqual(5)
      expect(new Set(urls.map((u) => new URL(u).host)).size).toBe(urls.length)
      for (const u of urls) {
        expect(u.startsWith('https://')).toBe(true)
        expect(u).not.toMatch(/key|token|demo/i)
      }
    }
  })

  test('a decision read fails over from the upstream to a trusted provider, never to a public one', async () => {
    const seen: string[] = []
    const proxy = startRpcProxy('https://upstream.example/k', {
      trusted: ['https://trusted.example/k'],
      fallbacks: ['https://public.example'],
      logRanges: {},
      chunkLogs: false,
      fetch: async (url: string) => {
        seen.push(new URL(url).host)
        if (url.startsWith('https://upstream')) return new Response('slow down', { status: 429 })
        return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' })
      },
    })
    try {
      const res = await fetch(`${proxy.url}c/bridge-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0x0000000000000000000000000000000000000001', 'latest'] }) })
      expect(((await res.json()) as { result: string }).result).toBe('0x1')
      expect(seen).toContain('trusted.example')
      expect(seen).not.toContain('public.example')
    } finally {
      proxy.stop()
    }
  })

  test('a send may go to a public provider when the upstream and trusted refuse', async () => {
    const seen: string[] = []
    const proxy = startRpcProxy('https://upstream.example/k', {
      trusted: [],
      fallbacks: ['https://public.example'],
      logRanges: {},
      chunkLogs: false,
      fetch: async (url: string) => {
        seen.push(new URL(url).host)
        if (url.startsWith('https://upstream')) return new Response('down', { status: 503 })
        return Response.json({ jsonrpc: '2.0', id: 1, result: `0x${'ab'.repeat(32)}` })
      },
    })
    try {
      const res = await fetch(`${proxy.url}c/bridge-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x02'] }) })
      expect(((await res.json()) as { result: string }).result).toBe(`0x${'ab'.repeat(32)}`)
      expect(seen).toContain('public.example')
    } finally {
      proxy.stop()
    }
  })

  test('with trustedLogsOnly a public provider never serves eth_getLogs, it only witnesses', async () => {
    const served: string[] = []
    const hash = `0x${'11'.repeat(32)}`
    const proxy = startRpcProxy('https://upstream.example/k', {
      trusted: [],
      fallbacks: ['https://public.example'],
      logRanges: {},
      chunkLogs: false,
      trustedLogsOnly: true,
      fetch: async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        const one = (b: { method: string; id: number }) => {
          if (b.method === 'eth_getLogs') served.push(new URL(url).host)
          if (url.startsWith('https://upstream') && b.method === 'eth_getLogs') return { jsonrpc: '2.0', id: b.id, error: { code: -32005, message: 'limit exceeded' } }
          if (b.method === 'eth_getLogs') return { jsonrpc: '2.0', id: b.id, result: [] }
          if (b.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: b.id, result: '0x100' }
          return { jsonrpc: '2.0', id: b.id, result: { hash, number: '0x100' } }
        }
        return Response.json(Array.isArray(body) ? body.map(one) : one(body))
      },
    })
    try {
      const res = await fetch(`${proxy.url}c/bridge-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0xf0', toBlock: '0x100' }] }) })
      const out = (await res.json()) as { result?: unknown; error?: unknown }
      expect(out.result).toBeUndefined()
      expect(served).not.toContain('public.example')
    } finally {
      proxy.stop()
    }
  })

  test('a hung upstream costs providerTimeoutMs, then the trusted provider answers', async () => {
    const proxy = startRpcProxy('https://upstream.example/k', {
      trusted: ['https://trusted.example/k'],
      fallbacks: ['https://public.example'],
      logRanges: {},
      chunkLogs: false,
      providerTimeoutMs: 300,
      fetch: async (url: string, init: RequestInit) => {
        if (url.startsWith('https://upstream')) {
          return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))))
        }
        return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' })
      },
    })
    try {
      const t = Date.now()
      const res = await fetch(`${proxy.url}c/bridge-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      expect(((await res.json()) as { result: string }).result).toBe('0x1')
      expect(Date.now() - t).toBeLessThan(2_000)
    } finally {
      proxy.stop()
    }
  })

  test('with chainId, a provider on another chain is never used, and one that did not answer is asked again', async () => {
    const reads: string[] = []
    let flaky = 0
    const proxy = startRpcProxy('https://upstream.example/k', {
      trusted: ['https://wrong.example/k', 'https://flaky.example/k'],
      fallbacks: [],
      logRanges: {},
      chunkLogs: false,
      chainId: 1,
      fetch: async (url: string, init: RequestInit) => {
        const host = new URL(url).host
        const { method } = JSON.parse(String(init.body))
        if (host === 'upstream.example') return new Response('down', { status: 503 })
        if (method === 'eth_chainId') {
          if (host === 'flaky.example' && flaky++ === 0) throw new Error('unreachable')
          return Response.json({ jsonrpc: '2.0', id: 0, result: host === 'wrong.example' ? '0x2105' : '0x1' })
        }
        reads.push(host)
        return Response.json({ jsonrpc: '2.0', id: 1, result: '0x5' })
      },
    })
    const ask = async () => {
      const res = await fetch(`${proxy.url}c/bridge-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0x0000000000000000000000000000000000000001', 'latest'] }) })
      return (await res.json()) as { result?: string }
    }
    try {
      // flaky did not answer its first chain check, then did in the proxy's second pass.
      expect((await ask()).result).toBe('0x5')
      expect((await ask()).result).toBe('0x5')
      expect(reads).not.toContain('wrong.example')
      expect(reads).toContain('flaky.example')
    } finally {
      proxy.stop()
    }
  })
})
