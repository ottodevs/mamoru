import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { historyCursor, readPositionHistory, readPositionHistoryFrom as readFrom, type HistoryCursor } from '../src/index.ts'

// Read and commit, as a consistent observe() does.
async function readPositionHistoryFrom(client: PublicClient, cursor: HistoryCursor, ...rest: [readonly bigint[], bigint, bigint, bigint]) {
  const { events, next } = await readFrom(client, cursor, ...rest)
  Object.assign(cursor, next)
  return events
}

type Raw = { eventName: 'DecreaseLiquidity' | 'Collect'; tokenId: bigint; block: bigint; logIndex: number }

// Fake client: serves logs by event name, tokenId and block range, and records every range asked.
function fakeClient(logs: Raw[]) {
  const ranges: [bigint, bigint][] = []
  const forks = new Set<bigint>()
  const client = {
    async getBlock({ blockNumber }: any) {
      return { number: blockNumber, hash: `0x${forks.has(blockNumber) ? 'f' : 'a'}${blockNumber.toString(16)}` }
    },
    async getLogs({ event, args, fromBlock, toBlock }: any) {
      ranges.push([fromBlock, toBlock])
      const ids = new Set((args.tokenId as bigint[]).map(String))
      return logs
        .filter((l) => l.eventName === event.name && ids.has(String(l.tokenId)) && l.block >= fromBlock && l.block <= toBlock)
        .map((l) => ({ eventName: l.eventName, args: { tokenId: l.tokenId, amount0: 1n, amount1: 2n }, logIndex: l.logIndex, blockNumber: l.block, transactionHash: '0x01' }))
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
    expect(second.map(key)).toEqual((await readPositionHistory(client, [1n, 2n], 100n, 200n)).map(key))
    // Second call: stable part from 146, unsafe tail from 196; nothing below the cursor again.
    expect(ranges.slice(0, 4).every(([from]) => from >= 146n)).toBe(true)
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
    const getLogs = (client as any).getLogs
    ;(client as any).getLogs = async (q: any) => {
      forks.add(150n)
      return getLogs(q)
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
