import { describe, expect, test } from 'bun:test'
import { makeClient, rpcTransport } from '../src/sync/client.ts'

const KEYED = 'https://keyed.example/v2/secret'
const PUBLIC = 'https://public.example'

type Call = { url: string; methods: string[] }

/** A fetch that answers JSON-RPC per host. `keyed` decides what the keyed provider says. */
function fakeFetch(keyed: 'ok' | 'quota' | 'down', calls: Call[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/\/$/, '')
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '[]')))
    const reqs = Array.isArray(body) ? body : [body]
    calls.push({ url, methods: reqs.map((r: { method: string }) => r.method) })
    const answer = (result: string) => reqs.map((r: { id: number }) => ({ jsonrpc: '2.0', id: r.id, result }))
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(Array.isArray(body) ? payload : (payload as unknown[])[0]), { status, headers: { 'content-type': 'application/json' } })
    if (url === PUBLIC) return json(answer('0x2105'))
    if (keyed === 'down') throw new TypeError('fetch failed')
    if (keyed === 'quota') return json(reqs.map((r: { id: number }) => ({ jsonrpc: '2.0', id: r.id, error: { code: 429, message: 'Monthly capacity limit exceeded.' } })), 429)
    return json(answer('0x1'))
  }) as typeof fetch
}

describe('engine state transport', () => {
  test('the keyed provider answers when it is healthy', async () => {
    const calls: Call[] = []
    const { transport, keyed } = rpcTransport({ BASE_RPC_URL: KEYED, BASE_RPC_PUBLIC: PUBLIC }, fakeFetch('ok', calls))
    expect(keyed).toBe(true)
    expect(await makeClient(transport).getChainId()).toBe(1)
    expect(calls.map((c) => c.url)).toEqual([KEYED])
  })

  test('a keyed provider out of quota or unreachable: the public endpoint answers the same request', async () => {
    for (const state of ['quota', 'down'] as const) {
      const calls: Call[] = []
      const { transport } = rpcTransport({ BASE_RPC_URL: KEYED, BASE_RPC_PUBLIC: PUBLIC }, fakeFetch(state, calls))
      expect(await makeClient(transport).getChainId()).toBe(0x2105)
      expect(calls.at(-1)!.url).toBe(PUBLIC)
      expect(calls.some((c) => c.url === KEYED)).toBe(true)
    }
  })

  test('without the secret only the public endpoint is used', async () => {
    const calls: Call[] = []
    const { transport, keyed } = rpcTransport({ BASE_RPC_PUBLIC: PUBLIC }, fakeFetch('ok', calls))
    expect(keyed).toBe(false)
    expect(await makeClient(transport).getChainId()).toBe(0x2105)
    expect(calls.map((c) => c.url)).toEqual([PUBLIC])
  })
})
