import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, numberToHex, zeroAddress, type Hex, type PublicClient } from 'viem'
import { positionEventsAbi } from '@mamoru/projector'
import { baseRegistry, address } from '@mamoru/registry'
import { historyCursor, readPositionHistory, readPositionHistoryFrom as readFrom, type HistoryCursor } from '../src/index.ts'

// Read and commit, as a consistent observe() does.
async function readPositionHistoryFrom(client: PublicClient, cursor: HistoryCursor, ...rest: [readonly bigint[], bigint, bigint, bigint]) {
  const { events, next } = await readFrom(client, cursor, ...rest)
  Object.assign(cursor, next)
  return events
}

const NPM = address('NonfungiblePositionManager', baseRegistry)

type Raw = { eventName: 'DecreaseLiquidity' | 'Collect'; tokenId: bigint; block: bigint; logIndex: number }

// Fake client: serves logs by tokenId and block range, and records every range asked.
function fakeClient(logs: Raw[]) {
  const ranges: [bigint, bigint][] = []
  const forks = new Set<bigint>()
  const client = {
    async getBlock({ blockNumber }: any) {
      return { number: blockNumber, hash: `0x${forks.has(blockNumber) ? 'f' : 'a'}${blockNumber.toString(16)}` }
    },
    // One eth_getLogs for both events: topic 0 is either signature, topic 1 any of the tokenIds.
    async request({ params: [filter] }: any) {
      const [fromBlock, toBlock] = [BigInt(filter.fromBlock), BigInt(filter.toBlock)]
      ranges.push([fromBlock, toBlock])
      const ids = new Set((filter.topics[1] as Hex[]).map((t) => String(BigInt(t))))
      return logs
        .filter((l) => ids.has(String(l.tokenId)) && l.block >= fromBlock && l.block <= toBlock)
        .map((l) => ({
          address: NPM,
          topics: encodeEventTopics({ abi: positionEventsAbi, eventName: l.eventName, args: { tokenId: l.tokenId } }),
          data: encodeAbiParameters([{ type: l.eventName === 'Collect' ? 'address' : 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [l.eventName === 'Collect' ? zeroAddress : 0n, 1n, 2n]),
          logIndex: numberToHex(l.logIndex),
          blockNumber: numberToHex(l.block),
          blockHash: `0x${'00'.repeat(32)}`,
          transactionHash: `0x${'01'.repeat(32)}`,
          transactionIndex: '0x0',
          removed: false,
        }))
    },
  } as unknown as PublicClient
  return { client, ranges, forks }
}

const LOGS: Raw[] = [
  { eventName: 'DecreaseLiquidity', tokenId: 1n, block: 105n, logIndex: 0 },
  { eventName: 'Collect', tokenId: 1n, block: 105n, logIndex: 1 },
  { eventName: 'Collect', tokenId: 2n, block: 140n, logIndex: 0 },
  { eventName: 'DecreaseLiquidity', tokenId: 1n, block: 190n, logIndex: 3 },
]

const key = (e: { tokenId: bigint; blockNumber: bigint; logIndex: number; kind: string }) => `${e.kind}:${e.tokenId}@${e.blockNumber}.${e.logIndex}`

describe('readPositionHistoryFrom', () => {
  test('matches a full read and only scans new blocks on the next call', async () => {
    const { client, ranges } = fakeClient(LOGS)
    const cursor = historyCursor()
    const first = await readPositionHistoryFrom(client, cursor, [1n, 2n], 100n, 150n, 145n)
    expect(first.map(key)).toEqual((await readPositionHistory(client, [1n, 2n], 100n, 150n)).map(key))
    expect(cursor.through).toBe(145n)
    ranges.length = 0
    const second = await readPositionHistoryFrom(client, cursor, [1n, 2n], 100n, 200n, 195n)
    // Second call: the stable part from 146, the unsafe tail from 196; nothing below the cursor again.
    expect(ranges).toEqual([[146n, 195n], [196n, 200n]])
    expect(cursor.through).toBe(195n)
    expect(cursor.events.every((e) => e.blockNumber <= 195n)).toBe(true)
    expect(second.map(key)).toEqual((await readPositionHistory(client, [1n, 2n], 100n, 200n)).map(key))
  })

  test('backfills a tokenId added after the cursor moved', async () => {
    const { client } = fakeClient(LOGS)
    const cursor = historyCursor()
    await readPositionHistoryFrom(client, cursor, [1n], 100n, 150n, 150n)
    const both = await readPositionHistoryFrom(client, cursor, [1n, 2n], 100n, 150n, 150n)
    expect(both.map(key)).toEqual((await readPositionHistory(client, [1n, 2n], 100n, 150n)).map(key))
  })

  test('keeps nothing above the safe block', async () => {
    const { client } = fakeClient(LOGS)
    const cursor = historyCursor()
    const r = await readPositionHistoryFrom(client, cursor, [1n], 100n, 200n, 150n)
    expect(r.map(key)).toContain('decrease:1@190.3')
    expect(cursor.events.some((e) => e.blockNumber > 150n)).toBe(false)
  })

  test('the caller\'s safe block hash stands in for the reads of that block', async () => {
    const { client } = fakeClient(LOGS)
    const asked: bigint[] = []
    const getBlock = (client as any).getBlock
    ;(client as any).getBlock = async (q: any) => (asked.push(q.blockNumber), getBlock(q))
    const cursor = historyCursor()
    await readFrom(client, cursor, [1n], 100n, 150n, 145n, '0xa91').then(({ next }) => Object.assign(cursor, next))
    // Only the read after the logs: the hash before them is the caller's.
    expect(asked).toEqual([145n])
    expect(cursor.hash).toBe('0xa91')
    // Same safe block on the next call: the cursor is checked against the caller's hash, with no request.
    asked.length = 0
    await readFrom(client, cursor, [1n], 100n, 160n, 145n, '0xa91')
    expect(asked).toEqual([])
    // A caller's hash that differs from the cursor's is a reorg: start over.
    const { next } = await readFrom(client, cursor, [1n], 100n, 160n, 145n, '0xf91')
    expect(next.through).toBe(99n)
  })

  test('the cursor moves only when the block that ends the range still has its hash after the log read', async () => {
    const { client, forks } = fakeClient(LOGS)
    const order: string[] = []
    const [getBlock, request] = [(client as any).getBlock, (client as any).request]
    ;(client as any).getBlock = async (q: any) => (order.push(`block ${q.blockNumber}`), getBlock(q))
    ;(client as any).request = async (q: any) => (order.push('logs'), request(q))
    const cursor = historyCursor()
    await readFrom(client, cursor, [1n], 100n, 150n, 145n, '0xa91').then(({ next }) => Object.assign(cursor, next))
    // Stable range, then its last block, then the tail.
    expect(order).toEqual(['logs', 'block 145', 'logs'])
    // A log provider on another view of block 190 (the hash the caller holds is not the one read after the logs).
    forks.add(190n)
    const { next } = await readFrom(client, cursor, [1n], 100n, 200n, 190n, '0xabe')
    expect(next.through).toBe(145n)
    expect(next.hash).toBe('0xa91')
    expect(next.events.some((e) => e.blockNumber > 145n)).toBe(false)
  })

  test('a backfill whose cursor block changed during the read is thrown away', async () => {
    const { client, forks } = fakeClient(LOGS)
    const cursor = historyCursor()
    await readPositionHistoryFrom(client, cursor, [2n], 100n, 150n, 150n)
    const request = (client as any).request
    let first = true
    ;(client as any).request = async (q: any) => {
      // The backfill of tokenId 1 is the first log read; block 150 changes under it.
      if (first) forks.add(150n)
      first = false
      return request(q)
    }
    const { events, next } = await readFrom(client, cursor, [1n, 2n], 100n, 150n, 150n)
    // Read again from the origin on the new view, with a cursor that holds the new hash.
    expect(next.hash).toBe('0xf96')
    expect(events.map(key)).toEqual((await readPositionHistory(client, [1n, 2n], 100n, 150n)).map(key))
  })

  test('a tokenId the caller no longer wants is left out of the tail', async () => {
    const { client } = fakeClient(LOGS)
    const cursor = historyCursor()
    await readPositionHistoryFrom(client, cursor, [1n, 2n], 100n, 120n, 120n)
    const r = await readPositionHistoryFrom(client, cursor, [2n], 100n, 200n, 150n)
    expect(r.map(key)).toEqual(['collect:2@140.0'])
    // The cursor still follows both ids below the safe block.
    expect(cursor.events.map(key)).toContain('decrease:1@105.0')
  })

  test('no tokenIds reads nothing', async () => {
    const { client, ranges } = fakeClient(LOGS)
    expect(await readPositionHistoryFrom(client, historyCursor(), [], 100n, 200n, 150n)).toEqual([])
    expect(ranges.length).toBe(0)
  })

  test('a safe head below the origin reads nothing before the origin', async () => {
    const { client } = fakeClient([...LOGS, { eventName: 'Collect', tokenId: 1n, block: 90n, logIndex: 0 }])
    const r = await readPositionHistoryFrom(client, historyCursor(), [1n], 100n, 150n, 80n)
    expect(r.map(key)).toEqual((await readPositionHistory(client, [1n], 100n, 150n)).map(key))
  })

  test('a safe head that moves back does not count a block twice', async () => {
    const { client } = fakeClient(LOGS)
    const cursor = historyCursor()
    await readPositionHistoryFrom(client, cursor, [2n], 100n, 150n, 145n)
    const r = await readPositionHistoryFrom(client, cursor, [2n], 100n, 150n, 130n)
    expect(r.map(key)).toEqual((await readPositionHistory(client, [2n], 100n, 150n)).map(key))
  })

  test('a new origin starts the cursor over', async () => {
    const { client } = fakeClient([...LOGS, { eventName: 'Collect', tokenId: 1n, block: 90n, logIndex: 0 }])
    const cursor = historyCursor()
    await readPositionHistoryFrom(client, cursor, [1n], 100n, 150n, 150n)
    const r = await readPositionHistoryFrom(client, cursor, [1n], 80n, 150n, 150n)
    expect(r.map(key)).toEqual((await readPositionHistory(client, [1n], 80n, 150n)).map(key))
  })

  test('a reorged cursor block rereads the history', async () => {
    const logs = [...LOGS]
    const { client, forks } = fakeClient(logs)
    const cursor = historyCursor()
    await readPositionHistoryFrom(client, cursor, [1n], 100n, 150n, 150n)
    // The event at 105 is gone on the new chain, and block 150 has a new hash.
    logs.splice(0, 2)
    forks.add(150n)
    const r = await readPositionHistoryFrom(client, cursor, [1n], 100n, 150n, 150n)
    expect(r.map(key)).toEqual([])
  })

  test('an uncommitted read leaves the cursor as it was', async () => {
    const { client } = fakeClient(LOGS)
    const cursor = historyCursor()
    const { next } = await readFrom(client, cursor, [1n], 100n, 150n, 150n)
    expect(next.through).toBe(150n)
    expect(cursor.through).toBe(-1n)
    expect(cursor.events).toEqual([])
  })

  test('a reorg during the read does not move the cursor', async () => {
    const { client, forks } = fakeClient(LOGS)
    const request = (client as any).request
    ;(client as any).request = async (q: any) => {
      forks.add(150n)
      return request(q)
    }
    const { events, next } = await readFrom(client, historyCursor(), [1n], 100n, 150n, 150n)
    expect(next.through).toBe(99n)
    expect(next.events).toEqual([])
    expect(events.map(key)).toEqual(['decrease:1@105.0', 'collect:1@105.1'])
  })

  test('a head behind the cursor reads in full and keeps the cursor', async () => {
    const { client } = fakeClient(LOGS)
    const cursor = historyCursor()
    await readPositionHistoryFrom(client, cursor, [1n, 2n], 100n, 150n, 150n)
    ;(client as any).getBlock = async ({ blockNumber }: any) => {
      if (blockNumber > 140n) throw new Error('BlockNotFoundError')
      return { number: blockNumber, hash: `0xa${blockNumber.toString(16)}` }
    }
    const { events, next } = await readFrom(client, cursor, [1n, 2n], 100n, 140n, 130n)
    expect(events.map(key)).toEqual((await readPositionHistory(client, [1n, 2n], 100n, 140n)).map(key))
    expect(next.through).toBe(150n)
  })
})

describe('readPositionHistoryFrom catching up in slices (catchUpBlocks)', () => {
  const read = (client: PublicClient, cursor: HistoryCursor, ids: bigint[], to: bigint, safe: bigint) =>
    readFrom(client, cursor, ids, 100n, to, safe, undefined, baseRegistry, 30n).then((r) => (Object.assign(cursor, r.next), r.events))

  test('a cold cursor reads its range in slices up to the safe block, then the tail, and matches a full read', async () => {
    const { client, ranges } = fakeClient(LOGS)
    const cursor = historyCursor()
    const events = await read(client, cursor, [1n, 2n], 200n, 195n)
    const full = await readPositionHistory(fakeClient(LOGS).client, [1n, 2n], 100n, 200n)
    expect(events.map(key)).toEqual(full.map(key))
    expect(ranges.every(([a, b]) => b - a + 1n <= 30n)).toBe(true)
    expect(cursor.through).toBe(195n)
  })

  test('out of time, the slices read are kept and the next call goes on from there', async () => {
    const { client, ranges } = fakeClient(LOGS)
    const cursor = historyCursor()
    const realNow = Date.now
    let t = realNow()
    Date.now = () => (t += 10_000)
    try {
      await expect(read(client, cursor, [1n, 2n], 400n, 395n)).rejects.toThrow('history: cursor read to block')
    } finally {
      Date.now = realNow
    }
    const kept = cursor.through
    expect(kept).toBeGreaterThan(99n)
    expect(kept).toBeLessThan(365n)
    ranges.length = 0
    const events = await read(client, cursor, [1n, 2n], 400n, 395n)
    expect(ranges[0]![0]).toBe(kept + 1n)
    expect(events.map(key)).toEqual((await readPositionHistory(fakeClient(LOGS).client, [1n, 2n], 100n, 400n)).map(key))
  })

  test('a tokenId new to a cursor far from its origin is backfilled in slices, kept across calls', async () => {
    const { client, ranges } = fakeClient(LOGS)
    const cursor = historyCursor()
    await read(client, cursor, [1n], 200n, 200n)
    const realNow = Date.now
    let t = realNow()
    Date.now = () => (t += 10_000)
    try {
      await expect(read(client, cursor, [1n, 2n], 200n, 200n)).rejects.toThrow('history: backfill read to block')
    } finally {
      Date.now = realNow
    }
    expect(cursor.ids.has('2')).toBe(false)
    const part = cursor.backfill!.through
    expect(part).toBeGreaterThan(99n)
    ranges.length = 0
    const events = await read(client, cursor, [1n, 2n], 200n, 200n)
    expect(ranges[0]![0]).toBe(part + 1n)
    expect(cursor.ids.has('2')).toBe(true)
    expect(cursor.backfill).toBeNull()
    expect(events.map(key)).toEqual((await readPositionHistory(fakeClient(LOGS).client, [1n, 2n], 100n, 200n)).map(key))
  })

  test('a slice whose end changes hash during its read fails and keeps nothing of it', async () => {
    const { client, forks } = fakeClient(LOGS)
    const cursor = historyCursor()
    const flip = client.request.bind(client)
    ;(client as any).request = async (args: any) => {
      const r = await flip(args)
      if (BigInt(args.params[0].toBlock) === 129n) forks.add(129n)
      return r
    }
    await expect(read(client, cursor, [1n, 2n], 200n, 195n)).rejects.toThrow('changed hash')
    expect(cursor.through).toBe(-1n)
  })

  test('without catchUpBlocks a cold cursor is one read, as before', async () => {
    const { client, ranges } = fakeClient(LOGS)
    await readPositionHistoryFrom(client, historyCursor(), [1n, 2n], 100n, 200n, 195n)
    expect(ranges[0]).toEqual([100n, 195n])
  })
})
