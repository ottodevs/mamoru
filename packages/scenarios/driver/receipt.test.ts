import { describe, expect, test } from 'bun:test'
import type { BundlerReceipt } from '@mamoru/erc4337'
import type { UserOpEventRead } from '@mamoru/rpc'
import { reconcileReceipt } from './receipt.ts'

const hash = `0x${'11'.repeat(32)}` as const
const sender = '0x00000000000000000000000000000000000000aa' as const
const ev: UserOpEventRead = {
  userOpHash: hash,
  sender,
  nonce: 5n,
  blockNumber: 100n,
  blockHash: `0x${'22'.repeat(32)}`,
  txHash: `0x${'33'.repeat(32)}`,
  logIndex: 9,
  success: true,
  actualGasCost: 1_000n,
  logs: [],
}
const receipt: BundlerReceipt = { userOpHash: hash, sender, nonce: 5n, success: true, actualGasCost: 1_000n, txHash: ev.txHash, blockNumber: 100n, blockHash: ev.blockHash }
const journal = { userOpHash: hash, sender, nonce: 5n }

describe('reconcileReceipt', () => {
  test('a receipt equal to the RPC event and the journal matches', () => {
    expect(reconcileReceipt(journal, ev, receipt)).toEqual({ status: 'match' })
  })

  test('no receipt is recorded as missing', () => {
    expect(reconcileReceipt(journal, ev, null)).toEqual({ status: 'missing' })
  })

  test('every conflicting field is named', () => {
    const lie: BundlerReceipt = { ...receipt, txHash: `0x${'44'.repeat(32)}`, actualGasCost: 999n, success: false, nonce: 6n }
    expect(reconcileReceipt(journal, ev, lie)).toEqual({ status: 'mismatch', fields: ['nonce', 'txHash', 'success', 'actualGasCost'] })
  })

  test('a receipt for another hash or sender conflicts with the journal', () => {
    const other: BundlerReceipt = { ...receipt, userOpHash: `0x${'55'.repeat(32)}`, sender: '0x00000000000000000000000000000000000000bb' }
    expect(reconcileReceipt(journal, ev, other)).toEqual({ status: 'mismatch', fields: ['userOpHash', 'sender'] })
  })
})
