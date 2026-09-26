import type { Server } from 'bun'

type JsonRpcRequest = { jsonrpc: '2.0'; id: unknown; method: string; params?: unknown[] }

const LOOPBACK = '127.0.0.1'

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
          return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
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
