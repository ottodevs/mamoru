// otto/mamoru#358: a provider that does not serve a method is not the answer; the next trusted one is asked.
import { describe, expect, test } from 'bun:test'
import { startRpcProxy } from '../src/rpc-proxy.ts'

const MONAD_PUBLIC = 'https://rpc.monad.xyz'
const MONAD_ALCHEMY = 'https://monad-mainnet.g.alchemy.com/v2/test-key'
const MONAD_DRPC = 'https://monad-mainnet.drpc.org'

type Reply = { result?: unknown; error?: { code: number; message: string } }

/** Monad as measured on 4 Nov 2026: eth_simulateV1 answered only by Alchemy; the public RPC says -32601, drpc free code 35. */
function monad(serves: Record<string, boolean>) {
  const calls: string[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string }
    calls.push(`${new URL(url).hostname} ${body.method}`)
    const reply = (r: Reply) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...r }), { status: 200 })
    if (body.method === 'eth_chainId') return reply({ result: '0x8f' })
    if (body.method !== 'eth_simulateV1') return reply({ result: '0x1' })
    if (serves[url]) return reply({ result: [{ calls: [{ status: '0x1', gasUsed: '0x5208', returnData: '0x' }] }] })
    if (url === MONAD_DRPC) return reply({ error: { code: 35, message: 'method is not available on free plan, please upgrade to paid plan' } })
    // geth adds the method as `data`; still unserved.
    return reply({ error: { code: -32601, message: 'Method not found', data: 'eth_simulateV1' } } as Reply)
  }
  return { fetch, calls }
}

async function simulate(upstream: string, trusted: string[], w: ReturnType<typeof monad>): Promise<Reply> {
  const proxy = startRpcProxy(upstream, { fetch: w.fetch, trusted, fallbacks: [MONAD_DRPC], logRanges: {} })
  try {
    const res = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [] }] }, 'latest'] }) })
    return (await res.json()) as Reply
  } finally {
    proxy.stop()
  }
}

describe('a method the provider does not serve', () => {
  test('the public upstream says Method not found: the trusted Alchemy answers the simulation', async () => {
    const w = monad({ [MONAD_ALCHEMY]: true })
    const r = await simulate(MONAD_PUBLIC, [MONAD_ALCHEMY], w)
    expect(r.error).toBeUndefined()
    expect(r.result).toEqual([{ calls: [{ status: '0x1', gasUsed: '0x5208', returnData: '0x' }] }])
    expect(w.calls.filter((c) => c.endsWith('eth_simulateV1'))).toEqual(['rpc.monad.xyz eth_simulateV1', 'monad-mainnet.g.alchemy.com eth_simulateV1'])
  })
  test('nobody serves it: the error comes back as Method not found, after both passes over the trusted list only', async () => {
    const w = monad({})
    const r = await simulate(MONAD_PUBLIC, [MONAD_ALCHEMY], w)
    expect(r.error?.code).toBe(-32601)
    // Two passes over the trusted list, in order, once each per pass; a simulation is a decision read: drpc (a plain
    // fallback) is never asked.
    expect(w.calls.filter((c) => c.endsWith('eth_simulateV1'))).toEqual([
      'rpc.monad.xyz eth_simulateV1',
      'monad-mainnet.g.alchemy.com eth_simulateV1',
      'rpc.monad.xyz eth_simulateV1',
      'monad-mainnet.g.alchemy.com eth_simulateV1',
    ])
  })
  test('drpc free plan (code 35) is unserved too; a revert whose reason names a method is the answer', async () => {
    const answers: Record<string, { code: number; message: string; data?: string }> = {
      [MONAD_PUBLIC]: { code: 35, message: 'method is not available on free plan, please upgrade to paid plan' },
      [MONAD_ALCHEMY]: { code: 3, message: 'execution reverted: Method not supported', data: '0x08c379a0' },
    }
    const calls: string[] = []
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string }
      calls.push(new URL(url).hostname)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: answers[url] }), { status: 200 })
    }
    const proxy = startRpcProxy(MONAD_PUBLIC, { fetch, trusted: [MONAD_ALCHEMY], fallbacks: [], logRanges: {} })
    try {
      const res = await (await globalThis.fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }) })).json()
      expect((res as Reply).error?.message).toBe('execution reverted: Method not supported')
      expect(calls).toEqual(['rpc.monad.xyz', 'monad-mainnet.g.alchemy.com'])
    } finally {
      proxy.stop()
    }
  })
  test('a real error of a served method is still the answer, not retried', async () => {
    const calls: string[] = []
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string }
      calls.push(new URL(url).hostname)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'sender not eoa' } }), { status: 200 })
    }
    const proxy = startRpcProxy(MONAD_PUBLIC, { fetch, trusted: [MONAD_ALCHEMY], fallbacks: [], logRanges: {} })
    try {
      const res = await (await globalThis.fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [] }) })).json()
      expect((res as Reply).error?.message).toBe('sender not eoa')
      expect(calls).toEqual(['rpc.monad.xyz'])
    } finally {
      proxy.stop()
    }
  })
})
