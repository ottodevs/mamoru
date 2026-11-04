// otto/mamoru#358: live 4 Nov (b54dda3a@143), every Monad harvest timed out. Its prepare re-read the position history
// from the account's activation (838k blocks, ~8,400 getLogs of 100 blocks) although the observation's cursor already
// held it. `principalOwed` is private: reached with a cast, like engine-vault.test.ts.
import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, numberToHex, toEventSelector, type Hex, type PublicClient } from 'viem'
import type { ChainPositionEvent } from '@mamoru/rpc'
import { address, baseRegistry } from '@mamoru/registry'
import { positionEventsAbi } from '@mamoru/projector'
import { Engine } from './engine.ts'

const TX = `0x${'00'.repeat(32)}` as Hex
const ev = (kind: 'decrease' | 'collect', blockNumber: bigint, amount0: bigint, logIndex = 0, tokenId = 7n): ChainPositionEvent => ({ kind, tokenId, amount0, amount1: 0n, logIndex, blockNumber, txHash: TX })

/** A raw DecreaseLiquidity log of token 7, as eth_getLogs answers it. */
const decreaseLog = (blockNumber: bigint, logIndex: number, amount0: bigint) => ({
  address: address('NonfungiblePositionManager', baseRegistry),
  topics: [toEventSelector(positionEventsAbi[1]), numberToHex(7n, { size: 32 })],
  data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [1n, amount0, 0n]),
  blockNumber: numberToHex(blockNumber),
  logIndex: numberToHex(logIndex),
  transactionHash: TX,
  blockHash: TX,
  transactionIndex: '0x0',
  removed: false,
})

function engine(cursor: { fromBlock: bigint; through: bigint; ids: string[]; events: ChainPositionEvent[] }, tailLogs: unknown[] = []) {
  const ranges: { from: bigint; to: bigint }[] = []
  const client = {
    request: async ({ method, params }: { method: string; params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      ranges.push({ from: BigInt(params[0].fromBlock), to: BigInt(params[0].toBlock) })
      return tailLogs
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

describe('principal owed: the cursor and its tail together (review of #358)', () => {
  test('a tail event after the cursor counts once; a cursor event above `through` is never counted with it', async () => {
    const stray = ev('decrease', 900_005n, 1_000n)
    const { owed } = engine({ fromBlock: 100n, through: 900_000n, ids: ['7'], events: [ev('decrease', 200n, 50n), stray] }, [decreaseLog(900_005n, 2, 7n)])
    expect((await owed(7n, { block: 900_010n, logIndex: 0 })).get(7n)).toEqual([57n, 0n])
  })

  test('chain order whatever the cursor order (a backfill appends older events after newer ones), and a cut after `through`', async () => {
    // Out of order in the cursor: a collect at 300 before the decrease at 200 would clamp to nothing if folded as stored.
    const { owed, ranges } = engine({ fromBlock: 100n, through: 900_000n, ids: ['7'], events: [ev('collect', 300n, 20n), ev('decrease', 200n, 50n)] }, [decreaseLog(900_005n, 1, 4n), decreaseLog(900_005n, 4, 9n)])
    expect((await owed(7n, { block: 900_005n, logIndex: 3 })).get(7n)).toEqual([34n, 0n])
    expect(ranges).toEqual([{ from: 900_001n, to: 900_005n }])
  })
})
