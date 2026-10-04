import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { componentOf, RpcMetrics } from '../src/metrics.ts'
import { labelProviders, providerWords, startRpcProxy } from '../src/rpc-proxy.ts'

/** 40 lowercase-hex chars, the shape of a QuickNode endpoint token (and most other provider API keys). */
const QUICKNODE_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-rpc-proxy-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('labelProviders', () => {
  test('registrable domain only (not the full host) when every provider has a distinct one', () => {
    const labels = labelProviders(['https://base-mainnet.g.alchemy.com/v2/key-a', 'https://base-rpc.publicnode.com'])
    expect(labels.get('https://base-mainnet.g.alchemy.com/v2/key-a')).toBe('alchemy.com')
    expect(labels.get('https://base-rpc.publicnode.com')).toBe('publicnode.com')
  })

  test('#1/#2 suffix when two providers share a registrable domain, never the path or key', () => {
    const labels = labelProviders(['https://base-mainnet.g.alchemy.com/v2/key-a', 'https://eth-mainnet.g.alchemy.com/v2/key-b'])
    expect(labels.get('https://base-mainnet.g.alchemy.com/v2/key-a')).toBe('alchemy.com#1')
    expect(labels.get('https://eth-mainnet.g.alchemy.com/v2/key-b')).toBe('alchemy.com#2')
  })

  test('a multi-part public suffix (co.uk) keeps three labels, not two', () => {
    const labels = labelProviders(['https://rpc.example.co.uk/v1/key'])
    expect(labels.get('https://rpc.example.co.uk/v1/key')).toBe('example.co.uk')
  })

  test('an IPv4 upstream (the loopback proxy in tests) is never split into octets', () => {
    const labels = labelProviders(['http://127.0.0.1:8080/'])
    expect(labels.get('http://127.0.0.1:8080/')).toBe('127.0.0.1')
  })

  test('a QuickNode-style URL with a 40-char token as the first subdomain label never surfaces the token', () => {
    const url = `https://${QUICKNODE_TOKEN}.base-mainnet.quiknode.pro/`
    const labels = labelProviders([url])
    const label = labels.get(url)!
    expect(label).toBe('quiknode.pro')
    expect(label).not.toContain(QUICKNODE_TOKEN)
  })

  test('a QuickNode-style provider never leaks its token into the /metrics payload or the persisted ring file', () => {
    const url = `https://${QUICKNODE_TOKEN}.base-mainnet.quiknode.pro/`
    const label = labelProviders([url]).get(url)!
    const dir = tmpDir()
    const metrics = new RpcMetrics(dir)
    metrics.recordRequest(label, 'eth_call', false)
    metrics.recordError(label, 'eth_call', 'rateCapacity')
    metrics.persist()

    const payloadText = JSON.stringify(metrics.snapshot())
    expect(payloadText).not.toContain(QUICKNODE_TOKEN)
    expect(payloadText).toContain('quiknode.pro')

    const persisted = readFileSync(join(dir, 'rpc-usage.json'), 'utf8')
    expect(persisted).not.toContain(QUICKNODE_TOKEN)
    expect(persisted).toContain('quiknode.pro')
  })
})

/** A fake single-provider upstream the proxy's loopback detection won't try to fall back from (providers.length === 1). */
function fakeUpstream(handler: (body: any) => { status?: number; json: any }) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = await req.json()
      const { status, json } = handler(body)
      return Response.json(json, { status: status ?? 200 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}

describe('startRpcProxy metrics wiring', () => {
  test('a successful call counts one request against the provider+method, no error', async () => {
    const upstream = fakeUpstream((body) => ({ json: { jsonrpc: '2.0', id: body.id, result: '0x1' } }))
    const metrics = new RpcMetrics(tmpDir())
    const proxy = startRpcProxy(upstream.url, { metrics })
    try {
      const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      expect(((await res.json()) as { result: string }).result).toBe('0x1')
    } finally {
      proxy.stop()
      upstream.stop()
    }
    const snap = metrics.snapshot()
    const c = snap.cumulative['127.0.0.1']!.eth_chainId!
    expect(c.requests).toBe(1)
    expect(c.errors.invalidParams + c.errors.rateCapacity + c.errors.timeout + c.errors.other).toBe(0)
  })

  test('an invalid-params error is classified and counted, and returned to the caller unchanged', async () => {
    const upstream = fakeUpstream((body) => ({ json: { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'invalid params for eth_call' } } }))
    const metrics = new RpcMetrics(tmpDir())
    const proxy = startRpcProxy(upstream.url, { metrics })
    try {
      const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }) })
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602)
    } finally {
      proxy.stop()
      upstream.stop()
    }
    const c = metrics.snapshot().cumulative['127.0.0.1']!.eth_call!
    expect(c.errors.invalidParams).toBe(1)
    expect(c.errors.rateCapacity).toBe(0)
  })

  test('eth_getLogs chunking increments getLogsChunks once per chunk, not once per logical call', async () => {
    const calls: unknown[] = []
    const upstream = fakeUpstream((body) => {
      calls.push(body)
      if (body.method === 'eth_blockNumber') return { json: { jsonrpc: '2.0', id: body.id, result: '0x14' } } // block 20, lag 3 -> head 17
      if (body.method === 'eth_getLogs') return { json: { jsonrpc: '2.0', id: body.id, result: [] } }
      // The proxy asks the provider that served the logs for the last block of the range.
      if (body.method === 'eth_getBlockByNumber') return { json: { jsonrpc: '2.0', id: body.id, result: { number: body.params[0], hash: `0x${'ab'.repeat(32)}` } } }
      return { json: { jsonrpc: '2.0', id: body.id, result: null } }
    })
    const metrics = new RpcMetrics(tmpDir())
    const prevRange = process.env.MAMORU_LOG_RANGE
    process.env.MAMORU_LOG_RANGE = '2' // force chunking regardless of host
    const proxy = startRpcProxy(upstream.url, { metrics, maxLogRange: 2 })
    try {
      const res = await fetch(proxy.url, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: '0xa' }] }), // 11 blocks / 2 per chunk = 6 chunks
      })
      expect(((await res.json()) as { result: unknown[] }).result).toEqual([])
    } finally {
      proxy.stop()
      upstream.stop()
      if (prevRange === undefined) delete process.env.MAMORU_LOG_RANGE
      else process.env.MAMORU_LOG_RANGE = prevRange
    }
    const c = metrics.snapshot().cumulative['127.0.0.1']!.eth_getLogs!
    expect(c.getLogsChunks).toBe(6)
    expect(c.requests).toBe(6)
  })

  test('a throwing metrics object never changes the proxy response (success path)', async () => {
    const upstream = fakeUpstream((body) => ({ json: { jsonrpc: '2.0', id: body.id, result: '0x2a' } }))
    const throwingMetrics = {
      recordRequest: () => {
        throw new Error('metrics backend is on fire')
      },
      recordError: () => {
        throw new Error('metrics backend is on fire')
      },
      recordFallback: () => {
        throw new Error('metrics backend is on fire')
      },
    } as unknown as RpcMetrics
    const proxy = startRpcProxy(upstream.url, { metrics: throwingMetrics })
    try {
      const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { result: string }).result).toBe('0x2a')
    } finally {
      proxy.stop()
      upstream.stop()
    }
  })

  test('a throwing metrics object never changes the proxy response (error path)', async () => {
    const upstream = fakeUpstream((body) => ({ json: { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'invalid params for eth_call' } } }))
    const throwingMetrics = {
      recordRequest: () => {
        throw new Error('metrics backend is on fire')
      },
      recordError: () => {
        throw new Error('metrics backend is on fire')
      },
      recordFallback: () => {
        throw new Error('metrics backend is on fire')
      },
    } as unknown as RpcMetrics
    const proxy = startRpcProxy(upstream.url, { metrics: throwingMetrics })
    try {
      const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }) })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602)
    } finally {
      proxy.stop()
      upstream.stop()
    }
  })

  test('an odd method name (shaped like an Object.prototype member) never throws end to end', async () => {
    const upstream = fakeUpstream((body) => ({ json: { jsonrpc: '2.0', id: body.id, result: 'ok' } }))
    const metrics = new RpcMetrics(tmpDir())
    const proxy = startRpcProxy(upstream.url, { metrics })
    try {
      const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'toString', params: [] }) })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { result: string }).result).toBe('ok')
    } finally {
      proxy.stop()
      upstream.stop()
    }
    expect(metrics.snapshot().cumulative['127.0.0.1']!.other!.requests).toBe(1)
  })
})

// A decision read (state, head, block, simulation) comes only from the upstream or a trusted keyed provider.
describe('decision reads fall back only to trusted providers', () => {
  const KEYED = 'https://base-mainnet.g.alchemy.com/v2/key-a'
  const TRUSTED = 'https://abc.base-mainnet.quiknode.pro/token/'
  const PUBLIC = 'https://base-rpc.publicnode.com'
  function world(down: Set<string>) {
    const hits: { host: string; method: string }[] = []
    const proxy = startRpcProxy(KEYED, {
      fallbacks: [PUBLIC],
      trusted: [TRUSTED],
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body))
        const host = new URL(url).hostname
        hits.push({ host, method: body.method })
        if (down.has(host)) return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: 429, message: 'rate limit' } }, { status: 429 })
        return Response.json({ jsonrpc: '2.0', id: body.id, result: host.includes('publicnode') ? '0xbad' : '0x1' })
      },
    })
    const ask = async (method: string, params: unknown[] = []) => (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result?: string; error?: { code: number } }
    return { hits, proxy, ask }
  }

  test('the upstream refuses: eth_call is answered by the trusted provider, never the public one', async () => {
    const w = world(new Set(['base-mainnet.g.alchemy.com']))
    try {
      for (const method of ['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_chainId', 'eth_simulateV1']) expect((await w.ask(method)).result).toBe('0x1')
    } finally {
      w.proxy.stop()
    }
    expect(w.hits.some((h) => h.host === 'base-rpc.publicnode.com')).toBe(false)
  })

  test('both keyed providers refuse: the read fails instead of trusting a public node', async () => {
    const w = world(new Set(['base-mainnet.g.alchemy.com', 'abc.base-mainnet.quiknode.pro']))
    let r: { result?: string; error?: { code: number } }
    try {
      r = await w.ask('eth_call')
    } finally {
      w.proxy.stop()
    }
    expect(r.result).toBeUndefined()
    expect(r.error?.code).toBe(429)
    expect(w.hits.some((h) => h.host === 'base-rpc.publicnode.com')).toBe(false)
  })

  test('heads, blocks, receipts and nonces fall back to the trusted provider only, also inside a batch', async () => {
    const w = world(new Set(['base-mainnet.g.alchemy.com']))
    try {
      for (const [method, params] of [['eth_blockNumber', []], ['eth_getBlockByNumber', ['0x10', false]], ['eth_getBlockByNumber', ['latest', false]], ['eth_getTransactionReceipt', ['0x01']], ['eth_getTransactionCount', ['0x0000000000000000000000000000000000000001', 'latest']]] as const) {
        expect((await w.ask(method, [...params])).error).toBeUndefined()
      }
      const batch = (await (await fetch(w.proxy.url, { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [] }]) })).json()) as { result?: string }[]
      expect(batch.map((r) => r.result)).toEqual(['0x1', '0x1'])
    } finally {
      w.proxy.stop()
    }
    expect(w.hits.some((h) => h.host === 'base-rpc.publicnode.com')).toBe(false)
  })

  test('a block the upstream does not have yet is asked again of the next trusted provider, never a public one', async () => {
    const hits: string[] = []
    const proxy = startRpcProxy(KEYED, {
      fallbacks: [PUBLIC],
      trusted: [TRUSTED],
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body))
        const host = new URL(url).hostname
        hits.push(host)
        // The upstream does not have the block; the trusted provider does.
        const result = host === 'abc.base-mainnet.quiknode.pro' ? { number: '0x10', hash: `0x${'cd'.repeat(32)}` } : null
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      },
    })
    let r: { result?: { number: string } | null }
    try {
      r = (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x10', false] }) })).json()) as typeof r
    } finally {
      proxy.stop()
    }
    expect(r.result?.number).toBe('0x10')
    expect(hits).toEqual(['base-mainnet.g.alchemy.com', 'abc.base-mainnet.quiknode.pro'])
  })

  test('a block no trusted provider has stays null after the retries, without asking a public node', async () => {
    const hits: string[] = []
    const proxy = startRpcProxy(KEYED, {
      fallbacks: [PUBLIC],
      trusted: [TRUSTED],
      fetch: async (url, init) => {
        hits.push(new URL(url).hostname)
        return Response.json({ jsonrpc: '2.0', id: JSON.parse(String(init.body)).id, result: null })
      },
    })
    let r: { result?: unknown }
    try {
      r = (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x10', false] }) })).json()) as typeof r
    } finally {
      proxy.stop()
    }
    expect(r.result).toBeNull()
    expect(hits.length).toBe(4)
    expect(hits.includes('base-rpc.publicnode.com')).toBe(false)
  })

  test('a log range the trusted provider takes in a few requests is served by it, not by a public node', async () => {
    const calls: { host: string; method: string }[] = []
    const proxy = startRpcProxy(KEYED, {
      fallbacks: [PUBLIC],
      trusted: [TRUSTED],
      logRanges: { 'quiknode.pro': 10_000, 'publicnode.com': 2_000 },
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body))
        calls.push({ host: new URL(url).hostname, method: body.method })
        if (body.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x2000' })
        if (body.method === 'eth_getBlockByNumber') return Response.json({ jsonrpc: '2.0', id: body.id, result: { number: body.params[0], hash: `0x${'ab'.repeat(32)}` } })
        return Response.json({ jsonrpc: '2.0', id: body.id, result: [] })
      },
    })
    try {
      const r = (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: '0x01', fromBlock: '0x1000', toBlock: '0x1095' }] }) })).json()) as { result?: unknown[] }
      expect(r.result).toEqual([])
    } finally {
      proxy.stop()
    }
    expect(calls.filter((c) => c.method === 'eth_getLogs').map((c) => c.host)).toEqual(['abc.base-mainnet.quiknode.pro'])
  })

  test('logs of one block by hash come from a trusted provider only', async () => {
    const w = world(new Set(['base-mainnet.g.alchemy.com']))
    let r: { result?: string; error?: { code: number } }
    try {
      r = await w.ask('eth_getLogs', [{ blockHash: `0x${'ab'.repeat(32)}` }])
    } finally {
      w.proxy.stop()
    }
    expect(r.result).toBe('0x1')
    expect(w.hits.filter((h) => h.method === 'eth_getLogs').map((h) => h.host)).toEqual(['base-mainnet.g.alchemy.com', 'abc.base-mainnet.quiknode.pro'])
  })

  test('a signed transaction may be relayed by any provider when the keyed ones refuse', async () => {
    const w = world(new Set(['base-mainnet.g.alchemy.com', 'abc.base-mainnet.quiknode.pro']))
    try {
      expect((await w.ask('eth_sendRawTransaction', ['0x02'])).result).toBe('0xbad')
    } finally {
      w.proxy.stop()
    }
    expect(w.hits.at(-1)?.host).toBe('base-rpc.publicnode.com')
  })
})

// Which loop of the operator made a request: told by the path the proxy is called on, counted apart from the provider.
describe('requests by component', () => {
  test('componentOf: the closed set, anything else is unlabelled', () => {
    expect(['/c/engine', '/c/watcher', '/c/operator', '/c/relayer', '/c/engine/'].map(componentOf)).toEqual(['engine', 'watcher', 'operator', 'relayer', 'engine'])
    expect(['/', '', '/c/', '/c/attacker', '/c/engine/extra', '/c/ENGINE', '/x/engine'].map(componentOf)).toEqual(Array(7).fill('unlabelled'))
  })

  test('the path decides the component; the provider counters are the same as before', async () => {
    const upstream = fakeUpstream((body) => ({ json: { jsonrpc: '2.0', id: body.id, result: '0x1' } }))
    const dir = tmpDir()
    const metrics = new RpcMetrics(dir)
    const proxy = startRpcProxy(upstream.url, { metrics })
    const ask = (path: string, method: string) => fetch(`${proxy.url}${path}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) }).then((r) => r.json())
    try {
      await ask('c/engine', 'eth_call')
      await ask('c/engine', 'eth_call')
      await ask('c/watcher', 'eth_call')
      await ask('c/nobody', 'eth_getCode')
      await ask('', 'eth_chainId')
      // A batch is one caller.
      await fetch(`${proxy.url}c/relayer`, { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }, { jsonrpc: '2.0', id: 2, method: 'eth_gasPrice', params: [] }]) })
    } finally {
      proxy.stop()
      upstream.stop()
    }
    const snap = metrics.snapshot()
    const by = snap.byComponent.cumulative
    expect(by.engine!.eth_call!.requests).toBe(2)
    expect(by.watcher!.eth_call!.requests).toBe(1)
    expect(by.relayer!.eth_gasPrice!.requests).toBe(2)
    expect(by.unlabelled!.eth_getCode!.requests).toBe(1)
    expect(by.unlabelled!.eth_chainId!.requests).toBe(1)
    expect(Object.keys(by).sort()).toEqual(['engine', 'relayer', 'unlabelled', 'watcher'])
    // By provider: every request, whoever made it.
    const total = Object.values(snap.cumulative['127.0.0.1']!).reduce((n, c) => n + c.requests, 0)
    expect(total).toBe(7)
    expect(snap.byComponent.last48h).toHaveLength(1)
    // It survives a restart.
    metrics.persist()
    const again = new RpcMetrics(dir).snapshot()
    expect(again.byComponent.cumulative.engine!.eth_call!.requests).toBe(2)
    expect(again.byComponent.last48h).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'rpc-usage.json'), 'utf8')).components.cumulative.watcher.eth_call.requests).toBe(1)
  })

  test('the CU of a billed provider is charged to the component that asked', () => {
    const metrics = new RpcMetrics(tmpDir())
    metrics.recordRequest('alchemy.com', 'eth_call', false, Date.now(), 'engine')
    metrics.recordRequest('alchemy.com', 'eth_call', false, Date.now(), 'watcher')
    metrics.recordRequest('publicnode.com', 'eth_getLogs', false, Date.now(), 'engine')
    const by = metrics.snapshot().byComponent.cumulative
    expect(by.engine!.eth_call!.cuEstimate).toBe(26)
    expect(by.watcher!.eth_call!.cuEstimate).toBe(26)
    expect(by.engine!.eth_getLogs!.cuEstimate).toBe(0)
    expect(metrics.cuEstimateTotal()).toBe(52)
  })

  test('a usage file written before components existed loads as before', () => {
    const dir = tmpDir()
    const old = new RpcMetrics(dir)
    old.recordRequest('alchemy.com', 'eth_call', false)
    old.persist()
    const file = join(dir, 'rpc-usage.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    delete raw.components
    writeFileSync(file, JSON.stringify(raw))
    const snap = new RpcMetrics(dir).snapshot()
    expect(snap.cumulative['alchemy.com']!.eth_call!.requests).toBe(1)
    expect(snap.byComponent.cumulative).toEqual({})
  })
})

describe('a refused transaction says why', () => {
  // Short on purpose: redactSecrets blanks long runs, which would hide the bytes even if they were logged.
  const RAW = '0x02f8c0ffee'
  /** Sends through a proxy whose upstream answers `answer`; returns the proxy's answers and what it logged. */
  async function send(answer: (body: any) => any, calls: { method: string; params: unknown[] }[]) {
    const upstream = fakeUpstream((body) => ({ json: { jsonrpc: '2.0', id: body.id, ...answer(body) } }))
    const proxy = startRpcProxy(upstream.url, {})
    const lines: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => void lines.push(a.join(' '))
    const answers: { result?: unknown; error?: { code: unknown; message: unknown } }[] = []
    try {
      for (const c of calls) answers.push((await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...c }) })).json()) as (typeof answers)[number])
    } finally {
      console.log = log
      proxy.stop()
      upstream.stop()
    }
    return { answers, said: lines.filter((l) => l.includes('refused')) }
  }

  test('the provider message is logged once, its URL redacted, the transaction never; the error comes back as it was', async () => {
    const message = 'transaction gas limit too high (cap: 16777216, tx: 16777217) see https://secret-key.example/v2/abcdefabcdefabcdefabcdef'
    const { answers, said } = await send(() => ({ error: { code: -32000, message } }), [{ method: 'eth_sendRawTransaction', params: [RAW] }, { method: 'eth_call', params: [] }])
    expect(answers[0]!.error).toEqual({ code: -32000, message })
    expect(said).toHaveLength(1)
    expect(said[0]).toBe('[rpc] eth_sendRawTransaction refused (-32000): transaction gas limit too high (cap: 16777216, tx: 16777217) see [redacted]')
    // The params (the signed transaction) are not part of the line.
    expect(said[0]).not.toContain('c0ffee')
  })

  test('an invalid-params refusal of a send is one line, without the transaction', async () => {
    const { said } = await send(() => ({ error: { code: -32602, message: 'invalid params: rlp' } }), [{ method: 'eth_sendRawTransaction', params: [RAW] }])
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('(-32602): invalid params: rlp')
    expect(said[0]).not.toContain('c0ffee')
  })

  test('an accepted transaction logs nothing', async () => {
    const { answers, said } = await send(() => ({ result: '0xhash' }), [{ method: 'eth_sendRawTransaction', params: [RAW] }])
    expect(answers[0]!.result).toBe('0xhash')
    expect(said).toHaveLength(0)
  })

  test('an error with no usable message or code still comes back', async () => {
    const { answers, said } = await send(() => ({ error: { code: 'x', message: { nested: true } } }), [{ method: 'eth_sendRawTransaction', params: [RAW] }])
    expect(answers[0]!.error).toBeDefined()
    expect(said).toHaveLength(1)
    expect(said[0]).toBe('[rpc] eth_sendRawTransaction refused (?): (no text)')
  })

  test('a message that is not text is not serialised: nothing inside it is logged', async () => {
    const message = { token: 'short-key', password: 'short-pass', url: 'aaaaaaaaaaaaaaaaaaaaaaaa://short-key.rpc.example', pad: 'x'.repeat(100_000) }
    const { answers, said } = await send(() => ({ error: { code: -32000, message } }), [{ method: 'eth_sendRawTransaction', params: [RAW] }])
    expect(answers[0]!.error).toEqual({ code: -32000, message })
    expect(said).toEqual(['[rpc] eth_sendRawTransaction refused (-32000): (no text)'])
  })

  test('a key in the hostname of a URL the provider echoes is not logged, whatever the scheme', async () => {
    const message = 'upstream https://short-key.rpc.example/v2/abc and wss://k3y.rpc.example said no'
    const { answers, said } = await send(() => ({ error: { code: -32000, message } }), [{ method: 'eth_sendRawTransaction', params: [RAW] }])
    expect(answers[0]!.error).toEqual({ code: -32000, message })
    expect(said[0]).toBe('[rpc] eth_sendRawTransaction refused (-32000): upstream [redacted] and [redacted] said no')
  })

  test('provider text cannot write a second line or a terminal escape', async () => {
    const message = 'rejected\n[operator] forged entry\r\u001b[31mred\u2028next\u0085end'
    const { answers, said } = await send(() => ({ error: { code: -32000, message } }), [{ method: 'eth_sendRawTransaction', params: [RAW] }])
    expect(answers[0]!.error).toEqual({ code: -32000, message })
    expect(said).toHaveLength(1)
    expect(said[0]).toBe('[rpc] eth_sendRawTransaction refused (-32000): rejected [operator] forged entry [31mred next end')
    expect(said[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
  })

  test('a log that throws costs no answer, alone or in a batch', async () => {
    const error = { code: -32000, message: 'nonce too low' }
    const upstream = fakeUpstream((body) => ({ json: { jsonrpc: '2.0', id: body.id, error } }))
    const proxy = startRpcProxy(upstream.url, {})
    const log = console.log
    let thrown = 0
    console.log = () => {
      thrown++
      throw new Error('sink down')
    }
    try {
      const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'eth_sendRawTransaction', params: [RAW] })
      const one = (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify(call(1)) })).json()) as { error: unknown }
      const many = (await (await fetch(proxy.url, { method: 'POST', body: JSON.stringify([call(2), call(3)]) })).json()) as { id: number; error: unknown }[]
      expect(one.error).toEqual(error)
      expect(many.map((m) => m.id).sort()).toEqual([2, 3])
      for (const m of many) expect(m.error).toEqual(error)
      expect(thrown).toBe(3)
    } finally {
      console.log = log
      proxy.stop()
      upstream.stop()
    }
  })
})

describe('providerWords', () => {
  test('an endpoint address is dropped however it is split', () => {
    for (const split of [
      '//alice:short-pass@short-key.rpc.example',
      'https://\nshort-key.rpc.example/v2/abc',
      'https://alice:\nshort-pass@short-key.rpc.example',
      'https:// short-key.rpc.example /v2/abc',
      'short-key.rpc.example:8545',
      '10.0.0.7:8545/v2/abc',
      'wss://short-key.rpc.example',
      'https\u200b://short-key\u2060.rpc.example\\v2\\abc',
      'https://\nshort-key.\nrpc.example/v2/abc',
      'https://rpc.example\n.short-key',
      'short-key. rpc .example',
      'https://short-key\u00ad.rpc\u034f.example\u061c/v2/abc',
    ]) {
      const out = providerWords(`refused by ${split} today`)
      expect(out).not.toMatch(/short-key|short-pass|rpc\.example|abc|10\.0/)
      expect(out.startsWith('refused by ')).toBe(true)
      expect(out.endsWith(' today')).toBe(true)
    }
  })

  test('what a node says when it refuses a transaction comes through as it was', () => {
    for (const said of [
      'insufficient funds for gas * price + value: have 0 want 7000000000000',
      'nonce too low',
      'replacement transaction underpriced',
      'transaction gas limit too high (cap: 16777216, tx: 16777217)',
      'max fee per gas less than block base fee: maxFeePerGas: 100, baseFee: 1.5',
    ]) expect(providerWords(said)).toBe(said)
  })

  test('nothing invisible reaches the line: controls, bidi marks, zero width, soft hyphen, separators', () => {
    const invisible = ['\u0000', '\u001b', '\u007f', '\u0085', '\u00ad', '\u034f', '\u061c', '\u180e', '\u200b', '\u200f', '\u2028', '\u2029', '\u202e', '\u2060', '\u206a', '\ufeff', '\u00a0', '\u3000', '\ud800']
    for (const c of invisible) expect(providerWords(`nonce${c}too${c}${c}low`)).toBe('nonce too low')
    expect(providerWords('nonce\u061c too low')).toBe('nonce too low')
  })

  test('a word cut by the reading limit is dropped: half an address is not a plain word', () => {
    for (let pad = 1960; pad <= 2000; pad++) {
      const out = providerWords(`no ${' '.repeat(pad)}short-key.rpc.example/v2/abc`)
      expect(out).not.toMatch(/short|key|rpc|example|abc/)
    }
    // Exactly at the limit nothing was cut: the last word stays. One character over, it goes.
    expect(providerWords(`${' '.repeat(1995)}nonce`)).toBe('nonce')
    expect(providerWords(`low ${' '.repeat(1991)}nonce.`)).toBe('low')
    // A cut through a surrogate pair leaves no half character behind (the word before it goes too: it is the last one).
    expect(providerWords(`too low ${' '.repeat(1991)}\u{1F600}`)).toBe('too')
    expect(providerWords('nonce too low')).toBe('nonce too low')
  })

  test('it never throws and never writes more than one short line', () => {
    for (const m of [undefined, null, 7, {}, [], Symbol('x'), 'a.'.repeat(50_000), '\n'.repeat(5_000)]) {
      const out = providerWords(m)
      expect(out.length).toBeLessThanOrEqual(161)
      expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
    }
  })
})
