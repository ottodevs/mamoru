import type { Figure, PoolView, Provenance, TokenHolding } from '@mamoru/domain'
import { address } from '@mamoru/registry'

export const BLOCK = 36_000_000
export const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const

export function fig<T>(value: T, observedAt: string, unit?: string): Figure<T> {
  const provenance: Provenance = { source: 'chain_rpc', chainId: 8453, blockNumber: BLOCK, blockHash: BLOCK_HASH, observedAt, status: 'fresh' }
  return unit ? { value, unit, provenance } : { value, provenance }
}

/** A PoolView as the engine lane writes it into proj_pool_state.payload_json. */
export function poolView(observedAt: string): PoolView {
  const f = <T>(v: T, unit?: string) => fig(v, observedAt, unit)
  return {
    pool: { address: address('pool:USDC/cbBTC/500'), token0: 'USDC', token1: 'cbBTC', fee: 500, tickSpacing: 10, name: 'pool:USDC/cbBTC/500' },
    block: BLOCK,
    price: f('65000.12', 'USDC'),
    tick: f(-68000),
    twapTick: f(-68010),
    twapGuard: f('ok' as const),
    liquidity: f('123456789'),
    balances: { amount0: f('1000000', 'USDC'), amount1: f('2000', 'cbBTC'), value: f('2300000', 'USDC') },
    window: { fromBlock: BLOCK - 1800, toBlock: BLOCK },
    stats: {
      swaps: f(12),
      volume0: f('10', 'USDC'), volume1: f('1', 'cbBTC'), volumeValue: f('11', 'USDC'),
      fees0: f('1', 'USDC'), fees1: f('0', 'cbBTC'), feesValue: f('1', 'USDC'),
      tickMin: f(-68100), tickMax: f(-67900),
      added: { count: f(1), amount0: f('5', 'USDC'), amount1: f('0', 'cbBTC') },
      removed: { count: f(0), amount0: f('0', 'USDC'), amount1: f('0', 'cbBTC') },
    },
    recentSwaps: [],
    recentLiquidity: [],
    accountPositions: [],
  }
}

export function tokens(observedAt: string): TokenHolding[] {
  return [
    { token: 'USDC', role: 'plan', amount: fig('0', observedAt, 'USDC'), value: fig('0', observedAt, 'USDC') },
    { token: 'cbBTC', role: 'plan', amount: fig('0', observedAt, 'cbBTC'), value: { value: null, unit: 'USDC', provenance: { source: 'estimate', chainId: 8453, observedAt, status: 'not_observed' } } },
    { token: 'ETH', role: 'gas', amount: fig('0', observedAt, 'ETH'), value: fig('0', observedAt, 'USDC') },
  ]
}
