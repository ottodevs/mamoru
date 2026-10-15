import { describe, expect, test } from 'bun:test'
import type { Proposal } from '@mamoru/decide'
import { opIntentView } from '../src/operator.ts'

// otto/mamoru#131: every Proposal carries a pool, so the SPA's history can always name it instead of
// assuming the USDC/cbBTC pool. enter_swap also carries the tokens and the amount; a converting harvest
// carries the token it converted.

describe('opIntentView', () => {
  test('enter_swap: pool, tokenIn/tokenOut and the amount swapped', () => {
    const intent: Proposal = { kind: 'enter_swap', grant: 'enter-swap', pool: 'pool:USDC/cbBTC/500', tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 10_000_000n }
    expect(opIntentView(intent)).toEqual({ pool: 'pool:USDC/cbBTC/500', tokenIn: 'USDC', tokenOut: 'cbBTC', amountIn: '10000000' })
  })

  test('enter_mint: pool only', () => {
    const intent: Proposal = { kind: 'enter_mint', grant: 'enter-mint', pool: 'pool:USDC/cbBTC/500', tickLower: -100, tickUpper: 100, amount0Desired: 1n, amount1Desired: 1n }
    expect(opIntentView(intent)).toEqual({ pool: 'pool:USDC/cbBTC/500' })
  })

  test('harvest with a convert step: pool and the converted token', () => {
    const intent: Proposal = { kind: 'harvest', grant: 'convert-any', pool: 'pool:USDC/cbBTC/500', tokenId: 1n, fees0: 1n, fees1: 2n, convert: { token: 'cbBTC', amount: 2n } }
    expect(opIntentView(intent)).toEqual({ pool: 'pool:USDC/cbBTC/500', convert: 'cbBTC' })
  })

  test('harvest with no convert step: pool only', () => {
    const intent: Proposal = { kind: 'harvest', grant: 'convert-any', pool: 'pool:USDC/cbBTC/500', tokenId: 1n, fees0: 1n, fees1: 2n, convert: null }
    expect(opIntentView(intent)).toEqual({ pool: 'pool:USDC/cbBTC/500' })
  })

  test('rerange and reduce: pool only', () => {
    const rerange: Proposal = { kind: 'rerange', grant: 'manage-any', pool: 'pool:USDC/cbBTC/500', tokenId: 1n, liquidity: 5n }
    const reduce: Proposal = { kind: 'reduce', grant: 'manage-any', pool: 'pool:USDC/cbBTC/500', tokenId: 1n, liquidity: 5n }
    expect(opIntentView(rerange)).toEqual({ pool: 'pool:USDC/cbBTC/500' })
    expect(opIntentView(reduce)).toEqual({ pool: 'pool:USDC/cbBTC/500' })
  })
})
