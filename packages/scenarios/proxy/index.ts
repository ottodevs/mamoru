import type { Server } from 'bun'

type JsonRpcRequest = { jsonrpc: '2.0'; id: unknown; method: string; params?: unknown[] }

const LOOPBACK = '127.0.0.1'

/** The upstream URL and its parts (host, each path segment, credentials, each query name and value), longest first. */
function upstreamParts(upstream: string): string[] {
  const parts = new Set<string>([upstream])
  try {
    const u = new URL(upstream)
    for (const p of [u.host, u.hostname, u.username, u.password, ...u.pathname.split('/'), ...u.search.replace(/^\?/, '').split(/[&=]/)]) {
      if (p.length >= 3) parts.add(p)
      try {
        if (decodeURIComponent(p).length >= 3) parts.add(decodeURIComponent(p))
      } catch {
        // not percent-encoded
      }
    }
  } catch {
    // not a URL: the whole value is the only part
  }
  return [...parts].sort((a, b) => b.length - a.length)
}

/**
 * `text` with the upstream URL and its parts replaced. For text a person reads (an error message, a log line),
 * never for chain data: a hex result may contain the same characters by chance and must not be touched.
 */
export function withoutUpstream(text: string, upstream: string): string {
  let out = text
  for (const part of upstreamParts(upstream)) out = out.split(part).join('<upstream>')
  return out
}

const HEX = /^0x[0-9a-fA-F]*$/

/**
 * What a provider answered, made safe to hand to anvil and to any log. A provider's error may quote the URL it
 * was called with, key included, so:
 * - a `result` is chain data and passes exactly as it came;
 * - an `error` keeps its code and its revert data (hex only); its message is read after JSON decoding, so no
 *   escape hides anything, and is replaced whole if it mentions any part of the upstream URL;
 * - anything that is not a JSON-RPC answer (an HTML error page, plain text) becomes a fixed error.
 */
export function safeAnswer(body: string, status: number, upstream: string): string {
  const parts = upstreamParts(upstream)
  const fixed = (id: unknown = null) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: `upstream error (http ${status})` } })
  const clean = (item: unknown): unknown => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return fixed()
    const { id, result, error } = item as { id?: unknown; result?: unknown; error?: unknown }
    const safeId = typeof id === 'number' || typeof id === 'string' || id === null ? id : null
    if (error === undefined) return 'result' in item ? { jsonrpc: '2.0', id: safeId, result } : fixed(safeId)
    const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown; data?: unknown }
    const message = typeof e.message === 'string' && !parts.some((p) => (e.message as string).includes(p)) ? e.message : 'upstream error'
    return { jsonrpc: '2.0', id: safeId, error: { code: typeof e.code === 'number' ? e.code : -32000, message, ...(typeof e.data === 'string' && HEX.test(e.data) ? { data: e.data } : {}) } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return JSON.stringify(fixed())
  }
  return JSON.stringify(Array.isArray(parsed) ? parsed.map(clean) : clean(parsed))
}

export type ForkProxy = { url: string; requests: () => number; stop: () => void }

/**
 * Loopback proxy that anvil forks from. The upstream URL is read from the
 * environment inside this process and never leaves it: not in argv, not in
 * logs, not in the URL that anvil receives.
 */
export function startForkProxy(envVar = 'RPC_URL'): ForkProxy {
  const upstream = process.env[envVar]
  if (!upstream) throw new Error(`${envVar} is not set`)
  let count = 0
  const server: Server<undefined> = Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      count++
      const body = await req.text()
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
          if (res.status === 429 && attempt < 5) {
            await Bun.sleep(250 * (attempt + 1))
            continue
          }
          return new Response(safeAnswer(await res.text(), res.status, upstream), { status: res.status, headers: { 'content-type': 'application/json' } })
        } catch {
          if (attempt >= 5) return new Response('upstream unavailable', { status: 502 })
          await Bun.sleep(250 * (attempt + 1))
        }
      }
    },
  })
  return { url: `http://${LOOPBACK}:${server.port}/`, requests: () => count, stop: () => server.stop(true) }
}

const LAB_ONLY_PREFIXES = ['anvil_', 'evm_', 'hardhat_']

export function isLabOnlyMethod(method: string): boolean {
  return LAB_ONLY_PREFIXES.some((p) => method.startsWith(p))
}

export type EnginePortStats = { forwarded: number; rejectedLabMethods: number; rejected: string[] }

export type EnginePort = { url: string; stats: () => EnginePortStats; stop: () => void }

export type ResponseRewrite = (method: string, result: unknown) => unknown

/**
 * The port the engine and its adapters talk to. It forwards to anvil and
 * refuses anvil_*, evm_* and hardhat_* (INV-NO-ANVIL-IN-ENGINE). `refuse`
 * removes more methods, as a provider without them would (LAB-08 b).
 */
export function startEnginePort(target: string, rewrite?: ResponseRewrite, refuse: string[] = []): EnginePort {
  const stats: EnginePortStats = { forwarded: 0, rejectedLabMethods: 0, rejected: [] }
  const handleOne = async (msg: JsonRpcRequest): Promise<unknown> => {
    const lab = isLabOnlyMethod(msg.method)
    if (lab || refuse.includes(msg.method)) {
      if (lab) stats.rejectedLabMethods++
      stats.rejected.push(msg.method)
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method ${msg.method} is not available on the engine port` } }
    }
    stats.forwarded++
    const res = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })
    const json = (await res.json()) as { result?: unknown }
    if (rewrite && 'result' in json) json.result = rewrite(msg.method, json.result)
    return json
  }
  const server: Server<undefined> = Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const payload = (await req.json()) as JsonRpcRequest | JsonRpcRequest[]
      const out = Array.isArray(payload) ? await Promise.all(payload.map(handleOne)) : await handleOne(payload)
      return Response.json(out)
    },
  })
  return { url: `http://${LOOPBACK}:${server.port}/`, stats: () => ({ ...stats, rejected: [...stats.rejected] }), stop: () => server.stop(true) }
}
