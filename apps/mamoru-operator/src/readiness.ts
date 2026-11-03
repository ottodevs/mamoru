// otto/mamoru#348 (spec 010 A1): readiness across chains, proven by CCTP, never by a key the operator holds.
//
// A V4 account's funds cross to another chain only to a Safe that chain's V4 holds ready (`isReady`). Readiness is a CCTP
// V2 message from the same V4 on the chain where the Safe lives (`announceReady`), attested by Circle and delivered on the
// other chain (`MessageTransmitterV2.receiveMessage`, the `relayMessage` intent), where V4's handler writes it. Two
// directions run this today:
//  - Base home -> its Ethereum sibling (#307): announceReady on Base (the home's own session, toDomain 0), relayed on
//    Ethereum by the sibling's session; the sibling bridges home only once Ethereum's V4 holds the home ready.
//  - Monad remote -> its Base home: announceReady on Monad (the remote's session, toDomain 6), relayed on Base by the
//    home's session; the home's engine bridges to Monad only once Base's V4 holds the remote ready.
// Every step is an op of the user's own session (the account pays its gas under its gas rate) or a read; anyone could
// send either call, so the operator holds no power here: it only saves the user the trouble.
//
// This module is the state machine, chain-agnostic: each step reads the chain first (`isReady`: already ready, nothing is
// sent), then moves one state at most, persisting what it learned so a restart resumes where it was. The ports are the
// chain- and process-specific parts (operator.ts for Monad -> Base, bridge-out.ts for Base -> Ethereum).
import { decodeAbiParameters, getAddress, hexToBigInt, pad, parseAbiItem, sliceHex, type Hex, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'

/** One userOp the flow sent: its hash, the block it was signed at (logs are searched from there) and its claimed time T. */
export type SentOp = { userOpHash: Hex; fromBlock: string; t: string }

/** Where an op stands on its chain: ran (with its outcome), not yet known, or gone (its A1 window passed and it never ran). */
export type OpOutcome = { txHash: Hex; success: boolean } | 'pending' | 'gone'

export type ReadyState = 'announce' | 'announced' | 'attesting' | 'relay' | 'relayed'

/**
 * The persisted flow of one (account, direction). Absent: nothing under way (ready, or never started).
 * - `announce`: send announceReady (or ask the peer that runs the announcing Safe); `again` is the source transaction a
 *   previous round produced that turned out unusable (the peer announces again only for that one: no double announce);
 * - `announced`: our announceReady op is out; its transaction is read from the chain;
 * - `attesting`: the announce ran in `srcTx`; Circle's attestation is polled (iris), and checked before it is used;
 * - `relay`: an accepted message and attestation, to deliver on the destination chain;
 * - `relayed`: the relay op is out; its outcome is read, then readiness again.
 */
export type ReadyFlow = {
  state: ReadyState
  /** When the flow entered `state` (ISO). */
  since: string
  /** Consecutive failures of the current step: they space the retries (backoff) and end a relay's tries. */
  fails: number
  /** Not before (ISO): the backoff after a failure. */
  nextAt?: string
  /** Announce rounds on `day` (UTC): each costs the account gas, so they are capped per day. */
  day: string
  rounds: number
  again?: Hex
  announced?: SentOp
  srcTx?: Hex
  message?: Hex
  attestation?: Hex
  relayed?: SentOp
  /** Why the last step did not move on (for logs and /ops). */
  why?: string
}

/**
 * What asking for an announce gives: our own op (to be read), the peer's transaction, the peer's announce still on its
 * way (`pending`: asked again next step, no failure, no round), or not now and why (`wait`: a failure, backed off).
 */
export type AnnounceAnswer = { op: SentOp } | { txHash: Hex } | { pending: string } | { wait: string }

export type ReadyPorts = {
  /** Readiness on the destination chain, read on chain. Throws when it cannot be read: the step does nothing. */
  isReady(): Promise<boolean>
  /** Send announceReady on the source chain, or ask the peer that runs it (`again`: see ReadyFlow). */
  announce(again?: Hex): Promise<AnnounceAnswer>
  /** Where an op the flow sent stands: `source` the announce, `destination` the relay. */
  outcome(side: 'source' | 'destination', op: SentOp): Promise<OpOutcome>
  /** Circle's complete attestations for `srcTx` (iris), empty while pending, null when Circle did not answer. */
  attestations(srcTx: Hex): Promise<{ message: Hex; attestation: Hex }[] | null>
  /** Why this message and attestation are not the readiness this flow waits for (null: accepted). */
  reject(message: Hex, attestation: Hex): Promise<string | null>
  /** Send relayMessage on the destination chain: the op, or not now and why. */
  relay(message: Hex, attestation: Hex): Promise<{ op: SentOp } | { wait: string }>
}

/** Announce rounds per account and direction per UTC day: each costs gas under the account's gas rate. */
export const READY_ROUNDS_PER_DAY = 4
/** An announce Circle has not attested after this is announced again (Base and Ethereum Standard: ~15-20 min). */
export const READY_ATTEST_GIVEUP_MS = 3 * 3_600_000
/** A message whose relay failed this many times in a row is dropped and announced again. */
export const READY_RELAY_TRIES = 3
/** Backoff after the n-th consecutive failure: one minute, doubling, at most 30 minutes. */
export function readyBackoffMs(fails: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, fails - 1), 30 * 60_000)
}

const iso = (ms: number) => new Date(ms).toISOString()
const utcDay = (ms: number) => iso(ms).slice(0, 10)

function enter(r: ReadyFlow, state: ReadyState, nowMs: number, patch: Partial<ReadyFlow> = {}): ReadyFlow {
  const { nextAt: _n, why: _w, ...rest } = r
  return { ...rest, state, since: iso(nowMs), fails: 0, ...patch }
}

function failed(r: ReadyFlow, nowMs: number, why: string): ReadyFlow {
  const fails = r.fails + 1
  return { ...r, fails, nextAt: iso(nowMs + readyBackoffMs(fails)), why }
}

/** A new round from `announce`: what the previous round sent is dropped; `again` names its unusable source tx. */
function restart(r: ReadyFlow, nowMs: number, why: string, again?: Hex): ReadyFlow {
  const { announced: _a, srcTx: _s, message: _m, attestation: _t, relayed: _r, ...rest } = r
  return { ...rest, state: 'announce', since: iso(nowMs), fails: r.fails + 1, nextAt: iso(nowMs + readyBackoffMs(r.fails + 1)), why, ...(again ? { again } : { again: undefined }) }
}

export type ReadyStep = {
  /** The flow to persist (undefined: nothing under way). */
  flow: ReadyFlow | undefined
  ready: boolean
  /** Something to persist changed. */
  changed: boolean
  /** A line for the log when the flow moved or failed. */
  note?: string
}

/**
 * One step of the readiness flow at `nowMs`. Reads readiness first: ready ends the flow and nothing is sent (no double
 * announce, also after a restart or when anyone else relayed). Otherwise moves at most one state. A port that throws ends
 * the step with nothing changed (the caller logs it); the next tick tries again from the persisted state.
 */
export async function stepReady(prev: ReadyFlow | undefined, p: ReadyPorts, nowMs: number): Promise<ReadyStep> {
  if (await p.isReady()) return { flow: undefined, ready: true, changed: prev !== undefined, ...(prev ? { note: `ready (was ${prev.state})` } : {}) }
  let r: ReadyFlow = prev ?? { state: 'announce', since: iso(nowMs), fails: 0, day: utcDay(nowMs), rounds: 0 }
  const fresh = prev === undefined
  if (r.nextAt && nowMs < Date.parse(r.nextAt)) return { flow: r, ready: false, changed: fresh }
  const moved = (flow: ReadyFlow, note: string): ReadyStep => ({ flow, ready: false, changed: true, note })
  switch (r.state) {
    case 'announce': {
      if (r.day !== utcDay(nowMs)) r = { ...r, day: utcDay(nowMs), rounds: 0 }
      if (r.rounds >= READY_ROUNDS_PER_DAY) {
        const tomorrow = Date.parse(`${utcDay(nowMs)}T00:00:00Z`) + 86_400_000
        return moved({ ...r, nextAt: iso(tomorrow), why: `${r.rounds} announce rounds today` }, `[alert] ${r.rounds} announce rounds today without readiness: waits until tomorrow`)
      }
      const a = await p.announce(r.again)
      if ('pending' in a) return r.why === a.pending && !fresh ? { flow: r, ready: false, changed: false } : moved({ ...r, why: a.pending }, `announce on its way (${a.pending})`)
      if ('wait' in a) return moved(failed(r, nowMs, a.wait), `announce not sent: ${a.wait}`)
      const rounds = r.rounds + 1
      if ('op' in a) return moved(enter(r, 'announced', nowMs, { announced: a.op, rounds, again: undefined }), `announceReady sent, userOp ${a.op.userOpHash}`)
      return moved(enter(r, 'attesting', nowMs, { srcTx: a.txHash, rounds, again: undefined }), `announceReady ran in ${a.txHash}`)
    }
    case 'announced': {
      const o = await p.outcome('source', r.announced!)
      if (o === 'pending') return { flow: r, ready: false, changed: fresh }
      if (o === 'gone') return moved(restart(r, nowMs, 'the announce op never ran'), 'announce op never ran: announced again')
      if (!o.success) return moved(restart(r, nowMs, `the announce op reverted in ${o.txHash}`), `announce op reverted in ${o.txHash}: announced again`)
      return moved(enter(r, 'attesting', nowMs, { srcTx: o.txHash }), `announceReady ran in ${o.txHash}`)
    }
    case 'attesting': {
      const list = await p.attestations(r.srcTx!)
      if (list === null) return moved(failed(r, nowMs, 'Circle did not answer'), 'attestation: Circle did not answer')
      const why: string[] = []
      for (const x of list) {
        const no = await p.reject(x.message, x.attestation)
        if (!no) return moved(enter(r, 'relay', nowMs, { message: x.message, attestation: x.attestation }), `attested (${r.srcTx})`)
        why.push(no)
      }
      if (nowMs - Date.parse(r.since) > READY_ATTEST_GIVEUP_MS) return moved(restart(r, nowMs, 'no usable attestation in time', r.srcTx), `no usable attestation of ${r.srcTx} in time: announced again`)
      if (why.length) return moved({ ...r, why: why.join('; ') }, `attestation ignored: ${why.join('; ')}`)
      return { flow: r, ready: false, changed: fresh }
    }
    case 'relay': {
      const s = await p.relay(r.message!, r.attestation!)
      if ('op' in s) return moved(enter(r, 'relayed', nowMs, { relayed: s.op, fails: r.fails }), `relayMessage sent, userOp ${s.op.userOpHash}`)
      if (r.fails + 1 >= READY_RELAY_TRIES) return moved(restart(r, nowMs, `relay refused: ${s.wait}`, r.srcTx), `relay refused ${READY_RELAY_TRIES} times (${s.wait}): announced again`)
      return moved(failed(r, nowMs, s.wait), `relay not sent: ${s.wait}`)
    }
    case 'relayed': {
      const o = await p.outcome('destination', r.relayed!)
      if (o === 'pending') return { flow: r, ready: false, changed: fresh }
      if (o !== 'gone' && o.success) {
        // It ran: readiness again, now (the read at the top may predate it).
        if (await p.isReady()) return { flow: undefined, ready: true, changed: true, note: `ready (relayed in ${o.txHash})` }
        return moved(restart(r, nowMs, `relayed in ${o.txHash} yet not ready (owners changed since?)`, r.srcTx), `relayed in ${o.txHash} yet not ready: announced again`)
      }
      const why = o === 'gone' ? 'the relay op never ran' : `the relay op reverted in ${o.txHash}`
      const back = { ...r, state: 'relay' as const, relayed: undefined }
      if (r.fails + 1 >= READY_RELAY_TRIES) return moved(restart(back, nowMs, why, r.srcTx), `${why} (${READY_RELAY_TRIES} tries): announced again`)
      return moved(failed(back, nowMs, why), `${why}: relayed again`)
    }
  }
}

// ---------------------------------------------------------------- the announcing side, on the peer that runs the Safe

/** The announcing side's record (Monad, for a V4 remote): its op, then the transaction that ran it, per day counted. */
export type AnnounceRecord = { op?: SentOp; txHash?: Hex; day: string; n: number; at: string }

export type AnnouncePorts = {
  /** The destination already holds the Safe ready (read where it can be; absent: unknown, not ready). */
  alreadyReady?: () => Promise<boolean>
  send(): Promise<{ op: SentOp } | { wait: string }>
  outcome(op: SentOp): Promise<OpOutcome>
}

export type PeerAnnounceAnswer = { state: 'announced'; txHash: Hex } | { state: 'ready' } | { state: 'pending'; code: string }

/**
 * The announcing side's answer to "announce": idempotent. A recorded transaction is returned again, unless the asker
 * names it as unusable (`again`): only then is a new announce sent. An op still out is read, never sent beside. At most
 * READY_ROUNDS_PER_DAY sends a day.
 */
export async function peerAnnounce(prev: AnnounceRecord | undefined, again: Hex | undefined, p: AnnouncePorts, nowMs: number): Promise<{ record: AnnounceRecord | undefined; answer: PeerAnnounceAnswer; changed: boolean }> {
  let r = prev
  let changed = false
  if (r?.txHash && (!again || again.toLowerCase() !== r.txHash.toLowerCase())) return { record: r, answer: { state: 'announced', txHash: r.txHash }, changed }
  if (r?.op && !r.txHash) {
    const o = await p.outcome(r.op)
    if (o === 'pending') return { record: r, answer: { state: 'pending', code: 'ANNOUNCE_PENDING' }, changed }
    if (o !== 'gone' && o.success) {
      r = { ...r, txHash: o.txHash, at: iso(nowMs) }
      return { record: r, answer: { state: 'announced', txHash: o.txHash }, changed: true }
    }
    r = { ...r, op: undefined }
    changed = true
  }
  if (p.alreadyReady && (await p.alreadyReady())) return { record: r, answer: { state: 'ready' }, changed }
  const day = utcDay(nowMs)
  const n = r?.day === day ? r.n : 0
  if (n >= READY_ROUNDS_PER_DAY) return { record: r, answer: { state: 'pending', code: 'ANNOUNCE_DAILY_LIMIT' }, changed }
  const s = await p.send()
  if ('wait' in s) return { record: r, answer: { state: 'pending', code: s.wait }, changed }
  return { record: { op: s.op, day, n: n + 1, at: iso(nowMs) }, answer: { state: 'pending', code: 'ANNOUNCE_SENT' }, changed: true }
}

// ---------------------------------------------------------------- reading the chains

const USER_OPERATION_EVENT = parseAbiItem('event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)')

/**
 * Where a userOp the flow sent stands, from the EntryPoint's logs: its UserOperationEvent from the block it was signed at,
 * `chunk` blocks per request. An op claiming time T can be included only up to T + 300 (A1): once the head is past that
 * (plus `marginSec`) and no event was found, it never ran and never will ('gone').
 */
export async function userOpOutcome(client: Pick<PublicClient, 'getBlock' | 'getLogs'>, entryPoint: Address, op: SentOp, o: { expiresAt: bigint; chunk?: bigint; marginSec?: bigint; maxBlocks?: bigint } ): Promise<OpOutcome> {
  const head = await client.getBlock({ blockTag: 'latest' })
  const chunk = o.chunk ?? 1_000n
  const from = BigInt(op.fromBlock)
  const last = o.maxBlocks !== undefined && from + o.maxBlocks < head.number! ? from + o.maxBlocks : head.number!
  for (let lo = from; lo <= last; lo += chunk) {
    const hi = lo + chunk - 1n < last ? lo + chunk - 1n : last
    const logs = await client.getLogs({ address: entryPoint, event: USER_OPERATION_EVENT, args: { userOpHash: op.userOpHash }, fromBlock: lo, toBlock: hi })
    const l = logs.find((x) => x.args.userOpHash?.toLowerCase() === op.userOpHash.toLowerCase())
    if (l?.transactionHash) return { txHash: l.transactionHash, success: l.args.success === true }
  }
  return head.timestamp > o.expiresAt + (o.marginSec ?? 60n) ? 'gone' : 'pending'
}

/** The readiness message V4 sends (`announceReady`), as Circle attests it: MessageV2 header and the body (home, safe, ownersHash). */
export type ReadinessMessage = { sourceDomain: number; destinationDomain: number; sender: Hex; recipient: Hex; destinationCaller: Hex; minFinality: number; finalityExecuted: number; home: Address; safe: Address; ownersHash: Hex }

export function decodeReadinessMessage(m: Hex): ReadinessMessage {
  const n = (m.length - 2) / 2
  if (n !== 148 + 96) throw new Error('not a readiness message (length)')
  const at = (o: number, len: number) => sliceHex(m, o, o + len, { strict: true })
  const [home, safe, ownersHash] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], sliceHex(m, 148))
  return {
    sourceDomain: Number(hexToBigInt(at(4, 4))),
    destinationDomain: Number(hexToBigInt(at(8, 4))),
    sender: at(44, 32),
    recipient: at(76, 32),
    destinationCaller: at(108, 32),
    minFinality: Number(hexToBigInt(at(140, 4))),
    finalityExecuted: Number(hexToBigInt(at(144, 4))),
    home: getAddress(home),
    safe: getAddress(safe),
    ownersHash,
  }
}

/**
 * Why `m` is not the readiness V4 on `source` sent to V4 on `destination` for `home` / `safe` (null: it is): from and to
 * the same V4, open destination caller, Standard finality asked and executed (V4 refuses Fast), the expected pair. The
 * attestation's signers are checked apart (cctp.ts attestationValid, on the destination chain).
 */
export function readinessMismatch(m: Hex, want: { source: number; destination: number; v4: Address; home: Address; safe: Address }): string | null {
  let d: ReadinessMessage
  try {
    d = decodeReadinessMessage(m)
  } catch (e) {
    return (e as Error).message
  }
  const w = (a: Address) => pad(a, { size: 32 }).toLowerCase()
  if (d.sourceDomain !== want.source || d.destinationDomain !== want.destination) return `domains ${d.sourceDomain} -> ${d.destinationDomain}`
  if (d.sender.toLowerCase() !== w(want.v4) || d.recipient.toLowerCase() !== w(want.v4)) return 'not from V4 to V4'
  if (BigInt(d.destinationCaller) !== 0n) return 'destination caller set'
  if (d.minFinality < 2000 || d.finalityExecuted < 2000) return `finality ${d.minFinality}/${d.finalityExecuted}`
  if (d.home !== getAddress(want.home) || d.safe !== getAddress(want.safe)) return `for ${d.home} / ${d.safe}`
  return null
}
