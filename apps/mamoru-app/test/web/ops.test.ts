import { describe, expect, test } from 'bun:test'
import type { OpView } from '@mamoru/domain'
import { historyOps, opLine } from '../../src/web/lib/ops.ts'

const AT = '2026-10-10T12:00:00.000Z'
const base = (patch: Partial<OpView>): OpView => ({ opId: 'own-1-activate', kind: 'activate', state: 'confirmed', updatedAt: AT, ...patch })

describe('opLine', () => {
  test('a start refused for gas says so and how to start with your own', () => {
    expect(opLine(base({ state: 'failed', code: 'SUBSIDY_BELOW_MINIMUM' }))).toBe('Start needs gas: add USDC, or send ETH on Base to your account')
    expect(opLine(base({ state: 'failed', code: 'SUBSIDY_DAILY_BUDGET' }))).toContain('send ETH on Base')
    expect(opLine(base({ state: 'failed', code: 'OWNER_TX_FAILED' }))).toBe('Start needs another approval')
  })

  test('enter_swap names the tokens and the amount when known', () => {
    const op = base({ opId: 'eng-1-1-op-1-enter_swap', kind: 'enter', state: 'confirmed', pool: 'pool:USDC/cbBTC/500', tokenIn: 'USDC', tokenOut: 'cbBTC', amountIn: '10000000' })
    expect(opLine(op)).toBe('Swapped 10 USDC to cbBTC')
    expect(opLine({ ...op, state: 'submitted' })).toBe('Swapping 10 USDC to cbBTC')
  })

  test('enter_swap without an amount still names the tokens', () => {
    const op = base({ opId: 'eng-1-1-op-1-enter_swap', kind: 'enter', state: 'confirmed', pool: 'pool:USDC/cbBTC/500', tokenIn: 'USDC', tokenOut: 'cbBTC' })
    expect(opLine(op)).toBe('Swapped USDC to cbBTC')
  })

  test('enter_swap with no pool fields at all (a row stored before this shipped) is neutral', () => {
    const op = base({ opId: 'eng-1-1-op-1-enter_swap', kind: 'enter', state: 'confirmed' })
    expect(opLine(op)).toBe('Swapped')
    expect(opLine({ ...op, state: 'submitted' })).toBe('Swapping')
  })

  test('enter_mint names the pool pair', () => {
    const op = base({ opId: 'eng-1-1-op-2-enter_mint', kind: 'enter', state: 'confirmed', pool: 'pool:USDC/cbBTC/500' })
    expect(opLine(op)).toBe('Opened USDC/cbBTC position')
    expect(opLine({ ...op, state: 'submitted' })).toBe('Opening USDC/cbBTC position')
  })

  test('enter_mint without a pool (old row) is neutral, not a guess', () => {
    const op = base({ opId: 'eng-1-1-op-2-enter_mint', kind: 'enter', state: 'confirmed' })
    expect(opLine(op)).toBe('Opened a position')
  })

  test('a different pool pair renders correctly, not hardcoded to USDC/cbBTC', () => {
    const op = base({ opId: 'eng-1-1-op-2-enter_mint', kind: 'enter', state: 'confirmed', pool: 'pool:USDC/USDT/100' })
    expect(opLine(op)).toBe('Opened USDC/USDT position')
  })

  test('harvest names the pool, and the converted token when the harvest converted one', () => {
    const plain = base({ opId: 'eng-1-1-op-3-harvest', kind: 'reduce', state: 'confirmed', pool: 'pool:USDC/cbBTC/500' })
    expect(opLine(plain)).toBe('Collected fees from USDC/cbBTC')
    const converting = base({ opId: 'eng-1-1-op-3-harvest', kind: 'reduce', state: 'submitted', pool: 'pool:USDC/cbBTC/500', convert: 'cbBTC' })
    expect(opLine(converting)).toBe('Collecting fees from USDC/cbBTC, converting cbBTC to USDC')
  })

  test('harvest without a pool keeps the old plain line', () => {
    expect(opLine(base({ opId: 'eng-1-1-op-3-harvest', kind: 'reduce', state: 'confirmed' }))).toBe('Collected fees')
  })

  test('a rebalance (rerange/reduce, not harvest) names the pool', () => {
    const op = base({ opId: 'eng-1-1-op-4-rerange', kind: 'reduce', state: 'confirmed', pool: 'pool:USDC/cbBTC/500' })
    expect(opLine(op)).toBe('Rebalanced USDC/cbBTC')
    expect(opLine(base({ opId: 'eng-1-1-op-4-rerange', kind: 'reduce', state: 'submitted' }))).toBe('Rebalancing')
  })

  test('owner exit (stop) is unchanged: no pool, it closes everything', () => {
    expect(opLine(base({ opId: 'own-2-exit', kind: 'exit', state: 'confirmed' }))).toBe('Allocation stopped')
    expect(opLine(base({ opId: 'own-2-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR' }))).toBe('Stop needs another approval')
  })

  test('engine-side close names the pool when present, else is neutral', () => {
    expect(opLine(base({ opId: 'eng-1-1-op-5-close_position', kind: 'exit', state: 'confirmed', pool: 'pool:USDC/cbBTC/500' }))).toBe('Closed USDC/cbBTC position')
    expect(opLine(base({ opId: 'eng-1-1-op-5-close_position', kind: 'exit', state: 'confirmed' }))).toBe('Closed a position')
  })

  test('activate, renew and transfer are unaffected by the new fields', () => {
    expect(opLine(base({ kind: 'activate', state: 'confirmed' }))).toBe('Mamoru started')
    expect(opLine(base({ kind: 'renew', state: 'confirmed' }))).toBe('Approval renewed')
    expect(opLine(base({ kind: 'transfer', state: 'confirmed', amountUsdc: '5000000' }))).toBe('Withdrew 5.00 USDC')
  })
})

describe('historyOps', () => {
  test('a top-up into a pool that already has a position keeps both confirmed rows: two real positions, not a duplicate', () => {
    const ops: OpView[] = [
      base({ opId: 'eng-1-1-op-2-enter_mint', kind: 'enter', state: 'confirmed', pool: 'pool:USDC/cbBTC/500', updatedAt: '2026-10-10T10:00:00.000Z' }),
      base({ opId: 'eng-1-2-op-9-enter_mint', kind: 'enter', state: 'confirmed', pool: 'pool:USDC/cbBTC/500', updatedAt: '2026-10-10T11:00:00.000Z' }),
    ]
    expect(historyOps(ops).map((o) => o.opId)).toEqual(['eng-1-2-op-9-enter_mint', 'eng-1-1-op-2-enter_mint'])
  })

  test('repeated failed engine retries never reach history: the operator collapses them before this runs', () => {
    const ops: OpView[] = [
      base({ opId: 'own-1-activate', kind: 'activate', state: 'confirmed', updatedAt: '2026-10-10T09:00:00.000Z' }),
      base({ opId: 'eng-1-1-op-1-enter_swap', kind: 'enter', state: 'failed', code: 'RECON_UNINCLUDABLE', updatedAt: '2026-10-10T09:05:00.000Z' }),
    ]
    expect(historyOps(ops).map((o) => o.opId)).toEqual(['own-1-activate'])
  })

  test('only the latest owner failure of a kind survives; an older superseded one does not', () => {
    const ops: OpView[] = [
      base({ opId: 'own-1-activate', kind: 'activate', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: '2026-10-10T09:00:00.000Z' }),
      base({ opId: 'own-2-activate', kind: 'activate', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: '2026-10-10T09:05:00.000Z' }),
    ]
    expect(historyOps(ops).map((o) => o.opId)).toEqual(['own-2-activate'])
  })
})
