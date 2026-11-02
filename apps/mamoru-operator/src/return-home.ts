// otto/mamoru#278 (spec 002 FR-XCH-014 a/c), the home side of the return leg: savings a V4 home account asks its remote
// Safe on Monad to send back, followed from the request to the mint here.
//
//   requested  on disk before the peer is asked (POST release, its id); asked again with the same id until it answers
//   burned     the peer reports the burn (tx, block, amount), settled there against Monad's chain
//   minted     Circle's attestation of that burn (source Monad), checked, and receiveMessage on Base by the relayer (or
//              its nonce found used: anyone may mint, the message fixes recipient and amount)
//   cancelled  the peer reports it withdrawn before any burn
// One open return per account. While one is open the account's bridges wait in both directions (`busy`); until its
// burn is known the remote value never reads below the value it was asked at (`floor`), and a burned one counts as
// value in flight until it is minted (`inFlight`). A request the peer proves it holds nothing for (bad request, not a
// remote there) is cancelled here; any other refusal keeps it open and holding. A
// burn never minted (attestation never matching, mints reverting) keeps the account's bridges waiting and is logged:
// that money is in transit and nothing else moves until someone looks.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Hex, PublicClient, TransactionReceipt } from 'viem'
import type { AccountContext, Address } from '@mamoru/domain'
import { messageTransmitterV2Abi } from '@mamoru/registry'
import type { MonadSender } from './bridge-monad.ts'
import { MAX_BASE_GAS_PRICE_WEI } from './bridge-out.ts'
import { attestationValid, CCTP_DOMAIN_BASE, CCTP_DOMAIN_MONAD, cctpAttestation, decodeCctpMessage, MESSAGE_TRANSMITTER_V2, mintIsFor, receiveMessageData } from './cctp.ts'
import type { ReleaseView } from './release.ts'

/** The peer's release routes (RemotePeer). */
export type ReturnPeer = { release(remote: AccountContext, id: string, amount: bigint): Promise<ReleaseView>; releaseStatus(remote: AccountContext, id?: string): Promise<ReleaseView> }

export type ReturnEntry = {
  id: string
  accountKey: string
  /** The home Safe: the only mint recipient. */
  home: Address
  /** Raw savings units asked for. */
  amount: string
  state: 'requested' | 'burned' | 'minted' | 'cancelled'
  /**
   * The remote value the request was made at: until the burn is known, the account's remote value never reads below it
   * (the burn may land on Monad before the peer reports it).
   */
  floor?: string
  /** Why it was cancelled here or by the peer. */
  note?: string
  /** What the peer burned (≤ amount), its Monad tx and block. */
  burn?: { amount: string; txHash: Hex; block: number }
  cctpNonce?: Hex
  mintTx?: Hex
  mintAt?: string
  mintReverts?: number
  mintedBlock?: string
  attestPolledAt?: string
  at: string
  updatedAt: string
}

type Journal = { returns: Record<string, ReturnEntry>; mintDays: Record<string, { n: number }> }

/** receiveMessage on Base: gas estimate ceiling (with 10 % added) and mints per UTC day, all accounts. */
export const RETURN_MINT_GAS_CAP = 300_000n
export const RETURN_MINTS_PER_DAY = 50
/** A mint signed but without a receipt after this long is tried again (the used-nonce check stops a second mint). */
export const RETURN_MINT_PENDING_MS = 10 * 60_000
export const RETURN_MINT_MAX_REVERTS = 3
/** Circle's Standard finality from Monad: the first poll waits this long, then one poll a minute. */
export const RETURN_ATTEST_FIRST_POLL_MS = 5 * 60_000
export const RETURN_ATTEST_POLL_MS = 60_000
/** Minted and cancelled returns are kept this long for the ops history, then pruned. */
export const RETURN_KEEP_MS = 30 * 24 * 3600_000

class MintBudget extends Error {}

export class ReturnHome {
  private journal: Journal
  private readonly file: string

  constructor(
    stateDir: string,
    /** Base, through the operator's proxy: the attestation check, the used nonce, the mint. */
    private readonly base: PublicClient,
    /** The operator's relayer on Base. Null: no mint is sent (a used nonce is still marked minted). */
    private readonly relayer: MonadSender | null,
    /** MamoruActionPolicyV4 on Monad (the burns' depositor and CCTP sender) and Monad's USDC; null while unpinned: nothing is minted. */
    private readonly monad: () => { v4: Address; usdc: Address } | null,
    private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.file = join(stateDir, 'return-home.json')
    this.journal = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Journal) : { returns: {}, mintDays: {} }
    this.journal.returns ??= {}
    this.journal.mintDays ??= {}
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.journal, null, 1), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** A change on disk before anything else happens; a save that throws leaves the entry as it was. */
  private update(e: ReturnEntry, patch: Partial<ReturnEntry>): void {
    const before = { ...e }
    Object.assign(e, patch, { updatedAt: this.iso() })
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (e as Record<string, unknown>)[k]
    try {
      this.save()
    } catch (err) {
      for (const k of Object.keys(e)) delete (e as Record<string, unknown>)[k]
      Object.assign(e, before)
      throw err
    }
  }

  returns(): ReturnEntry[] {
    return Object.values(this.journal.returns)
  }

  /** The account's return not minted nor cancelled yet, if any (one at a time). */
  open(accountKey: string): ReturnEntry | undefined {
    return this.returns().find((e) => e.accountKey === accountKey && (e.state === 'requested' || e.state === 'burned'))
  }

  /** While a return is open the account's bridges wait, both ways. */
  busy(accountKey: string): boolean {
    return !!this.open(accountKey)
  }

  /** The remote value floor of the account's open return not yet known burned (see `floor`); 0 when none. */
  floor(accountKey: string): bigint {
    const e = this.open(accountKey)
    return e?.state === 'requested' && e.floor ? BigInt(e.floor) : 0n
  }

  /** Burned on Monad and not minted here yet: value of the account in flight. */
  inFlight(accountKey: string): bigint {
    return this.returns().reduce((s, e) => (e.accountKey === accountKey && e.state === 'burned' && e.burn ? s + BigInt(e.burn.amount) : s), 0n)
  }

  /**
   * Asks the remote Safe to send `amount` home: the entry is on disk before the peer is asked, so a lost answer is
   * asked again with the same id (the same request there). One open return per account: refused while one is.
   */
  /** The peer's latest release is none or cancelled (nothing open or sending there); unknown counts as not. */
  private async nothingOpen(remote: AccountContext, peer: ReturnPeer): Promise<boolean> {
    try {
      const v = await peer.releaseStatus(remote)
      return v.state === 'none' || v.state === 'cancelled'
    } catch {
      return false
    }
  }

  async request(accountKey: string, home: Address, remote: AccountContext, peer: ReturnPeer, amount: bigint, floor: bigint): Promise<ReturnEntry> {
    if (amount <= 0n) throw new Error(`return of ${amount}`)
    if (this.open(accountKey)) throw new Error(`${accountKey}: a return is already open`)
    const at = this.iso()
    const e: ReturnEntry = { id: `ret-${this.now().toString(36)}-${randomBytes(4).toString('hex')}`, accountKey, home, amount: amount.toString(), floor: floor.toString(), state: 'requested', at, updatedAt: at }
    this.journal.returns[e.id] = e
    try {
      this.save()
    } catch (err) {
      delete this.journal.returns[e.id]
      throw err
    }
    await this.ask(e, remote, peer)
    return e
  }

  /**
   * POST release for this entry. A refusal that proves the peer holds nothing for it (400 BAD_REQUEST; 404 NOT_A_REMOTE
   * with the peer's latest release none or cancelled) cancels it here, so it never holds the account. Anything else keeps it and holds the account, logged:
   * no answer (asked again on the next tick), or another release open there this journal does not know (409).
   */
  private async ask(e: ReturnEntry, remote: AccountContext, peer: ReturnPeer): Promise<void> {
    try {
      await peer.release(remote, e.id, BigInt(e.amount))
    } catch (err) {
      const status = (err as { status?: unknown }).status
      const code = (err as { code?: unknown }).code
      // A stopped Safe also answers 404 to a new request: only with nothing open or sending there is it nothing held.
      const nothingThere = status === 404 && code === 'NOT_A_REMOTE' && (await this.nothingOpen(remote, peer))
      if ((status === 400 && code === 'BAD_REQUEST') || nothingThere) {
        this.update(e, { state: 'cancelled', note: `refused by the peer: ${status} ${typeof code === 'string' ? code : ''}`.trim() })
        console.error(`[return] ${e.accountKey} ${e.id}: refused by the peer (${status} ${String(code ?? '')}); cancelled`)
        return
      }
      console.error(`[return] ${e.accountKey} ${e.id}: not taken yet (${typeof status === 'number' ? `${status} ${String(code ?? '')}` : (err as Error).message?.split('\n')[0]}); kept, asked again on the next tick`)
    }
  }

  /**
   * Every minute: each requested return asks the peer where it is (asked again when the peer does not know it), each
   * burned one is minted. `peerOf` gives the remote's context and peer for an account; none: that account waits.
   */
  async tick(peerOf: (accountKey: string) => { remote: AccountContext; peer: ReturnPeer } | null): Promise<void> {
    this.prune()
    for (const e of this.returns()) {
      try {
        if (e.state === 'requested') {
          const p = peerOf(e.accountKey)
          if (p) await this.follow(e, p.remote, p.peer)
        }
        if (e.state === 'burned') await this.mint(e)
      } catch (err) {
        console.error(`[return] ${e.accountKey} ${e.id}: ${(err as Error).message?.split('\n')[0]}`)
      }
    }
  }

  private async follow(e: ReturnEntry, remote: AccountContext, peer: ReturnPeer): Promise<void> {
    const v = await peer.releaseStatus(remote, e.id)
    if (v.state === 'none') return void (await this.ask(e, remote, peer))
    if ('id' in v && v.id !== e.id) throw new Error(`peer answered release ${v.id} for ${e.id}`)
    if (v.state === 'cancelled') return void this.update(e, { state: 'cancelled' })
    if (v.state !== 'burned') return
    if (!v.burn || BigInt(v.burn.amount) <= 0n || BigInt(v.burn.amount) > BigInt(e.amount)) throw new Error(`peer reports a burn of ${v.burn?.amount} for ${e.amount} asked`)
    this.update(e, { state: 'burned', burn: { amount: v.burn.amount, txHash: v.burn.txHash, block: v.burn.block } })
  }

  /**
   * A burned return, minted here: Circle's attestation of its Monad tx (source Monad), the message exactly this burn
   * (Monad USDC, to the home, the burned amount, Monad to Base, sent by V4 there) and signed by the attesters enabled
   * on Base; a nonce another return already has is never this one's; a used nonce is minted (by anyone); otherwise
   * receiveMessage from the relayer within the gas ceilings and the day's count, its hash on disk before the broadcast.
   */
  async mint(e: ReturnEntry): Promise<void> {
    if (!e.burn) return
    const m = this.monad()
    if (!m) return
    if (e.mintTx) {
      const rc = await this.base.getTransactionReceipt({ hash: e.mintTx }).catch(() => null)
      if (rc?.status === 'success') return void this.update(e, { state: 'minted', mintedBlock: rc.blockNumber.toString() })
      if (rc) this.update(e, { mintTx: undefined, mintReverts: (e.mintReverts ?? 0) + 1 })
      else if (this.now() - Date.parse(e.mintAt ?? e.updatedAt) < RETURN_MINT_PENDING_MS) return
      else this.update(e, { mintTx: undefined })
    }
    const now = this.now()
    if (now - Date.parse(e.updatedAt) < RETURN_ATTEST_FIRST_POLL_MS && !e.attestPolledAt) return
    if (e.attestPolledAt && now - Date.parse(e.attestPolledAt) < RETURN_ATTEST_POLL_MS) return
    const atts = await cctpAttestation(e.burn.txHash, this.fetcher, CCTP_DOMAIN_MONAD)
    this.update(e, { attestPolledAt: this.iso() })
    if (!atts) return
    const amount = BigInt(e.burn.amount)
    const att = atts.find((a) => {
      try {
        return mintIsFor(decodeCctpMessage(a.message), m.usdc, e.home, amount, { source: CCTP_DOMAIN_MONAD, destination: CCTP_DOMAIN_BASE }, m.v4)
      } catch {
        return false
      }
    })
    if (!att) return
    const msg = decodeCctpMessage(att.message)
    if (BigInt(msg.nonce) === 0n || !(await attestationValid(this.base, att.message, att.attestation))) {
      console.error(`[return] ${e.accountKey} ${e.id}: attestation not signed by the attesters enabled on Base, ignored`)
      return
    }
    if (this.returns().some((o) => o !== e && o.cctpNonce?.toLowerCase() === msg.nonce.toLowerCase())) {
      console.error(`[return] ${e.accountKey} ${e.id}: attestation of another return, ignored`)
      return
    }
    if (e.cctpNonce?.toLowerCase() !== msg.nonce.toLowerCase()) this.update(e, { cctpNonce: msg.nonce })
    const block = await this.base.getBlockNumber()
    const used = await this.base.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'usedNonces', args: [msg.nonce], blockNumber: block })
    if (used !== 0n) return void this.update(e, { state: 'minted', mintedBlock: block.toString() })
    if (!this.relayer) return
    const reverts = e.mintReverts ?? 0
    if (reverts >= RETURN_MINT_MAX_REVERTS) {
      console.error(`[return] ${e.accountKey} ${e.id}: receiveMessage reverted ${reverts} times; not sent again, kept in flight until someone looks`)
      return
    }
    if (reverts > 0 && now - Date.parse(e.mintAt ?? e.updatedAt) < RETURN_MINT_PENDING_MS * 2 ** (reverts - 1)) return
    const day = new Date(now).toISOString().slice(0, 10)
    if ((this.journal.mintDays[day]?.n ?? 0) >= RETURN_MINTS_PER_DAY) {
      console.error(`[return] ${e.accountKey} ${e.id}: Base mints for today used up, minting tomorrow`)
      return
    }
    const data = receiveMessageData(att.message, att.attestation)
    const est = await this.base.estimateGas({ account: this.relayer.address, to: MESSAGE_TRANSMITTER_V2, data })
    const gas = (est * 11n) / 10n
    if (gas > RETURN_MINT_GAS_CAP) {
      console.error(`[return] ${e.accountKey} ${e.id}: receiveMessage estimated at ${est} gas, over the ${RETURN_MINT_GAS_CAP} cap; not minted`)
      return
    }
    if ((await this.base.getGasPrice()) > MAX_BASE_GAS_PRICE_WEI) return
    let sent: { hash: Hex; receipt: TransactionReceipt }
    try {
      sent = await this.relayer.send(
        { to: MESSAGE_TRANSMITTER_V2, data, gas },
        undefined,
        (_wei, { maxFeePerGas }) => {
          if (maxFeePerGas > MAX_BASE_GAS_PRICE_WEI) throw new MintBudget('Base gas above the mint ceiling, minting later')
        },
        // The mint's hash is on disk before the broadcast; only a signed mint counts against the day.
        (h) => {
          this.journal.mintDays = { [day]: { n: (this.journal.mintDays[day]?.n ?? 0) + 1 } }
          this.update(e, { mintTx: h, mintAt: this.iso() })
        },
      )
    } catch (err) {
      if (err instanceof MintBudget) return
      throw err
    }
    if (sent.receipt.status === 'success') this.update(e, { state: 'minted', mintTx: sent.hash, mintedBlock: sent.receipt.blockNumber.toString() })
    else this.update(e, { mintTx: undefined, mintReverts: reverts + 1 })
  }

  private prune(): void {
    const cutoff = this.now() - RETURN_KEEP_MS
    let changed = false
    for (const [id, e] of Object.entries(this.journal.returns)) {
      if ((e.state === 'minted' || e.state === 'cancelled') && Date.parse(e.updatedAt) < cutoff) {
        delete this.journal.returns[id]
        changed = true
      }
    }
    if (changed) this.save()
  }
}
