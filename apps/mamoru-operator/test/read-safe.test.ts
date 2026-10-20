import { describe, expect, test } from 'bun:test'
import type { Address } from '@mamoru/domain'
import { baseRegistry, address } from '@mamoru/registry'
import { FakeChain } from '../../../packages/rpc/test/fake-chain.ts'
import { readSafe } from '../src/chain.ts'

const SAFE = '0x00000000000000000000000000000000000000aa' as Address

// otto/mamoru#135: an open home tab polled this every 6 s at 81 CU a call (eth_blockNumber + eth_getCode + 2
// eth_call). Target: no eth_blockNumber ever, no eth_getCode once the Safe's deployment is confirmed, 52 CU
// (two eth_call) for an account with a position, 26 for one with none.
describe('readSafe (otto/mamoru#135)', () => {
  test('no eth_blockNumber, ever: it rides inside the first Multicall3 call', async () => {
    const chain = new FakeChain()
    chain.code.set(SAFE.toLowerCase(), '0x6001')
    await readSafe(chain.client, SAFE)
    expect(chain.count('eth_blockNumber')).toBe(0)
  })

  test('an account with no position: one eth_call', async () => {
    const chain = new FakeChain()
    chain.code.set(SAFE.toLowerCase(), '0x6001')
    const r = await readSafe(chain.client, SAFE)
    expect(chain.count('eth_call')).toBe(1)
    expect(r.positions).toEqual([])
  })

  test('an account with one position: two eth_call, the one more request is the positions round', async () => {
    const chain = new FakeChain()
    chain.code.set(SAFE.toLowerCase(), '0x6001')
    chain.addPosition(SAFE, 7n, 'pool:USDC/cbBTC/500')
    const r = await readSafe(chain.client, SAFE)
    expect(chain.count('eth_call')).toBe(2)
    expect(r.positions).toHaveLength(1)
    expect(r.positions[0]!.tokenId).toBe(7n)
  })

  // Review finding 7: the one-more-request round of an account with more positions than the speculative ones is
  // pinned to the block the first call answered at, never to a placeholder block 0.
  test('more positions than the speculative round: the extra round is pinned to the block the first call read', async () => {
    const chain = new FakeChain()
    chain.code.set(SAFE.toLowerCase(), '0x6001')
    for (let i = 1n; i <= 10n; i++) chain.addPosition(SAFE, i, 'pool:USDC/cbBTC/500')
    const r = await readSafe(chain.client, SAFE)
    expect(r.positions.map((p) => p.tokenId)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n])
    const tags = chain.requests.filter((q) => q.method === 'eth_call').map((q) => (q.params as unknown[])[1])
    expect(tags.slice(1).every((t) => t === '0x3e8')).toBe(true)
    expect(tags).not.toContain('0x0')
  })

  test('deployed: eth_getCode costs during warm-up, then never again once confirmed', async () => {
    const chain = new FakeChain()
    chain.code.set(SAFE.toLowerCase(), '0x6001')
    const first = await readSafe(chain.client, SAFE)
    expect(first.deployed).toBe(true)
    expect(chain.count('eth_getCode')).toBe(1)
    // Still close to the sighting (well under the ~450-block stand-in for the safe tag): asked again.
    chain.head += 10n
    await readSafe(chain.client, SAFE)
    expect(chain.count('eth_getCode')).toBe(2)
    // Far enough past the sighting now: one more read confirms it (at the safe-ish block).
    chain.head = 1_500n
    await readSafe(chain.client, SAFE)
    const confirmedAt = chain.count('eth_getCode')
    expect(confirmedAt).toBe(3)
    // Any later read, however much later, costs none: the Safe stays deployed.
    chain.head += 1_000n
    await readSafe(chain.client, SAFE)
    chain.head += 1_000n
    await readSafe(chain.client, SAFE)
    expect(chain.count('eth_getCode')).toBe(confirmedAt)
  })

  test('not deployed: eth_getCode is asked every time, never cached as deployed', async () => {
    const chain = new FakeChain()
    const r1 = await readSafe(chain.client, SAFE)
    expect(r1.deployed).toBe(false)
    chain.head += 1_000n
    const r2 = await readSafe(chain.client, SAFE)
    expect(r2.deployed).toBe(false)
    expect(chain.count('eth_getCode')).toBe(2)
  })

  test('the block it reports is the one the batch read, from Multicall3.getBlockNumber', async () => {
    const chain = new FakeChain()
    chain.head = 1_234n
    const r = await readSafe(chain.client, SAFE)
    expect(r.block).toBe(1_234n)
  })

  // otto/mamoru#135 review finding: a block-number sub-call that fails inside the batch must fail the whole
  // read, not fall back to an unpinned, unbatched getBlockNumber() that could answer from a later block than
  // the rest of this same batch actually read.
  test('the block-number sub-call failing inside the batch fails the whole read, never an inconsistent one', async () => {
    const chain = new FakeChain()
    chain.failRead(address('Multicall3', baseRegistry), 'getBlockNumber()')
    await expect(readSafe(chain.client, SAFE)).rejects.toThrow()
    // Every other sub-call of that same batch still ran: only the one call failed.
    expect(chain.count('eth_call')).toBe(1)
    expect(chain.count('eth_blockNumber')).toBe(0)
  })
})
