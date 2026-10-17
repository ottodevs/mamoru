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
/** The Safe tx hash the stop was signed for, and another transaction of the same Safe. */
const SAFE_TX = `0x${'a1'.repeat(32)}` as const
const OTHER_TX = `0x${'b2'.repeat(32)}` as const

function setup(withHash: boolean, archiveOnly = false, logged: string = SAFE_TX, kept: string | null = SAFE_TX) {
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
      { opId: 'own-2-exit', kind: 'exit', state: 'failed', code: 'OWNER_TX_ERROR', ...(withHash ? { txHash: TX } : {}), ...(kept ? { safeTxHash: kept } : {}), updatedAt: '2026-09-26T21:11:54.000Z' },
    ],
  } as unknown as AccountState
  const receipt = { transactionHash: TX, status: 'success', blockNumber: 51833884n, from: RELAYER, logs: [{ address: SAFE, topics: [EXECUTION_SUCCESS, logged] }] } as unknown as TransactionReceipt
  let calls = 0
  const client = {
    getTransactionReceipt: async () => {
      if (calls++ === 0 || archiveOnly) throw new Error('Archive requests require a personal token')
      return receipt
    },
    getBlock: async () => ({ number: 51833900n, timestamp: BigInt(Date.parse('2026-09-26T21:12:26.000Z') / 1000) }),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      fromBlock <= 51833884n && 51833884n <= toBlock ? [{ address: SAFE, topics: [EXECUTION_SUCCESS, logged], transactionHash: TX, blockNumber: 51833884n }] : [],
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

  test('without a hash kept, another transaction of the Safe that spent the nonce is not taken for the stop', async () => {
    const { acc, op } = setup(false, true, OTHER_TX)
    await op.reconcileOwner(acc)
    expect(acc.ops[1]).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.active).toBe(true)
    expect(acc.grants).toHaveLength(1)
  })

  test('without a hash and without the Safe tx hash (an op stored before it was kept), no log is taken for it', async () => {
    const { acc, op } = setup(false, true, SAFE_TX, null)
    await op.reconcileOwner(acc)
    expect(acc.ops[1]).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.active).toBe(true)
  })

  test('a stop found late leaves the grants enabled after it remembered, for the next stop to revoke', async () => {
    const { acc, op } = setup(true)
    // The stop revoked 0xaa; a renewal that ran after it put the engine on 0xbb.
    ;(acc.ops[1] as { revokes?: string[] }).revokes = ['0xaa']
    acc.grants = [{ name: 'enter-swap', permissionId: '0xbb' }] as never
    await op.reconcileOwner(acc)
    expect(acc.active).toBe(false)
    expect(acc.revoked).toEqual(['0xaa'])
    expect(acc.superseded).toEqual(['0xbb'])
  })

  test('an activation found late on an account already running leaves its grants remembered, for a stop to revoke', async () => {
    const { acc, op } = setup(true)
    Object.assign(acc.ops[1]!, { opId: 'own-2-activate', kind: 'activate', ownerGrants: [{ name: 'enter-swap', permissionId: '0xcc' }] })
    await op.reconcileOwner(acc)
    expect(acc.ops[1]).toMatchObject({ state: 'confirmed' })
    expect(acc.grants).toEqual([{ name: 'enter-swap', permissionId: '0xaa' }] as never)
    expect(acc.superseded).toEqual(['0xcc'])
  })

  test('otto/mamoru#140: a stop that landed late (its hash lost) is found from its send block, in pages of at most 2000 blocks sent one at a time', async () => {
    const { acc, op } = setup(false, true)
    const head = 51_900_000n
    const headTs = BigInt(Date.parse('2026-09-26T21:12:26.000Z') / 1000)
    // Sent 3000 s (1500 blocks) before the head; landed 600 blocks after it was sent, far past the old +10 window.
    const stop = acc.ops[1]! as unknown as { sentAt: number; updatedAt: string }
    stop.sentAt = Number(headTs - 3000n) * 1000
    stop.updatedAt = new Date(Number(headTs - 3000n) * 1000).toISOString()
    const landed = head - 1500n + 600n
    const pages: [bigint, bigint][] = []
    let inflight = 0
    let peak = 0
    const c = (op as unknown as { client: Record<string, unknown> }).client
    c.getBlock = async () => ({ number: head, timestamp: headTs })
    c.getLogs = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      inflight++
      peak = Math.max(peak, inflight)
      pages.push([fromBlock, toBlock])
      await Bun.sleep(1)
      inflight--
      return fromBlock <= landed && landed <= toBlock ? [{ address: SAFE, topics: [EXECUTION_SUCCESS, SAFE_TX], transactionHash: TX, blockNumber: landed }] : []
    }
    await op.reconcileOwner(acc)
    expect(acc.ops[1]).toMatchObject({ state: 'confirmed', txHash: TX, block: Number(landed) })
    expect(peak).toBe(1)
    expect(pages.every(([f, t]) => t - f < 2000n)).toBe(true)
    expect(pages[0]![0]).toBe(head - 1500n - 150n)
  })

  test('otto/mamoru#140: a log of another Safe tx hash in that range is never taken for the op', async () => {
    const { acc, op } = setup(false, true)
    const c = (op as unknown as { client: Record<string, unknown> }).client
    c.getLogs = async () => [{ address: SAFE, topics: [EXECUTION_SUCCESS, OTHER_TX], transactionHash: TX, blockNumber: 51833884n }]
    await op.reconcileOwner(acc)
    expect(acc.ops[1]).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  test('otto/mamoru#140: an armed Start sent days after it was prepared is searched for from when it was handed to a provider', async () => {
    const { acc, op } = setup(false, true)
    const head = 51_900_000n
    const headTs = BigInt(Date.parse('2026-09-26T21:12:26.000Z') / 1000)
    const stop = acc.ops[1]! as unknown as { sentAt: number; broadcastAt: number; lastBroadcastAt: number; updatedAt: string }
    // Prepared (armed) three days before the head; first handed to a provider 1500 blocks before it, last 1000.
    stop.sentAt = Number(headTs - 3n * 86_400n) * 1000
    stop.updatedAt = new Date(stop.sentAt).toISOString()
    stop.broadcastAt = Number(headTs - 3000n) * 1000
    stop.lastBroadcastAt = Number(headTs - 2000n) * 1000
    const landed = head - 900n
    const c = (op as unknown as { client: Record<string, unknown> }).client
    const pages: bigint[] = []
    c.getBlock = async () => ({ number: head, timestamp: headTs })
    c.getLogs = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      pages.push(fromBlock)
      return fromBlock <= landed && landed <= toBlock ? [{ address: SAFE, topics: [EXECUTION_SUCCESS, SAFE_TX], transactionHash: TX, blockNumber: landed }] : []
    }
    await op.reconcileOwner(acc)
    expect(acc.ops[1]).toMatchObject({ state: 'confirmed', txHash: TX })
    expect(pages[0]).toBe(head - 1500n - 150n)
  })
})
