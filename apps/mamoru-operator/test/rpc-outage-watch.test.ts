import { describe, expect, test } from 'bun:test'
import { ALL_DOWN_ALERT_MS, OutageWatch } from '../src/rpc-proxy.ts'

// otto/mamoru#444: one page when no provider of a proxy has answered for ALL_DOWN_ALERT_MS while asked, one recovery.
function capture(run: () => void): string[] {
  const lines: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
  try {
    run()
  } finally {
    console.error = orig
  }
  return lines
}

describe('OutageWatch (#444)', () => {
  test('failures running unbroken past the window page once, naming providers by label; a good answer recovers once', () => {
    const w = new OutageWatch('chain', () => 'alchemy.com exhausted until 2026-12-01T00:00:00.000Z, quiknode.pro failing', ALL_DOWN_ALERT_MS, 0)
    const lines = capture(() => {
      w.failed(0)
      w.failed(100_000)
      w.failed(200_000)
      w.failed(ALL_DOWN_ALERT_MS - 1)
      w.failed(ALL_DOWN_ALERT_MS)
      w.failed(ALL_DOWN_ALERT_MS + 60_000) // still down: no second page
      w.ok(ALL_DOWN_ALERT_MS + 120_000)
      w.ok(ALL_DOWN_ALERT_MS + 180_000) // already up: no second recovery line
    })
    expect(lines).toEqual([
      '[alert] rpc chain: no provider has answered for 5 min; reads and sends wait (alchemy.com exhausted until 2026-12-01T00:00:00.000Z, quiknode.pro failing)',
      '[rpc] chain: providers answer again after 420 s without one',
    ])
    expect(w.down()).toBe(false)
  })

  test('a quiet spell is not an outage: the first failure after an hour without requests starts the run, it does not page', () => {
    const w = new OutageWatch('chain', () => 'x', ALL_DOWN_ALERT_MS, 0)
    const lines = capture(() => {
      w.failed(3_600_000)
      w.failed(3_600_000 + 60_000)
    })
    expect(lines).toEqual([])
  })

  test('an answer inside the window resets it: failures must run unbroken for the whole window', () => {
    const w = new OutageWatch('monad', () => 'x', ALL_DOWN_ALERT_MS, 0)
    const lines = capture(() => {
      w.failed(ALL_DOWN_ALERT_MS - 1_000)
      w.ok(ALL_DOWN_ALERT_MS - 500)
      w.failed(ALL_DOWN_ALERT_MS + 1_000)
    })
    expect(lines).toEqual([])
    expect(w.down()).toBe(false)
  })
})

describe('the proxy pages when every provider fails (#444)', () => {
  const { startRpcProxy } = require('../src/rpc-proxy.ts') as typeof import('../src/rpc-proxy.ts')
  const { QuotaBook } = require('../src/quota.ts') as typeof import('../src/quota.ts')
  const A = 'https://base-mainnet.g.alchemy.com/v2/test-key'
  const Q = 'https://example.base-mainnet.quiknode.pro/test-key/'
  // An eth_call at a fixed block: a read the proxy sends to a provider (head reads may be answered from its own head).
  const call = async (url: string) => (await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, '0x10'] }) })).json()
  /** Requests for `ms`, one every 10 ms: an unbroken run, as live traffic is. */
  const hammer = async (url: string, ms: number) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      await call(url)
      await Bun.sleep(10)
    }
  }

  test('upstream and trusted both failing past the window: one [alert] with labels, no URL; an answer after it: one recovery', async () => {
    let up = false
    const fetcher = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number }
      return up ? new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x10' })) : new Response('bad gateway', { status: 502 })
    }
    const lines: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
    const proxy = startRpcProxy(A, { fetch: fetcher as never, trusted: [Q], fallbacks: [], logRanges: {}, quota: new QuotaBook(), allDownAlertMs: 1_000 })
    try {
      await hammer(proxy.url, 1_600)
      up = true
      await Bun.sleep(30) // past any short backoff
      await call(proxy.url)
    } finally {
      proxy.stop()
      console.error = orig
    }
    const alerts = lines.filter((l) => l.startsWith('[alert] rpc chain'))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).not.toContain('test-key')
    expect(lines.filter((l) => l.includes('providers answer again'))).toHaveLength(1)
  })

  test('a revoked key or a 200 that is not JSON-RPC is an outage too, and a URL given as the name never reaches the page', async () => {
    // Every provider unusable in a different way: a revoked key, and a 200 whose body is not JSON-RPC.
    const fetcher = async (url: string) => (url.includes('alchemy') ? new Response('unauthorized', { status: 401 }) : new Response('<html>maintenance</html>', { status: 200 }))
    const lines: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
    const proxy = startRpcProxy(A, { name: A, fetch: fetcher as never, trusted: [Q], fallbacks: [], logRanges: {}, quota: new QuotaBook(), allDownAlertMs: 1_000 })
    try {
      await hammer(proxy.url, 1_600)
    } finally {
      proxy.stop()
      console.error = orig
    }
    const alerts = lines.filter((l) => l.startsWith('[alert] rpc '))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toStartWith('[alert] rpc proxy:')
    expect(lines.join('\n')).not.toContain('test-key')
  })

  test('a provider whose own JSON-RPC error happens to read "upstream HTTP 503" is still an answer: no page', async () => {
    const fetcher = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'upstream HTTP 503' } }), { status: 200 })
    }
    const lines: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
    const proxy = startRpcProxy(A, { fetch: fetcher as never, trusted: [Q], fallbacks: [], logRanges: {}, quota: new QuotaBook(), allDownAlertMs: 1_000 })
    try {
      await hammer(proxy.url, 1_600)
    } finally {
      proxy.stop()
      console.error = orig
    }
    expect(lines.filter((l) => l.startsWith('[alert] rpc '))).toEqual([])
  })

  const shapes: [string, (id: number) => Response | Promise<never>][] = [
    ['a well-formed result on HTTP 503', (id) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result: null }), { status: 503 })],
    ['an error object without the JSON-RPC envelope on HTTP 200', () => new Response(JSON.stringify({ error: { code: -32602, message: 'block range too large' } }), { status: 200 })],
    ['a connection that fails', () => Promise.reject(new TypeError('connect ECONNREFUSED'))],
    ['a retriable refusal on every request (no data for the operator)', (id) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32005, message: 'too many requests' } }), { status: 200 })],
  ]
  test.each(shapes)('every provider giving %s for the whole window pages once', async (_what, answer) => {
    const fetcher = async (_url: string, init: RequestInit) => answer((JSON.parse(String(init.body)) as { id: number }).id)
    const lines: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
    const proxy = startRpcProxy(A, { fetch: fetcher as never, trusted: [Q], fallbacks: [], logRanges: {}, quota: new QuotaBook(), allDownAlertMs: 1_000 })
    try {
      await hammer(proxy.url, 1_600)
    } finally {
      proxy.stop()
      console.error = orig
    }
    expect(lines.filter((l) => l.startsWith('[alert] rpc chain'))).toHaveLength(1)
  })
})

