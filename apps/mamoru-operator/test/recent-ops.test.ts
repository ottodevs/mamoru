// otto/mamoru#129: Operator.recentOps() feeds GET /metrics `opsRecent` for the /ops console. Confirms it never
// leaks a sensitive StoredOp field (grants, session key, signature, permissionId, calls, ...), orders newest
// first across accounts by updatedAt, and respects the limit.
import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { POLICIES } from '@mamoru/policy'
import { Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore, StoredOp } from '../src/state.ts'
import { baseRegistry } from '@mamoru/registry'

function world(accounts: Record<string, AccountState>) {
  const client = { getBlockNumber: async () => 1n } as unknown as PublicClient
  const relayer = { address: `0x${'7'.repeat(40)}` } as unknown as Relayer
  const store = { state: { accounts }, save: () => {} } as unknown as StateStore
  const cfg = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 } satisfies OperatorConfig
  return new Operator(cfg, client, relayer, store)
}

const at = (i: number) => `2026-10-10T00:0${i}:00.000Z`

function account(accountKey: string, ops: StoredOp[]): AccountState {
  return { accountKey, ops } as unknown as AccountState
}

describe('Operator.recentOps (otto/mamoru#129)', () => {
  test('newest first across every account, by updatedAt', () => {
    const op = world({
      a: account('aaaaaaaa11112222', [
        { opId: 'own-1-activate', kind: 'activate', state: 'confirmed', updatedAt: at(1) },
        { opId: 'eng-1-1-op-1-enter', kind: 'enter', state: 'confirmed', updatedAt: at(4) },
      ]),
      b: account('bbbbbbbb33334444', [{ opId: 'own-1-renew', kind: 'renew', state: 'confirmed', updatedAt: at(2) }]),
    })
    expect(op.recentOps(10).map((o) => o.at)).toEqual([at(4), at(2), at(1)])
  })

  test('accountKey is shortened to 8 chars, kind/state/code pass through, code defaults to null', () => {
    const op = world({
      a: account('aaaaaaaa11112222', [
        { opId: 'own-1-activate', kind: 'activate', state: 'failed', code: 'DEPOSIT_OVER_CAP', updatedAt: at(1) },
        { opId: 'own-2-transfer', kind: 'transfer', state: 'confirmed', updatedAt: at(2) },
      ]),
    })
    expect(op.recentOps(10)).toEqual([
      { accountKey: 'aaaaaaaa', kind: 'transfer', state: 'confirmed', at: at(2), code: null },
      { accountKey: 'aaaaaaaa', kind: 'activate', state: 'failed', at: at(1), code: 'DEPOSIT_OVER_CAP' },
    ])
  })

  test('limit bounds the count, keeping the newest', () => {
    const op = world({
      a: account('aaaaaaaa', [
        { opId: 'o1', kind: 'enter', state: 'confirmed', updatedAt: at(1) },
        { opId: 'o2', kind: 'enter', state: 'confirmed', updatedAt: at(2) },
        { opId: 'o3', kind: 'enter', state: 'confirmed', updatedAt: at(3) },
      ]),
    })
    const out = op.recentOps(2)
    expect(out.length).toBe(2)
    expect(out.map((o) => o.at)).toEqual([at(3), at(2)])
  })

  test('never carries a grant, session key, signature, permissionId, calls or any field beyond the five allowed', () => {
    const op = world({
      a: account('aaaaaaaa', [
        {
          opId: 'eng-1-1-op-1-enter_mint',
          kind: 'enter',
          state: 'confirmed',
          code: 'EXEC_OK',
          updatedAt: at(1),
          permissionId: '0xdeadbeef',
          calls: [{ to: '0x1', data: '0x2' } as unknown as StoredOp['calls'] extends (infer T)[] ? T : never],
          ownerGrants: [{ name: 'enter-swap', grant: {} as never, permissionId: '0x01' }],
          safeTxHash: '0xabc',
          safeNonce: '1',
        } as StoredOp,
      ]),
    })
    const [row] = op.recentOps(10)
    expect(Object.keys(row!).sort()).toEqual(['accountKey', 'at', 'code', 'kind', 'state'])
  })

  test('no accounts, or accounts with no ops, return an empty list', () => {
    expect(world({}).recentOps(10)).toEqual([])
    expect(world({ a: account('aaaaaaaa', []) }).recentOps(10)).toEqual([])
  })
})
