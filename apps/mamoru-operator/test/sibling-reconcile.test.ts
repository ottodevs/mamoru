// otto/mamoru#309 (b), review r1 of #227 and the security review of its fix: an unfinished sibling enable is never
// failed by the clock alone (a signed Safe tx with no deadline stays valid while its nonce is unspent), never left stuck
// (resent, bounded), and decided terminally only at Ethereum's finalized block.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from 'viem'
import { BridgeOut, SIBLING_RESENDS, UNCONFIRMED_GIVEUP_MS, type StoredSibling } from '../src/bridge-out.ts'

const SAFE = '0x0000000000000000000000000000000000000aaa' as const
const TX = `0x${'ab'.repeat(32)}` as Hex
const HASH = `0x${'11'.repeat(32)}` as Hex
const T0 = Date.parse('2026-11-02T20:00:00Z')
const SUCCESS = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e'
const FAILURE = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23'

type Chain = { enabled: boolean; nonceFinal: bigint; receipt: 'none' | 'success' | 'reverted' | 'error'; execLog: 'none' | 'success' | 'failure'; finalized: bigint; sendLands: boolean; pending?: boolean; sendThrowsAfterSign?: boolean }

function make(stored: Partial<StoredSibling>, chain: Chain, now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'mamoru-sib-'))
  const c: StoredSibling = { id: 'p', safe: SAFE, safeNonce: '0', safeTxHash: HASH, permissionId: `0x${'22'.repeat(32)}`, sessionKey: '0x0000000000000000000000000000000000000bbb', capUsdc: '1', fromBlock: '5', state: 'unconfirmed', sentAt: new Date(T0).toISOString(), execData: '0xdeadbeef', resends: 0, at: new Date(T0).toISOString(), ...stored }
  writeFileSync(join(dir, 'bridge-out.json'), JSON.stringify({ routes: {}, spent: { day: '', wei: '0' }, moves: {}, siblings: { k: c } }))
  const sent: Hex[] = []
  const l1 = {
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ number: chain.finalized, timestamp: 0n }),
    getGasPrice: async () => 1_000_000n,
    getBalance: async () => 10n ** 18n,
    estimateGas: async () => 1_000_000n,
    call: async () => ({ data: `0x${'1'.padStart(64, '0')}` }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'isPermissionEnabled') return chain.enabled
      if (functionName === 'nonce') return chain.nonceFinal
      throw new Error(functionName)
    },
    getCode: async () => '0x6080',
    getLogs: async () => (chain.execLog === 'none' ? [] : [{ topics: [chain.execLog === 'success' ? SUCCESS : FAILURE, HASH], data: '0x', transactionHash: TX }]),
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (chain.pending) return { hash }
      throw new TransactionNotFoundError({ hash })
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (chain.receipt === 'error') throw new Error('provider down')
      if (chain.receipt === 'none') throw new TransactionReceiptNotFoundError({ hash })
      return { status: chain.receipt, logs: [], transactionHash: hash, gasUsed: 1n, effectiveGasPrice: 1n }
    },
  }
  const relayer = {
    address: '0x0000000000000000000000000000000000000001' as const,
    send: async (tx: { data?: Hex }, onSent?: (h: Hex) => void, _onSending?: unknown, onSigned?: (h: Hex, n: number) => void) => {
      sent.push(tx.data!)
      onSigned?.(TX, 0)
      if (chain.sendThrowsAfterSign) throw new Error('provider accepted it, then the call timed out')
      onSent?.(TX)
      if (chain.sendLands) chain.enabled = true
      return { hash: TX, receipt: { status: chain.sendLands ? 'success' : 'reverted', logs: chain.sendLands ? [{ address: SAFE, topics: [SUCCESS, HASH], data: '0x' }] : [], gasUsed: 1n, effectiveGasPrice: 1n } as never }
    },
  }
  const bo = new BridgeOut(l1 as never, relayer, dir, fetch, now, undefined, () => true)
  return { bo, sent, journal: () => JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8')).siblings.k as StoredSibling }
}

const base: Chain = { enabled: false, nonceFinal: 0n, receipt: 'none', execLog: 'none', finalized: 50n, sendLands: false }

describe('sibling enable reconciliation', () => {
  test('the session enabled: done', async () => {
    const m = make({}, { ...base, enabled: true }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.journal().state).toBe('done')
  })

  test("the Safe's ExecutionFailure at the finalized block: failed", async () => {
    const m = make({ l1Tx: TX }, { ...base, execLog: 'failure' }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.journal().state).toBe('failed')
  })

  test('the signed nonce taken by another tx (at the finalized block): failed', async () => {
    const m = make({ l1Tx: TX }, { ...base, nonceFinal: 1n }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.journal().state).toBe('failed')
  })

  test('nothing finalized yet past the send: no terminal decision', async () => {
    const m = make({ l1Tx: TX, fromBlock: '60' }, { ...base, nonceFinal: 1n, execLog: 'failure' }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.journal().state).toBe('unconfirmed')
  })

  test('the clock alone never fails it: a dropped send is resent with the same signature, and lands', async () => {
    const m = make({ l1Tx: TX }, { ...base, sendLands: true }, () => T0 + UNCONFIRMED_GIVEUP_MS + 1)
    await m.bo.tick()
    expect(m.sent).toEqual(['0xdeadbeef'])
    expect(m.journal().state).toBe('done')
  })

  test('a reverted send is unconfirmed, not failed; resent at most SIBLING_RESENDS times, then alerted and kept blocking', async () => {
    let now = T0 + 60_000
    const m = make({ l1Tx: TX }, { ...base, receipt: 'reverted' }, () => now)
    for (let i = 0; i < SIBLING_RESENDS + 2; i++) {
      await m.bo.tick()
      now += UNCONFIRMED_GIVEUP_MS + 1
    }
    expect(m.sent.length).toBe(SIBLING_RESENDS)
    expect(m.journal().state).toBe('unconfirmed')
  })

  test('a provider error decides nothing', async () => {
    const m = make({ l1Tx: TX }, { ...base, receipt: 'error' }, () => T0 + UNCONFIRMED_GIVEUP_MS + 1)
    await m.bo.tick()
    expect(m.sent).toEqual([])
    expect(m.journal().state).toBe('unconfirmed')
  })

  test('a failed row whose tx landed late becomes done', async () => {
    const m = make({ l1Tx: TX, state: 'failed' }, { ...base, enabled: true }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.journal().state).toBe('done')
  })
})

describe('sibling resend guards (security review of #227)', () => {
  test('a resend refused before the send (simulation) consumes no resend and is tried again later', async () => {
    let now = T0 + UNCONFIRMED_GIVEUP_MS + 1
    const m = make({ l1Tx: TX }, { ...base, sendLands: true }, () => now)
    ;(m.bo as unknown as { l1: { call: () => Promise<unknown> } }).l1.call = async () => { throw new Error('refused') }
    await m.bo.tick()
    expect(m.sent).toEqual([])
    expect(m.journal().resends ?? 0).toBe(0)
    ;(m.bo as unknown as { l1: { call: () => Promise<unknown> } }).l1.call = async () => ({ data: `0x${'1'.padStart(64, '0')}` })
    now += 60_000
    await m.bo.tick()
    expect(m.sent.length).toBe(1)
    expect(m.journal().state).toBe('done')
  })

  test('a resend above the gas ceiling is never sent', async () => {
    const m = make({ l1Tx: TX }, base, () => T0 + UNCONFIRMED_GIVEUP_MS + 1)
    ;(m.bo as unknown as { l1: { estimateGas: () => Promise<bigint> } }).l1.estimateGas = async () => 5_000_000n
    await m.bo.tick()
    expect(m.sent).toEqual([])
  })

  test('a reverted send is not resent before the interval', async () => {
    const m = make({ l1Tx: TX }, { ...base, receipt: 'reverted' }, () => T0 + 60_000)
    await m.bo.tick()
    expect(m.sent).toEqual([])
    expect(m.journal().state).toBe('unconfirmed')
  })
})

describe('sibling review r2 of #227', () => {
  test('never signed for broadcast (crash after the deploy): failed after the give-up, never resent', async () => {
    let now = T0 + 60_000
    const m = make({ state: 'sending', deployTx: TX, l1Tx: undefined }, base, () => now)
    await m.bo.tick()
    expect(m.journal().state).toBe('sending')
    now = T0 + UNCONFIRMED_GIVEUP_MS + 1
    await m.bo.tick()
    expect(m.journal().state).toBe('failed')
    expect(m.sent).toEqual([])
  })

  test('a tx still pending in the mempool is not resent beside itself', async () => {
    const m = make({ l1Tx: TX }, { ...base, pending: true }, () => T0 + UNCONFIRMED_GIVEUP_MS + 1)
    await m.bo.tick()
    expect(m.sent).toEqual([])
    expect(m.journal().state).toBe('unconfirmed')
  })

  test('a provider that accepts the resend and then fails the call: counted once the hash is signed, stays unconfirmed', async () => {
    const m = make({ l1Tx: TX }, { ...base, sendThrowsAfterSign: true }, () => T0 + UNCONFIRMED_GIVEUP_MS + 1)
    await m.bo.tick()
    expect(m.sent.length).toBe(1)
    expect(m.journal().resends).toBe(1)
    expect(m.journal().state).toBe('unconfirmed')
  })
})
