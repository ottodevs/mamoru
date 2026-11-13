import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAddress, isAddressEqual, pad, parseAbiItem, parseEventLogs, type Hex, type Log, type PublicClient, type TransactionReceipt } from 'viem'
import { ReasonError, type Address, type BridgeProgress, type BridgeStuckReason, type MoneyChain, type MoneyInFlight } from '@mamoru/domain'
import { DEFAULT_BRIDGE_STUCK_AFTER_MIN, type BridgeStuckAfterMin } from '@mamoru/policy'
import { address, baseRegistry, entry, entryPointV07Abi, messageTransmitterV2Abi, monadRegistry, safe7579Abi, smartSessionAbi, tokenMessengerV2Abi, type Registry } from '@mamoru/registry'
import { userOpLogs } from '@mamoru/rpc'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { twapTickAt } from '@mamoru/uniswap-v3/twap'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import { amountsForLiquidity, inUsdc, readSafe, usdcPools, type SafeRead } from './chain.ts'
import { chainLegOf, etaOf, heldAboveDust, unreadLeg } from './money-map.ts'
import { attestationValid, CCTP_DOMAIN_BASE, CCTP_DOMAIN_MONAD, cctpAttestation, cctpMessageKey, decodeCctpMessage, MESSAGE_TRANSMITTER_V2, mintIsFor, receiveMessageData } from './cctp.ts'
import { Lock } from './lock.ts'
import { logErr, redactSecrets, RELAYER_READ_MS, RelayerWatch, type RelayerBalance } from './metrics.ts'

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
// - the value of the account's own Safe on Monad (otto/mamoru#251: its own address, fixed by its approval), at the TWAP
//   of each pool it holds (never slot0), plus in flight; `ready` when that Safe has code on Monad, SmartSession is
//   installed on it and every session its setup committed to is enabled;
// - the mint: Circle's attestation for source domain 6 (Base) and the burn's Base transaction, checked to be this
//   burn (message key, Base to Monad, the account as sender, its own Safe on Monad as recipient, the amount) and signed by the attesters
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
/** Review of #144: a mint that reverted is tried again only after MONAD_MINT_PENDING_MS doubled per revert, at most this many times. */
export const MONAD_MINT_MAX_REVERTS = 3
/** Review of #144: blocks of Base one settle eth_getLogs covers at most (the RPC proxy splits it further when a provider needs it). */
export const SETTLE_LOG_CHUNK = 2_000n
/** Review of #144: chunks one settle pass reads at most; the cursor on disk (`scanFrom`) resumes from there on the next tick. */
export const SETTLE_CHUNKS_PER_TICK = 5
/** Review round 2 of #144: after a bridge-out fails the sleeve reads not ready this long, doubling per failure in a row up to the cap. */
export const BRIDGE_FAIL_COOLDOWN_MS = 30 * 60_000
export const BRIDGE_FAIL_COOLDOWN_MAX_MS = 24 * 3600_000
/** Minted burns are kept this long for the ops history, then pruned. */
/** A failed on-chain check of a burn is not asked again for this long. */
export const SETTLE_FAIL_TTL_MS = 5_000
/**
 * otto/mamoru#269: a read of a Monad Safe for the money map is given up after this long (funding never waits on a dead
 * RPC). Measured from lady against the public Monad RPCs, a readSafe takes 80-200 ms warm and ~360 ms cold (1-2 round
 * trips); 5 s is ~14x the worst cold sample, so a slow but live provider passes. Only one read of a Safe is ever running:
 * a hung one is not restarted by later polls.
 */
export const MONAD_LEG_TIMEOUT_MS = 5_000
export const MINTED_KEEP_MS = 30 * 24 * 3600_000
/** Native USDC on Base: the token the session burns (the message's burnToken). */
export const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

export type BridgeBurnState = 'sending' | 'burned' | 'minted' | 'failed' | 'dropped'

export type BridgeBurn = {
  /** The userOp hash: one burn per signed userOp. */
  id: Hex
  accountKey: string
  account: Address
  /** otto/mamoru#251: the account's own Safe on Monad, the burn's mint recipient (the bridge-out grant allows no other). */
  recipient: Address
  /** otto/mamoru#293: the burn's depositor and CCTP message sender when it is not `account` (V4); absent = `account`. */
  depositor?: Address
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
  /** Review of #144: the first Base block not yet known to be without this userOp's event (the settle cursor). */
  scanFrom?: string
  txHash?: Hex
  burnBlock?: string
  /**
   * otto/mamoru#376: the Base block a failed burn's userOp was included in (its execution reverted, nothing burned, but
   * session policies count at validation, so the grant's cumulative total was charged there).
   */
  failedBlock?: string
  burnedAt?: string
  /** cctpMessageKey of the MessageSent the burn emitted: the attested message must have the same. */
  messageKey?: Hex
  /** The attested CCTP nonce, once known. */
  cctpNonce?: Hex
  attestPolledAt?: string
  /** otto/mamoru#269: when Circle's attestation of this burn was first seen complete (and checked to be this burn). */
  attestedAt?: string
  mintTx?: Hex
  mintAt?: string
  /** Review of #144: how many receiveMessage of this burn reverted; each waits longer, and past MONAD_MINT_MAX_REVERTS none is sent. */
  mintReverts?: number
  /** Monad block at (or before) which the mint is known on chain: a sleeve read at an earlier block still counts it in flight. */
  mintedBlock?: string
  note?: string
  /** otto/mamoru#245: when the burn passed its state's deadline (engine setting bridge.stuckAfterMin); cleared by any state change. */
  stuckAt?: string
  /** otto/mamoru#245: what holds it, a fixed code (the latest seen while stuck). */
  stuckReason?: BridgeStuckReason
  /**
   * otto/mamoru#245: when ops was paged about it, per state. Never cleared: one alert per (burn, state), across restarts.
   * A journal written before it was per state holds a string: read as paged for the state the burn was then in.
   */
  stuckAlertedAt?: { sending?: string; burned?: string }
}

type Journal = {
  burns: Record<string, BridgeBurn>
  mintDays: Record<string, { n: number; wei: string }>
  /** Last sleeve value read per account (raw USDC, without in flight), and its Monad block. */
  sleeves: Record<string, { value: string; block: string; at: string; safe?: string; /** otto/mamoru#401: the Safe's own USDC at that read, and since when (unix s) it has stayed at or above the return threshold. */ idle?: string; idleSince?: number }>
  /** Review round 2 of #144: per account, bridge-outs that failed in a row and until when the sleeve reads not ready. */
  cooldowns: Record<string, { failures: number; until: string; code: string }>
  /** otto/mamoru#269: the last good display total of each remote Safe (slot0, as funding shows it), by `${key}@${safe}`: what the money map falls back to, flagged stale, when Monad cannot be read. */
  shown: Record<string, { totalUsdc: string; block: string; at: string }>
  /** otto/mamoru#269: every Safe a burn of the account went to, kept until a read shows it empty (not pruned with the burns). */
  pastRecipients: Record<string, Address[]>
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
 * `settled`: burns the caller checked on chain to be outside in flight at these reads (not left Base yet at the local
 * read, or minted at or before the sleeve's block).
 */
export function inFlightOf(burns: readonly BridgeBurn[], accountKey: string, sleeveBlock: bigint, settled: ReadonlySet<string> = new Set()): bigint {
  return inFlightBurns(burns, accountKey, sleeveBlock, settled).reduce((sum, b) => sum + BigInt(b.amount), 0n)
}

/** The burns inFlightOf counts, one by one: the single rule behind both the engine's remote value and the money map (otto/mamoru#269). */
export function inFlightBurns(burns: readonly BridgeBurn[], accountKey: string, sleeveBlock: bigint | ((b: BridgeBurn) => bigint), settled: ReadonlySet<string> = new Set()): BridgeBurn[] {
  const at = (b: BridgeBurn) => (typeof sleeveBlock === 'function' ? sleeveBlock(b) : sleeveBlock)
  return burns.filter((b) => b.accountKey === accountKey && !settled.has(b.id) && (IN_FLIGHT.has(b.state) || (b.state === 'minted' && (b.mintedBlock === undefined || BigInt(b.mintedBlock) > at(b)))))
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
    /**
     * Review of #144: set when the Monad RPC could not be checked at boot (unreachable). Until it passes nothing is read
     * from or sent to Monad (remote falls back to the last value, no mint); a wrong chain keeps it failing for good.
     */
    private readonly verify?: () => Promise<void>,
  ) {
    this.journal = this.load()
    this.verified = !verify
  }

  private verified: boolean
  /** Burns recorded by this process and not signed since: only those may be discarded as never signed. */
  private readonly unsigned = new Set<string>()
  /**
   * otto/mamoru#245: the stuck deadlines of an account, from its engine settings. Set by boot once the settings source
   * exists; the code defaults until then and without one.
   */
  stuckAfterOf: (accountKey: string) => BridgeStuckAfterMin = () => DEFAULT_BRIDGE_STUCK_AFTER_MIN
  /** otto/mamoru#245: per burn, what stopped the last mint pass (memory only: the next pass sees it again). */
  private readonly blockers = new Map<string, BridgeStuckReason>()
  /** otto/mamoru#245: the relayer's MON on Monad from the last mint's balance check (for /metrics; no read of its own). */
  private relayerMon: { wei: bigint; at: string } | null = null
  /** otto/mamoru#277: the relayer's balance on a timer (not only before a mint), its low-balance page, and the last Monad gas price read. */
  private readonly relayerWatch = new RelayerWatch()
  private relayerReadAt = 0
  private lastGasPrice: bigint | null = null

  /**
   * otto/mamoru#277: reads the Monad relayer's MON at most every RELAYER_READ_MS, so the figure is fresh with no mint
   * pending, and pages once when it is under two mints (MONAD_MINT_GAS_CAP gas at twice the gas price, the mint's own
   * estimate shape, doubled). A failed read keeps the last value; nothing throws into the tick.
   */
  async tickRelayer(): Promise<void> {
    const relayer = this.relayer
    if (!relayer || this.now() - this.relayerReadAt < RELAYER_READ_MS) return
    this.relayerReadAt = this.now()
    try {
      if (!(await this.monadVerified())) return
      const wei = await this.monad.getBalance({ address: relayer.address })
      const read = await this.monad.getGasPrice().catch(() => 0n)
      if (read > 0n) this.lastGasPrice = read
      const price = this.lastGasPrice
      this.relayerMon = { wei, at: this.iso() }
      // No price ever read: the balance is shown by relayerMon and nothing is judged on a guess.
      if (price === null) return
      this.relayerWatch.observe('bridge_monad', this.monadRegistryOf.chainId, relayer.address, wei, 2n * (MONAD_MINT_GAS_CAP * price * 2n), 'mints', this.iso())
    } catch (e) {
      logErr('[bridge-monad] relayer balance not read, last value kept:', e)
    }
  }

  /** otto/mamoru#277: the Monad relayer's balance as last read, for /metrics `relayers`. */
  relayers(): RelayerBalance[] {
    const e = this.relayerWatch.last()
    return e ? [e] : []
  }

  /** Whether Monad is the checked chain; runs the boot check again while it is not. */
  private async monadVerified(): Promise<boolean> {
    if (this.verified) return true
    try {
      await this.verify!()
      this.verified = true
      console.log('[bridge-monad] Monad RPC checked: the bridge leg reads and mints on Monad from now on')
    } catch (e) {
      logErr('[bridge-monad] Monad RPC still not checked, nothing read or sent there:', e)
    }
    return this.verified
  }

  get file(): string {
    return join(this.stateDir, 'bridge-monad.json')
  }

  private load(): Journal {
    const empty: Journal = { burns: {}, mintDays: {}, sleeves: {}, cooldowns: {}, shown: {}, pastRecipients: {} }
    if (!existsSync(this.file)) return empty
    // An unreadable journal stops the operator: starting empty would forget burns in flight and bridge them again.
    const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Journal>
    const past: Record<string, Address[]> = { ...(j.pastRecipients ?? {}) }
    // A journal from before pastRecipients (the field is absent): its burns' recipients are seeded once. Never again: a
    // recipient released since would come back with every restart while its old burns are still journaled.
    if (j.pastRecipients === undefined) {
      // Also every Safe the engine ever recorded a sleeve for (its account is the key before any '#'): a rotated Safe whose
      // burns were pruned long ago is still known there.
      for (const [k, e] of Object.entries(j.sleeves ?? {})) {
        if (!e.safe) continue
        const list = (past[k.split('#')[0]!] ??= [])
        if (!list.some((a) => a.toLowerCase() === e.safe!.toLowerCase())) list.push(getAddress(e.safe))
      }
    }
    for (const b of j.pastRecipients === undefined ? Object.values(j.burns ?? {}) : []) {
      if (b.state === 'failed' || b.state === 'dropped') continue
      const list = (past[b.accountKey] ??= [])
      if (!list.some((a) => a.toLowerCase() === b.recipient.toLowerCase())) list.push(b.recipient)
    }
    // otto/mamoru#245: a stuckAlertedAt from before it was per state counts as paged for the state the burn is in.
    for (const b of Object.values(j.burns ?? {})) {
      const was = b.stuckAlertedAt as unknown
      if (typeof was === 'string') b.stuckAlertedAt = b.state === 'sending' ? { sending: was } : { burned: was }
      else if (was !== undefined && (was === null || typeof was !== 'object')) delete b.stuckAlertedAt
    }
    return { burns: j.burns ?? {}, mintDays: j.mintDays ?? {}, sleeves: j.sleeves ?? {}, cooldowns: j.cooldowns ?? {}, shown: j.shown ?? {}, pastRecipients: past }
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
      // Recorded before (an earlier attempt or process): it may have been signed then, so it is never discarded as unsigned.
      this.unsigned.delete(id)
      // Review round 2: a dropped entry signed again (e.g. after a signing failure) is a live burn once more: back to
      // 'sending', on disk before this returns, so it is counted and settled. A dropped one whose nonce is spent is
      // dropped again by the chain settlement; nothing is lost by restoring it.
      if (existing.state === 'dropped') {
        const before = { ...existing }
        Object.assign(existing, { state: 'sending', updatedAt: this.iso(), note: `signed again after: ${existing.note ?? 'dropped'}` })
        try {
          this.save()
        } catch (e) {
          Object.assign(existing, before)
          throw e
        }
        // A dropped entry has no bytes that can land (never signed, or its nonce spent): this attempt is the first signing.
        this.unsigned.add(id)
      }
      return
    }
    const at = this.iso()
    this.journal.burns[id] = {
      id,
      accountKey,
      account: getAddress(b.account),
      recipient: getAddress(b.recipient),
      ...(isAddressEqual(b.depositor, b.account) ? {} : { depositor: getAddress(b.depositor) }),
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
    const kept = this.journal.pastRecipients[accountKey]
    const hadRecipient = !!kept?.some((a) => a.toLowerCase() === b.recipient.toLowerCase())
    if (!hadRecipient) this.journal.pastRecipients[accountKey] = [...(kept ?? []), getAddress(b.recipient)]
    try {
      this.save()
    } catch (e) {
      delete this.journal.burns[id]
      if (!hadRecipient) {
        if (kept) this.journal.pastRecipients[accountKey] = kept
        else delete this.journal.pastRecipients[accountKey]
      }
      throw e
    }
    this.unsigned.add(id)
  }

  /**
   * Review of #144: the engine's `bridgeUnsigned`. A burn this process recorded whose signing then failed has no signed
   * bytes anywhere, so it can never burn: 'dropped', out of flight. Any other burn is left to the chain to settle.
   */
  discardUnsigned(userOpHash: Hex): void {
    const id = userOpHash.toLowerCase()
    const b = this.journal.burns[id]
    if (!b || b.state !== 'sending' || !this.unsigned.has(id)) return
    this.unsigned.delete(id)
    this.update(b, { state: 'dropped', note: 'never signed: nothing can burn' })
  }

  /** In flight for the account against a sleeve read at `sleeveBlock` (see inFlightOf). */
  inFlight(accountKey: string, sleeveBlock: bigint, settled?: ReadonlySet<string>): bigint {
    return inFlightOf(this.burns(), accountKey, sleeveBlock, settled)
  }

  /**
   * otto/mamoru#332: what a cap counts of the burns that left the Base Safes `sources`, raw USDC. A burn belongs to the
   * Safe its USDC left (`account`: under V4 too, V4 pulls the amount from it before it burns), never to an account key:
   * a Safe's burns are then counted once wherever that Safe is counted, whether or not an account here still names it.
   * Every burn that is not failed or dropped counts until a read of its recipient used in the same total
   * (`readAt(recipient)`: the Monad block of that read, undefined when the total holds none) is at or after its
   * mintedBlock. A minted burn without mintedBlock (old entries: `tick` backfills it from the mint's receipt) counts
   * until pruned. A burn to a Safe no total reads keeps counting until pruned: its money is counted nowhere else. A
   * 'sending' burn may still be in the Base Safe too (counted twice: the cap only places less). No chain read here.
   */
  capUsdc(sources: readonly string[], readAt: (recipient: Address) => bigint | undefined): bigint {
    const from = new Set(sources.map((a) => a.toLowerCase()))
    let sum = 0n
    for (const b of this.burns()) {
      if (!from.has(b.account.toLowerCase())) continue
      if (IN_FLIGHT.has(b.state)) sum += BigInt(b.amount)
      else if (b.state === 'minted') {
        const at = readAt(b.recipient)
        if (b.mintedBlock === undefined || at === undefined || BigInt(b.mintedBlock) > at) sum += BigInt(b.amount)
      }
    }
    return sum
  }

  /**
   * otto/mamoru#332: a burn minted before mintedBlock was recorded (old entries) gets it from its mint's receipt on Monad,
   * so the cap stops counting it at the first read that holds the mint. Without a mint hash, or while the receipt cannot
   * be read, it keeps counting (until pruned). `updatedAt` is left as it was: the prune's age is unchanged.
   */
  private async backfillMinted(b: BridgeBurn): Promise<void> {
    if (b.state !== 'minted' || b.mintedBlock !== undefined || !b.mintTx) return
    const rc = await this.monad.getTransactionReceipt({ hash: b.mintTx }).catch(() => null)
    if (rc?.status !== 'success') return
    b.mintedBlock = rc.blockNumber.toString()
    this.save()
  }

  /**
   * Review of #144: the burns of the account that inFlightOf would count but the chain shows are already in one of the
   * two reads. A 'sending' burn whose EntryPoint nonce is unmoved at `baseBlock` has not landed there: its USDC is still
   * in the local balances read at that block. A burn minted at a block the journal only bounds from above (a mint by
   * someone else is seen at the head) whose CCTP nonce is already used at the sleeve's block: its USDC is in that read.
   * A read that fails leaves the burn counted (never under the real value) and `unsure` set: the value may then count it
   * twice, so the caller reports the sleeve not ready and no bridge is sized on it (review round 2 of #144).
   */
  private async settledAt(accountKey: string, baseBlock: bigint | undefined, sleeveBlock: bigint | undefined): Promise<Set<string> & { unsure?: boolean }> {
    const out: Set<string> & { unsure?: boolean } = new Set<string>()
    for (const b of this.burns()) {
      if (b.accountKey !== accountKey) continue
      try {
        if (b.state === 'sending' && baseBlock !== undefined) {
          const nonce = await this.base.readContract({ address: address('EntryPointV07', this.baseRegistryOf), abi: entryPointV07Abi, functionName: 'getNonce', args: [b.account, BigInt(b.nonceKey)], blockNumber: baseBlock })
          if (nonce <= BigInt(b.nonce)) out.add(b.id)
        } else if (b.state === 'minted' && sleeveBlock !== undefined && b.cctpNonce && b.mintedBlock !== undefined && BigInt(b.mintedBlock) > sleeveBlock) {
          const used = await this.monad.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'usedNonces', args: [b.cctpNonce], blockNumber: sleeveBlock })
          if (used !== 0n) out.add(b.id)
        }
      } catch {
        // Counted in flight, and the result is not trusted for a bridge.
        out.unsure = true
      }
    }
    return out
  }

  /**
   * The engine's `remote` for a v6 account: the sleeve at the TWAP plus in flight, and whether the sleeve is ready.
   * Monad unreadable or no TWAP: the last value read plus in flight, never ready; no value read yet: throws (the review
   * holds rather than size the account without its sleeve). A read from a block older than the last one recorded (a
   * lagging provider) is not used: the last one is. `baseBlock`: the block the engine read the local balances at.
   */
  async remote(accountKey: string, safe: Address, twapWindowSeconds: number, baseBlock?: bigint, permissionIds: readonly Hex[] = [], idleMin?: (value: bigint) => bigint): Promise<{ value: bigint; inFlight: bigint; ready: boolean; idle?: bigint; idleSince?: number; idleThreshold?: bigint }> {
    const stored = this.journal.sleeves[accountKey]
    // otto/mamoru#401 (review r2): what the journal holds is of one Safe. Another Safe under the same key (a new remote, a
    // move) never inherits its value, its idle or its clock. An entry from before `safe` was recorded counts as this one.
    const last = stored && (stored.safe === undefined || stored.safe === safe.toLowerCase()) ? stored : undefined
    const sameSafe = stored?.safe !== undefined && stored.safe === safe.toLowerCase()
    let read: { value: bigint; block: bigint; ready: boolean; idle: bigint }
    try {
      if (!(await this.monadVerified())) throw new Error('Monad RPC not checked yet')
      read = await this.readSleeve(safe, twapWindowSeconds, permissionIds)
    } catch (e) {
      // The provider's error may quote its keyed URL: redacted before it reaches the engine's journal.
      if (!last) throw new ReasonError('OBS_RPC_UNAVAILABLE', `Monad sleeve of ${accountKey} unreadable and never read: ${redactSecrets((e as Error).message?.split('\n')[0] ?? String(e))}`)
      const settled = await this.settledAt(accountKey, baseBlock, undefined)
      const inFlight = this.inFlight(accountKey, BigInt(last.block), settled)
      return { value: BigInt(last.value) + inFlight, inFlight, ready: false }
    }
    read = { ...read, idle: read.idle ?? 0n }
    const lagging = !!last && BigInt(last.block) > read.block
    // A lagging provider: its older read could miss a mint the journal already places at or before the last block (same Safe only).
    if (lagging) read = { value: BigInt(last!.value), block: BigInt(last!.block), ready: read.ready, idle: sameSafe ? BigInt(last!.idle ?? '0') : 0n }
    const settled = await this.settledAt(accountKey, baseBlock, read.block)
    const inFlight = this.inFlight(accountKey, read.block, settled)
    // otto/mamoru#401 (spec 012 HRV-R4, review r2): the idle clock runs only while the Safe's own USDC is above the return
    // threshold the caller gives for this sleeve value (the same one decide then judges against, `idleThreshold`), and
    // starts again whenever a read finds it at or below. Kept across restarts; a lagging read does not move it.
    const threshold = idleMin?.(read.value + inFlight)
    let idleSince = sameSafe ? stored?.idleSince : undefined
    if (!lagging) {
      idleSince = threshold !== undefined && read.idle > threshold ? (idleSince ?? Math.floor(this.now() / 1000)) : undefined
      if (!stored || !sameSafe || stored.value !== read.value.toString() || BigInt(stored.block) < read.block || stored.idle !== read.idle.toString() || stored.idleSince !== idleSince) {
        this.journal.sleeves[accountKey] = { value: read.value.toString(), block: read.block.toString(), at: this.iso(), safe: safe.toLowerCase(), idle: read.idle.toString(), ...(idleSince !== undefined ? { idleSince } : {}) }
        try {
          this.save()
        } catch (e) {
          logErr('[bridge-monad] journal write failed:', e)
        }
      }
    } else if (threshold !== undefined && read.idle <= threshold) idleSince = undefined
    // `idle` only when a threshold was given (the caller's policy reads it); `idleSince` only while above it.
    return { value: read.value + inFlight, inFlight, ready: read.ready && !settled.unsure && !this.coolingDown(accountKey), ...(threshold !== undefined ? { idle: read.idle, idleThreshold: threshold, ...(idleSince !== undefined ? { idleSince } : {}) } : {}) }
  }

  /** Whether a recent bridge-out failure of the account still holds bridging (its sleeve reads not ready). */
  private coolingDown(accountKey: string): boolean {
    const c = this.journal.cooldowns[accountKey]
    return !!c && Date.parse(c.until) > this.now()
  }

  /**
   * Review round 2 of #144 (raised on #143): the engine's `bridgeFailed`. A bridge-out that failed (refused, precheck,
   * simulation, revert) holds bridging for BRIDGE_FAIL_COOLDOWN_MS, doubling per failure in a row up to the cap, on disk:
   * the sleeve reads not ready, so decide takes the local entries instead of proposing the same failing bridge every
   * review. A burn that lands clears it.
   */
  bridgeFailed(accountKey: string, code: string): void {
    const failures = (this.journal.cooldowns[accountKey]?.failures ?? 0) + 1
    const wait = Math.min(BRIDGE_FAIL_COOLDOWN_MS * 2 ** (failures - 1), BRIDGE_FAIL_COOLDOWN_MAX_MS)
    this.journal.cooldowns[accountKey] = { failures, until: new Date(this.now() + wait).toISOString(), code }
    try {
      this.save()
    } catch (e) {
      logErr('[bridge-monad] journal write failed (cooldown kept in memory):', e)
    }
    logErr(`[bridge-monad] ${accountKey}:`, `bridge-out failed (${code}); bridging held for ${Math.round(wait / 60_000)} min`)
  }

  /** The sleeve's value at the TWAP and its readiness on Monad, at one block. */
  async readSleeve(safe: Address, twapWindowSeconds: number, permissionIds: readonly Hex[]): Promise<{ value: bigint; block: bigint; ready: boolean; idle: bigint }> {
    const r = await readSafe(this.monad, safe, this.monadRegistryOf)
    const value = await sleeveValueAtTwap(this.monad, r, this.monadRegistryOf, twapWindowSeconds)
    // Ready (otto/mamoru#251): the Safe is deployed on Monad, SmartSession is installed on it, and every session its setup
    // committed to (`permissionIds`, from the approval) is enabled: nothing is bridged to a Safe that could not use it.
    const smartSession = address('SmartSession', this.monadRegistryOf)
    let ready = permissionIds.length > 0 && r.deployed && (await this.monad.readContract({ address: safe, abi: safe7579Abi, functionName: 'isModuleInstalled', args: [1n, smartSession, '0x'], blockNumber: r.block }))
    for (const id of permissionIds) {
      if (!ready) break
      ready = await this.monad.readContract({ address: smartSession, abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [id, safe], blockNumber: r.block })
    }
    return { value, block: r.block, ready, idle: r.tokens.USDC ?? 0n }
  }

  /** The ops view of the burn of a userOp, if it is one. */
  view(userOpHash: Hex | undefined): BridgeView | undefined {
    if (!userOpHash) return undefined
    const b = this.journal.burns[userOpHash.toLowerCase()]
    if (!b) return undefined
    return { chainId: b.chainId, amountUsdc: b.amount, state: b.state === 'dropped' ? 'failed' : b.state, ...this.trail(b) }
  }

  /**
   * otto/mamoru#269: what the journal knows of a burn beyond its state (all optional): the burn's transaction and time,
   * the attestation, the mint, the receiving Safe and, while burned, the arrival window (burnedAt + 13..19 min) with
   * `late` once past it. A minted burn's time is when the journal saw it minted.
   */
  private trail(b: BridgeBurn): Omit<BridgeProgress, 'chainId' | 'amountUsdc' | 'state'> {
    return {
      ...(b.txHash ? { burnTx: b.txHash } : {}),
      ...(b.burnedAt ? { burnedAt: b.burnedAt } : {}),
      ...(b.attestedAt ? { attestedAt: b.attestedAt } : {}),
      ...(b.mintTx ? { mintTx: b.mintTx } : {}),
      ...(b.state === 'minted' ? { mintedAt: b.updatedAt } : {}),
      recipient: b.recipient,
      ...(b.state === 'burned' && b.burnedAt ? { eta: etaOf(b.burnedAt, this.now()) } : {}),
      ...(b.stuckAt && b.stuckReason ? { stuckAt: b.stuckAt, stuckReason: b.stuckReason } : {}),
    }
  }

  /** Time left (ms) of `deadline`, or the whole leg timeout when there is none. */
  private left(deadline?: number): number {
    return deadline === undefined ? this.legTimeoutMs : Math.max(1, deadline - Date.now())
  }

  /** The bound funding gives all its Monad reads together (otto/mamoru#269). */
  legBudgetMs(): number {
    return this.legTimeoutMs
  }

  /** Whether the CCTP nonce of `b` is used on Monad at `block`, bounded like every Monad read that funding waits on. */
  private usedAt(b: BridgeBurn, block: bigint, ms: number): Promise<{ settled: boolean; unsure: boolean }> {
    return this.memoCheck(`${b.id}|u|${block}`, async () => (await withTimeout(this.monad.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'usedNonces', args: [b.cctpNonce!], blockNumber: block }), ms)) !== 0n)
  }

  /** otto/mamoru#269 (display): a check of the chain at a block is a fact that does not change, kept (a failure only for a few seconds, so a dead RPC is not asked on every poll). */
  private readonly settledMemo = new Map<string, { settled: boolean; ok: boolean; at: number }>()
  private async memoCheck(key: string, run: () => Promise<boolean>): Promise<{ settled: boolean; unsure: boolean }> {
    const hit = this.settledMemo.get(key)
    if (hit && (hit.ok || this.now() - hit.at < SETTLE_FAIL_TTL_MS)) return { settled: hit.settled, unsure: !hit.ok }
    if (this.settledMemo.size > 2_000) this.settledMemo.clear()
    try {
      const settled = await run()
      this.settledMemo.set(key, { settled, ok: true, at: this.now() })
      return { settled, unsure: false }
    } catch {
      this.settledMemo.set(key, { settled: false, ok: false, at: this.now() })
      return { settled: false, unsure: true }
    }
  }

  /**
   * otto/mamoru#269, DISPLAY ONLY (the engine and the cap never call this): the money map's in-flight rows for an account.
   * They are the burns the engine's own rule (inFlightBurns, the rule inFlightOf sums) counts, against the Monad block each
   * recipient Safe was read at: in flight until minted at or before that block, on Monad from then on. The checks the engine's
   * `settledAt` makes are made here too, but kept per (burn, block) and never against a stale read:
   * - a 'sending' burn whose EntryPoint nonce is unmoved at `baseBlock` has not left the home read;
   * - a 'burned' burn above `baseBlock` is still in the home read the map is paired with;
   * - a minted burn whose CCTP nonce is used at the recipient's read block is in that read;
   * - a minted burn to a Safe `legOf` does not know is settled (a recipient is only forgotten after an empty read).
   * A burn minted with no `mintedBlock` (old entries only) and one resting on a stale or missing read stay counted and
   * flagged `unsure`; a failed check does the same. Without a `baseBlock` every 'sending' and 'burned' burn counts.
   */
  async moneyInFlight(
    accountKey: string,
    baseBlock: bigint | undefined,
    legOf: (b: BridgeBurn) => { block?: bigint; stale: boolean } | undefined,
    /** Absolute time (ms) by which the Monad part of funding must be done; every chain read here stays inside it. */
    deadline?: number,
  ): Promise<{ rows: MoneyInFlight[]; unsure: boolean }> {
    const mine = this.burns().filter((b) => b.accountKey === accountKey)
    const settled = new Set<string>()
    const failed = new Set<string>()
    // The checks that ask a chain run together, all inside the one deadline funding gives its Monad part.
    const jobs: Promise<void>[] = []
    const check = (b: BridgeBurn, run: Promise<{ settled: boolean; unsure: boolean }>) =>
      jobs.push(
        run.then((r) => {
          if (r.settled) settled.add(b.id)
          if (r.unsure) failed.add(b.id)
        }),
      )
    for (const b of mine) {
      const l = legOf(b)
      const ms = this.left(deadline)
      if (b.state === 'sending' && baseBlock !== undefined) {
        check(b, this.memoCheck(`${b.id}|n|${baseBlock}`, async () => (await withTimeout(this.base.readContract({ address: address('EntryPointV07', this.baseRegistryOf), abi: entryPointV07Abi, functionName: 'getNonce', args: [b.account, BigInt(b.nonceKey)], blockNumber: baseBlock }), ms)) <= BigInt(b.nonce)))
      } else if (b.state === 'burned' && baseBlock !== undefined && b.burnBlock !== undefined && BigInt(b.burnBlock) > baseBlock) {
        settled.add(b.id)
      } else if (b.state === 'minted') {
        // Settled only for a recipient the caller does not track at all (forgotten after a live empty read). A tracked Safe
        // that has no live read now keeps its minted burn in flight, flagged unsure.
        if (!l) {
          if (b.mintedBlock !== undefined) settled.add(b.id)
        } else if (!l.stale && l.block !== undefined && b.cctpNonce && b.mintedBlock !== undefined && BigInt(b.mintedBlock) > l.block) check(b, this.usedAt(b, l.block, ms))
      } else if (b.state === 'burned' && b.cctpNonce && l && !l.stale && l.block !== undefined) {
        // The mint may have landed before the journal says so (between two ticks): if the nonce is used at the block the
        // recipient was read at, the USDC is in that read.
        check(b, this.usedAt(b, l.block, ms))
      }
    }
    await Promise.all(jobs)
    let unsure = false
    const rows = inFlightBurns(mine, accountKey, (b) => legOf(b)?.block ?? 0n, settled)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((b) => {
        const l = legOf(b)
        const weak = b.state === 'minted' && (b.mintedBlock === undefined || !l || l.stale || l.block === undefined)
        const rowUnsure = failed.has(b.id) || weak
        if (rowUnsure) unsure = true
        const t = this.trail(b)
        const stage: MoneyInFlight['stage'] = b.state === 'sending' ? 'sending' : b.state === 'minted' ? 'minted' : b.mintTx ? 'minting' : b.attestedAt ? 'attested' : 'burned'
        return {
          id: b.id,
          kind: 'cctp',
          from: this.baseRegistryOf.chainId,
          to: b.chainId,
          recipient: b.recipient,
          amountUsdc: b.amount,
          stage,
          ...(t.burnTx ? { burnTx: t.burnTx } : {}),
          ...(t.burnedAt ? { burnedAt: t.burnedAt } : {}),
          ...(t.attestedAt ? { attestedAt: t.attestedAt } : {}),
          ...(t.mintTx ? { mintTx: t.mintTx } : {}),
          ...(t.mintedAt ? { mintedAt: t.mintedAt } : {}),
          ...(t.eta ? { eta: t.eta } : {}),
          ...(t.stuckAt && t.stuckReason ? { stuckAt: t.stuckAt, stuckReason: t.stuckReason } : {}),
          feeUsdc: '0',
          finality: 'standard',
          ...(rowUnsure ? { unsure: true } : {}),
        } satisfies MoneyInFlight
      })
    return { rows, unsure }
  }

  /** Every Safe a burn of the account went to, kept until a read shows it empty (releaseRecipient), however old its burns. */
  recipients(accountKey: string): Address[] {
    return [...(this.journal.pastRecipients[accountKey] ?? [])]
  }

  /**
   * Forgets a past recipient, only when `leg` is a live read of it that holds nothing at all (no token, no position) and
   * no burn to it is still on its way or minted above that read's block. Returns whether it was dropped.
   */
  releaseRecipient(accountKey: string, safe: Address, leg: { block: number; stale: boolean; empty: boolean }): boolean {
    if (leg.stale || !leg.empty) return false
    const list = this.journal.pastRecipients[accountKey]
    if (!list?.some((a) => a.toLowerCase() === safe.toLowerCase())) return false
    const open = this.burns().some(
      (b) => b.accountKey === accountKey && b.recipient.toLowerCase() === safe.toLowerCase() && (IN_FLIGHT.has(b.state) || (b.state === 'minted' && (b.mintedBlock === undefined || BigInt(b.mintedBlock) > BigInt(leg.block)))),
    )
    if (open) return false
    this.journal.pastRecipients[accountKey] = list.filter((a) => a.toLowerCase() !== safe.toLowerCase())
    try {
      this.save()
    } catch (e) {
      this.journal.pastRecipients[accountKey] = list
      logErr('[bridge-monad] journal write failed:', e)
      return false
    }
    return true
  }

  /** MONAD_LEG_TIMEOUT_MS; a field so a test can shorten it. */
  private legTimeoutMs = MONAD_LEG_TIMEOUT_MS
  private readonly legCache = new Map<string, { at: number; leg: MoneyChain }>()
  private readonly legReads = new Map<string, Promise<MoneyChain>>()

  /**
   * otto/mamoru#269: one remote Safe on Monad as a chain of the money map: tokens, positions, MON, block and time, at
   * the pool price funding shows (slot0). One read serves every poll for `maxAgeMs`, and a failed read is not retried for
   * 5 s, so the map adds no RPC load beyond that. Monad unreadable: the last good leg of this process, else the last good
   * total on disk, else the engine's last sleeve value, flagged stale with its time; never 0 once anything was read. Never
   * read at all: `read.at` is null (the map is then incomplete). `key`: the journal key of the Safe (account key, or
   * `<account key>#retired` for a retired design-C Safe).
   */
  async sleeveLeg(key: string, safe: Address, maxAgeMs: number, deadline?: number): Promise<MoneyChain> {
    const jk = safe.toLowerCase()
    const ck = jk
    const hit = this.legCache.get(ck)
    if (hit && this.now() - hit.at < (hit.leg.read.stale ? Math.min(maxAgeMs, 5_000) : maxAgeMs)) return hit.leg
    const running = this.legReads.get(ck)
    if (running) return running
    const p = this.readLeg(key, safe, ck, jk, deadline).finally(() => this.legReads.delete(ck))
    this.legReads.set(ck, p)
    return p
  }

  /**
   * The one readSafe of each Safe that may be running: a hung request is waited on again, never restarted by the next
   * poll. The Monad client is built with a 60 s transport timeout (boot.ts SIDE_CLIENT_TIMEOUT_MS), so a request that never
   * answers is rejected by the transport and leaves this map by itself.
   */
  private readonly rawReads = new Map<string, Promise<SafeRead>>()

  private legVerify: Promise<boolean> | null = null

  private async readLeg(key: string, safe: Address, ck: string, jk: string, deadline?: number): Promise<MoneyChain> {
    const before = this.legCache.get(ck)
    try {
      // The check of the Monad RPC (until it has passed) and the read together stay inside one deadline.
      const r = await withTimeout(
        (async () => {
          if (!this.verified) {
            this.legVerify ??= this.monadVerified().finally(() => (this.legVerify = null))
            if (!(await this.legVerify)) throw new Error('Monad RPC not checked yet')
          }
          if (this.rawReads.has(jk)) throw new Error('the previous read of this Safe has not answered yet')
          // The same full read the engine's readSleeve makes; the display filters positions to those above dust.
          const raw = readSafe(this.monad, safe, this.monadRegistryOf)
          this.rawReads.set(jk, raw)
          void raw.then(() => undefined, () => undefined).finally(() => this.rawReads.delete(jk))
          return raw
        })(),
        this.left(deadline),
      )
      const last = this.journal.shown[jk]
      // A lagging provider: a read older than the last one shown is not used (it could miss a mint already counted).
      if (last && BigInt(last.block) > r.block) throw new Error(`provider at block ${r.block}, behind ${last.block}`)
      const at = this.iso()
      const leg = chainLegOf({ chainId: this.monadRegistryOf.chainId, safe, registry: this.monadRegistryOf, r, held: heldAboveDust(r, this.monadRegistryOf), at, stale: false, gasSymbol: 'MON' })
      if (last && last.totalUsdc === leg.totalUsdc && this.now() - Date.parse(last.at) <= 5 * 60_000) {
        // Unchanged: the block moves on in memory (a prune must see this read), the disk is written on a change or after 5 min.
        last.block = r.block.toString()
      } else {
        this.journal.shown[jk] = { totalUsdc: leg.totalUsdc, block: r.block.toString(), at }
        try {
          this.save()
        } catch (e) {
          logErr('[bridge-monad] journal write failed:', e)
        }
      }
      this.legCache.set(ck, { at: this.now(), leg })
      return leg
    } catch (e) {
      if (!before || !before.leg.read.stale) logErr(`[bridge-monad] ${key} money map: Monad Safe unreadable, showing its last value:`, e)
      // What is known of THIS Safe (never of the account's other Safes): this process's last leg, the last good total on
      // disk (by address), or the engine's last sleeve value when it was read for this very Safe: the newest by block wins.
      const known = before && before.leg.read.at !== null ? before.leg : null
      const shown = this.journal.shown[jk]
      // The engine's sleeve record for THIS Safe, found by address under whatever key the engine used (account key or #retired).
      // An entry written before it carried a Safe is the account's primary remote's (plain key), never a #retired/#past one's.
      const sl = [...Object.values(this.journal.sleeves).filter((e) => e.safe === jk), ...(!key.includes('#') && this.journal.sleeves[key] && this.journal.sleeves[key]!.safe === undefined ? [this.journal.sleeves[key]!] : [])].sort((x, y) => Number(y.block) - Number(x.block))[0]
      const cands = [shown ? { totalUsdc: BigInt(shown.totalUsdc), block: Number(shown.block), at: shown.at } : null, sl ? { totalUsdc: BigInt(sl.value), block: Number(sl.block), at: sl.at } : null].filter((c): c is NonNullable<typeof c> => c !== null)
      const best = cands.sort((x, y) => y.block - x.block)[0] ?? null
      const leg: MoneyChain = known && (!best || best.block <= known.read.block) ? { ...known, read: { ...known.read, stale: true } } : unreadLeg({ chainId: this.monadRegistryOf.chainId, safe, gasSymbol: 'MON', known: best })
      // Cached for the short failure TTL (no hammering, no log spam); `known` above ignores an unread leg, so it never
      // shadows what the journal learns later.
      this.legCache.set(ck, { at: this.now(), leg })
      return leg
    }
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
      const monadOk = this.burns().some((b) => b.state === 'burned' || (b.state === 'minted' && b.mintedBlock === undefined && b.mintTx)) ? await this.monadVerified() : this.verified
      for (const b of this.burns()) {
        try {
          if (b.state === 'sending') await this.settleSending(b)
          if (b.state === 'burned' && !monadOk) this.blockers.set(b.id, 'monad_unreachable')
          if (b.state === 'burned' && monadOk) await this.mint(b)
          if (b.state === 'minted' && monadOk) await this.backfillMinted(b)
        } catch (e) {
          logErr(`[bridge-monad] ${String(b.account ?? '').slice(0, 10)} ${String(b.id ?? '').slice(0, 10)}:`, e)
        }
        // otto/mamoru#245: one bad entry never skips the rest of the pass nor the prune.
        try {
          this.flagStuck(b)
        } catch (e) {
          logErr(`[bridge-monad] stuck check of ${String(b.id).slice(0, 10)}:`, e)
        }
      }
      this.prune()
    })
  }

  private update(b: BridgeBurn, patch: Partial<BridgeBurn>): void {
    // otto/mamoru#245: stuck is a flag on one state; any move (burned, minted, failed, dropped) clears it. The alert mark stays.
    const moved = patch.state !== undefined && patch.state !== b.state && b.stuckAt !== undefined
    Object.assign(b, patch, { updatedAt: this.iso() }, moved ? { stuckAt: undefined, stuckReason: undefined } : {})
    if (patch.state !== undefined) this.blockers.delete(b.id)
    this.save()
    if (moved) console.log(`[bridge-monad] ${(b.accountKey ?? '').slice(0, 8)} ${(b.id ?? '').slice(0, 10)}: no longer stuck, now ${b.state}`)
  }

  /**
   * otto/mamoru#245: a 'sending' burn older than its deadline (from `at`), or a 'burned' one (from `burnedAt`), is flagged
   * stuck with the code of what holds it, and ops is paged once per burn and state: one [alert] line (forwarded to
   * Mattermost by the ops alert-forward), its mark on disk first so a restart never pages again. A burn paged while
   * sending is paged again if it then sticks while burned. `burnedAt` missing (old entries): from `at`, never `updatedAt`
   * (every Iris poll moves that). Nothing else changes: the burn keeps
   * counting in flight and in the cap, and the next tick tries it again. Never throws.
   */
  private flagStuck(b: BridgeBurn): void {
    if (!IN_FLIGHT.has(b.state)) return
    let after: BridgeStuckAfterMin
    try {
      after = this.stuckAfterOf(b.accountKey)
    } catch {
      after = DEFAULT_BRIDGE_STUCK_AFTER_MIN
    }
    const since = Date.parse(b.state === 'sending' ? b.at : (b.burnedAt ?? b.at))
    const mins = b.state === 'sending' ? after.sending : after.burned
    if (!Number.isFinite(since) || this.now() - since < mins * 60_000) return
    const reason = this.stuckReasonOf(b)
    const state = b.state as 'sending' | 'burned'
    const page = b.stuckAlertedAt?.[state] === undefined
    if (b.stuckAt !== undefined && b.stuckReason === reason && !page) return
    // updatedAt is left as it was: the revert backoff and the prune read it.
    if (b.stuckAt === undefined) b.stuckAt = this.iso()
    b.stuckReason = reason
    if (page) b.stuckAlertedAt = { ...b.stuckAlertedAt, [state]: this.iso() }
    try {
      this.save()
    } catch (e) {
      // Kept in memory: this process does not page again either.
      logErr('[bridge-monad] journal write failed (stuck flag kept in memory):', e)
    }
    // Codes and short ids only: no amount, no address.
    if (page) logErr(`[alert] bridge to Monad stuck: account ${(b.accountKey ?? '').slice(0, 8)} burn ${(b.id ?? '').slice(0, 10)} ${b.state} for over ${mins} min (${reason}); still counted in flight and retried`, undefined)
  }

  /** otto/mamoru#245: the code of what holds a burn: what the last pass hit, else what was recorded, else what the journal shows. */
  private stuckReasonOf(b: BridgeBurn): BridgeStuckReason {
    const seen = this.blockers.get(b.id)
    if (seen) return seen
    if (b.state === 'sending') return b.note?.startsWith('landed in') ? 'burn_unmatched' : 'not_sent'
    if (b.stuckReason) return b.stuckReason
    if ((b.mintReverts ?? 0) > 0) return 'mint_reverted'
    if (b.mintTx) return 'mint_pending'
    return 'no_attestation'
  }

  /**
   * otto/mamoru#245 (#277): the bridge leg's numbers for /metrics, from the journal and the reads mint() already makes
   * (no RPC here): USDC in flight (raw), the oldest in-flight burn's age, reverts of in-flight mints, stuck burns, and the
   * relayer's MON on Monad as last read before a mint (null until one).
   */
  metrics(): { inFlightUsdc: string; inFlightCount: number; oldestBurnAgeS: number | null; mintReverts: number; stuckCount: number; stuckReasons: Partial<Record<BridgeStuckReason, number>>; relayerMon: { address: Address; wei: string; at: string } | null } {
    const open = this.burns().filter((b) => IN_FLIGHT.has(b.state))
    const oldest = open.reduce<number | null>((m, b) => {
      const t = Date.parse(b.at)
      return Number.isFinite(t) && (m === null || t < m) ? t : m
    }, null)
    const stuckReasons: Partial<Record<BridgeStuckReason, number>> = {}
    for (const b of open) if (b.stuckAt && b.stuckReason) stuckReasons[b.stuckReason] = (stuckReasons[b.stuckReason] ?? 0) + 1
    return {
      inFlightUsdc: open.reduce((s, b) => s + BigInt(b.amount), 0n).toString(),
      inFlightCount: open.length,
      oldestBurnAgeS: oldest === null ? null : Math.max(0, Math.round((this.now() - oldest) / 1000)),
      mintReverts: open.reduce((s, b) => s + (b.mintReverts ?? 0), 0),
      stuckCount: open.filter((b) => b.stuckAt).length,
      stuckReasons,
      relayerMon: this.relayer && this.relayerMon ? { address: this.relayer.address, wei: this.relayerMon.wei.toString(), at: this.relayerMon.at } : null,
    }
  }

  /**
   * otto/mamoru#269: a minted burn is pruned only once a read of its recipient after the mint is recorded: the engine's sleeve
   * record for that Safe, or the last good display total, at or after its mintedBlock; a burn with no mintedBlock (old
   * entries) needs a successful live read of the recipient whose wall-clock time is after the mint was seen (mintAt, else
   * updatedAt). Until then the journal row is what keeps its amount in the displayed total while Monad cannot be read:
   * never age alone. Failed and dropped burns hold no value.
   */
  private confirmed(b: BridgeBurn): boolean {
    if (b.state !== 'minted') return true
    const safe = b.recipient.toLowerCase()
    const reads = [this.journal.shown[safe], ...Object.values(this.journal.sleeves).filter((e) => e.safe === safe)]
    if (b.mintedBlock !== undefined) return reads.some((e) => e !== undefined && BigInt(e.block) >= BigInt(b.mintedBlock!))
    const since = Date.parse(b.mintAt ?? b.updatedAt)
    return reads.some((e) => e !== undefined && Date.parse(e.at) >= since)
  }

  private prune(): void {
    const cut = this.now() - MINTED_KEEP_MS
    let changed = false
    for (const [id, b] of Object.entries(this.journal.burns)) {
      if ((b.state === 'minted' || b.state === 'failed' || b.state === 'dropped') && Date.parse(b.updatedAt) < cut && this.confirmed(b)) {
        delete this.journal.burns[id]
        changed = true
      }
    }
    if (changed) this.save()
  }

  /**
   * A burn written before its userOp was signed, settled only from Base at its `safe` block. The EntryPoint nonce at
   * `safe` first: while it is unmoved the userOp has not landed at or below `safe` (inclusion spends it, a revert too), so
   * no log is read and the cursor moves to `safe`. Once it moved, the UserOperationEvent is looked for from the cursor in
   * bounded chunks (SETTLE_LOG_CHUNK, at most SETTLE_CHUNKS_PER_TICK a pass, the cursor on disk after each): a success
   * with exactly this burn: 'burned'; a revert: 'failed', nothing burned; no event up to `safe`: 'dropped' (another
   * userOp took the nonce, this one can never land). Anything else stays in flight.
   */
  async settleSending(b: BridgeBurn): Promise<void> {
    const ep = address('EntryPointV07', this.baseRegistryOf)
    const safe = await this.base.getBlock({ blockTag: 'safe' })
    let cursor = BigInt(b.scanFrom ?? b.fromBlock)
    if (safe.number < cursor) return
    const nonceAtSafe = await this.base.readContract({ address: ep, abi: entryPointV07Abi, functionName: 'getNonce', args: [b.account, BigInt(b.nonceKey)], blockNumber: safe.number })
    if (nonceAtSafe <= BigInt(b.nonce)) return void this.update(b, { scanFrom: (safe.number + 1n).toString() })
    for (let i = 0; i < SETTLE_CHUNKS_PER_TICK && cursor <= safe.number; i++) {
      const to = cursor + SETTLE_LOG_CHUNK - 1n < safe.number ? cursor + SETTLE_LOG_CHUNK - 1n : safe.number
      const logs = await this.base.getLogs({ address: ep, event: userOperationEvent, args: { userOpHash: b.id }, fromBlock: cursor, toBlock: to })
      if (logs.length > 1) throw new Error(`${logs.length} UserOperationEvents for ${b.id}`)
      if (logs.length === 1) return this.landed(b, logs[0]!)
      cursor = to + 1n
      this.update(b, { scanFrom: cursor.toString() })
    }
    if (cursor > safe.number) this.update(b, { state: 'dropped', note: `nonce ${b.nonce} spent at safe block ${safe.number} without this userOp: nothing burned` })
  }

  /** The burn's UserOperationEvent, found at or below `safe`: burned, failed, or kept in flight when it is not this burn. */
  private async landed(b: BridgeBurn, ev: { args: { sender?: Address; nonce?: bigint; success?: boolean }; blockNumber: bigint | null; transactionHash: Hex | null; logIndex: number | null }): Promise<void> {
    const blockNumber = ev.blockNumber!
    const txHash = ev.transactionHash!
    if (BigInt(b.scanFrom ?? b.fromBlock) !== blockNumber) this.update(b, { scanFrom: blockNumber.toString() })
    if (!ev.args.sender || !isAddressEqual(ev.args.sender, b.account) || ev.args.nonce !== BigInt(b.nonce)) throw new Error(`UserOperationEvent of ${ev.args.sender} nonce ${ev.args.nonce} for this burn's hash`)
    if (!ev.args.success) return void this.update(b, { state: 'failed', txHash, failedBlock: blockNumber.toString(), note: 'the userOp reverted: nothing burned' })
    const receipt = await this.base.getTransactionReceipt({ hash: txHash })
    const burn = burnOf(userOpLogs(receipt.logs, ev.logIndex!, this.baseRegistryOf), b, this.baseRegistryOf)
    if (!burn) {
      // Landed, but not as this burn: kept in flight (never under-counted) until someone looks.
      this.blockers.set(b.id, 'burn_unmatched')
      if (!b.note) this.update(b, { note: `landed in ${txHash} without exactly this burn; kept in flight` })
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, `userOp ${b.id.slice(0, 10)} landed without exactly this burn; kept in flight`)
      return
    }
    delete this.journal.cooldowns[b.accountKey]
    this.update(b, { state: 'burned', txHash, burnBlock: blockNumber.toString(), burnedAt: this.iso(), messageKey: cctpMessageKey(burn.message) })
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
      if (rc) {
        // Reverted: counted once (the hash is cleared here), and the next attempt waits longer (below).
        this.update(b, { mintTx: undefined, mintReverts: (b.mintReverts ?? 0) + 1, note: `receiveMessage ${b.mintTx} reverted` })
        this.blockers.set(b.id, 'mint_reverted')
      } else {
        // No receipt yet: pending, unless it was signed and never broadcast. After MONAD_MINT_PENDING_MS the attempt below
        // runs again: the used-nonce check stops it if the first landed; a first landing after it makes the second revert.
        if (this.now() - Date.parse(b.mintAt ?? b.updatedAt) < MONAD_MINT_PENDING_MS) return void this.blockers.set(b.id, 'mint_pending')
        this.update(b, { mintTx: undefined })
      }
    }
    const now = this.now()
    if (now - Date.parse(b.burnedAt ?? b.updatedAt) < ATTEST_FIRST_POLL_MS) return
    if (b.attestPolledAt && now - Date.parse(b.attestPolledAt) < ATTEST_POLL_MS) return
    // otto/mamoru#245: once the CCTP nonce is known, a mint by anyone else (the owner calling receiveMessage on Monad) is
    // seen on the burn's poll timer even when Iris does not answer; the check after the attestation is then skipped, so
    // a pass reads usedNonces once, as before.
    const checkedNonce = b.cctpNonce?.toLowerCase()
    // On disk, and before any read: a restart does not poll again at once, and neither does a pass whose usedNonces
    // read or Iris call throws (otto/mamoru#245: the poll timer holds when Iris does not answer).
    this.update(b, { attestPolledAt: this.iso() })
    if (b.cctpNonce && (await this.mintedElsewhere(b, b.cctpNonce))) return
    const atts = await cctpAttestation(b.txHash, this.fetcher, CCTP_DOMAIN_BASE)
    if (!b.mintReverts) this.blockers.set(b.id, 'no_attestation')
    if (!atts) return
    const amount = BigInt(b.amount)
    const att = atts.find((a) => {
      try {
        return cctpMessageKey(a.message) === b.messageKey && mintIsFor(decodeCctpMessage(a.message), BASE_USDC, b.recipient, amount, { source: CCTP_DOMAIN_BASE, destination: CCTP_DOMAIN_MONAD }, b.depositor ?? b.account)
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
    // otto/mamoru#269 (display): the step from 'attesting' to 'minting' is only visible if the first valid attestation time is
    // kept. Set only once the nonce, the attesters' signature and the duplicate check passed; nothing here decides anything
    // (updatedAt is not moved), and a failed write is logged, never allowed to stop the mint.
    if (!b.attestedAt) {
      b.attestedAt = this.iso()
      try {
        this.save()
      } catch (e) {
        logErr('[bridge-monad] journal write failed (attestedAt kept in memory):', e)
      }
    }
    // The CCTP nonce is on disk before anything else is read or sent for it (the duplicate check above reads it).
    if (b.cctpNonce?.toLowerCase() !== msg.nonce.toLowerCase()) this.update(b, { cctpNonce: msg.nonce })
    if (checkedNonce !== msg.nonce.toLowerCase() && (await this.mintedElsewhere(b, msg.nonce))) return
    if (!this.relayer) return void this.blockers.set(b.id, 'mint_off')
    // A mint that reverted is not sent again at once: each revert doubles the wait, and past the cap none is sent (a mint by
    // anyone else is still seen by the used-nonce check above).
    const reverts = b.mintReverts ?? 0
    if (reverts > 0) this.blockers.set(b.id, 'mint_reverted')
    if (reverts >= MONAD_MINT_MAX_REVERTS) {
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, `receiveMessage reverted ${reverts} times; not sent again, kept in flight until someone looks`)
      return
    }
    if (reverts > 0 && now - Date.parse(b.mintAt ?? b.updatedAt) < MONAD_MINT_PENDING_MS * 2 ** (reverts - 1)) return
    const data = receiveMessageData(att.message, att.attestation)
    const relayer = this.relayer
    const est = await this.monad.estimateGas({ account: relayer.address, to: MESSAGE_TRANSMITTER_V2, data })
    const gas = (est * 11n) / 10n
    if (gas > MONAD_MINT_GAS_CAP) {
      this.blockers.set(b.id, 'gas_ceiling')
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, `receiveMessage estimated at ${est} gas, over the ${MONAD_MINT_GAS_CAP} cap; not minted`)
      return
    }
    const price = await this.monad.getGasPrice()
    if (price > MAX_MONAD_GAS_PRICE_WEI) {
      this.blockers.set(b.id, 'gas_ceiling')
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, 'Monad gas above the mint ceiling, minting later')
      return
    }
    const day = this.day()
    const estimate = gas * price * 2n
    const m = this.mintDay(day)
    if (m.n >= MONAD_MINTS_PER_DAY || BigInt(m.wei) + estimate > MONAD_MINT_BUDGET_WEI) {
      this.blockers.set(b.id, 'mint_budget')
      logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, 'Monad mint budget for today used up, minting tomorrow')
      return
    }
    const balance = await this.monad.getBalance({ address: relayer.address })
    this.relayerMon = { wei: balance, at: this.iso() }
    if (balance < estimate) {
      this.blockers.set(b.id, 'relayer_unfunded')
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
        this.blockers.set(b.id, e.message.includes('budget') ? 'mint_budget' : 'gas_ceiling')
        logErr(`[bridge-monad] ${b.account.slice(0, 10)}:`, e.message)
        return
      }
      throw e
    }
    // Monad charges the gas limit: the limit at the price paid.
    charge(gas * sent.receipt.effectiveGasPrice)
    if (sent.receipt.status === 'success') this.update(b, { state: 'minted', mintTx: sent.hash, mintedBlock: sent.receipt.blockNumber.toString() })
    else {
      this.update(b, { mintTx: sent.hash, note: `receiveMessage ${sent.hash} reverted; tried again after the used-nonce check` })
      this.blockers.set(b.id, 'mint_reverted')
    }
  }

  /**
   * Whether the CCTP nonce of `b` is already used on Monad at the head: then it was minted (by the relayer in an earlier
   * pass, or by anyone else, e.g. the owner calling receiveMessage), and the burn ends minted with no transaction. The
   * mintedBlock is the block of that read, at or after the real mint (#332: never before it, or the cap under-counts).
   */
  private async mintedElsewhere(b: BridgeBurn, nonce: Hex): Promise<boolean> {
    const block = await this.monad.getBlockNumber()
    const used = await this.monad.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'usedNonces', args: [nonce], blockNumber: block })
    if (used === 0n) return false
    this.update(b, { state: 'minted', cctpNonce: nonce, mintedBlock: block.toString(), note: b.mintTx ? b.note : 'minted by someone else (any caller may)' })
    return true
  }
}

/** The one DepositForBurn of this burn in a userOp's logs, and the MessageSent next to it; null unless exactly that. */
export function burnOf(logs: Log[], b: Pick<BridgeBurn, 'account' | 'depositor' | 'recipient' | 'amount' | 'destinationDomain'>, registry: Registry = baseRegistry): { message: Hex } | null {
  const messenger = address('TokenMessengerV2', registry)
  const burns = parseEventLogs({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', logs: logs.filter((l) => isAddressEqual(l.address, messenger)) })
  const sent = parseEventLogs({ abi: messageTransmitterV2Abi, eventName: 'MessageSent', logs: logs.filter((l) => isAddressEqual(l.address, MESSAGE_TRANSMITTER_V2)) })
  if (burns.length !== 1 || sent.length !== 1) return null
  const a = burns[0]!.args
  const ok =
    isAddressEqual(a.burnToken, address('USDC', registry)) &&
    isAddressEqual(a.depositor, b.depositor ?? b.account) &&
    a.amount === BigInt(b.amount) &&
    a.mintRecipient.toLowerCase() === pad(b.recipient, { size: 32 }).toLowerCase() &&
    a.destinationDomain === b.destinationDomain &&
    BigInt(a.destinationCaller) === 0n &&
    a.maxFee === 0n &&
    a.minFinalityThreshold >= 2000 &&
    a.hookData === '0x'
  return ok ? { message: sent[0]!.args.message } : null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)
  })
  p.catch(() => {})
  return Promise.race([p, timeout]).finally(() => clearTimeout(t))
}
