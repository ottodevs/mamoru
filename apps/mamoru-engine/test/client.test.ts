import { describe, expect, test } from 'bun:test'
import { encodeFunctionData } from 'viem'
import { poolReadAbi } from '../src/sync/abis.ts'
import { makeClient, rpcTransport } from '../src/sync/client.ts'
import { readHead } from '../src/sync/head.ts'

const KEYED = 'https://keyed.example/v2/secret'
const PUBLIC = 'https://public.example'
const POOL = '0x00000000000000000000000000000000000000aa'
const HASH = `0x${'ab'.repeat(32)}`

type Call = { url: string; methods: string[] }
type Req = { id: number; method: string }

const block = { number: '0x10', hash: HASH, parentHash: HASH, timestamp: '0x1', transactions: [], uncles: [], logsBloom: null, gasLimit: '0x0', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', size: '0x0' }

/** A fetch that answers JSON-RPC per host. `keyed` decides what the keyed provider says. */
function fakeFetch(keyed: 'ok' | 'quota' | 'down' | 'reverts', calls: Call[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/\/$/, '')
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '[]')))
    const reqs: Req[] = Array.isArray(body) ? body : [body]
    calls.push({ url, methods: reqs.map((r) => r.method) })
    const reply = (payload: unknown[], status = 200) => new Response(JSON.stringify(Array.isArray(body) ? payload : payload[0]), { status, headers: { 'content-type': 'application/json' } })
    const ok = (chainId: string) => reqs.map((r) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? chainId : r.method === 'eth_getBlockByNumber' ? block : '0x' }))
    if (url === PUBLIC) return reply(ok('0x2105'))
    if (keyed === 'down') throw new TypeError('fetch failed')
    if (keyed === 'quota') return reply(reqs.map((r) => ({ jsonrpc: '2.0', id: r.id, error: { code: 429, message: 'Monthly capacity limit exceeded.' } })), 429)
    if (keyed === 'reverts') return reply(reqs.map((r) => ({ jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted: OLD' } })))
    return reply(ok('0x1'))
  }) as typeof fetch
}

const urls = (calls: Call[]) => calls.map((c) => c.url)

describe('engine state transport', () => {
  test('the keyed provider answers when it is healthy', async () => {
    const calls: Call[] = []
    const { transport, keyed } = rpcTransport({ BASE_RPC_URL: KEYED, BASE_RPC_PUBLIC: PUBLIC }, fakeFetch('ok', calls))
    expect(keyed).toBe(true)
    expect(await makeClient(transport).getChainId()).toBe(1)
    expect(urls(calls)).toEqual([KEYED])
  })

  test('out of quota or unreachable: one failed keyed request, then the public endpoint for the rest of the sync', async () => {
    for (const state of ['quota', 'down'] as const) {
      const calls: Call[] = []
      const client = makeClient(rpcTransport({ BASE_RPC_URL: KEYED, BASE_RPC_PUBLIC: PUBLIC }, fakeFetch(state, calls)).transport)
      expect(await client.getChainId()).toBe(0x2105)
      expect(await client.getChainId()).toBe(0x2105)
      // The keyed provider is asked once, with no retry, and never again.
      expect(urls(calls)).toEqual([KEYED, PUBLIC, PUBLIC])
    }
  })

  test('the batched head read of a sync fails over as one', async () => {
    const calls: Call[] = []
    const client = makeClient(rpcTransport({ BASE_RPC_URL: KEYED, BASE_RPC_PUBLIC: PUBLIC }, fakeFetch('quota', calls)).transport)
    const head = await readHead(client, 0x2105)
    expect(head.safe).toMatchObject({ number: 16, hash: HASH })
    // readHead sends chain id, latest and safe together: the keyed batch fails, the public endpoint answers all three.
    expect(calls.filter((c) => c.url === PUBLIC).flatMap((c) => c.methods).sort()).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber'])
    expect(calls.filter((c) => c.url === KEYED).length).toBeLessThanOrEqual(3)
    const after = calls.length
    await client.getChainId()
    expect(urls(calls.slice(after))).toEqual([PUBLIC])
  })

  test('a revert is the answer, not an outage: it surfaces and the keyed provider stays in use', async () => {
    const calls: Call[] = []
    const client = makeClient(rpcTransport({ BASE_RPC_URL: KEYED, BASE_RPC_PUBLIC: PUBLIC }, fakeFetch('reverts', calls)).transport)
    const data = encodeFunctionData({ abi: poolReadAbi, functionName: 'observe', args: [[1800, 0]] })
    await expect(client.call({ to: POOL, data })).rejects.toThrow(/execution reverted/)
    await expect(client.call({ to: POOL, data })).rejects.toThrow(/execution reverted/)
    expect(urls(calls)).toEqual([KEYED, KEYED])
  })

  test('without the secret only the public endpoint is used', async () => {
    const calls: Call[] = []
    const { transport, keyed } = rpcTransport({ BASE_RPC_PUBLIC: PUBLIC }, fakeFetch('ok', calls))
    expect(keyed).toBe(false)
    expect(await makeClient(transport).getChainId()).toBe(0x2105)
    expect(urls(calls)).toEqual([PUBLIC])
  })
})
