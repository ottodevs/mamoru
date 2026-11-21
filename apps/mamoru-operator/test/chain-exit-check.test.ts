// otto/mamoru#427: the read-only exit check values what a Monad Safe would hold once its pool positions are out and its WMON sold.
import { describe, expect, test } from 'bun:test'
import type { Address } from '@mamoru/domain'
import { exitRow } from '../src/chain-exit-check.ts'
import type { PoolPosition, SafeRead } from '../src/chain.ts'

const SAFE = '0x00000000000000000000000000000000000000aa' as Address
// sqrtPriceX96 for 1 WMON (18 decimals) = 0.02 USDC (6 decimals), WMON as token0: price raw = 0.02e6 / 1e18.
const Q96 = 1n << 96n
const SQRT = BigInt(Math.floor(Math.sqrt(0.02e6 / 1e18) * 2 ** 48)) * (Q96 >> 48n)

const position: PoolPosition = { tokenId: 50_578n, pool: 'pool:WMON/USDC/3000', token0: 'WMON', token1: 'USDC', fee: 3000, liquidity: 10n ** 15n, tickLower: -261_000, tickUpper: -259_000, inRange: true, amount0: 1_000n * 10n ** 18n, amount1: 30_000_000n, tokensOwed0: 0n, tokensOwed1: 1_000_000n } as PoolPosition

const read = (over: Partial<SafeRead>): SafeRead => ({ block: 1n, deployed: true, eth: 0n, usdc: 5_000_000n, sqrtPriceX96: SQRT, tick: 0, tokens: { WMON: 500n * 10n ** 18n, USDC: 5_000_000n }, prices: { 'pool:WMON/USDC/3000': { sqrtPriceX96: SQRT, tick: 0 } }, positions: [position], ...over }) as SafeRead

describe('chain exit check (otto/mamoru#427)', () => {
  test('USDC after exit = USDC held + the positions\' USDC side + all WMON sold at the pool price less the 0.30 % fee', () => {
    const row = exitRow(SAFE, read({}))
    expect(row.positions).toEqual([{ tokenId: 50_578n, liquidity: 10n ** 15n, usdc: expect.any(BigInt) }])
    // 1,500 WMON at ~0.02 = ~30 USDC, less 0.3 %; plus 5 held, 30 + 1 in the position.
    const usd = Number(row.expectedUsdc) / 1e6
    expect(usd).toBeGreaterThan(65.5)
    expect(usd).toBeLessThan(66.5)
  })

  test('nothing to exit: what is held', () => {
    const row = exitRow(SAFE, read({ positions: [], tokens: { WMON: 0n, USDC: 7_000_000n }, usdc: 7_000_000n }))
    expect(row.expectedUsdc).toBe(7_000_000n)
    expect(row.positions).toEqual([])
  })
})
