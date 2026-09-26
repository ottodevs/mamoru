import type { DashboardPayload, Figure, Hex0x, PositionView, Provenance } from '@mamoru/domain'
import { emptyAccount, FIXTURE_BLOCK, FIXTURE_OBSERVED_AT, USDC_CBBTC_POOL } from '../../src/web/fixtures/empty-account.ts'

// Test only: an account with one managed position, a decision and history rows, to cover non-empty paths.
const rpc: Provenance = { source: 'chain_rpc', chainId: 8453, blockNumber: FIXTURE_BLOCK, observedAt: FIXTURE_OBSERVED_AT, status: 'fresh' }
const journal: Provenance = { source: 'journal', chainId: 8453, observedAt: FIXTURE_OBSERVED_AT, status: 'fresh' }
const mb: Provenance = { ...rpc, source: 'multibaas', check: 'reconciled', checkedAt: FIXTURE_BLOCK }
const fallback: Provenance = { ...rpc, detail: 'PROJ_SOURCE_FALLBACK_RPC', cause: 'MB_QUERY_FAILED' }
const f = <T>(value: T | null, provenance: Provenance, unit?: string): Figure<T> => (unit ? { value, unit, provenance } : { value, provenance })
const tx = (n: number): Hex0x => `0x${n.toString(16).padStart(64, 'a')}`

const position: PositionView = {
  tokenId: '1234',
  pool: USDC_CBBTC_POOL,
  managed: true,
  tickLower: -65_000,
  tickUpper: -64_600,
  rangeState: f('out_of_range', rpc),
  outOfRangeSince: f('before_retention', mb),
  timeInRange: f('0.625', mb),
  liquidity: f('9120044001', rpc),
  liquidityFromEvents: f<string>(null, rpc),
  historyComplete: false,
  principal: { amount0: f('500000000', rpc, 'USDC'), amount1: f('764000', rpc, 'cbBTC'), value: f('999900000', { ...rpc, source: 'estimate' }, 'USDC') },
  uncollectedFees: { amount0: f('1200000', rpc, 'USDC'), amount1: f('1800', rpc, 'cbBTC'), value: f('2380000', { ...rpc, source: 'estimate' }, 'USDC') },
  collectedFees: { amount0: f('0', mb, 'USDC'), amount1: f('0', mb, 'cbBTC') },
  feeMovement: { amount0: f('400000', rpc, 'USDC'), amount1: f('600', rpc, 'cbBTC'), value: f('790000', { ...rpc, source: 'estimate' }, 'USDC'), fromBlock: FIXTURE_BLOCK - 43_200 },
  value: f('1002280000', { ...rpc, source: 'estimate' }, 'USDC'),
  codes: ['OBS_POSITION_OUT_OF_RANGE'],
  events: [
    { block: FIXTURE_BLOCK - 900, blockHash: tx(1), txHash: tx(2), logIndex: 3, at: FIXTURE_OBSERVED_AT, opId: 'op_1', provenance: fallback, kind: 'increase', amount0: f('500000000', fallback, 'USDC'), amount1: f('764000', fallback, 'cbBTC') },
  ],
}

export function populatedAccount(): DashboardPayload {
  const d = structuredClone(emptyAccount)
  d.pools.positions = [position]
  d.portfolio.positions = { managed: 1, unmanaged: 0, value: position.value }
  d.currentAction.op = { opId: 'op_2', kind: 'harvest', state: 'discarded', code: 'DRY_RUN_STOP', updatedAt: FIXTURE_OBSERVED_AT }
  d.currentAction.decision = {
    decisionId: 'dec_1',
    kind: 'harvest',
    code: 'DECIDE_HARVEST',
    block: FIXTURE_BLOCK,
    trail: [
      { gate: 'Risk Monitor', verdict: 'GO', reason: 'RISK_OK' },
      { gate: 'Execution Health Gate', verdict: 'GO', reason: 'EHG_OK' },
    ],
    shadow: [{ code: 'ENY_SHADOW', note: 'ENY estimate recorded.' }],
    positions: [{ tokenId: '1234', codes: ['OBS_POSITION_OUT_OF_RANGE'] }],
  }
  d.currentAction.recentDecisions = [{ decisionId: 'dec_1', kind: 'harvest', code: 'DECIDE_HARVEST', block: FIXTURE_BLOCK, at: FIXTURE_OBSERVED_AT }]
  d.currentAction.chainOps = [
    { block: FIXTURE_BLOCK - 10, blockHash: tx(5), txHash: tx(6), logIndex: 0, at: FIXTURE_OBSERVED_AT, provenance: { ...rpc, check: 'mismatch' }, kind: 'userOp', state: 'included' },
  ]
  d.currentAction.notes = ['BUNDLER_UNAVAILABLE']
  d.savingsLog.rows = [
    { block: FIXTURE_BLOCK - 20, blockHash: tx(7), txHash: tx(8), logIndex: 1, at: FIXTURE_OBSERVED_AT, opId: 'op_0', provenance: mb, kind: 'harvest', amount: f('2380000', mb, 'USDC'), code: 'PROJ_RECONCILED' },
  ]
  d.savings.ledgerTotal = f('2380000', journal, 'USDC')
  return d
}
