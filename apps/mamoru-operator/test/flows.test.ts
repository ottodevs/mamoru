import { describe, expect, test } from 'bun:test'
import type { StoredOp } from '../src/state.ts'
import type { DepositRow } from '../src/deposits.ts'
import { accountFlows } from '../src/flows.ts'

// otto/mamoru#380: external USDC flows from the rows the operator already keeps.
const dep = (tx: string, logIndex: number, amountUsdc: string, at: string): DepositRow => ({ txHash: `0x${tx}` as `0x${string}`, logIndex, block: '1', amountUsdc, from: '0x00000000000000000000000000000000000000aa', at })
const op = (o: Partial<StoredOp> & { opId: string }): StoredOp => ({ kind: 'transfer', state: 'confirmed', updatedAt: '2026-11-10T10:00:00.000Z', ...o }) as StoredOp

describe('accountFlows', () => {
  test('deposits are in, confirmed owner transfers are out, oldest first; the fee on top is not a withdrawal', () => {
    const flows = accountFlows(
      [dep('b1', 0, '2000000', '2026-11-09T10:00:00.000Z'), dep('a1', 3, '500000', '2026-11-08T10:00:00.000Z')],
      [op({ opId: 'own-1', txHash: '0xC1' as `0x${string}`, amountUsdc: '700000', feeUsdc: '20000' })],
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
      ],
    )
    expect(flows.map((f) => f.id)).toEqual(['in:0xa1:0'])
  })

  test('no deposits and no ops: nothing', () => {
    expect(accountFlows(undefined, [])).toEqual([])
  })
})
