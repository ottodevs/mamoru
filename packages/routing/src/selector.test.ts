import { describe, expect, test } from 'bun:test'
import { quoteAll, rank, selectBest } from './selector.ts'
import { RouteError } from './errors.ts'
import type { Adapter, Quote, QuoteRequest } from './types.ts'

const REQ: QuoteRequest = { sourceChainId: 1, destChainId: 8453, asset: 'USDC', amountIn: 150_000_000n, account: '0x1111111111111111111111111111111111111111' }

function quote(partial: Partial<Quote> & { provider: string; amountOut: bigint }): Quote {
  return {
    route: partial.provider,
    sourceChainId: REQ.sourceChainId,
    destChainId: REQ.destChainId,
    asset: REQ.asset,
    amountIn: 150_000_000n,
    fee: 150_000_000n - partial.amountOut,
    etaSec: 60,
    target: '0x2222222222222222222222222222222222222222',
    calldata: '0x1234',
    recipientCheck: 'onchain-pinnable',
    mode: 'session-key',
    expiresAt: new Date(1_000_000).toISOString(),
    ...partial,
  }
}

describe('selectBest, executable only when a mode is requested', () => {
  test('owner-only never returns a quote-only route (no calldata / recipientCheck none), even when it ranks best', () => {
    const quoteOnly = quote({ provider: 'quoteonly', amountOut: 150_000_000n, mode: 'owner-only', recipientCheck: 'none', calldata: undefined })
    const noCalldata = quote({ provider: 'nocalldata', amountOut: 149_999_000n, mode: 'owner-only', calldata: undefined })
    const exec = quote({ provider: 'exec', amountOut: 149_000_000n, mode: 'owner-only', recipientCheck: 'decoded-calldata' })
    expect(selectBest([quoteOnly, noCalldata, exec], { mode: 'owner-only' })?.provider).toBe('exec')
    expect(selectBest([quoteOnly, noCalldata], { mode: 'owner-only' })).toBeNull()
    expect(rank([quoteOnly, noCalldata, exec], { mode: 'owner-only' }).map((q) => q.provider)).toEqual(['exec'])
    // no mode: a UI comparison still sees quote-only routes
    expect(selectBest([quoteOnly, exec])?.provider).toBe('quoteonly')
  })
})

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

  // otto/mamoru#181, review round 3: ranking is by net output (amountOut minus any priced native-asset `value`
  // surcharge, see pricing.ts), not raw amountOut — two quotes landing on the same amountOut are not equally
  // good if one of them also spends the account's native balance on the source chain.

  test("never prefers a route that charges native value over one that doesn't, unless its USDC advantage clears that value at the stated conservative price", () => {
    // Free route: 149.90 USDC, no native cost. Value-charging route: 149.95 USDC (0.05 USDC better on paper)
    // but attaches 0.001 ETH, priced at the stated $5,000/ETH = $5.00 = 5_000_000 base units — a cost that
    // dwarfs the 0.05 USDC advantage, so the free route must still win.
    const free = quote({ provider: 'free', amountOut: 149_900_000n })
    const costsValue = quote({ provider: 'costly', amountOut: 149_950_000n, value: 1_000_000_000_000_000n })
    expect(selectBest([free, costsValue])?.provider).toBe('free')
  })

  test('a value-charging route DOES win once its USDC advantage genuinely exceeds the priced native cost', () => {
    // Same 0.001 ETH ($5.00) cost, but this route's raw output is 10 USDC better — comfortably past the cost.
    const free = quote({ provider: 'free', amountOut: 149_900_000n })
    const worthIt = quote({ provider: 'worth-it', amountOut: 159_900_000n, value: 1_000_000_000_000_000n })
    expect(selectBest([free, worthIt])?.provider).toBe('worth-it')
  })

  test('a quote whose native cost cannot be priced at all (e.g. Monad/MON) never outranks one with a known cost — not even a known cost of zero', () => {
    const known = quote({ provider: 'known', amountOut: 100_000_000n }) // deliberately low amountOut
    const unpriceable = quote({ provider: 'unpriceable', sourceChainId: 143, amountOut: 999_000_000n, value: 1n }) // deliberately huge amountOut
    expect(selectBest([known, unpriceable])?.provider).toBe('known')
    expect(rank([known, unpriceable]).map((r) => r.provider)).toEqual(['known', 'unpriceable'])
  })

  test('bridging ETH on an ETH-native source chain, value beyond the principal: only the excess over amountIn is a real cost', () => {
    // amountIn 10 ETH on both. a: value is exactly amountIn (no real extra cost, like canonical.ts) -> net ==
    // amountOut. b: value is amountIn + 0.05 ETH extra, but amountOut is 0.1 ETH higher than a's -> net is still
    // 0.05 ETH ahead of a's once that real extra cost is subtracted, so b wins.
    const amountIn = 10_000_000_000_000_000_000n // 10 ETH
    const a = quote({ provider: 'a', asset: 'ETH', amountIn, amountOut: 10_000_000_000_000_000_000n, value: amountIn })
    const b = quote({ provider: 'b', asset: 'ETH', amountIn, amountOut: 10_100_000_000_000_000_000n, value: amountIn + 50_000_000_000_000_000n })
    expect(selectBest([a, b])?.provider).toBe('b')
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
