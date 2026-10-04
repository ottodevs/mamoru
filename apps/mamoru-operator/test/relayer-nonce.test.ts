import { afterAll, describe, expect, test } from 'bun:test'
import { parseTransaction, type Hex, type PublicClient } from 'viem'
import { Relayer } from '../src/relayer.ts'

// A JSON-RPC stub that takes any raw transaction and remembers the nonce it carried.
const nonces: number[] = []
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    type Call = { id: number; method: string; params: unknown[] }
    const one = (m: Call) => {
      const result =
        m.method === 'eth_chainId'
          ? '0x2105'
          : m.method === 'eth_sendRawTransaction'
            ? (nonces.push(parseTransaction(m.params[0] as Hex).nonce ?? -1), `0x${String(nonces.length).padStart(64, '0')}`)
            : m.method === 'eth_getBlockByNumber'
              ? { baseFeePerGas: '0x4c4b40', number: '0x1', timestamp: '0x1' }
              : m.method === 'eth_maxPriorityFeePerGas'
                ? '0xf4240'
                : null
      return { jsonrpc: '2.0', id: m.id, result }
    }
    const body = (await req.json()) as Call | Call[]
    return Response.json(Array.isArray(body) ? body.map(one) : one(body))
  },
})
afterAll(() => server.stop(true))

/** A provider whose pending count is whatever `count` says: a lagging node repeats an old one. */
function relayer(count: () => number) {
  const client = {
    estimateGas: async () => 21_000n,
    getTransactionCount: async () => count(),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ transactionHash: hash, status: 'success', blockNumber: 1n, logs: [] }),
  } as unknown as PublicClient
  return new Relayer(`0x${'11'.repeat(32)}`, client, `http://127.0.0.1:${server.port}`, 8453)
}
const TO = `0x${'22'.repeat(20)}` as const

describe('the relayer does not reuse the nonce of a transaction a provider just accepted', () => {
  test('a lagging node repeats the count right after a send: the next send goes one above it', async () => {
    nonces.length = 0
    const r = relayer(() => 41)
    await r.send({ to: TO, value: 1n })
    await r.send({ to: TO, data: '0x01' })
    expect(nonces).toEqual([41, 42])
  })

  test('onSending runs after the reads and before the provider gets the transaction', async () => {
    nonces.length = 0
    const order: string[] = []
    const r = relayer(() => (order.push('count'), 3))
    await r.send({ to: TO, value: 1n }, () => order.push('sent'), () => order.push(`sending:${nonces.length}`))
    expect(order).toEqual(['count', 'sending:0', 'sent'])
  })

  test('a count ahead of what this process mined is taken as is', async () => {
    nonces.length = 0
    let n = 7
    const r = relayer(() => n)
    await r.send({ to: TO, value: 1n })
    n = 12
    await r.send({ to: TO, value: 1n })
    expect(nonces).toEqual([7, 12])
  })

  test('after two minutes the count alone decides, so a dropped transaction leaves no gap for good', async () => {
    nonces.length = 0
    const r = relayer(() => 41)
    await r.send({ to: TO, value: 1n })
    ;(r as unknown as { lastSent: { nonce: number; at: number } }).lastSent.at -= 121_000
    await r.send({ to: TO, value: 1n })
    expect(nonces).toEqual([41, 41])
  })
})
