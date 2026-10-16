// otto/mamoru#140 (part2 #8): readSafe's PoolPosition carried amount0/amount1 from current liquidity only, never
// tokensOwed0/1 — fees or principal left by a decrease whose collect has not run yet. positionUsdc (valuation:
// reducePlan's "is there anything to withdraw" check, and funding's deposit value) undervalued such a position,
// in the worst case reporting it worth 0 even though collect() would still sweep real tokens from it.
import { describe, expect, test } from 'bun:test'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { positionUsdc, type PoolPosition } from '../src/chain.ts'

const PRICE = sqrtRatioAtTick(0) // pool:USDC/USDT/100 at 1:1

const pos = (over: Partial<PoolPosition>): PoolPosition => ({
  tokenId: 1n,
  pool: 'pool:USDC/USDT/100',
  token0: 'USDC',
  token1: 'USDT',
  fee: 100,
  liquidity: 0n,
  tickLower: 0,
  tickUpper: 1,
  inRange: false,
  amount0: 0n,
  amount1: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
  ...over,
})

describe('positionUsdc counts tokensOwed, not only the liquidity-derived amounts', () => {
  test('a position with liquidity decreased to 0 but USDC still owed is not valued at 0', () => {
    const p = pos({ liquidity: 0n, amount0: 0n, amount1: 0n, tokensOwed0: 3_000_000n })
    expect(positionUsdc(p, PRICE)).toBe(3_000_000n)
  })

  test('owed accrues on top of the liquidity-derived amount, on either token', () => {
    const p = pos({ amount0: 1_000_000n, tokensOwed0: 500_000n, amount1: 2_000_000n, tokensOwed1: 250_000n })
    expect(positionUsdc(p, PRICE)).toBe(3_750_000n)
  })

  test('no owed tokens: unchanged from the liquidity-derived amounts alone', () => {
    const p = pos({ amount0: 1_000_000n, amount1: 2_000_000n })
    expect(positionUsdc(p, PRICE)).toBe(3_000_000n)
  })
})
