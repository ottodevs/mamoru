import type { Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import type { BundlerReceipt } from '@mamoru/erc4337'
import type { UserOpEventRead } from '@mamoru/rpc'

/** What the journal signed and what the RPC's UserOperationEvent says, against the bundler's receipt. */
export type ReceiptCheck =
  | { status: 'match' }
  | { status: 'missing' }
  | { status: 'mismatch'; fields: string[] }

/**
 * FR-AA-004: the RPC is the confirmation authority. The bundler receipt is
 * compared with the journal (hash, sender, nonce) and with the RPC event
 * (transaction, block, success, gas cost); every disagreement is named.
 */
export function reconcileReceipt(journal: { userOpHash: Hex; sender: Address; nonce: bigint }, ev: UserOpEventRead, receipt: BundlerReceipt | null): ReceiptCheck {
  if (!receipt) return { status: 'missing' }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const checks: [string, boolean][] = [
    ['userOpHash', same(receipt.userOpHash, journal.userOpHash) && same(ev.userOpHash, journal.userOpHash)],
    ['sender', same(receipt.sender, journal.sender) && same(ev.sender, journal.sender)],
    ['nonce', receipt.nonce === journal.nonce && ev.nonce === journal.nonce],
    ['txHash', same(receipt.txHash, ev.txHash)],
    ['blockNumber', receipt.blockNumber === ev.blockNumber],
    ['blockHash', same(receipt.blockHash, ev.blockHash)],
    ['success', receipt.success === ev.success],
    ['actualGasCost', receipt.actualGasCost === ev.actualGasCost],
  ]
  const fields = checks.filter(([, ok]) => !ok).map(([f]) => f)
  return fields.length ? { status: 'mismatch', fields } : { status: 'match' }
}
