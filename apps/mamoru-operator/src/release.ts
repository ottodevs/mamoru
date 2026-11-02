// otto/mamoru#278 (spec 002 FR-XCH-014 a/c): the return home of a V4 remote Safe, on the operator that runs it.
//
// One rule: the home account's operator asks for an amount (`POST release`), this Safe frees it and bridges it home in
// one burn (decide's `releaseOf`), and the home operator mints it there. One request, one burn:
//   open     asked; the engine frees and bridges, nothing else
//   sending  the burn is on disk before its userOp is signed (`beforeSign`); its op row settles it
//   burned   the burn landed here (tx and block known): the home operator mints it; a new request may follow
// A burn that failed or was never signed goes back to open, so the engine tries again. Nothing here moves funds: the
// engine signs the burn under the Safe's one V4 session, and V4 mints only to the Safe's home on its home domain.

import { getAddress, isAddressEqual, type Hex } from 'viem'
import type { Address, ChainId } from '@mamoru/domain'
import { V4_CHAIN_BY_DOMAIN } from '@mamoru/policy'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import type { AccountState } from './state.ts'

export type ReleaseState = {
  /** The home operator's id for the request: the same id asked again is the same request. */
  id: string
  /** Raw savings units asked for. */
  amount: string
  /** The home chain (V4_CHAIN_BY_DOMAIN of the Safe's home domain). */
  chainId: number
  state: 'open' | 'sending' | 'burned'
  burn?: { userOpHash: Hex; amount: string; txHash?: Hex; block?: number }
  at: string
  updatedAt: string
}

export type ReleaseView = { state: 'none' } | { id: string; amount: string; chainId: number; state: ReleaseState['state']; burn?: { amount: string; txHash?: Hex; block?: number } }

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

/** The Safe's home, from the spec it was provisioned with; null when it is not a V4 remote. */
export function homeOf(acc: Pick<AccountState, 'ctx'>): { home: Address; chainId: number } | null {
  const spec = acc.ctx.remote
  if (!spec?.home || spec.homeDomain === undefined) return null
  const chainId = V4_CHAIN_BY_DOMAIN[spec.homeDomain]
  return chainId === undefined ? null : { home: getAddress(spec.home), chainId }
}

/** A new request, or the same one asked again. Refused: not a V4 remote, a bad body, another request still open. */
export function requestRelease(acc: AccountState, body: unknown, now: string): ReleaseView {
  const h = homeOf(acc)
  if (!h) throw new ReleaseRefused(400, 'NOT_A_REMOTE', 'this Safe has no home to send to')
  const b = body as { id?: unknown; amount?: unknown } | null
  if (typeof b?.id !== 'string' || !ID.test(b.id)) throw new ReleaseRefused(400, 'BAD_REQUEST', 'id: 1-64 letters, digits or dashes')
  if (typeof b.amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(b.amount) || BigInt(b.amount) >= MAX_AMOUNT) throw new ReleaseRefused(400, 'BAD_REQUEST', 'amount: a positive integer string of raw savings units')
  reconcile(acc, now)
  const r = acc.release
  if (r && r.state !== 'burned') {
    if (r.id === b.id && r.amount === b.amount) return viewOf(r)
    throw new ReleaseRefused(409, 'RELEASE_OPEN', `release ${r.id} is still ${r.state}`)
  }
  acc.release = { id: b.id, amount: b.amount, chainId: h.chainId, state: 'open', at: now, updatedAt: now }
  return viewOf(acc.release)
}

export function releaseView(acc: AccountState, now: string): ReleaseView {
  reconcile(acc, now)
  return acc.release ? viewOf(acc.release) : { state: 'none' }
}

/** What the engine's review reads (`Observation.release`): the amount while the request is not burned yet. */
export function releaseObs(acc: AccountState, now: string): { amount: bigint; chainId: ChainId } | undefined {
  reconcile(acc, now)
  const r = acc.release
  return r && r.state !== 'burned' ? { amount: BigInt(r.amount), chainId: r.chainId as ChainId } : undefined
}

/**
 * The engine's `beforeBridgeSign` on a V4 remote: the burn goes on disk as `sending` before its userOp is signed (the
 * caller saves the state; a save that throws refuses the signature). Refused: no open request, another burn already
 * out, a burn that is not the request's (chain, recipient, more than asked).
 */
export function beforeSign(acc: AccountState, b: BridgeSigning, now: string): void {
  const r = acc.release
  const h = homeOf(acc)
  if (!r || !h) throw new Error('bridge from a remote Safe without an open release')
  const hash = b.userOpHash.toLowerCase() as Hex
  if (r.state === 'sending' && r.burn?.userOpHash === hash && BigInt(r.burn.amount) === b.amount) return
  if (r.state !== 'open') throw new Error(`release ${r.id} is ${r.state}: one burn per request`)
  if (b.chainId !== r.chainId || !isAddressEqual(b.recipient, h.home)) throw new Error(`release burn to chain ${b.chainId} / ${b.recipient}: not this Safe's home`)
  if (b.amount <= 0n || b.amount > BigInt(r.amount)) throw new Error(`release burn of ${b.amount}: more than the ${r.amount} asked`)
  Object.assign(r, { state: 'sending', burn: { userOpHash: hash, amount: b.amount.toString() }, updatedAt: now })
}

/** The engine's `bridgeUnsigned`: that burn was never signed, the request is open again. */
export function unsigned(acc: AccountState, hash: Hex, now: string): boolean {
  const r = acc.release
  if (r?.state !== 'sending' || r.burn?.userOpHash !== hash.toLowerCase()) return false
  reopen(r, now)
  return true
}

function reopen(r: ReleaseState, now: string): void {
  r.state = 'open'
  delete r.burn
  r.updatedAt = now
}

/** A `sending` burn settles from its engine op row: confirmed is burned (tx and block), failed is open again. */
function reconcile(acc: AccountState, now: string): void {
  const r = acc.release
  if (r?.state !== 'sending' || !r.burn) return
  const row = acc.ops.find((o) => o.userOpHash?.toLowerCase() === r.burn!.userOpHash)
  if (row?.state === 'confirmed' && row.txHash && row.block !== undefined) {
    Object.assign(r, { state: 'burned', burn: { ...r.burn, txHash: row.txHash as Hex, block: row.block }, updatedAt: now })
  } else if (row?.state === 'failed') {
    reopen(r, now)
  }
}

function viewOf(r: ReleaseState): ReleaseView {
  return { id: r.id, amount: r.amount, chainId: r.chainId, state: r.state, ...(r.burn ? { burn: { amount: r.burn.amount, ...(r.burn.txHash ? { txHash: r.burn.txHash } : {}), ...(r.burn.block !== undefined ? { block: r.burn.block } : {}) } } : {}) }
}
