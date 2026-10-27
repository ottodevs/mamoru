import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountContext, Hex, OpView } from '@mamoru/domain'
import type { SessionGrant } from '@mamoru/policy'
import type { SafeTx } from '@mamoru/account/live'
import type { Execution } from '@mamoru/account/safe'
import type { OpRecord } from '@mamoru/scenarios/driver/journal.ts'
import type { SponsorEntry } from './sponsorship.ts'
import type { OpFacts } from './yield-receipts.ts'

/** An op as GET /ops serves it, plus what the operator keeps: repeat count of an identical failure, and for a confirmed engine op the session and calls it used (ledger replay on restart). */
export type StoredOp = OpView & {
  count?: number
  /** An engine op settled failed whose signed bytes were included later: its session uses replay like a confirmed one. */
  lateIncluded?: boolean
  permissionId?: Hex
  calls?: Execution[]
  /** Owner activate: the grants its tx enables, so a late receipt can still start the engine. */
  ownerGrants?: StoredGrant[]
  /** activate/renew (spec 006): the cap, in base units, its grants were sized for and its summary named. */
  capUsdc?: string
  /** Owner stop: the permissionIds its tx revokes. */
  revokes?: Hex[]
  /** Owner op: the Safe transaction hash it was signed for (ExecutionSuccess carries it) and its Safe nonce. */
  safeTxHash?: Hex
  safeNonce?: string
  /** When (ms) the op was created, before its transaction was sent: where its ExecutionSuccess is searched from. */
  sentAt?: number
  /** When (ms) a copy of its transaction was first, and last, handed to a provider (an armed Start: maybe days after sentAt). */
  broadcastAt?: number
  lastBroadcastAt?: number
  /** otto/mamoru#129: an engine op's userOp hash, so its facts count that userOp only (yield-receipts.ts). */
  userOpHash?: Hex
  /** otto/mamoru#129: an op's gas and collected fees, read once from its receipt (yield-receipts.ts). */
  facts?: OpFacts
  /**
   * otto/mamoru#163: an owner activation or renewal, every signed copy of its execTransaction (relayer tx hash and
   * nonce), kept before it left; `reverted` once its receipt says so. A revert leaves the Safe nonce unspent and the
   * owner's signature relayable by anyone: only the Safe nonce moving settles the op.
   */
  signedTxs?: { hash: Hex; nonce: number; reverted?: true }[]
  /** otto/mamoru#163: the Safe tx hash whose execution spent this op's Safe nonce, read from that block's own log. */
  spentBy?: Hex
  /** otto/mamoru#163: the last block the bounded range search for its ExecutionSuccess has covered (checkpoint). */
  scannedTo?: string
  /**
   * otto/mamoru#218: an engine op that closed a position to re-range it (`kind` is `reduce` for it, as for a harvest),
   * and the block timestamp (unix seconds, decimal) it was included at. Both are set once it is confirmed; the operator
   * seeds a new engine's cooldown and weekly count from the confirmed ones.
   */
  rerange?: true
  rerangeAt?: string
  /** otto/mamoru#15: an activation whose batch buys its own gas reserve: the unix time its swap reverts after. */
  reserveDeadline?: string
}

/** A grant the owner enabled on chain (enter-swap, enter-mint). */
export type StoredGrant = {
  name: string
  grant: SessionGrant
  permissionId: Hex
  /** Spec 007 T7: tokenIds this session's owner-signed `Init.admit` admitted at enable (v4 only), for the engine's precheck mirror. */
  admit?: string[]
}

/** An activation the owner signed before any USDC arrived; the operator executes it when the deposit lands. */
export type ArmedActivation = {
  opId: string
  tx: SafeTx
  safeTxHash: Hex
  /** Owner signature (SafeWebAuthnSharedSigner contract signature) over safeTxHash. */
  signature: Hex
  /** The grants this tx enables, with their permissionIds. */
  grants: StoredGrant[]
  armedAt: string
  /** Failed execution attempts so far; the watcher retries until ARM_MAX_TRIES. */
  tries?: number
  /** Not before this time (ms): the wait after a failed attempt grows with the tries. */
  retryAt?: number
  /** A failed attempt got as far as sending the execTransaction: it may have landed although the reply said no. */
  execSent?: boolean
  /** When (ms) the execTransaction was first handed to a provider: nothing of it can be on chain before. */
  sentAt?: number
  /** Spec 006: the cap (base units) the signed summary named; the activation never takes in more under this signature. */
  capUsdc?: string
  /** otto/mamoru#140 (part2 #3): the account's owner generation it was prepared at. Absent: armed before generations were kept. */
  gen?: number
  /** otto/mamoru#15: wei of gas reserve the signed batch buys into the Safe at least (USDC -> ETH swap); absent: none. */
  reserveWei?: string
  /** otto/mamoru#15: unix time after which that swap reverts: an approval never sent is dropped near it. */
  reserveDeadline?: string
}

export type AccountState = {
  /** Spec 006: the cap (base units) the account's current grants were sized for, from its last confirmed activation or renewal. Absent: LIVE_CAP_USDC. */
  signedCapUsdc?: string
  accountKey: string
  ctx: AccountContext
  /** Registry trust calls already ran on this Safe (first activation). */
  trusted: boolean
  active: boolean
  /** Policy of the last activation (absent: activated before it was stored, conservador-live-v1). */
  policyId?: string
  /** Engine session key. Private, 0600 state file only, never logged. */
  sessionKey?: Hex
  grants: StoredGrant[]
  revoked: Hex[]
  /**
   * Permission ids still enabled on the Safe that the engine no longer uses: the grants a renewal replaced when it
   * could not revoke them in its own transaction. A stop revokes them with the rest.
   */
  superseded?: Hex[]
  /**
   * otto/mamoru#140: why the account stopped running without an owner op of its own confirmed (invariant I1, see
   * Operator.enforceGrants): one block showed engine grants disabled by a transaction not proven to be ours.
   * GRANTS_PARTLY_REVOKED: some of them (the ones still enabled are kept in `superseded` for the next stop);
   * GRANTS_REVOKED_ELSEWHERE: all of them. `opId`: the owner op of unknown outcome pending then, left unconfirmed.
   * Cleared by an activation, or when that op is proven.
   */
  deactivated?: { code: 'GRANTS_REVOKED_ELSEWHERE' | 'GRANTS_PARTLY_REVOKED'; opId?: string; block: string; at: string }
  managedTokenIds: string[]
  depositsAfter: string
  historyFromBlock: string
  /** Block the engine's current grants were enabled in by a renewal: the engine must not observe before it. */
  grantsFromBlock?: string
  /** Bumped at each activation so engine op ids stay unique across runs. */
  epoch: number
  /** Engine loops started in this epoch; part of engine op ids so a restart never reuses one. */
  runs?: number
  ops: StoredOp[]
  /**
   * otto/mamoru#140 (Sol review round 2 of #64): engine ops whose signed bytes may still be included (Engine.carried),
   * handed to every later engine of the account until the nonce at `safe` passes them or they land.
   */
  carried?: OpRecord[]
  seq: number
  /** Signed activation waiting for the first USDC deposit. */
  armed?: ArmedActivation
  /** When owner executions of this account failed (ISO), last 24 h: the relayer's failure budget. */
  ownerFailures?: string[]
  /**
   * otto/mamoru#140 (part2 #3): owner generation, bumped by every activation, stop and renewal that lands. An
   * activation prepared or armed at another generation is stale. Absent: 0.
   */
  gen?: number
  /**
   * otto/mamoru#140 (part2 #4): position tokenIds Mamoru's engine minted on this Safe. Only these are sized from by a
   * withdrawal and shown by funding; anyone can send a Safe a position NFT. Absent: an account from before the record
   * (every non-dust position counts until it is seeded at boot or the next activation).
   */
  admittedTokenIds?: string[]
  /** Sol review round 2 #3: the block each admitted id was minted in; a read from before it never prunes the id. */
  admittedAt?: Record<string, string>
  /**
   * otto/mamoru#184: the account's admitted positions at its last decided review, for the other accounts' depth
   * sizing. Kept across stops and restarts: a lapsed session leaves its positions in the pool. Liquidity as a decimal
   * string; null when an entry was decided before any review recorded them (unknown, as with no view). `entering`:
   * the pool of an entry (mint, increase, re-range) decided then and not yet observed.
   */
  peerView?: { positions: { pool: string | null; tickLower: number; tickUpper: number; liquidity: string }[] | null; entering: string | null }
  /** otto/mamoru#140 (part2 #6): owner transactions of this account the relayer paid for, last 24 h (sponsorship limits). */
  sponsored?: SponsorEntry[]
}

export type OperatorState = { accounts: Record<string, AccountState> }

const BIG = '$big'

function replacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? { [BIG]: v.toString() } : v
}

function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if (typeof o[BIG] === 'string' && Object.keys(o).length === 1) return BigInt(o[BIG] as string)
  }
  return v
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

/** JSON state in one 0600 file, written atomically (tmp + rename). */
export class StateStore {
  readonly file: string
  state: OperatorState

  constructor(readonly dir: string) {
    ensureDir(dir)
    this.file = join(dir, 'accounts.json')
    this.state = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8'), reviver) as OperatorState) : { accounts: {} }
  }

  save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, replacer, 1), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}

/** Reads a 0x private key from `file`, or creates one there (0600). The key is never printed. */
export function loadOrCreateKey(file: string, generate: () => Hex): Hex {
  if (existsSync(file)) {
    const k = readFileSync(file, 'utf8').trim()
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${file} does not hold a 0x private key`)
    return k as Hex
  }
  const k = generate()
  writeFileSync(file, `${k}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return k
}
