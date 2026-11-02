// otto/mamoru#309 (b), review r1 of #227: an unfinished sibling enable is never left stuck in the journal.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TransactionReceiptNotFoundError, type Hex } from 'viem'
import { BridgeOut, UNCONFIRMED_GIVEUP_MS, type StoredSibling } from '../src/bridge-out.ts'

const SAFE = '0x0000000000000000000000000000000000000aaa' as const
const TX = `0x${'ab'.repeat(32)}` as Hex
const T0 = Date.parse('2026-11-02T20:00:00Z')

type Chain = { enabled: boolean; nonce: bigint; receipt: 'none' | 'success' | 'reverted'; execLog: 'none' | 'success' | 'failure' }

function make(stored: Partial<StoredSibling>, chain: Chain, now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'mamoru-sib-'))
  const c: StoredSibling = { id: 'p', safe: SAFE, safeNonce: '0', safeTxHash: `0x${'11'.repeat(32)}`, permissionId: `0x${'22'.repeat(32)}`, sessionKey: '0x0000000000000000000000000000000000000bbb', capUsdc: '1', fromBlock: '1', state: 'unconfirmed', sentAt: new Date(T0).toISOString(), at: new Date(T0).toISOString(), ...stored }
  writeFileSync(join(dir, 'bridge-out.json'), JSON.stringify({ routes: {}, spent: { day: '', wei: '0' }, moves: {}, siblings: { k: c } }))
  const SUCCESS = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e'
  const FAILURE = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23'
  const l1 = {
    getBlockNumber: async () => 10n,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'isPermissionEnabled') return chain.enabled
      if (functionName === 'nonce') return chain.nonce
      throw new Error(functionName)
    },
    getCode: async () => '0x6080',
    getLogs: async () => (chain.execLog === 'none' ? [] : [{ topics: [chain.execLog === 'success' ? SUCCESS : FAILURE, c.safeTxHash], data: '0x', transactionHash: TX }]),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (chain.receipt === 'none') throw new TransactionReceiptNotFoundError({ hash })
      return { status: chain.receipt, logs: [], transactionHash: hash }
    },
  }
  const relayer = { address: '0x0000000000000000000000000000000000000001' as const, send: async () => Promise.reject(new Error('unused')) }
  const bo = new BridgeOut(l1 as never, relayer, dir, fetch, now, undefined, () => true)
  return { bo, journal: () => JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8')).siblings.k as StoredSibling }
}

describe('sibling enable reconciliation', () => {
  const base: Chain = { enabled: false, nonce: 0n, receipt: 'none', execLog: 'none' }

  test('the session enabled: done', async () => {
    const m = make({}, { ...base, enabled: true }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.journal().state).toBe('done')
  })

  test('a reverted sent tx: failed (the account can prepare again)', async () => {
    const m = make({ l1Tx: TX }, { ...base, receipt: 'reverted' }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.journal().state).toBe('failed')
  })

  test("the Safe's ExecutionFailure: failed", async () => {
    const m = make({ l1Tx: TX }, { ...base, execLog: 'failure' }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.journal().state).toBe('failed')
  })

  test('the signed nonce spent by something else: failed', async () => {
    const m = make({ l1Tx: TX }, { ...base, nonce: 1n }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.journal().state).toBe('failed')
  })

  test('dropped (no receipt, nonce unspent): waits, then fails once the give-up time passed; the clock is never reset', async () => {
    let now = T0 + 60_000
    const m = make({ l1Tx: TX }, base, () => now)
    for (let i = 0; i < 5; i++) {
      await m.bo.tick()
      now += 60_000
    }
    expect(m.journal().state).toBe('unconfirmed')
    expect(m.journal().sentAt).toBe(new Date(T0).toISOString())
    now = T0 + UNCONFIRMED_GIVEUP_MS + 1
    await m.bo.tick()
    expect(m.journal().state).toBe('failed')
  })

  test('never sent (restart between deploy and exec): fails after the give-up time', async () => {
    let now = T0 + 60_000
    const m = make({ state: 'sending', deployTx: TX }, base, () => now)
    await m.bo.tick()
    expect(m.journal().state).toBe('sending')
    now = T0 + UNCONFIRMED_GIVEUP_MS + 1
    await m.bo.tick()
    expect(m.journal().state).toBe('failed')
  })
})
