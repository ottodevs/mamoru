import { describe, expect, test } from 'bun:test'
import { collapseFailed } from '../src/operator.ts'

describe('collapseFailed', () => {
  test('repeated failed engine ops with the same code collapse into the newest', () => {
    const at = (i: number) => `2026-09-26T21:0${i}:00.000Z`
    const out = collapseFailed([
      { opId: 'own-1-activate', kind: 'activate', state: 'confirmed', updatedAt: at(0) },
      { opId: 'eng-1-1-op-1-enter_swap', kind: 'enter', state: 'failed', code: 'RECON_UNINCLUDABLE', updatedAt: at(1) },
      { opId: 'eng-1-1-op-2-enter_mint', kind: 'enter', state: 'confirmed', code: 'EXEC_OK', updatedAt: at(2), permissionId: '0x01', calls: [] },
      { opId: 'eng-1-2-op-1-enter_swap', kind: 'enter', state: 'failed', code: 'RECON_UNINCLUDABLE', updatedAt: at(3), count: 4 },
      { opId: 'own-2-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: at(4) },
    ])
    expect(out.map((o) => o.opId)).toEqual(['own-1-activate', 'eng-1-1-op-2-enter_mint', 'eng-1-2-op-1-enter_swap', 'own-2-exit'])
    expect((out[2] as { count?: number }).count).toBe(5)
    expect('calls' in out[1]!).toBe(false)
  })
})
