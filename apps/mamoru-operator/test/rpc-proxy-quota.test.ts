// otto/mamoru#418: a provider whose monthly quota is spent is passed over until its recheck, not asked first on every request.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaBook, quotaExhausted } from '../src/quota.ts'
import { startRpcProxy } from '../src/rpc-proxy.ts'

const ALCHEMY = 'https://base-mainnet.g.alchemy.com/v2/test-key'
const QUICKNODE = 'https://example.base-mainnet.quiknode.pro/test-key/'
const SPENT = { code: 429, message: 'Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service.' }

function world(spent: Set<string>) {
  const calls: string[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string }
    calls.push(new URL(url).hostname)
    if (spent.has(url)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: SPENT }), { status: 429 })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x10' }), { status: 200 })
  }
  return { fetch, calls }
}

async function call(url: string, method = 'eth_call'): Promise<any> {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, '0x10'] }) })
  return res.json()
}

describe('quota refusals', () => {
  test('a spent monthly plan is a quota refusal; a burst limit is not', () => {
    expect(quotaExhausted(429, SPENT)).toBe(true)
    expect(quotaExhausted(402, { message: 'Payment Required' })).toBe(true)
    expect(quotaExhausted(200, { code: -32007, message: 'credit limit exceeded for this endpoint' })).toBe(true)
    expect(quotaExhausted(429, { code: 429, message: 'Your app has exceeded its compute units per second capacity' })).toBe(false)
    expect(quotaExhausted(429, { code: -32005, message: 'too many requests' })).toBe(false)
    // A contract's revert reason is its own text, whatever it says.
    expect(quotaExhausted(200, { code: 3, message: 'execution reverted: out of credits' })).toBe(false)
    expect(quotaExhausted(200, { code: -32000, message: 'execution reverted: quota exceeded' })).toBe(false)
  })
})

describe('a provider out of quota (otto/mamoru#418)', () => {
  test('after the first refusal the upstream is passed over: the next requests go straight to the trusted one', async () => {
    const w = world(new Set([ALCHEMY]))
    const quota = new QuotaBook()
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, trusted: [QUICKNODE], fallbacks: [], logRanges: {}, quota })
    try {
      expect((await call(proxy.url)).result).toBe('0x10')
      expect(w.calls).toEqual(['base-mainnet.g.alchemy.com', 'example.base-mainnet.quiknode.pro'])
      w.calls.length = 0
      for (let i = 0; i < 3; i++) expect((await call(proxy.url)).result).toBe('0x10')
      expect(w.calls).toEqual(['example.base-mainnet.quiknode.pro', 'example.base-mainnet.quiknode.pro', 'example.base-mainnet.quiknode.pro'])
      expect(quota.down(ALCHEMY)).toBe(true)
      expect(quota.snapshot().map((e) => e.label)).toEqual(['alchemy.com'])
    } finally {
      proxy.stop()
    }
  })

  test('at the recheck time it is asked again, and a good answer clears the mark', async () => {
    const spent = new Set([ALCHEMY])
    const w = world(spent)
    const quota = new QuotaBook(undefined, 0)
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, trusted: [QUICKNODE], fallbacks: [], logRanges: {}, quota })
    try {
      await call(proxy.url)
      expect(quota.snapshot()).toHaveLength(1)
      spent.clear()
      w.calls.length = 0
      expect((await call(proxy.url)).result).toBe('0x10')
      expect(w.calls).toEqual(['base-mainnet.g.alchemy.com'])
      expect(quota.snapshot()).toEqual([])
    } finally {
      proxy.stop()
    }
  })

  test('every trusted provider spent: they are still asked (a spent provider beats none) and the refusal comes back', async () => {
    const w = world(new Set([ALCHEMY, QUICKNODE]))
    const quota = new QuotaBook()
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, trusted: [QUICKNODE], fallbacks: [], logRanges: {}, quota })
    try {
      await call(proxy.url)
      w.calls.length = 0
      const r = await call(proxy.url)
      expect(r.error?.code).toBe(429)
      expect(w.calls.length).toBeGreaterThan(0)
    } finally {
      proxy.stop()
    }
  })

  test('the mark survives a restart and the file holds no URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-'))
    const a = new QuotaBook(dir)
    a.mark(ALCHEMY, 'alchemy.com', 'Monthly capacity limit exceeded')
    const raw = readFileSync(join(dir, 'rpc-quota.json'), 'utf8')
    expect(raw).not.toContain('test-key')
    expect(raw).not.toContain('alchemy.com/v2')
    expect(new QuotaBook(dir).down(ALCHEMY)).toBe(true)
    expect(new QuotaBook(dir).down(QUICKNODE)).toBe(false)
  })
})
