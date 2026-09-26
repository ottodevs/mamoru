import type { Server } from 'bun'

type Req = { jsonrpc: '2.0'; id: unknown; method: string; params?: any[] }

/**
 * Loopback JSON-RPC proxy in front of the upstream provider. It keeps the
 * keyed URL inside this process (viem errors echo the URL they called) and
 * splits eth_getLogs into ranges the provider accepts (Alchemy free tier: 10 blocks).
 */
export function startRpcProxy(upstream: string, maxLogRange = Number(process.env.MAMORU_LOG_RANGE ?? 10)): { url: string; stop: () => void } {
  let id = 0
  async function raw(body: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        if (res.status === 429 && attempt < 5) {
          await Bun.sleep(300 * (attempt + 1))
          continue
        }
        return await res.json()
      } catch (e) {
        if (attempt >= 3) throw e
        await Bun.sleep(300 * (attempt + 1))
      }
    }
  }
  async function one(method: string, params: unknown[]): Promise<any> {
    const r = await raw({ jsonrpc: '2.0', id: ++id, method, params })
    if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error })
    return r.result
  }
  const toNum = async (tag: unknown): Promise<bigint> => {
    if (typeof tag === 'string' && tag.startsWith('0x')) return BigInt(tag)
    if (tag === undefined || tag === 'latest' || tag === 'pending') return BigInt(await one('eth_blockNumber', []))
    const b = await one('eth_getBlockByNumber', [tag, false])
    return BigInt(b.number)
  }
  async function getLogs(msg: Req): Promise<unknown> {
    const filter = { ...(msg.params?.[0] ?? {}) }
    if (filter.blockHash) return one('eth_getLogs', [filter])
    const from = await toNum(filter.fromBlock ?? 'latest')
    const to = await toNum(filter.toBlock ?? 'latest')
    if (to - from + 1n <= BigInt(maxLogRange)) return one('eth_getLogs', [{ ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }])
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
  async function handle(msg: Req): Promise<unknown> {
    try {
      if (msg.method === 'eth_getLogs') return { jsonrpc: '2.0', id: msg.id, result: await getLogs(msg) }
      const r = await raw({ ...msg })
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
