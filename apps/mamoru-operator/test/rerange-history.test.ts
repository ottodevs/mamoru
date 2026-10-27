import { describe, expect, test } from 'bun:test'
import { rerangeHistoryOf } from '../src/operator.ts'
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
