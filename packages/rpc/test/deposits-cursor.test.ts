import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { baseRegistry } from '@mamoru/registry'
import { depositsCursor, readDeposits, type ObserveInput } from '../src/index.ts'

const ACCT = '0x00000000000000000000000000000000000000aa'
const FROM = '0x00000000000000000000000000000000000000bb'

// Fake client: one transfer to the account per listed block; records every range asked; `forks` changes a block's hash.
function fakeClient(blocks: bigint[]) {
  const ranges: [bigint, bigint][] = []
  const forks = new Set<bigint>()
  let flipAfterRead: bigint | null = null
  const client = {
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { number: blockNumber, hash: `0x${forks.has(blockNumber) ? 'f' : 'a'}${blockNumber.toString(16)}` }
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      ranges.push([fromBlock, toBlock])
      if (flipAfterRead !== null && toBlock === flipAfterRead) forks.add(flipAfterRead)
      return blocks
        .filter((b) => b >= fromBlock && b <= toBlock)
        .map((b) => ({ args: { from: FROM, to: ACCT, value: 1n }, blockNumber: b, transactionHash: `0x${b.toString(16)}`, logIndex: 0 }))
    },
  } as unknown as PublicClient
  return { client, ranges, forks, flipAt: (b: bigint) => (flipAfterRead = b) }
}

const input = (over: Partial<ObserveInput>): ObserveInput => ({ depositsAfter: 0n, savingsAsset: 'USDC', registry: baseRegistry, ...over }) as ObserveInput
const at = (d: { block: bigint }[]) => d.map((x) => x.block)

describe('readDeposits catching up on a long gap', () => {
  test('without catchUpBlocks a gap is one read, as before', async () => {
    const { client, ranges } = fakeClient([150n])
    const d = await readDeposits(client, ACCT, input({ depositsAfter: 100n }), 1000n, 990n)
    expect(at(d)).toEqual([150n])
    expect(ranges).toEqual([[101n, 1000n]])
  })

  test('a gap within one slice is one read', async () => {
    const { client, ranges } = fakeClient([150n])
    const cursor = depositsCursor()
    await readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 1000n, depositsCursor: cursor }), 1000n, 990n)
    expect(ranges).toEqual([[101n, 1000n]])
  })

  test('a wider gap is read in slices up to the safe head, then the tail, and finds every deposit once', async () => {
    const { client, ranges } = fakeClient([150n, 420n, 980n, 995n])
    const cursor = depositsCursor()
    const d = await readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 300n, depositsCursor: cursor }), 1000n, 990n)
    expect(ranges).toEqual([[101n, 400n], [401n, 700n], [701n, 1000n]])
    expect(at(d)).toEqual([150n, 420n, 980n, 995n])
    expect(d.find((x) => x.block === 995n)!.safe).toBe(false)
    expect(cursor.through).toBe(700n)
  })

  test('slices already read are not read again by the next observation', async () => {
    const { client, ranges } = fakeClient([150n, 1200n])
    const cursor = depositsCursor()
    await readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 300n, depositsCursor: cursor }), 1000n, 990n)
    ranges.length = 0
    const d = await readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 300n, depositsCursor: cursor }), 1300n, 1290n)
    expect(ranges).toEqual([[701n, 1000n], [1001n, 1300n]])
    expect(at(d)).toEqual([150n, 1200n])
  })

  test('a cursor read for another depositsAfter starts over', async () => {
    const { client, ranges } = fakeClient([150n, 820n])
    const cursor = depositsCursor()
    await readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 300n, depositsCursor: cursor }), 1000n, 990n)
    ranges.length = 0
    const d = await readDeposits(client, ACCT, input({ depositsAfter: 500n, catchUpBlocks: 300n, depositsCursor: cursor }), 1000n, 990n)
    expect(ranges[0]).toEqual([501n, 800n])
    expect(at(d)).toEqual([820n])
  })

  test('a reorg of the last block kept starts over', async () => {
    const { client, ranges, forks } = fakeClient([150n])
    const cursor = depositsCursor()
    await readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 300n, depositsCursor: cursor }), 1000n, 990n)
    forks.add(700n)
    ranges.length = 0
    await readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 300n, depositsCursor: cursor }), 1000n, 990n)
    expect(ranges[0]).toEqual([101n, 400n])
  })

  test('a slice whose end changes hash during its read fails the observation and is not kept', async () => {
    const { client, flipAt } = fakeClient([150n])
    const cursor = depositsCursor()
    flipAt(400n)
    await expect(readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 300n, depositsCursor: cursor }), 1000n, 990n)).rejects.toThrow('changed hash')
    expect(cursor.through).toBe(100n)
    expect(cursor.deposits).toEqual([])
  })

  test('a gap too long for one observation keeps what it read and fails, and the next one goes on from there', async () => {
    const { client, ranges } = fakeClient([150n, 5000n])
    const cursor = depositsCursor()
    const realNow = Date.now
    let t = realNow()
    // Each slice takes 10 s of the 30 s an observation reads for.
    Date.now = () => (t += 5_000)
    try {
      await expect(readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 300n, depositsCursor: cursor }), 10_000n, 9_990n)).rejects.toThrow('deposits: read to block')
    } finally {
      Date.now = realNow
    }
    const kept = cursor.through
    expect(kept).toBeGreaterThan(100n)
    expect(kept).toBeLessThan(9_690n)
    ranges.length = 0
    const d = await readDeposits(client, ACCT, input({ depositsAfter: 100n, catchUpBlocks: 300n, depositsCursor: cursor }), 10_000n, 9_990n)
    expect(ranges[0]![0]).toBe(kept + 1n)
    expect(at(d)).toEqual([150n, 5000n])
  })
})
