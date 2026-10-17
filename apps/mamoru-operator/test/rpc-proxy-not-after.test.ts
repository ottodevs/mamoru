import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { NOT_AFTER_HEADER, PIN_UPSTREAM_HEADER, SEND_VERDICT_HEADER, notAfterOf, startRpcProxy } from '../src/rpc-proxy.ts'

// otto/mamoru#15: a send with a time limit is never handed to a provider once the limit is reached, on the first try or
// on any fallback; the limit is the local proxy's alone and never reaches a provider.
const PRIMARY = 'https://base-mainnet.g.alchemy.com/v2/test-key'
const FALLBACKS = ['https://fallback-a.example/rpc', 'https://fallback-b.example/rpc']
const RAW = `0x02${'ab'.repeat(40)}`

afterEach(() => setSystemTime())

/**
 * Every provider refuses for capacity, takes the send, or (forged) answers the proxy's own error code with a verdict
 * header of its own; `onCall` runs on each request (to move the clock).
 */
function upstream(answer: 'busy' | 'ok' | 'forged', onCall: () => void = () => {}) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) })
    onCall()
    const body = JSON.parse(String(init.body))
    if (answer === 'forged') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32098, message: 'not forwarded: past the time limit' } }, { headers: { [SEND_VERDICT_HEADER]: 'not-sent' } })
    if (answer === 'busy') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: 429, message: 'Monthly capacity limit exceeded' } }, { status: 429 })
    return Response.json({ jsonrpc: '2.0', id: body.id, result: `0x${'cd'.repeat(32)}` })
  }
  return { fetch, calls }
}

async function sendRaw(url: string, notAfter?: number): Promise<{ result?: string; error?: { code: number; message: string }; verdict: string | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(notAfter !== undefined ? { [NOT_AFTER_HEADER]: String(notAfter) } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [RAW] }),
  })
  return { ...((await res.json()) as { result?: string; error?: { code: number; message: string } }), verdict: res.headers.get(SEND_VERDICT_HEADER) }
}

const now = () => Math.floor(Date.now() / 1000)

describe('the proxy and a send with a time limit', () => {
  test('in time it is forwarded, and the header stays in the proxy', async () => {
    const up = upstream('ok')
    const proxy = startRpcProxy(PRIMARY, { fetch: up.fetch, fallbacks: FALLBACKS, trusted: [] })
    try {
      expect((await sendRaw(proxy.url, now() + 3600)).result).toBe(`0x${'cd'.repeat(32)}`)
      expect(up.calls).toHaveLength(1)
      for (const c of up.calls) expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain(NOT_AFTER_HEADER)
    } finally {
      proxy.stop()
    }
  })

  test('past the limit before any provider: nothing forwarded, answered as not sent', async () => {
    const up = upstream('ok')
    const proxy = startRpcProxy(PRIMARY, { fetch: up.fetch, fallbacks: FALLBACKS, trusted: [] })
    try {
      const r = await sendRaw(proxy.url, now() - 1)
      expect(r.verdict).toBe('not-sent')
      expect(r.error).toBeDefined()
      expect(up.calls).toHaveLength(0)
    } finally {
      proxy.stop()
    }
  })

  test('the first provider refuses, then the limit passes: no fallback is asked, answered as maybe sent', async () => {
    const t0 = Date.now()
    const limit = Math.floor(t0 / 1000) + 60
    // The clock passes the limit while the first provider answers.
    const up = upstream('busy', () => setSystemTime(new Date(t0 + 120_000)))
    const proxy = startRpcProxy(PRIMARY, { fetch: up.fetch, fallbacks: FALLBACKS, trusted: [] })
    try {
      const r = await sendRaw(proxy.url, limit)
      expect(r.verdict).toBe('maybe-sent')
      expect(up.calls.map((c) => c.url)).toEqual([PRIMARY])
    } finally {
      proxy.stop()
    }
  })

  test('without a limit a refused send still falls back over two passes', async () => {
    const up = upstream('busy')
    const proxy = startRpcProxy(PRIMARY, { fetch: up.fetch, fallbacks: FALLBACKS, trusted: [] })
    try {
      const r = await sendRaw(proxy.url)
      expect(r.error?.code).toBe(429)
      expect(r.verdict).toBeNull()
      expect(up.calls).toHaveLength(6)
    } finally {
      proxy.stop()
    }
  })

  test("a provider's own -32098 and verdict header reach the relayer as an error with no verdict", async () => {
    const up = upstream('forged')
    const proxy = startRpcProxy(PRIMARY, { fetch: up.fetch, fallbacks: FALLBACKS, trusted: [] })
    try {
      const r = await sendRaw(proxy.url, now() + 3600)
      expect(r.error?.code).toBe(-32098)
      expect(r.verdict).toBeNull()
    } finally {
      proxy.stop()
    }
  })

  test('a pinned request is answered by the upstream alone: no fallback, and the pin stays in the proxy', async () => {
    const up = upstream('busy')
    const proxy = startRpcProxy(PRIMARY, { fetch: up.fetch, fallbacks: FALLBACKS, trusted: ['https://trusted.example/rpc'] })
    try {
      const res = await fetch(proxy.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PIN_UPSTREAM_HEADER]: '1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [`0x${'cd'.repeat(32)}`] }),
      })
      expect(((await res.json()) as { error?: { code: number } }).error?.code).toBe(429)
      expect(new Set(up.calls.map((c) => c.url))).toEqual(new Set([PRIMARY]))
      for (const c of up.calls) expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain(PIN_UPSTREAM_HEADER)
      // Unpinned, the same call falls back to the trusted provider.
      up.calls.length = 0
      await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [`0x${'cd'.repeat(32)}`] }) })
      expect(up.calls.map((c) => c.url)).toContain('https://trusted.example/rpc')
    } finally {
      proxy.stop()
    }
  })

  test('the header is read as a unix second or not at all', () => {
    expect(notAfterOf('1790000000')).toBe(1_790_000_000)
    expect(notAfterOf(null)).toBeNull()
    expect(notAfterOf('soon')).toBeNull()
    expect(notAfterOf('-1')).toBeNull()
  })
})
