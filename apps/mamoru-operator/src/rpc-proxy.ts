import type { Server } from 'bun'
import { classifyRpcError, redactSecrets, safeMetrics, type RpcMetrics } from './metrics.ts'

type Req = { jsonrpc: '2.0'; id: unknown; method: string; params?: any[] }

/**
 * Loopback JSON-RPC proxy in front of the upstream provider. It keeps the
 * keyed URL inside this process (viem errors echo the URL they called) and
 * splits eth_getLogs into ranges the provider accepts (Alchemy free tier: 10 blocks).
 */
const FALLBACKS = (process.env.MAMORU_RPC_FALLBACKS ?? 'https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org').split(',').filter(Boolean)

function isLoopback(url: string): boolean {
  const h = new URL(url).hostname
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
}

/** Rate or capacity refusals that are worth a retry or another provider, not a real answer. */
function retriable(status: number, body: any): boolean {
  if (status === 429 || status >= 500) return true
  const e = body?.error
  if (!e) return false
  return e.code === 429 || e.code === -32005 || /rate|capacity|limit exceeded|compute units|too many|throughput|timeout|temporar/i.test(String(e.message))
}

function wellFormed(body: any): boolean {
  return !!body && typeof body === 'object' && ('result' in body || (body.error && typeof body.error === 'object'))
}

/** Second-level "public suffixes" where the registrable domain needs the last three labels, not two
 * (co.uk, com.au, ...). Not a full public-suffix list — this only needs to be right for the handful
 * of plausible RPC-provider/CDN domains, not to resolve eTLD+1 for arbitrary hostnames; an unlisted
 * multi-part suffix just collapses one label further than ideal, never leaks one further than safe. */
const MULTI_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'co.in', 'co.nz', 'co.kr', 'com.au', 'com.br', 'com.cn'])

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * The registrable domain (eTLD+1) of a hostname: the last two labels, or the last three when the
 * last two form a known multi-part suffix. Some providers put their API key in a subdomain
 * (QuickNode: `<key>.base-mainnet.quiknode.pro`); the full hostname must never become a label, a
 * `/metrics` field, or a line in the persisted ring file — only the registrable domain underneath it.
 * An IPv4 address (the loopback proxy's own upstream in tests) or a bracketed IPv6 address has no
 * "registrable domain" at all and is returned as-is, never split into its dotted octets/groups.
 */
function registrableDomain(hostname: string): string {
  if (IPV4_RE.test(hostname) || hostname.includes(':')) return hostname
  const labels = hostname.split('.').filter(Boolean)
  if (labels.length <= 2) return hostname
  const lastTwo = labels.slice(-2).join('.')
  return labels.slice(-(MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2)).join('.')
}

/** Provider URL -> display label: registrable domain only, `#1`/`#2` suffix when several providers
 * share one (never a subdomain, the path, or a key — see `registrableDomain`). */
export function labelProviders(providers: string[]): Map<string, string> {
  const hosts = providers.map((p) => registrableDomain(new URL(p).hostname))
  const totalPerHost = new Map<string, number>()
  for (const h of hosts) totalPerHost.set(h, (totalPerHost.get(h) ?? 0) + 1)
  const seen = new Map<string, number>()
  const labels = new Map<string, string>()
  providers.forEach((p, i) => {
    const h = hosts[i]!
    if ((totalPerHost.get(h) ?? 0) > 1) {
      const idx = (seen.get(h) ?? 0) + 1
      seen.set(h, idx)
      labels.set(p, `${h}#${idx}`)
    } else labels.set(p, h)
  })
  return labels
}

export function startRpcProxy(upstream: string, opts: { maxLogRange?: number; metrics?: RpcMetrics } = {}): { url: string; stop: () => void } {
  const maxLogRange = opts.maxLogRange ?? Number(process.env.MAMORU_LOG_RANGE ?? 10)
  const metrics = opts.metrics
  let id = 0
  const local = isLoopback(upstream)
  // Chunk getLogs for Alchemy (free tier: 10 blocks) or when MAMORU_LOG_RANGE is set; otherwise the range goes as is.
  const chunkLogs = /alchemy/i.test(new URL(upstream).hostname) || !!process.env.MAMORU_LOG_RANGE
  const providers = local ? [upstream] : [upstream, ...FALLBACKS.filter((f) => f !== upstream)]
  const labels = labelProviders(providers)
  const labelOf = (url: string) => labels.get(url) ?? registrableDomain(new URL(url).hostname)
  async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    let json: any = null
    try {
      json = await res.json()
    } catch {}
    return { status: res.status, json }
  }
  /** On a rate/capacity refusal, move to the next provider at once; two passes over the list. Always returns a result/error object. */
  async function raw(body: any, isChunk = false): Promise<any> {
    let last: any = null
    const all = [...providers, ...providers]
    for (const [pi, url] of all.entries()) {
      const label = labelOf(url)
      const tries = 1
      if (pi === providers.length) await Bun.sleep(250)
      for (let attempt = 0; attempt < tries; attempt++) {
        try {
          const r = await post(url, body)
          if (metrics) safeMetrics(() => metrics.recordRequest(label, body.method, isChunk))
          const errObj = r.json?.error ?? (wellFormed(r.json) ? undefined : { code: -32603, message: `upstream HTTP ${r.status}` })
          if (errObj && metrics) safeMetrics(() => metrics.recordError(label, body.method, classifyRpcError(r.status, errObj)))
          if (wellFormed(r.json) && !retriable(r.status, r.json)) return r.json
          last = errObj
        } catch (e) {
          if (metrics) safeMetrics(() => metrics.recordRequest(label, body.method, isChunk))
          last = { code: -32603, message: (e as Error).message.split('\n')[0] }
          if (metrics) safeMetrics(() => metrics.recordError(label, body.method, classifyRpcError(undefined, last)))
        }
        if (attempt + 1 < tries) await Bun.sleep(400 * 2 ** attempt)
      }
      const next = all[pi + 1]
      if (next !== undefined && next !== url && metrics) safeMetrics(() => metrics.recordFallback(label, body.method))
      if (pi === 0 && providers.length > 1 && process.env.MAMORU_RPC_LOG) console.log(`[rpc] ${body?.method} falling back after: ${redactSecrets(last?.message).slice(0, 120)}`)
    }
    return { jsonrpc: '2.0', id: body?.id ?? null, error: { code: typeof last?.code === 'number' ? last.code : -32603, message: String(last?.message ?? 'upstream unavailable') } }
  }
  async function one(method: string, params: unknown[], isChunk = false): Promise<any> {
    const r = await raw({ jsonrpc: '2.0', id: ++id, method, params }, isChunk)
    if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error })
    return r.result
  }
  const toNum = async (tag: unknown): Promise<bigint> => {
    if (typeof tag === 'string' && tag.startsWith('0x')) return BigInt(tag)
    if (tag === undefined || tag === 'latest' || tag === 'pending') return head()
    const b = await one('eth_getBlockByNumber', [tag, false])
    return BigInt(b.number)
  }
  async function getLogs(msg: Req): Promise<unknown> {
    const filter = { ...(msg.params?.[0] ?? {}) }
    if (filter.blockHash) return one('eth_getLogs', [filter])
    const from = await toNum(filter.fromBlock ?? 'latest')
    const to = await toNum(filter.toBlock ?? 'latest')
    if (!chunkLogs || to - from + 1n <= BigInt(maxLogRange)) return one('eth_getLogs', [{ ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }])
    const ranges: [bigint, bigint][] = []
    for (let a = from; a <= to; a += BigInt(maxLogRange)) {
      const b = a + BigInt(maxLogRange) - 1n
      ranges.push([a, b < to ? b : to])
    }
    const out: unknown[] = []
    for (let i = 0; i < ranges.length; i += 4) {
      const chunk = await Promise.all(ranges.slice(i, i + 4).map(([a, b]) => one('eth_getLogs', [{ ...filter, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }], true)))
      for (const c of chunk) out.push(...(c as unknown[]))
    }
    return out
  }
  // A load-balanced provider answers from nodes a block or two apart: a head read from one node and a call pinned
  // to it on another gives "0x", null fields or "block not found". Serve `latest` a few blocks behind the tip.
  const lag = BigInt(process.env.MAMORU_HEAD_LAG ?? 3)
  async function head(): Promise<bigint> {
    const n = BigInt(await one('eth_blockNumber', [])) - lag
    return n
  }
  async function handle(msg: Req): Promise<unknown> {
    const r = await handleInner(msg)
    // Name the call behind an invalid-params refusal: the engine only sees the message.
    const e = (r as any)?.error
    if (e && (e.code === -32602 || /invalid param/i.test(String(e.message)))) console.log(`[rpc] ${msg.method} refused (${e.code}): ${redactSecrets(JSON.stringify(msg.params ?? [])).slice(0, 300)}`)
    return r
  }
  async function handleInner(msg: Req): Promise<unknown> {
    try {
      if (msg.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: msg.id, result: `0x${(await head()).toString(16)}` }
      if (msg.method === 'eth_getBlockByNumber' && (msg.params?.[0] === 'latest' || msg.params?.[0] === 'pending')) {
        return { jsonrpc: '2.0', id: msg.id, result: await one('eth_getBlockByNumber', [`0x${(await head()).toString(16)}`, msg.params?.[1] ?? false]) }
      }
      if (msg.method === 'eth_getLogs') return { jsonrpc: '2.0', id: msg.id, result: await getLogs(msg) }
      let r = await raw({ ...msg })
      // A block by number that this node does not have yet comes back null: ask again (a fallback may have it).
      for (let i = 0; i < 3 && msg.method.startsWith('eth_getBlockBy') && r && 'result' in r && r.result === null; i++) {
        await Bun.sleep(700)
        r = await raw({ ...msg })
      }
      return { ...r, id: msg.id }
    } catch (e) {
      const rpc = (e as any).rpc ?? { code: -32603, message: (e as Error).message.split('\n')[0] }
      return { jsonrpc: '2.0', id: msg.id, error: rpc }
    }
  }
  const server: Server<undefined> = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const payload = (await req.json()) as Req | Req[]
      return Response.json(Array.isArray(payload) ? await Promise.all(payload.map(handle)) : await handle(payload))
    },
  })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}
