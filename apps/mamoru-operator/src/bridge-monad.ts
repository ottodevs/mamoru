import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAddress, isAddressEqual, pad, parseAbiItem, parseEventLogs, type Hex, type Log, type PublicClient, type TransactionReceipt } from 'viem'
import { ReasonError, type Address, type BridgeProgress } from '@mamoru/domain'
import { address, baseRegistry, entry, entryPointV07Abi, messageTransmitterV2Abi, monadRegistry, safe7579Abi, tokenMessengerV2Abi, type Registry } from '@mamoru/registry'
import { readUserOpEvent } from '@mamoru/rpc'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { twapTickAt } from '@mamoru/uniswap-v3/twap'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import { amountsForLiquidity, inUsdc, readSafe, usdcPools, type SafeRead } from './chain.ts'
import { attestationValid, CCTP_DOMAIN_BASE, CCTP_DOMAIN_MONAD, cctpAttestation, cctpMessageKey, decodeCctpMessage, MESSAGE_TRANSMITTER_V2, mintIsFor, receiveMessageData } from './cctp.ts'
import { Lock } from './lock.ts'
import { logErr } from './metrics.ts'

// otto/mamoru#215: the bridge leg of a v6 account, Base to its own sleeve on Monad (same Safe address there).
//
// The engine burns on Base with the bridge-out session (CCTP V2 depositForBurn, Standard finality, no fee, any caller).
// This file keeps, per burn, what the allocator must never lose sight of, and finishes the transfer on Monad:
// - a journal on disk (bridge-monad.json, 0600) with every burn from BEFORE its userOp is signed ('sending'), its Base
//   transaction and CCTP message once it landed ('burned'), and 'minted' once MessageTransmitterV2 on Monad has used
//   the message's nonce. Until then the amount is in flight: counted in the account's remote value and blocking any
//   new bridge (decide's DECIDE_WAIT_BRIDGE). A 'sending' burn whose outcome is unknown stays in flight until the chain
//   settles it: its UserOperationEvent (burned, or reverted: 'failed'), or its nonce taken at `safe` without it
//   ('dropped');
// - the account's sleeve value on Monad, valued at the TWAP of each pool it holds (never slot0), plus in flight;
//   `ready` when the sleeve's Safe has code on Monad and SmartSession is installed on it;
// - the mint: Circle's attestation for source domain 6 (Base) and the burn's Base transaction, checked to be this
//   burn (message key, Base to Monad, the account as recipient and sender, the amount) and signed by the attesters
//   enabled on Monad, then receiveMessage on Monad from the operator's relayer key (its own nonce space on Monad, as
//   on Ethereum for bridge-out), under a MON gas ceiling and a daily MON budget, the mint's hash on disk before the
//   broadcast. Anyone may mint (destinationCaller 0): a nonce already used is marked minted without a transaction.

export const BRIDGE_MONAD_CHAIN_ID = 143
/** Attestation polls of one burn at most this often (Standard finality from Base takes ~15-20 min). */
export const ATTEST_POLL_MS = 60_000
/** The first poll waits this long after the burn landed: nothing is attested before Base's finality. */
export const ATTEST_FIRST_POLL_MS = 5 * 60_000
/** Gas limit of one receiveMessage on Monad at most (Monad charges the limit, so the estimate +10% is sent). */
export const MONAD_MINT_GAS_CAP = 500_000n
/** The relayer does not mint above this maxFeePerGas (Monad's base fee is ~100 gwei; 500 gwei bounds a mint to 0.25 MON). */
export const MAX_MONAD_GAS_PRICE_WEI = 500_000_000_000n
/** Most the relayer spends on Monad mints per UTC day, all accounts (2 MON), and how many. */
export const MONAD_MINT_BUDGET_WEI = 2_000_000_000_000_000_000n
export const MONAD_MINTS_PER_DAY = 50
/** A mint signed but without a receipt after this long is tried again (the used-nonce check stops a second mint). */
export const MONAD_MINT_PENDING_MS = 10 * 60_000
/** Minted burns are kept this long for the ops history, then pruned. */
export const MINTED_KEEP_MS = 30 * 24 * 3600_000
/** Native USDC on Base: the token the session burns (the message's burnToken). */
export const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

export type BridgeBurnState = 'sending' | 'burned' | 'minted' | 'failed' | 'dropped'

export type BridgeBurn = {
  /** The userOp hash: one burn per signed userOp. */
  id: Hex
  accountKey: string
  account: Address
  opId: string
  chainId: number
  destinationDomain: number
  bucket: string
  pool: string
  /** Raw USDC. */
  amount: string
  state: BridgeBurnState
  at: string
  updatedAt: string
  nonceKey: string
  nonce: string
  /** Base block the op was prepared at: its UserOperationEvent is looked for from here. */
  fromBlock: string
  txHash?: Hex
  burnBlock?: string
  burnedAt?: string
  /** cctpMessageKey of the MessageSent the burn emitted: the attested message must have the same. */
  messageKey?: Hex
  /** The attested CCTP nonce, once known. */
  cctpNonce?: Hex
  attestPolledAt?: string
  mintTx?: Hex
  mintAt?: string
  /** Monad block at (or before) which the mint is known on chain: a sleeve read at an earlier block still counts it in flight. */
  mintedBlock?: string
  note?: string
}

type Journal = {
  burns: Record<string, BridgeBurn>
  mintDays: Record<string, { n: number; wei: string }>
  /** Last sleeve value read per account (raw USDC, without in flight), and its Monad block. */
  sleeves: Record<string, { value: string; block: string; at: string }>
}

/** What the ops view shows of a bridge. */
export type BridgeView = BridgeProgress

/** The Monad relayer: Relayer's send, nothing else. */
export type MonadSender = {
  readonly address: Address
  send(tx: { to: Address; data?: Hex; gas?: bigint }, onSent?: (hash: Hex) => void, onSending?: (maxFeeWei: bigint, signed: { hash: Hex; nonce: number; maxFeePerGas: bigint }) => void, onSigned?: (hash: Hex, nonce: number) => void): Promise<{ hash: Hex; receipt: TransactionReceipt }>
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const IN_FLIGHT = new Set<BridgeBurnState>(['sending', 'burned'])
const userOperationEvent = parseAbiItem('event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)')

class MintBudget extends Error {}

/**
 * The remote value of one account from a sleeve read and the journal: in flight is every burn not yet minted, and every
 * burn minted at a Monad block after the one the sleeve was read at (its USDC is not in that read yet). Never less.
 */
export function inFlightOf(burns: readonly BridgeBurn[], accountKey: string, sleeveBlock: bigint): bigint {
  let sum = 0n
  for (const b of burns) {
    if (b.accountKey !== accountKey) continue
    if (IN_FLIGHT.has(b.state) || (b.state === 'minted' && (b.mintedBlock === undefined || BigInt(b.mintedBlock) > sleeveBlock))) sum += BigInt(b.amount)
  }
  return sum
}

/**
 * The sleeve's value in raw USDC at the TWAP of each pool it holds a token or a position of (`twapWindowSeconds`, read
 * at the same block as the balances): token balances, and positions with their amounts at the TWAP price plus what they
 * owe. MON itself (the Safe's gas reserve) is not counted. Throws EHG_TWAP_UNAVAILABLE when a pool it needs has no TWAP.
 */
export async function sleeveValueAtTwap(client: PublicClient, read: SafeRead, registry: Registry, twapWindowSeconds: number): Promise<bigint> {
  const pools = usdcPools(registry)
  const twaps = new Map<string, bigint>()
  const sqrtTwap = async (pool: string): Promise<bigint> => {
    let s = twaps.get(pool)
    if (s === undefined) {
      s = sqrtRatioAtTick(await twapTickAt(client, entry(pool, registry).address, twapWindowSeconds, read.block))
      twaps.set(pool, s)
    }
    return s
  }
  let value = 0n
  for (const [token, amount] of Object.entries(read.tokens)) {
    if (amount === 0n) continue
    if (token === 'USDC') {
      value += amount
      continue
    }
    const pool = pools.find((p) => entry(p, registry).token0 === token || entry(p, registry).token1 === token)
    if (!pool) throw new ReasonError('EHG_TWAP_UNAVAILABLE', `no USDC pool prices ${token} on ${registry.chain}`)
    value += inUsdc(pool, token, amount, await sqrtTwap(pool), registry)
  }
  for (const p of read.positions) {
    const s = await sqrtTwap(p.pool)
    const { amount0, amount1 } = amountsForLiquidity(s, p.tickLower, p.tickUpper, p.liquidity)
    value += inUsdc(p.pool, p.token0, amount0 + p.tokensOwed0, s, registry) + inUsdc(p.pool, p.token1, amount1 + p.tokensOwed1, s, registry)
  }
  return value
}

export class MonadBridge {
  private readonly journal: Journal
  private readonly lock = new Lock()

  constructor(
    private readonly stateDir: string,
    /** Base, through the operator's proxy: where the burns are settled from. */
    private readonly base: PublicClient,
    /** Monad (MAMORU_MONAD_RPC_URL): the sleeve reads and the mint. */
    private readonly monad: PublicClient,
    /** The operator's relayer key on Monad. Null: no mint is sent (a used nonce is still marked minted). */
    private readonly relayer: MonadSender | null,
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly baseRegistryOf: Registry = baseRegistry,
    private readonly monadRegistryOf: Registry = monadRegistry,
  ) {
    this.journal = this.load()
  }

  get file(): string {
    return join(this.stateDir, 'bridge-monad.json')
  }

  private load(): Journal {
    const empty: Journal = { burns: {}, mintDays: {}, sleeves: {} }
    if (!existsSync(this.file)) return empty
    // An unreadable journal stops the operator: starting empty would forget burns in flight and bridge them again.
    const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Journal>
    return { burns: j.burns ?? {}, mintDays: j.mintDays ?? {}, sleeves: j.sleeves ?? {} }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.journal, null, 1), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  burns(): BridgeBurn[] {
    return Object.values(this.journal.burns)
  }

  /**
   * The engine's `beforeBridgeSign`: the burn goes on disk as 'sending' before its userOp is signed. Throws (the engine
   * then discards the op unsigned) when it cannot be written, or when the burn is not one this journal can follow.
   */
  recordSending(accountKey: string, b: BridgeSigning): void {
    if (b.chainId !== BRIDGE_MONAD_CHAIN_ID || b.destinationDomain !== CCTP_DOMAIN_MONAD) throw new Error(`bridge to chain ${b.chainId} (domain ${b.destinationDomain}): only Monad is followed`)
    const id = b.userOpHash.toLowerCase() as Hex
    const existing = this.journal.burns[id]
    if (existing) {
      if (existing.accountKey !== accountKey || BigInt(existing.amount) !== b.amount) throw new Error(`userOp ${id} already journaled for another burn`)
      return
    }
    const at = this.iso()
    this.journal.burns[id] = {
      id,
      accountKey,
      account: getAddress(b.account),
      opId: b.opId,
      chainId: b.chainId,
      destinationDomain: b.destinationDomain,
      bucket: b.bucket,
      pool: b.pool,
      amount: b.amount.toString(),
      state: 'sending',
      at,
      updatedAt: at,
      nonceKey: b.nonceKey.toString(),
      nonce: b.nonce.toString(),
      fromBlock: b.prepareBlock.toString(),
    }
    try {
      this.save()
    } catch (e) {
      delete this.journal.burns[id]
      throw e
    }
  }

  /** In flight for the account against a sleeve read at `sleeveBlock` (see inFlightOf). */
  inFlight(accountKey: string, sleeveBlock: bigint): bigint {
    return inFlightOf(this.burns(), accountKey, sleeveBlock)
  }

  /**
   * The engine's `remote` for a v6 account: the sleeve at the TWAP plus in flight, and whether the sleeve is ready.
   * Monad unreadable or no TWAP: the last value read plus in flight, never ready; no value read yet: throws (the review
   * holds rather than size the account without its sleeve).
   */
  async remote(accountKey: string, safe: Address, twapWindowSeconds: number): Promise<{ value: bigint; inFlight: bigint; ready: boolean }> {
    let read: { value: bigint; block: bigint; ready: boolean }
    try {
      read = await this.readSleeve(safe, twapWindowSeconds)
    } catch (e) {
      const last = this.journal.sleeves[accountKey]
      if (!last) throw new ReasonError('OBS_RPC_UNAVAILABLE', `Monad sleeve of ${accountKey} unreadable and never read: ${(e as Error).message?.split('\n')[0] ?? String(e)}`)
      const inFlight = this.inFlight(accountKey, BigInt(last.block))
      return { value: BigInt(last.value) + inFlight, inFlight, ready: false }
    }
    const last = this.journal.sleeves[accountKey]
    if (!last || last.value !== read.value.toString() || BigInt(last.block) < read.block) {
      // Never moved back to an older block: a lagging provider must not make a minted burn look in flight forever.
      if (!last || BigInt(last.block) <= read.block) {
        this.journal.sleeves[accountKey] = { value: read.value.toString(), block: read.block.toString(), at: this.iso() }
        try {
          this.save()
        } catch (e) {
          logErr('[bridge-monad] journal write failed:', e)
        }
      }
    }
    const inFlight = this.inFlight(accountKey, read.block)
    return { value: read.value + inFlight, inFlight, ready: read.ready }
  }

  /** The sleeve's value at the TWAP and its readiness on Monad, at one block. */
  async readSleeve(safe: Address, twapWindowSeconds: number): Promise<{ value: bigint; block: bigint; ready: boolean }> {
    const r = await readSafe(this.monad, safe, this.monadRegistryOf)
    const value = await sleeveValueAtTwap(this.monad, r, this.monadRegistryOf, twapWindowSeconds)
    // Ready: the Safe is deployed on Monad and SmartSession is installed on it. The sleeve's activation installs
    // SmartSession and enables its v5 sessions in the same owner transaction; the permission ids themselves are the Monad
    // operator's and not known here.
    const ready = r.deployed && (await this.monad.readContract({ address: safe, abi: safe7579Abi, functionName: 'isModuleInstalled', args: [1n, address('SmartSession', this.monadRegistryOf), '0x'], blockNumber: r.block }))
    return { value, block: r.block, ready }
  }

  /** The ops view of the burn of a userOp, if it is one. */
  view(userOpHash: Hex | undefined): BridgeView | undefined {
    if (!userOpHash) return undefined
    const b = this.journal.burns[userOpHash.toLowerCase()]
    if (!b) return undefined
    return { chainId: b.chainId, amountUsdc: b.amount, state: b.state === 'dropped' ? 'failed' : b.state }
  }

  /** The account's latest burn not yet minted, for the progress line. */
  pending(accountKey: string): BridgeBurn | undefined {
    return this.burns()
      .filter((b) => b.accountKey === accountKey && IN_FLIGHT.has(b.state))
      .sort((a, b) => b.at.localeCompare(a.at))[0]
  }

  pendingCount(): number {
    return this.burns().filter((b) => IN_FLIGHT.has(b.state)).length
  }

  /** One pass: settle every 'sending' burn from Base, mint every 'burned' one on Monad. Never throws. */
  tick(): Promise<void> {
    return this.lock.run(async () => {
      for (const b of this.burns()) {
        try {
          if (b.state === 'sending') await this.settleSending(b)
          if (b.state === 'burned') await this.mint(b)
        } catch (e) {
          logErr(`[bridge-monad] ${b.account.slice(0, 10)} ${b.id.slice(0, 10)}:`, e)
        }
      }
      this.prune()
    })
  }

  private update(b: BridgeBurn, patch: Partial<BridgeBurn>): void {
    Object.assign(b, patch, { updatedAt: this.iso() })
    this.save()
  }

  private prune(): void {
    const cut = this.now() - MINTED_KEEP_MS
    let changed = false
    for (const [id, b] of Object.entries(this.journal.burns)) {
      if ((b.state === 'minted' || b.state === 'failed' || b.state === 'dropped') && Date.parse(b.updatedAt) < cut) {
        delete this.journal.burns[id]
        changed = true
      }
    }
    if (changed) this.save()
  }

  /**
   * A burn written before its userOp was signed, settled only from Base at its `safe` block: its UserOperationEvent up
   * to `safe` (a success with exactly this burn: 'burned'; a revert: 'failed', nothing burned), or the nonce at `safe`
   * past its own without the event ('dropped': it can never land). Anything else stays in flight.
   */
  async settleSending(b: BridgeBurn): Promise<void> {
    const safe = await this.base.getBlock({ blockTag: 'safe' })
    const from = BigInt(b.fromBlock)
    if (safe.number < from) return
    const logs = await this.base.getLogs({ address: address('EntryPointV07', this.baseRegistryOf), event: userOperationEvent, args: { userOpHash: b.id }, fromBlock: from, toBlock: safe.number })
    if (logs.length === 0) {
      const nonceAtSafe = await this.base.readContract({ address: address('EntryPointV07', this.baseRegistryOf), abi: entryPointV07Abi, functionName: 'getNonce', args: [b.account, BigInt(b.nonceKey)], blockNumber: safe.number })
      if (nonceAtSafe > BigInt(b.nonce)) this.update(b, { state: 'dropped', note: `nonce ${b.nonce} spent at safe block ${safe.number} without this userOp: nothing burned` })
      return
    }
    const ev = await readUserOpEvent(this.base, b.id, from, this.baseRegistryOf)
    if (!ev || ev.blockNumber > safe.number) return
    if (!isAddressEqual(ev.sender, b.account) || ev.nonce !== BigInt(b.nonce)) throw new Error(`UserOperationEvent of ${ev.sender} nonce ${ev.nonce} for this burn's hash`)
    if (!ev.success) return void this.update(b, { state: 'failed', txHash: ev.txHash, note: 'the userOp reverted: nothing burned' })
    const burn = burnOf(ev.logs, b, this.baseRegistryOf)
    if (!burn) {
      // Landed, but not as this burn: kept in flight (never under-counted) until someone looks.
      if (!b.note) this.update(b, { note: `landed in ${ev.txHash} without exactly this burn; kept in flight` })
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, `userOp ${b.id.slice(0, 10)} landed without exactly this burn; kept in flight`)
      return
    }
    this.update(b, { state: 'burned', txHash: ev.txHash, burnBlock: ev.blockNumber.toString(), burnedAt: this.iso(), messageKey: cctpMessageKey(burn.message) })
  }

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10)
  }

  private mintDay(day: string): { n: number; wei: string } {
    return this.journal.mintDays[day] ?? { n: 0, wei: '0' }
  }

  private setMintDay(day: string, m: { n: number; wei: bigint }): void {
    // Only the last week is kept.
    for (const d of Object.keys(this.journal.mintDays)) if (d < new Date(this.now() - 7 * 86_400_000).toISOString().slice(0, 10)) delete this.journal.mintDays[d]
    this.journal.mintDays[day] = { n: m.n, wei: m.wei.toString() }
    this.save()
  }

  /**
   * A burned transfer, minted on Monad: Circle's attestation (source Base), checked to be this burn and signed by the
   * attesters enabled on Monad; a nonce already used is marked minted with no transaction; otherwise receiveMessage
   * from the relayer within the gas ceiling and the day's budget, its hash on disk before the broadcast.
   */
  async mint(b: BridgeBurn): Promise<void> {
    if (!b.txHash || !b.messageKey) return
    if (b.mintTx) {
      const rc = await this.monad.getTransactionReceipt({ hash: b.mintTx }).catch(() => null)
      if (rc?.status === 'success') return void this.update(b, { state: 'minted', mintedBlock: rc.blockNumber.toString() })
      // No receipt yet: pending, unless it was signed and never broadcast. After MONAD_MINT_PENDING_MS the attempt below
      // runs again: the used-nonce check stops it if the first landed; a first landing after it makes the second revert.
      if (!rc && this.now() - Date.parse(b.mintAt ?? b.updatedAt) < MONAD_MINT_PENDING_MS) return
      this.update(b, { mintTx: undefined })
    }
    const now = this.now()
    if (now - Date.parse(b.burnedAt ?? b.updatedAt) < ATTEST_FIRST_POLL_MS) return
    if (b.attestPolledAt && now - Date.parse(b.attestPolledAt) < ATTEST_POLL_MS) return
    const atts = await cctpAttestation(b.txHash, this.fetcher, CCTP_DOMAIN_BASE)
    b.attestPolledAt = this.iso()
    if (!atts) return
    const amount = BigInt(b.amount)
    const att = atts.find((a) => {
      try {
        return cctpMessageKey(a.message) === b.messageKey && mintIsFor(decodeCctpMessage(a.message), BASE_USDC, b.account, amount, { source: CCTP_DOMAIN_BASE, destination: CCTP_DOMAIN_MONAD })
      } catch {
        return false
      }
    })
    if (!att) {
      if (atts.length > 0) logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, `no attested message is this burn (${atts.length} complete), not minted`)
      return
    }
    const msg = decodeCctpMessage(att.message)
    // Iris is not trusted: only an attestation signed by the attesters enabled on Monad makes its nonce mean anything.
    if (BigInt(msg.nonce) === 0n || !(await attestationValid(this.monad, att.message, att.attestation))) {
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, 'attestation not signed by the attesters enabled on Monad, ignored')
      return
    }
    // A CCTP nonce another burn of this journal already has is never this one's.
    if (this.burns().some((o) => o !== b && o.cctpNonce?.toLowerCase() === msg.nonce.toLowerCase())) {
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, 'attestation of another burn, ignored')
      return
    }
    const block = await this.monad.getBlockNumber()
    const used = await this.monad.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'usedNonces', args: [msg.nonce], blockNumber: block })
    if (used !== 0n) return void this.update(b, { state: 'minted', cctpNonce: msg.nonce, mintedBlock: block.toString(), note: b.mintTx ? b.note : 'minted by someone else (any caller may)' })
    if (!this.relayer) return
    const data = receiveMessageData(att.message, att.attestation)
    const relayer = this.relayer
    const est = await this.monad.estimateGas({ account: relayer.address, to: MESSAGE_TRANSMITTER_V2, data })
    const gas = (est * 11n) / 10n
    if (gas > MONAD_MINT_GAS_CAP) {
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, `receiveMessage estimated at ${est} gas, over the ${MONAD_MINT_GAS_CAP} cap; not minted`)
      return
    }
    const price = await this.monad.getGasPrice()
    if (price > MAX_MONAD_GAS_PRICE_WEI) {
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, 'Monad gas above the mint ceiling, minting later')
      return
    }
    const day = this.day()
    const estimate = gas * price * 2n
    const m = this.mintDay(day)
    if (m.n >= MONAD_MINTS_PER_DAY || BigInt(m.wei) + estimate > MONAD_MINT_BUDGET_WEI) {
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, 'Monad mint budget for today used up, minting tomorrow')
      return
    }
    const balance = await this.monad.getBalance({ address: relayer.address })
    if (balance < estimate) {
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, `relayer ${relayer.address} has ${balance} wei MON, a mint needs up to ${estimate}: fund it`)
      return
    }
    let charged = 0n
    const charge = (wei: bigint, dn = 0) => {
      const cur = this.mintDay(day)
      const next = BigInt(cur.wei) - charged + wei
      this.setMintDay(day, { n: cur.n + dn, wei: next > 0n ? next : 0n })
      charged = wei
    }
    charge(estimate, 1)
    let signed = false
    let sent: { hash: Hex; receipt: TransactionReceipt }
    try {
      sent = await relayer.send(
        { to: MESSAGE_TRANSMITTER_V2, data, gas },
        undefined,
        (maxFeeWei, { maxFeePerGas }) => {
          charge(maxFeeWei)
          if (BigInt(this.mintDay(day).wei) > MONAD_MINT_BUDGET_WEI) throw new MintBudget('Monad mint budget for today used up, minting tomorrow')
          if (maxFeePerGas > MAX_MONAD_GAS_PRICE_WEI) throw new MintBudget('Monad gas above the mint ceiling, minting later')
        },
        (h) => {
          // The mint's hash (and the CCTP nonce it mints) is on disk before the broadcast.
          signed = true
          this.update(b, { mintTx: h, mintAt: this.iso(), cctpNonce: msg.nonce })
        },
      )
    } catch (e) {
      if (!signed) charge(0n, -1)
      if (e instanceof MintBudget) {
        logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, e.message)
        return
      }
      throw e
    }
    // Monad charges the gas limit: the limit at the price paid.
    charge(gas * sent.receipt.effectiveGasPrice)
    if (sent.receipt.status === 'success') this.update(b, { state: 'minted', mintTx: sent.hash, mintedBlock: sent.receipt.blockNumber.toString() })
    else this.update(b, { mintTx: sent.hash, note: `receiveMessage ${sent.hash} reverted; tried again after the used-nonce check` })
  }
}

/** The one DepositForBurn of this burn in a userOp's logs, and the MessageSent next to it; null unless exactly that. */
export function burnOf(logs: Log[], b: Pick<BridgeBurn, 'account' | 'amount' | 'destinationDomain'>, registry: Registry = baseRegistry): { message: Hex } | null {
  const messenger = address('TokenMessengerV2', registry)
  const burns = parseEventLogs({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', logs: logs.filter((l) => isAddressEqual(l.address, messenger)) })
  const sent = parseEventLogs({ abi: messageTransmitterV2Abi, eventName: 'MessageSent', logs: logs.filter((l) => isAddressEqual(l.address, MESSAGE_TRANSMITTER_V2)) })
  if (burns.length !== 1 || sent.length !== 1) return null
  const a = burns[0]!.args
  const ok =
    isAddressEqual(a.burnToken, address('USDC', registry)) &&
    isAddressEqual(a.depositor, b.account) &&
    a.amount === BigInt(b.amount) &&
    a.mintRecipient.toLowerCase() === pad(b.account, { size: 32 }).toLowerCase() &&
    a.destinationDomain === b.destinationDomain &&
    BigInt(a.destinationCaller) === 0n &&
    a.maxFee === 0n &&
    a.minFinalityThreshold >= 2000 &&
    a.hookData === '0x'
  return ok ? { message: sent[0]!.args.message } : null
}
