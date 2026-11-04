// otto/mamoru#358: live 4 Nov (b54dda3a@143), every Monad harvest timed out. Its prepare re-read the position history
// from the account's activation (838k blocks, ~8,400 getLogs of 100 blocks) although the observation's cursor already
// held it. `principalOwed` is private: reached with a cast, like engine-vault.test.ts.
import { describe, expect, test } from 'bun:test'
import type { Hex, PublicClient } from 'viem'
import type { ChainPositionEvent } from '@mamoru/rpc'
import { baseRegistry } from '@mamoru/registry'
import { Engine } from './engine.ts'

const TX = `0x${'00'.repeat(32)}` as Hex
const ev = (kind: 'decrease' | 'collect', blockNumber: bigint, amount0: bigint, logIndex = 0, tokenId = 7n): ChainPositionEvent => ({ kind, tokenId, amount0, amount1: 0n, logIndex, blockNumber, txHash: TX })

function engine(cursor: { fromBlock: bigint; through: bigint; ids: string[]; events: ChainPositionEvent[] }) {
  const ranges: { from: bigint; to: bigint }[] = []
  const client = {
    request: async ({ method, params }: { method: string; params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      ranges.push({ from: BigInt(params[0].fromBlock), to: BigInt(params[0].toBlock) })
      return []
    },
  } as unknown as PublicClient
  const e = Object.assign(Object.create(Engine.prototype) as Engine, {
    client,
    registry: baseRegistry,
    historyFromBlock: 100n,
    historyCursor: { fromBlock: cursor.fromBlock, through: cursor.through, hash: '0x01', ids: new Set(cursor.ids), events: cursor.events },
  })
  const owed = (tokenId: bigint, at: { block: bigint; logIndex: number }) => (e as unknown as { principalOwed: (t: bigint, a: typeof at) => Promise<Map<bigint, [bigint, bigint]>> }).principalOwed(tokenId, at)
  return { owed, ranges }
}

describe('principal owed from the observation cursor (otto/mamoru#358)', () => {
  test('a held tokenId: the cursor events plus only the blocks after it, never from activation', async () => {
    const { owed, ranges } = engine({ fromBlock: 100n, through: 900_000n, ids: ['7'], events: [ev('decrease', 200n, 50n), ev('collect', 300n, 20n), ev('decrease', 400n, 5n, 0, 8n)] })
    expect((await owed(7n, { block: 900_010n, logIndex: 0 })).get(7n)).toEqual([30n, 0n])
    expect(ranges).toEqual([{ from: 900_001n, to: 900_009n }])
  })

  test('a cut inside the cursor: only events before (block, logIndex), no read at all', async () => {
    const { owed, ranges } = engine({ fromBlock: 100n, through: 900_000n, ids: ['7'], events: [ev('decrease', 200n, 50n, 1), ev('collect', 200n, 20n, 3)] })
    expect((await owed(7n, { block: 200n, logIndex: 3 })).get(7n)).toEqual([50n, 0n])
    expect(ranges).toEqual([])
  })

  test('a tokenId the cursor does not hold, or a cursor of another origin: read in full from activation, as before', async () => {
    for (const c of [{ fromBlock: 100n, ids: ['9'] }, { fromBlock: 50n, ids: ['7'] }]) {
      const { owed, ranges } = engine({ ...c, through: 900_000n, events: [] })
      await owed(7n, { block: 900_010n, logIndex: 0 })
      expect(ranges).toEqual([{ from: 100n, to: 900_009n }])
    }
  })
})
