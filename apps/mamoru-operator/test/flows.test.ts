import { describe, expect, test } from 'bun:test'
import type { StoredOp } from '../src/state.ts'
import type { DepositRow } from '../src/deposits.ts'
import { accountFlows } from '../src/flows.ts'

// otto/mamoru#380: external USDC flows from the rows the operator already keeps.
const dep = (tx: string, logIndex: number, amountUsdc: string, at: string): DepositRow => ({ txHash: `0x${tx}` as `0x${string}`, logIndex, block: '1', amountUsdc, from: '0x00000000000000000000000000000000000000aa', at })
const facts = (txHash: string, at: string) => ({ txHash, at, gasWei: '0', fees: [], v: 2 })
const op = (o: Partial<StoredOp> & { opId: string }): StoredOp => ({ kind: 'transfer', state: 'confirmed', updatedAt: '2026-11-10T10:00:00.000Z', ...o }) as StoredOp

describe('accountFlows', () => {
  test('deposits are in, confirmed owner transfers are out, oldest first; the fee on top is not a withdrawal', () => {
    const flows = accountFlows(
      [dep('b1', 0, '2000000', '2026-11-09T10:00:00.000Z'), dep('a1', 3, '500000', '2026-11-08T10:00:00.000Z')],
      [op({ opId: 'own-1', txHash: '0xC1' as `0x${string}`, amountUsdc: '700000', feeUsdc: '20000', facts: facts('0xC1', '2026-11-10T10:00:00.000Z') })],
    )
    expect(flows).toEqual([
      { id: 'in:0xa1:3', t: Date.parse('2026-11-08T10:00:00.000Z') / 1000, kind: 'in', usdc: '500000' },
      { id: 'in:0xb1:0', t: Date.parse('2026-11-09T10:00:00.000Z') / 1000, kind: 'in', usdc: '2000000' },
      { id: 'out:0xc1', t: Date.parse('2026-11-10T10:00:00.000Z') / 1000, kind: 'out', usdc: '700000' },
    ])
  })

  test('failed, proposed, engine and non-transfer ops, undated rows and zero amounts are left out; a repeated deposit counts once', () => {
    const flows = accountFlows(
      [dep('a1', 0, '1000000', '2026-11-08T10:00:00.000Z'), dep('a1', 0, '1000000', '2026-11-08T10:00:00.000Z'), dep('a2', 0, '0', '2026-11-08T10:00:00.000Z'), dep('a3', 0, '5', 'never')],
      [
        op({ opId: 'own-2', state: 'failed', amountUsdc: '1000000' }),
        op({ opId: 'own-3', state: 'submitted', amountUsdc: '1000000' }),
        op({ opId: 'eng-1', amountUsdc: '1000000' }),
        op({ opId: 'own-4', kind: 'exit', amountUsdc: '1000000' }),
        op({ opId: 'own-5' }),
        op({ opId: 'own-6', txHash: '0xd6' as `0x${string}`, amountUsdc: '1000000', facts: facts('0xd6', 'never') }),
      ],
    )
    expect(flows.map((f) => f.id)).toEqual(['in:0xa1:0', 'gap:own-6'])
  })

  test('a withdrawal is dated by its receipt block, not by when it was reconciled; it waits for its facts', () => {
    const mined = '2026-11-10T23:59:30.000Z'
    const o = op({ opId: 'own-7', txHash: '0xe7' as `0x${string}`, amountUsdc: '1000000', updatedAt: '2026-11-11T00:03:00.000Z' })
    expect(accountFlows([], [o])).toEqual([]) // receipt not read yet: next snapshot
    o.facts = facts('0xe7', mined) as never
    expect(accountFlows([], [o])).toEqual([{ id: 'out:0xe7', t: Date.parse(mined) / 1000, kind: 'out', usdc: '1000000' }])
  })

  test('a receipt given up on, a confirmed withdrawal with no transaction, and a deposit list at its cap are gaps', () => {
    const lost = op({ opId: 'own-8', amountUsdc: '1000000' })
    const gave = op({ opId: 'own-9', txHash: '0xe9' as `0x${string}`, amountUsdc: '1000000', factsMisses: { txHash: '0xe9', count: 99, first: Date.now() - 48 * 3_600_000 } })
    const full = Array.from({ length: 200 }, (_, i) => dep(`f${i}`, 0, '5000000', '2026-11-08T10:00:00.000Z'))
    expect(accountFlows([], [lost, gave], 1000).map((f) => [f.id, f.kind, f.t])).toEqual([['gap:own-8', 'gap', 1000], ['gap:own-9', 'gap', 1000]])
    expect(accountFlows(full, [], 1000).filter((f) => f.kind === 'gap')).toEqual([{ id: 'gap:deposits-cap', t: 1000, kind: 'gap', usdc: '0' }])
  })

  test('no deposits and no ops: nothing', () => {
    expect(accountFlows(undefined, [])).toEqual([])
  })
})
