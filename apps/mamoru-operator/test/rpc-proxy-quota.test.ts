// otto/mamoru#418: a provider whose monthly quota is spent is passed over until its recheck, not asked first on every request.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cycleStart, nextReset, QuotaBook, quotaExhausted, resetDaysFromEnv, resetFromAnswer } from '../src/quota.ts'
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
    // A send's balance error is about the sender, not the plan.
    expect(quotaExhausted(200, { code: -32000, message: 'insufficient balance for transfer' })).toBe(false)
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
      // An answer sent in the refusal's own millisecond keeps the mark.
      await Bun.sleep(2)
      w.calls.length = 0
      expect((await call(proxy.url)).result).toBe('0x10')
      expect(w.calls).toEqual(['base-mainnet.g.alchemy.com'])
      expect(quota.snapshot()).toEqual([])
    } finally {
      proxy.stop()
    }
  })

  test('every trusted provider spent: one request a minute asks one of them, the others fail at once without a request', async () => {
    const w = world(new Set([ALCHEMY, QUICKNODE]))
    const quota = new QuotaBook()
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, trusted: [QUICKNODE], fallbacks: [], logRanges: {}, quota })
    try {
      await call(proxy.url)
      w.calls.length = 0
      // The minute's one probe: a single provider, a single request.
      const probe = await call(proxy.url)
      expect(probe.error?.code).toBe(429)
      expect(w.calls).toHaveLength(1)
      w.calls.length = 0
      const r = await call(proxy.url)
      expect(r.error?.code).toBe(429)
      expect(r.error?.message).toMatch(/^every provider for this call is out of quota until \d{4}-\d{2}-01T00:00:00\.000Z$/)
      expect(w.calls).toEqual([])
    } finally {
      proxy.stop()
    }
  })

  test('the mark survives a restart and the file holds no URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-'))
    const a = new QuotaBook(dir)
    a.mark(ALCHEMY, 'alchemy.com', 'Monthly capacity limit exceeded', Date.now() + 86_400_000)
    const raw = readFileSync(join(dir, 'rpc-quota.json'), 'utf8')
    expect(raw).not.toContain('test-key')
    expect(raw).not.toContain('alchemy.com/v2')
    expect(new QuotaBook(dir).down(ALCHEMY)).toBe(true)
    expect(new QuotaBook(dir).down(QUICKNODE)).toBe(false)
  })

  test('past the daily recheck only one request asks the spent provider; the rest keep passing it over', () => {
    const quota = new QuotaBook(undefined, 1_000)
    quota.mark(ALCHEMY, 'alchemy.com', 'Monthly capacity limit exceeded', 10_000_000, 0)
    expect(quota.skip(ALCHEMY, 500)).toBe(true)
    expect(quota.skip(ALCHEMY, 1_000)).toBe(false)
    expect(quota.skip(ALCHEMY, 1_001)).toBe(true)
    expect(quota.skip(ALCHEMY, 1_002)).toBe(true)
  })

  test('a good answer to a request sent before the latest refusal does not clear the mark', () => {
    const quota = new QuotaBook()
    quota.mark(ALCHEMY, 'alchemy.com', 'Monthly capacity limit exceeded', 10_000_000, 2_000)
    quota.clear(ALCHEMY, 1_000)
    quota.clear(ALCHEMY, 2_000)
    expect(quota.snapshot()).toHaveLength(1)
    quota.clear(ALCHEMY, 3_000)
    expect(quota.snapshot()).toEqual([])
  })
})

// Exact answers, as providers send them. Alchemy's spent plan (HTTP 429, every key since 20 Nov 2026) and its burst
// limit; QuickNode's documented rate-limit codes (quicknode.com/docs/ethereum/error-references), which are bursts.
const ALCHEMY_BURST = { code: 429, message: 'Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message. If not, check out https://docs.alchemy.com/reference/throughput' }
const QUICKNODE_BURSTS = [
  { code: -32007, message: 'Per-second request limit reached' },
  { code: -32008, message: 'Per-minute request limit reached' },
  { code: -32011, message: 'Method rate limit reached' },
  { code: -32029, message: 'Rate limit exceeded' },
]

describe('quota answers and resets (otto/mamoru#418)', () => {
  test('exact provider answers: the spent plan is a quota; every burst limit is not', () => {
    expect(quotaExhausted(429, SPENT)).toBe(true)
    expect(quotaExhausted(429, ALCHEMY_BURST)).toBe(false)
    for (const e of QUICKNODE_BURSTS) expect(quotaExhausted(429, e)).toBe(false)
    expect(quotaExhausted(429, { code: -32603, message: 'upstream HTTP 429' })).toBe(false)
  })

  test('Alchemy out of quota is parked until the first of next month, 00:00 UTC; a burst limit is a few seconds out', async () => {
    const w = world(new Set([ALCHEMY]))
    const quota = new QuotaBook()
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, trusted: [QUICKNODE], fallbacks: [], logRanges: {}, quota, quotaResetDays: {} })
    try {
      await call(proxy.url)
      const d = new Date()
      expect(quota.until(ALCHEMY)).toBe(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
      expect(quota.providers().map((p) => [p.label, p.state])).toEqual([['alchemy.com', 'exhausted'], ['quiknode.pro', 'ok']])
    } finally {
      proxy.stop()
    }
  })

  test('a burst 429 never parks: the provider is burst_limited for seconds, then ok', async () => {
    const quota = new QuotaBook()
    let burst = true
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number }
      if (url === ALCHEMY && burst) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: ALCHEMY_BURST }), { status: 429 })
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x10' })
    }
    const proxy = startRpcProxy(ALCHEMY, { fetch, trusted: [QUICKNODE], fallbacks: [], logRanges: {}, quota })
    try {
      expect((await call(proxy.url)).result).toBe('0x10')
      expect(quota.down(ALCHEMY)).toBe(false)
      expect(quota.snapshot()).toEqual([])
      const a = quota.providers().find((p) => p.label === 'alchemy.com')!
      expect(a.state).toBe('burst_limited')
      expect(Date.parse(a.until!) - Date.now()).toBeLessThanOrEqual(10_000)
      expect(quota.cooling(ALCHEMY, Date.now() + 10_001)).toBe(false)
      expect(quota.providers().find((p) => p.label === 'alchemy.com')!.state).toBe('ok')
      burst = false
    } finally {
      proxy.stop()
    }
  })

  test('a reset the answer gives wins: Retry-After, or a date after "reset" in the message', async () => {
    const now = Date.UTC(2026, 10, 22, 12)
    expect(resetFromAnswer('credits exhausted', '3600', now)).toBe(now + 3_600_000)
    expect(resetFromAnswer('credits exhausted', 'Sun, 23 Nov 2026 00:00:00 GMT', now)).toBe(Date.UTC(2026, 10, 23))
    expect(resetFromAnswer('API credits exhausted; your credits reset on 2026-12-14', null, now)).toBe(Date.UTC(2026, 11, 14))
    expect(resetFromAnswer('quota exceeded, resets at 2026-11-30T08:00:00Z', null, now)).toBe(Date.UTC(2026, 10, 30, 8))
    // In the past, over 40 days out, or no date: the configured cycle.
    expect(resetFromAnswer('reset 2026-11-01', null, now)).toBeNull()
    expect(resetFromAnswer('reset 2027-06-01', '99999999', now)).toBeNull()
    expect(resetFromAnswer(SPENT.message, null, now)).toBeNull()
    expect(resetFromAnswer({ reset: '2026-12-01' }, null, now)).toBeNull()

    const quota = new QuotaBook()
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number }
      if (url === QUICKNODE) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'insufficient credits' } }), { status: 402, headers: { 'retry-after': '7200' } })
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x10' })
    }
    const proxy = startRpcProxy(QUICKNODE, { fetch, trusted: [ALCHEMY], fallbacks: [], logRanges: {}, quota })
    try {
      const before = Date.now()
      expect((await call(proxy.url)).result).toBe('0x10')
      const until = quota.until(QUICKNODE)!
      expect(until).toBeGreaterThanOrEqual(before + 7_200_000)
      expect(until).toBeLessThanOrEqual(Date.now() + 7_200_000)
    } finally {
      proxy.stop()
    }
  })

  test('MAMORU_RPC_QUOTA_RESET_DAY sets a billing cycle per provider; the rest reset on the first', () => {
    const days = resetDaysFromEnv({ MAMORU_RPC_QUOTA_RESET_DAY: 'quiknode.pro=14, alchemy.com=1, bad=40, x=abc' })
    expect(days).toEqual({ 'quiknode.pro': 14, 'alchemy.com': 1 })
    const nov20 = Date.UTC(2026, 10, 20, 9)
    expect(nextReset('quiknode.pro', nov20, days)).toBe(Date.UTC(2026, 11, 14))
    expect(cycleStart('quiknode.pro', nov20, days)).toBe(Date.UTC(2026, 10, 14))
    expect(nextReset('alchemy.com', nov20, days)).toBe(Date.UTC(2026, 11, 1))
    expect(nextReset('alchemy.com', Date.UTC(2026, 11, 31, 23), days)).toBe(Date.UTC(2027, 0, 1))
    expect(cycleStart('quiknode.pro', Date.UTC(2026, 10, 3), days)).toBe(Date.UTC(2026, 9, 14))
    // The reset instant itself starts the new cycle.
    expect(cycleStart('alchemy.com', Date.UTC(2026, 11, 1), days)).toBe(Date.UTC(2026, 11, 1))
  })

  test('at the reset one request asks again; refused, it is parked until the next reset', () => {
    const quota = new QuotaBook()
    const reset = Date.UTC(2026, 11, 1)
    quota.mark(ALCHEMY, 'alchemy.com', 'Monthly capacity limit exceeded', reset, reset - 3_600_000)
    expect(quota.skip(ALCHEMY, reset - 1)).toBe(true)
    expect(quota.skip(ALCHEMY, reset)).toBe(false)
    expect(quota.skip(ALCHEMY, reset + 1)).toBe(true)
    quota.mark(ALCHEMY, 'alchemy.com', 'Monthly capacity limit exceeded', Date.UTC(2027, 0, 1), reset + 2)
    expect(quota.until(ALCHEMY)).toBe(Date.UTC(2027, 0, 1))
    expect(quota.skip(ALCHEMY, reset + 86_400_000 - 1)).toBe(true)
    // The daily recheck.
    expect(quota.skip(ALCHEMY, reset + 2 + 86_400_000)).toBe(false)
  })

  test('/metrics provider states carry host-free labels only, never a key or a subdomain', async () => {
    const w = world(new Set([ALCHEMY]))
    const quota = new QuotaBook()
    const proxy = startRpcProxy(ALCHEMY, { fetch: w.fetch, trusted: [QUICKNODE], fallbacks: ['https://base-rpc.publicnode.com'], logRanges: {}, quota, name: 'chain' })
    try {
      await call(proxy.url)
      const raw = JSON.stringify([quota.providers(), quota.snapshot()])
      expect(raw).not.toContain('test-key')
      expect(raw).not.toContain('base-mainnet')
      expect(raw).not.toContain('example')
      expect(quota.providers().map((p) => `${p.proxy}/${p.label}/${p.state}`)).toEqual(['chain/alchemy.com/exhausted', 'chain/publicnode.com/ok', 'chain/quiknode.pro/ok'])
    } finally {
      proxy.stop()
    }
  })
})

describe('eth_getLogs with every provider spent (otto/mamoru#418, review)', () => {
  test('the minute probe asks one provider once; the next request in the minute asks none', async () => {
    const quota = new QuotaBook()
    const calls: string[] = []
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string }
      calls.push(`${new URL(url).hostname} ${body.method}`)
      if (body.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x100' })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: SPENT }), { status: 429 })
    }
    const PUB = 'https://base-rpc.publicnode.com'
    const proxy = startRpcProxy(ALCHEMY, { fetch, trusted: [QUICKNODE], fallbacks: [PUB], logRanges: {}, chunkLogs: false, trustedLogsOnly: true, quota, headLag: 0n })
    const logs = () => fetch2(proxy.url, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x10', toBlock: '0x15' }] })
    try {
      quota.mark(ALCHEMY, 'alchemy.com', 'Monthly capacity limit exceeded', Date.now() + 86_400_000)
      quota.mark(QUICKNODE, 'quiknode.pro', 'Monthly capacity limit exceeded', Date.now() + 86_400_000)
      calls.length = 0
      const first = await logs()
      expect(first.error).toBeDefined()
      // One provider, one request: no second pass, and no rate retry of a spent plan.
      expect(calls).toEqual(['base-mainnet.g.alchemy.com eth_getLogs'])
      calls.length = 0
      const second = await logs()
      expect(second.error?.message).toMatch(/^every provider for this call is out of quota until /)
      expect(calls).toEqual([])
    } finally {
      proxy.stop()
    }
  })
})

async function fetch2(url: string, body: unknown): Promise<any> {
  return (await fetch(url, { method: 'POST', body: JSON.stringify(body) })).json()
}

describe('alert marks are saved before the page (review)', () => {
  test('quota: the file holds the mark when the [alert] line is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-order-'))
    const real = console.error
    let onDisk: string | null = null
    console.error = (...a: unknown[]) => {
      if (String(a[0]).startsWith('[alert]')) onDisk = readFileSync(join(dir, 'rpc-quota.json'), 'utf8')
    }
    try {
      new QuotaBook(dir).mark(ALCHEMY, 'alchemy.com', 'Monthly capacity limit exceeded', Date.now() + 86_400_000)
    } finally {
      console.error = real
    }
    expect(onDisk).not.toBeNull()
    expect(Object.keys(JSON.parse(onDisk!))).toHaveLength(1)
  })
})
