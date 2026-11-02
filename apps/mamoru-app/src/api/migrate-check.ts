import { ReasonError, type AccountContext, type Hex0x, type OwnerTxToSign } from '@mamoru/domain'
import { safeTxTypedData } from '@mamoru/account/safe'
import { hashTypedData, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem'
import { accountContext } from './accounts/operator.ts'
import type { AccountRow } from './accounts/store.ts'
import { defaultRemoteRegistry, verifyRemote, type RemoteRegistry } from './remote.ts'

/**
 * otto/mamoru#295: before the owner is asked to sign a migrate-v4 step, the Worker holds the operator's prepare to what the
 * card will show. Nothing here trusts a string the operator sends:
 *  1. the Safe transaction fields are present and hash (EIP-712) to the `safeTxHash` the passkey signs;
 *  2. `safe` is the owner's own Safe, from the Worker's D1 rows, on the chain of the step (Base, then Monad);
 *  3. a `moveTo` is the remote Safe the owner's own keys give (`verifyRemote`), never the operator's say-so;
 *  4. the calldata, read call by call (a MultiSend is unpacked), sends value or tokens only to `moveTo`, and does send to it.
 * Any failure throws `ReasonError('MIGRATE_TX_MISMATCH')`; the route answers 502 and the card shows it.
 */
export const MIGRATE_CHAINS = [8453, 143] as const

const fail = (why: string): never => {
  throw new ReasonError('MIGRATE_TX_MISMATCH', why)
}

const MULTISEND = '0x8d80ff0a'
const TRANSFER = '0xa9059cbb'
const TRANSFER_FROM = '0x23b872dd'

type Call = { to: Address; value: bigint; data: Hex }

const word = (hex: string, i: number) => hex.slice(2 + i * 64, 2 + (i + 1) * 64)
const addrOfWord = (w: string) => `0x${w.slice(24)}` as Address

/** MultiSend(CallOnly) packed transactions: operation(1) to(20) value(32) len(32) data. */
function unpackMultiSend(data: Hex): Call[] {
  if (!data.toLowerCase().startsWith(MULTISEND)) fail('a delegate call that is not a MultiSend')
  const body = `0x${data.slice(10)}`
  const len = Number(BigInt(`0x${word(body, 1)}`))
  const packed = body.slice(2 + 64 * 2, 2 + 64 * 2 + len * 2)
  const calls: Call[] = []
  let i = 0
  while (i < packed.length) {
    const operation = Number.parseInt(packed.slice(i, i + 2), 16)
    const to = `0x${packed.slice(i + 2, i + 42)}` as Address
    const value = BigInt(`0x${packed.slice(i + 42, i + 106)}`)
    const n = Number(BigInt(`0x${packed.slice(i + 106, i + 170)}`)) * 2
    const inner = `0x${packed.slice(i + 170, i + 170 + n)}` as Hex
    if (operation !== 0) fail('a nested delegate call')
    calls.push({ to, value, data: inner })
    i += 170 + n
  }
  return calls
}

/** Where a call sends value or tokens, or null when it sends none (a removeSession, an enable). */
function recipients(call: Call): Address[] {
  const out: Address[] = []
  if (call.value > 0n) out.push(call.to)
  const sel = call.data.slice(0, 10).toLowerCase()
  if (sel === TRANSFER) out.push(addrOfWord(word(`0x${call.data.slice(10)}`, 0)))
  if (sel === TRANSFER_FROM) out.push(addrOfWord(word(`0x${call.data.slice(10)}`, 1)))
  return out
}

export function checkMigrateTx(args: { tx: OwnerTxToSign; step: number; rows: AccountRow[]; registryOf?: RemoteRegistry }): void {
  const { tx, step, rows, registryOf = defaultRemoteRegistry } = args
  const chainId = MIGRATE_CHAINS[step]
  if (chainId === undefined) return fail(`step ${step} does not exist`)
  const f = tx.safeTx
  if (!f || !tx.safe || typeof tx.safeTxHash !== 'string') return fail('the prepare carries no Safe transaction')
  if (tx.chainId !== chainId) return fail(`step ${step} is on chain ${chainId}, not ${tx.chainId}`)

  // 2. the owner's own Safe on that chain, from D1.
  const own = rows.find((r) => r.chain_id === chainId)
  if (!own || !isAddressEqual(own.address, tx.safe as Address)) return fail('not the owner\'s own Safe on this chain')

  // 1. the hash the passkey signs is the hash of these fields.
  if (!isAddressEqual(f.gasToken as Address, zeroAddress)) return fail('a gas token')
  const typed = safeTxTypedData(tx.safe as Address, chainId, {
    to: f.to as Address,
    value: BigInt(f.value),
    data: f.data as Hex,
    operation: f.operation,
    nonce: BigInt(f.nonce),
    refund: { safeTxGas: BigInt(f.safeTxGas), baseGas: BigInt(f.baseGas), gasPrice: BigInt(f.gasPrice), refundReceiver: f.refundReceiver as Address },
  })
  if (hashTypedData(typed).toLowerCase() !== tx.safeTxHash.toLowerCase()) return fail('the hash does not match the transaction')

  // 3. the destination is derived from the owner's keys, not taken from the operator.
  const base = rows.find((r) => r.chain_id === 8453)
  if (tx.moveTo !== undefined) {
    if (!base || !tx.remote) return fail('a destination with no remote Safe to derive it from')
    const ctx: AccountContext = accountContext(base)
    try {
      verifyRemote(ctx, { chainId: tx.remote.chainId, address: tx.moveTo as Hex0x, spec: tx.remote.spec }, registryOf)
    } catch {
      return fail('the destination is not the owner\'s remote Safe')
    }
    if (tx.remote.chainId !== chainId) return fail('the destination is on another chain')
  }

  // 4. what the calldata sends, and to whom.
  const calls: Call[] = f.operation === 1 ? unpackMultiSend(f.data) : [{ to: f.to as Address, value: BigInt(f.value), data: f.data as Hex }]
  const sent = calls.flatMap(recipients)
  if (tx.moveTo === undefined) {
    if (sent.length) return fail('it sends funds, but none were announced')
  } else {
    if (!sent.length) return fail('it does not send funds to the announced destination')
    if (sent.some((a) => !isAddressEqual(a, tx.moveTo as Address))) return fail('it sends funds somewhere else')
  }
}
