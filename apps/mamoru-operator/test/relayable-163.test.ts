// otto/mamoru#163: a reverted owner activation (GS013) leaves its Safe nonce unspent, and the owner's signature can be
// relayed by anyone until something else takes that nonce. It is never closed on the revert alone.
import { describe, expect, test } from 'bun:test'
import { keccak256, stringToHex, type Hex, type TransactionReceipt } from 'viem'
import type { Operator } from '../src/operator.ts'
import type { AccountState, StoredOp } from '../src/state.ts'
import { SAFE, ctx, quiet, sign, world } from './owner-world.ts'

const EXECUTION_SUCCESS = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'))
type Prep = { prepared: Map<string, { tx: { nonce: bigint }; revokes?: Hex[] }> }
const prepared = (op: Operator, id: string) => (op as unknown as Prep).prepared.get(id)!
const reverted = (hash: Hex) => ({ transactionHash: hash, status: 'success', blockNumber: 101n, logs: [] }) as unknown as TransactionReceipt
const ids = (gs?: { permissionId: string }[]) => (gs ?? []).map((g) => g.permissionId)

/** A first Start whose execTransaction reverted: the Safe deployed, its nonce still 0. */
async function revertedStart() {
  const w = world(10_000_000n)
  ;(w.op as unknown as { startLoop(a: AccountState): void }).startLoop = () => {}
  w.knobs.execOk = false
  const first = (await quiet(async () => w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx))))).out
  const acc = w.state.accounts.k!
  const old = acc.ops.find((o) => o.opId === first.opId) as StoredOp
  w.knobs.execOk = true
  // Its own copy's receipt, as reconciliation reads it.
  w.knobs.receipts.set(old.signedTxs![0]!.hash.toLowerCase(), reverted(old.signedTxs![0]!.hash))
  return { w, acc, old }
}

describe('a reverted activation stays unresolved while its Safe nonce is unspent', () => {
  test('the signed copy is kept before it leaves; the revert is an unread outcome, not OWNER_TX_FAILED', async () => {
    const { w, acc, old } = await revertedStart()
    expect(old).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR', safeNonce: '0' })
    expect(old.signedTxs).toEqual([{ hash: expect.any(String), nonce: expect.any(Number), reverted: true }])
    expect(w.chain.nonce).toBe(0n)
    // Reconciliation reads the revert and the Safe nonce: still its own, so still open.
    await w.op.reconcileOwner(acc)
    expect(old).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.active).toBe(false)
  })

  test('Try again is allowed and signed for the same Safe nonce', async () => {
    const { w, old } = await revertedStart()
    const t = await w.op.prepareActivate(ctx)
    expect(prepared(w.op, t.prepareId).tx.nonce).toBe(BigInt(old.safeNonce!))
  })

  test('relayed later by anyone and executed: its own grants are applied', async () => {
    const { w, acc, old } = await revertedStart()
    // A third party relays the same signature: the Safe nonce moves and the Safe logs its ExecutionSuccess.
    w.chain.nonce = 1n
    w.knobs.safeLogs = [{ topics: [EXECUTION_SUCCESS, old.safeTxHash!], data: '0x', transactionHash: keccak256(stringToHex('relay')), blockNumber: 150n }]
    await quiet(() => w.op.reconcileOwner(acc))
    expect(old).toMatchObject({ state: 'confirmed', code: 'EXEC_OK', block: 150 })
    expect(acc.active).toBe(true)
    expect(ids(acc.grants)).toEqual(ids(old.ownerGrants))
  })

  test('the replacement ran: the old start is SUPERSEDED, and the account keeps the replacement grants', async () => {
    const { w, acc, old } = await revertedStart()
    const again = (await quiet(async () => w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx))))).out
    expect(again).toMatchObject({ state: 'confirmed' })
    const replacement = acc.ops.find((o) => o.opId === again.opId) as StoredOp
    expect(replacement.safeNonce).toBe(old.safeNonce)
    await quiet(() => w.op.reconcileOwner(acc))
    expect(old).toMatchObject({ state: 'failed', code: 'SUPERSEDED' })
    expect(ids(acc.grants)).toEqual(ids(replacement.ownerGrants))
  })

  test('another Safe tx took the nonce and this one never ran: SAFE_NONCE_MOVED', async () => {
    const { w, acc, old } = await revertedStart()
    w.chain.nonce = 1n
    await quiet(() => w.op.reconcileOwner(acc))
    expect(old).toMatchObject({ state: 'failed', code: 'SAFE_NONCE_MOVED' })
  })

  test('a Start while the Safe moved past an unresolved one that cannot be settled yet is refused, nothing signed', async () => {
    const { w, old } = await revertedStart()
    w.chain.nonce = 1n
    type Logs = { client: { getLogs(): Promise<unknown> } }
    ;(w.op as unknown as Logs).client.getLogs = async () => {
      throw new Error('HTTP request failed. Status: 503')
    }
    const e = (await quiet(() => w.op.prepareActivate(ctx).catch((x: unknown) => x))).out
    expect(e).toMatchObject({ status: 409, code: 'OWNER_OP_SETTLING' })
    expect(old).toMatchObject({ code: 'OWNER_TX_ERROR' })
  })

  test('a Stop revokes the grants of an unresolved start as well as the engine ones', async () => {
    const { w, old } = await revertedStart()
    const stop = await w.op.prepareStop(ctx, { revokeOnly: true })
    expect(prepared(w.op, stop.prepareId).revokes).toEqual(expect.arrayContaining(ids(old.ownerGrants)))
  })
})

describe('boot-time exposure scan (read only)', () => {
  test('lists reverted activations and renewals closed before this change whose Safe nonce has not moved past them', async () => {
    const w = world(10_000_000n)
    w.chain.deployed = true
    w.chain.nonce = 2n
    const acc = w.op.account(ctx).acc
    const at = new Date().toISOString()
    acc.ops.push(
      { opId: 'own-1-activate', kind: 'activate', state: 'failed', code: 'OWNER_TX_FAILED', updatedAt: at, safeNonce: '2', txHash: `0x${'11'.repeat(32)}` } as never,
      { opId: 'own-2-renew', kind: 'renew', state: 'failed', code: 'OWNER_TX_FAILED', updatedAt: at, safeNonce: '1' } as never,
      { opId: 'own-3-activate', kind: 'activate', state: 'failed', code: 'OWNER_TX_FAILED', updatedAt: at } as never,
      { opId: 'own-4-transfer', kind: 'transfer', state: 'failed', code: 'OWNER_TX_FAILED', updatedAt: at, safeNonce: '2' } as never,
    )
    const before = JSON.stringify(acc.ops.map((o) => [o.opId, o.state, o.code]))
    const lines: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
    let n = 0
    try {
      n = (await quiet(() => w.op.scanRevertedExposure())).out
    } finally {
      console.log = log
    }
    // own-1 (nonce 2, Safe at 2): relayable; own-3 (no nonce kept): to check by hand; own-2 (Safe past it) and the transfer: not listed.
    expect(n).toBe(2)
    expect(lines.filter((l) => l.startsWith('[exposure#163]')).map((l) => l.split(' ')[2])).toEqual(['own-1-activate', 'own-3-activate'])
    expect(lines.join('\n')).toContain(SAFE)
    expect(JSON.stringify(acc.ops.map((o) => [o.opId, o.state, o.code]))).toBe(before)
  })
})
