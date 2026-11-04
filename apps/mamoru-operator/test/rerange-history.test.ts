import { describe, expect, test } from 'bun:test'
import { heldHistorySeedOf, outOfRangeSeedOf, rerangeHistoryOf } from '../src/operator.ts'
import { outOfRangeFromSeed, OUT_OF_RANGE_SEED_GAP_S } from '@mamoru/scenarios/driver/engine.ts'
import type { StoredOp } from '../src/state.ts'

// otto/mamoru#218: a restarted engine is seeded from the confirmed re-ranges the account's stored ops record.
const NOW = 2_000_000
const op = (over: Partial<StoredOp>): StoredOp => ({ opId: 'eng-1-1-a-rerange', kind: 'reduce', state: 'confirmed', updatedAt: '2026-10-27T00:00:00Z', pool: 'pool:USDC/cbBTC/500', rerange: true, block: 10, rerangeAt: String(NOW - 3600), ...over })

describe('rerangeHistoryOf', () => {
  test('keeps confirmed re-ranges of the last 7 days with pool and block time', () => {
    const rows = [op({}), op({ opId: 'b', pool: 'pool:USDC/USDT/100', rerangeAt: String(NOW - 6 * 86_400) })]
    expect(rerangeHistoryOf(rows, NOW)).toEqual([
      { pool: 'pool:USDC/cbBTC/500', at: BigInt(NOW - 3600) },
      { pool: 'pool:USDC/USDT/100', at: BigInt(NOW - 6 * 86_400) },
    ])
  })
  test('a merge (#220) is kept and marked, for the cooldown but not the weekly cap', () => {
    expect(rerangeHistoryOf([op({ why: 'merge' })], NOW)).toEqual([{ pool: 'pool:USDC/cbBTC/500', at: BigInt(NOW - 3600), merge: true }])
  })
  test('skips old, unconfirmed, non-re-range and untimed rows', () => {
    const rows = [
      op({ rerangeAt: String(NOW - 8 * 86_400) }),
      op({ state: 'submitted' }),
      op({ state: 'failed' }),
      op({ rerange: undefined }),
      op({ rerangeAt: undefined }),
      op({ pool: undefined }),
    ]
    expect(rerangeHistoryOf(rows, NOW)).toEqual([])
  })
})

// Live wait rule: the out-of-range clock survives a restart, never a long gap.
describe('out-of-range clock across a restart', () => {
  test('stored clock parses to the seed; junk is no seed', () => {
    expect(outOfRangeSeedOf({ since: { '6291301': '1000' }, seenAt: '5000' })).toEqual({ since: new Map([[6291301n, 1000n]]), seenAt: 5000n })
    expect(outOfRangeSeedOf(undefined)).toBeUndefined()
    expect(outOfRangeSeedOf({ since: { x: 'y' }, seenAt: '1' } as never)).toBeUndefined()
    expect(outOfRangeSeedOf({ since: {}, seenAt: 3 } as never)).toBeUndefined()
  })

  test('kept within the gap, dropped past it or from the future', () => {
    const seed = { since: new Map([[7n, 1000n]]), seenAt: 10_000n }
    expect(outOfRangeFromSeed(seed, 10_000n + OUT_OF_RANGE_SEED_GAP_S).get(7n)).toBe(1000n)
    expect(outOfRangeFromSeed(seed, 10_001n + OUT_OF_RANGE_SEED_GAP_S).size).toBe(0)
    expect(outOfRangeFromSeed(seed, 9_000n).size).toBe(0)
  })
})

describe('otto/mamoru#358: the stored held-position histories as the engine seed', () => {
  const H = `0x${'ab'.repeat(32)}`
  const ev = { kind: 'collect', tokenId: '49417', amount0: '5', amount1: '7', logIndex: 3, blockNumber: '118500000', txHash: `0x${'cd'.repeat(32)}` }
  test('parses what onHeldHistory stored; a malformed entry is left out, the rest kept', () => {
    expect(heldHistorySeedOf({ '49417': { through: '118600000', hash: H, events: [ev] } })).toEqual(
      new Map([['49417', { through: 118600000n, hash: H, events: [{ kind: 'collect', tokenId: 49417n, amount0: 5n, amount1: 7n, logIndex: 3, blockNumber: 118500000n, txHash: ev.txHash }] }]]),
    )
    const mixed = heldHistorySeedOf({ '1': { through: 'x', hash: H, events: [] }, '2': { through: '9', hash: '0x01', events: [] }, '3': { through: '9', hash: H, events: [{ ...ev, kind: 'mint' }] }, '4': { through: '9', hash: H, events: [] } })
    expect([...(mixed ?? new Map()).keys()]).toEqual(['4'])
    expect(heldHistorySeedOf(undefined)).toBeUndefined()
    expect(heldHistorySeedOf({ '1': { through: 'x', hash: H, events: [] } })).toBeUndefined()
  })
})
