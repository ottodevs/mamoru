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

/** Shaped as on Base: topics [ExecutionSuccess, safeTxHash], data the payment only. */
const execLog = (safeTxHash: Hex, tx: string, block: bigint) => ({ topics: [EXECUTION_SUCCESS, safeTxHash], data: `0x${'0'.repeat(64)}` as Hex, transactionHash: keccak256(stringToHex(tx)), blockNumber: block })

/** The Safe nonce went from 0 to 1 at block `at`; the head is past it. */
const spentAt = (w: ReturnType<typeof world>, at: bigint) => {
  w.chain.nonce = 1n
  w.knobs.nonceAt = (b) => (b >= at ? 1n : 0n)
  w.knobs.blockHead = at + 20n
}

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
    // Shaped as on Base: topics [ExecutionSuccess, safeTxHash], data the payment only.
    w.knobs.safeLogs = [{ topics: [EXECUTION_SUCCESS, old.safeTxHash!], data: `0x${'0'.repeat(64)}`, transactionHash: keccak256(stringToHex('relay')), blockNumber: 150n }]
    // Twenty blocks past it: deep enough to settle on.
    w.knobs.blockHead = 170n
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
    // The chain: the replacement spent nonce 0 at block 101, its log in that block.
    spentAt(w, 101n)
    w.knobs.safeLogs = [{ ...execLog(replacement.safeTxHash!, 'replacement', 101n), transactionHash: replacement.txHash as Hex }]
    await quiet(() => w.op.reconcileOwner(acc))
    expect(old).toMatchObject({ state: 'failed', code: 'SUPERSEDED' })
    expect(ids(acc.grants)).toEqual(ids(replacement.ownerGrants))
  })

  test('another Safe tx took the nonce, as its block\'s own log shows: SAFE_NONCE_MOVED, with that Safe tx as evidence', async () => {
    const { w, acc, old } = await revertedStart()
    const other = keccak256(stringToHex('a withdrawal'))
    spentAt(w, 110n)
    w.knobs.safeLogs = [execLog(other, 'withdrawal', 110n)]
    await quiet(() => w.op.reconcileOwner(acc))
    expect(old).toMatchObject({ state: 'failed', code: 'SAFE_NONCE_MOVED', block: 110, spentBy: other })
  })

  test('a log backend behind (a range search answers empty) never closes it: the spending block\'s own logs confirm it', async () => {
    const { w, acc, old } = await revertedStart()
    spentAt(w, 110n)
    w.knobs.safeLogs = [execLog(old.safeTxHash!, 'relay', 110n)]
    w.knobs.rangeLogsLag = true
    await quiet(() => w.op.reconcileOwner(acc))
    expect(old).toMatchObject({ state: 'confirmed', code: 'EXEC_OK', block: 110 })
    expect(acc.active).toBe(true)
  })

  test('the spending block\'s logs cannot be read (by hash), or show no Safe execution: no conclusion, it stays open', async () => {
    for (const how of ['down', 'empty'] as const) {
      const { w, acc, old } = await revertedStart()
      spentAt(w, 110n)
      w.knobs.rangeLogsLag = true
      if (how === 'down') {
        w.knobs.safeLogs = [execLog(keccak256(stringToHex('other')), 'other', 110n)]
        w.knobs.blockLogsDown = true
      }
      await quiet(() => w.op.reconcileOwner(acc))
      expect(old, how).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
      expect(old.spentBy, how).toBeUndefined()
    }
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

  test('relayed by anyone between Start\'s checks and its nonce read: settled as run, and no approval for the next nonce', async () => {
    const { w, acc, old } = await revertedStart()
    // Not reconciled yet: the account still reads as not running when Start checks it.
    w.chain.nonce = 1n
    w.knobs.safeLogs = [{ topics: [EXECUTION_SUCCESS, old.safeTxHash!], data: `0x${'0'.repeat(64)}`, transactionHash: keccak256(stringToHex('relay')), blockNumber: 150n }]
    // Twenty blocks past it: deep enough to settle on.
    w.knobs.blockHead = 170n
    const before = (w.op as unknown as Prep).prepared.size
    const e = (await quiet(() => w.op.prepareActivate(ctx).catch((x: unknown) => x))).out
    expect(e).toMatchObject({ status: 409, code: 'ALREADY_ACTIVE' })
    expect((w.op as unknown as Prep).prepared.size).toBe(before)
    expect(old).toMatchObject({ state: 'confirmed' })
    expect(acc.active).toBe(true)
  })

  test('our receipt unavailable: a third party\'s execution in another tx confirms it; an unrelated Safe tx moving the nonce closes it, and Start is free again', async () => {
    const ran = await revertedStart()
    ran.w.knobs.receipts.clear()
    ran.w.chain.nonce = 1n
    ran.w.knobs.safeLogs = [{ topics: [EXECUTION_SUCCESS, ran.old.safeTxHash!], data: `0x${'0'.repeat(64)}`, transactionHash: keccak256(stringToHex('relay')), blockNumber: 150n }]
    ran.w.knobs.blockHead = 170n
    await quiet(() => ran.w.op.reconcileOwner(ran.acc))
    expect(ran.old).toMatchObject({ state: 'confirmed', block: 150 })
    expect(ran.acc.active).toBe(true)

    const moved = await revertedStart()
    moved.w.knobs.receipts.clear()
    spentAt(moved.w, 110n)
    moved.w.knobs.safeLogs = [execLog(keccak256(stringToHex('a withdrawal')), 'withdrawal', 110n)]
    await quiet(() => moved.w.op.reconcileOwner(moved.acc))
    expect(moved.old).toMatchObject({ state: 'failed', code: 'SAFE_NONCE_MOVED' })
    const t = await moved.w.op.prepareActivate(ctx)
    expect(prepared(moved.w.op, t.prepareId).tx.nonce).toBe(1n)
    // receiptOf waits between its tries on an unreadable receipt.
  }, 30_000)

  test('a lagging second view (block B answered with another hash, its log not served yet) concludes nothing; consistent, it confirms', async () => {
    const { w, acc, old } = await revertedStart()
    // Executed at block 150 by a relay: the head is 150 and the nonce there is 1, but the node that serves the logs
    // and block 150 by number is behind (no log yet, another hash for 150).
    w.knobs.blockHead = 150n
    w.chain.nonce = 1n
    w.knobs.blockHashes.set(150n, keccak256(stringToHex('another view of 150')))
    await quiet(() => w.op.reconcileOwner(acc))
    expect(old).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    expect(acc.active).toBe(false)
    // The same view everywhere now: the block that spent the nonce is served, its log shows the execution.
    w.knobs.blockHashes.clear()
    w.knobs.nonceAt = (b) => (b >= 150n ? 1n : 0n)
    w.knobs.safeLogs = [{ topics: [EXECUTION_SUCCESS, old.safeTxHash!], data: `0x${'0'.repeat(64)}`, transactionHash: keccak256(stringToHex('relay')), blockNumber: 150n }]
    w.knobs.blockHead = 170n
    await quiet(() => w.op.reconcileOwner(acc))
    expect(old).toMatchObject({ state: 'confirmed', block: 150 })
    expect(acc.active).toBe(true)
  })

  test('a guard ran another Safe tx inside ours: two executions in X, ours second, decided by its hash (confirmed)', async () => {
    const { w, acc, old } = await revertedStart()
    // Nonce 0 (ours) and 1 (run by a guard inside ours) both spent at block 110; the inner one's log comes first.
    w.chain.nonce = 2n
    w.knobs.nonceAt = (b) => (b >= 110n ? 2n : 0n)
    w.knobs.blockHead = 130n
    w.knobs.rangeLogsLag = true
    w.knobs.safeLogs = [execLog(keccak256(stringToHex('inner')), 'outer-tx', 110n), execLog(old.safeTxHash!, 'outer-tx', 110n)]
    await quiet(() => w.op.reconcileOwner(acc))
    expect(old).toMatchObject({ state: 'confirmed', block: 110, txHash: keccak256(stringToHex('outer-tx')) })
    expect(acc.active).toBe(true)
  })

  test('ours absent from X: another Safe tx spent the nonce only with no guard and exactly one execution there; otherwise open', async () => {
    for (const how of ['guard', 'two-logs'] as const) {
      const { w, acc, old } = await revertedStart()
      spentAt(w, 110n)
      w.knobs.rangeLogsLag = true
      w.knobs.safeLogs = [execLog(keccak256(stringToHex('a withdrawal')), 'withdrawal', 110n)]
      if (how === 'guard') w.knobs.guard = `0x${'0'.repeat(24)}${'9'.repeat(40)}`
      else w.knobs.safeLogs.push(execLog(keccak256(stringToHex('another')), 'another', 110n))
      await quiet(() => w.op.reconcileOwner(acc))
      expect(old, how).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
      expect(old.spentBy, how).toBeUndefined()
    }
  })

  test('while the Safe nonce is still its own, a settle pass reads no logs at all', async () => {
    const { w, acc, old } = await revertedStart()
    let calls = 0
    type L = { client: { getLogs(a: unknown): Promise<unknown> } }
    const client = (w.op as unknown as L).client
    const getLogs = client.getLogs.bind(client)
    client.getLogs = async (a) => (calls++, getLogs(a))
    for (let i = 0; i < 3; i++) await quiet(() => w.op.reconcileOwner(acc))
    expect(calls).toBe(0)
    expect(old).toMatchObject({ code: 'OWNER_TX_ERROR' })
  })

  test('a long-pending op: each pass scans at most 20 pages, resuming from its checkpoint', async () => {
    const { w, acc, old } = await revertedStart()
    w.chain.nonce = 1n
    w.knobs.nonceAt = (b) => (b >= 199_990n ? 1n : 0n)
    w.knobs.blockHead = 200_000n
    w.knobs.rangeLogsLag = true
    // The spending block cannot be read: the op stays open, pass after pass.
    w.knobs.blockLogsDown = true
    old.scannedTo = '0'
    w.knobs.rangeScans.length = 0
    await quiet(() => w.op.reconcileOwner(acc))
    expect(w.knobs.rangeScans).toHaveLength(20)
    expect(w.knobs.rangeScans[0]).toEqual({ from: 1n, to: 2_000n })
    expect(old.scannedTo).toBe('40000')
    await quiet(() => w.op.reconcileOwner(acc))
    expect(w.knobs.rangeScans).toHaveLength(40)
    expect(w.knobs.rangeScans[20]).toEqual({ from: 40_001n, to: 42_000n })
    expect(old).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
  })

  describe('one consistent, final view (reorgs)', () => {
    /** Ours spent nonce 0 at block 110; the head at 130 (20 blocks deep); the range search behind (empty). */
    const ranAt110 = async () => {
      const r = await revertedStart()
      spentAt(r.w, 110n)
      r.w.knobs.rangeLogsLag = true
      r.w.knobs.safeLogs = [execLog(r.old.safeTxHash!, 'relay', 110n)]
      return r
    }

    test('a reorg between the nonce read and the read of X (X by number is now another block) concludes nothing', async () => {
      const { w, acc, old } = await ranAt110()
      // Block 110 by number is a fork block unknown to the node's state.
      w.knobs.blockHashes.set(110n, keccak256(stringToHex('fork-110')))
      await quiet(() => w.op.reconcileOwner(acc))
      expect(old).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    })

    test('X whose own parent is past the nonce too (a fork) does not cross it: open', async () => {
      const { w, acc, old } = await ranAt110()
      const forkParent = keccak256(stringToHex('fork-109'))
      w.knobs.parents.set(110n, forkParent)
      w.knobs.forks.set(forkParent, 1n)
      await quiet(() => w.op.reconcileOwner(acc))
      expect(old).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
    })

    test('fewer than 12 confirmations: open; deep enough later: settled', async () => {
      const { w, acc, old } = await ranAt110()
      w.knobs.blockHead = 115n
      await quiet(() => w.op.reconcileOwner(acc))
      expect(old).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
      w.knobs.blockHead = 122n
      await quiet(() => w.op.reconcileOwner(acc))
      expect(old).toMatchObject({ state: 'confirmed', block: 110 })
    })

    test('a range-search hit in a block that is not canonical any more is not taken', async () => {
      const { w, acc, old } = await revertedStart()
      spentAt(w, 110n)
      // The log backend still serves a log from a block that was reorged out; the spending block cannot be read.
      w.knobs.safeLogs = [{ ...execLog(old.safeTxHash!, 'orphaned', 110n), blockHash: keccak256(stringToHex('orphan-110')) }]
      w.knobs.blockLogsDown = true
      await quiet(() => w.op.reconcileOwner(acc))
      expect(old).toMatchObject({ state: 'failed', code: 'OWNER_TX_ERROR' })
      expect(acc.active).toBe(false)
    })
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
