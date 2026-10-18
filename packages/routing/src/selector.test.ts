import { describe, expect, test } from 'bun:test'
import { quoteAll, rank, selectBest } from './selector.ts'
import { RouteError } from './errors.ts'
import type { Adapter, Quote, QuoteRequest } from './types.ts'

const REQ: QuoteRequest = { sourceChainId: 1, destChainId: 8453, asset: 'USDC', amountIn: 150_000_000n, account: '0x1111111111111111111111111111111111111111' }

function quote(partial: Partial<Quote> & { provider: string; amountOut: bigint }): Quote {
  return {
    route: partial.provider,
    amountIn: 150_000_000n,
    fee: 150_000_000n - partial.amountOut,
    etaSec: 60,
    target: '0x2222222222222222222222222222222222222222',
    recipientCheck: 'onchain-pinnable',
    mode: 'session-key',
    expiresAt: new Date(1_000_000).toISOString(),
    ...partial,
  }
}

describe('selectBest', () => {
  test('picks the highest net output', () => {
    const q = [quote({ provider: 'a', amountOut: 149_900_000n }), quote({ provider: 'b', amountOut: 149_980_000n }), quote({ provider: 'c', amountOut: 149_610_000n })]
    expect(selectBest(q)?.provider).toBe('b')
  })

  test('a tie on output goes to the faster route', () => {
    const q = [quote({ provider: 'slow', amountOut: 149_980_000n, etaSec: 120 }), quote({ provider: 'fast', amountOut: 149_980_000n, etaSec: 2 })]
    expect(selectBest(q)?.provider).toBe('fast')
  })

  test('filters by signing mode', () => {
    const q = [quote({ provider: 'session', amountOut: 149_000_000n, mode: 'session-key' }), quote({ provider: 'owner', amountOut: 150_000_000n, mode: 'owner-only' })]
    expect(selectBest(q, { mode: 'session-key' })?.provider).toBe('session')
    expect(selectBest(q, { mode: 'owner-only' })?.provider).toBe('owner')
  })

  test('no quotes, or none in the requested mode, is null', () => {
    expect(selectBest([])).toBeNull()
    expect(selectBest([quote({ provider: 'a', amountOut: 1n, mode: 'owner-only' })], { mode: 'session-key' })).toBeNull()
  })

  test('rank orders every quote best-first', () => {
    const q = [quote({ provider: 'mid', amountOut: 149_900_000n }), quote({ provider: 'best', amountOut: 149_980_000n }), quote({ provider: 'worst', amountOut: 149_000_000n })]
    expect(rank(q).map((r) => r.provider)).toEqual(['best', 'mid', 'worst'])
  })
})

describe('quoteAll', () => {
  const ok: Adapter = { name: 'ok', supports: () => true, quote: async () => quote({ provider: 'ok', amountOut: 149_900_000n }) }
  const refuses: Adapter = {
    name: 'refuses',
    supports: () => true,
    quote: async () => {
      throw new RouteError('refuses', 'BRIDGE_QUOTE_REFUSED', 'fee too high')
    },
  }
  const crashes: Adapter = {
    name: 'crashes',
    supports: () => true,
    quote: async () => {
      throw new Error('network blip')
    },
  }
  const notApplicable: Adapter = { name: 'skip', supports: () => false, quote: async () => quote({ provider: 'skip', amountOut: 1n }) }

  test('collects quotes and failures without throwing, and skips unsupported adapters', async () => {
    const run = await quoteAll(REQ, [ok, refuses, crashes, notApplicable])
    expect(run.quotes.map((q) => q.provider)).toEqual(['ok'])
    expect(run.failures).toHaveLength(2)
    expect(run.failures.find((f) => f.provider === 'refuses')).toMatchObject({ code: 'BRIDGE_QUOTE_REFUSED' })
    expect(run.failures.find((f) => f.provider === 'crashes')).toMatchObject({ code: 'UNKNOWN', message: expect.stringContaining('network blip') })
  })
})
