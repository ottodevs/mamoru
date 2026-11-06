import { describe, expect, test } from 'bun:test'
import { baseRegistry } from '@mamoru/registry'
import { harvestedOf } from '../src/harvested.ts'
import type { StoredOp } from '../src/state.ts'

const POOL = 'pool:WETH/USDC/500'
const pool = baseRegistry.entries.find((e) => e.name === POOL)!
const weth = pool.token0 === 'USDC' ? 'fee1' : 'fee0'
const at = (s: number) => new Date(s * 1000).toISOString()
const op = (n: number, step: StoredOp['step'], extra: Partial<StoredOp> = {}): StoredOp => ({ opId: `eng-${n}`, kind: 'reduce', state: 'confirmed', updatedAt: at(n), block: n, step, pool: POOL, ...extra }) as StoredOp
const harvest = (n: number, wethFee: bigint, usdcFee = 0n) =>
  op(n, 'harvest', { facts: { at: at(1000 + n), gasWei: '1', fees: [{ tokenId: '1', pool: POOL, fee0: (weth === 'fee0' ? wethFee : usdcFee).toString(), fee1: (weth === 'fee1' ? wethFee : usdcFee).toString() }] } })

describe('harvestedOf (spec 012 HT5, HRV-R1/R2, HRV-S21, S25)', () => {
  test('a harvest adds its non-USDC fees, from its own time; USDC fees are not harvested volatile', () => {
    expect(harvestedOf([harvest(1, 10n, 5n)], baseRegistry)).toEqual({ WETH: { amount: 10n, since: 1001 } })
  })

  test('a swap of the token takes its amount off, harvested first; the counter never goes below 0', () => {
    expect(harvestedOf([harvest(1, 10n), op(2, 'enter_swap', { tokenIn: 'WETH', tokenOut: 'USDC', amountIn: '4' })], baseRegistry)).toEqual({ WETH: { amount: 6n, since: 1001 } })
    expect(harvestedOf([harvest(1, 10n), op(2, 'enter_swap', { tokenIn: 'WETH', tokenOut: 'USDC', amountIn: '40' })], baseRegistry)).toEqual({})
  })

  test('HRV-S21: a re-range mint in a pool with the token zeroes it: a later sale never reaches principal', () => {
    expect(harvestedOf([harvest(1, 10n), op(2, 'rerange')], baseRegistry)).toEqual({})
    expect(harvestedOf([harvest(1, 10n), op(2, 'rerange'), harvest(3, 7n)], baseRegistry)).toEqual({ WETH: { amount: 7n, since: 1003 } })
  })

  test('HRV-S25: derived from the stored ops, so a restart keeps it and its since; order is by block, not by array', () => {
    const ops = [harvest(5, 3n), harvest(1, 10n)]
    expect(harvestedOf(ops, baseRegistry)).toEqual({ WETH: { amount: 13n, since: 1001 } })
  })

  test('a confirmed harvest whose receipt is not read yet makes it unknown (null): nothing is sold', () => {
    expect(harvestedOf([harvest(1, 10n), op(2, 'harvest')], baseRegistry)).toBeNull()
  })

  test('an unconfirmed op does not count; any confirmed owner op (a withdrawal) clears everything before it', () => {
    expect(harvestedOf([{ ...harvest(1, 10n), state: 'submitted' } as StoredOp], baseRegistry)).toEqual({})
    const withdraw = { opId: 'own-2', kind: 'transfer', state: 'confirmed', updatedAt: at(2), block: 2 } as StoredOp
    expect(harvestedOf([harvest(1, 10n), withdraw, harvest(3, 4n)], baseRegistry)).toEqual({ WETH: { amount: 4n, since: 1003 } })
  })

  test('a confirmed op with no block recorded yet makes it unknown (null)', () => {
    expect(harvestedOf([harvest(1, 10n), { ...op(2, 'enter_swap', { tokenIn: 'WETH', amountIn: '10' }), block: undefined } as StoredOp], baseRegistry)).toBeNull()
  })
})
