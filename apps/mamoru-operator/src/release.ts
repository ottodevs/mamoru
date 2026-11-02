// otto/mamoru#278 (spec 002 FR-XCH-014 a/c): the return home of a V4 remote Safe, on the operator that runs it.
//
// One rule: the home account's operator asks for an amount (`POST release`), this Safe frees it and bridges it home in
// one burn (decide's `releaseOf`), and the home operator mints it there. One request, one burn, settled by the chain:
//   open       asked; the engine frees and bridges, nothing else
//   sending    a burn userOp is on disk before it is signed (`beforeSign`). Every try of it uses the same EntryPoint
//              nonce, so at most one can ever land. Its UserOperationEvent makes it burned (or open again on a revert);
//              that nonce used at `safe` without any of its tries makes it open again. Until then it is what the engine
//              does: a try that was never sent is replaced by another at the same nonce, never by a second burn.
//   burned     landed (tx, block, amount): the home operator mints it; a new request may follow
//   cancelled  the home withdrew it while it was still open (nothing was signed)
// The same id asked again is the same request, in any state. Nothing here moves funds: the engine signs the burn under
// the Safe's one V4 session, and V4 mints only to the Safe's home on its home domain.

import { getAddress, isAddressEqual, parseAbiItem, type Hex, type Log, type PublicClient } from 'viem'
import type { Address, ChainId } from '@mamoru/domain'
import { V4_CHAIN_BY_DOMAIN } from '@mamoru/policy'
import { address, entryPointV07Abi, type Registry } from '@mamoru/registry'
import { userOpLogs } from '@mamoru/rpc'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import { burnOf } from './bridge-monad.ts'
import type { AccountState } from './state.ts'

type Try = { userOpHash: Hex; amount: string; depositor: Address }

export type ReleaseState = {
  /** The home operator's id for the request: the same id asked again is the same request. */
  id: string
  /** Raw savings units asked for. */
  amount: string
  /** The home chain (V4_CHAIN_BY_DOMAIN of the Safe's home domain). */
  chainId: number
  state: 'open' | 'sending' | 'burned' | 'cancelled'
  /** While sending: the nonce every try uses, the block they were prepared from, and each try signed or about to be. */
  sending?: { nonceKey: string; nonce: string; fromBlock: string; tries: Try[] }
  /** Once burned: what landed. */
  burn?: { userOpHash: Hex; amount: string; txHash: Hex; block: number }
  at: string
  updatedAt: string
}

export type ReleaseView = { state: 'none' } | { id: string; amount: string; chainId: number; state: ReleaseState['state']; burn?: { amount: string; txHash: Hex; block: number } }

export class ReleaseRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const MAX_AMOUNT = 1n << 128n
const ID = /^[A-Za-z0-9-]{1,64}$/
/** Finished requests kept for `status` by id (the home reads a burn before it asks again). */
export const RELEASES_KEPT = 10
/** Blocks one settle getLogs covers at most (the RPC proxy splits it further per provider). */
const SETTLE_LOG_CHUNK = 2_000n
const userOperationEvent = parseAbiItem('event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)')

/** The Safe's home, from the spec it was provisioned with; null when it is not a V4 remote. */
export function homeOf(acc: Pick<AccountState, 'ctx'>): { home: Address; chainId: number; homeDomain: number } | null {
  const spec = acc.ctx.remote
  if (!spec?.home || spec.homeDomain === undefined) return null
  const chainId = V4_CHAIN_BY_DOMAIN[spec.homeDomain]
  return chainId === undefined ? null : { home: getAddress(spec.home), chainId, homeDomain: spec.homeDomain }
}

function parse(body: unknown): { id: string; amount?: string } {
  const b = body as { id?: unknown; amount?: unknown } | null
  if (typeof b?.id !== 'string' || !ID.test(b.id)) throw new ReleaseRefused(400, 'BAD_REQUEST', 'id: 1-64 letters, digits or dashes')
  if (b.amount === undefined) return { id: b.id }
  if (typeof b.amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(b.amount) || BigInt(b.amount) >= MAX_AMOUNT) throw new ReleaseRefused(400, 'BAD_REQUEST', 'amount: a positive integer string of raw savings units')
  return { id: b.id, amount: b.amount }
}

function find(acc: AccountState, id: string): ReleaseState | undefined {
  return acc.release?.id === id ? acc.release : acc.releasesDone?.find((r) => r.id === id)
}

/**
 * A new request, or the same one asked again (any state: never a second burn for one id). Refused: not a V4 remote, a
 * bad body, the id with another amount, another request still open or sending.
 */
export function requestRelease(acc: AccountState, body: unknown, now: string): ReleaseView {
  const h = homeOf(acc)
  if (!h) throw new ReleaseRefused(400, 'NOT_A_REMOTE', 'this Safe has no home to send to')
  const b = parse(body)
  if (!b.amount) throw new ReleaseRefused(400, 'BAD_REQUEST', 'amount: a positive integer string of raw savings units')
  const same = find(acc, b.id)
  if (same) {
    if (same.amount !== b.amount) throw new ReleaseRefused(409, 'RELEASE_ID_REUSED', `release ${b.id} was asked for ${same.amount}`)
    return viewOf(same)
  }
  const r = acc.release
  if (r && (r.state === 'open' || r.state === 'sending')) throw new ReleaseRefused(409, 'RELEASE_OPEN', `release ${r.id} is still ${r.state}`)
  if (r) acc.releasesDone = [r, ...(acc.releasesDone ?? [])].slice(0, RELEASES_KEPT)
  acc.release = { id: b.id, amount: b.amount, chainId: h.chainId, state: 'open', at: now, updatedAt: now }
  return viewOf(acc.release)
}

/** The home withdraws a request nothing was signed for yet (open). Cancelled or unknown: as it is. Sending/burned: refused. */
export function cancelRelease(acc: AccountState, body: unknown, now: string): ReleaseView {
  const { id } = parse(body)
  const r = find(acc, id)
  if (!r) return { state: 'none' }
  if (r.state === 'open') Object.assign(r, { state: 'cancelled', updatedAt: now })
  else if (r.state !== 'cancelled') throw new ReleaseRefused(409, 'RELEASE_NOT_OPEN', `release ${id} is ${r.state}`)
  return viewOf(r)
}

/** Where a request is: by id, or the latest. */
export function releaseView(acc: AccountState, id?: string): ReleaseView {
  const r = id ? find(acc, id) : acc.release
  return r ? viewOf(r) : { state: 'none' }
}

/** What the engine's review reads (`Observation.release`): the amount while the request is open or sending. */
export function releaseObs(acc: AccountState): { amount: bigint; chainId: ChainId } | undefined {
  const r = acc.release
  return r && (r.state === 'open' || r.state === 'sending') ? { amount: BigInt(r.amount), chainId: r.chainId as ChainId } : undefined
}

/**
 * The engine's `beforeBridgeSign` on a V4 remote: the try goes on disk before its userOp is signed (the caller saves;
 * a save that throws refuses the signature). An open request takes its first try; a sending one takes another try only
 * at the same nonce (only one of them can land). Refused: no request, a burn that is not the request's (chain, domain,
 * recipient, more than asked), another nonce while one is still unsettled.
 */
export function beforeSign(acc: AccountState, b: BridgeSigning, now: string): void {
  const r = acc.release
  const h = homeOf(acc)
  if (!r || !h || (r.state !== 'open' && r.state !== 'sending')) throw new Error('bridge from a remote Safe without an open release')
  if (b.chainId !== r.chainId || b.destinationDomain !== h.homeDomain || !isAddressEqual(b.recipient, h.home)) throw new Error(`release burn to chain ${b.chainId} / ${b.recipient}: not this Safe's home`)
  if (b.amount <= 0n || b.amount > BigInt(r.amount)) throw new Error(`release burn of ${b.amount}: more than the ${r.amount} asked`)
  const t: Try = { userOpHash: b.userOpHash.toLowerCase() as Hex, amount: b.amount.toString(), depositor: getAddress(b.depositor) }
  if (r.state === 'open') {
    r.sending = { nonceKey: b.nonceKey.toString(), nonce: b.nonce.toString(), fromBlock: b.prepareBlock.toString(), tries: [t] }
    r.state = 'sending'
  } else {
    const s = r.sending!
    if (s.nonceKey !== b.nonceKey.toString() || s.nonce !== b.nonce.toString()) throw new Error(`release ${r.id}: a burn at nonce ${s.nonce} is not settled yet`)
    if (!s.tries.some((x) => x.userOpHash === t.userOpHash)) s.tries.push(t)
  }
  r.updatedAt = now
}

/** The engine's `bridgeUnsigned`: that try was never signed; with no try left the request is open again. */
export function unsigned(acc: AccountState, hash: Hex, now: string): boolean {
  const r = acc.release
  if (r?.state !== 'sending' || !r.sending) return false
  const tries = r.sending.tries.filter((t) => t.userOpHash !== hash.toLowerCase())
  if (tries.length === r.sending.tries.length) return false
  if (tries.length) r.sending.tries = tries
  else reopen(r)
  r.updatedAt = now
  return true
}

function reopen(r: ReleaseState): void {
  r.state = 'open'
  delete r.sending
}

/** The chain reads `settle` needs (the operator's client of this chain). */
export type SettleChain = Pick<PublicClient, 'getBlock' | 'readContract' | 'getLogs' | 'getTransactionReceipt'>

/**
 * A sending request, settled by the chain at `safe`: nothing while its nonce is unused there; once used, the
 * UserOperationEvent of one of its tries makes it burned (exactly that burn: DepositForBurn of the try's amount from its
 * depositor to the home, on the home domain) or open again (reverted); none of them up to `safe` makes it open again
 * (another op took the nonce). Returns whether the state changed. A landed op that is not exactly its burn throws:
 * it stays sending, never under-counted, until someone looks.
 */
export async function settle(acc: AccountState, chain: SettleChain, registry: Registry, now: string): Promise<boolean> {
  const r = acc.release
  const h = homeOf(acc)
  if (r?.state !== 'sending' || !r.sending || !h) return false
  const s = r.sending
  const ep = address('EntryPointV07', registry)
  const safe = await chain.getBlock({ blockTag: 'safe' })
  const sender = acc.ctx.address as Address
  const used = (await chain.readContract({ address: ep, abi: entryPointV07Abi, functionName: 'getNonce', args: [sender, BigInt(s.nonceKey)], blockNumber: safe.number })) as bigint
  if (used <= BigInt(s.nonce)) return false
  for (let from = BigInt(s.fromBlock); from <= safe.number; from += SETTLE_LOG_CHUNK) {
    const to = from + SETTLE_LOG_CHUNK - 1n < safe.number ? from + SETTLE_LOG_CHUNK - 1n : safe.number
    for (const t of s.tries) {
      const logs = (await chain.getLogs({ address: ep, event: userOperationEvent, args: { userOpHash: t.userOpHash }, fromBlock: from, toBlock: to })) as unknown as (Log & { args: { sender?: Address; nonce?: bigint; success?: boolean } })[]
      if (!logs.length) continue
      const ev = logs[0]!
      if (!ev.args.sender || !isAddressEqual(ev.args.sender, sender) || ev.args.nonce !== BigInt(s.nonce)) throw new Error(`release ${r.id}: UserOperationEvent of ${ev.args.sender} nonce ${ev.args.nonce} for its try`)
      if (!ev.args.success) {
        reopen(r)
        r.updatedAt = now
        return true
      }
      const receipt = await chain.getTransactionReceipt({ hash: ev.transactionHash! })
      const burn = burnOf(userOpLogs(receipt.logs, ev.logIndex!, registry), { account: sender, depositor: t.depositor, recipient: h.home, amount: t.amount, destinationDomain: h.homeDomain }, registry)
      if (!burn) throw new Error(`release ${r.id}: its userOp landed in ${ev.transactionHash} without exactly its burn; kept sending`)
      Object.assign(r, { state: 'burned', burn: { userOpHash: t.userOpHash, amount: t.amount, txHash: ev.transactionHash!, block: Number(ev.blockNumber!) }, updatedAt: now })
      delete r.sending
      return true
    }
  }
  // The nonce is used at `safe` and none of the tries is there: another op took it, none of them can ever land.
  reopen(r)
  r.updatedAt = now
  return true
}

/**
 * Whether the nonce of a sending request is already used at the head: one of its tries landed, or another op took it.
 * Until the burn is settled at `safe`, the engine is not told of the request (it would free value again for a burn
 * already sent); nothing is signed for it meanwhile.
 */
export async function nonceUsedAtHead(acc: AccountState, chain: Pick<PublicClient, 'readContract'>, registry: Registry): Promise<boolean> {
  const s = acc.release?.state === 'sending' ? acc.release.sending : undefined
  if (!s) return false
  const used = (await chain.readContract({ address: address('EntryPointV07', registry), abi: entryPointV07Abi, functionName: 'getNonce', args: [acc.ctx.address as Address, BigInt(s.nonceKey)] })) as bigint
  return used > BigInt(s.nonce)
}

function viewOf(r: ReleaseState): ReleaseView {
  return { id: r.id, amount: r.amount, chainId: r.chainId, state: r.state, ...(r.burn ? { burn: { amount: r.burn.amount, txHash: r.burn.txHash, block: r.burn.block } } : {}) }
}
