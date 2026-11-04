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

function engine(cursor: { fromBlock: bigint; through: bigint; ids: string[]; events: ChainPositionEvent[] }, tailLogs: unknown[] = [], cfg: { historyStepBlocks?: bigint } = {}, hashOf: (n: bigint) => Hex = () => '0xaa') {
  const ranges: { from: bigint; to: bigint }[] = []
  const logs = { down: false }
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: hashOf(blockNumber) }),
    request: async ({ method, params }: { method: string; params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      if (logs.down) throw new Error('timeout')
      ranges.push({ from: BigInt(params[0].fromBlock), to: BigInt(params[0].toBlock) })
      return tailLogs
    },
  } as unknown as PublicClient
  const e = Object.assign(Object.create(Engine.prototype) as Engine, {
    client,
    registry: baseRegistry,
    historyFromBlock: 100n,
    cfg,
    heldTurn: 0,
    heldHistory: new Map(),
    historyCursor: { fromBlock: cursor.fromBlock, through: cursor.through, hash: '0x01', ids: new Set(cursor.ids), events: cursor.events },
  })
  const owed = (tokenId: bigint, at: { block: bigint; logIndex: number }, full = false) => (e as unknown as { principalOwed: (t: bigint, a: typeof at, f: boolean) => Promise<Map<bigint, [bigint, bigint]>> }).principalOwed(tokenId, at, full)
  const advance = (safe: bigint, tokenIds: bigint[]) => (e as unknown as { advanceHeldHistory: (o: unknown) => Promise<void> }).advanceHeldHistory({ safeBlock: { number: safe, hash: '0xaa' }, positions: tokenIds.map((tokenId) => ({ tokenId })) })
  return { owed, ranges, advance, logs }
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

describe('a held position the cursor does not follow, read one slice per review (otto/mamoru#358, Monad)', () => {
  const none = { fromBlock: 100n, through: 900_000n, ids: [] as string[], events: [] as ChainPositionEvent[] }

  test('under historyStepBlocks: slices of the step up to the safe block, then the harvest folds them plus the tail', async () => {
    const { owed, ranges, advance } = engine(none, [], { historyStepBlocks: 400_000n })
    await expect(owed(7n, { block: 900_010n, logIndex: 0 })).rejects.toMatchObject({ code: 'OBS_RPC_UNAVAILABLE' })
    expect(ranges).toEqual([])
    await advance(900_000n, [7n])
    await advance(900_000n, [7n])
    await advance(900_000n, [7n])
    // Within a step of the safe block it stops: the tail at harvest time reads the rest (at most a step).
    expect(ranges).toEqual([
      { from: 100n, to: 400_099n },
      { from: 400_100n, to: 800_099n },
    ])
    ranges.length = 0
    await owed(7n, { block: 900_010n, logIndex: 0 })
    expect(ranges).toEqual([{ from: 800_100n, to: 900_009n }])
  })

  test('a slice whose end block changed hash during the read does not count', async () => {
    let n = 0
    const { owed, advance } = engine(none, [], { historyStepBlocks: 2_000_000n }, () => (n++ === 0 ? '0xaa' : '0xbb'))
    await advance(900_000n, [7n])
    await expect(owed(7n, { block: 900_010n, logIndex: 0 })).rejects.toMatchObject({ code: 'OBS_RPC_UNAVAILABLE' })
  })

  test('gate: the confirm path folds what was read plus the whole rest, even past a step; never the whole history again', async () => {
    const { owed, ranges, advance } = engine(none, [], { historyStepBlocks: 400_000n })
    await advance(900_000n, [7n])
    await advance(900_000n, [7n])
    ranges.length = 0
    await owed(7n, { block: 1_300_000n, logIndex: 2 }, true)
    expect(ranges).toEqual([{ from: 800_100n, to: 1_300_000n }])
  })

  test('gate: a previous slice end that is no longer canonical starts the read over', async () => {
    let fork = false
    const { ranges, advance } = engine(none, [], { historyStepBlocks: 400_000n }, (n) => (fork && n === 400_099n ? '0xbb' : '0xaa'))
    await advance(900_000n, [7n])
    fork = true
    await advance(900_000n, [7n])
    expect(ranges).toEqual([
      { from: 100n, to: 400_099n },
      { from: 100n, to: 400_099n },
    ])
  })

  test('gate: a forked read whose re-read fails is gone at once; the harvest waits instead of folding it', async () => {
    let fork = false
    const { owed, ranges, advance, logs } = engine(none, [], { historyStepBlocks: 400_000n }, (n) => (fork && n === 800_099n ? '0xbb' : '0xaa'))
    await advance(900_000n, [7n])
    await advance(900_000n, [7n])
    expect(await owed(7n, { block: 900_010n, logIndex: 0 })).toEqual(new Map())
    fork = true
    logs.down = true
    await advance(900_000n, [7n])
    await expect(owed(7n, { block: 900_010n, logIndex: 0 })).rejects.toThrow('OBS_RPC_UNAVAILABLE')
    expect(ranges.at(-1)).toEqual({ from: 800_100n, to: 900_009n })
  })

  test('gate: one slice per review across positions, from a start that rotates', async () => {
    const { ranges, advance } = engine(none, [], { historyStepBlocks: 400_000n })
    await advance(900_000n, [7n, 8n])
    await advance(900_000n, [7n, 8n])
    await advance(900_000n, [7n, 8n])
    expect(ranges).toEqual([
      { from: 100n, to: 400_099n },
      { from: 100n, to: 400_099n },
      { from: 400_100n, to: 800_099n },
    ])
  })

  test('gate: a safe head below activation reads nothing and never moves the read back', async () => {
    const { ranges, advance } = engine(none, [], { historyStepBlocks: 400_000n })
    await advance(50n, [7n])
    expect(ranges).toEqual([])
    await advance(900_000n, [7n])
    expect(ranges).toEqual([{ from: 100n, to: 400_099n }])
  })

  test('the confirm path (`full`) and chains without a step read in full, as before; without a step nothing is read ahead', async () => {
    const a = engine(none, [], { historyStepBlocks: 400_000n })
    await a.owed(7n, { block: 900_010n, logIndex: 0 }, true)
    expect(a.ranges).toEqual([{ from: 100n, to: 900_009n }])
    const b = engine(none)
    await b.advance(900_000n, [7n])
    expect(b.ranges).toEqual([])
    await b.owed(7n, { block: 900_010n, logIndex: 0 })
    expect(b.ranges).toEqual([{ from: 100n, to: 900_009n }])
  })
})
