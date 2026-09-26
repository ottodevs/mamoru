import type { Figure, Hex0x, PoolLiquidityView, PoolsResponse, PoolSwapView, PoolView, Provenance } from '@mamoru/domain'
import { FIXTURE_BLOCK, FIXTURE_OBSERVED_AT, USDC_CBBTC_POOL } from './empty-account.ts'

// Dev and test only. Pool rows shaped like a ReadModelSync pass over USDC/cbBTC 0.05% on Base.
const WINDOW = 43_200
const rpc: Provenance = { source: 'chain_rpc', chainId: 8453, blockNumber: FIXTURE_BLOCK, observedAt: FIXTURE_OBSERVED_AT, status: 'fresh' }
const est: Provenance = { ...rpc, source: 'estimate' }
const reconciled = (block: number): Provenance => ({
  source: 'multibaas',
  chainId: 8453,
  blockNumber: block,
  observedAt: FIXTURE_OBSERVED_AT,
  status: 'fresh',
  check: 'reconciled',
  checkedAt: FIXTURE_BLOCK,
})
const f = <T>(value: T, provenance: Provenance, unit?: string): Figure<T> => (unit ? { value, unit, provenance } : { value, provenance })

const hash = (n: number): Hex0x => `0x${n.toString(16).padStart(64, '0')}`

function swap(i: number, block: number, usdc: string, cbbtc: string, tick: number, at: string): PoolSwapView {
  const p = reconciled(block)
  return {
    block,
    blockHash: hash(0xb10c00 + i),
    txHash: hash(0x5a00 + i),
    logIndex: 40 + i,
    at,
    provenance: p,
    amount0: f(usdc, p, 'USDC'),
    amount1: f(cbbtc, p, 'cbBTC'),
    tick,
  }
}

function liquidity(i: number, block: number, kind: 'mint' | 'burn', usdc: string, cbbtc: string, at: string): PoolLiquidityView {
  const p = reconciled(block)
  return {
    block,
    blockHash: hash(0x11c000 + i),
    txHash: hash(0x1100 + i),
    logIndex: 12 + i,
    at,
    provenance: p,
    kind,
    amount0: f(usdc, p, 'USDC'),
    amount1: f(cbbtc, p, 'cbBTC'),
    tickLower: -65_000,
    tickUpper: -64_600,
  }
}

export const usdcCbbtcPool: PoolView = {
  pool: USDC_CBBTC_POOL,
  block: FIXTURE_BLOCK,
  price: f('65432100000', rpc, 'USDC'),
  tick: f(-64_842, rpc),
  twapTick: f(-64_836, rpc),
  twapGuard: f('ok', rpc),
  liquidity: f('1843200418822907', rpc),
  balances: { amount0: f('4210385120334', rpc, 'USDC'), amount1: f('5120447381', rpc, 'cbBTC'), value: f('7560740000000', est, 'USDC') },
  window: { fromBlock: FIXTURE_BLOCK - WINDOW, toBlock: FIXTURE_BLOCK },
  stats: {
    swaps: f(1_284, rpc),
    volume0: f('18420330100000', rpc, 'USDC'),
    volume1: f('27911204455', rpc, 'cbBTC'),
    volumeValue: f('36683500000000', est, 'USDC'),
    fees0: f('9210165050', est, 'USDC'),
    fees1: f('13955602', est, 'cbBTC'),
    feesValue: f('18341750000', est, 'USDC'),
    tickMin: f(-65_118, rpc),
    tickMax: f(-64_590, rpc),
    added: { count: f(37, rpc), amount0: f('912004000000', rpc, 'USDC'), amount1: f('1393000120', rpc, 'cbBTC') },
    removed: { count: f(29, rpc), amount0: f('801330000000', rpc, 'USDC'), amount1: f('1224700000', rpc, 'cbBTC') },
  },
  recentSwaps: [
    swap(1, FIXTURE_BLOCK - 4, '25000000000', '-38190331', -64_842, '2026-09-26T18:19:52.000Z'),
    swap(2, FIXTURE_BLOCK - 19, '-12480221003', '19100000', -64_845, '2026-09-26T18:19:22.000Z'),
    swap(3, FIXTURE_BLOCK - 57, '4100000000', '-6264410', -64_839, '2026-09-26T18:18:06.000Z'),
  ],
  recentLiquidity: [
    liquidity(1, FIXTURE_BLOCK - 812, 'mint', '150000000000', '229100000', '2026-09-26T17:52:56.000Z'),
    liquidity(2, FIXTURE_BLOCK - 2_301, 'burn', '82000140000', '125330012', '2026-09-26T17:03:18.000Z'),
  ],
  accountPositions: [],
}

export const poolsResponse: PoolsResponse = { chainId: 8453, pools: [usdcCbbtcPool], syncedAt: FIXTURE_OBSERVED_AT }
