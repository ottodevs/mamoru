import { describe, expect, test } from 'bun:test'
import type { OpView } from '@mamoru/domain'
import { feesOf, gasLabel, gasOf, historyEntries, moveLine, moveReason, moveState, rangeLabel, stepLine, stepOf, type Move } from '../../src/web/lib/moves.ts'

const POOL = 'pool:USDC/USDT/100'
const eng = (id: string, step: OpView['step'], at: string, patch: Partial<OpView> = {}): OpView => ({
  opId: `eng-1-1-${id}-${step}`,
  kind: step === 'rerange' || step === 'harvest' ? 'reduce' : 'enter',
  state: 'confirmed',
  updatedAt: at,
  pool: POOL,
  ...patch,
})

// Brais's account c23e94e1, 26 Oct (UTC): close 21:01, swap 21:17, open 21:18.
const close = eng('a', 'rerange', '2026-10-26T14:01:00.000Z', { why: 'out', tickLower: 0, tickUpper: 40, facts: { at: 'x', gasWei: '20', gasUsdc: '30000', fees: [{ tokenId: '6291325', pool: POOL, fee0: '1', fee1: '1', usdc: '12000' }] } })
const swap = eng('b', 'enter_swap', '2026-10-26T14:17:00.000Z', { tokenIn: 'USDT', tokenOut: 'USDC', amountIn: '5756781', facts: { at: 'x', gasWei: '10', gasUsdc: '8000', fees: [] } })
const mint = eng('c', 'enter_mint', '2026-10-26T14:18:00.000Z', { tickLower: 11, tickUpper: 52, tokenId: '6358057', facts: { at: 'x', gasWei: '30', gasUsdc: '12000', fees: [] } })
const harvest = eng('d', 'harvest', '2026-10-26T14:10:00.000Z', { pool: 'pool:USDC/cbBTC/500' })
const owner: OpView = { opId: 'own-3-transfer', kind: 'transfer', state: 'confirmed', updatedAt: '2026-10-26T10:00:00.000Z' }

describe('historyEntries (#219)', () => {
  test('close, swap and open in one pool fold into one move; other pools and owner ops stay rows', () => {
    const entries = historyEntries([mint, owner, swap, harvest, close])
    expect(entries.map((e) => (e.type === 'op' ? e.op.opId : `move:${e.move.ops.length}`))).toEqual(['move:3', harvest.opId, owner.opId])
    const m = (entries[0] as { type: 'move'; move: Move }).move
    expect(m.ops.map((o) => stepOf(o))).toEqual(['rerange', 'enter_swap', 'enter_mint'])
    expect(m.open).toBe(mint)
    expect(m.updatedAt).toBe(mint.updatedAt)
    expect(moveState(m)).toBe('done')
    expect(moveLine(m)).toBe('Moved your USDC/USDT range')
  })

  test('a move still waiting for its open is in progress', () => {
    const m = (historyEntries([close, swap], Date.parse(swap.updatedAt) + 60_000)[0] as { type: 'move'; move: Move }).move
    expect(m.open).toBeNull()
    expect(moveState(m)).toBe('pending')
    expect(moveLine(m)).toBe('Moving your USDC/USDT range')
  })

  test('an open long after the close is a separate entry, not part of the move', () => {
    const late = { ...mint, updatedAt: '2026-10-27T02:00:00.000Z' }
    expect(historyEntries([close, late]).map((e) => e.type)).toEqual(['op', 'move'])
  })

  test('no open within the window, or a newer close in the pool: the move is stalled, not pending forever', () => {
    const late = historyEntries([close, swap], Date.parse(close.updatedAt) + 7 * 3_600_000)
    expect(moveState((late[0] as { type: 'move'; move: Move }).move)).toBe('stalled')
    const again = { ...close, opId: 'eng-1-1-z-rerange', updatedAt: '2026-10-26T14:05:00.000Z' }
    const both = historyEntries([close, again, mint], Date.parse(again.updatedAt) + 60_000).filter((e) => e.type === 'move').map((e) => (e as { type: 'move'; move: Move }).move)
    expect(both.map((m) => [m.id, moveState(m)])).toEqual([[again.opId, 'done'], [close.opId, 'stalled']])
    expect(moveLine(both[1]!)).toBe('Closed your USDC/USDT range, not reopened yet')
  })

  test('chain order wins over updatedAt: a close re-stamped after its swap still leads the move', () => {
    const entries = historyEntries([{ ...close, block: 1, updatedAt: '2026-10-26T14:30:00.000Z' }, { ...swap, block: 2 }, { ...mint, block: 3, updatedAt: '2026-10-26T14:31:00.000Z' }])
    expect(entries).toHaveLength(1)
    expect((entries[0] as { type: 'move'; move: Move }).move.ops.map((o) => stepOf(o))).toEqual(['rerange', 'enter_swap', 'enter_mint'])
  })

  test('pool-less rows (before #131) are never grouped', () => {
    const { pool: _a, ...c } = close
    const { pool: _b, ...w } = swap
    expect(historyEntries([c, w]).map((e) => e.type)).toEqual(['op', 'op'])
  })

  test('rows stored before `step` existed are read from the opId suffix', () => {
    const { step: _s, ...old } = close
    expect(stepOf(old)).toBe('rerange')
    expect(stepOf(owner)).toBeNull()
  })
})

describe('move detail (#219)', () => {
  test('steps say what each transaction did', () => {
    expect(stepLine(close, 'out')).toBe('Closed the out-of-range position')
    expect(stepLine(swap, 'out')).toBe('Adjusted the token amounts: 5.756781 USDT to USDC')
    expect(stepLine({ ...swap, amountOut: '5738297' }, 'out')).toBe('Adjusted the token amounts: 5.756781 USDT to about 5.73 USDC')
    expect(stepLine(mint, 'out')).toBe('Opened a position in range')
  })

  test('the reason is plain, and old rows get the general rule', () => {
    expect(moveReason('out')).toContain('left your range')
    expect(moveReason(undefined)).toContain('leaves it or comes close to its edge')
  })

  test('gas sums every step in USDC; fees are what the close collected', () => {
    const g = gasOf([close, swap, mint])!
    expect(g).toEqual({ usdc: 50_000n, wei: 60n, count: 3 })
    expect(gasLabel(g)).toBe('0.050 USDC')
    expect(gasLabel({ usdc: 13_125n, wei: 1n, count: 1 })).toBe('0.013 USDC')
    expect(gasLabel({ usdc: 400n, wei: 1n, count: 1 })).toBe('< 0.001 USDC')
    expect(gasLabel({ usdc: 1_200_000n, wei: 1n, count: 1 })).toBe('1.20 USDC')
    expect(gasOf([{ ...owner }])).toBeNull()
    expect(feesOf(close)).toBe(12_000n)
  })

  test('an unpriced step shows gas in ETH', () => {
    const g = gasOf([close, { ...swap, facts: { at: 'x', gasWei: '1000000000000', fees: [] } }])!
    expect(g.usdc).toBeNull()
    expect(gasLabel(g)).toBe('0.000001 ETH')
    expect(gasLabel(g, 'MON')).toBe('0.000001 MON')
  })

  test('ranges read as the other token in USDC', () => {
    // USDC is token0 of USDC/USDT: tick 31 is 1 USDT = 0.9969 USDC.
    expect(rangeLabel(POOL, 11, 52)).toBe('0.9948 – 0.9989 USDC per USDT')
    expect(rangeLabel(POOL, -20, 20)).toBe('0.9980 – 1.0020 USDC per USDT')
    expect(rangeLabel(POOL, undefined, 52)).toBeNull()
  })
})
