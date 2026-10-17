import { afterAll, describe, expect, test } from 'bun:test'
import { parseTransaction, type Hex, type PublicClient } from 'viem'
import { Relayer, SendExpired } from '../src/relayer.ts'

// A JSON-RPC stub that takes any raw transaction and remembers the nonce it carried.
const nonces: number[] = []
/** Every method the stub was asked, in order. */
const calls: string[] = []
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    type Call = { id: number; method: string; params: unknown[] }
    const one = (m: Call) => {
      calls.push(m.method)
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
function relayer(count: () => number, order?: string[]) {
  const client = {
    estimateGas: async () => 21_000n,
    estimateFeesPerGas: async () => (order?.push('fees'), { maxFeePerGas: 6_000_000n, maxPriorityFeePerGas: 1_000_000n }),
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
    const r = relayer(() => (order.push('count'), 3), order)
    await r.send({ to: TO, value: 1n }, () => order.push('sent'), () => (calls.push('mark'), order.push(`sending:${nonces.length}`)))
    expect(order).toEqual(['count', 'fees', 'sending:0', 'sent'])
    // After onSending the provider was asked for one thing only: to take the signed transaction.
    expect(calls.slice(calls.lastIndexOf('mark') + 1)).toEqual(['eth_sendRawTransaction'])
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

// otto/mamoru#15: a job that carries a time limit (a swap deadline) is checked last, after the queue and every read,
// against the later of the wall clock and the chain head; past it nothing is broadcast, on any attempt.
describe('a job with a time limit is never broadcast past it', () => {
  const wall = () => BigInt(Math.floor(Date.now() / 1000))
  /** A relayer whose chain head is `head.t` and whose receipts wait for `gate` when one is set. */
  function timed(head: { t: bigint | null }, gate?: { wait: Promise<void> }) {
    const client = {
      estimateGas: async () => 21_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 6_000_000n, maxPriorityFeePerGas: 1_000_000n }),
      getTransactionCount: async () => 9,
      getBlock: async () => {
        if (head.t === null) throw new Error('HTTP request failed. Status: 503')
        return { timestamp: head.t }
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (gate) await gate.wait
        return { transactionHash: hash, status: 'success', blockNumber: 1n, logs: [] }
      },
    } as unknown as PublicClient
    return new Relayer(`0x${'11'.repeat(32)}`, client, `http://127.0.0.1:${server.port}`, 8453)
  }
  const limit = (at: bigint) => ({ at, code: 'RESERVE_SWAP_EXPIRED' })

  test('in time it goes out like any other', async () => {
    nonces.length = 0
    const r = timed({ t: wall() })
    await r.send({ to: TO, data: '0x01', notAfter: limit(wall() + 3600n) })
    expect(nonces).toHaveLength(1)
  })

  test('one that expires while queued behind another is dropped with its code, never broadcast', async () => {
    nonces.length = 0
    const head = { t: wall() as bigint | null }
    let open!: () => void
    const gate = { wait: new Promise<void>((r) => (open = r)) }
    const r = timed(head, gate)
    let marked = false
    const first = r.send({ to: TO, value: 1n })
    const second = r.send({ to: TO, data: '0x01', notAfter: limit(wall() + 3600n) }, undefined, () => (marked = true)).catch((e: unknown) => e)
    await Bun.sleep(20)
    // In time when it was queued; the chain moves past the limit while the first send waits for its receipt.
    expect(nonces).toHaveLength(1)
    head.t = wall() + 7200n
    open()
    await first
    const e = await second
    expect(e).toBeInstanceOf(SendExpired)
    expect((e as SendExpired).code).toBe('RESERVE_SWAP_EXPIRED')
    expect(marked).toBe(false)
    expect(nonces).toHaveLength(1)
  })

  test('a retry past the limit is never broadcast, by the wall clock alone when the head cannot be read', async () => {
    nonces.length = 0
    const head = { t: wall() as bigint | null }
    const r = timed(head)
    const job = { to: TO, data: '0x01' as Hex, notAfter: limit(wall() + 3600n) }
    await r.send(job)
    expect(nonces).toHaveLength(1)
    // The same job again (a retry): the head is past its limit now.
    head.t = wall() + 3600n
    expect(await r.send(job).catch((e: unknown) => e)).toBeInstanceOf(SendExpired)
    // And with the head unreadable, the wall clock past the limit still stops it.
    head.t = null
    expect(await r.send({ ...job, notAfter: limit(wall()) }).catch((e: unknown) => e)).toBeInstanceOf(SendExpired)
    expect(nonces).toHaveLength(1)
  })
})
