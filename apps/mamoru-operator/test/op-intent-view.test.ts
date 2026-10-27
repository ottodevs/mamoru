import { describe, expect, test } from 'bun:test'
import type { Proposal } from '@mamoru/decide'
import { opIntentView, opStepView } from '../src/operator.ts'

// otto/mamoru#131: every Proposal carries a pool, so the SPA's history can always name it instead of
// assuming the USDC/cbBTC pool. enter_swap also carries the tokens and the amount; a converting harvest
// carries the token it converted.

describe('opIntentView', () => {
  test('enter_swap: pool, tokenIn/tokenOut and the amount swapped', () => {
    const intent: Proposal = { kind: 'enter_swap', grant: 'enter-swap', pool: 'pool:USDC/cbBTC/500', tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 10_000_000n }
    expect(opIntentView(intent)).toEqual({ pool: 'pool:USDC/cbBTC/500', tokenIn: 'USDC', tokenOut: 'cbBTC', amountIn: '10000000' })
  })

  test('enter_mint: pool and the range it opens (#219)', () => {
    const intent: Proposal = { kind: 'enter_mint', grant: 'enter-mint', pool: 'pool:USDC/cbBTC/500', tickLower: -100, tickUpper: 100, amount0Desired: 1n, amount1Desired: 1n }
    expect(opIntentView(intent)).toEqual({ pool: 'pool:USDC/cbBTC/500', tickLower: -100, tickUpper: 100 })
  })

  test('harvest with a convert step: pool, position and the converted token', () => {
    const intent: Proposal = { kind: 'harvest', grant: 'convert-any', pool: 'pool:USDC/cbBTC/500', tokenId: 1n, fees0: 1n, fees1: 2n, convert: { token: 'cbBTC', amount: 2n } }
    expect(opIntentView(intent)).toEqual({ pool: 'pool:USDC/cbBTC/500', tokenId: '1', convert: 'cbBTC' })
  })

  test('harvest with no convert step: pool and position', () => {
    const intent: Proposal = { kind: 'harvest', grant: 'convert-any', pool: 'pool:USDC/cbBTC/500', tokenId: 1n, fees0: 1n, fees1: 2n, convert: null }
    expect(opIntentView(intent)).toEqual({ pool: 'pool:USDC/cbBTC/500', tokenId: '1' })
  })

  test('rerange and reduce: pool and position; a rerange says why and the range it leaves (#219)', () => {
    const rerange: Proposal = { kind: 'rerange', grant: 'manage-any', pool: 'pool:USDC/cbBTC/500', tokenId: 1n, liquidity: 5n, why: 'out', tickLower: -10, tickUpper: 30 }
    const legacy: Proposal = { kind: 'rerange', grant: 'manage-any', pool: 'pool:USDC/cbBTC/500', tokenId: 1n, liquidity: 5n }
    const reduce: Proposal = { kind: 'reduce', grant: 'manage-any', pool: 'pool:USDC/cbBTC/500', tokenId: 1n, liquidity: 5n }
    expect(opIntentView(rerange)).toEqual({ pool: 'pool:USDC/cbBTC/500', tokenId: '1', why: 'out', tickLower: -10, tickUpper: 30 })
    expect(opIntentView(legacy)).toEqual({ pool: 'pool:USDC/cbBTC/500', tokenId: '1' })
    expect(opIntentView(reduce)).toEqual({ pool: 'pool:USDC/cbBTC/500', tokenId: '1' })
  })
})

describe('opStepView (#219)', () => {
  test('a swap carries its kind, reason and quoted output', () => {
    expect(opStepView({ kind: 'enter_swap', causeCode: 'DECIDE_ENTER', quote: { amountIn: 5n, amountOut: 4n, amountOutMinimum: 3n } })).toEqual({ step: 'enter_swap', cause: 'DECIDE_ENTER', amountOut: '4' })
  })

  test('a mint carries the tokenId it got; a rerange has no quote', () => {
    expect(opStepView({ kind: 'enter_mint', causeCode: 'DECIDE_ENTER', mintedTokenId: 6358057n })).toEqual({ step: 'enter_mint', cause: 'DECIDE_ENTER', tokenId: '6358057' })
    expect(opStepView({ kind: 'rerange', causeCode: 'DECIDE_RANGE_ADJUST' })).toEqual({ step: 'rerange', cause: 'DECIDE_RANGE_ADJUST' })
  })
})
