import { describe, expect, test } from 'bun:test'
import { keccak256, stringToHex, type PublicClient, type TransactionReceipt } from 'viem'
import type { AccountContext } from '@mamoru/domain'
import { Operator } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'

const SAFE = `0x${'5'.repeat(40)}` as const
const RELAYER = `0x${'7'.repeat(40)}` as const
const TX = `0x56aa1762${'0'.repeat(56)}` as const
const EXECUTION_SUCCESS = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'))

function setup(withHash: boolean, archiveOnly = false) {
  const acc = {
    accountKey: 'k',
    ctx: { accountKey: 'k', address: SAFE } as unknown as AccountContext,
    trusted: true,
    active: true,
    grants: [{ name: 'enter-swap', permissionId: '0xaa' }],
    revoked: [],
    managedTokenIds: [],
    depositsAfter: '0',
    historyFromBlock: '0',
    epoch: 1,
    seq: 2,
    ops: [
      { opId: 'own-1-activate', kind: 'activate', state: 'confirmed', txHash: `0x${'9'.repeat(64)}`, updatedAt: '2026-09-26T20:32:37.000Z' },
      { opId: 'own-2-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', ...(withHash ? { txHash: TX } : {}), updatedAt: '2026-09-26T21:11:54.000Z' },
    ],
  } as unknown as AccountState
  const receipt = { transactionHash: TX, status: 'success', blockNumber: 51833884n, from: RELAYER, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS] }] } as unknown as TransactionReceipt
  let calls = 0
  const client = {
    getTransactionReceipt: async () => {
      if (calls++ === 0 || archiveOnly) throw new Error('Archive requests require a personal token')
      return receipt
    },
    getBlock: async () => ({ number: 51833900n, timestamp: BigInt(Date.parse('2026-09-26T21:12:26.000Z') / 1000) }),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      fromBlock <= 51833884n && 51833884n <= toBlock ? [{ address: SAFE, topics: [EXECUTION_SUCCESS], transactionHash: TX, blockNumber: 51833884n }] : [],
  } as unknown as PublicClient
  const store = { state: { accounts: { k: acc } }, save: () => {} } as unknown as StateStore
  const op = new Operator({} as never, client, { address: RELAYER } as unknown as Relayer, store)
  return { acc, op }
}

describe('owner receipt reconciliation', () => {
  for (const [withHash, archiveOnly] of [[true, false], [true, true], [false, true]] as const) {
    test(`a stop whose receipt poll failed becomes confirmed (hash ${withHash ? 'kept' : 'found in logs'}, receipt ${archiveOnly ? 'refused' : 'served'})`, async () => {
      const { acc, op } = setup(withHash, archiveOnly)
      await op.reconcileOwner(acc)
      const stop = acc.ops[1]!
      expect(stop.state).toBe('confirmed')
      expect(stop.txHash).toBe(TX)
      expect(stop.block).toBe(51833884)
      expect(acc.active).toBe(false)
      expect(acc.grants).toEqual([])
      expect(acc.revoked).toEqual(['0xaa'])
    })
  }
})
