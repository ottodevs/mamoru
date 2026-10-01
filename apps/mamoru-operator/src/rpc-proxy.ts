import type { Server } from 'bun'

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

export function startRpcProxy(upstream: string, maxLogRange = Number(process.env.MAMORU_LOG_RANGE ?? 10)): { url: string; stop: () => void } {
  let id = 0
  const local = isLoopback(upstream)
  // Chunk getLogs for Alchemy (free tier: 10 blocks) or when MAMORU_LOG_RANGE is set; otherwise the range goes as is.
  const chunkLogs = /alchemy/i.test(new URL(upstream).hostname) || !!process.env.MAMORU_LOG_RANGE
  const providers = local ? [upstream] : [upstream, ...FALLBACKS.filter((f) => f !== upstream)]
  async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    let json: any = null
    try {
      json = await res.json()
    } catch {}
    return { status: res.status, json }
  }
  /** On a rate/capacity refusal, move to the next provider at once; two passes over the list. Always returns a result/error object. */
  async function raw(body: any): Promise<any> {
    let last: any = null
    for (const [pi, url] of [...providers, ...providers].entries()) {
      const tries = 1
      if (pi === providers.length) await Bun.sleep(250)
      for (let attempt = 0; attempt < tries; attempt++) {
        try {
          const r = await post(url, body)
          if (wellFormed(r.json) && !retriable(r.status, r.json)) return r.json
          last = r.json?.error ?? { code: -32603, message: `upstream HTTP ${r.status}` }
        } catch (e) {
          last = { code: -32603, message: (e as Error).message.split('\n')[0] }
        }
        if (attempt + 1 < tries) await Bun.sleep(400 * 2 ** attempt)
      }
      if (pi === 0 && providers.length > 1 && process.env.MAMORU_RPC_LOG) console.log(`[rpc] ${body?.method} falling back after: ${String(last?.message).slice(0, 120)}`)
    }
    return { jsonrpc: '2.0', id: body?.id ?? null, error: { code: typeof last?.code === 'number' ? last.code : -32603, message: String(last?.message ?? 'upstream unavailable') } }
  }
  async function one(method: string, params: unknown[]): Promise<any> {
    const r = await raw({ jsonrpc: '2.0', id: ++id, method, params })
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
      const chunk = await Promise.all(ranges.slice(i, i + 4).map(([a, b]) => one('eth_getLogs', [{ ...filter, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }])))
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
    if (e && (e.code === -32602 || /invalid param/i.test(String(e.message)))) console.log(`[rpc] ${msg.method} refused (${e.code}): ${JSON.stringify(msg.params ?? []).slice(0, 300)}`)
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
