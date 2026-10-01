import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { historyCursor, readPositionHistory, readPositionHistoryFrom } from '../src/index.ts'

type Raw = { eventName: 'DecreaseLiquidity' | 'Collect'; tokenId: bigint; block: bigint; logIndex: number }

// Fake client: serves logs by event name, tokenId and block range, and records every range asked.
function fakeClient(logs: Raw[]) {
  const ranges: [bigint, bigint][] = []
  const client = {
    async getLogs({ event, args, fromBlock, toBlock }: any) {
      ranges.push([fromBlock, toBlock])
      const ids = new Set((args.tokenId as bigint[]).map(String))
      return logs
        .filter((l) => l.eventName === event.name && ids.has(String(l.tokenId)) && l.block >= fromBlock && l.block <= toBlock)
        .map((l) => ({ eventName: l.eventName, args: { tokenId: l.tokenId, amount0: 1n, amount1: 2n }, logIndex: l.logIndex, blockNumber: l.block, transactionHash: '0x01' }))
    },
  } as unknown as PublicClient
  return { client, ranges }
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
})
