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
  test('failures under the window page nothing; past it, one page naming the providers by label; a good answer recovers once', () => {
    const w = new OutageWatch('chain', () => 'alchemy.com exhausted until 2026-12-01T00:00:00.000Z, quiknode.pro failing', ALL_DOWN_ALERT_MS, 0)
    const lines = capture(() => {
      w.failed(60_000)
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
  const call = async (url: string) => (await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json()

  test('upstream and trusted both failing past the window: one [alert] with labels, no URL; an answer after it: one recovery', async () => {
    let up = false
    const fetcher = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number }
      return up ? new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x10' })) : new Response('bad gateway', { status: 502 })
    }
    const lines: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
    const proxy = startRpcProxy(A, { fetch: fetcher as never, trusted: [Q], fallbacks: [], logRanges: {}, quota: new QuotaBook(), allDownAlertMs: 50 })
    try {
      await call(proxy.url)
      await Bun.sleep(80)
      await call(proxy.url)
      await call(proxy.url)
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
})
