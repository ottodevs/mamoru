import type { Server } from 'bun'
import { createEmulator, type Emulation, type Emulator, type Forward, type RpcMsg } from './emulate.ts'

type JsonRpcRequest = { jsonrpc: '2.0'; id: unknown; method: string; params?: unknown[] }

const LOOPBACK = '127.0.0.1'

/** The most one upstream request through the fork proxy may take before it is asked again. */
export const UPSTREAM_TIMEOUT_MS = 30_000
/** How long the fork proxy keeps asking again after an upstream 429 before anvil gets it. */
export const RATE_LIMIT_WAIT_MS = 40_000

export type ForkProxy = { url: string; requests: () => number; stop: () => void }

/** Hosts of keyed providers: every fork read there is billed (a QuickNode credit each), and a head fork re-reads all of it. */
const KEYED_HOST = /(^|\.)quiknode\.pro$/i

/**
 * A fork run reads hundreds of thousands of slots, so the keyed provider is refused unless E2E_ALLOW_KEYED=1. The URL
 * is never in the message: only the name of the variable that holds it.
 */
export function assertNotKeyed(upstream: string, envVar: string, env: Record<string, string | undefined> = process.env): void {
  if (env.E2E_ALLOW_KEYED === '1') return
  let host = ''
  try {
    host = new URL(upstream).hostname
  } catch {
    return
  }
  if (KEYED_HOST.test(host)) throw new Error(`${envVar} is a keyed provider (billed per call): fork from a public RPC, or set E2E_ALLOW_KEYED=1 to use it on purpose`)
}

/**
 * Loopback proxy that anvil forks from. The upstream URL is read from the
 * environment inside this process and never leaves it: not in argv, not in
 * logs, not in the URL that anvil receives.
 */
export function startForkProxy(envVar = 'RPC_URL'): ForkProxy {
  const upstream = process.env[envVar]
  if (!upstream) throw new Error(`${envVar} is not set`)
  assertNotKeyed(upstream, envVar)
  let count = 0
  const server: Server<undefined> = Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      count++
      const body = await req.text()
      const started = Date.now()
      for (let attempt = 0; ; attempt++) {
        try {
          // Bounded: an upstream request with no answer is asked again here, under anvil's own 45 s fork timeout,
          // instead of holding the fork read behind it until anvil gives up.
          const res = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
          // A 429 is asked again here for up to RATE_LIMIT_WAIT_MS rather than handed to anvil after a few tries: a keyed
          // provider answers 429 past ~30 req/s, and a refused fork read reaching anvil is the suspected trigger of the
          // mid-run stalls seen with anvil 1.7.1 on 4 Nov (not proven). Still under anvil's 45 s fork timeout.
          if (res.status === 429 && Date.now() - started < RATE_LIMIT_WAIT_MS) {
            await Bun.sleep(Math.min(2_000, 250 * (attempt + 1)))
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
 * removes more methods, as a provider without them would (LAB-08 b). `emulation` (otto/mamoru#273) puts a recorded
 * provider profile in front of anvil (proxy/emulate.ts); without it nothing changes.
 */
export function startEnginePort(target: string, rewrite?: ResponseRewrite, refuse: string[] = [], emulation?: Emulation): EnginePort {
  const emulator: Emulator | undefined = emulation && createEmulator(emulation)
  const stats: EnginePortStats = { forwarded: 0, rejectedLabMethods: 0, rejected: [] }
  const handleOne = async (msg: JsonRpcRequest): Promise<unknown> => {
    const lab = isLabOnlyMethod(msg.method)
    if (lab || refuse.includes(msg.method)) {
      if (lab) stats.rejectedLabMethods++
      stats.rejected.push(msg.method)
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method ${msg.method} is not available on the engine port` } }
    }
    const forward: Forward = async (m: RpcMsg) => {
      stats.forwarded++
      const res = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) })
      const json = (await res.json()) as { result?: unknown }
      if (rewrite && 'result' in json) json.result = rewrite(m.method, json.result)
      return json
    }
    if (emulator) return emulator.handle(msg, forward)
    return forward(msg)
  }
  const server: Server<undefined> = Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (emulator?.rateLimited()) return Response.json({ jsonrpc: '2.0', id: null, error: { code: 429, message: 'Too Many Requests' } }, { status: 429 })
      const payload = (await req.json()) as JsonRpcRequest | JsonRpcRequest[]
      const out = Array.isArray(payload) ? await Promise.all(payload.map(handleOne)) : await handleOne(payload)
      return Response.json(out)
    },
  })
  return { url: `http://${LOOPBACK}:${server.port}/`, stats: () => ({ ...stats, rejected: [...stats.rejected] }), stop: () => server.stop(true) }
}
