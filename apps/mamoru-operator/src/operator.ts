import { randomBytes } from 'node:crypto'
import { decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiItem, getAddress, isAddress, keccak256, stringToHex, toFunctionSelector, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { BASE_CHAIN_ID, chainOf, isChainId, overCap, ReasonError, type AccountContext, type Address, type FundingView, type OpView, type OwnerSignature, type OwnerTxToSign, type PriceDivergenceLeg, type PriceDivergenceWarning, type TransferPlan, type TransferRequest, type WithdrawAsset } from '@mamoru/domain'
import { address, entry, erc20Abi, mamoruActionPolicyV2Abi, moduleRegistryAbi, nonfungiblePositionManagerAbi, safeAbi, smartSessionAbi, type Registry, type RegistryName } from '@mamoru/registry'
import { uniswapV3, type UniswapV3 } from '@mamoru/uniswap-v3'
import type { SnapshotTarget } from './snapshot.ts'
import { BATCH_MAX_CALLS, Batch, contractRead, multicall3Of, poolStateCache, simulateCalls, SharedGuardReads, type SimCallResult } from '@mamoru/rpc'
import { POLICIES, USAGE_RENEW_BPS, V4_POOLS, V4_TX_GAS_TARGET, calibratedGasModel, fitPrefixBySimulation, budgetUsedBps, canonicalSettingsJson, capBaseUnits, computeCaps, estimateSessionGas, grantKey, instantiateGrant, maxGasCostPerOp, orderV4Keys, retargetToPolicy, splitV4Keys, v4BudgetCaps, v4PoolOf, withActionPolicy, withEngineSettings, type OpsFlagName, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import {
  LIVE_CAP_USDC,
  activationBatch,
  assertionShape,
  browserOwnerSignature,
  deployCall,
  execData,
  fromB64url,
  liveAccountFromContext,
  ownerSafeTx,
  ownerSignatureShape,
  readSafeNonce,
  safeTxHashOf,
  stopBatch,
  transferBatch,
  verifyOwnerSignature,
  type LiveAccount,
  type LiveGasReserve,
  type LivePosition,
  type LiveReceive,
  type LiveSwap,
  type SafeTx,
} from '@mamoru/account/live'
import { multiSendCallOnly } from '@mamoru/account/safe'
import { permissionIdOf, revocationCalls, toSmartSession, v4DeploymentOf, v4PoliciesFor, type V4Deployment } from '@mamoru/account/sessions'
import { minOut, sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { twapTickAt } from '@mamoru/uniswap-v3/twap'
import { SELF_RESERVE_DEADLINE_SECONDS, SELF_RESERVE_PROBE_USDC, SELF_RESERVE_TWAP_SECONDS, reserveExpired, selfReserveConfirmed, selfReservePlan, usdcForWeiAtTick } from './self-reserve.ts'
import { Engine, type EngineConfig, type EngineSession } from '@mamoru/scenarios/driver/engine.ts'
import type { EngineSettingsSource } from './engine-settings.ts'
import type { GuardReadsState } from './guard-reads-state.ts'
import type { OpRecord } from '@mamoru/scenarios/driver/journal.ts'
import type { Observation, PeerPositionObs, Proposal } from '@mamoru/decide'
import { isTerminal } from '@mamoru/journal'
import type { RpcBudget } from './budget.ts'
import { MAX_INVENTORY, amountsForLiquidity, inUsdc, livePool, nativePricePool, positionUsdc, priceOf, readSafe, usdcPools, writeRefusal, type PoolPosition, type SafeRead } from './chain.ts'
import { FundingCache, fundingCacheKey, isAccountKey } from './funding-cache.ts'
import { elsewhereOf, exposureOf, joinReads, totalOf, type ChainExposure, type ExposureWire, type PeerExposure, type PeerRead } from './exposure.ts'
import { closeCalls, planReduce, routeOf, swapBackCalls, type SwapBack } from './unwind.ts'
import { accepts, divergenceLeg, divergenceWarning, judgeSwap, staleAcceptance, type AcceptedSwap } from './divergence.ts'
import { ONE_ACTION_GAS_UNITS, gasReserveAlertOverrideFromEnv, gasReserveAlertWei } from './gas-reserve.ts'
import { Lock } from './lock.ts'
import { classifyEngineError, EngineHealthTracker, GasReserveTracker, logErr, safeMetrics, type EngineHealthSnapshot, type GasReserveSnapshot } from './metrics.ts'
import type { Relayer } from './relayer.ts'
import { revertData } from './bundler.ts'
import { readChainUsage, readPolicyBudgets, type ChainUsage } from './session-usage.ts'
import { DEFAULT_SPONSOR, activationRefusal, monadSponsor, boundedSponsor, recentSponsored, sponsorRefusal, type SponsoredKind, type SponsorEntry, type SponsorPolicy } from './sponsorship.ts'
import type { AccountState, ArmedActivation, StateStore, StoredGrant, StoredOp } from './state.ts'

/** Known/active/armed account counts plus the operator's engine health for GET /metrics. */
export type AccountsSummary = { known: number; active: number; armed: number }
/** GET /metrics `opsRecent` (otto/mamoru#129): exactly these five fields, never a grant, session key, signature,
 * salt or userOp — the same trim GET /ops already applies per-account, here across every account at once. */
export type RecentOp = { accountKey: string; kind: OpView['kind']; state: OpView['state']; at: string; code: string | null }

/** Where an account's cap at Start came from (otto/mamoru#26). */
export type CapSource = 'override' | 'canary' | 'env' | 'default' | 'emergency'

/**
 * GET /metrics `authorizations` (otto/mamoru#26, for /ops): what the operator already holds in memory about each
 * account's approval. Never a session key, signature, permission id or grant body. Whole USDC; ISO times.
 */
export type AuthorizationSnapshot = {
  account: string
  active: boolean
  policyId: string
  policyVersion: string
  /** Pools the held grants name (`pool:...`), sorted. */
  pools: string[]
  /** The earliest validUntil of the held grants, or null without grants. */
  validUntil: string | null
  /** Per held grant (and v4 per-pool budget), how much of its allowance is used, bps. */
  grants: { grant: string; usedBps: number }[]
  capUsdc: number
  capSource: CapSource
  /** The cap the held grants were sized for. */
  signedCapUsdc: number
  /** SESSION_* conditions on the held approval (expired, renewal due, grants missing, usage spent, last engine code). */
  holds: string[]
  /** otto/mamoru#140: why the account stopped without its own owner op, or null. */
  deactivated: string | null
}
const RELAYER_BALANCE_CACHE_MS = 60_000
/**
 * otto/mamoru#135: how old the shared readSafe behind GET funding may be. 15 s for a poll, 60 s while the keyed
 * RPC provider is over its hourly budget, and 2 s for `fresh=1` (the add-money screen watching a deposit land, a
 * dialog opening). 2 s is under the app's 4 s fast poll, so a fresh poll always gets a read of its own, while a
 * client asking fresh=1 in a loop still costs at most one readSafe per account per 2 s. The cache only feeds what
 * the app shows: every owner action's prepare and submit reads the chain itself and decides on that.
 */
const FUNDING_FRESH_MS = 15_000
/** #149: how long the on-chain usage counters of an account are taken as current (about 30 reads per account). */
const CHAIN_USAGE_TTL_MS = 10 * 60_000
const FUNDING_STALE_MS = 60_000
const FUNDING_FRESH_READ_MS = 2_000
/**
 * otto/mamoru#212: how old the peer operators' read of an account may be: for a Start check (prepare, submit, the armed
 * watcher, the send), for an engine review and for what funding shows. A peer that cannot be read fails closed.
 */
const PEER_START_MAX_AGE_MS = 10_000
const PEER_ENGINE_MAX_AGE_MS = 2_000
const PEER_FUNDING_MAX_AGE_MS = 30_000

const EXECUTION_SUCCESS = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'))
const EXECUTION_FAILURE = keccak256(stringToHex('ExecutionFailure(bytes32,uint256)'))
/** Safe 1.4.1 GuardManager: keccak256("guard_manager.guard.address"), where the Safe's guard address is stored. */
const GUARD_STORAGE_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'
/** otto/mamoru#163: the range search's pages per settle pass (its checkpoint carries it on next pass). */
const SCAN_PAGES_PER_PASS = 20
/** otto/mamoru#163: blocks above the evidence a settlement waits for (~24 s on Base), and the evidence block still canonical. */
const SETTLE_CONFIRMATIONS = 12n
/** The Safe tx that spent an op's Safe nonce, read from the spending block's own logs. */
type SpentBy = { safeTxHash: Hex; tx: Hex; block: bigint; ours: boolean; success: boolean }
const EXECUTION_SUCCESS_EVENT = parseAbiItem('event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)')
/** How far past an owner op's send block its ExecutionSuccess is searched for (about a day of Base blocks), and per request. */
const OWNER_LOG_SEARCH_BLOCKS = 43_200n
const OWNER_LOG_PAGE_BLOCKS = 2_000n
/** First and longest wait between reconciliation passes of an account with owner ops still unresolved (doubling). */
const RECONCILE_RETRY_MS = 30_000
const RECONCILE_RETRY_MAX_MS = 1_800_000
/** Above this many tracked permission ids a full grant check alerts (expected ~48 a year: 12 grants, 4 renewals). */
const GRANTS_TRACKED_ALERT = 2_000
/** How often the engine loop reads every grant it uses before a review (otto/mamoru#140, invariant I1). */
const GRANTS_CHECK_MS = 300_000
/** Permission ids per engine-loop grant sweep (one Multicall3 chunk): the engine's always, the others in rotation. */
const GRANTS_SWEEP_MAX = 100

/** Engine-loop sweeps within which every non-engine id the account knows is read again (see enforceGrants). */
export function sweepsToCover(others: number, engine: number): number {
  return others <= GRANTS_SWEEP_MAX - engine ? 1 : Math.ceil(others / Math.max(1, GRANTS_SWEEP_MAX - engine))
}
/** An owner op whose receipt poll failed after the tx was sent: the tx may still have landed. */
const RECEIPT_UNKNOWN = 'OWNER_TX_ERROR'
/** Armed activations retry this many times across watcher passes before failing visibly. */
const ARM_MAX_TRIES = 20
/**
 * Wait after the first failed attempt of an armed activation; doubles each try up to ARM_RETRY_MAX_MS. The maximum
 * stays inside the window findOwnerTx looks back (150 blocks, about 5 min), so an attempt that landed after all is
 * still found when the next one sees the Safe nonce moved.
 */
const ARM_RETRY_MS = 30_000
const ARM_RETRY_MAX_MS = 180_000
/**
 * After ARM_MAX_TRIES failed attempts the approval is not dropped: it is parked and tried again this often. An owner's
 * signed approval ends only by running, or by the owner (a moved Safe nonce, a newer approval, a stop).
 */
const ARM_PARKED_MS = 1_800_000
/** How long an approval over the cap, or over the failure budget, waits between looks. */
const ARM_CAP_HOLD_MS = 300_000
const ARM_BUDGET_HOLD_MS = 600_000
/** Minimum gap between two receipt reconciliation passes of one account. */
const RECONCILE_EVERY_MS = 20_000
/** Base produces a block every 2 s; used to place a failure time on the chain when no tx hash was kept. */
const BLOCK_SECONDS = 2n
/** Blocks added before the handover time when looking for the block an activation executed in (clock and block-time slack). */
const ACTIVATION_SEARCH_MARGIN = 60n
/** Passes the search for that block is tried before the account is started from the search floor. */
const RECOVER_TRIES = 3
/** Blocks past an unproven head (5 min on Base) the engine of an activation recovered without historical state starts at. */
const RECOVER_HEAD_MARGIN = 150n
const PREPARE_TTL_MS = 5 * 60_000
/** On top of the policy reserve: the first userOp prefund leaves the Safe's balance into its EntryPoint deposit. */
const TOP_UP_MARGIN_WEI = 200_000_000_000_000n
/**
 * Relayer gas for one activation beyond the Safe top-up: the Safe deploy and the ~14M gas execTransaction on Base.
 * Fixed and on the high side on purpose: with the full top-up it asks for the worst case, so a wait can only be
 * longer than needed, never a send that runs out half way.
 */
const ACTIVATION_GAS_WEI = 200_000_000_000_000n
/** While an activation waits for the relayer to be funded, it is logged at most this often per account. */
const RELAYER_LOW_LOG_MS = 3_600_000
/** Blocks of deposit progress (~10 min on Base) before it is written to the state file. */
const DEPOSITS_SAVE_BLOCKS = 300n
/** How long a POST waits for the owner transaction before answering with the op as it stands; the SPA polls /ops. */
const POST_WAIT_MS = 15_000
/** How often the armed-activation watcher runs a pass; one request for every Safe due in that pass. */
const ARM_WATCH_MS = 15_000
/** While the owner is around (armed, seen in the app or paid in within the last hour) the Safe is read every pass. */
const ARM_FRESH_MS = 3_600_000
/** After that: once a minute for a day, then every five minutes. A deposit nobody is waiting for can take that long to start. */
const ARM_IDLE_MS = 60_000
const ARM_DAY_MS = 86_400_000
const ARM_STALE_MS = 300_000
/** Over the RPC budget an account with nothing in flight is still reviewed at least this often. */
const BUDGET_REVIEW_MS = 900_000
/** Over the RPC budget an operation left `included` is picked up at the normal pace for this long, then at the braked pace. */
const BUDGET_RESUME_MS = 1_800_000
/**
 * An entry is several operations (a swap and a mint per pool) and the engine decides one per review. While a review
 * leaves the next one something to do at once (it waited for the provider's head, or its operation confirmed), the
 * next review comes this soon instead of a whole review period later: a deposit is placed in a couple of minutes, not
 * in half an hour. FOLLOW_UP_MAX in a row at most, so an engine that keeps producing operations cannot spin.
 */
/** Blocks past the head (a minute on Base) no review looks before, when an engine operation was out at the last stop. */
const RESTART_FLOOR_MARGIN = 30n
export const FOLLOW_UP_MS = 5_000
export const FOLLOW_UP_MAX = 12
/** Quick reviews still granted after one that did nothing: the provider may not show the last operation's effect yet. */
export const FOLLOW_UP_GRACE = 2

/** Whether a review that did nothing is still inside an entry: one of the last FOLLOW_UP_GRACE after a quick one. */
export function graceLeft(more: boolean, followUps: number, grace: number): { more: boolean; grace: number } {
  if (more) return { more: true, grace: 0 }
  if (followUps > 0 && grace < FOLLOW_UP_GRACE) return { more: true, grace: grace + 1 }
  return { more: false, grace: 0 }
}

/** The block of the latest engine operation stored for an account that reached the chain; 0 when none did. */
export function lastEngineBlock(ops: readonly Pick<OpView, 'opId' | 'block'>[]): bigint {
  return ops.reduce((m, o) => (o.opId.startsWith('eng-') && o.block !== undefined && BigInt(o.block) > m ? BigInt(o.block) : m), 0n)
}

/** When the next review of an account comes, and how many quick follow-ups in a row that makes. */
export function nextReview(more: boolean, followUps: number, overBudget: boolean, reviewMs: number): { ms: number; followUps: number } {
  if (more && !overBudget && followUps < FOLLOW_UP_MAX) return { ms: Math.min(FOLLOW_UP_MS, reviewMs), followUps: followUps + 1 }
  return { ms: reviewMs, followUps: 0 }
}

/**
 * otto/mamoru#135 follow-up: whether two `Runner.waiting` lists report the same thing (order included). Used
 * to invalidate the funding cache only when a review's decision actually changed what it reports, not on every
 * tick a repeated wait holds through (that would undo the cache's point).
 */
export function sameWaiting(a: Runner['waiting'], b: Runner['waiting']): boolean {
  const xs = a ?? []
  const ys = b ?? []
  return xs.length === ys.length && xs.every((w, i) => w.bucket === ys[i]!.bucket && w.pool === ys[i]!.pool && w.code === ys[i]!.code && w.amountUsdc === ys[i]!.amountUsdc)
}
/** otto/mamoru#140 (part2 #9): the most a pending owner tx (prepared, not yet signed) holds engine review for. */
export const REVIEW_HOLD_MAX_MS = 5 * 60_000
/**
 * Whether engine review is held this tick for a pending non-activate prepare on the account, and since when. An
 * owner tx prepared on the current positions is waiting for its passkey: an engine reduce or re-range now would
 * change the liquidity it withdraws (GS013), so review waits for it to run or expire. But `prepare` needs no
 * passkey, so without a bound a compromised app Worker (or a scripted retry loop) could keep one unexpired prepare
 * outstanding forever and starve the account's engine indefinitely. Bounded to REVIEW_HOLD_MAX_MS: past it, review
 * runs anyway and a stale prepare simply reverts on submit (GS013) and is prepared again, same as always.
 */
export function reviewHold(pending: boolean, since: number | undefined, now: number, maxMs = REVIEW_HOLD_MAX_MS): { hold: boolean; since?: number } {
  if (!pending) return { hold: false, since: undefined }
  const at = since ?? now
  return { hold: now - at < maxMs, since: at }
}
/** The relayer does not pay to deploy a Safe that holds less than this (1 USDC). */
export const MIN_DEPLOY_USDC = 1_000_000n
/**
 * Activations the relayer paid for and that failed, per account, in 24 hours. Only a new activation is refused once
 * the budget is spent. A withdrawal or a stop whose signature verified is always attempted: the guards protect the
 * relayer's gas, never at the price of an owner reaching their own funds.
 */
export const MAX_OWNER_FAILURES_PER_DAY = 5
/** Across all accounts this is a figure for the log and an alert, never a gate. */
export const OWNER_FAILURES_ALERT_PER_DAY = 50
const DAY_MS = 24 * 3_600_000
/** What counts: the relayer sent a transaction and it failed, or its outcome is unknown. Refusals before any send cost no gas and do not count. */
const BUDGET_CODES = new Set(['OWNER_TX_FAILED', 'OWNER_TX_ERROR', 'DEPLOY_FAILED'])
/**
 * otto/mamoru#163: owner ops whose Safe tx, once signed, stays executable by anyone until its Safe nonce is spent, and
 * that enable grants: a revert or a missing log never settles them, only the Safe nonce moving does.
 */
const RELAYABLE_KINDS = new Set<string>(['activate', 'renew'])
/** How long a stored engine operation left `submitted` (sent before a restart) keeps a renewal from revoking its grant. */
const ENGINE_OP_PENDING_MS = 600_000
/** How long a stop whose receipt was never read keeps a renewal from being prepared. */
const UNKNOWN_STOP_MS = 3_600_000
/** Owner op states after which nothing more happens to it. */
const TERMINAL_STATES = new Set<OpView['state']>(['confirmed', 'failed'])
/** Engine op states in which a user operation is signed or out and not settled yet. */
/**
 * Session uses already on chain, replayed into a new engine's ledger: every stored engine op that ran (confirmed, or
 * landed late) under a permission this engine signs with, from any epoch. An extension keeps earlier grants and their
 * on-chain counters keep counting (Sol review round 3 of #64); a permission's id is unique on chain.
 */
export function priorIncludedOf(ops: readonly StoredOp[], sessions: readonly { permissionId: Hex }[]): { permissionId: Hex; calls: NonNullable<StoredOp['calls']> }[] {
  const active = new Set(sessions.map((s) => s.permissionId.toLowerCase()))
  return ops.filter((o) => o.opId.startsWith('eng-') && (o.state === 'confirmed' || o.lateIncluded) && o.permissionId && o.calls && active.has(o.permissionId.toLowerCase())).map((o) => ({ permissionId: o.permissionId!, calls: o.calls! }))
}

const ENGINE_UNSETTLED = new Set<OpRecord['state']>(['signed', 'submitted', 'included', 'pending_reconciliation'])
/** What a retried activation meets when the Safe nonce it was signed for is already spent. */
const SPENT_NONCE_CODES = new Set(['SAFE_NONCE_MOVED', 'OWNER_TX_REVERTS', 'OWNER_TX_FAILED', 'BAD_SIGNATURE'])
/** How often an unavailable simulation or eth_call is tried again before the fallback. */
const SIM_TRIES = 3
/** otto/mamoru#140 (part2 #4): positions one Stop closes; the rest stay in the Safe and the next Stop closes them. */
export const MAX_STOP_POSITIONS = 8
/** Positions worth less than this (raw USDC, 0.01) are not unwound by a Stop nor counted by a withdrawal: dust or unsolicited. */
export const POSITION_DUST_USDC = 10_000n
/** Positions a withdrawal plans from, and funding shows, at most (largest first). */
export const MAX_SIZING_POSITIONS = 16
/** Outstanding prepares per account (oldest dropped) and in all (refused past it). */
const PREPARED_PER_ACCOUNT = 4
const PREPARED_MAX = 2_000
/**
 * Gas an owner transaction is assumed to take when its sponsorship is reserved and when a Safe-paid fee is quoted: a
 * Stop closing MAX_STOP_POSITIONS positions with swaps, a withdrawal reducing MAX_SIZING_POSITIONS, stay under it.
 */
const OWNER_TX_GAS = 4_000_000n
/** Safe-paid: gas execTransaction is refunded on top of what it measures itself (intrinsic, calldata, the refund transfer). */
const SAFE_PAID_BASE_GAS = 120_000n
/** When the gas price cannot be read: 0.05 gwei, above Base's usual price. */
const FALLBACK_GAS_PRICE = 50_000_000n
/** Owner transactions under the sponsorship limits. Not activations: #82's subsidy and the failure budget hold those. */
const SPONSORED_KINDS = new Set<OwnerKind>(['transfer', 'stop', 'renew'])
/** Activations that land per Safe in any 24 h (Sol review #3); the reserve top-up itself is #82's subsidy model. */
export const ACTIVATIONS_PER_DAY = 3
/** A renewal's gas: near Base's per-tx cap, and never Safe-paid (no room for safeTxGas; a renewal is not an exit). */
const RENEW_TX_GAS = 16_500_000n
/**
 * Sol review round 2 #4: one more position may be minted only while the admitted ones fit in one bounded read
 * (MAX_INVENTORY), so every admitted position stays reachable by withdrawals and Stop. An account from before the
 * record (no list) is not limited here.
 */
export function mintAllowed(admitted: readonly string[] | undefined): boolean {
  return !admitted || admitted.length < MAX_INVENTORY
}

/** An activation's exec gas, reserved against the activation budget: Base's per-tx cap (EIP-7825), an upper bound. */
const ACTIVATE_TX_GAS = 16_777_216n
/** The Safe factory call, reserved with a sponsored transaction of a Safe not deployed yet. */
const DEPLOY_GAS = 500_000n

/**
 * Balance a sender must keep on chains with a protocol reserve. Monad (143): a transaction whose MON value transfer
 * leaves the sender under 10 MON reverts and still pays its gas (docs.monad.xyz/developer-essentials/reserve-balance;
 * the one-off "emptying" exception does not cover an activation's several relayer transactions). The relayer only
 * activates when it can pay the activation and still keep this reserve; otherwise the Start waits armed.
 */
export const SENDER_RESERVE_WEI: Readonly<Record<number, bigint>> = { 143: 10n * 10n ** 18n }

/**
 * Every `HttpError` message is either a static string or built only from values this operator
 * computed itself (an amount, an address, an asset name from a closed set, a call index) — never
 * from a caught exception's own `.message`, which could carry upstream/provider-originated text (an
 * RPC error, a URL). Audited: of every `new HttpError(...)` call site in this file, the ones that
 * used to embed `(e as Error).message` or another RPC/simulation-derived value directly
 * (account-context validation, a simulation RPC failure, owner-signature parsing, and the two
 * owner-signature-check-unavailable sites) are built with `safeHttpError` below instead, which can
 * only ever carry the fixed text for `code` — a call site cannot accidentally pass through a raw
 * exception message for one of these codes, because there is nowhere to pass one. A code already
 * covered by `safeHttpError` is never also thrown with `new HttpError` elsewhere with a different
 * literal, so this fixed text is the one and only message that code ever carries. Every other code
 * keeps its own distinct, equally safe, operator-authored text passed directly to `new HttpError`
 * (e.g. `BAD_SIGNATURE` on a proven chain revert, or `DEPOSIT_OVER_CAP`, which is always built only
 * from the live deposit amount and the constant cap, never from an exception, and must keep
 * carrying those amounts for the SPA). The real exception, redacted, still goes to the journal via
 * `logErr` at every one of the `safeHttpError` call sites.
 */
const SAFE_ERROR_MESSAGE = {
  ACCOUNT_MISMATCH: 'accountKey is bound to another Safe',
  SIMULATION_UNAVAILABLE: 'the operator could not simulate this transaction right now; try again shortly',
  BAD_SIGNATURE: 'the signature could not be verified',
  OPERATOR_ERROR: 'the operator hit an unexpected error handling this request',
  OWNER_CHECK_UNAVAILABLE: 'the signature could not be checked right now; try again in a moment',
  OWNER_FAILURE_BUDGET: `${MAX_OWNER_FAILURES_PER_DAY} activations of this account failed in 24 hours; withdrawals still work, starting again waits`,
  OPERATOR_BUSY: 'the operator is busy, try again in a moment',
} as const

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** An `HttpError` whose message can only ever be the fixed, closed-table text for `code` — see `SAFE_ERROR_MESSAGE` above. */
export function safeHttpError(status: number, code: keyof typeof SAFE_ERROR_MESSAGE): HttpError {
  return new HttpError(status, code, SAFE_ERROR_MESSAGE[code])
}

export type OperatorConfig = {
  chainId: number
  /**
   * otto/mamoru#63: the registry of the chain this operator reads (boot.ts `operatorRegistry`): pools, tokens, the
   * live pool and every contract address come from it. On a lab fork it is the registry of the forked chain.
   */
  registry: Registry
  /**
   * otto/mamoru#61: the MAMORU_CHAIN_WRITES opt-in this operator runs with (boot.ts `chainWritesFor`), set only when it
   * applies to `registry`'s chain on its own chain id. Absent: Base is the only chain written to, as always.
   */
  chainWrites?: readonly number[]
  live: boolean
  rpcUrl: string
  bundlerUrl: string
  policy: PolicyVersion
  reviewMs: number
  waitBlockMs: number
  maxWaitBlocks: number
  /** Hourly budget of the keyed RPC provider; absent: no limit. */
  rpcBudget?: RpcBudget
  /** Client of the armed watcher's batched balance reads, so the counters tell them apart; absent: the operator's client. */
  watchClient?: PublicClient
  /** Per-account cap on the USDC at Start, base units (otto/mamoru#127); absent: LIVE_CAP_USDC. Session caps are sized from it. */
  capUsdc?: bigint
  /** Depth sizing of entries for the engine (otto/mamoru#127); absent: entries are sized as before. */
  depth?: NonNullable<PolicyVersion['depth']>
  /** Spec 006 (otto/mamoru#147): engine settings per account, pulled from D1. Absent: capUsdc and depth above, as before. */
  settings?: Pick<EngineSettingsSource, 'forAccount' | 'status'> & Partial<Pick<EngineSettingsSource, 'otherSafes'>>
  /**
   * otto/mamoru#140 (part2 #5): independent providers (MAMORU_RPC_TRUSTED) that must agree, at least two of them,
   * before an owner signature the off-chain verifier refused is ever paid for. Absent or fewer than two: such a
   * signature is never sent.
   */
  trustedClients?: { label: string; client: PublicClient }[]
  /** otto/mamoru#140 (part2 #6): what the relayer pays of owner transfers and stops; tests and #147 phase 2 settings only, held to SPONSOR_BOUNDS. Absent: DEFAULT_SPONSOR. */
  sponsor?: SponsorPolicy
  /**
   * Spec 007 T7: the deployed v4 policy (conservadorLiveV4 with MamoruActionPolicy and MamoruGasPolicy, boot.ts
   * `resolveV4Policy`), set only with MAMORU_ONCHAIN_POLICY_V4=1 and both addresses. Absent: nothing of v4 exists for
   * this operator; every account resolves and renews exactly as before.
   */
  v4Policy?: PolicyVersion
  /**
   * otto/mamoru#151: the deployed v5 policy (conservadorLiveV5 with MamoruActionPolicyV2 and MamoruGasPolicy, boot.ts
   * `resolveV5Policy`), set only with the v4 opt-in and MAMORU_ACTION_POLICY_V2_ADDRESS. Absent: nothing of v5 exists.
   */
  v5Policy?: PolicyVersion
  /** otto/mamoru#129 runtime flags from the settings pull; `onchain_action_policy_v4` offers the v4 renewal per account. Absent: every flag off. */
  opsFlags?: () => Partial<Record<OpsFlagName, boolean>>
  /** otto/mamoru#172: where the shared guard reads' fee history and fallback series survive a restart (`GuardReadsState`). Absent: memory only. */
  guardReadsState?: Pick<GuardReadsState, 'load' | 'update'>
  /**
   * otto/mamoru#212: the operators that run the same Safe address on the other chains (MAMORU_PEER_OPERATORS). The cap
   * counts what the account holds there too. Absent or empty: this chain alone.
   */
  peers?: Pick<PeerExposure, 'configured' | 'read'>
}

/** Spec 007 T7: the live policies whose accounts the renew row moves to v4 (same three pools and weights). */
const V4_MIGRATES_FROM = new Set(['conservador-live-v2', 'conservador-live-v3'])
/** otto/mamoru#151: the policies whose accounts the renew row moves to v5 (MamoruActionPolicyV2): v2/v3, and v4 (V1). */
const V5_MIGRATES_FROM = new Set(['conservador-live-v2', 'conservador-live-v3', 'conservador-live-v4', 'conservador-lab-v4'])
/** Gas a v4 approval's first transaction carries besides enableSessions, per removeSession (measured: ~1.45M for 8). */
const REVOKE_GAS_EACH = 190_000n
/** The registry trust calls of a first activation, and one self-attestation call, with margin. */
const TRUST_GAS = 400_000n
const ATTEST_GAS = 150_000n
/** MamoruActionPolicy.MAX_ADMIT: positions one Init may admit. */
const MAX_ADMIT = 64

/** The owner's WebAuthn signature check on top of a Safe transaction's own gas (shared signer + P-256 verification), with margin. */
const PASSKEY_VERIFY_GAS = 300_000n

/** Safe StorageAccessible: delegatecall `targetContract` with `calldataPayload`, then revert with (success, returndata). */
const storageAccessibleAbi = parseAbi(['function simulateAndRevert(address targetContract, bytes calldataPayload)'])

const v4PolicyAbi = parseAbi([
  'function generationOf(address account) view returns (uint64)',
  'struct Config { uint32 twapWindow; uint32 twapShortWindow; uint24 bandTicks; uint64 generation; bool budgetIn1; uint32 budgetWindow; int24 anchorTick; uint24 anchorBand; uint128 perWindow; uint128 total; bytes32 initHash; }',
  'function configOf(address account, address pool) view returns (Config)',
])

/**
 * otto/mamoru#151: the one policy a renewal's grants are of. Throws when they mix policies: the summary describes one
 * policy, so a transaction carrying another's grants is never held for signing.
 */
export function renewPolicyOf(grants: readonly Pick<StoredGrant, 'grant'>[]): string | undefined {
  const ids = [...new Set(grants.map((g) => g.grant.policyId))]
  if (ids.length > 1) throw new Error(`a renewal mixes policies ${ids.join(', ')}`)
  return ids[0]
}

/** A policy whose grants need MamoruActionPolicy (v4). */
function isV4(policy: PolicyVersion): boolean {
  return policy.session.grants.some((g) => g.requiresActionPolicy)
}

type OwnerKind = 'activate' | 'transfer' | 'stop' | 'renew'

type Prepared = {
  prepareId: string
  accountKey: string
  kind: OwnerKind
  tx: SafeTx
  safeTxHash: Hex
  expires: number
  /** activate: the grants this tx enables. stop: the permissionIds it revokes. */
  grants?: StoredGrant[]
  revokes?: Hex[]
  /** renew: it only adds the grants the account lacks (see planExtend); `base` is the account's grants it was built on. */
  extend?: boolean
  base?: Hex[]
  /** transfer: what the history line shows. */
  meta?: { amountUsdc: string; asset?: string; to: Hex }
  /**
   * transfer (otto/mamoru#155): the price divergence warning this prepare returned, and each diverging swap with the
   * minimum its calldata carries. Submit runs only with this quoteId accepted and no live quote under a minimum.
   */
  divergence?: PriceDivergenceWarning
  accepted?: AcceptedSwap[]
  /** activate (spec 006): the cap, in base units, that the owner's summary named. A later raise of the cap never lets more in under this signature. */
  capUsdc?: string
  /** activate (otto/mamoru#140 part2 #3): the account's owner generation it was prepared at; any owner change since makes it stale. */
  gen?: number
  /** activate (otto/mamoru#15): wei of gas reserve the batch's own USDC -> ETH swap pays into the Safe at least (self-reserve.ts). */
  reserveWei?: string
  /** activate (otto/mamoru#15): the unix time after which that swap reverts; nothing is simulated or sent near it (reserveExpired). */
  reserveDeadline?: string
  /**
   * activate (part2 #7): a session key generated for this prepare, for an account that has none yet. It is written
   * to the account only once the owner's signature over these grants is proven.
   */
  sessionKey?: Hex
  /** transfer/stop/renew (part2 #6): what the relayer's payment is counted as; absent when the SafeTx refunds the fee from the Safe. */
  sponsorKind?: SponsoredKind
  /** stop: it only revokes grants (no position, swap or quote), so it may fall back to an emergency revocation. */
  revokeOnly?: boolean
  /** part2 #7: the Safe, lower case: open prepares are bounded per Safe, whatever accountKey asks. */
  safe?: string
  /** Safe-paid (`tx.refund`): the fee the summary named, in wei; the Safe must hold it when the transaction is sent. */
  feeWei?: string
  /**
   * renew (otto/mamoru#151, GPT-6 review P1): the policy the summary describes and every grant of `tx` is of. Submit
   * refuses it when the policy a renewal would now move the account to is another (a flag flipped since the prepare).
   */
  policyId?: string
  /** renew: it moves the account to another policy (the row's `upgrade`), not a renewal of its own. */
  move?: boolean
  /**
   * renew (otto/mamoru#151, GPT-6 round 2): a full renewal of an account on MamoruActionPolicyV2 ends a guardian pause.
   * `pauseChecked`: the pause state was read for this prepare; `pausedWarned`: it was paused and the summary says the
   * renewal ends it. Submit reads it again and refuses one whose warning no longer matches (PAUSE_STATE_CHANGED).
   */
  pauseChecked?: boolean
  pausedWarned?: boolean
}

type Runner = { engine: Engine; timer: ReturnType<typeof setTimeout> | null; stopped: boolean; /** Quick follow-up reviews in a row (see FOLLOW_UP_MS), and how many of the last did nothing. */ followUps?: number; grace?: number; /** An engine op was unsettled when this loop started: the first tick sets the observation floor past the head. */ floorPending?: boolean; /** When (ms) the next review is due. */ nextAt?: number; /** The provider's head was seen past the account's activation block. */ pastActivation?: boolean; /** When the last review that reached a decision started (ms); absent before the first. */ reviewedAt?: number; /** otto/mamoru#127, #128: buckets of the last decision whose savings wait, with why. */ waiting?: { bucket: string; pool: string | null; code: string; amountUsdc: string }[]; /** Since when the journal has had an operation left `included` (ms); absent when it has none. */ includedAt?: number; epoch: number; run: number; seen: Map<string, string>; alias: Map<string, string> }

const ENGINE_STATE: Record<OpRecord['state'], OpView['state'] | null> = {
  proposed: 'proposed',
  prepared: 'proposed',
  simulated: 'proposed',
  signed: 'submitted',
  submitted: 'submitted',
  included: 'submitted',
  pending_reconciliation: 'submitted',
  confirmed: 'confirmed',
  failed: 'failed',
  discarded: null,
}

function engineKind(k: OpRecord['kind']): OpView['kind'] {
  return k === 'close_position' ? 'exit' : k === 'harvest' || k === 'convert' || k === 'rerange' || k === 'reduce' ? 'reduce' : 'enter'
}

/**
 * The pool and, for a swap or a converting harvest, the tokens and amount: every `Proposal` kind carries a
 * `pool`, so this always has something to show the SPA, going from "the USDC/cbBTC pool" (hardcoded) to the
 * pool each history row actually acted on. otto/mamoru#131.
 */
export function opIntentView(intent: Proposal): Pick<OpView, 'pool' | 'tokenIn' | 'tokenOut' | 'amountIn' | 'convert'> {
  if (intent.kind === 'enter_swap') return { pool: intent.pool, tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, amountIn: intent.amountIn.toString() }
  if (intent.kind === 'harvest' && intent.convert) return { pool: intent.pool, convert: intent.convert.token }
  return { pool: intent.pool }
}

const now = () => new Date().toISOString()

type Progress = NonNullable<FundingView['progress']>

/** Engine op kind -> the progress line the SPA shows. close_position is the engine closing a position to re-range it. */
const ENGINE_STEP: Record<OpRecord['kind'], Progress['step']> = {
  enter_swap: 'swapping',
  enter_mint: 'opening',
  // otto/mamoru#171: adding to a held position is the same step for the owner as opening one.
  increase_liquidity: 'opening',
  close_position: 'reranging',
  harvest: 'rebalancing',
  convert: 'rebalancing',
  rerange: 'reranging',
  reduce: 'rebalancing',
}

/** Accounts activated before the operator stored a policy id per account ran this policy. */
const LEGACY_POLICY = 'conservador-live-v1'
/** Base's per-tx gas cap is 2^24 (EIP-7825). Budget the activation well under it: the relayer adds a margin on top of its estimate. */
export const BASE_TX_GAS_CAP = 16_777_216n
const ACTIVATION_GAS_BUDGET = 15_000_000n
/** A renewal revokes eight grants and enables eight in one transaction: its estimate may come closer to the cap. */
const RENEW_GAS_BUDGET = 16_200_000n
/** execTransaction, WebAuthn P-256 verify and MultiSend around the calls. */
const ACTIVATION_OVERHEAD_GAS = 600_000n
/** Measured on Base: enableSessions costs 1.4-2.1M gas per session of the live policies; 2.1M is the conservative bound. */
const STATIC_GAS_PER_SESSION = 2_100_000n
/** otto/mamoru#15: static bound for a self-funded activation's reserve swap (approve, exactInputSingle + unwrapWETH9, approve 0). */
const STATIC_GAS_RESERVE_SWAP = 300_000n
/** otto/mamoru#15: an activation whose gas reserve swap reached its deadline: it never ran and never can, the owner approves again. */
const RESERVE_SWAP_EXPIRED = 'RESERVE_SWAP_EXPIRED'

/** The engine's and left-behind grants of `acc` that a stop revoking `revokes` leaves enabled: remembered for the next stop. */
function unrevoked(acc: AccountState, revokes: Hex[]): Hex[] {
  const gone = new Set(revokes.map((id) => id.toLowerCase()))
  return [...new Set([...acc.grants.map((g) => g.permissionId), ...(acc.superseded ?? [])])].filter((id) => !gone.has(id.toLowerCase()))
}

/** `ids` without those in `gone`. */
function unrevokedIds(ids: Hex[], gone: Hex[]): Hex[] {
  const g = new Set(gone.map((id) => id.toLowerCase()))
  return ids.filter((id) => !g.has(id.toLowerCase()))
}

/** "USDC/cbBTC 0.05%" for pool:USDC/cbBTC/500. */
function poolLabel(pool: string, registry: Registry): string {
  const e = entry(pool, registry)
  return `${e.token0}/${e.token1} ${(e.fee! / 10_000).toFixed(2)}%`
}

export class Operator {
  private readonly prepared = new Map<string, Prepared>()
  private readonly locks = new Map<string, Lock>()
  private readonly runners = new Map<string, Runner>()
  private readonly reconciled = new Map<string, number>()
  /** Per account: the pending reconciliation timer and its current backoff (reconcileLater). */
  private readonly reconcileTimers = new Map<string, { timer: ReturnType<typeof setTimeout> | null; delay: number }>()
  private reconcileRetryMs = RECONCILE_RETRY_MS
  private reconcileRetryMaxMs = RECONCILE_RETRY_MAX_MS
  private shutDown = false
  /** When (ms) the engine loop last read every grant of the account (enforceGrants, invariant I1). */
  private readonly grantsChecked = new Map<string, number>()
  /** When (ms) the tracked-ids alert last fired per account. */
  private readonly grantsAlerted = new Map<string, number>()
  /** Where the engine loop's rotating grant sweep resumes, per account (enforceGrants). */
  private readonly sweepCursor = new Map<string, number>()
  /** Since when (ms) engine review has been held for a pending non-activate prepare on this account; see reviewHold. */
  private readonly reviewHeldSince = new Map<string, number>()
  private armTimer: ReturnType<typeof setTimeout> | null = null
  /** Armed watcher, in memory: when each armed Safe was last read, and when its owner was last seen (funding poll, deposit). */
  private readonly armRead = new Map<string, number>()
  private readonly armSeen = new Map<string, number>()
  private armStopped = false
  /** Owner transactions being executed right now, by accountKey. */
  private readonly busy = new Map<string, Progress>()
  private readonly seenAt = new Map<string, string>()
  /** Pause between retries of a pre-send simulation that reverts (a load-balanced provider can answer from a lagging node). */
  private retryMs = 3_000
  /** Times the off-chain signature check said no and the chain said yes, since this process started. Logged with each one. */
  mirrorMismatches = 0
  private readonly engineHealth = new EngineHealthTracker()
  /** otto/mamoru#8: per-account gas-reserve alert state, from the engine's own observation. */
  private readonly gasReserve = new GasReserveTracker()
  private readonly gasReserveAlertOverride = gasReserveAlertOverrideFromEnv()
  private relayerBalanceCache: { at: number; value: bigint } | null = null
  /** otto/mamoru#135: one readSafe shared by every open tab and poll of the same account; dropped whenever the account moves (fundingMoved). */
  private readonly fundingCache = new FundingCache<SafeRead>(Date.now, FUNDING_STALE_MS)
  /** #149: usage counters read from the chain per account (readChainUsage), keyed by lower-case permission id. */
  private readonly chainUsage = new Map<string, { at: number; grants: string; byGrant: Map<string, ChainUsage>; budgets?: Map<string, number>; paused?: boolean }>()
  /** Ops whose execTransaction went to the provider in this attempt: only then can a refusal be about a copy already out. */
  private readonly execTried = new Set<string>()
  /** Armed ops being sent again after a failed attempt: an earlier copy may have landed although its reply said no. */
  private readonly retried = new Set<string>()
  /** Passes in a row in which the block of an activation found on chain could not be read, by account. */
  private readonly recoverFails = new Map<string, number>()
  /** Until when (ms) the watcher leaves a parked armed account unread. */
  private readonly armHold = new Map<string, number>()
  /** Last time each account's activation was logged as waiting for relayer ETH. */
  private readonly relayerLowLogged = new Map<string, number>()
  /** Pool state of the last few blocks: accounts reviewed at the same block read it once. */
  private readonly poolCache = poolStateCache()
  /**
   * #172: guard history of lazy accounts, read once per pool per minute for every engine (see `SharedGuardReads`),
   * with the fee history and fallback series the cost test needs, restored from and saved to `cfg.guardReadsState`.
   */
  readonly guardReads: SharedGuardReads
  /** Uniswap V3 calls and quotes bound to `cfg.registry`. */
  private readonly v3: UniswapV3
  /** otto/mamoru#212: USDC on its way to an account's Safe from Ethereum (bridge-out), counted in its exposure. Set at boot. */
  bridgeInFlight: ((accountKey: string) => bigint) | null = null
  /** otto/mamoru#212: the peer operators' read each running engine reviews with (taken right before the review). */
  private readonly enginePeers = new Map<string, PeerRead>()

  constructor(
    readonly cfg: OperatorConfig,
    private readonly client: PublicClient,
    readonly relayer: Relayer,
    private readonly store: StateStore,
  ) {
    this.v3 = uniswapV3(cfg.registry)
    const saved = cfg.guardReadsState
    const restored = saved?.load()
    this.guardReads = new SharedGuardReads({ fees: restored?.fees, series: restored?.series, onUpdate: saved ? (s) => saved.update(s) : undefined })
  }

  /** GET /metrics: accounts known / active / armed. */
  accountsSummary(): AccountsSummary {
    const all = Object.values(this.store.state.accounts)
    return { known: all.length, active: all.filter((a) => a.active).length, armed: all.filter((a) => !!a.armed).length }
  }

  /** GET /metrics `opsRecent` (otto/mamoru#129): the newest `limit` ops across every account, newest first,
   * trimmed to accountKey (8 chars), kind, state, updatedAt and code only. */
  recentOps(limit: number): RecentOp[] {
    const all: { accountKey: string; op: StoredOp }[] = []
    for (const acc of Object.values(this.store.state.accounts)) for (const op of acc.ops) all.push({ accountKey: acc.accountKey, op })
    all.sort((a, b) => Date.parse(b.op.updatedAt) - Date.parse(a.op.updatedAt))
    return all.slice(0, limit).map(({ accountKey, op }) => ({ accountKey: accountKey.slice(0, 8), kind: op.kind, state: op.state, at: op.updatedAt, code: op.code ?? null }))
  }

  /** The Safes the snapshot loop reads (otto/mamoru#136): every active or armed account. */
  snapshotTargets(): SnapshotTarget[] {
    return Object.values(this.store.state.accounts)
      .filter((a) => a.active || !!a.armed)
      .map((a) => ({ accountKey: a.accountKey, safe: a.ctx.address, active: !!a.active, armed: !!a.armed }))
  }

  /** GET /metrics: engine health of every account with a running loop, newest-first. */
  engineHealthSnapshot(): EngineHealthSnapshot[] {
    return [...this.runners.keys()].map((key) => this.engineHealth.snapshot(key))
  }

  /** GET /metrics: gas-reserve alert state of every account with a running loop (otto/mamoru#8). */
  gasReserveSnapshot(): GasReserveSnapshot[] {
    return [...this.runners.keys()].map((key) => this.gasReserve.snapshot(key))
  }

  /**
   * GET /metrics: accounts currently below their gas-reserve alert threshold, among accounts with a running
   * loop. Derived from `gasReserveSnapshot()` itself, not `GasReserveTracker.lowCount()` (which has no notion
   * of which accounts are still running), so this count can never disagree with the per-account list next to
   * it in the payload (otto/mamoru#8 review, finding #2).
   */
  gasReserveLowCount(): number {
    return this.gasReserveSnapshot().filter((s) => s.low).length
  }

  /** GET /metrics `authorizations` (otto/mamoru#26): every known account, from memory only (no RPC). */
  authorizationsSnapshot(): AuthorizationSnapshot[] {
    return Object.values(this.store.state.accounts).map((acc) => {
      const policy = this.policyOf(acc)
      const { cap, source } = this.capOf(acc)
      const untils = acc.grants.map((g) => g.grant.userOp.validUntil).filter((v) => v > 0)
      // Multi-pool policies name the pool in the grant key; a single-pair policy's grants cover its bucket pools.
      const named = [...new Set(acc.grants.map((g) => g.name.split(':').slice(1).join(':')).filter((p) => p.startsWith('pool:')))]
      const pools = (named.length || !acc.grants.length ? named : this.bucketPools(acc)).sort()
      const view = this.approvalView(acc)
      const last = this.runners.has(acc.accountKey) ? this.engineHealth.snapshot(acc.accountKey).lastDecisionCode : null
      const holds = [
        ...(view?.expired ? ['SESSION_EXPIRED'] : view?.renewDue ? ['SESSION_RENEWAL_DUE'] : []),
        ...(view?.missing ? ['SESSION_MISSING'] : []),
        ...(view?.usage?.spent ? ['SESSION_USAGE_SPENT'] : []),
      ]
      if (last?.startsWith('SESSION_') && !holds.includes(last)) holds.push(last)
      return {
        account: acc.accountKey.slice(0, 8),
        active: acc.active,
        policyId: policy.policyId,
        policyVersion: policy.version,
        pools,
        validUntil: untils.length ? new Date(Math.min(...untils) * 1000).toISOString() : null,
        grants: this.grantUsage(acc),
        capUsdc: Number(cap / 1_000_000n),
        capSource: source,
        signedCapUsdc: Number(this.signedCapOf(acc) / 1_000_000n),
        holds,
        deactivated: acc.deactivated?.code ?? null,
      }
    })
  }

  /** GET /metrics: relayer ETH balance, cached 60s so a metrics poll never adds RPC load. */
  async relayerBalance(): Promise<{ wei: string; cachedAgeMs: number }> {
    const now = Date.now()
    if (!this.relayerBalanceCache || now - this.relayerBalanceCache.at >= RELAYER_BALANCE_CACHE_MS) {
      const value = await this.client.getBalance({ address: this.relayer.address })
      this.relayerBalanceCache = { at: now, value }
    }
    return { wei: this.relayerBalanceCache.value.toString(), cachedAgeMs: now - this.relayerBalanceCache.at }
  }

  /** Whether a transaction of the relayer is in a node's pool and not yet mined. */
  private async relayerHasPending(): Promise<boolean> {
    const [pending, latest] = await Promise.all([
      this.client.getTransactionCount({ address: this.relayer.address, blockTag: 'pending' }),
      this.client.getTransactionCount({ address: this.relayer.address, blockTag: 'latest' }),
    ])
    return pending > latest
  }

  /**
   * Whether the relayer can pay one activation now: the Safe top-up plus the deploy and execTransaction gas, or only
   * the gas when the batch buys the Safe's reserve itself (`selfFunded`, otto/mamoru#15). When it cannot, the owner's
   * signed activation waits armed instead of failing; a relayer short of ETH is ours to fix.
   */
  private async relayerCanActivate(acc: AccountState, selfFunded = false): Promise<boolean> {
    // otto/mamoru#61: ACTIVATION_GAS_WEI is in Base ETH. Off Base the deploy and the exec are priced at the chain's gas
    // price (twice it: the bound it may move to), at their full limits, as the chain charges them.
    const gasWei = this.offBase() ? (DEPLOY_GAS + ACTIVATE_TX_GAS) * (await this.gasPrice()) * 2n : ACTIVATION_GAS_WEI
    // The protocol reserve only binds a value transfer: a self-funded activation sends the Safe no MON, gas alone.
    const reserve = selfFunded ? 0n : (SENDER_RESERVE_WEI[this.cfg.registry.chainId] ?? 0n)
    const need = (selfFunded ? 0n : this.cfg.policy.gasReserveWei + (await this.topUpMarginWei())) + gasWei + reserve
    const have = BigInt((await this.relayerBalance()).wei)
    if (have >= need) return true
    const at = Date.now()
    if (at - (this.relayerLowLogged.get(acc.accountKey) ?? 0) >= RELAYER_LOW_LOG_MS) {
      this.relayerLowLogged.set(acc.accountKey, at)
      logErr(`[armed] ${acc.accountKey} relayer short of gas funds (chain reserve included), activation waits armed:`, { have: have.toString(), need: need.toString() })
    }
    return false
  }

  /**
   * otto/mamoru#140 (part2 #4): an account that ever ran before admitted positions were recorded gets, once, the
   * positions its Safe holds now as admitted: before this release only Mamoru put positions there. A Safe holding more
   * than MAX_INVENTORY gets the first MAX_INVENTORY, with an alert.
   */
  private async seedAdmitted(acc: AccountState): Promise<void> {
    if (acc.admittedTokenIds) return
    const r = await readSafe(this.client, acc.ctx.address as Address, this.cfg.registry)
    if (acc.admittedTokenIds) return
    if ((r.positionCount ?? 0) > MAX_INVENTORY) logErr('[alert]', `${acc.accountKey} holds ${r.positionCount} position NFTs: admitted seeded from the first ${MAX_INVENTORY} only`)
    acc.admittedTokenIds = r.positions.map((p) => p.tokenId.toString())
    this.store.save()
    console.log(`[admitted] ${acc.accountKey} seeded with ${acc.admittedTokenIds.length} position(s)`)
  }

  /**
   * otto/mamoru#163, read only, once at boot: owner activations and renewals closed as OWNER_TX_FAILED before this
   * change that may have enabled grants the operator does not track. Their Safe nonce not moved past theirs: the
   * signature can still be relayed by anyone. Moved past it: the block that spent it is read (spentBy); the op is
   * dismissed only when that block proves its own Safe tx did not succeed there (another Safe tx, or its own
   * ExecutionFailure). Its own ExecutionSuccess (a later relay of the reverted signature) means its grants are enabled
   * and must be revoked; no conclusion means a check by hand. Logged for the coordinator; nothing is changed. Returns
   * how many were found.
   */
  async scanRevertedExposure(): Promise<number> {
    let exposed = 0
    for (const acc of Object.values(this.store.state.accounts)) {
      const ops = acc.ops.filter((o) => o.opId.startsWith('own-') && RELAYABLE_KINDS.has(o.kind) && o.state === 'failed' && o.code === 'OWNER_TX_FAILED') as StoredOp[]
      if (!ops.length) continue
      let nonce: bigint | null = null
      try {
        nonce = (await readSafeNonce(this.client, acc.ctx.address as Address)).nonce
      } catch (e) {
        logErr(`[exposure#163] ${acc.accountKey} Safe nonce unreadable:`, e)
      }
      for (const o of ops) {
        const at = `${acc.accountKey} ${o.opId} ${o.kind} tx ${o.txHash ?? '-'} at ${o.updatedAt} safe ${acc.ctx.address}`
        if (o.safeNonce === undefined) {
          exposed++
          console.log(`[exposure#163] ${at}: reverted, its Safe nonce was not kept (Safe now at ${nonce ?? 'unknown'}); check by hand`)
        } else if (nonce === null || nonce <= BigInt(o.safeNonce)) {
          exposed++
          console.log(`[exposure#163] ${at}: reverted at Safe nonce ${o.safeNonce}, Safe now at ${nonce ?? 'unknown'}: its signature is still relayable`)
        } else {
          // Past its nonce: whatever spent it may be this very signature, relayed after the revert.
          const grants = (o.ownerGrants ?? []).map((g) => g.permissionId).join(',') || 'none kept'
          let spent: SpentBy | null = null
          if (o.safeTxHash) {
            try {
              const head = await this.client.getBlockNumber({ cacheTime: 0 })
              spent = await this.spentBy(acc, o, head)
            } catch (e) {
              logErr(`[exposure#163] ${acc.accountKey} ${o.opId} spending block unreadable:`, e)
            }
          }
          if (spent && (!spent.ours || !spent.success)) continue
          exposed++
          if (spent) console.log(`[exposure#163] ${at}: reverted at Safe nonce ${o.safeNonce}, then relayed and executed in tx ${spent.tx} at block ${spent.block}: its grants are enabled (${grants}); revoke them`)
          else console.log(`[exposure#163] ${at}: reverted at Safe nonce ${o.safeNonce}, Safe now at ${nonce}: what spent that nonce is not proven${o.safeTxHash ? '' : ' (no Safe tx hash kept)'}; its grants (${grants}) may be enabled, check by hand`)
        }
      }
    }
    if (exposed) logErr('[alert]', `${exposed} reverted owner activation/renewal op(s) may still be relayable: see [exposure#163] lines`)
    return exposed
  }

  /** Restarts the engine loop of every account that was active. */
  resume(): void {
    // otto/mamoru#63: off Base no engine loop, armed watcher or reconciliation starts: the operator only reads.
    const refusal = this.writeRefusal()
    if (refusal) {
      const active = Object.values(this.store.state.accounts).filter((a) => a.active || a.armed).length
      console.log(`[operator] ${refusal}${active ? `; ${active} active or armed account(s) left untouched` : ''}`)
      return
    }
    void this.scanRevertedExposure().catch((e) => logErr('[exposure#163] scan failed:', e))
    for (const acc of Object.values(this.store.state.accounts)) if (acc.active) this.startLoop(acc)
    for (const acc of Object.values(this.store.state.accounts)) {
      if (acc.trusted && !acc.admittedTokenIds) void this.lock(acc.accountKey).run(() => this.seedAdmitted(acc)).catch((e) => logErr(`[admitted] ${acc.accountKey} not seeded:`, e))
    }
    // An approval a restart caught mid-attempt: once its execTransaction was out, the receipt settles it; before
    // that it is simply armed again.
    for (const acc of Object.values(this.store.state.accounts)) {
      const op = acc.armed && acc.ops.find((o) => o.opId === acc.armed!.opId)
      if (!op || acc.active) continue
      // Armed before ops kept their Safe tx hash: reconciliation matches the execution by it.
      ;(op as StoredOp).safeTxHash ??= acc.armed!.safeTxHash
      ;(op as StoredOp).safeNonce ??= acc.armed!.tx.nonce.toString()
      if (op.txHash) {
        acc.armed = undefined
        this.failOwner(acc, op, RECEIPT_UNKNOWN)
      } else {
        if (op.state !== 'proposed' || op.code !== 'ARMED') this.patchOp(acc, op.opId, { state: 'proposed', code: 'ARMED' })
        // Handed to a provider with no hash kept: it may be pending. The same full wait as after any handover (see
        // retryAt) before anything is sent again; the nonce read on each pass then finds it.
        if (acc.armed!.execSent) acc.armed = { ...acc.armed!, retryAt: Math.max(acc.armed!.retryAt ?? 0, Date.now() + ARM_RETRY_MAX_MS) }
      }
    }
    // An owner transaction that was out when the process stopped is still `submitted` in the state file and nobody
    // is waiting for its receipt any more. It becomes an unread receipt: reconciliation settles it from the chain,
    // and it does not hold what waits on it (a renewal, the app) for ever. Not charged to the owner's budget.
    let recovered = false
    for (const acc of Object.values(this.store.state.accounts)) {
      for (const op of acc.ops) {
        // `proposed` too: the op is stored before its task takes the account lock, and that task did not survive;
        // whether it reached the chain is for the chain to say. A `submitted` one is recovered whatever its age (it
        // was sent). A `proposed` one only from the last day: the state file holds unsigned prepares from weeks
        // ago, and as unread receipts reconciliation would look for them for ever.
        if (!op.opId.startsWith('own-') || acc.armed?.opId === op.opId) continue
        const recent = Date.now() - (Date.parse(op.updatedAt) || 0) < DAY_MS
        if (op.state === 'submitted' || (op.state === 'proposed' && recent)) {
          // Its time is kept: findOwnerTx looks for the transaction around when it was sent, not around this restart.
          Object.assign(op, { state: 'failed', code: RECEIPT_UNKNOWN })
          recovered = true
        }
      }
    }
    if (recovered || Object.values(this.store.state.accounts).some((a) => a.armed)) this.store.save()
    for (const acc of Object.values(this.store.state.accounts)) this.reconcileSoon(acc)
    const armed = Object.values(this.store.state.accounts).filter((a) => a.armed).length
    if (armed) console.log(`[armed] ${armed} armed activation(s) reloaded`)
    this.armStopped = false
    this.armTimer = setTimeout(() => this.watchArmed(), 0)
  }

  shutdown(): void {
    this.armStopped = true
    this.shutDown = true
    for (const t of this.reconcileTimers.values()) if (t.timer) clearTimeout(t.timer)
    this.reconcileTimers.clear()
    if (this.armTimer) clearTimeout(this.armTimer)
    for (const r of this.runners.values()) {
      r.stopped = true
      if (r.timer) clearTimeout(r.timer)
    }
  }

  private lock(key: string): Lock {
    let l = this.locks.get(key)
    if (!l) this.locks.set(key, (l = new Lock()))
    return l
  }

  /**
   * The stored account for this context; the Safe address is recomputed from the context and must match, in both
   * directions (otto/mamoru#140 part1 #6): an accountKey keeps the same Safe, and a Safe is never known under a
   * second accountKey — a compromised app Worker cannot alias a fresh accountKey onto an address already tracked,
   * to slip past that Safe's lock or its owner-failure budget. `readOnly` (GET /funding, GET /ops): an accountKey
   * never seen before gets the same empty view any new account would, but it is not written into the state file —
   * a compromised Worker (or a scripted GET loop) cannot grow the account store or trigger a disk write with reads.
   */
  account(ctx: AccountContext, opts: { readOnly?: boolean } = {}): { acc: AccountState; live: LiveAccount } {
    if (ctx.chainId !== this.cfg.chainId) throw new HttpError(400, 'CHAIN_MISMATCH', `account is on ${ctx.chainId}, operator on ${this.cfg.chainId}`)
    let live: LiveAccount
    try {
      live = liveAccountFromContext(ctx, this.cfg.registry)
    } catch (e) {
      logErr('[http] account context rejected:', e)
      throw safeHttpError(400, 'ACCOUNT_MISMATCH')
    }
    let acc = this.store.state.accounts[ctx.accountKey]
    if (!acc) {
      const other = Object.values(this.store.state.accounts).find((a) => a.ctx.address.toLowerCase() === ctx.address.toLowerCase())
      if (other) throw new HttpError(409, 'ACCOUNT_MISMATCH', 'this Safe is already known under another accountKey')
      acc = { accountKey: ctx.accountKey, ctx, trusted: false, active: false, grants: [], revoked: [], managedTokenIds: [], depositsAfter: '0', historyFromBlock: '0', epoch: 0, ops: [], seq: 0 }
      if (!opts.readOnly) {
        this.store.state.accounts[ctx.accountKey] = acc
        this.store.save()
      }
    } else if (acc.ctx.address.toLowerCase() !== ctx.address.toLowerCase()) {
      throw new HttpError(409, 'ACCOUNT_MISMATCH', 'accountKey is bound to another Safe')
    }
    return { acc, live }
  }

  /**
   * otto/mamoru#140 (part2 #7): the account written into the state file. Prepares run on a readOnly view of an
   * account never seen before; it is stored once an owner signature for it is proven (submit), so a caller that only
   * prepares never grows the state file. The record already stored wins over the view.
   */
  private persist(acc: AccountState): AccountState {
    const have = this.store.state.accounts[acc.accountKey]
    if (have) return have
    // Synchronous with the write: two first submits for one Safe under two accountKeys can both pass account()'s
    // check across their awaits; only one is stored (Sol review #1).
    const safe = acc.ctx.address.toLowerCase()
    if (Object.values(this.store.state.accounts).some((a) => a.ctx.address.toLowerCase() === safe)) throw new HttpError(409, 'ACCOUNT_MISMATCH', 'this Safe is already known under another accountKey')
    this.store.state.accounts[acc.accountKey] = acc
    this.store.save()
    return acc
  }

  /** The per-account cap at Start (otto/mamoru#127, #26): see capOf. */
  capFor(acc: AccountState): bigint {
    return this.capOf(acc).cap
  }

  /**
   * The per-account cap at Start and where it came from: the account's own cap (otto/mamoru#26), else its engine
   * settings (spec 006: canary, else environment), else configured, else the code default. `emergency`: the local
   * emergency file or MAMORU_CAP_USDC.
   */
  capOf(acc: AccountState): { cap: bigint; source: CapSource } {
    // With settings, they are the whole answer (the env override is already merged into them, and an account cap is
    // dropped under it): no fall-through to the env cap.
    const s = this.cfg.settings?.forAccount(acc.accountKey)
    if (!s) return this.cfg.capUsdc !== undefined ? { cap: this.cfg.capUsdc, source: 'emergency' } : { cap: LIVE_CAP_USDC, source: 'default' }
    const own = s.accountCapUsdc ?? null
    const cap = own !== null ? BigInt(own) * 1_000_000n : (capBaseUnits(s.settings) ?? LIVE_CAP_USDC)
    // The same rule as the boot check on MAMORU_CAP_USDC, for pulled settings and account caps alike: a cap above the
    // default needs depth sizing actually applied to this account, which happens under a target-weights policy only.
    // Otherwise the account keeps the default cap and the status names it.
    if (cap > LIVE_CAP_USDC && (!s.settings.depth || this.policyOf(acc).allocation !== 'target-weights')) {
      if (!this.capRefused.has(acc.accountKey)) console.log(`[alert] engine settings: ${own !== null ? 'account cap' : 'cap'} ${fmtUsdc(cap)} refused for ${acc.accountKey.slice(0, 8)} (${s.settings.depth ? `policy ${this.policyOf(acc).policyId} cannot size entries to depth` : 'depth sizing is off'}); default cap kept`)
      this.capRefused.add(acc.accountKey)
      return { cap: LIVE_CAP_USDC, source: 'default' }
    }
    this.capRefused.delete(acc.accountKey)
    const source: CapSource =
      own !== null ? 'override' : s.source === 'local' || s.override.includes('capUsdc') ? 'emergency' : s.settings.capUsdc === null ? 'default' : s.canary ? 'canary' : 'env'
    return { cap, source }
  }

  /** Accounts whose pulled cap was refused by capFor; reported in /metrics. */
  private readonly capRefused = new Set<string>()

  /**
   * The cap an activation runs under: the current one, never above the cap its signed summary named. An approval
   * prepared or armed before spec 006 carries no cap: it was signed under LIVE_CAP_USDC (the default; above it the
   * operator would not have started without MAMORU_DEPTH), so that is its ceiling, never the current cap.
   */
  activationCap(acc: AccountState, signed?: string): bigint {
    const now = this.capFor(acc)
    const ceiling = signed && /^[0-9]+$/.test(signed) ? BigInt(signed) : LIVE_CAP_USDC
    return ceiling < now ? ceiling : now
  }

  /** The cap the account's grants were sized for (spec 006). */
  signedCapOf(acc: AccountState): bigint {
    return acc.signedCapUsdc && /^[0-9]+$/.test(acc.signedCapUsdc) ? BigInt(acc.signedCapUsdc) : LIVE_CAP_USDC
  }

  /** One line when the plan now allows a different cap than the one these grants carry. */
  private capNotice(acc: AccountState, cap: bigint): string[] {
    const now = this.capFor(acc)
    return now === cap ? [] : [`Your plan now allows up to ${fmtUsdc(now)} USDC per account; this approval keeps the ${fmtUsdc(cap)} USDC limits you signed`]
  }

  /**
   * otto/mamoru#212: the cap the account's total across chains is held to. Before Start, the current cap (the
   * activation then runs under the cap the owner signs). Running: the current cap, never above the one its grants were
   * signed for; a higher cap takes a renewal, which funding offers (`approval.capRaise`).
   */
  effectiveCap(acc: AccountState): bigint {
    return acc.active ? this.activationCap(acc, acc.signedCapUsdc) : this.capFor(acc)
  }

  /** otto/mamoru#212: this chain's share of the account's exposure, valued as funding shows it (idle tokens, positions). */
  private localExposure(acc: Pick<AccountState, 'accountKey' | 'admittedTokenIds' | 'active'>, r: SafeRead): ChainExposure {
    const reg = this.cfg.registry
    // Every position Mamoru admitted (up to MAX_INVENTORY), not only the MAX_SIZING_POSITIONS largest a withdrawal plans from.
    const positions = this.heldPositions(acc, r).map((p) => positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, reg))
    return exposureOf(this.cfg.chainId, idleTokens(r, reg), positions, this.bridgeInFlight?.(acc.accountKey) ?? 0n, acc.active)
  }

  /**
   * otto/mamoru#212: the owner's other Safes (an owner holding more than one address in its environment, from the
   * settings pull). Normally none: a Base account and its sleeves share one address.
   */
  private otherSafes(acc: AccountState): Address[] {
    const own = acc.ctx.address.toLowerCase()
    return [...new Set((this.cfg.settings?.otherSafes?.(acc.accountKey) ?? []).map((a) => a.toLowerCase()))].filter((a) => a !== own) as Address[]
  }

  /** Whether the cap of this account needs anything read beyond this chain's Safe. */
  private readsElsewhere(acc: AccountState): boolean {
    return !!this.cfg.peers?.configured || this.otherSafes(acc).length > 0
  }

  /**
   * otto/mamoru#212: everything the account's owner holds outside this chain's Safe: the same address on the peer
   * chains, and any other Safe of the owner here and on the peer chains. Never throws: a failure reads `ok: false`.
   */
  private async peerRead(acc: AccountState, maxAgeMs: number): Promise<PeerRead> {
    const peers = this.cfg.peers
    const others = this.otherSafes(acc)
    let out: PeerRead = { ok: true, chains: [] }
    try {
      for (const address of peers?.configured ? [acc.ctx.address as Address, ...others] : []) out = joinReads(out, await peers!.read(address, maxAgeMs))
      for (const address of others) {
        const sibling = Object.values(this.store.state.accounts).find((a) => a.ctx.address.toLowerCase() === address)
        const r = sibling ? await this.readSafeCached(sibling, getAddress(address), maxAgeMs <= PEER_START_MAX_AGE_MS) : await readSafe(this.client, getAddress(address), this.cfg.registry)
        out = joinReads(out, { ok: true, chains: [this.localExposure(sibling ?? { accountKey: '', admittedTokenIds: undefined, active: false }, r)] })
      }
      return out
    } catch (e) {
      logErr(`[peer] ${acc.accountKey} exposure read failed:`, e)
      return { ok: false, chainId: 0 }
    }
  }

  /** otto/mamoru#212: what this chain holds for the account now (a live read), for the Start checks after prepare. */
  private async localTotal(acc: AccountState, safe: Address): Promise<bigint> {
    return totalOf(this.localExposure(acc, await this.readOf(acc, safe)))
  }

  /**
   * otto/mamoru#212: the account's total across chains for a Start check, `local` being what this chain holds. A peer
   * that cannot be read refuses the Start (CAP_CHECK_UNAVAILABLE): nothing new is placed on a guess.
   */
  private async startTotal(acc: AccountState, local: bigint): Promise<{ total: bigint; across: boolean }> {
    const peers = await this.peerRead(acc, PEER_START_MAX_AGE_MS)
    if (!peers.ok) throw capCheckUnavailable()
    const elsewhere = peers.chains.reduce((s, e) => s + totalOf(e), 0n)
    return { total: local + elsewhere, across: elsewhere > 0n }
  }

  /** otto/mamoru#212: the cap an engine review places within (`Observation.cap`), from the read taken before it. */
  private engineCap(acc: AccountState): NonNullable<Observation['cap']> {
    const peers: PeerRead = this.readsElsewhere(acc) ? (this.enginePeers.get(acc.accountKey) ?? { ok: false, chainId: 0 }) : { ok: true, chains: [] }
    return { capUsdc: this.effectiveCap(acc), elsewhereUsdc: elsewhereOf(peers) }
  }

  /**
   * otto/mamoru#212: GET /internal/exposure/<address>, what a peer operator counts of this Safe on this chain. Read only:
   * an address no account here uses is read from the chain and stored nowhere.
   */
  async exposureFor(address: Address): Promise<ExposureWire> {
    const safe = getAddress(address)
    const acc = Object.values(this.store.state.accounts).find((a) => a.ctx.address.toLowerCase() === safe.toLowerCase())
    // A read at most FUNDING_FRESH_READ_MS old: the caller's own cache age then bounds how old the balances are.
    const r = acc ? await this.readSafeCached(acc, safe, true) : await readSafe(this.client, safe, this.cfg.registry)
    const e = this.localExposure(acc ?? { accountKey: '', admittedTokenIds: undefined, active: false }, r)
    return { chainId: this.cfg.chainId, address: safe.toLowerCase(), block: r.block.toString(), idleUsdc: e.idleUsdc.toString(), placedUsdc: e.placedUsdc.toString(), active: e.active }
  }

  settingsStatus(): (ReturnType<EngineSettingsSource['status']> & { capRefused: string[] }) | null {
    const s = this.cfg.settings?.status()
    return s ? { ...s, capRefused: [...this.capRefused].map((k) => k.slice(0, 8)) } : null
  }

  private readonly settingsPolicies = new Map<string, PolicyVersion>()

  /**
   * The fall guard (#101) reads the 24 h history of the volatile buckets' pools; the lazy re-range (#172) the volatility
   * and fee growth of every pool it may re-range in. Nothing is read while both are off.
   */
  guardHistoryOf(policy: PolicyVersion): EngineConfig['guardHistory'] {
    const guarded = policy.guards ? policy.buckets.filter((b) => policy.guards?.byBucket[b.id]?.fallFreeze).map((b) => b.pools[0]).filter((p): p is NonNullable<typeof p> => !!p) : []
    const lazy = policy.range.lazy ? policy.buckets.flatMap((b) => b.pools) : []
    const pools = [...new Set([...guarded, ...lazy])] as RegistryName[]
    if (!pools.length) return undefined
    // Guard-only accounts keep their own reads pinned to their block, as before.
    return policy.range.lazy ? { pools, shared: this.guardReads } : { pools }
  }

  /** Spec 006: new settings reach every running engine on its next review; nothing restarts. */
  retuneEngines(): void {
    for (const [key, runner] of this.runners) {
      const acc = this.store.state.accounts[key]
      if (!acc) continue
      try {
        const policy = this.enginePolicyOf(acc)
        runner.engine.retune(policy, this.guardHistoryOf(policy))
      } catch (e) {
        logErr(`[settings] ${key} not retuned:`, e)
      }
    }
  }

  private readonly depthPolicies = new WeakMap<PolicyVersion, PolicyVersion>()

  /**
   * The policy the engine decides with: the account's, plus depth sizing when the operator is configured for it.
   * Grants are always built from `policyOf`: depth sizing changes how much an entry places, never what a session allows.
   */
  enginePolicyOf(acc: AccountState): PolicyVersion {
    const p = this.withAccountBudgets(acc, this.policyOf(acc))
    if (this.cfg.settings) {
      // Spec 006: depth sizing and the guard come from the account's engine settings. Memoized per settings, so an
      // unchanged version hands every review the same policy object.
      const s = this.cfg.settings.forAccount(acc.accountKey).settings
      // A v4 account's policy carries its own budgets (withAccountBudgets): its signed cap is part of the key.
      const key = `${p.policyId}@${p.version}${isV4(p) ? ` cap ${this.signedCapOf(acc)}` : ''} ${canonicalSettingsJson(s)}`
      let d = this.settingsPolicies.get(key)
      if (!d) {
        d = withEngineSettings(p, s)
        this.settingsPolicies.set(key, d)
      }
      return d
    }
    const depth = this.cfg.depth
    if (!depth || p.allocation !== 'target-weights') return p
    let d = this.depthPolicies.get(p)
    if (!d) {
      d = { ...p, depth }
      this.depthPolicies.set(p, d)
    }
    return d
  }

  /** The policy the account was activated with; accounts activated before policy ids were stored run conservador-live-v1. */
  policyOf(acc: AccountState): PolicyVersion {
    if (!acc.policyId) return acc.active || acc.grants.length ? (POLICIES[LEGACY_POLICY] ?? this.cfg.policy) : this.cfg.policy
    const p = POLICIES[acc.policyId]
    if (p) return p
    // Spec 007 T7: a v4 account resolves only to the deployed v4 policy this operator was configured with.
    if (this.cfg.v4Policy?.policyId === acc.policyId) return this.cfg.v4Policy
    if (this.cfg.v5Policy?.policyId === acc.policyId) return this.cfg.v5Policy
    if (this.cfg.policy.policyId === acc.policyId) return this.cfg.policy
    throw new Error(`${acc.accountKey}: unknown policy ${acc.policyId}`)
  }

  /**
   * Spec 007 T7 (d): the v4 policy the renew row moves this account to, or null: v4 configured (env opt-in and both
   * deployed addresses), the `onchain_action_policy_v4` ops flag on, the account running on a v2/v3 policy of the
   * same chain. Accounts that never tap keep their grants.
   */
  v4Target(acc: AccountState): PolicyVersion | null {
    if (!acc.active) return null
    let cur: PolicyVersion
    try {
      cur = this.policyOf(acc)
    } catch {
      return null
    }
    const flags = this.cfg.opsFlags?.()
    // otto/mamoru#151: MamoruActionPolicyV2 deployed and offered: v2/v3 and v4 accounts move to v5.
    const v5 = this.cfg.v5Policy
    if (v5 && flags?.onchain_action_policy_v5 === true && V5_MIGRATES_FROM.has(cur.policyId) && cur.chain === v5.chain) return v5
    const v4 = this.cfg.v4Policy
    if (!v4 || flags?.onchain_action_policy_v4 !== true) return null
    return V4_MIGRATES_FROM.has(cur.policyId) && cur.chain === v4.chain ? v4 : null
  }

  private readonly v4Sized = new Map<string, PolicyVersion>()

  /**
   * Spec 007 T7: a v4 account's engine policy with its own budgets (W_p, T_p at the cap it signed: the same values its
   * Inits carry), so precheck mirrors the budget check. Unchanged for every other policy.
   */
  private withAccountBudgets(acc: AccountState, p: PolicyVersion): PolicyVersion {
    const ap = p.actionPolicy
    if (!ap || !isV4(p)) return p
    const cap = this.signedCapOf(acc)
    const key = `${p.policyId}@${p.version} ${ap.address} ${cap}`
    let sized = this.v4Sized.get(key)
    if (!sized) {
      const pools = Object.values(V4_POOLS).filter((v) => p.buckets.some((b) => b.pools.includes(v.pool)))
      sized = withActionPolicy(p, ap.address, pools, { caps: v4BudgetCaps(p, cap), ...(ap.gasPolicy ? { gasPolicy: ap.gasPolicy } : {}), ...(ap.bandFactorBps !== undefined ? { bandFactorBps: ap.bandFactorBps } : {}), ...(ap.twapShortWindowSeconds !== undefined ? { twapShortWindowSeconds: ap.twapShortWindowSeconds } : {}), ...(ap.contractVersion ? { contractVersion: ap.contractVersion } : {}) })
      this.v4Sized.set(key, sized)
    }
    return sized
  }

  private bucketPools(acc: AccountState): string[] {
    return this.policyOf(acc).buckets.flatMap((b) => b.pools)
  }

  /**
   * Until when the engine's grants of a running account are valid (the earliest of them), and whether the renewal
   * is due: inside the policy's renewal window, or already lapsed. Null when the account is not running.
   */
  private approvalView(acc: AccountState): FundingView['approval'] {
    if (!acc.active) return null
    const untils = acc.grants.map((g) => g.grant.userOp.validUntil).filter((v) => v > 0)
    if (!untils.length) return null
    const validUntil = Math.min(...untils)
    const left = validUntil - Math.floor(Date.now() / 1000)
    const missing = this.missingGrants(acc).length
    const usage = this.usageView(acc)
    const target = this.v4Target(acc)
    const upgrade = target !== null
    const paused = this.chainUsage.get(acc.accountKey)?.paused === true
    // otto/mamoru#212: the cap was raised above the one these grants were signed for; a full renewal signs the new one.
    const cap = this.capFor(acc)
    const signed = this.signedCapOf(acc)
    const capRaise = cap > signed ? { capUsdc: cap.toString(), signedUsdc: signed.toString() } : null
    return { validUntil, renewDue: left <= this.policyOf(acc).session.renewalWindowSeconds, expired: left <= 0, policyId: this.policyOf(acc).policyId, ...(missing ? { missing } : {}), ...(usage ? { usage } : {}), ...(upgrade ? { upgrade, upgradePolicy: target.policyId } : {}), ...(paused ? { paused } : {}), ...(capRaise ? { capRaise } : {}) }
  }

  /**
   * otto/mamoru#149: how much of what its approval allows each engine grant has used, in bps (its usage limit or, for
   * an entry grant, its fullest cumulative cap), counted by the chain or the operator's own count, whichever is
   * higher; then a v4 account's per-pool MamoruActionPolicy budgets as `enter-swap:<pool>`. In memory, no RPC.
   */
  private grantUsage(acc: AccountState): { grant: string; usedBps: number }[] {
    const ledger = this.runners.get(acc.accountKey)?.engine.ledger
    const chain = this.chainUsage.get(acc.accountKey)?.byGrant
    const out: { grant: string; usedBps: number }[] = []
    for (const g of acc.grants) {
      const u = ledger?.usageOf(g.permissionId)
      const limit = g.grant.userOp.usageLimit
      const id = g.permissionId.toLowerCase()
      const c = chain?.get(id)
      const own = u?.used ?? acc.ops.filter((o) => o.state === 'confirmed' && o.permissionId?.toLowerCase() === id).length
      const used = Math.max(own, c?.used ?? 0)
      const usedBps = Math.max(limit > 0 ? Math.floor((used * 10_000) / limit) : 10_000, u?.spentBps ?? 0, c?.spentBps ?? 0)
      out.push({ grant: g.name, usedBps })
    }
    // Spec 007 T7 (e): a v4 account's MamoruActionPolicy budget per pool (T_p, charged by swaps and mints) counts the
    // same way, as the pool's entry: the renewal (a new generation) starts it from zero before it binds.
    for (const [pool, usedBps] of this.chainUsage.get(acc.accountKey)?.budgets ?? []) {
      out.push({ grant: `enter-swap:${pool}`, usedBps })
    }
    return out
  }

  /**
   * otto/mamoru#149: the engine grant closest to the end of what its approval allows, once it has used USAGE_RENEW_BPS
   * of it: its usage limit (userOps included under it) or, for an entry grant, its fullest cumulative cap. Counted by
   * the chain (refreshChainUsage: uses made with the key by anyone), or by the operator's own count where that is
   * higher or the chain was not read. The renewal row offers a renewal from then on, so the engine is never blocked
   * silently; `spent` says it already is (SESSION_USAGE_SPENT). Null when every grant is under the threshold.
   */
  usageView(acc: AccountState): NonNullable<NonNullable<FundingView['approval']>['usage']> | null {
    let worst: { grant: string; usedBps: number } | null = null
    for (const u of this.grantUsage(acc)) if (!worst || u.usedBps > worst.usedBps) worst = u
    if (!worst || worst.usedBps < USAGE_RENEW_BPS) return null
    const pool = worst.grant.split(':').slice(1).join(':')
    const name = worst.grant.split(':')[0]!
    const action = name === 'convert-any' ? 'collect' : name === 'manage-any' ? 'rerange' : 'enter'
    return { action, pool: pool.startsWith('pool:') ? pool : null, usedBps: Math.min(worst.usedBps, 10_000), spent: worst.usedBps >= 10_000 }
  }

  /**
   * Grants of the account's policy that it does not hold: the manage-any/convert-any pairs an activation (or a
   * renewal) left out to fit Base's per-tx gas cap. Without them the engine cannot re-range, reduce or harvest in that
   * pool (SESSION_MISSING); one more owner approval adds them (planExtend).
   */
  private missingGrants(acc: AccountState): string[] {
    const have = new Set(acc.grants.map((g) => g.name))
    return this.policyOf(acc).session.grants.filter((g) => !g.perPosition).map(grantKey).filter((k) => !have.has(k))
  }

  /** The manage-any/convert-any keys of one pool per entry, lowest-preference bucket first: what is left out first when a grant set does not fit one transaction. */
  private droppablePairs(policy: PolicyVersion, keys: string[]): string[][] {
    return [...policy.buckets]
      .sort((a, b) => a.preference - b.preference)
      .flatMap((b) => b.pools)
      .map((pool) => keys.filter((k) => (k.startsWith('manage-any') || k.startsWith('convert-any')) && (k.endsWith(`:${pool}`) || !k.includes(':'))))
      .filter((ks) => ks.length > 0)
  }

  /**
   * #149: the usage counters of the account's grants as the chain has them, at most CHAIN_USAGE_TTL_MS old. A use the
   * operator did not make (the key used elsewhere) is logged; either way the larger count is what the row follows.
   */
  private async refreshChainUsage(acc: AccountState): Promise<void> {
    if (!acc.active || !acc.grants.length) return
    const ids = acc.grants.map((g) => g.permissionId.toLowerCase()).join(',')
    const had = this.chainUsage.get(acc.accountKey)
    if (had && had.grants === ids && Date.now() - had.at < CHAIN_USAGE_TTL_MS) return
    // Taken before the read, so a slow or failing RPC is not asked again on every poll.
    this.chainUsage.set(acc.accountKey, { at: Date.now(), grants: ids, byGrant: had?.grants === ids ? had.byGrant : new Map() })
    const byGrant = await readChainUsage(this.client as never, acc.ctx.address as Address, acc.grants, this.cfg.registry)
    const budgets = await this.readBudgets(acc)
    const paused = (await this.readPaused(acc)) === true
    if (!byGrant.size && !budgets?.size && !paused) return
    this.chainUsage.set(acc.accountKey, { at: Date.now(), grants: ids, byGrant, ...(budgets?.size ? { budgets } : {}), ...(paused ? { paused } : {}) })
    const ledger = this.runners.get(acc.accountKey)?.engine.ledger
    for (const g of acc.grants) {
      const c = byGrant.get(g.permissionId.toLowerCase())
      const own = ledger?.usesOf(g.permissionId) ?? acc.ops.filter((o) => o.state === 'confirmed' && o.permissionId?.toLowerCase() === g.permissionId.toLowerCase()).length
      if (c && c.used > own) console.log(`[usage] ${acc.accountKey} ${g.name}: the chain counts ${c.used} uses, the operator ${own}`)
    }
  }

  /**
   * otto/mamoru#151: whether MamoruActionPolicyV2's guardian has paused this account (v5 only; false for any other policy;
   * null when the read fails). The renew row says so, and a renewal is not prepared without knowing: it ends a pause.
   */
  private async readPaused(acc: AccountState, blockNumber?: bigint): Promise<boolean | null> {
    let p: PolicyVersion
    try {
      p = this.policyOf(acc)
    } catch {
      return false
    }
    const ap = p.actionPolicy
    if (!ap || ap.contractVersion !== 2) return false
    try {
      return await this.client.readContract({ address: ap.address, abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', args: [acc.ctx.address as Address], ...(blockNumber !== undefined ? { blockNumber } : {}) })
    } catch (e) {
      // GPT-6 review of the v2 diffs (P1): an unreadable pause is not "not paused". null: the renewal refuses to prepare.
      logErr(`[v5] ${acc.accountKey} isPaused unreadable:`, e)
      return null
    }
  }

  /** Spec 007 T7 (e): the v4 account's policy budgets used per pool (bps of T_p), from the chain; undefined for any other account. */
  private async readBudgets(acc: AccountState): Promise<Map<string, number> | undefined> {
    let p: PolicyVersion
    try {
      p = this.policyOf(acc)
    } catch {
      return undefined
    }
    if (!isV4(p) || !p.actionPolicy) return undefined
    const pools = [...new Set(acc.grants.map((g) => g.grant.pool).filter((x): x is NonNullable<typeof x> => !!x))].map((name) => ({ name, address: address(name, this.cfg.registry) }))
    return readPolicyBudgets(this.client as never, p.actionPolicy.address, acc.ctx.address as Address, pools, budgetUsedBps)
  }

  /** `fresh`: a read at most FUNDING_FRESH_READ_MS old (a deposit lands without anything of the account moving). */
  async funding(ctx: AccountContext, fresh = false): Promise<FundingView> {
    const { acc, live } = this.account(ctx, { readOnly: true })
    // In the background: the row follows on the next poll, and a slow read never holds the balance up.
    void this.refreshChainUsage(acc).catch((e) => logErr(`[usage] ${acc.accountKey}`, e))
    // The app is open on this account: an armed activation is watched at full pace again.
    if (acc.armed) this.armSeen.set(acc.accountKey, Date.now())
    const [r, peers] = await Promise.all([this.readSafeCached(acc, live.safe, fresh), this.peerRead(acc, PEER_FUNDING_MAX_AGE_MS)])
    // otto/mamoru#212: the cap holds the account's total across every chain, idle and placed.
    const total = totalOf(this.localExposure(acc, r)) + (peers.ok ? peers.chains.reduce((s, e) => s + totalOf(e), 0n) : 0n)
    const cap = this.effectiveCap(acc)
    return {
      address: live.safe,
      deployed: r.deployed,
      block: Number(r.block),
      usdc: r.usdc.toString(),
      eth: r.eth.toString(),
      capUsdc: this.capFor(acc).toString(),
      // Only while the engine is off: that is when the cap refuses Start.
      overCap: acc.active ? null : overCap(total, cap),
      exposure: { totalUsdc: total.toString(), capUsdc: cap.toString(), overUsdc: (total > cap ? total - cap : 0n).toString(), ...(peers.ok ? {} : { peerUnavailable: true }) },
      deployMinUsdc: MIN_DEPLOY_USDC.toString(),
      cbbtc: (r.tokens.cbBTC ?? 0n).toString(),
      gasReserveWei: this.policyOf(acc).gasReserveWei.toString(),
      active: acc.active,
      approval: this.approvalView(acc),
      idle: idleTokens(r, this.cfg.registry),
      engine: this.engineView(acc),
      positions: this.sizingPositions(acc, r).map((p) => ({
        tokenId: p.tokenId.toString(),
        pool: p.pool,
        liquidity: p.liquidity.toString(),
        inRange: p.inRange,
        amountUsdc: (p.token0 === 'USDC' ? p.amount0 : p.amount1).toString(),
        amountCbbtc: (p.token0 === 'cbBTC' ? p.amount0 : p.token1 === 'cbBTC' ? p.amount1 : 0n).toString(),
        amounts: [
          { token: p.token0, amount: p.amount0.toString(), decimals: entry(p.token0, this.cfg.registry).decimals ?? 18, valueUsdc: inUsdc(p.pool, p.token0, p.amount0, r.prices[p.pool]!.sqrtPriceX96, this.cfg.registry).toString() },
          { token: p.token1, amount: p.amount1.toString(), decimals: entry(p.token1, this.cfg.registry).decimals ?? 18, valueUsdc: inUsdc(p.pool, p.token1, p.amount1, r.prices[p.pool]!.sqrtPriceX96, this.cfg.registry).toString() },
        ],
        valueUsdc: positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, this.cfg.registry).toString(),
      })),
      progress: this.progressOf(acc),
    }
  }

  /**
   * readSafe shared by every open tab and poll of the same account (see FUNDING_FRESH_MS). Cleared whenever the
   * account moves (fundingMoved), so the engine and op state funding reports next to it are never paired with a
   * balance read before that move, even one the invalidation raced with. Every other caller of readSafe
   * (prepare, submit, renew) reads live: only the display read funding serves is cached.
   */
  private async readSafeCached(acc: AccountState, safe: Address, fresh: boolean): Promise<SafeRead> {
    const maxAge = fresh ? FUNDING_FRESH_READ_MS : (this.cfg.rpcBudget?.over(Date.now()) ?? false) ? FUNDING_STALE_MS : FUNDING_FRESH_MS
    return this.fundingCache.get(fundingCacheKey(acc.accountKey, safe), maxAge, () => this.readOf(acc, safe))
  }

  /** readSafe with the positions Mamoru admitted on this account named (otto/mamoru#140 part2 #4: see MAX_INVENTORY). */
  private async readOf(acc: AccountState, safe: Address): Promise<SafeRead> {
    // The ids as they were when the read started: an id admitted while it was in flight (onMinted) was not looked
    // for, and is never pruned on this read's word.
    const asked = acc.admittedTokenIds ? [...acc.admittedTokenIds] : undefined
    const r = await readSafe(this.client, safe, this.cfg.registry, asked ? { admitted: asked.map((id) => BigInt(id)) } : {})
    // Sol review #6: the record holds what the Safe still owns, so it stays bounded. Pruned from a read that saw every
    // NFT (enumerated) or checked the admitted ids one by one (ownerOf), never from a capped enumeration.
    const sawAll = r.byId ? (asked?.length ?? 0) <= MAX_INVENTORY : (r.positionCount ?? 0) <= MAX_INVENTORY
    if (asked && acc.admittedTokenIds && sawAll && this.store.state.accounts[acc.accountKey] === acc) {
      const owned = new Set([...(r.ownedIds ?? r.positions.map((p) => p.tokenId))].map((id) => id.toString()))
      const wasAsked = new Set(asked)
      // One synchronous step from the current record: only ids this read looked for and did not find go, and only
      // when the read's block is not before the id's mint (Sol review round 2 #3: a lagging provider never prunes it).
      const before = (id: string) => acc.admittedAt?.[id] !== undefined && r.block < BigInt(acc.admittedAt[id]!)
      const kept = acc.admittedTokenIds.filter((id) => !wasAsked.has(id) || owned.has(id) || before(id))
      if (kept.length !== acc.admittedTokenIds.length) {
        const gone = new Set(acc.admittedTokenIds.filter((id) => !kept.includes(id)))
        acc.admittedTokenIds = kept
        if (acc.admittedAt) acc.admittedAt = Object.fromEntries(Object.entries(acc.admittedAt).filter(([id]) => !gone.has(id)))
        this.store.save()
      }
    }
    return r
  }

  /**
   * otto/mamoru#135: something of this account moved (an owner op, the owner-tx progress line, an engine journal
   * move, the engine starting or ending an entry): the next funding read goes to the chain.
   */
  private fundingMoved(acc: AccountState): void {
    // Every Safe this account was read for, not only acc.ctx's: a request's context is what funding keys by.
    this.fundingCache.invalidateWhere((k) => isAccountKey(k, acc.accountKey))
  }

  /** Between operations: whether the engine is working through an entry, and when it looks at the account next. */
  private engineView(acc: AccountState): FundingView['engine'] {
    const runner = acc.active ? this.runners.get(acc.accountKey) : undefined
    if (!runner || runner.stopped) return null
    const waiting = runner.waiting?.length ? { waiting: runner.waiting, reviewedAt: runner.reviewedAt === undefined ? null : new Date(runner.reviewedAt).toISOString() } : {}
    return { placing: (runner.followUps ?? 0) > 0, nextReviewAt: runner.nextAt === undefined ? null : new Date(runner.nextAt).toISOString(), ...waiting }
  }

  /** What is in flight for this account: an owner transaction the operator is executing, else a live engine op. */
  progressOf(acc: AccountState): Progress | null {
    const owner = this.busy.get(acc.accountKey)
    if (owner) return { ...owner }
    const runner = this.runners.get(acc.accountKey)
    if (!runner) return null
    const o = runner.engine.journal.ops.findLast((x) => !isTerminal(x.state))
    if (!o) return null
    return { step: ENGINE_STEP[o.kind], pool: o.intent.pool, since: this.since(acc.accountKey, `${runner.epoch}-${runner.run}-${o.opId}`) }
  }

  /** First time this engine op was seen in flight (the journal keeps no timestamps). */
  private since(key: string, opKey: string): string {
    const k = `${key}|${opKey}`
    let at = this.seenAt.get(k)
    if (!at) {
      if (this.seenAt.size > 1000) this.seenAt.clear()
      this.seenAt.set(k, (at = now()))
    }
    return at
  }

  private setBusy(acc: AccountState, step: Progress['step']): void {
    this.busy.set(acc.accountKey, { step, since: now() })
    this.fundingMoved(acc)
  }

  /** GET /ops. Failed engine ops are internal attempts: left out unless `all` (debugging). */
  ops(ctx: AccountContext, after: string | null, includeFailedEngine = false): { ops: OpView[] } {
    const { acc } = this.account(ctx, { readOnly: true })
    // reconcileSoon is itself a no-op on an account with no unsettled own-* op (true of any account this readOnly
    // call just built in memory, which always starts with ops: []) — but it is never run against one that is not
    // the store's own record, so it can never schedule work against an object a mutating call will later replace.
    if (this.store.state.accounts[acc.accountKey] === acc) this.reconcileSoon(acc)
    const all = collapseFailed(includeFailedEngine ? acc.ops : acc.ops.filter((o) => !(o.opId.startsWith('eng-') && o.state === 'failed')))
    if (!after) return { ops: all }
    const i = all.findIndex((o) => o.opId === after)
    if (i >= 0) return { ops: all.slice(i + 1) }
    const t = Date.parse(after)
    return { ops: Number.isNaN(t) ? all : all.filter((o) => Date.parse(o.updatedAt) > t) }
  }

  // ---- owner side: prepare -------------------------------------------------

  private assertLive(): void {
    // otto/mamoru#63: off Base nothing is prepared or signed, live or not, fork or mainnet (fail closed), unless this
    // operator was opted into writing to that chain (otto/mamoru#61).
    const refusal = this.writeRefusal()
    if (refusal) throw new HttpError(503, 'CHAIN_READ_ONLY', refusal)
    if (!this.cfg.live) throw new HttpError(503, 'DRY_RUN_STOP', 'operator is not live (MAMORU_LIVE=1 on chain 8453 required)')
  }

  /** otto/mamoru#63, #61: why this operator may not write (chain.ts `writeRefusal` with its opt-in), or null. */
  private writeRefusal(): string | null {
    return writeRefusal(this.cfg.registry, this.cfg.chainWrites ? { chainId: this.cfg.chainId, optIn: this.cfg.chainWrites } : undefined)
  }

  /** The name of the chain the operator writes to, for the summaries the owner signs ("Base" on Base). */
  private chainName(): string {
    return isChainId(this.cfg.registry.chainId) ? chainOf(this.cfg.registry.chainId).name : this.cfg.registry.chain
  }

  /** The symbol of the chain's native asset ("ETH" on Base, "MON" on Monad). */
  private nativeSymbol(): string {
    return isChainId(this.cfg.registry.chainId) ? chainOf(this.cfg.registry.chainId).native.symbol : 'ETH'
  }

  /**
   * What the relayer's top-up adds over the policy reserve: the first userOp's prefund leaves the Safe for its EntryPoint
   * deposit, and decide holds every operation while the Safe is under the reserve. On Base, TOP_UP_MARGIN_WEI as always.
   * otto/mamoru#61: off Base (MON at ~100 gwei) that figure is nothing; it is one engine userOp's prefund at its largest
   * (the engine's fixed limits, ONE_ACTION_GAS_UNITS) at twice the gas price read now.
   */
  private async topUpMarginWei(): Promise<bigint> {
    return this.offBase() ? ONE_ACTION_GAS_UNITS * (await this.gasPrice()) * 2n : TOP_UP_MARGIN_WEI
  }

  /** Whether the operator writes to a chain other than Base (otto/mamoru#61): Base-only routes stay closed there. */
  private offBase(): boolean {
    return this.cfg.registry.chainId !== BASE_CHAIN_ID
  }

  private async hold(acc: AccountState, live: LiveAccount, kind: OwnerKind, calls: Parameters<typeof ownerSafeTx>[0], summary: string[], extra: Partial<Prepared> = {}): Promise<OwnerTxToSign> {
    const { nonce, deployed } = await readSafeNonce(this.client, live.safe)
    // otto/mamoru#163: an activation whose outcome is unresolved can still run while the Safe nonce is its own. One that
    // replaces it is signed for that same nonce (the current one), so only one of them can ever execute. If the Safe
    // moved past it, it ran or never will: that is settled first (under this same account lock), and no new start is
    // signed while it cannot be. (An unresolved renewal is already handled by settleRenewals: the next renewal or stop
    // revokes its grants, and it is applied only once proven.)
    if (kind === 'activate') {
      let n = this.unresolvedNonce(acc)
      if (n !== null && n < nonce) {
        try {
          await this.reconcileOwner(acc)
        } catch (e) {
          logErr(`[reconcile] ${acc.accountKey} before a Start:`, e)
        }
        n = this.unresolvedNonce(acc)
        // The earlier start may have just been settled as run (relayed by anyone between Start's checks and the nonce
        // read): the account runs now, or has grants to revoke first. No approval for the next nonce is handed out.
        if (acc.active) throw new HttpError(409, 'ALREADY_ACTIVE', 'the engine is already active for this account')
        if (acc.superseded?.length) throw new HttpError(409, 'STOP_FIRST', 'earlier Mamoru grants are still enabled on your Safe: stop first to revoke them, then start')
      }
      if (n !== null && n < nonce) throw new HttpError(409, 'OWNER_OP_SETTLING', 'an earlier approval of this account is still being settled from the chain: try again in a minute')
    }
    // otto/mamoru#140 (part2 #6): past the sponsorship limits the Safe pays its own fee, and the summary says so.
    const fee = await this.feePlan(acc, live, kind, extra.revokeOnly === true, deployed)
    const tx: SafeTx = fee.refund ? { ...ownerSafeTx(calls, nonce, this.cfg.registry), refund: fee.refund } : ownerSafeTx(calls, nonce, this.cfg.registry)
    const safeTxHash = safeTxHashOf(live, tx)
    const prepareId = toHex(randomBytes(16)).slice(2)
    const expires = Date.now() + PREPARE_TTL_MS
    for (const [id, p] of this.prepared) if (p.expires < Date.now()) this.prepared.delete(id)
    // part2 #7: a few open prepares per account and kind of exit (the oldest goes; a Stop never evicts, nor is evicted
    // by, anything else), and a ceiling over all of them that a Stop is never refused by.
    const stop = kind === 'stop'
    const safe = live.safe.toLowerCase()
    const mine = [...this.prepared.values()].filter((p) => (p.safe ?? '') === safe && (p.kind === 'stop') === stop).sort((a, b) => a.expires - b.expires)
    for (const p of mine.slice(0, Math.max(0, mine.length - PREPARED_PER_ACCOUNT + 1))) this.prepared.delete(p.prepareId)
    if (!stop && this.prepared.size >= PREPARED_MAX) throw safeHttpError(503, 'OPERATOR_BUSY')
    // otto/mamoru#151: a renewal's grants are all of one policy, the one its summary was built from (renewPolicyOf).
    const policyId = kind === 'renew' ? renewPolicyOf(extra.grants ?? []) : undefined
    this.prepared.set(prepareId, { prepareId, accountKey: acc.accountKey, kind, tx, safeTxHash, expires, ...extra, ...(policyId ? { policyId } : {}), safe, ...(fee.sponsorKind ? { sponsorKind: fee.sponsorKind } : {}), ...(fee.feeWei ? { feeWei: fee.feeWei.toString() } : {}) })
    return { safe: live.safe, chainId: this.cfg.chainId, safeTxHash, summary: fee.line ? [...summary, fee.line] : summary, expiresAt: new Date(expires).toISOString(), prepareId, ...(policyId ? { policyId } : {}), ...(kind === 'renew' ? { move: extra.move === true } : {}) }
  }

  /** The policy a renewal of `acc` targets now: the move's target when one is offered, else the account's own. */
  renewTarget(acc: AccountState): string {
    return (this.v4Target(acc) ?? this.policyOf(acc)).policyId
  }

  // ---- owner side: who pays (otto/mamoru#140 part2 #6) -----------------------

  private sponsorPolicy(): SponsorPolicy {
    // otto/mamoru#61: DEFAULT_SPONSOR and SPONSOR_BOUNDS are Base ETH; an operator writing to Monad counts in MON, and a
    // configured policy is never loosened by the Monad default (monadSponsor: the stricter of the two, field by field).
    if (this.offBase()) return monadSponsor(this.cfg.sponsor)
    return this.cfg.sponsor ? boundedSponsor(this.cfg.sponsor) : DEFAULT_SPONSOR
  }

  /** This account's sponsored owner transactions of the last 24 h, pruned in place, and every account's. */
  private sponsoredOf(acc: AccountState, at: number): { own: SponsorEntry[]; all: SponsorEntry[] } {
    const own = recentSponsored(acc.sponsored, at)
    if (acc.sponsored && own.length !== acc.sponsored.length) acc.sponsored = own
    const all = Object.values(this.store.state.accounts).flatMap((a) => (a.accountKey === acc.accountKey ? own : recentSponsored(a.sponsored, at)))
    // A view not stored yet (an account's first prepare) has entries of its own only once stored.
    return { own, all: this.store.state.accounts[acc.accountKey] ? all : [...all, ...own] }
  }

  private async gasPrice(): Promise<bigint> {
    try {
      const p = await this.client.getGasPrice()
      if (p > 0n) return p
    } catch (e) {
      // otto/mamoru#61: FALLBACK_GAS_PRICE is a Base figure: off Base nothing is priced or sent on a guess.
      if (this.offBase()) throw Object.assign(new HttpError(503, 'GAS_PRICE_UNAVAILABLE', 'the network fee could not be read just now: nothing was sent, try again in a minute'), { cause: e })
    }
    if (this.offBase()) throw new HttpError(503, 'GAS_PRICE_UNAVAILABLE', 'the network fee could not be read just now: nothing was sent, try again in a minute')
    return FALLBACK_GAS_PRICE
  }

  private gasOf(kind: OwnerKind | SponsoredKind): bigint {
    return kind === 'renew' ? RENEW_TX_GAS : OWNER_TX_GAS
  }

  /**
   * Whether the relayer pays this owner transaction or the Safe does. Within the sponsorship limits the relayer pays,
   * as before, and the payment is counted (chargeSponsor, before anything is sent). Past them:
   * - a transfer or a Stop: the SafeTx refunds the fee from the Safe's ETH to the relayer, at no more than twice the
   *   current gas price, so an exit is never locked behind a limit while the Safe can pay for itself;
   * - a revoke-only Stop whose Safe cannot pay: an emergency revocation, sponsored up to EMERGENCY_REVOKES_PER_DAY per
   *   account and counted; it does no work but revoking, so the exemption buys nothing else;
   * - a renewal: refused until the limit frees (it is not an exit, and too large to be Safe-paid).
   * Anything else that cannot be paid is told what to send or when sponsorship frees up.
   */
  private async feePlan(acc: AccountState, live: LiveAccount, kind: OwnerKind, revokeOnly: boolean, deployed: boolean): Promise<{ refund?: NonNullable<SafeTx['refund']>; feeWei?: bigint; line?: string; sponsorKind?: SponsoredKind }> {
    if (!SPONSORED_KINDS.has(kind)) return {}
    const price = await this.gasPrice()
    const at = Date.now()
    const { own, all } = this.sponsoredOf(acc, at)
    const policy = this.sponsorPolicy()
    const no = sponsorRefusal(policy, own, all, kind as SponsoredKind, this.gasOf(kind) * price, at)
    if (!no) return { sponsorKind: kind as SponsoredKind }
    const until = new Date(no.until).toISOString()
    if (kind === 'renew') throw new HttpError(429, no.code, `Mamoru has paid for as many renewals as it can today; renew after ${until}`)
    const gasPrice = price * 2n
    // Sol review round 2 #2: a Safe not deployed yet is deployed by the relayer first; the refund pays that back too.
    const baseGas = SAFE_PAID_BASE_GAS + (deployed ? 0n : DEPLOY_GAS)
    const feeWei = (this.gasOf(kind) + baseGas) * gasPrice
    // An undeployed Safe can pay too: ETH sent to its address is there once the relayer deploys it.
    const eth = await this.client.getBalance({ address: live.safe })
    if (eth >= feeWei) {
      return {
        refund: { safeTxGas: this.gasOf(kind), baseGas, gasPrice, refundReceiver: this.relayer.address as Address },
        feeWei,
        line: `Your Safe pays this transaction's network fee to Mamoru's relayer, at most about ${fmtUnits(feeWei, 18)} ${this.nativeSymbol()} (sponsored transactions are used up until ${until})`,
      }
    }
    if (kind === 'stop' && revokeOnly && !sponsorRefusal(policy, own, all, 'revoke', 0n, at)) return { sponsorKind: 'revoke' }
    // Rounded up to what fmtUnits shows (6 decimals), so the amount named is always enough.
    const short = ((feeWei - eth + 999_999_999_999n) / 1_000_000_000_000n) * 1_000_000_000_000n
    throw new HttpError(429, no.code, `Mamoru has paid for as many of this account's transactions as it can today. Send at least ${fmtUnits(short, 18)} ${this.nativeSymbol()} to your Safe ${live.safe} so it pays its own network fee, or try again after ${until}`)
  }

  /**
   * Base caps a transaction at 2^24 gas (EIP-7825); a fork does not. SmartSession.enableSessions costs ~1-3M gas per
   * session, so the full multi-pool v2 set (12 sessions, ~18.2M) reverts GS013 on real Base. Keep every entry grant
   * and drop the manage-any/convert-any pairs of the lowest-preference buckets until the simulated tx fits. The engine
   * discards a proposal whose session is missing (SESSION_MISSING), so a dropped pair only disables re-range/reduce
   * for that pool, until the owner adds it with one more approval (planExtend).
   */
  private async fitActivation(
    live: LiveAccount,
    policy: PolicyVersion,
    allKeys: string[],
    build: (keys: string[]) => ReturnType<typeof instantiateGrant>[],
    acc: AccountState,
    block: bigint,
    reserve?: LiveGasReserve,
  ): Promise<{ keys: string[]; grants: ReturnType<typeof instantiateGrant>[]; batch: ReturnType<typeof activationBatch> }> {
    const droppable = this.droppablePairs(policy, allKeys)
    let keys = allKeys
    for (let i = 0; ; i++) {
      const grants = build(keys)
      const batch = activationBatch(live, grants, acc.revoked, { trust: !acc.trusted, ...(reserve ? { reserve } : {}) })
      // otto/mamoru#15: the static estimate counts the reserve swap too (the simulation sees it).
      const gas = await this.activationGas(live, batch.calls, grants.length, block, reserve ? 400_000n + BigInt(grants.length) * STATIC_GAS_PER_SESSION + STATIC_GAS_RESERVE_SWAP : undefined)
      if (gas <= ACTIVATION_GAS_BUDGET || i >= droppable.length) {
        if (keys.length < allKeys.length) console.log(`[activate] ${live.safe} ~${gas} gas: dropped ${allKeys.filter((k) => !keys.includes(k)).join(', ')} to fit ${this.chainName()}'s per-tx gas cap`)
        return { keys, grants, batch }
      }
      keys = keys.filter((k) => !droppable[i]!.includes(k))
    }
  }

  /** Simulated gas of the activation calls from the Safe plus calldata and Safe/WebAuthn overhead; a static estimate when the simulation is unavailable (e.g. undeployed Safe). */
  private async activationGas(live: LiveAccount, calls: Parameters<typeof ownerSafeTx>[0], sessions: number, block: bigint, fallback?: bigint): Promise<bigint> {
    return (await this.activationGasOf(live, calls, sessions, block, fallback)).gas
  }

  /**
   * otto/mamoru#151: the gas limit the owner's Safe transaction carrying `calls` needs, or null when it cannot be read.
   * The batch runs in one simulation in the Safe's own context: `Safe.simulateAndRevert(MultiSendCallOnly, multiSend)`
   * delegatecalls the batch exactly as execTransaction does, then reverts, so no refund is netted out of the gas used
   * (a reverted call refunds nothing). Inner success is the first word of the revert data. Scaled by 9/8 and plus
   * PASSKEY_VERIFY_GAS: on a Base fork eth_estimateGas of the signed owner transaction was 1.10-1.113 x this figure over
   * eight v4/v5 approval transactions (t8-fork.ts prints both), from execTransaction around the batch and the nested
   * calls' 63/64 rule; the passkey (WebAuthn) check replaces the fork's EOA signature.
   */
  private async ownerTxGasLimit(live: LiveAccount, calls: Parameters<typeof ownerSafeTx>[0], block: bigint): Promise<bigint | null> {
    if (!calls.length) return null
    try {
      // One call or many, through MultiSendCallOnly: the same execution as the owner transaction (a single call is sent
      // to its target directly; through MultiSend it costs a little more, so the figure stays on the safe side).
      const ms = multiSendCallOnly(calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data })), this.cfg.registry)
      const data = encodeFunctionData({ abi: storageAccessibleAbi, functionName: 'simulateAndRevert', args: [ms.to, ms.data] })
      const [res] = await simulateCalls(this.client, [{ from: this.relayer.address, to: live.safe, data }], block)
      if (!res || res.returnData.length < 2 + 64 * 2 || BigInt(res.returnData.slice(0, 66)) !== 1n) return null
      return (res.gasUsed * 9n) / 8n + PASSKEY_VERIFY_GAS
    } catch {
      return null
    }
  }

  /** `activationGas`, and whether it was simulated (false: the static estimate). */
  private async activationGasOf(live: LiveAccount, calls: Parameters<typeof ownerSafeTx>[0], sessions: number, block: bigint, fallback?: bigint): Promise<{ gas: bigint; simulated: boolean }> {
    const bytes = calls.reduce((n, c) => n + BigInt((c.data.length - 2) / 2), 0n)
    const overhead = 16n * bytes + ACTIVATION_OVERHEAD_GAS
    try {
      const res = await simulateCalls(this.client, calls.map((c) => ({ from: live.safe, to: c.to, data: c.data })), block)
      if (res.every((x) => x.status === 'success')) return { gas: res.reduce((n, x) => n + x.gasUsed, 0n) + overhead, simulated: true }
    } catch {
      // fall through to the static estimate
    }
    return { gas: (fallback ?? 400_000n + BigInt(sessions) * STATIC_GAS_PER_SESSION) + overhead, simulated: false }
  }

  /**
   * The engine's session grants for one owner approval, sized at the account cap and valid from now for the policy's
   * validity, with the Safe transaction that enables them. A first approval and a renewal sign the same thing.
   */
  /** `reserve`: a first activation that buys the Safe's own gas reserve in the same transaction (otto/mamoru#15, self-reserve.ts). */
  private async approval(acc: AccountState, live: LiveAccount, policy: PolicyVersion, r: Awaited<ReturnType<typeof readSafe>>, cap: bigint, only?: string[], mode: 'full' | 'extend' = 'full', reserve?: LiveGasReserve) {
    // otto/mamoru#140 (part2 #7): a new key stays with the prepare (Prepared.sessionKey) until the owner's signature
    // over these grants is proven; nothing is written for an account that only prepares.
    const newKey = acc.sessionKey ? undefined : generatePrivateKey()
    const sessionKey = privateKeyToAccount(acc.sessionKey ?? newKey!).address
    // Sized at the account cap, not the observed deposit: the same signature bounds any deposit up to the cap,
    // so the owner can sign before any USDC arrives (armed activation). Priced at each pool's TWAP, not slot0, which a
    // swap in the read block could move to shrink or inflate the volatile caps the owner signs (otto/mamoru#140).
    const prices = Object.fromEntries(
      await Promise.all(
        [...new Set([livePool(this.cfg.registry), ...policy.buckets.flatMap((b) => b.pools)])].map(async (pool) => {
          const tick = await twapTickAt(this.client, address(pool, this.cfg.registry), policy.execution.twapWindowSeconds, r.block).catch(() => null)
          if (tick === null) throw new HttpError(503, 'PRICE_UNAVAILABLE', 'a pool price could not be checked right now; try again in a moment')
          const pr = priceOf(pool, sqrtRatioAtTick(tick), this.cfg.registry)
          return [pr.asset, { num: pr.num, den: pr.den }]
        }),
      ),
    )
    const caps = computeCaps(policy, cap, prices)
    // Spec 007 T7 (P1 1): a v4 policy's grants go out with MamoruActionPolicy (and its per-pool Init) and
    // MamoruGasPolicy, bound to the deployed addresses the policy config names; never without them.
    const v4 = isV4(policy) ? await this.v4Context(acc, live, policy, r.block, mode) : null
    const block = await this.client.getBlock({ blockNumber: r.block })
    const t = Number(block.timestamp)
    const allKeys = policy.session.grants.filter((g) => !g.perPosition).map(grantKey)
    const build = (keys: string[]) => keys.map((key) => {
      const g = instantiateGrant(policy, key, {
        account: live.safe,
        sessionKey,
        chainId: this.cfg.chainId,
        salt: toHex(randomBytes(32)),
        validAfter: t - 60,
        validUntil: t + policy.session.validitySeconds,
        caps,
        admittedTokenIds: [],
        // #149: usage limits sized for the approval's validity at this account cap; spec 006: the one cap captured
        // for this prepare, the same one the caps above, the summary and the stored ceiling use.
        capUsdc: cap,
      })
      return v4 && g.requiresActionPolicy ? retargetToPolicy(g, v4.d.actionPolicy) : g
    })
    const batchOf = (grants: SessionGrant[]) =>
      activationBatch(live, grants, acc.revoked, {
        trust: !acc.trusted,
        ...(v4 ? { policiesFor: v4PoliciesFor(grants, v4.d, v4.generation, v4BudgetCaps(policy, cap), v4.admitByPool), attest: v4.attest, reattest: v4.reattest, attestData: v4.attestData } : {}),
        ...(reserve ? { reserve } : {}),
      })
    // A first approval takes as many grants as fit the gas cap. A renewal takes exactly the ones the account has
    // (`only`): it neither loses a grant nor gains one the owner did not have.
    const exact = only?.filter((k) => allKeys.includes(k))
    // Built once: every build draws new salts, and the batch must enable the very grants that are stored.
    const exactGrants = exact ? build(exact) : null
    if (v4 && !exactGrants) throw new Error('a v4 approval is always built on the keys fitV4 chose')
    const { keys, grants, batch } = exact && exactGrants
      ? { keys: exact, grants: exactGrants, batch: batchOf(exactGrants) }
      : await this.fitActivation(live, policy, allKeys, build, acc, r.block, reserve)
    // Spec 007 T7: the first grant of each pool carried that pool's Init.admit (v4PoliciesFor); kept for the engine's mirror.
    const firstOfPool = new Map<string, number>()
    grants.forEach((g, i) => {
      if (g.pool && !firstOfPool.has(g.pool)) firstOfPool.set(g.pool, i)
    })
    const stored: StoredGrant[] = grants.map((g, i) => {
      const admit = v4 && g.pool && firstOfPool.get(g.pool) === i ? (v4.admitByPool[g.pool] ?? []).map(String) : []
      return { name: keys[i]!, grant: g, permissionId: batch.permissionIds[i]!, ...(admit.length ? { admit } : {}) }
    })
    // What this transaction admits (a pool whose sessions all come in a later step is admitted there).
    return { sessionKey, caps, stored, batch, ...(newKey ? { newKey } : {}), ...(v4 ? { v4: { generation: v4.generation, admitted: stored.reduce((n, g) => n + (g.admit?.length ?? 0), 0) } } : {}) }
  }

  /**
   * Spec 007 T7 (c): what a v4 approval of `acc` needs from the chain, read at `block`.
   * - Both policies are registered (`findModule`) under the resolver of Mamoru's other policies, before any account
   *   attests them (Deploy.s.sol writes the record in the deploy transaction itself); otherwise refused.
   * - Self-attestation: each policy the Safe has not attested yet (`findAttestation`) is attested in this transaction.
   * - Generation: a full approval (activation, renewal, the move from v2/v3) enables `generationOf + 1`, which retires
   *   every older config of the account; an extension (the next transaction of the same approval) enables the current
   *   one, and only while the pools the account already holds are configured at it (otherwise a full renewal).
   * - Init.admit (T6 M-4): the positions the operator minted for this Safe (`admittedTokenIds`) that the Safe still
   *   owns, grouped by the v4 pool they belong to; each Init of a pool admits them again (harmless: same pool).
   */
  private async v4Context(acc: AccountState, live: LiveAccount, policy: PolicyVersion, block: bigint, mode: 'full' | 'extend'): Promise<{ d: V4Deployment; generation: bigint; attest: Address[]; reattest: Address[]; attestData: Hex; admitByPool: Partial<Record<string, bigint[]>> }> {
    const d = v4DeploymentOf(policy)
    if (!d) throw new HttpError(503, 'ACTION_POLICY_UNCONFIGURED', 'the on-chain action policy is not configured on this operator')
    const read = <T,>(args: Parameters<PublicClient['readContract']>[0]) => this.client.readContract({ ...args, blockNumber: block } as never) as Promise<T>
    const reference = await read<{ resolverUID: Hex; sender: Address }>({ address: address('ModuleRegistry', this.cfg.registry), abi: moduleRegistryAbi, functionName: 'findModule', args: [address('TimeFramePolicy', this.cfg.registry)] })
    for (const m of [d.actionPolicy, d.gasPolicy]) {
      const rec = await read<{ resolverUID: Hex; sender: Address }>({ address: address('ModuleRegistry', this.cfg.registry), abi: moduleRegistryAbi, functionName: 'findModule', args: [m] })
      if (BigInt(rec.sender) === 0n || rec.resolverUID !== reference.resolverUID) {
        logErr(`[v4] ${m} has no ModuleRecord under Mamoru's resolver (sender ${rec.sender}): not attested`, undefined)
        throw new HttpError(503, 'ACTION_POLICY_NOT_REGISTERED', 'the on-chain action policy is not registered yet: nothing was changed')
      }
    }
    // An attestation counts only if it stays in force for the whole approval being signed: made, not revoked, and with
    // no expiry before the approval ends (review rounds 2 and 3). Otherwise it is made again in this owner transaction,
    // or the registry would refuse every userOp from the day it lapses. Mamoru's own self-attestations never expire.
    const now = Number((await this.client.getBlock({ blockNumber: block })).timestamp)
    const approvalEnd = now + policy.session.validitySeconds
    const attest: Address[] = []
    // Unrevoked but lapsing: the registry refuses a new attestation over it (AlreadyAttested), so it is revoked first.
    const reattest: Address[] = []
    for (const m of [d.actionPolicy, d.gasPolicy]) {
      const a = await read<{ time: number; expirationTime: number; revocationTime: number; attester: Address }>({ address: address('ModuleRegistry', this.cfg.registry), abi: moduleRegistryAbi, functionName: 'findAttestation', args: [m, live.safe] })
      const lapses = Number(a.expirationTime) !== 0 && Number(a.expirationTime) <= approvalEnd
      const inForce = Number(a.time) !== 0 && Number(a.revocationTime) === 0
      if (!inForce || lapses) attest.push(m)
      if (inForce && lapses) reattest.push(m)
    }
    const current = await read<bigint>({ address: d.actionPolicy, abi: v4PolicyAbi, functionName: 'generationOf', args: [live.safe] })
    // otto/mamoru#151: the move to another policy contract (v4 on V1 -> v5 on V2) is a renewal at the old contract's
    // generation + 1 (spec 007: "a migration carries the old deployment's generation"; V2 accepts that jump only on its
    // first enable for the account). Read at the same block as the rest.
    const prior = mode === 'full' ? await this.priorGeneration(acc, live.safe, d, read) : 0n
    let generation = (prior > current ? prior : current) + 1n
    if (mode === 'extend') {
      generation = current
      const held = [...new Set(acc.grants.map((g) => g.grant.pool).filter((x): x is NonNullable<typeof x> => !!x))]
      const configs = await Promise.all(held.map((pool) => read<{ generation: bigint }>({ address: d.actionPolicy, abi: v4PolicyAbi, functionName: 'configOf', args: [live.safe, address(pool, this.cfg.registry)] })))
      if (current === 0n || configs.some((c) => c.generation !== current)) {
        throw new HttpError(409, 'POLICY_GENERATION_MOVED', "the approval on your Safe changed since the last step: renew it in full instead")
      }
    }
    const admitByPool: Partial<Record<string, bigint[]>> = {}
    for (const id of acc.admittedTokenIds ?? []) {
      const tokenId = BigInt(id)
      let owner: Address
      let pos: readonly unknown[]
      try {
        owner = await read<Address>({ address: address('NonfungiblePositionManager', this.cfg.registry), abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', args: [tokenId] })
        pos = await read<readonly unknown[]>({ address: address('NonfungiblePositionManager', this.cfg.registry), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] })
      } catch (e) {
        // Only the position manager's own answer that the token does not exist means burned (review round 3). Any
        // other failure (a provider error) refuses the prepare: a renewal signed without a position the Safe still
        // owns would leave it out of the new generation's admitted set.
        if (/invalid token id|nonexistent token|ERC721: (owner query for nonexistent|invalid token)/i.test(e instanceof Error ? e.message : String(e))) continue
        logErr(`[v4] ${acc.accountKey} position ${tokenId} unreadable while preparing the approval:`, e)
        throw new HttpError(503, 'POSITION_READ_UNAVAILABLE', 'your positions could not be read just now: nothing was changed, try again in a minute')
      }
      if (owner.toLowerCase() !== live.safe.toLowerCase()) continue
      const [t0, t1, fee] = [String(pos[2]).toLowerCase(), String(pos[3]).toLowerCase(), Number(pos[4])]
      const spec = Object.values(V4_POOLS).find((v) => policy.buckets.some((b) => b.pools.includes(v.pool)) && address(v.token0, this.cfg.registry).toLowerCase() === t0 && address(v.token1, this.cfg.registry).toLowerCase() === t1 && v.fee === fee)
      if (!spec) continue
      ;(admitByPool[spec.pool] ??= []).push(tokenId)
    }
    for (const [pool, ids] of Object.entries(admitByPool)) {
      if ((ids?.length ?? 0) > MAX_ADMIT) throw new HttpError(409, 'ADMIT_TOO_LARGE', `more than ${MAX_ADMIT} open positions in ${poolLabel(pool, this.cfg.registry)}: close some first`)
    }
    // Unique per prepare (generation and block time): the registry cannot store the same attestation bytes twice.
    const attestData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [generation, BigInt(now)])
    return { d, generation, attest, reattest, attestData, admitByPool }
  }

  /** The account's generation at the action policy contract it runs on now, when that is another one than `d`'s; else 0. */
  private async priorGeneration(acc: AccountState, safe: Address, d: V4Deployment, read: <T>(args: Parameters<PublicClient['readContract']>[0]) => Promise<T>): Promise<bigint> {
    let cur: PolicyVersion
    try {
      cur = this.policyOf(acc)
    } catch {
      return 0n
    }
    const old = cur.actionPolicy?.address
    if (!isV4(cur) || !old || old.toLowerCase() === d.actionPolicy.toLowerCase()) return 0n
    return read<bigint>({ address: old, abi: v4PolicyAbi, functionName: 'generationOf', args: [safe] })
  }

  /**
   * Spec 007 T7 (c): one v4 approval as consecutive owner transactions. The keys are ordered (orderV4Keys); the first
   * transaction takes the longest prefix of whole sessions whose SIMULATED gas (bounded up to the gas limit it needs,
   * refunds included), revokes, trust and attest included, stays at or under min(`budget`, V4_TX_GAS_TARGET) (otto/mamoru#151: ~2.2M under 2^24). The static per-action model only
   * seeds that search (`fitPrefixBySimulation`); when the Safe cannot be simulated (undeployed) the model's split stands
   * and must fit `budget` as before. What is left over is the account's missing grants: the renew row offers them, one
   * owner transaction at a time, through planExtend (fitted the same way), once this one has landed.
   */
  private async fitV4(acc: AccountState, live: LiveAccount, policy: PolicyVersion, r: Awaited<ReturnType<typeof readSafe>>, cap: bigint, keys: string[], revokes: Hex[], mode: 'full' | 'extend', budget: bigint, reserve?: LiveGasReserve) {
    // otto/mamoru#15: a self-funded activation's reserve swap rides in the same transaction, after the grants.
    const overheadGas = BigInt(revokes.length) * REVOKE_GAS_EACH + (acc.trusted ? 0n : TRUST_GAS) + ATTEST_GAS + (reserve ? STATIC_GAS_RESERVE_SWAP : 0n)
    const ordered = orderV4Keys(policy, keys)
    const target = budget < V4_TX_GAS_TARGET ? budget : V4_TX_GAS_TARGET
    const guess = splitV4Keys(policy, ordered, { overheadGas, ceiling: target })[0]?.length ?? 0
    const built = new Map<number, { a: Awaited<ReturnType<Operator['approval']>>; calls: ReturnType<typeof revocationCalls>; gas: bigint; simulated: boolean }>()
    const build = async (ks: string[]) => {
      const a = await this.approval(acc, live, policy, r, cap, ks, mode, reserve)
      const calls = [...revocationCalls(revokes, this.cfg.registry), ...a.batch.calls]
      const fallback = overheadGas + a.stored.reduce((n, g) => n + estimateSessionGas(g.grant.actions.length), 0n)
      // The gas LIMIT the owner transaction needs, before refunds (a revoke clears storage: t8-fork measured
      // eth_estimateGas 13.78M against a receipt of 11.31M on the v5 move's first transaction), from one simulation of
      // the whole batch in the Safe's own context. Not available (an undeployed Safe): the per-call simulation, bounded
      // up by 5/4 (EIP-3529: a refund is at most 1/5 of the gas before it), else the static estimate.
      const limit = await this.ownerTxGasLimit(live, calls, r.block)
      const sim = limit === null ? await this.activationGasOf(live, calls, a.stored.length, r.block, fallback) : { gas: limit, simulated: true }
      const gas = limit !== null || !sim.simulated ? sim.gas : (sim.gas * 5n) / 4n
      built.set(ks.length, { a, calls, gas, simulated: sim.simulated })
      return built.get(ks.length)!
    }
    const fit = await fitPrefixBySimulation(ordered, guess, async (ks) => {
      const b = await build(ks)
      return b.simulated ? b.gas : null
    }, target)
    let n = fit.n
    // Not simulable: the static split, held to `budget` (its estimate shrinks it one session at a time, as before).
    while (n > 0 && !fit.simulated && (built.get(n) ?? (await build(ordered.slice(0, n)))).gas > budget) n -= 1
    if (n === 0) throw new HttpError(409, 'RENEWAL_TOO_LARGE', 'this approval does not fit one transaction on Base: nothing was changed, Mamoru keeps running')
    const { a, calls, gas, simulated } = built.get(n) ?? (await build(ordered.slice(0, n)))
    const ks = ordered.slice(0, n)
    const rest = ordered.filter((k) => !ks.includes(k))
    // How many more owner transactions the rest takes, priced per action as this one simulated (else the static model).
    const actions = a.stored.reduce((m, g) => m + g.grant.actions.length, 0)
    const model = simulated ? calibratedGasModel(gas, overheadGas, actions) : undefined
    const steps = 1 + (rest.length ? splitV4Keys(policy, rest, { ...(model ? { model } : {}), ceiling: target }).length : 0)
    console.log(`[v4] ${live.safe} ~${gas} gas${simulated ? ' (simulated)' : ' (estimated)'}: ${a.stored.length} sessions now (generation ${a.v4?.generation}), ${rest.length} in ${steps - 1} later step(s)`)
    return { ...a, calls, rest, steps }
  }

  /**
   * Renewal of a running account's approval: the same grants with a fresh validity, usage and totals. Nothing is
   * moved and no position is touched; the engine switches to the new grants when the transaction lands. The grants
   * it replaces are left to lapse on their own date.
   */
  /** Planned under the account lock: nothing else of the account (an engine review, another owner action) runs in between. */
  prepareRenew(ctx: AccountContext): Promise<OwnerTxToSign> {
    return this.lock(ctx.accountKey).run(() => this.planRenew(ctx))
  }

  private async planRenew(ctx: AccountContext): Promise<OwnerTxToSign> {
    this.assertLive()
    const { acc, live } = this.account(ctx, { readOnly: true })
    await this.settleRenewals(acc)
    this.assertRenewable(acc)
    const r = await this.readOf(acc, live.safe)
    // Spec 007 T7 (d): the renew row moves a v2/v3 account to the on-chain action policy when that is offered.
    const target = this.v4Target(acc)
    const policy = target ?? this.policyOf(acc)
    // Grants the account lacks are added by an approval of their own, unless the renewal is due: then the renewal goes
    // first (it revokes every grant the account has, and the added ones would be revoked with them) and the missing
    // grants are offered once it has landed. Nor while a renewal's outcome is unknown: if it ran unseen, the grants the
    // engine has are revoked on chain and only a full renewal (which revokes everything and enables a fresh set) is
    // safe to build on them.
    const missing = this.missingGrants(acc)
    // #149: a grant near the end of its usage needs fresh counts, which only a full renewal gives (an extension keeps the
    // grants the account has): it goes first, like a due renewal.
    const view = this.approvalView(acc)
    if (!target && missing.length && !view?.renewDue && !view?.usage && !this.unsettledRenewalGrants(acc).length) return this.planExtend(acc, live, policy, r, missing)
    // The grants it replaces are revoked in the same Safe transaction, always: two sets are never enabled at once
    // and each limit exists once. Measured on Base: revoking eight grants is about 1.45M gas on top of the 12.7M that
    // enabling eight takes. When the whole does not fit the cap, manage-any/convert-any pairs are left out of the new
    // set (lowest-preference bucket first), never the revokes; an approval of their own adds them back afterwards.
    // The grants of a renewal whose outcome is still unknown go with them: if it ran unseen (a read behind the
    // chain), its grants are revoked here all the same; the removal of a session that is not there is taken.
    const old = [...new Set([...acc.grants.map((g) => g.permissionId), ...(acc.superseded ?? []), ...this.unsettledRenewalGrants(acc)])]
    // otto/mamoru#212: a full renewal sizes the new grants for the account's cap now, raised or lowered from the one it
    // signed before (spec 006 kept the old one, so a raised cap could never be used short of a stop and a new start).
    // The summary names the cap and, when it changes, both figures: the owner signs the new limits knowingly.
    const signed = this.signedCapOf(acc)
    // Never below the signed cap (coordinator, merge gate round 1): a lowered cap holds the engine (effectiveCap) but
    // never shrinks the grants that manage what is already placed.
    const now = this.capFor(acc)
    const cap = now > signed ? now : signed
    if (isV4(policy)) {
      // The move to v4 enables every grant of the v4 policy; a v4 renewal the ones the account has, as before.
      // otto/mamoru#151: a renewal on MamoruActionPolicyV2 ends a guardian pause; the owner signs knowing it. Fails
      // closed: when the pause cannot be read, nothing is prepared (the owner could otherwise end one unaware).
      const paused = await this.readPaused(acc, r.block)
      if (paused === null) throw new HttpError(503, 'PAUSE_STATE_UNAVAILABLE', "whether a guardian has paused Mamoru on your Safe could not be read just now: nothing was changed, try again in a minute")
      const keys = target ? policy.session.grants.filter((g) => !g.perPosition).map(grantKey) : acc.grants.map((g) => g.name)
      const f = await this.fitV4(acc, live, policy, r, cap, keys, old, 'full', RENEW_GAS_BUDGET)
      // otto/mamoru#151: the move to MamoruActionPolicyV2 (v5) names what it adds besides the on-chain limits.
      const toV5 = !!target && !!target.actionPolicy && target.actionPolicy.contractVersion === 2
      const summary = [
        ...(paused ? ['A guardian key has paused Mamoru on this Safe. This renewal ends that pause: approve it only if you know why it was paused'] : []),
        target ? `Renew Mamoru's approval on your Safe ${live.safe} and move it to ${toV5 ? 'the new version of its on-chain limits' : 'on-chain limits'}` : `Renew Mamoru's approval on your Safe ${live.safe}`,
        ...(target ? ['Mamoru can now trade only near the market price, and only the positions it opened'] : []),
        ...(toV5 ? ['It can add to a position it already holds instead of opening another one', 'A guardian key can pause it at any time; that key can never move your funds, and your next renewal ends a pause'] : []),
        `Engine key ${f.sessionKey} may keep doing the same kinds of actions for ${Math.round(policy.session.validitySeconds / 86_400)} more days, within new limits counted from zero, sized for deposits up to ${fmtUsdc(cap)} USDC (your cap):`,
        ...this.v4Lines(f.stored, policy, cap),
        ...capChange(signed, cap),
        ...(f.v4?.admitted ? [`Your ${f.v4.admitted} open position${f.v4.admitted === 1 ? '' : 's'} stay under Mamoru's management`] : []),
        'The approval it replaces is revoked in the same transaction',
        ...this.stepLines(f.steps, f.rest),
        'Nothing is moved: your positions stay as they are',
        'Whatever it collects, mints or swaps is paid to your Safe, never to anyone else',
      ]
      return this.hold(acc, live, 'renew', f.calls, summary, { grants: f.stored, revokes: old, capUsdc: cap.toString(), move: !!target, pauseChecked: true, pausedWarned: paused })
    }
    const { sessionKey, stored, calls, dropped } = await this.fitGrants(acc, live, policy, r, acc.grants.map((g) => g.name), old, cap)
    // Named so the renewal says, every time, exactly what the engine keeps doing without asking again: not every
    // renewed account holds manage-any/convert-any (a gas-capped activation can leave them out, see "fitGrants"),
    // and the renewal must not claim more authority than what it is actually renewing. manage-any's decrease,
    // collect and burn take any tokenId the Safe owns, in any pool, not only this policy's pools (grants.ts);
    // droppablePairs keeps a pool's manage-any and convert-any together, so `dropped` below and `liveManage`
    // here never name the same pool.
    const liveManage = stored.filter((g) => g.name.startsWith('manage-any') || g.name.startsWith('convert-any')).map((g) => g.name)
    const summary = [
      `Renew Mamoru's approval on your Safe ${live.safe}`,
      `Engine key ${sessionKey} may keep doing the same kinds of actions for ${Math.round(policy.session.validitySeconds / 86_400)} more days, within new limits counted from zero, sized for deposits up to ${fmtUsdc(cap)} USDC (your cap):`,
      ...this.limitLines(stored, policy),
      ...capChange(signed, cap),
      'The approval it replaces is revoked in the same transaction',
      ...(dropped.length ? [`Re-ranging and collecting fees in ${this.poolsOf(dropped)} needs one more approval after this one`] : []),
      ...(liveManage.length
        ? [`It also keeps acting, without asking again, on any Uniswap v3 position your Safe owns, in any pool: take liquidity out, collect fees, burn it once empty, and convert ${this.volatileOf(liveManage)} back to USDC`]
        : []),
      'Nothing is moved: your positions stay as they are',
      'Whatever it collects, mints or swaps is paid to your Safe, never to anyone else',
    ]
    return this.hold(acc, live, 'renew', calls, summary, { grants: stored, revokes: old, capUsdc: cap.toString() })
  }

  /**
   * One more approval for a running account that lacks grants of its policy: it enables only those, valid from now
   * for the policy's validity, and keeps every grant the account has. It revokes only what a renewal would revoke
   * besides the engine's grants (left-over and unsettled ones), so nothing the engine uses stops working. It travels
   * as a renewal (kind `renew`, same route, same one-at-a-time rules) and is applied by adding its grants.
   */
  private async planExtend(acc: AccountState, live: LiveAccount, policy: PolicyVersion, r: Awaited<ReturnType<typeof readSafe>>, missing: string[]): Promise<OwnerTxToSign> {
    const old = [...new Set([...(acc.superseded ?? []), ...this.unsettledRenewalGrants(acc)])]
    // The added grants are sized like the ones the account holds: for the cap it signed (spec 006), named below.
    const cap = this.signedCapOf(acc)
    if (isV4(policy)) {
      // Spec 007 T7 (c): the next transaction of a v4 approval, at the generation the earlier ones enabled.
      const f = await this.fitV4(acc, live, policy, r, cap, missing, old, 'extend', RENEW_GAS_BUDGET)
      const summary = [
        `Finish Mamoru's approval on your Safe ${live.safe}: ${this.poolsOf(f.stored.map((g) => g.name))}`,
        `Engine key ${f.sessionKey} may, for the rest of this approval and within limits sized for deposits up to ${fmtUsdc(cap)} USDC:`,
        ...this.v4Lines(f.stored, policy, cap),
        ...(f.v4?.admitted ? [`Your ${f.v4.admitted} open position${f.v4.admitted === 1 ? '' : 's'} there stay under Mamoru's management`] : []),
        ...this.stepLines(f.steps, f.rest),
        ...this.capNotice(acc, cap),
        'Nothing is moved now: your positions stay as they are',
        'Whatever it collects, mints or swaps is paid to your Safe, never to anyone else',
      ]
      return this.hold(acc, live, 'renew', f.calls, summary, { grants: f.stored, revokes: old, extend: true, base: acc.grants.map((g) => g.permissionId), capUsdc: cap.toString() })
    }
    const { sessionKey, stored, calls, dropped } = await this.fitGrants(acc, live, policy, r, missing, old, cap)
    const added = stored.map((g) => g.name)
    const summary = [
      `Let Mamoru's engine re-range and collect fees in ${this.poolsOf(added)} on your Safe ${live.safe}`,
      `Engine key ${sessionKey} may, for ${Math.round(policy.session.validitySeconds / 86_400)} days and within limits sized for deposits up to ${fmtUsdc(cap)} USDC: take liquidity out of any position your Safe owns and collect it, with its fees, into your Safe; burn a position once it is empty; open positions again in those pools; and swap ${this.volatileOf(added)} to USDC`,
      'It does this without asking you again, only within these limits, and whatever it collects, mints or swaps is paid to your Safe, never to anyone else',
      ...this.limitLines(stored, policy),
      ...(dropped.length ? [`${this.poolsOf(dropped)} needs one more approval after this one`] : []),
      ...this.capNotice(acc, cap),
      'Nothing is moved now: your positions stay as they are',
    ]
    return this.hold(acc, live, 'renew', calls, summary, { grants: stored, revokes: old, extend: true, base: acc.grants.map((g) => g.permissionId), capUsdc: cap.toString() })
  }

  /**
   * The grants for `keys` and the Safe calls that revoke `revokes` and enable them, fitted to one Base transaction:
   * manage-any/convert-any pairs are left out, lowest-preference bucket first, until the simulated gas fits. Refused
   * when nothing is left to enable or it still does not fit; the revokes are never left out.
   */
  private async fitGrants(acc: AccountState, live: LiveAccount, policy: PolicyVersion, r: Awaited<ReturnType<typeof readSafe>>, keys: string[], revokes: Hex[], cap: bigint) {
    if (isV4(policy)) throw new Error('fitGrants: a v4 approval goes through fitV4')
    const droppable = this.droppablePairs(policy, keys)
    let ks = keys
    for (let i = 0; ; i++) {
      const { sessionKey, stored, batch } = await this.approval(acc, live, policy, r, cap, ks)
      const calls = [...revocationCalls(revokes, this.cfg.registry), ...batch.calls]
      const gas = stored.length ? await this.activationGas(live, calls, stored.length, r.block) : 0n
      if (stored.length && gas <= RENEW_GAS_BUDGET) {
        const dropped = keys.filter((k) => !ks.includes(k))
        if (dropped.length) console.log(`[renew] ${live.safe} ~${gas} gas: left out ${dropped.join(', ')} to fit Base's per-tx gas cap`)
        return { sessionKey, stored, calls, dropped }
      }
      if (!stored.length || i >= droppable.length) {
        logErr(`[renew] ${acc.accountKey} ~${gas} gas over ${RENEW_GAS_BUDGET}:`, { grants: stored.length, revokes: revokes.length })
        throw new HttpError(409, 'RENEWAL_TOO_LARGE', 'this approval does not fit one transaction on Base: nothing was changed, Mamoru keeps running')
      }
      ks = ks.filter((k) => !droppable[i]!.includes(k))
    }
  }

  /**
   * #149: the limits the owner signs, read from the very grants being enabled, one line per pool: the USDC an entry
   * swap may spend per swap and in total, and how many transactions (userOps) each grant allows. A transaction can
   * hold several steps (collect and swap, take out and burn), so the counts are of transactions, and say so.
   */
  private limitLines(stored: StoredGrant[], policy: PolicyVersion): string[] {
    const n = (v: number) => v.toLocaleString('en-US')
    // Bare names (single-pair policies, conservador-live-v1): '' stands for the policy's one pool.
    const poolOf = (name: string) => name.split(':').slice(1).join(':')
    const pools = [...new Set(stored.map((g) => poolOf(g.name)).filter((p) => p === '' || p.startsWith('pool:')))]
    const bare = policy.buckets.flatMap((b) => b.pools)[0]
    return pools.map((pool) => {
      const of = (name: string) => stored.find((g) => g.name === (pool ? `${name}:${pool}` : name))
      const swap = of('enter-swap')?.grant.actions.find((a) => a.signature.startsWith('exactInputSingle'))?.params.find((p) => p.field === 'amountIn')
      const counts = [
        ['enter-swap', 'to swap USDC in'],
        ['enter-mint', 'to open a position'],
        ['manage-any', 'to take liquidity out, burn or re-open a position'],
        ['convert-any', 'to collect fees and swap them to USDC'],
      ].flatMap(([name, what]) => {
        const g = of(name!)
        return g ? [`${n(g.grant.userOp.usageLimit)} ${what}`] : []
      }).map((c, i) => (i === 0 ? c.replace(' to ', ' transactions to ') : c))
      // The per-call cap binds each swap call; a transaction may batch several, so only the total bounds one transaction.
      const total = swap ? fmtUsdc(swap.cumulativeLimit ?? swap.ref) : ''
      const money = swap ? `USDC swapped in at most ${fmtUsdc(swap.ref)} per swap and ${total} in total, so at most ${total} in one transaction, which can hold several swaps; ` : ''
      const label = pool ? poolLabel(pool, this.cfg.registry) : bare ? poolLabel(bare, this.cfg.registry) : 'its pool'
      return `In ${label}: ${money}at most ${counts.join(', ')} (one transaction can hold several of these steps)`
    })
  }

  /**
   * Spec 007 T7 (d): the v4 limits the owner signs, one line per pool, read from the grants and Inits being enabled:
   * the price band around the market (two TWAPs, the stables anchor), the policy budget (W_p a day, T_p in total), and
   * the gas cap per engine transaction with what that allows in all. Short on purpose: the unified approval dialog
   * (PR #80) shows every line.
   */
  private v4Lines(stored: StoredGrant[], policy: PolicyVersion, cap: bigint): string[] {
    const budgets = v4BudgetCaps(policy, cap)
    const pools = [...new Set(stored.map((g) => g.grant.pool).filter((x): x is NonNullable<typeof x> => !!x))]
    const lines = pools.map((pool) => {
      const spec = v4PoolOf(pool)
      if (!spec) return `In ${poolLabel(pool, this.cfg.registry)}: no on-chain limits`
      const band = `${(spec.bandTicks / 100).toFixed(2)}%`
      const anchor = spec.anchor ? ` and within ${(spec.anchor.band / 100).toFixed(2)}% of 1:1` : ''
      const day = budgets[spec.caps.budgetWindow] ?? 0n
      const total = budgets[spec.caps.budgetTotal] ?? 0n
      return `In ${poolLabel(pool, this.cfg.registry)}: swaps, new positions and withdrawals only within ${band} of the 30- and 5-minute average price${anchor}; swaps and new positions worth at most ${fmtUsdc(day)} USDC a day and ${fmtUsdc(total)} USDC in total on this approval`
    })
    const caps = policy.actionPolicy?.gasPolicy?.caps
    if (caps) {
      const per = maxGasCostPerOp(caps)
      const ops = stored.reduce((n, g) => n + BigInt(g.grant.userOp.usageLimit), 0n)
      lines.push(`Each engine transaction pays at most ${fmtUnits(per, 18)} ETH of network fee (at most ${fmtUnits(caps.maxFeePerGas, 9)} gwei per gas), from your Safe's ETH; these grants allow ${ops.toLocaleString('en-US')} transactions in all`)
    }
    return lines
  }

  /** Spec 007 T7 (c): where this transaction sits in a v4 approval that takes several. */
  private stepLines(steps: number, rest: string[]): string[] {
    if (steps <= 1) return []
    return [`Base limits how much one transaction can carry, so this approval takes ${steps} steps: after this one, ${steps - 1 === 1 ? 'one more' : `${steps - 1} more`} for ${this.poolsOf(rest)} (until then Mamoru does not act there with those permissions)`]
  }

  /** "cbBTC and WETH": the tokens other than USDC of the pools named in a set of grant keys (what a harvest converts). */
  private volatileOf(keys: string[]): string {
    const pools = [...new Set(keys.map((k) => k.split(':').slice(1).join(':')).filter((p) => p.startsWith('pool:')))]
    const tokens = [...new Set(pools.flatMap((p) => [entry(p, this.cfg.registry).token0, entry(p, this.cfg.registry).token1]).filter((t): t is string => !!t && t !== 'USDC'))]
    return tokens.length ? tokens.join(' and ') : 'what it collects'
  }

  /** "USDC/cbBTC 0.05% and WETH/USDC 0.30%" for the pools named in a set of grant keys. */
  private poolsOf(keys: string[]): string {
    const pools = [...new Set(keys.map((k) => k.split(':').slice(1).join(':')).filter((p) => p.startsWith('pool:')))]
    return pools.length ? pools.map((p) => poolLabel(p, this.cfg.registry)).join(' and ') : 'its pools'
  }

  /**
   * Renewals that failed only because their receipt was not read. Invariant I2 (otto/mamoru#140): a renewal is
   * confirmed only by its own receipt, or the Safe's ExecutionSuccess carrying its own Safe tx hash; never from its
   * grants reading enabled (the owner may enable the same sessions in a transaction of their own) nor from the nonce.
   * Proven, it is applied only if every one of its grants is still enabled (otherwise partlyRevoked). Not proven: it
   * stays an unread receipt while its Safe nonce is not spent; once spent it ends RENEWAL_SUPERSEDED (none of its
   * grants enabled) or RENEWAL_UNPROVEN, and whatever of it is enabled stays tracked (I3, enforceGrants).
   */
  private async settleRenewals(acc: AccountState): Promise<void> {
    const unknown = acc.ops.filter((o) => o.opId.startsWith('own-') && o.kind === 'renew' && o.state === 'failed' && o.code === RECEIPT_UNKNOWN) as StoredOp[]
    const superseded = (op: StoredOp) => acc.ops.slice(acc.ops.indexOf(op) + 1).some((l) => l.opId.startsWith('own-') && (l.kind === 'renew' || l.kind === 'exit') && l.state === 'confirmed')
    for (const op of unknown) {
      const ids = (op.ownerGrants ?? []).map((g) => g.permissionId)
      if (!ids.length) continue
      // A later renewal or stop confirmed after it: nothing of it is applied (that would put the engine back on
      // revoked grants). What of it is still enabled stays tracked by enforceGrants.
      if (superseded(op)) {
        this.patchOp(acc, op.opId, { state: 'failed', code: 'RENEWAL_SUPERSEDED' })
        continue
      }
      // otto/mamoru#163: one block B for "not run": the execution is searched exactly to B (and B's hash checked), and the
      // grants and the Safe nonce that decide RENEWAL_UNPROVEN / RENEWAL_SUPERSEDED are read at that same B, never later.
      let pin: { number: bigint; hash: Hex }
      try {
        const b = await this.client.getBlock()
        if (b.number === null || !b.hash) continue
        pin = { number: b.number, hash: b.hash }
      } catch (e) {
        logErr(`[settle] ${acc.accountKey} head unreadable:`, e)
        continue
      }
      // otto/mamoru#163: with its Safe nonce and Safe tx hash kept, its own receipt first, then the chain at B: nothing
      // searched while the nonce is unspent (it may still land: left as it is, its grants revoked by a stop or renewal
      // meanwhile); past it, the spending block's logs say which Safe tx spent it.
      let spent: SpentBy | null = null
      let proof: { hash: Hex; block: number } | null = null
      if (op.safeTxHash && op.safeNonce !== undefined) {
        const own = await this.provenOwnerTx(acc, op, undefined, { receiptOnly: true })
        if (own === 'unknown') continue
        if (own !== 'none') proof = own
        else {
          const v = await this.executionAt(acc, op, pin)
          if (!v) continue
          if (v.ran) proof = v.ran
          else if (v.nonce <= BigInt(op.safeNonce) || !v.spent) continue
          else spent = v.spent
        }
      } else {
        const answer = await this.provenOwnerTx(acc, op, pin)
        // A read error decides nothing: it stays an unread receipt, asked again (#140).
        if (answer === 'unknown') continue
        proof = answer === 'none' ? null : answer
        // Without a Safe nonce and Safe tx hash kept, nothing proves it did not run: left as it is.
        if (!proof) continue
      }
      // Proven: read at a head not below the account's floor nor the renewal's own block (a lagging provider defers,
      // #140). Not proven: at B itself, which must not be below the account's floor.
      const block = proof ? await this.headAtLeast(acc, BigInt(proof.block)) : pin.number >= this.floorOf(acc, 0n) ? pin.number : null
      if (block === null) continue
      const on = await this.enabledAt(acc, ids, block)
      if (!on) continue
      if (superseded(op) || op.state !== 'failed' || op.code !== RECEIPT_UNKNOWN) continue
      if (proof) {
        if (on.every(Boolean)) {
          console.log(`[renew] ${acc.accountKey} ${op.opId} executed on chain (tx ${proof.hash}), every grant enabled at block ${block}: applied`)
          this.afterOwner(acc, { prepareId: op.opId, accountKey: acc.accountKey, kind: 'renew', tx: undefined as never, safeTxHash: '0x', expires: 0, grants: op.ownerGrants, revokes: op.revokes, extend: op.extend, ...(op.capUsdc ? { capUsdc: op.capUsdc } : {}) }, { blockNumber: BigInt(proof.block) } as TransactionReceipt)
          this.patchOp(acc, op.opId, { state: 'confirmed', code: 'EXEC_OK', txHash: proof.hash, block: proof.block })
        } else {
          this.partlyRevoked(acc, op, ids, on, block)
          this.patchOp(acc, op.opId, { state: 'failed', code: 'RENEWAL_PARTLY_REVOKED', txHash: proof.hash, block: proof.block })
        }
        continue
      }
      // Its Safe nonce was spent by another Safe tx (or by this one failing: ExecutionFailure), proven by that block's
      // own log: it can no longer run. Its time is kept (findOwnerTx looks around it): reconcileOwner still asks.
      if (!spent) continue
      Object.assign(op, { state: 'failed', code: on.some(Boolean) ? 'RENEWAL_UNPROVEN' : 'RENEWAL_SUPERSEDED', spentBy: spent.safeTxHash, block: Number(spent.block) })
      this.store.save()
    }
    // Stops after renewals: a renewal applied above replaced the engine's grants, and the stop is judged on those.
    await this.settleStops(acc)
    await this.enforceGrants(acc)
  }

  /**
   * Stops that failed only because their receipt was not read. Disabled grants do not prove a stop ran (the owner
   * may have revoked them elsewhere, and then its position close and swaps never happened): once an engine grant
   * reads disabled, the stop is confirmed only by its own receipt or the ExecutionSuccess of its own Safe tx hash
   * (I2). Without that proof it stays an unread receipt, never reported as done; the engine is stopped by
   * enforceGrants (I1), with a typed reason.
   */
  private async settleStops(acc: AccountState): Promise<void> {
    // Unread receipts, and any stop still not settled that this process is not executing (left over from a stop of the operator).
    const unknown = acc.ops.filter((o) => o.opId.startsWith('own-') && o.kind === 'exit' && ((o.state === 'failed' && o.code === RECEIPT_UNKNOWN) || (!TERMINAL_STATES.has(o.state) && !this.busy.has(acc.accountKey)))) as StoredOp[]
    if (!unknown.length || !acc.active || !acc.grants.length) return
    const op = unknown.at(-1)!
    const ids = [...new Set([...acc.grants.map((g) => g.permissionId), ...(acc.superseded ?? []), ...this.unsettledRenewalGrants(acc), ...(op.revokes ?? [])])]
    const block = await this.headAtLeast(acc, 0n)
    if (block === null) return
    // Every engine grant, at one block: all enabled means the stop has not run.
    const on = await this.enabledAt(acc, acc.grants.map((g) => g.permissionId), block)
    if (!on || on.every(Boolean)) return
    const answer = await this.provenOwnerTx(acc, op)
    const proof = typeof answer === 'object' ? answer : null
    if (proof) {
      console.log(`[stop] ${acc.accountKey} ${op.opId} executed on chain (tx ${proof.hash}): applied`)
      this.afterOwner(acc, { prepareId: op.opId, accountKey: acc.accountKey, kind: 'stop', tx: undefined as never, safeTxHash: '0x', expires: 0, revokes: ids }, { blockNumber: BigInt(proof.block) } as TransactionReceipt)
      this.patchOp(acc, op.opId, { state: 'confirmed', code: 'EXEC_OK', txHash: proof.hash, block: proof.block })
      return
    }
    // Not proven: it stays an unread receipt for reconciliation (one left over from a stop of the operator becomes
    // one, its time kept for findOwnerTx's window); enforceGrants stops the engine.
    for (const o of unknown) if (!TERMINAL_STATES.has(o.state)) Object.assign(o, { state: 'failed', code: RECEIPT_UNKNOWN })
    this.store.save()
  }

  /**
   * Whether the engine may review now (invariant I1): its grants were verified within GRANTS_CHECK_MS, or the sweep
   * run now read the chain. A sweep that fails or is deferred (provider behind the account) returns false: the review
   * is held, and the sweep is tried again at the next tick, not GRANTS_CHECK_MS later.
   */
  private async grantGate(acc: AccountState, at: number): Promise<boolean> {
    // The engine's grants are read on every tick (one Multicall3 call), so I1 holds within one tick; the rotating
    // window of the other ids rides along every GRANTS_CHECK_MS.
    const others = at - (this.grantsChecked.get(acc.accountKey) ?? 0) >= GRANTS_CHECK_MS
    if (!(await this.enforceGrants(acc, { full: false, others }))) return false
    if (others) this.grantsChecked.set(acc.accountKey, at)
    return true
  }

  /**
   * otto/mamoru#140 invariants, from one block of the chain:
   * - I1: the engine runs only while every grant it uses reads enabled. One disabled (revoked by a transaction we
   *   did not send), whatever owner op is pending: the loop stops, the account is inactive with a typed reason
   *   (GRANTS_PARTLY_REVOKED, or GRANTS_REVOKED_ELSEWHERE when none is left), the grants still enabled are kept.
   * - I3: a grant leaves tracking (`grants`/`superseded`) only when it reads disabled. Every permission id the account
   *   ever knew (its grants, superseded, revoked, every owner op's grants and revocations, an armed approval's) that
   *   reads enabled and is not the engine's is put in `superseded`, so the next stop or renewal revokes it and Start
   *   waits for that stop (STOP_FIRST); one in `superseded` that reads disabled leaves it (recorded as revoked).
   * A read that fails, or a provider head below the account's floor, changes nothing. Full sweep (every id at one
   * pinned block, sequential batches) after every settle pass and before a Start. The engine loop reads the engine's
   * grants on every tick (grantGate), and every GRANTS_CHECK_MS a rotating window of the other ids with them, each
   * again within sweepsToCover(others, engine) such sweeps: with 12 engine grants, 500 other ids within 6 (30 min).
   */
  private async enforceGrants(acc: AccountState, opts: { full?: boolean; others?: boolean } = { full: true }): Promise<boolean> {
    const low = (id: string) => id.toLowerCase()
    const engine = acc.grants.map((g) => g.permissionId)
    const pendingOps = acc.ops.filter((o) => o.opId.startsWith('own-') && (!TERMINAL_STATES.has(o.state) || (o.state === 'failed' && o.code === RECEIPT_UNKNOWN)))
    // Every other permission id the account knows, in a stable order: superseded, pending ops' and the armed
    // approval's, then every owner op's grants and revocations and the revoked list. None is ever dropped (I3).
    const mine = new Set(engine.map(low))
    const others = new Map<string, Hex>()
    for (const id of [
      ...(acc.superseded ?? []),
      ...pendingOps.flatMap((o) => ((o as StoredOp).ownerGrants ?? []).map((g) => g.permissionId)),
      ...(acc.armed?.grants ?? []).map((g) => g.permissionId),
      ...acc.ops.flatMap((o) => [...((o as StoredOp).ownerGrants ?? []).map((g) => g.permissionId), ...((o as StoredOp).revokes ?? [])]),
      ...acc.revoked,
    ]) {
      const k = low(id)
      if (!mine.has(k) && !others.has(k)) others.set(k, id)
    }
    // A full sweep (settle passes, Start) reads them all, in chunks of BATCH_MAX_CALLS. The engine loop's sweep reads
    // the engine's grants every time and a rotating window of the others: GRANTS_SWEEP_MAX ids per sweep, so each
    // one is read again within ceil(others / (GRANTS_SWEEP_MAX - engine)) sweeps (sweepsToCover).
    const list = [...others.values()]
    let window = list
    // A full sweep (settle passes, Start) reads every id the account tracks at one pinned block, in sequential
    // batches of BATCH_MAX_CALLS at that same block: a consistent view, verified as a whole or not at all. A grant
    // the owner enables after that block is caught by the engine loop's sweep within sweepsToCover() sweeps.
    if (opts.full === false && opts.others === false) window = []
    else if (opts.full === false && list.length > GRANTS_SWEEP_MAX - engine.length) {
      // The engine loop's sweep: the engine's grants every time, a rotating window of the others.
      const size = Math.max(1, GRANTS_SWEEP_MAX - engine.length)
      const start = (this.sweepCursor.get(acc.accountKey) ?? 0) % list.length
      window = Array.from({ length: size }, (_, i) => list[(start + i) % list.length]!)
      this.sweepCursor.set(acc.accountKey, (start + size) % list.length)
    }
    const universe = [...engine, ...window]
    // Nothing tracked yet (a first Start): a full check still needs the chain readable, or it answers unavailable.
    if (!universe.length) return opts.full === false || (await this.headAtLeast(acc, 0n)) !== null
    // otto/mamoru#140, a deliberate tradeoff with I3: no id is ever dropped, so a full check grows with the account's
    // history (expected ~48 ids a year: 12 grants, 4 renewals). Past GRANTS_TRACKED_ALERT it alerts, once an hour.
    if (opts.full !== false && list.length + engine.length > GRANTS_TRACKED_ALERT && Date.now() - (this.grantsAlerted.get(acc.accountKey) ?? 0) > 3_600_000) {
      this.grantsAlerted.set(acc.accountKey, Date.now())
      logErr('[alert]', `${acc.accountKey} tracks ${list.length + engine.length} permission ids: every full grant check reads them all (over ${GRANTS_TRACKED_ALERT})`)
    }
    const block = await this.headAtLeast(acc, 0n)
    if (block === null) return false
    const on = await this.enabledAt(acc, universe, block)
    if (!on) return false
    const enabled = new Set(universe.filter((_, i) => on[i]).map(low))
    let changed = false
    if (acc.active && engine.some((id) => !enabled.has(low(id)))) {
      const off = engine.filter((id) => !enabled.has(low(id)))
      const by = pendingOps.at(-1)?.opId
      const code = off.length === engine.length ? 'GRANTS_REVOKED_ELSEWHERE' : 'GRANTS_PARTLY_REVOKED'
      logErr(`[grants] ${acc.accountKey} ${off.length}/${engine.length} engine grants disabled at block ${block}${by ? ` (${by} not proven)` : ''}: engine stopped (${code})`, undefined)
      // The reason first: afterOwner saves, and the inactive account is never stored without it.
      acc.deactivated = { code, ...(by ? { opId: by } : {}), block: block.toString(), at: now() }
      this.afterOwner(acc, { prepareId: by ?? 'grants', accountKey: acc.accountKey, kind: 'stop', tx: undefined as never, safeTxHash: '0x', expires: 0, revokes: off }, { blockNumber: block } as TransactionReceipt)
      changed = true
    }
    const read = new Set(universe.map(low))
    const now_ = new Set(acc.grants.map((g) => low(g.permissionId)))
    const before = acc.superseded ?? []
    // Only ids read in this sweep are decided on; the others stay as they are until their turn.
    const kept = before.filter((id) => !now_.has(low(id)) && (!read.has(low(id)) || enabled.has(low(id))))
    const gone = before.filter((id) => read.has(low(id)) && !enabled.has(low(id)))
    const known = new Set(kept.map(low))
    const added = universe.filter((id) => enabled.has(low(id)) && !now_.has(low(id)) && !known.has(low(id)))
    if (gone.length || added.length || kept.length !== before.length) {
      if (added.length) logErr(`[grants] ${acc.accountKey} ${added.length} enabled grants were untracked at block ${block}: kept for revocation`, undefined)
      acc.revoked.push(...gone.filter((id) => !acc.revoked.some((r) => low(r) === low(id))))
      acc.superseded = [...kept, ...added]
      changed = true
    }
    if (changed) this.store.save()
    return true
  }


  /** The account's floor and `min`: no grant is read at a block below it (see headAtLeast). */
  private floorOf(acc: AccountState, min: bigint): bigint {
    let floor = min
    for (const b of [acc.grantsFromBlock, acc.active ? acc.historyFromBlock : undefined, ...acc.ops.filter((o) => o.opId.startsWith('own-')).map((o) => o.block)]) {
      if (b === undefined || b === null || b === '') continue
      const n = BigInt(b)
      if (n > floor) floor = n
    }
    return floor
  }

  /**
   * The block number of the head, when it is not below `min` nor the account's floor: the block its current grants
   * were enabled in (grantsFromBlock), its activation block, and the block of its latest owner op. A provider behind
   * that answers null: whatever was to be read is deferred, never decided on an older view of the chain (#140).
   */
  private async headAtLeast(acc: AccountState, min: bigint): Promise<bigint | null> {
    const floor = this.floorOf(acc, min)
    try {
      const head = await this.client.getBlockNumber()
      if (head >= floor) return head
      console.log(`[grants] ${acc.accountKey} provider head ${head} behind block ${floor}: deferred`)
      return null
    } catch (e) {
      logErr(`[grants] ${acc.accountKey} head unreadable:`, e)
      return null
    }
  }

  /**
   * The owner tx of `op`, proven: its own receipt (status success, the Safe's ExecutionSuccess carrying the op's Safe
   * tx hash when one is kept), or without a receipt the ExecutionSuccess log of that Safe tx hash (findOwnerTx). Null
   * when nothing proves it ran; any read that fails counts as not proven.
   */
  /** `pin` (otto/mamoru#163): "none" only from a search that reached exactly that block, whose hash still matches. */
  private async provenOwnerTx(acc: AccountState, op: StoredOp, pin?: { number: bigint; hash: Hex }, opts: { receiptOnly?: boolean } = {}): Promise<{ hash: Hex; block: number } | 'none' | 'unknown'> {
    const safe = (acc.ctx.address as string).toLowerCase()
    const own = op.safeTxHash?.toLowerCase()
    try {
      if (op.txHash) {
        let receipt: TransactionReceipt | null = null
        try {
          receipt = await this.client.getTransactionReceipt({ hash: op.txHash as Hex })
        } catch (e) {
          // Not found is an answer (the logs below decide); any other error is not one: nothing is decided.
          if ((e as { name?: string })?.name !== 'TransactionReceiptNotFoundError') {
            logErr(`[settle] ${acc.accountKey} ${op.opId} receipt unreadable, undecided:`, e)
            return 'unknown'
          }
        }
        if (receipt) {
          const ok = receipt.status === 'success' && receipt.logs.some((l) => l.address.toLowerCase() === safe && l.topics[0] === EXECUTION_SUCCESS && (!own || l.topics[1]?.toLowerCase() === own))
          if (ok) return { hash: receipt.transactionHash, block: Number(receipt.blockNumber) }
          // otto/mamoru#163: our copy reverted, but the same signature may have run in another transaction (anyone can
          // relay it): with a Safe tx hash, its ExecutionSuccess below decides. Without one, this copy's revert is all.
          if (!own) return 'none'
        }
      }
      if (opts.receiptOnly) return 'none'
      // Without a Safe tx hash nothing tells its log from another's: undecided, never "not run".
      if (!own) return 'unknown'
      const found = await this.findOwnerTx(acc, op, { anyTx: true, ...(pin ? { toBlock: pin.number } : {}) })
      if (found?.ok) return { hash: found.hash, block: found.block }
      if (pin) {
        const again = await this.client.getBlock({ blockNumber: pin.number })
        if (again.hash?.toLowerCase() !== pin.hash.toLowerCase()) return 'unknown'
      }
      return 'none'
    } catch (e) {
      logErr(`[settle] ${acc.accountKey} ${op.opId} execution unreadable, undecided:`, e)
      return 'unknown'
    }
  }

  /**
   * A renewal that ran (proven by its receipt, its log, or its own grants enabled) and some of whose grants were
   * removed since by another transaction: not made the engine's approval, part of it is gone. The ones still enabled
   * are never dropped from tracking: remembered as superseded, so the next stop revokes them (and Start is refused
   * until then, see STOP_FIRST). Having run, it also revoked what it was built to revoke. A full renewal revoked the
   * engine's grants: the engine is not left running on revoked grants, the account stops (as a stop would leave it)
   * and says why. An extension revoked none of them: the engine runs on. The caller marks the op.
   */
  private partlyRevoked(acc: AccountState, op: { opId: string; revokes?: Hex[]; extend?: boolean }, ids: Hex[], on: boolean[], block: bigint): void {
    const still = ids.filter((_, i) => on[i])
    acc.superseded = [...new Set([...(acc.superseded ?? []), ...still])]
    logErr(`[renew] ${acc.accountKey} ${op.opId} ran but ${ids.length - still.length}/${ids.length} of its grants are disabled at block ${block}: not applied, ${still.length} kept for revocation`, undefined)
    if (op.extend) {
      acc.revoked.push(...(op.revokes ?? []).filter((id) => !acc.revoked.includes(id)))
      acc.superseded = unrevokedIds(acc.superseded, op.revokes ?? [])
      this.store.save()
    } else {
      // The reason first: afterOwner saves, and the inactive account is never stored without it.
      acc.deactivated = { code: 'GRANTS_REVOKED_ELSEWHERE', opId: op.opId, block: block.toString(), at: now() }
      this.afterOwner(acc, { prepareId: op.opId, accountKey: acc.accountKey, kind: 'stop', tx: undefined as never, safeTxHash: '0x', expires: 0, revokes: op.revokes ?? [] }, { blockNumber: block } as TransactionReceipt)
    }
  }

  /**
   * Every grant of a renewal that ran in block `from`, read now: the head block, not one behind `from`. 'behind' when
   * the head is not past `from` yet (nothing can have removed a grant after it there), null when a read fails.
   */
  private async renewalGrantsNow(acc: AccountState, ids: Hex[], from: bigint): Promise<{ block: bigint; on: boolean[] } | 'behind' | null> {
    try {
      const block = await this.client.getBlockNumber()
      // Not below the receipt nor the account's floor (grantsFromBlock, activation, latest owner op): an older view
      // could show grants a later op revoked (#140).
      if (block < this.floorOf(acc, from)) return 'behind'
      const on = await this.enabledAt(acc, ids, block)
      return on ? { block, on } : null
    } catch (e) {
      logErr(`[renew] ${acc.accountKey} head unreadable:`, e)
      return null
    }
  }

  /** Whether block `block` shows none of `ids` enabled on the Safe; false when any read fails. */
  private async noneEnabledAt(acc: AccountState, ids: Hex[], block: bigint): Promise<boolean> {
    const on = await this.enabledAt(acc, ids, block)
    return !!on && !on.some(Boolean)
  }

  /** Whether each of `ids` is enabled on the Safe at block `block`; null when any read fails. */
  private async enabledAt(acc: AccountState, ids: Hex[], block: bigint): Promise<boolean[] | null> {
    try {
      // Multicall3 batches pinned at `block`, BATCH_MAX_CALLS ids each, sent one after another (no burst); a call that
      // fails in its batch is read on its own.
      const out: boolean[] = []
      for (let i = 0; i < ids.length; i += BATCH_MAX_CALLS) {
        const batch = new Batch(this.client, multicall3Of(this.cfg.registry), block)
        const handles = ids.slice(i, i + BATCH_MAX_CALLS).map((id) => batch.add(contractRead(this.client, { address: address('SmartSession', this.cfg.registry), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [id, acc.ctx.address as Address], blockNumber: block })))
        await batch.run()
        for (const h of handles) out.push(!!(await h.need()))
      }
      return out
    } catch (e) {
      logErr(`[settle] ${acc.accountKey} grants at block ${block} unreadable, left for later:`, e)
      return null
    }
  }

  /** Whether one block shows the Safe nonce past `nonce` and none of `ids` enabled: an op signed for `nonce` can never run. */
  private async spentWithout(acc: AccountState, nonce: bigint, ids: Hex[]): Promise<boolean> {
    try {
      const block = await this.client.getBlockNumber()
      const now = await this.client.readContract({ address: acc.ctx.address as Address, abi: safeAbi, functionName: 'nonce', blockNumber: block })
      return now > nonce && (await this.noneEnabledAt(acc, ids, block))
    } catch (e) {
      logErr(`[settle] ${acc.accountKey} Safe nonce unreadable, left for later:`, e)
      return false
    }
  }

  /**
   * Permission ids of renewals whose outcome is not known (sent, or receipt unread). A stop revokes them whether or
   * not they are enabled: Smart Sessions takes the removal of a session that is not there, and asking the chain
   * first would leave a gap between that answer and the Safe nonce the stop is signed for.
   */
  private unsettledRenewalGrants(acc: AccountState): Hex[] {
    return acc.ops
      .filter((o) => o.opId.startsWith('own-') && o.kind === 'renew' && (!TERMINAL_STATES.has(o.state) || (o.state === 'failed' && o.code === RECEIPT_UNKNOWN)))
      .flatMap((o) => ((o as StoredOp).ownerGrants ?? []).map((g) => g.permissionId))
  }

  /**
   * A stop of this account is on its way (sent, or failed only for an unread receipt). A stop with an unread receipt
   * counts only while it still can land: until a later owner transaction is confirmed (that one spent the Safe nonce
   * the stop was signed for), and for an hour at most. The engine is paused meanwhile (US6): it opens nothing that the
   * stop's revocation would cut in half.
   */
  private stopInFlight(acc: AccountState): boolean {
    return acc.ops.some((o, i) => {
      if (!o.opId.startsWith('own-') || o.kind !== 'exit') return false
      // In flight for at most a day: one left unsettled longer was never recovered by a restart in time. If it did
      // run, settleStops has already applied it from the chain.
      if (!TERMINAL_STATES.has(o.state)) return Date.now() - (Date.parse(o.updatedAt) || 0) < DAY_MS
      if (o.state !== 'failed' || o.code !== RECEIPT_UNKNOWN) return false
      const spent = acc.ops.slice(i + 1).some((l) => l.opId.startsWith('own-') && l.state === 'confirmed')
      return !spent && Date.now() - (Date.parse(o.updatedAt) || 0) < UNKNOWN_STOP_MS
    })
  }

  /**
   * Why this account cannot renew now, or null. Not running: it starts instead. A stop on its way (sent, or failed
   * only for an unread receipt): the renewal could land after it and enable grants on a stopped account. An engine
   * operation not settled yet: it was signed under the grants the renewal revokes.
   */
  private renewRefusal(acc: AccountState, except?: string): { code: string; message: string } | null {
    if (!acc.active) return { code: 'NOT_ACTIVE', message: 'Mamoru is not running on this account: start it instead of renewing' }
    if (this.stopInFlight(acc)) return { code: 'STOP_IN_FLIGHT', message: 'a stop of this account is on its way: nothing to renew' }
    // One renewal at a time: a second one would be built on grants the first is about to replace.
    // (One left unsettled for more than a day was never recovered by a restart in time: it no longer counts.)
    if (acc.ops.some((o) => o.opId.startsWith('own-') && o.kind === 'renew' && !TERMINAL_STATES.has(o.state) && o.opId !== except && Date.now() - (Date.parse(o.updatedAt) || 0) < DAY_MS)) {
      return { code: 'RENEWAL_IN_FLIGHT', message: 'a renewal of this account is already on its way' }
    }
    const runner = this.runners.get(acc.accountKey)
    // The journal of the running engine, and what is stored: after a restart the journal is empty while a user
    // operation sent before it may still be on its way. A stored one counts for ENGINE_OP_PENDING_MS, not for ever.
    const carriedIds = new Set((acc.carried ?? []).filter((o) => o.state === 'pending_reconciliation').map((o) => o.storedId))
    const stored = acc.ops.some((o) => o.opId.startsWith('eng-') && o.state === 'submitted' && !carriedIds.has(o.opId) && Date.now() - (Date.parse(o.updatedAt) || 0) < ENGINE_OP_PENDING_MS)
    // An op waiting in pending_reconciliation with signed bytes (a bundler rejection; a legacy grant's swap has no
    // deadline and could wait for ever) does not hold the renewal: it is carried to the next engine and watched until
    // it lands or its nonce passes (Sol review round 2 of #64), whatever the renewal does to its grant.
    // Only an op waiting in pending_reconciliation is let through: one in flight (signed, submitted, included) still
    // holds the renewal for the minute it takes, as before.
    const carried = new Set((runner?.engine.carried() ?? []).filter((o) => o.state === 'pending_reconciliation'))
    if (stored || runner?.engine.journal.ops.some((o) => ENGINE_UNSETTLED.has(o.state) && !carried.has(o))) return { code: 'ENGINE_BUSY', message: 'Mamoru is finishing an operation on this account. Try again in a minute.' }
    return null
  }

  private assertRenewable(acc: AccountState): void {
    const no = this.renewRefusal(acc)
    if (no) throw new HttpError(409, no.code, no.message)
  }

  /**
   * otto/mamoru#140 (part2 #3): planned under the account lock from the first read to the stored prepare, so no
   * activation, stop or renewal of the account lands in between; the prepare carries the account's owner
   * generation, and submit and execute refuse it once that has moved (ACTIVATION_STALE).
   */
  prepareActivate(ctx: AccountContext): Promise<OwnerTxToSign> {
    return this.lock(ctx.accountKey).run(() => this.planActivate(ctx))
  }

  private async planActivate(ctx: AccountContext): Promise<OwnerTxToSign> {
    this.assertLive()
    const { acc, live } = this.account(ctx, { readOnly: true })
    // otto/mamoru#140: what is enabled on the Safe now decides a Start (I1, I3): an engine on a revoked grant is
    // stopped, grants revoked since leave `superseded`, untracked ones join it.
    // Refused while that read cannot be made (a failed read, a provider behind the account): never decided blind.
    // Already under the account lock (prepareActivate): called directly, the lock is not re-entrant.
    const checked = await this.enforceGrants(acc)
    if (acc.active) throw new HttpError(409, 'ALREADY_ACTIVE', 'the engine is already active for this account')
    if (!checked) throw new HttpError(503, 'GRANT_CHECK_UNAVAILABLE', 'the approvals on your Safe could not be read just now: nothing was changed, try again in a minute')
    // An activation does not revoke grants left enabled (a partly revoked renewal's survivors, a renewal that landed
    // after a stop): they would stay beside the new approval. A stop revokes them first.
    if (acc.superseded?.length) throw new HttpError(409, 'STOP_FIRST', 'earlier Mamoru grants are still enabled on your Safe: stop first to revoke them, then start')
    const gen = acc.gen ?? 0
    const r = await this.readOf(acc, live.safe)
    // One cap for the whole prepare (spec 006): the check, the grants, the summary and the stored ceiling all use this
    // value, so a settings pull in the middle cannot make them disagree.
    const cap = this.capFor(acc)
    // otto/mamoru#212: what the account holds here and on every other chain, idle and placed.
    const start = await this.startTotal(acc, totalOf(this.localExposure(acc, r)))
    if (start.total > cap) throw depositOverCap(start.total, cap, start.across)
    if (!r.deployed && r.usdc > 0n && r.usdc < MIN_DEPLOY_USDC) throw belowDeployMinimum(r.usdc, this.chainName())
    const policy = this.cfg.policy
    // otto/mamoru#15: a Safe holding enough USDC buys its own gas reserve in this very transaction (self-reserve.ts):
    // the relayer then sends no top-up. Any other start keeps the relayer's top-up, within the activation budget.
    const self = r.usdc > 0n ? await this.selfReserve(live.safe, r) : null
    const reserve = self?.reserve
    const invested = r.usdc - (reserve?.amountIn ?? 0n)
    const reserveLine = self ? [`Convert ${fmtUnitsExact(self.reserve.amountIn, 6)} USDC to at least ${fmtUnits(self.reserve.amountOutMinimum, 18)} ETH on ${self.route}, kept in your Safe as its gas reserve`] : []
    const own = reserve ? { reserveWei: reserve.amountOutMinimum.toString(), reserveDeadline: reserve.deadline.toString() } : {}
    if (isV4(policy)) {
      // Spec 007 T7 (c): a v4 Start enables what fits one Base transaction; the rest follows as one more approval each.
      const keys = policy.session.grants.filter((g) => !g.perPosition).map(grantKey)
      const f = await this.fitV4(acc, live, policy, r, cap, keys, [], 'full', ACTIVATION_GAS_BUDGET, reserve)
      const days = Math.round(policy.session.validitySeconds / 86_400)
      const pools = policy.buckets.filter((b) => b.pools[0]).map((b) => `${poolLabel(b.pools[0]!, this.cfg.registry)} ${b.preference / 100}%`)
      const summary = [
        `${r.deployed ? 'Use' : 'Create'} your Safe ${live.safe} on ${this.chainName()}`,
        ...reserveLine,
        r.usdc > 0n
          ? `Let Mamoru's engine keep your ${fmtUsdc(invested)} USDC invested across Uniswap v3 ${pools.join(', ')}`
          : `Let Mamoru's engine keep your deposit (up to ${fmtUsdc(cap)} USDC) invested across Uniswap v3 ${pools.join(', ')} as soon as it arrives`,
        `Engine key ${f.sessionKey} may swap USDC into those pools' tokens, open positions there, and take out, collect and close only the positions it opened, only near the market price, for ${days} days:`,
        ...this.v4Lines(f.stored, policy, cap),
        ...this.stepLines(f.steps, f.rest),
        `Whatever it collects, mints or swaps is paid to your Safe, never to anyone else. Cap ${fmtUsdc(cap)} USDC`,
      ]
      return this.hold(acc, live, 'activate', f.calls, summary, { grants: f.stored, capUsdc: cap.toString(), gen, ...(f.newKey ? { sessionKey: f.newKey } : {}), ...own })
    }
    const { sessionKey, caps, stored, batch, newKey } = await this.approval(acc, live, policy, r, cap, undefined, 'full', reserve)
    const bind = { gen, ...(newKey ? { sessionKey: newKey } : {}), ...own }
    // What this activation actually enables, not what the policy could: a gas-capped activation (fitActivation)
    // can leave manage-any/convert-any out of `stored`, and the summary must not claim authority that is not
    // in `batch.calls`. manage-any's decrease/collect/burn take any tokenId the Safe owns (grants.ts), in any
    // pool, not only the policy's pools; convert-any's swap stays pinned to that pair's volatile token. The
    // baseline per-position 'manage' grant is excluded here (perPosition, not part of an activation batch) and
    // is kept revoked by the live engine (revokeManage): activation alone never grants decrease/collect/burn,
    // only enter-swap/enter-mint, plus manage-any/convert-any when `liveManage` is non-empty.
    const liveManage = stored.filter((g) => g.name.startsWith('manage-any') || g.name.startsWith('convert-any')).map((g) => g.name)
    const days = Math.round(policy.session.validitySeconds / 86_400)
    const paidToSafe = `It does this without asking you again, within these limits, and whatever it collects, mints or swaps is paid to your Safe, never to anyone else. For ${days} days; cap ${fmtUsdc(cap)} USDC`
    const pools = policy.buckets.filter((b) => b.pools[0]).map((b) => `${poolLabel(b.pools[0]!, this.cfg.registry)} ${b.preference / 100}%`)
    if (pools.length > 1) {
      const summary = [
        `${r.deployed ? 'Use' : 'Create'} your Safe ${live.safe} on ${this.chainName()}`,
        ...reserveLine,
        r.usdc > 0n
          ? `Let Mamoru's engine keep your ${fmtUsdc(invested)} USDC invested across Uniswap v3 ${pools.join(', ')}`
          : `Let Mamoru's engine keep your deposit (up to ${fmtUsdc(cap)} USDC) invested across Uniswap v3 ${pools.join(', ')} as soon as it arrives`,
        `Engine key ${sessionKey} may swap USDC into those pools' tokens and mint positions there`,
        ...(liveManage.length
          ? [`It may also act on any Uniswap v3 position your Safe owns, in any pool: take liquidity out, collect fees, burn it once empty, and convert ${this.volatileOf(liveManage)} back to USDC`]
          : []),
        ...this.limitLines(stored, policy),
        paidToSafe,
      ]
      return this.hold(acc, live, 'activate', batch.calls, summary, { grants: stored, capUsdc: cap.toString(), ...bind })
    }
    // One pool: its label and its token other than USDC, read from the registry ("USDC/cbBTC 0.05%" and "cbBTC" on Base,
    // as these lines always said; "WMON/USDC 0.30%" and "WMON" on Monad, otto/mamoru#61).
    const onePool = policy.buckets.find((b) => b.pools[0])?.pools[0]
    if (!onePool) throw new Error(`${policy.policyId} allocates to no pool`)
    const oneLabel = poolLabel(onePool, this.cfg.registry)
    const oneEntry = entry(onePool, this.cfg.registry)
    const volatile = oneEntry.token0 === 'USDC' ? oneEntry.token1! : oneEntry.token0!
    const summary = [
      `${r.deployed ? 'Use' : 'Create'} your Safe ${live.safe} on ${this.chainName()}`,
      ...reserveLine,
      r.usdc > 0n
        ? `Let Mamoru's engine allocate your ${fmtUsdc(invested)} USDC into Uniswap v3 ${oneLabel}`
        : `Let Mamoru's engine allocate your deposit (up to ${fmtUsdc(cap)} USDC) into Uniswap v3 ${oneLabel} as soon as it arrives`,
      `Engine key ${sessionKey} may swap USDC->${volatile} (max ${fmtUsdc(caps.usdcSwapPerCall ?? 0n)} per swap) and mint that pool`,
      ...(liveManage.length
        ? [`It may also act on any Uniswap v3 position your Safe owns, in any pool: take liquidity out, collect fees, burn it once empty, and convert ${volatile} back to USDC`]
        : []),
      paidToSafe,
    ]
    return this.hold(acc, live, 'activate', batch.calls, summary, { grants: stored, capUsdc: cap.toString(), ...bind })
  }

  /**
   * otto/mamoru#15: the Safe's own gas reserve, bought in the activation batch (self-reserve.ts), or null when this
   * start keeps the relayer's top-up. Quoted at the prepare block on the WETH/USDC pools a withdrawal to ETH uses (best
   * rate wins), priced at that pool's TWAP, and confirmed by a quote of the exact amount.
   */
  private async selfReserve(safe: Address, r: SafeRead): Promise<{ reserve: LiveGasReserve; route: string } | null> {
    // otto/mamoru#61: the reserve swap is priced and routed in WETH on Base's pools. Off Base the relayer tops the Safe up.
    if (this.offBase()) return null
    const target = this.cfg.policy.gasReserveWei + TOP_UP_MARGIN_WEI
    let probe: { receive: LiveReceive; quoted: bigint; route: string; pool: string } | null = null
    if (r.eth < target && r.usdc > 0n) {
      try {
        probe = await this.receiveQuote('ETH', SELF_RESERVE_PROBE_USDC, r.block, this.cfg.policy.execution.slippageBps)
      } catch (e) {
        logErr(`[activate] ${safe} no USDC -> ETH quote for the gas reserve:`, e)
      }
    }
    // The pool the spot quote chose, read for its TWAP: no answer (window not covered, provider down) means no swap.
    let fairCost: bigint | null = null
    if (probe) {
      try {
        const tick = await twapTickAt(this.client, address(probe.pool, this.cfg.registry), SELF_RESERVE_TWAP_SECONDS, r.block)
        fairCost = usdcForWeiAtTick(target - r.eth, tick, entry(probe.pool, this.cfg.registry).token0 === 'WETH')
      } catch (e) {
        logErr(`[activate] ${safe} no TWAP for the gas reserve swap:`, e)
      }
    }
    const fee = probe?.receive.fee ?? 0
    const plan = selfReservePlan({ usdc: r.usdc, eth: r.eth, target, probeOut: probe?.quoted ?? null, fairCost, feeBps: BigInt(fee / 100) })
    if ('skip' in plan) {
      if (plan.skip !== 'FUNDED') console.log(`[activate] ${safe} gas reserve not bought in the batch: ${plan.skip}${fairCost !== null ? ` (TWAP cost ${fairCost} USDC units)` : ''}`)
      return null
    }
    try {
      const quoted = await this.v3.quoteExactInputSingle(this.client, { tokenIn: address('USDC', this.cfg.registry), tokenOut: address('WETH', this.cfg.registry), fee, amountIn: plan.amountIn, blockNumber: r.block })
      if (!selfReserveConfirmed(plan.minOut, quoted)) {
        console.log(`[activate] ${safe} gas reserve not bought in the batch: QUOTE_SHORT (${plan.amountIn} USDC -> ${quoted} wei, need ${plan.minOut})`)
        return null
      }
    } catch (e) {
      logErr(`[activate] ${safe} no quote for the gas reserve swap:`, e)
      return null
    }
    const { timestamp } = await this.client.getBlock({ blockNumber: r.block })
    return { reserve: { fee, amountIn: plan.amountIn, amountOutMinimum: plan.minOut, deadline: timestamp + SELF_RESERVE_DEADLINE_SECONDS }, route: probe!.route }
  }

  /** Planned under the account lock: an in-flight engine op (reduce, re-range) lands first, so the plan sees its liquidity. */
  prepareTransfer(ctx: AccountContext, req: TransferRequest): Promise<TransferPlan> {
    return this.lock(ctx.accountKey).run(() => this.planTransfer(ctx, req))
  }

  private async planTransfer(ctx: AccountContext, req: TransferRequest): Promise<TransferPlan> {
    this.assertLive()
    const { acc, live } = this.account(ctx, { readOnly: true })
    if (!req || typeof req.to !== 'string' || !isAddress(req.to)) throw new HttpError(400, 'BAD_REQUEST', 'to must be an address')
    let amount: bigint
    try {
      amount = BigInt(req.amountUsdc)
    } catch {
      throw new HttpError(400, 'BAD_REQUEST', 'amountUsdc must be an integer string')
    }
    if (amount <= 0n) throw new HttpError(400, 'BAD_REQUEST', 'amountUsdc must be positive')
    const asset: WithdrawAsset = req.asset ?? 'USDC'
    const avail = WITHDRAW_ASSETS.find((a) => a.asset === asset)
    if (!avail) throw new HttpError(400, 'BAD_REQUEST', 'asset must be USDC, EURC, ETH or JPYC')
    if (!avail.available) throw new HttpError(409, 'ASSET_UNAVAILABLE', avail.reason ?? `${asset} is not available`)
    // otto/mamoru#61: payouts in another asset route through Base's pools; off Base a withdrawal pays USDC only.
    if (asset !== 'USDC' && this.offBase()) throw new HttpError(409, 'ASSET_UNAVAILABLE', `${asset} payouts are not available on ${this.chainName()}: withdraw USDC`)
    const payoutCap = PAYOUT_CAP_USDC[asset]
    if (payoutCap !== undefined && amount > payoutCap) throw new HttpError(409, 'CAP_EXCEEDED', `${ASSET_LABEL[asset] ?? asset} payouts are capped at ${fmtUsdc(payoutCap)} USD each`)
    const to = getAddress(req.to)
    if (to.toLowerCase() === live.safe.toLowerCase()) throw new HttpError(400, 'BAD_REQUEST', 'recipient is the Safe itself')
    // An undeployed Safe can still pay out: the relayer deploys it right before the owner transfer (executeOwner).
    const r = await this.readOf(acc, live.safe)
    if (!r.deployed && r.usdc < MIN_DEPLOY_USDC) throw belowDeployMinimum(r.usdc, this.chainName())
    const slip = this.policyOf(acc).execution.slippageBps
    let reduce: { pos: PoolPosition; bps: number; lp: LivePosition }[] = []
    let swaps: QuotedSwap[] = []
    if (r.usdc < amount) {
      const plan = await this.reducePlan(acc, live.safe, r, amount, slip)
      reduce = plan.reduce
      swaps = plan.swaps
    }
    const out = asset === 'USDC' ? undefined : await this.receiveQuote(asset, amount, r.block, slip)
    const deadline = (await this.client.getBlock()).timestamp + 1800n
    const calls = [
      ...closeCalls(live.safe, reduce.map((x) => x.lp), deadline, false, this.cfg.registry),
      ...swapBackCalls(live.safe, swaps, this.cfg.registry),
      ...transferBatch({ account: live.safe, to, amountUsdc: amount, reduce: [], deadline, receive: out?.receive, registry: this.cfg.registry }),
    ]
    const probe = out ? balanceProbe(asset, to, this.cfg.registry) : undefined
    const sim = await this.checkFromSafe(live.safe, calls, r.block, probe)
    if (out && probe) {
      const delta = probe.decode(sim.after!) - probe.decode(sim.before!)
      if (delta < out.receive.amountOutMinimum) throw new HttpError(409, 'SIMULATION_FAILED', `the recipient would receive ${delta} ${asset} units, less than the minimum ${out.receive.amountOutMinimum}`)
    }
    const short = `${to.slice(0, 6)}…${to.slice(-4)}`
    const summary = [
      ...(r.deployed ? [] : [`Create your Safe ${live.safe} on ${this.chainName()}`]),
      ...reduce.map((x) => `Withdraw ${(x.bps / 100).toFixed(2)}% of position #${x.pos.tokenId} (${poolLabel(x.pos.pool, this.cfg.registry)})`),
      ...swaps.map((sw) => `Swap ${sw.amountIn} ${sw.token} units to at least ${fmtUsdc(sw.amountOutMinimum)} USDC`),
      ...(out
        ? [
            `Swap ${fmtUsdc(amount)} USDC from your Safe on ${out.route}`,
            `Receive at least ${fmtUnits(out.receive.amountOutMinimum, out.decimals)} ${ASSET_LABEL[asset] ?? asset} at ${short} (${to})`,
          ]
        : [`Send ${fmtUsdc(amount)} USDC from your Safe to ${to}`]),
    ]
    // otto/mamoru#155: a swap under its pool's TWAP is never refused. The plan (and the minimums the owner signs) stay
    // what they are without it; prepare adds the warning, and submit runs only with it accepted.
    const div = await this.divergenceOf(acc, r, slip, swaps, out ? { ...out, amountIn: amount } : undefined)
    const ownerTx = await this.hold(acc, live, 'transfer', calls, summary, { meta: { amountUsdc: amount.toString(), ...(asset === 'USDC' ? {} : { asset }), to }, ...(div ? { divergence: div.warning, accepted: div.accepted } : {}) })
    return {
      ...(div ? { divergence: div.warning } : {}),
      reduce: reduce.map((x) => ({ tokenId: x.pos.tokenId.toString(), liquidityBps: x.bps })),
      ...(out
        ? { receive: { asset, quoted: out.quoted.toString(), minimum: out.receive.amountOutMinimum.toString(), decimals: out.decimals, route: out.route } }
        : { receive: { asset, quoted: amount.toString(), minimum: amount.toString(), decimals: 6, route: 'Direct USDC transfer' } }),
      ownerTx,
    }
  }

  /** GET withdraw-assets: what a withdraw can pay out in, with the reason when it cannot. */
  async withdrawAssets(): Promise<{ assets: { asset: WithdrawAsset; available: boolean; reason?: string }[] }> {
    const block = await this.client.getBlockNumber()
    const assets = await Promise.all(
      WITHDRAW_ASSETS.map(async (a) => {
        if (!a.available || a.asset === 'USDC') return a
        if (this.offBase()) return { asset: a.asset, available: false, reason: `Not available on ${this.chainName()}: withdraw USDC` }
        try {
          await this.receiveQuote(a.asset, 1_000_000n, block, this.cfg.policy.execution.slippageBps)
          return a
        } catch (e) {
          // otto/mamoru#140 (part1 #7): the caught exception can be a raw RPC/viem error (an HttpRequestError's
          // message carries the full provider URL, key included); never interpolate it into a client-facing reason.
          logErr(`[withdraw-assets] ${a.asset} quote unavailable:`, e)
          return { asset: a.asset, available: false, reason: `No Uniswap quote for ${a.asset} right now; try again shortly` }
        }
      }),
    )
    return { assets }
  }

  /** QuoterV2 at the prepare block over every registered pool for the asset; the best output wins. */
  private async receiveQuote(asset: WithdrawAsset, amountIn: bigint, blockNumber: bigint, slip: number): Promise<{ receive: LiveReceive; quoted: bigint; decimals: number; route: string; pool: string; tokenOut: string }> {
    const routes = RECEIVE_ROUTES[asset as ReceiveAsset]
    if (!routes) throw new HttpError(409, 'ASSET_UNAVAILABLE', `${asset} is not available`)
    let best: { pool: string; fee: number; out: bigint } | undefined
    for (const pool of routes.pools) {
      const fee = entry(pool, this.cfg.registry).fee!
      try {
        const out = await this.v3.quoteExactInputSingle(this.client, { tokenIn: address('USDC', this.cfg.registry), tokenOut: address(routes.tokenOut, this.cfg.registry), fee, amountIn, blockNumber })
        if (!best || out > best.out) best = { pool, fee, out }
      } catch {
        // an empty or broken pool only drops out of the route set
      }
    }
    if (!best) throw new HttpError(503, 'QUOTE_UNAVAILABLE', `no Uniswap v3 quote for USDC -> ${asset}`)
    const pair = `USDC/${routes.tokenOut}`
    const route = `Uniswap v3 ${pair} ${(best.fee / 10_000).toFixed(2)}%${asset === 'ETH' ? ' + unwrap' : ''}`
    return { receive: { asset: routes.receive, fee: best.fee, amountOutMinimum: minOut(best.out, slip) }, quoted: best.out, decimals: entry(routes.tokenOut, this.cfg.registry).decimals!, route, pool: best.pool, tokenOut: routes.tokenOut }
  }

  /**
   * otto/mamoru#155: every swap of a withdrawal (each swap back to USDC, and the payout) judged against its pool's TWAP
   * at the prepare block. A diverging one becomes a leg of the warning, at the minimum the batch already carries. A
   * pool whose TWAP cannot be read is judged as before this check (no warning), and logged.
   */
  private async divergenceOf(
    acc: AccountState,
    r: SafeRead,
    slip: number,
    swaps: QuotedSwap[],
    payout: { pool: string; tokenOut: string; amountIn: bigint; quoted: bigint; decimals: number; receive: LiveReceive } | undefined,
  ): Promise<{ warning: PriceDivergenceWarning; accepted: AcceptedSwap[] } | undefined> {
    const policy = this.policyOf(acc)
    const legs: { leg: PriceDivergenceLeg; usdcIn?: bigint }[] = []
    const accepted: AcceptedSwap[] = []
    const judge = async (pool: string, tokenIn: string, amountIn: bigint, quote: bigint, minimum: bigint) => {
      const e = entry(pool, this.cfg.registry)
      let twapTick: number
      try {
        twapTick = await twapTickAt(this.client, address(pool, this.cfg.registry), policy.execution.twapWindowSeconds, r.block)
      } catch (err) {
        logErr(`[owner] ${acc.accountKey} withdrawal: ${poolLabel(pool, this.cfg.registry)} TWAP unreadable, priced without the divergence check:`, err)
        return null
      }
      const j = judgeSwap({ amountIn, fee: e.fee!, tokenInIsToken0: e.token0 === tokenIn, twapTick, spotTick: r.prices[pool]?.tick, quote, minimum, maxTwapDeviationTicks: policy.execution.maxTwapDeviationTicks, slippageBps: slip })
      return j.divergent ? j.fair : null
    }
    for (const sw of swaps) {
      const fair = await judge(sw.pool, sw.token, sw.amountIn, sw.quoted, sw.amountOutMinimum)
      if (fair === null) continue
      legs.push({ leg: divergenceLeg({ kind: 'swap-back', token: 'USDC', sellToken: sw.token, decimals: 6, fair, quote: sw.quoted, minimum: sw.amountOutMinimum }) })
      accepted.push({ pool: sw.pool, tokenIn: sw.token, tokenOut: 'USDC', fee: entry(sw.pool, this.cfg.registry).fee!, amountIn: sw.amountIn, minimum: sw.amountOutMinimum })
    }
    if (payout) {
      const fair = await judge(payout.pool, 'USDC', payout.amountIn, payout.quoted, payout.receive.amountOutMinimum)
      if (fair !== null) {
        legs.push({ leg: divergenceLeg({ kind: 'payout', token: payout.receive.asset, decimals: payout.decimals, fair, quote: payout.quoted, minimum: payout.receive.amountOutMinimum }), usdcIn: payout.amountIn })
        accepted.push({ pool: payout.pool, tokenIn: 'USDC', tokenOut: payout.tokenOut, fee: payout.receive.fee, amountIn: payout.amountIn, minimum: payout.receive.amountOutMinimum })
      }
    }
    const warning = divergenceWarning(legs)
    if (!warning) return undefined
    console.log(`[owner] ${acc.accountKey} withdrawal under the TWAP: ${warning.legs.map((l) => `${l.kind} ${l.sellToken ?? 'USDC'}->${l.token} fair ${l.fairAmount} min ${l.minAmount} (${l.shortfallBps} bps)`).join('; ')}, quote ${warning.quoteId}`)
    return { warning, accepted }
  }

  /**
   * Withdraw: reduce the stables bucket first, then BTC, then risk (policy bucket order), only as far as needed,
   * plus swaps of what the reduce frees back to USDC; sized from a simulated decrease+collect at the prepare block.
   */
  private async reducePlan(acc: AccountState, safe: Address, r: SafeRead, amount: bigint, slip: number): Promise<{ reduce: { pos: PoolPosition; bps: number; lp: LivePosition }[]; swaps: QuotedSwap[] }> {
    // A position can be worth collecting at 0 current liquidity if a past decrease left tokensOwed uncollected.
    // otto/mamoru#140 (part2 #4): only the positions Mamoru admitted, never dust or ones sent to the Safe unasked.
    const open = this.sizingPositions(acc, r).filter((p) => p.liquidity > 0n || p.tokensOwed0 > 0n || p.tokensOwed1 > 0n)
    const value = open.reduce((s, p) => s + positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, this.cfg.registry), 0n)
    const need = amount - r.usdc
    // otto/mamoru#140 (part1 #4): no open position is not "nothing to withdraw" — idle non-USDC tokens (left by an
    // enter_swap, a close_position, or a failed enter_mint) still swap back below. The loop's own check a few lines
    // down (`target >= value`) is the real "nothing left to free" answer, reached only after that swap is tried.
    const keep = BigInt(10_000 - slip)
    const order = this.bucketPools(acc)
    let margin = 103n
    for (;;) {
      const target = (need * margin) / 100n
      const plan = planReduce(open, r.prices, target > value ? value : target, order, this.cfg.registry)
      const reduce = plan.map(({ pos, bps }) => {
        const liquidity = (pos.liquidity * BigInt(bps)) / 10_000n
        const a = amountsForLiquidity(r.prices[pos.pool]!.sqrtPriceX96, pos.tickLower, pos.tickUpper, liquidity)
        return { pos, bps, lp: { tokenId: pos.tokenId, liquidity, amount0Min: (a.amount0 * keep) / 10_000n, amount1Min: (a.amount1 * keep) / 10_000n } }
      })
      const got = await this.simulateCollect(safe, reduce.map((x) => ({ lp: x.lp, pos: x.pos })), r.block)
      // Idle volatile tokens (left by an engine reduce or re-range) swap back with what the reduce frees.
      for (const [token, raw] of Object.entries(r.tokens)) if (token !== 'USDC' && raw > 0n) got[token] = (got[token] ?? 0n) + raw
      const swaps = await this.swapQuotes(acc, got, r.block, slip)
      const freed = (got.USDC ?? 0n) + swaps.reduce((s, x) => s + x.amountOutMinimum, 0n)
      if (r.usdc + freed >= amount) return { reduce, swaps }
      if (target >= value) throw new HttpError(409, 'INSUFFICIENT_FUNDS', `the Safe can free about ${fmtUsdc(r.usdc + freed)} USDC, less than ${fmtUsdc(amount)}`)
      margin = (margin * 120n) / 100n
    }
  }

  /**
   * otto/mamoru#140 (part2 #4): the positions a withdrawal sizes from and funding shows. Anyone can mint or send a
   * position NFT to a Safe; only the ones Mamoru's engine minted on it count (`admittedTokenIds`). An account from
   * before that record (`admittedTokenIds` absent) counts every position worth more than dust. Largest first, at
   * most MAX_SIZING_POSITIONS.
   */
  /** otto/mamoru#212: the positions the cap counts: every admitted one (an account from before the record: every one above dust). */
  private heldPositions(acc: Pick<AccountState, 'admittedTokenIds'>, r: SafeRead): PoolPosition[] {
    const admitted = acc.admittedTokenIds ? new Set(acc.admittedTokenIds) : null
    return r.positions.filter((p) => (admitted ? admitted.has(p.tokenId.toString()) : positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, this.cfg.registry) >= POSITION_DUST_USDC))
  }

  private sizingPositions(acc: Pick<AccountState, 'admittedTokenIds'>, r: SafeRead): PoolPosition[] {
    const admitted = acc.admittedTokenIds ? new Set(acc.admittedTokenIds) : null
    return r.positions
      .filter((p) => (admitted ? admitted.has(p.tokenId.toString()) : positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, this.cfg.registry) >= POSITION_DUST_USDC))
      .map((p) => ({ p, v: positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, this.cfg.registry) }))
      .sort((a, b) => (a.v === b.v ? 0 : a.v > b.v ? -1 : 1))
      .slice(0, MAX_SIZING_POSITIONS)
      .map((x) => x.p)
  }

  /** What decreaseLiquidity + collect of these positions returns to the Safe, per token, simulated from the Safe at `block`. */
  private async simulateCollect(safe: Address, lps: { lp: LivePosition; pos: PoolPosition }[], block: bigint): Promise<Record<string, bigint>> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const calls: { to: Address; data: Hex; pos?: PoolPosition }[] = lps.flatMap(({ lp: p, pos }) => [
      ...(p.liquidity > 0n ? [this.v3.decreaseLiquidity({ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: p.amount0Min, amount1Min: p.amount1Min, deadline })] : []),
      { ...this.v3.collect({ account: safe, tokenId: p.tokenId }), pos },
    ])
    const res = await this.simulateFromSafe(safe, calls, block)
    const out: Record<string, bigint> = {}
    res.forEach((x, i) => {
      const pos = calls[i]!.pos
      if (pos && calls[i]!.data.startsWith(COLLECT_SELECTOR)) {
        const [a0, a1] = decodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', data: x.returnData })
        out[pos.token0] = (out[pos.token0] ?? 0n) + a0
        out[pos.token1] = (out[pos.token1] ?? 0n) + a1
      }
    })
    return out
  }

  /**
   * Quotes every non-USDC amount back to USDC on its route; amounts too small to quote a positive minimum stay in the
   * Safe. Each swap keeps its quote (`quoted`) for the withdrawal's price divergence check (otto/mamoru#155).
   */
  private async swapQuotes(acc: AccountState, amounts: Record<string, bigint>, blockNumber: bigint, slip: number): Promise<QuotedSwap[]> {
    const out: QuotedSwap[] = []
    for (const [token, raw] of Object.entries(amounts)) {
      if (token === 'USDC') continue
      // one unit less: collect rounding can leave the Safe a unit short of the simulated amount
      const amountIn = raw > 1n ? raw - 1n : 0n
      if (amountIn <= 0n) continue
      const pool = routeOf(token, this.bucketPools(acc), usdcPools(this.cfg.registry), this.cfg.registry)
      if (!pool) continue
      const q = await this.v3.quoteExactInputSingle(this.client, { tokenIn: address(token, this.cfg.registry), tokenOut: address('USDC', this.cfg.registry), fee: entry(pool, this.cfg.registry).fee!, amountIn, blockNumber }).catch(() => 0n)
      if (q <= 1n) continue
      const amountOutMinimum = minOut(q, slip)
      if (amountOutMinimum > 0n) out.push({ token, pool, amountIn, amountOutMinimum, quoted: q })
    }
    return out
  }

  /**
   * Every call of the owner batch, in order, from the Safe (what MultiSendCallOnly does under delegatecall), with
   * eth_simulateV1 at `block`. Refuses before the owner is asked to sign if any call reverts.
   */
  private async simulateFromSafe(safe: Address, calls: { to: Address; data: Hex }[], block: bigint): Promise<SimCallResult[]>
  private async simulateFromSafe(safe: Address, calls: { to: Address; data: Hex }[], block: bigint, probe: Probe | undefined): Promise<SimCallResult[] & { before?: Hex; after?: Hex }>
  private async simulateFromSafe(safe: Address, calls: { to: Address; data: Hex }[], block: bigint, probe?: Probe): Promise<SimCallResult[] & { before?: Hex; after?: Hex }> {
    let res: SimCallResult[] & { before?: Hex; after?: Hex }
    try {
      const batch = calls.map((c) => ({ from: safe, to: c.to, data: c.data }))
      const read = probe ? [{ from: safe, to: probe.to, data: probe.data }] : []
      const all = await simulateCalls(this.client, [...read, ...batch, ...read], block)
      if (probe) {
        const [before, after] = [all[0]!, all[all.length - 1]!]
        if (before.status !== 'success' || after.status !== 'success') throw new Error('recipient balance read failed')
        res = Object.assign(all.slice(1, -1), { before: before.returnData, after: after.returnData })
      } else res = all
    } catch (e) {
      logErr('[owner] simulation unavailable:', e)
      throw safeHttpError(503, 'SIMULATION_UNAVAILABLE')
    }
    const bad = res.findIndex((x) => x.status !== 'success')
    if (bad >= 0) {
      const reason = res[bad]!.error ?? res[bad]!.returnData
      logErr(`[owner] simulation: call ${bad} to ${calls[bad]!.to} (${calls[bad]!.data.slice(0, 10)}) reverts:`, reason)
      // The revert reason itself is chain-decoded data, not an operator-authored string (and could in
      // principle carry something opaque from an unexpected contract): it goes to the journal above
      // (redacted by logErr), never into the client-facing message.
      throw new HttpError(409, 'SIMULATION_FAILED', `call ${bad + 1} of ${calls.length} (${calls[bad]!.data.slice(0, 10)} on ${calls[bad]!.to}) would revert`)
    }
    return res
  }

  /**
   * The pre-signing check of an owner batch. When nothing is read from the result (no payout probe), an unavailable
   * simulation does not stop the owner from preparing a withdrawal or a stop: the preflight decides before sending.
   */
  private async checkFromSafe(safe: Address, calls: { to: Address; data: Hex }[], block: bigint, probe: Probe | undefined): Promise<SimCallResult[] & { before?: Hex; after?: Hex }> {
    try {
      return await this.simulateFromSafe(safe, calls, block, probe)
    } catch (e) {
      if (probe || !(e instanceof HttpError) || e.code !== 'SIMULATION_UNAVAILABLE') throw e
      logErr(`[owner] ${safe} prepare: simulation unavailable, prepared without it:`, e)
      return []
    }
  }

  private async swapQuote(amountIn: bigint, blockNumber: bigint, slip: number): Promise<LiveSwap | undefined> {
    if (amountIn <= 0n) return undefined
    const out = await this.v3.quoteExactInputSingle(this.client, { tokenIn: address('cbBTC', this.cfg.registry), tokenOut: address('USDC', this.cfg.registry), fee: 500, amountIn, blockNumber })
    return { amountIn, amountOutMinimum: minOut(out, slip) }
  }

  /**
   * A revoke-only Stop is planned outside the account lock: it never waits behind another prepare or an engine review.
   * It only reads the grants (synchronously) and the Safe nonce; a renewal landing meanwhile leaves grants it did not
   * name, which the stop records as superseded for the next Stop (afterOwner), as any stop does.
   */
  prepareStop(ctx: AccountContext, opts: { revokeOnly?: boolean } = {}): Promise<OwnerTxToSign> {
    if (opts.revokeOnly) return this.planStop(ctx, opts)
    return this.lock(ctx.accountKey).run(() => this.planStop(ctx, opts))
  }

  /** Every grant enabled on the Safe: the ones the engine uses, the ones a renewal left behind, and those of a renewal whose receipt is not known yet, enabled or not. */
  private stopRevokes(acc: AccountState): Hex[] {
    return [...new Set([...acc.grants.map((g) => g.permissionId), ...(acc.superseded ?? []), ...this.unsettledRenewalGrants(acc), ...this.unsettledActivationGrants(acc)])]
  }

  /**
   * otto/mamoru#163: grants of every activation whose outcome is unresolved. One of its Safe txs may have run unseen
   * (relayed by anyone) or may still run before the stop takes the nonce: a stop revokes them too (a session that is
   * not enabled is removed all the same).
   */
  private unsettledActivationGrants(acc: AccountState): Hex[] {
    // A grant id is unique to the Safe tx that enables it, and a Safe tx runs at most once: one already revoked was
    // enabled by this very op and cannot come back.
    const revoked = new Set(acc.revoked.map((id) => id.toLowerCase()))
    return acc.ops
      .filter((o) => o.opId.startsWith('own-') && o.kind === 'activate' && o.state === 'failed' && o.code === RECEIPT_UNKNOWN)
      .flatMap((o) => ((o as StoredOp).ownerGrants ?? []).map((g) => g.permissionId))
      .filter((id) => !revoked.has(id.toLowerCase()))
  }

  /** The lowest Safe nonce of an activation whose outcome is unresolved, or null (otto/mamoru#163). */
  private unresolvedNonce(acc: AccountState): bigint | null {
    const ns = acc.ops
      .filter((o) => o.opId.startsWith('own-') && o.kind === 'activate' && o.state === 'failed' && o.code === RECEIPT_UNKNOWN && (o as StoredOp).safeNonce !== undefined)
      .map((o) => BigInt((o as StoredOp).safeNonce!))
    return ns.length ? ns.reduce((a, b) => (b < a ? b : a)) : null
  }

  /**
   * otto/mamoru#163: an activation or renewal with no proof it ran. Its Safe nonce still unspent: it can run, `open`.
   * Past it: the Safe's ExecutionSuccess of its Safe tx hash, searched from its first handover to the head, in any
   * transaction (anyone may have relayed it), proves it ran; none means another Safe tx took the nonce: SUPERSEDED when
   * one of this account's own owner ops of that nonce ran, else SAFE_NONCE_MOVED. A read that fails throws: nothing
   * is concluded.
   */
  private async settleByNonce(acc: AccountState, op: StoredOp): Promise<'open' | { close: string; spentBy?: Hex; block?: number } | { hash: Hex; block: number; ok: true }> {
    const v = await this.executionAt(acc, op)
    if (!v) return 'open'
    // Found (by the range search, or in the block that spent the nonce): proof.
    if (v.ran) return { ...v.ran, ok: true }
    if (v.nonce <= BigInt(op.safeNonce!)) {
      // otto/mamoru#15: its reserve swap past its deadline at a final block with the nonce still unspent: it never ran,
      // and never can. Closed, so the owner can approve again; anything short of that proof leaves it open.
      const past = await this.reserveSwapPast(acc, op)
      return past ? { close: RESERVE_SWAP_EXPIRED, block: Number(past) } : 'open'
    }
    const spent = v.spent
    if (!spent) return 'open'
    if (spent.ours) return { close: 'OWNER_TX_FAILED', spentBy: spent.safeTxHash, block: Number(spent.block) }
    const replaced = acc.ops.some((o) => o !== op && o.opId.startsWith('own-') && (o as StoredOp).safeTxHash?.toLowerCase() === spent.safeTxHash.toLowerCase())
    return { close: replaced ? 'SUPERSEDED' : 'SAFE_NONCE_MOVED', spentBy: spent.safeTxHash, block: Number(spent.block) }
  }

  /**
   * otto/mamoru#15: the block that proves an activation's reserve swap can never run, or null. One block B, read by
   * hash, SETTLE_CONFIRMATIONS below the head and still canonical (finalAt), whose own timestamp is past the swap's
   * deadline and at which the Safe nonce is still the op's: up to B the SafeTx did not run, and from B on SwapRouter02
   * refuses the swap ("Transaction too old"), and with it the whole execTransaction (safeTxGas 0: GS013). Any read that
   * fails, or a B not past the deadline yet, is null: no conclusion.
   */
  private async reserveSwapPast(acc: AccountState, op: StoredOp): Promise<bigint | null> {
    if (op.kind !== 'activate' || !op.reserveDeadline || op.safeNonce === undefined) return null
    try {
      const head = await this.client.getBlockNumber({ cacheTime: 0 })
      if (head < SETTLE_CONFIRMATIONS) return null
      const b = await this.client.getBlock({ blockNumber: head - SETTLE_CONFIRMATIONS })
      if (!b.hash || b.number === null || b.timestamp <= BigInt(op.reserveDeadline)) return null
      if ((await this.nonceAtHash(acc.ctx.address as Address, b.hash)) > BigInt(op.safeNonce)) return null
      return (await this.finalAt(b.number, b.hash)) ? b.number : null
    } catch (e) {
      logErr(`[reconcile] ${acc.accountKey} ${op.opId} reserve swap deadline not checked:`, e)
      return null
    }
  }

  /**
   * otto/mamoru#163: positive evidence of which Safe tx spent this op's Safe nonce N, given a block `upTo` at which the
   * Safe nonce is past N. The block X where it went past N is found by a binary search of the Safe nonce read at block
   * numbers (from before the op's first handover); X's hash is read, and the Safe's logs of X are fetched by that hash
   * (EIP-234: a node without the block errors instead of answering empty). The Safe executions of X in log order
   * (ExecutionSuccess or ExecutionFailure, each spending one nonce) name the one that spent N by its topics[1]. Any read
   * that fails, or an X with no such log where one must be, is null: no conclusion.
   */
  private async spentBy(acc: AccountState, op: StoredOp, upTo: bigint): Promise<SpentBy | null> {
    const safe = acc.ctx.address as Address
    const n = BigInt(op.safeNonce!)
    try {
      const nonceAt = async (b: bigint): Promise<bigint> => {
        if (!(await this.client.getCode({ address: safe, blockNumber: b }))) return 0n
        return (await this.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce', blockNumber: b })) as bigint
      }
      // From before the op's first handover (the Safe nonce was N or lower then), widened until it is.
      const top = await this.client.getBlock({ blockNumber: upTo })
      const since = BigInt(Math.floor((op.broadcastAt ?? op.sentAt ?? Date.parse(op.updatedAt)) / 1000))
      let back = (top.timestamp > since ? (top.timestamp - since) / BLOCK_SECONDS : 0n) + 150n
      let lo = upTo > back ? upTo - back : 0n
      let loNonce = await nonceAt(lo)
      while (loNonce > n && lo > 0n) {
        back *= 2n
        lo = upTo > back ? upTo - back : 0n
        loNonce = await nonceAt(lo)
      }
      if (loNonce > n) return null
      let hi = upTo
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n
        const m = await nonceAt(mid)
        if (m > n) hi = mid
        else {
          lo = mid
          loNonce = m
        }
      }
      // One view, by hash: X's header, the Safe nonce at X and at its parent (X must cross N on that very chain), and
      // X's own logs. Final only once X is SETTLE_CONFIRMATIONS deep and still canonical.
      const x = await this.client.getBlock({ blockNumber: hi })
      if (!x.hash || !x.parentHash || x.number === null) return null
      const [atX, atParent] = [await this.nonceAtHash(safe, x.hash), await this.nonceAtHash(safe, x.parentHash)]
      if (!(atX > n && atParent <= n)) {
        console.log(`[reconcile] ${acc.accountKey} ${op.opId} block ${hi} (${x.hash}) does not cross Safe nonce ${n} on its own chain (parent ${atParent}, block ${atX}): no conclusion`)
        return null
      }
      if (!(await this.finalAt(x.number, x.hash))) return null
      const logs = (await this.client.getLogs({ address: safe, blockHash: x.hash } as never)) as unknown as { address: string; topics: Hex[]; logIndex: number | null; transactionHash: Hex | null }[]
      const runs = logs.filter((l) => l.address.toLowerCase() === safe.toLowerCase() && (l.topics[0] === EXECUTION_SUCCESS || l.topics[0] === EXECUTION_FAILURE) && l.topics[1] && l.transactionHash)
      // Ours in X decides by its own log. Log order is not nonce order (a guard can execute another signed Safe tx
      // inside ours, whose log then comes first), so nothing is attributed by position.
      const mine = op.safeTxHash ? runs.find((l) => l.topics[1]!.toLowerCase() === op.safeTxHash!.toLowerCase()) : undefined
      if (mine) return { safeTxHash: mine.topics[1]!, tx: mine.transactionHash!, block: hi, ours: true, success: mine.topics[0] === EXECUTION_SUCCESS }
      // Not ours: another Safe tx spent N only if X holds exactly one Safe execution and the Safe had no guard at X
      // (read at X's hash), so nothing else can have run inside it. Anything else is no conclusion.
      const guard = (await this.client.request({ method: 'eth_getStorageAt', params: [safe, GUARD_STORAGE_SLOT, { blockHash: x.hash }] } as never)) as Hex
      if (runs.length !== 1 || BigInt(guard) !== 0n) {
        console.log(`[reconcile] ${acc.accountKey} ${op.opId} block ${hi} spent Safe nonce ${n} with ${runs.length} Safe execution(s), guard ${BigInt(guard) === 0n ? 'none' : 'set'}: no conclusion`)
        return null
      }
      const run = runs[0]!
      return { safeTxHash: run.topics[1]!, tx: run.transactionHash!, block: hi, ours: false, success: run.topics[0] === EXECUTION_SUCCESS }
    } catch (e) {
      logErr(`[reconcile] ${acc.accountKey} ${op.opId} the block that spent its Safe nonce could not be read:`, e)
      return null
    }
  }

  /**
   * otto/mamoru#163: one view of the chain at a block B (the head, or `pin`). The Safe nonce at B is read first: while
   * it is still the op's own nothing is searched (a relayed execution would have moved it). Past it: a bounded range
   * search (scanFast, from a saved checkpoint) may find the op's ExecutionSuccess quickly, and whatever it does, the
   * block that spent the nonce is read for evidence (spentBy). Null when B or the nonce cannot be read.
   */
  private async executionAt(acc: AccountState, op: StoredOp, pin?: { number: bigint; hash: Hex }): Promise<{ block: bigint; nonce: bigint; ran: { hash: Hex; block: number } | null; spent: SpentBy | null } | null> {
    const safe = acc.ctx.address as Address
    const n = BigInt(op.safeNonce!)
    let block: bigint
    let nonce: bigint
    try {
      if (pin) block = pin.number
      else {
        const b = await this.client.getBlock()
        if (b.number === null) return null
        block = b.number
      }
      if (!(await this.client.getCode({ address: safe, blockNumber: block }))) return { block, nonce: 0n, ran: null, spent: null }
      nonce = (await this.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce', blockNumber: block })) as bigint
    } catch (e) {
      logErr(`[reconcile] ${acc.accountKey} ${op.opId} Safe nonce unreadable, no conclusion:`, e)
      return null
    }
    if (nonce <= n) return { block, nonce, ran: null, spent: null }
    try {
      const fast = await this.scanFast(acc, op, block)
      if (fast) return { block, nonce, ran: fast, spent: null }
    } catch (e) {
      // The fast path never holds up the evidence below.
      logErr(`[reconcile] ${acc.accountKey} ${op.opId} range search failed, reading the spending block instead:`, e)
    }
    const spent = await this.spentBy(acc, op, block)
    if (spent?.ours && spent.success) return { block, nonce, ran: { hash: spent.tx, block: Number(spent.block) }, spent }
    return { block, nonce, ran: null, spent }
  }

  /**
   * otto/mamoru#163: the op's ExecutionSuccess (topics[1], any transaction) in a range search, bounded: from the op's
   * saved checkpoint (or before its first handover) on, at most SCAN_PAGES_PER_PASS pages of OWNER_LOG_PAGE_BLOCKS
   * per pass, the checkpoint advancing as pages answer. Only a hit counts: an empty page proves nothing.
   */
  private async scanFast(acc: AccountState, op: StoredOp, upTo: bigint): Promise<{ hash: Hex; block: number } | null> {
    const own = op.safeTxHash
    if (!own) return null
    const safe = acc.ctx.address as Address
    let from = op.scannedTo !== undefined ? BigInt(op.scannedTo) + 1n : await this.firstSendBlock(op, upTo)
    try {
      for (let i = 0; i < SCAN_PAGES_PER_PASS && from <= upTo; i++) {
        const to = from + OWNER_LOG_PAGE_BLOCKS - 1n < upTo ? from + OWNER_LOG_PAGE_BLOCKS - 1n : upTo
        const page = (await this.client.getLogs({ address: safe, event: EXECUTION_SUCCESS_EVENT, args: { txHash: own }, fromBlock: from, toBlock: to } as never)) as unknown as { address: string; topics: Hex[]; transactionHash: Hex | null; blockNumber: bigint | null }[]
        const hit = (page as { topics: Hex[]; transactionHash: Hex | null; blockNumber: bigint | null; blockHash?: Hex | null }[]).find((l) => l.transactionHash && l.topics[0] === EXECUTION_SUCCESS && l.topics[1]?.toLowerCase() === own.toLowerCase())
        // A hit counts only on the canonical chain, deep enough, with the Safe nonce past N at that very block.
        if (hit && hit.blockHash && hit.blockNumber !== null && (await this.finalAt(hit.blockNumber, hit.blockHash)) && (await this.nonceAtHash(safe, hit.blockHash)) > BigInt(op.safeNonce!)) {
          return { hash: hit.transactionHash!, block: Number(hit.blockNumber) }
        }
        if (hit) {
          console.log(`[reconcile] ${acc.accountKey} ${op.opId} execution log at block ${hit.blockNumber} not final or not canonical yet: not taken`)
          return null
        }
        op.scannedTo = to.toString()
        from = to + 1n
      }
    } finally {
      this.store.save()
    }
    return null
  }

  /** The Safe nonce at a block given by its hash (EIP-1898); 0 before the Safe has code there. Throws on any read error. */
  private async nonceAtHash(safe: Address, blockHash: Hex): Promise<bigint> {
    const code = (await this.client.request({ method: 'eth_getCode', params: [safe, { blockHash }] } as never)) as Hex
    if (!code || code === '0x') return 0n
    const data = encodeFunctionData({ abi: safeAbi, functionName: 'nonce' })
    const raw = (await this.client.request({ method: 'eth_call', params: [{ to: safe, data }, { blockHash }] } as never)) as Hex
    return decodeFunctionResult({ abi: safeAbi, functionName: 'nonce', data: raw }) as bigint
  }

  /**
   * otto/mamoru#163: whether block `number` with `hash` is final enough to settle on: at least SETTLE_CONFIRMATIONS
   * below the head, and still the block at that height (read again by number, same hash).
   */
  private async finalAt(number: bigint, hash: Hex): Promise<boolean> {
    const head = await this.client.getBlockNumber({ cacheTime: 0 })
    if (head < number + SETTLE_CONFIRMATIONS) return false
    const again = await this.client.getBlock({ blockNumber: number })
    return again.hash?.toLowerCase() === hash.toLowerCase()
  }

  /** A block from before the op's first handover (the Safe nonce was its own or lower then), estimated from `upTo`'s time. */
  private async firstSendBlock(op: StoredOp, upTo: bigint): Promise<bigint> {
    const top = await this.client.getBlock({ blockNumber: upTo })
    const since = BigInt(Math.floor((op.broadcastAt ?? op.sentAt ?? Date.parse(op.updatedAt)) / 1000))
    const back = (top.timestamp > since ? (top.timestamp - since) / BLOCK_SECONDS : 0n) + 150n
    return upTo > back ? upTo - back : 0n
  }

  /**
   * otto/mamoru#140 (part2 #4): Stop. The engine's grants are revoked, and up to MAX_STOP_POSITIONS positions are
   * closed and swapped back to USDC, largest first (the ones Mamoru admitted before any other); dust is left alone,
   * and what is left over is closed by the next Stop. `revokeOnly` (or a full plan that cannot be built: a read, a
   * quote or a simulation failing) revokes the grants and nothing else: it reads no position, price or quote, so an
   * attacker who fills the Safe with position NFTs can never keep the owner from revoking the engine.
   */
  private async planStop(ctx: AccountContext, opts: { revokeOnly?: boolean } = {}): Promise<OwnerTxToSign> {
    this.assertLive()
    const { acc, live } = this.account(ctx, { readOnly: true })
    // otto/mamoru#140 (#60): every id the account ever knew is read on chain first, so one the owner enabled again
    // after it was revoked is revoked by this stop too. A full Stop runs under the account lock: the full sweep, which
    // records what it finds. A revoke-only Stop runs outside it: a read that changes nothing, its finds added to this
    // stop's revocations. Unreadable: refused (GRANT_CHECK_UNAVAILABLE), like any read a Stop needs.
    if (opts.revokeOnly) {
      const again = await this.enabledElsewhere(acc)
      if (!again) throw new HttpError(503, 'GRANT_CHECK_UNAVAILABLE', 'the approvals on your Safe could not be read just now: nothing was changed, try again in a minute')
      return this.planRevokeOnly(acc, live, [...new Set([...this.stopRevokes(acc), ...again])])
    }
    if (!(await this.enforceGrants(acc))) throw new HttpError(503, 'GRANT_CHECK_UNAVAILABLE', 'the approvals on your Safe could not be read just now: nothing was changed, try again in a minute')
    const revokes = this.stopRevokes(acc)
    try {
      return await this.planFullStop(acc, live, revokes)
    } catch (e) {
      if (!revokes.length || (e instanceof HttpError && ['NOT_DEPLOYED', 'NOTHING_TO_STOP', 'OPERATOR_BUSY'].includes(e.code))) throw e
      logErr(`[owner] ${acc.accountKey} stop: the full plan could not be built, revoking only:`, e)
      return this.planRevokeOnly(acc, live, revokes, true)
    }
  }

  /**
   * The ids this account knows besides the ones a Stop already revokes (stopRevokes) that read enabled now: revoked
   * ones the owner enabled again, an owner op's grants. A read only, nothing recorded (it runs outside the account
   * lock); null when it cannot be read.
   */
  private async enabledElsewhere(acc: AccountState): Promise<Hex[] | null> {
    const low = (id: string) => id.toLowerCase()
    const known = new Set(this.stopRevokes(acc).map(low))
    const ids = new Map<string, Hex>()
    for (const id of [
      ...(acc.armed?.grants ?? []).map((g) => g.permissionId),
      ...acc.ops.flatMap((o) => [...((o as StoredOp).ownerGrants ?? []).map((g) => g.permissionId), ...((o as StoredOp).revokes ?? [])]),
      ...acc.revoked,
    ]) {
      if (!known.has(low(id)) && !ids.has(low(id))) ids.set(low(id), id)
    }
    const list = [...ids.values()]
    if (!list.length) return []
    const block = await this.headAtLeast(acc, 0n)
    if (block === null) return null
    const on = await this.enabledAt(acc, list, block)
    return on ? list.filter((_, i) => on[i]) : null
  }

  private async planRevokeOnly(acc: AccountState, live: LiveAccount, revokes: Hex[], fallback = false): Promise<OwnerTxToSign> {
    const { deployed } = await readSafeNonce(this.client, live.safe)
    if (!deployed) throw new HttpError(409, 'NOT_DEPLOYED', 'the Safe is not deployed yet')
    if (!revokes.length) throw new HttpError(409, 'NOTHING_TO_STOP', 'no grant to revoke')
    const calls = stopBatch({ account: live.safe, permissionIds: revokes, positions: [], deadline: 0n, registry: this.cfg.registry })
    const summary = [
      `Revoke the engine's ${revokes.length} session grant(s)`,
      fallback ? 'Your positions could not be read just now: they stay in your Safe as they are, and Stop again closes them' : 'Your positions and tokens stay in your Safe as they are; Stop again closes them',
    ]
    return this.hold(acc, live, 'stop', calls, summary, { revokes, revokeOnly: true })
  }

  private async planFullStop(acc: AccountState, live: LiveAccount, revokes: Hex[]): Promise<OwnerTxToSign> {
    const r = await this.readOf(acc, live.safe)
    if (!r.deployed) throw new HttpError(409, 'NOT_DEPLOYED', 'the Safe is not deployed yet')
    const slip = this.policyOf(acc).execution.slippageBps
    const keep = BigInt(10_000 - slip)
    const admitted = new Set(acc.admittedTokenIds ?? [])
    const worth = (p: PoolPosition) => positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, this.cfg.registry)
    // Only what Mamoru admitted, once that is recorded: a position sent to the Safe unasked is never part of a Stop, so
    // it cannot make the unwind revert and keep the admitted ones from being closed.
    const ranked = r.positions
      .filter((p) => (p.liquidity > 0n || p.tokensOwed0 > 0n || p.tokensOwed1 > 0n) && worth(p) >= POSITION_DUST_USDC && (!acc.admittedTokenIds || admitted.has(p.tokenId.toString())))
      .sort((a, b) => (worth(a) === worth(b) ? 0 : worth(a) > worth(b) ? -1 : 1))
    const chosen = ranked.slice(0, MAX_STOP_POSITIONS)
    const left = ranked.length - chosen.length
    const positions: LivePosition[] = chosen.map((p) => ({ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: (p.amount0 * keep) / 10_000n, amount1Min: (p.amount1 * keep) / 10_000n }))
    const got = positions.length ? await this.simulateCollect(live.safe, positions.map((lp, i) => ({ lp, pos: chosen[i]! })), r.block) : {}
    const held: Record<string, bigint> = {}
    for (const [t, v] of Object.entries(r.tokens)) if (t !== 'USDC' && v > 0n) held[t] = v + 1n
    for (const [t, v] of Object.entries(got)) if (t !== 'USDC') held[t] = (held[t] ?? 1n) + v
    const swaps = await this.swapQuotes(acc, held, r.block, slip)
    if (!revokes.length && !positions.length && !swaps.length) throw new HttpError(409, 'NOTHING_TO_STOP', 'no grant, no position and nothing to swap back')
    const deadline = (await this.client.getBlock()).timestamp + 1800n
    const calls = [
      ...(revokes.length || positions.length ? stopBatch({ account: live.safe, permissionIds: revokes, positions, deadline, registry: this.cfg.registry }) : []),
      ...swapBackCalls(live.safe, swaps, this.cfg.registry),
    ]
    await this.checkFromSafe(live.safe, calls, r.block, undefined)
    const summary = [
      ...(revokes.length ? [`Revoke the engine's ${revokes.length} session grant(s)`] : []),
      ...chosen.map((p) => `Close and burn position #${p.tokenId} (${poolLabel(p.pool, this.cfg.registry)})`),
      ...swaps.map((sw) => `Swap ${sw.amountIn} ${sw.token} units to at least ${fmtUsdc(sw.amountOutMinimum)} USDC`),
      'Everything stays in your Safe as USDC',
      ...(left > 0 ? [`${left} more position(s) stay in your Safe: Stop again to close them`] : []),
    ]
    return this.hold(acc, live, 'stop', calls, summary, { revokes })
  }

  // ---- owner side: submit --------------------------------------------------

  async submit(ctx: AccountContext, kind: OwnerKind, body: OwnerSignature): Promise<OpView> {
    this.assertLive()
    // otto/mamoru#140 (part2 #7): an account never seen before is stored only once its owner's signature is proven.
    const view = this.account(ctx, { readOnly: true })
    const live = view.live
    let acc = view.acc
    const p = body && typeof body.prepareId === 'string' ? this.prepared.get(body.prepareId) : undefined
    if (!p || p.accountKey !== acc.accountKey || p.kind !== kind) throw new HttpError(404, 'PREPARE_UNKNOWN', 'no such prepared transaction for this account')
    if (p.expires < Date.now()) {
      this.prepared.delete(p.prepareId)
      throw new HttpError(410, 'PREPARE_EXPIRED', 'the prepared transaction expired, prepare again')
    }
    // otto/mamoru#155: a withdrawal prepared under a price divergence runs only with that warning's quote accepted.
    // Anything else drops the approval (nothing signed stays usable) and the app prepares again, with fresh numbers.
    if (p.divergence && !accepts(p.divergence, body.acceptDivergence)) {
      this.prepared.delete(p.prepareId)
      throw divergenceStale()
    }
    // otto/mamoru#151 (GPT-6 review P1): the renewal signed is the one the row offers now. A move prepared for one policy
    // (v4) after which the offer changed (the v5 flag on) is not sent: the owner prepares again and reads the new summary.
    if (kind === 'renew' && p.policyId !== undefined && p.policyId !== this.renewTarget(acc)) {
      this.prepared.delete(p.prepareId)
      throw new HttpError(409, 'APPROVAL_TARGET_CHANGED', 'what this approval would move your Safe to changed since it was prepared: prepare it again')
    }
    // otto/mamoru#151 (GPT-6 round 2): a full renewal ends a guardian pause. The pause is read again now, before any
    // signature check or send: one set after the prepare (whose summary did not warn) is refused and the approval
    // dropped, so the next tap prepares it with the warning; an unreadable pause is refused as retryable (fail closed).
    if (kind === 'renew' && p.pauseChecked) {
      const paused = await this.readPaused(acc)
      if (paused === null) throw new HttpError(503, 'PAUSE_STATE_UNAVAILABLE', "whether a guardian has paused Mamoru on your Safe could not be read just now: nothing was sent, try again in a minute")
      if (paused && !p.pausedWarned) {
        this.prepared.delete(p.prepareId)
        throw new HttpError(409, 'PAUSE_STATE_CHANGED', 'a guardian paused Mamoru on your Safe after this approval was prepared, and this renewal would end that pause: prepare it again to read why')
      }
    }
    let signature: Hex
    try {
      signature = browserOwnerSignature(body, p.safeTxHash, this.cfg.registry)
    } catch (e) {
      // No Safe signature can be built from this body, so there is nothing to ask the chain about. The shape is kept for diagnosis.
      logErr(`[owner] OWNER_SIG_UNPARSEABLE ${acc.accountKey} ${kind} ${JSON.stringify(bodyShape(body))}:`, e)
      throw safeHttpError(400, 'BAD_SIGNATURE')
    }
    // otto/mamoru#140 (part2 #5): the off-chain check mirrors the on-chain verifier for this account's passkey. When
    // it says no, one provider's simulation is not enough to pay for the transaction (a dishonest one would say yes
    // to anything): at least two independent providers of MAMORU_RPC_TRUSTED must each run the exact sequence the
    // relayer would send and see execTransaction return true, and none may see it revert. Without that pool the
    // signature is refused; a pool that cannot answer is a retryable 503.
    if (!(await verifyOwnerSignature(signature, p.safeTxHash, live.webauthn, this.cfg.registry))) {
      const truth = await this.quorum(live, execData(p.tx, signature))
      if (truth.outcome === 'unavailable') {
        logErr(`[owner] ${acc.accountKey} ${kind} signature not verified off chain and not proven by the trusted providers, retryable:`, truth.why)
        throw safeHttpError(503, 'OWNER_CHECK_UNAVAILABLE')
      }
      if (truth.outcome === 'revert') {
        this.prepared.delete(p.prepareId)
        throw new HttpError(400, 'BAD_SIGNATURE', 'the passkey signature does not match this account and transaction')
      }
      if (truth.outcome === 'unproven') {
        this.prepared.delete(p.prepareId)
        // The shape is closed and pre-vetted (see mirrorMismatch): embedded verbatim, not cut by logErr's redaction.
        logErr(`[alert] ${acc.accountKey} ${kind} OWNER_SIG_UNVERIFIED: off-chain check refused a signature one provider accepts; not sent. shape ${JSON.stringify(bodyShape(body))}`, undefined)
        throw new HttpError(400, 'OWNER_SIG_UNVERIFIED', 'the signature could not be verified for this account')
      }
      this.mirrorMismatch(acc, kind, bodyShape(body))
    }
    acc = this.persist(acc)
    if (kind === 'activate') {
      // part2 #3: an activation prepared before the account's last activation, stop or renewal is not sent, nor one
      // for an account that runs now. Checked again under the account lock right before the send (executeOwner).
      if (this.staleActivation(acc, p)) {
        this.prepared.delete(p.prepareId)
        this.assertFresh(acc, p)
      }
      // part2 #7: the session key generated for this prepare becomes the account's once the owner signed its grants.
      if (p.sessionKey) {
        if (acc.sessionKey && acc.sessionKey !== p.sessionKey) {
          this.prepared.delete(p.prepareId)
          throw new HttpError(409, 'ACTIVATION_STALE', 'the account changed since this Start was prepared: prepare it again')
        }
        acc.sessionKey = p.sessionKey
        this.store.save()
      }
    }
    this.prepared.delete(p.prepareId)
    // otto/mamoru#155: the accepted minimums are in the signed calldata; one the live price has fallen under would only
    // revert. Nothing is sent: the approval is already dropped above, and the app prepares again.
    if (p.accepted?.length && staleAcceptance(p.accepted, await this.liveQuotes(p.accepted))) {
      console.log(`[owner] ${acc.accountKey} ${p.prepareId} accepted quote ${p.divergence?.quoteId} went stale: not sent`)
      throw divergenceStale()
    }
    if (kind === 'renew') {
      // It sends the same costly grant transaction as an activation: the same failure budget applies.
      this.assertBudget(acc)
      await this.lock(acc.accountKey).run(() => this.settleRenewals(acc))
      this.assertRenewable(acc)
      // Built on the grants the account had when it was prepared: if a renewal was applied since, prepare again.
      const now = new Set(acc.grants.map((g) => g.permissionId.toLowerCase()))
      const known = new Set([...now, ...(acc.superseded ?? []).map((s) => s.toLowerCase()), ...this.unsettledRenewalGrants(acc).map((s) => s.toLowerCase()), ...acc.revoked.map((s) => s.toLowerCase())])
      // A renewal must revoke every grant the account has now; an extension must find exactly the grants it was built on.
      const base = new Set((p.base ?? []).map((id) => id.toLowerCase()))
      const changed = p.extend
        ? base.size !== now.size || [...now].some((id) => !base.has(id)) || this.unsettledRenewalGrants(acc).length > 0
        : ![...now].every((id) => (p.revokes ?? []).some((r) => r.toLowerCase() === id))
      if (changed || (p.revokes ?? []).some((id) => !known.has(id.toLowerCase()))) {
        throw new HttpError(409, 'RENEWAL_STALE', 'the approval changed since this renewal was prepared: prepare it again')
      }
    }
    if (kind === 'activate') {
      if (!(await this.lock(acc.accountKey).run(() => this.enforceGrants(acc)))) throw new HttpError(503, 'GRANT_CHECK_UNAVAILABLE', 'the approvals on your Safe could not be read just now: nothing was changed, try again in a minute')
      if (acc.superseded?.length) throw new HttpError(409, 'STOP_FIRST', 'earlier Mamoru grants are still enabled on your Safe: stop first to revoke them, then start')
      // Only a new activation or a renewal is subject to the failure budget; a proven owner's transfer or stop never is.
      this.assertBudget(acc)
      const usdc = await this.usdcOf(live.safe)
      if (usdc === 0n) return this.armFresh(acc, p, signature)
      // The relayer deploys a Safe only for USDC on this chain, whatever the account holds elsewhere (otto/mamoru#212).
      if (!(await readSafeNonce(this.client, live.safe)).deployed && usdc < MIN_DEPLOY_USDC) throw belowDeployMinimum(usdc, this.chainName())
      // otto/mamoru#212: the total across chains, and USDC on its way here from Ethereum.
      const start = await this.startTotal(acc, await this.localTotal(acc, live.safe))
      if (start.total > this.activationCap(acc, p.capUsdc)) throw depositOverCap(start.total, this.activationCap(acc, p.capUsdc), start.across)
      // The relayer cannot pay for it now: the signature waits armed and the watcher runs it once the relayer is funded.
      // A batch that buys its own gas reserve needs no top-up from it (otto/mamoru#15).
      if (!(await this.relayerCanActivate(acc, BigInt(p.reserveWei ?? 0) > 0n))) return this.armFresh(acc, p, signature)
      // part2 #3: checked again after the reads above, with no await before the approval it supersedes is dropped.
      this.assertFresh(acc, p)
      this.disarm(acc, 'ARMED_SUPERSEDED')
    }
    const op = this.newOp(acc, kind === 'stop' ? 'exit' : kind)
    this.stash(acc, op, p)
    const run = this.lock(acc.accountKey).run(() => this.execute(acc, live, p, signature, op))
    run.catch((e) => {
      logErr(`[owner] ${op.opId}:`, e)
      this.relayerBalanceCache = null
      // The relayer ran out of ETH before the owner's transaction went out: same op, back to waiting armed.
      // The relayer ran out of ETH, or the provider refused the transaction outright: the owner's execTransaction never
      // went out and the signature is still good, so the same op goes back to waiting armed and the watcher tries again.
      if (kind === 'activate' && !(e instanceof HttpError) && !(this.execTried.has(opKey(acc, op)) && maybeBroadcast(e)) && (relayerShort(e) || providerRefused(e))) {
        this.lock(acc.accountKey)
          .run(async () => this.rearm(acc, op, p, signature, relayerShort(e) ? 0 : 1))
          .catch((err) => logErr(`[armed] ${op.opId} rearm:`, err))
        return
      }
      // A refusal before anything was sent keeps its own code; anything else may have reached the chain.
      this.failOwner(acc, op, e instanceof HttpError ? e.code : 'OWNER_TX_ERROR')
    })
    await Promise.race([run.catch(() => undefined), Bun.sleep(POST_WAIT_MS)])
    return { ...acc.ops.find((o) => o.opId === op.opId)! }
  }

  /** QuoterV2 at the head for each accepted swap; null where it cannot answer. */
  private async liveQuotes(swaps: readonly AcceptedSwap[]): Promise<(bigint | null)[]> {
    const blockNumber = await this.client.getBlockNumber().catch(() => null)
    if (blockNumber === null) return swaps.map(() => null)
    return Promise.all(
      swaps.map((s) =>
        this.v3.quoteExactInputSingle(this.client, { tokenIn: address(s.tokenIn, this.cfg.registry), tokenOut: address(s.tokenOut, this.cfg.registry), fee: s.fee, amountIn: s.amountIn, blockNumber }).catch((e: unknown) => {
          logErr(`[owner] accepted ${s.tokenIn}->${s.tokenOut} quote unavailable at submit:`, e)
          return null
        }),
      ),
    )
  }

  // ---- owner side: what the relayer will not pay for ------------------------

  /** Failure times of the last 24 h, pruned in place. */
  private recentFailures(acc: AccountState): string[] {
    const since = Date.now() - DAY_MS
    const kept = (acc.ownerFailures ?? []).filter((t) => Date.parse(t) > since)
    if (acc.ownerFailures && kept.length !== acc.ownerFailures.length) acc.ownerFailures = kept
    return kept
  }

  private noteFailure(acc: AccountState): void {
    acc.ownerFailures = [...this.recentFailures(acc), now()]
    this.store.save()
    const all = Object.values(this.store.state.accounts).reduce((n, a) => n + this.recentFailures(a).length, 0)
    if (all >= OWNER_FAILURES_ALERT_PER_DAY) logErr('[alert]', `${all} failed owner executions paid by the relayer in 24 hours, across all accounts`)
  }

  /** Whether this account may not start another activation today. Exit paths never ask. */
  private overBudget(acc: AccountState): boolean {
    return this.recentFailures(acc).length >= MAX_OWNER_FAILURES_PER_DAY
  }

  private assertBudget(acc: AccountState): void {
    if (this.overBudget(acc)) throw safeHttpError(429, 'OWNER_FAILURE_BUDGET')
  }

  /**
   * otto/mamoru#140 (part2 #3): why this activation must not run now, or null. An account that runs refuses any;
   * one whose owner generation (bumped by every activation, stop and renewal that lands) moved since the prepare
   * refuses it as stale. A prepare or armed approval from before generations were kept carries none: only the
   * first rule applies to it.
   */
  private staleActivation(acc: AccountState, p: Pick<Prepared, 'gen'>): 'ALREADY_ACTIVE' | 'ACTIVATION_STALE' | null {
    if (acc.active) return 'ALREADY_ACTIVE'
    if (p.gen !== undefined && p.gen !== (acc.gen ?? 0)) return 'ACTIVATION_STALE'
    return null
  }

  /**
   * otto/mamoru#140 (part2 #6): reserves one sponsored owner transaction of `kind` for this account, at an estimate
   * of its cost, or says which limit refuses it. Synchronous: two sends can never both pass the last free slot.
   */
  private chargeSponsor(acc: AccountState, kind: SponsoredKind, gasPrice: bigint, extraGas = 0n): SponsorEntry | { code: string } {
    const at = Date.now()
    const { own, all } = this.sponsoredOf(acc, at)
    const estimate = (this.gasOf(kind) + extraGas) * gasPrice
    const no = sponsorRefusal(this.sponsorPolicy(), own, all, kind, estimate, at)
    if (no) {
      logErr(`[sponsor] ${acc.accountKey} ${kind} not sponsored (${no.code}) at send time: prepare again, the Safe pays`, undefined)
      return { code: no.code }
    }
    const entry: SponsorEntry = { at: new Date(at).toISOString(), wei: estimate.toString(), kind }
    acc.sponsored = [...own, entry]
    this.store.save()
    return entry
  }

  /**
   * Sol review round 2 #1: reserves the relayer's spend on one activation against the daily activation budget across
   * all accounts, or says it is used up. Synchronous, like chargeSponsor: two activations never both pass the last slot.
   */
  private chargeActivation(acc: AccountState, opId: string, estimate: bigint): SponsorEntry | { code: string } {
    const at = Date.now()
    const { own, all } = this.sponsoredOf(acc, at)
    // A retry of the same activation (an armed one the relayer could not send) holds one slot, not one per try.
    const prior = own.find((e) => e.kind === 'activation' && e.opId === opId)
    if (prior) return prior
    const no = activationRefusal(this.sponsorPolicy(), all, estimate, at)
    if (no) {
      logErr(`[sponsor] ${acc.accountKey} activation not sent (${no.code}): the daily activation budget is used up until ${new Date(no.until).toISOString()}`, undefined)
      return { code: no.code }
    }
    const entry: SponsorEntry = { at: new Date(at).toISOString(), wei: estimate.toString(), kind: 'activation', opId }
    acc.sponsored = [...own, entry]
    this.store.save()
    return entry
  }

  /** What the relayer paid for a Safe-paid transaction that reverted, counted like a sponsored one. */
  private recordSponsor(acc: AccountState, kind: SponsoredKind, receipt: TransactionReceipt, before = 0n): void {
    const paid = before + (receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined ? receipt.gasUsed * receipt.effectiveGasPrice : 0n)
    acc.sponsored = [...recentSponsored(acc.sponsored, Date.now()), { at: now(), wei: paid.toString(), kind }]
    this.store.save()
  }

  private unchargeSponsor(acc: AccountState, entry: SponsorEntry): void {
    acc.sponsored = (acc.sponsored ?? []).filter((e) => e !== entry)
    this.store.save()
  }

  /** The reserved estimate becomes what the receipt says the relayer paid, when it says. */
  private settleSponsor(acc: AccountState, entry: SponsorEntry, receipt: TransactionReceipt, before = 0n): void {
    const paid = receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined ? receipt.gasUsed * receipt.effectiveGasPrice : null
    if (paid === null) return
    entry.wei = (before + paid).toString()
    this.store.save()
  }

  /**
   * otto/mamoru#8: the Safe's native balance this review already read (its own observation, no new RPC call)
   * against this account's gas-reserve alert threshold (gas-reserve.ts). Logs a line only the one cycle the
   * account crosses the threshold, in either direction — not every cycle, which would flood the journal for an
   * account that stays low (nothing refills it today; see gas-reserve.ts's module doc).
   */
  private recordGasReserve(acc: AccountState, nativeWei: bigint, gas: { maxFeePerGas: bigint; opGasUnits: bigint }): void {
    // The floor the engine's own gate checks (the policy it reviews with), and one prefund at the fee it bid this review.
    const threshold = gasReserveAlertWei(this.enginePolicyOf(acc).gasReserveWei, this.gasReserveAlertOverride, gas.maxFeePerGas, gas.opGasUnits)
    const { low, transitioned } = this.gasReserve.record(acc.accountKey, nativeWei, threshold)
    if (transitioned) {
      const state = low ? 'below' : 'back above'
      console.log(`[gas-reserve] ${acc.accountKey} ${state} its alert threshold: ${nativeWei} of ${threshold} wei`)
    }
  }

  private failOwner(acc: AccountState, op: OpView, code: string, detail: Partial<OpView> = {}): void {
    if (BUDGET_CODES.has(code)) this.noteFailure(acc)
    this.patchOp(acc, op.opId, { state: 'failed', code, ...detail })
  }

  /**
   * Everything that can be known before the relayer spends gas on an owner signature. Every owner path runs through
   * here (activate, armed activate, transfer, stop). Returns the refusal, or null to go ahead.
   * - The passkey signed exactly this SafeTx (Safe, chain, nonce): checked off chain, with the chain as ground truth
   *   when that check says no (a successful simulation overrules it, and is logged as OWNER_SIG_MIRROR_MISMATCH). A
   *   forged request needs one of the two to pass, so it never costs the relayer anything.
   * - The whole sequence (deploy if needed, then execTransaction) is simulated. A revert refuses: nothing is sent and
   *   nothing counts against a budget. When the simulation cannot run (provider does not serve eth_simulateV1, rate
   *   limit, timeout) it is tried again, then an eth_call of execTransaction stands in when the Safe is deployed; for
   *   an undeployed Safe, or when eth_call cannot run either, the verified signature and the minimum balance are
   *   enough and the transaction is sent. An unavailable simulation never stops a proven owner.
   */
  private async preflight(acc: AccountState, live: LiveAccount, p: Prepared, signature: Hex): Promise<{ code: string; detail?: Partial<OpView> } | null> {
    if (safeTxHashOf(live, p.tx).toLowerCase() !== p.safeTxHash.toLowerCase()) return { code: 'BAD_SIGNATURE' }
    // The mirror of the on-chain verifier. When it says yes the signature is proven. When it says no, the trusted
    // providers decide (quorum): their agreement is the proof, any revert is the refusal, one provider alone is neither.
    const data = execData(p.tx, signature)
    let proven = await verifyOwnerSignature(signature, p.safeTxHash, live.webauthn, this.cfg.registry)
    if (!proven) {
      const truth = await this.quorum(live, data)
      if (truth.outcome === 'revert') return { code: 'BAD_SIGNATURE' }
      if (truth.outcome === 'unproven') return { code: 'OWNER_SIG_UNVERIFIED' }
      if (truth.outcome === 'unavailable') {
        logErr(`[owner] ${acc.accountKey} ${p.kind} signature not verified off chain and not proven by the trusted providers:`, truth.why)
        throw safeHttpError(503, 'OWNER_CHECK_UNAVAILABLE')
      }
      this.mirrorMismatch(acc, p.kind, ownerSignatureShape(signature))
      proven = true
    }
    for (let attempt = 0; ; attempt++) {
      const { deployed, nonce } = await readSafeNonce(this.client, live.safe)
      if (nonce !== p.tx.nonce) return { code: 'SAFE_NONCE_MOVED' }
      const usdc = await this.usdcOf(live.safe)
      if (p.kind === 'activate') {
        // otto/mamoru#212: the total across chains; a peer that cannot be read keeps it from running now.
        const start = await this.localTotal(acc, live.safe).then((local) => this.startTotal(acc, local)).catch(() => null)
        if (!start) return { code: 'CAP_CHECK_UNAVAILABLE' }
        if (start.total > this.activationCap(acc, p.capUsdc)) return { code: 'DEPOSIT_OVER_CAP', detail: { amountUsdc: start.total.toString(), capUsdc: this.activationCap(acc, p.capUsdc).toString() } }
      }
      if (!deployed && usdc < MIN_DEPLOY_USDC) return { code: 'BELOW_DEPLOY_MINIMUM' }
      // otto/mamoru#140 (part2 #6): a Safe-paid transaction needs the ETH its fee was quoted at, or the relayer pays a revert (GS011).
      if (p.tx.refund && p.feeWei && (await this.client.getBalance({ address: live.safe })) < BigInt(p.feeWei)) return { code: 'SAFE_FEE_UNFUNDED' }
      let sim = await this.simulateOwner(this.client, live, deployed, data)
      if (sim.outcome === 'unavailable') {
        logErr(`[owner] ${acc.accountKey} ${p.kind} simulation unavailable:`, sim.why)
        if (deployed) sim = await this.callOwner(this.client, live, data)
        if (sim.outcome === 'unavailable') {
          // The signature is proven (off chain, or by the trusted providers): an unavailable simulation never stops it.
          logErr(`[owner] ${acc.accountKey} ${p.kind}:`, `proceeding on the verified signature${deployed ? '' : ' and the minimum balance (Safe not deployed)'}`)
          return null
        }
      }
      if (sim.outcome === 'ok') return null
      if (attempt >= 2) {
        logErr(`[owner] ${acc.accountKey} ${p.kind} would revert, nothing sent:`, sim.why)
        return { code: 'OWNER_TX_REVERTS' }
      }
      logErr(`[owner] ${acc.accountKey} ${p.kind} simulation reverts, retry ${attempt + 1}:`, sim.why)
      await Bun.sleep(this.retryMs)
    }
  }

  /** What the chain says about this execTransaction, from `client`: the relayer's sequence simulated, or an eth_call when the Safe is deployed and the simulation cannot run. A revert is asked again twice (lagging node). */
  private async groundTruth(client: PublicClient, live: LiveAccount, deployed: boolean, data: Hex): Promise<Outcome> {
    for (let attempt = 0; ; attempt++) {
      let sim = await this.simulateOwner(client, live, deployed, data)
      if (sim.outcome === 'unavailable' && deployed) sim = await this.callOwner(client, live, data)
      if (sim.outcome !== 'revert' || attempt >= 2) return sim
      await Bun.sleep(this.retryMs)
    }
  }

  /**
   * otto/mamoru#140 (part2 #5): whether a signature the off-chain verifier refused is valid on chain, decided by
   * independent providers. Any provider (the operator's own included) that sees the sequence revert refuses it. It
   * is proven only when at least two of MAMORU_RPC_TRUSTED, each with execTransaction returning true, agree; the
   * operator's own provider alone is `unproven`. Fewer than two answers is `unavailable` (retryable).
   */
  private async quorum(live: LiveAccount, data: Hex): Promise<Proof> {
    const { deployed } = await readSafeNonce(this.client, live.safe)
    const own = await this.groundTruth(this.client, live, deployed, data)
    if (own.outcome === 'revert') return own
    const trusted = this.cfg.trustedClients ?? []
    if (trusted.length < 2) return own.outcome === 'ok' ? { outcome: 'unproven', why: 'MAMORU_RPC_TRUSTED has fewer than two providers' } : own
    const answers = await Promise.all(trusted.map(async (t) => ({ label: t.label, a: await this.groundTruth(t.client, live, deployed, data).catch((e): Outcome => ({ outcome: 'unavailable', why: (e as Error).message.split('\n')[0] ?? 'error' })) })))
    const revert = answers.find((x) => x.a.outcome === 'revert')
    if (revert) return { outcome: 'revert', why: `${revert.label}: ${(revert.a as { why: string }).why}` }
    const ok = answers.filter((x) => x.a.outcome === 'ok').length
    if (ok >= 2) return { outcome: 'ok' }
    return { outcome: 'unavailable', why: `${ok} of ${trusted.length} trusted providers proved it: ${answers.filter((x) => x.a.outcome !== 'ok').map((x) => `${x.label} ${(x.a as { why: string }).why}`).join('; ')}` }
  }

  /**
   * The mirror refused a signature the chain accepts. Loud on purpose: the mirror has a bug for this authenticator.
   * `shape` is already a closed, pre-vetted diagnostic shape (lengths, flags, a fixed set of key names — never a
   * key, a signature or a challenge/origin value), so it is embedded verbatim rather than passed through
   * `logErr`'s generic redaction: that path truncates at 160 chars and would otherwise cut the JSON off mid-object.
   */
  private mirrorMismatch(acc: AccountState, kind: OwnerKind, shape: unknown): void {
    this.mirrorMismatches++
    logErr(
      `[owner] OWNER_SIG_MIRROR_MISMATCH #${this.mirrorMismatches} ${acc.accountKey} ${kind}: off-chain check refused a signature the chain accepts; proceeding. shape ${JSON.stringify(shape)}`,
      undefined,
    )
  }

  /** The relayer's own sequence in one eth_simulateV1 block: the factory call when the Safe has no code, then execTransaction. */
  private async simulateOwner(client: PublicClient, live: LiveAccount, deployed: boolean, data: Hex): Promise<Outcome> {
    const from = this.relayer.address
    const calls = [...(deployed ? [] : [{ from, ...deployCall(live) }]), { from, to: live.safe, data }]
    let res: SimCallResult[] | undefined
    let why = 'simulation unavailable'
    for (let i = 0; i < SIM_TRIES && !res; i++) {
      try {
        res = await simulateCalls(client, calls, await client.getBlockNumber({ cacheTime: 0 }))
      } catch (e) {
        why = (e as Error).message.split('\n')[0] ?? why
        if (i < SIM_TRIES - 1) await Bun.sleep(this.retryMs)
      }
    }
    if (!res) return { outcome: 'unavailable', why }
    const bad = res.findIndex((x) => x.status !== 'success')
    if (bad >= 0) return { outcome: 'revert', why: `${bad === res.length - 1 ? 'execTransaction' : 'deploy'}: ${res[bad]!.error ?? res[bad]!.returnData}` }
    try {
      if (decodeFunctionResult({ abi: safeAbi, functionName: 'execTransaction', data: res.at(-1)!.returnData }) !== true) return { outcome: 'revert', why: 'execTransaction returned false' }
    } catch {
      return { outcome: 'revert', why: 'execTransaction returned no result' }
    }
    return { outcome: 'ok' }
  }

  /**
   * A plain eth_call of execTransaction from the relayer on a deployed Safe: a revert is a revert, anything else is
   * the provider. otto/mamoru#140 (part2 #5): an answer counts as ok only when it decodes to `true`; any other
   * result (empty, false, garbage) is a revert, never a pass.
   */
  private async callOwner(client: PublicClient, live: LiveAccount, data: Hex): Promise<Outcome> {
    let why = 'eth_call unavailable'
    for (let i = 0; i < SIM_TRIES; i++) {
      try {
        const res = await client.call({ account: this.relayer.address, to: live.safe, data })
        return execReturnsTrue(res.data) ? { outcome: 'ok' } : { outcome: 'revert', why: 'execTransaction did not return true' }
      } catch (e) {
        if (isRevert(e)) return { outcome: 'revert', why: revertReason(e) }
        why = (e as Error).message.split('\n')[0] ?? why
        if (i < SIM_TRIES - 1) await Bun.sleep(this.retryMs)
      }
    }
    return { outcome: 'unavailable', why }
  }

  private usdcOf(safe: Address): Promise<bigint> {
    return this.client.readContract({ address: address('USDC', this.cfg.registry), abi: erc20Abi, functionName: 'balanceOf', args: [safe] })
  }

  /** otto/mamoru#140 (part2 #3): refuses a stale activation; synchronous, so nothing lands between it and what follows. */
  private assertFresh(acc: AccountState, p: Prepared): void {
    const stale = this.staleActivation(acc, p)
    if (stale) throw new HttpError(409, stale, stale === 'ALREADY_ACTIVE' ? 'the engine is already active for this account' : 'the account changed since this Start was prepared: prepare it again')
  }

  /** arm, under the account lock and after a last staleness check: a stale approval never replaces an armed one. */
  private armFresh(acc: AccountState, p: Prepared, signature: Hex): Promise<OpView> {
    return this.lock(acc.accountKey).run(async () => {
      this.assertFresh(acc, p)
      return this.arm(acc, p, signature)
    })
  }

  /** Stores the signed activation (0600 state file); the watcher executes it when USDC lands. */
  private arm(acc: AccountState, p: Prepared, signature: Hex): OpView {
    this.disarm(acc, 'ARMED_SUPERSEDED')
    this.armHold.delete(acc.accountKey)
    const op = this.newOp(acc, 'activate')
    op.code = 'ARMED'
    this.stash(acc, op, p)
    acc.armed = { opId: op.opId, tx: p.tx, safeTxHash: p.safeTxHash, signature, grants: p.grants ?? [], armedAt: now(), ...(p.capUsdc ? { capUsdc: p.capUsdc } : {}), ...(p.gen !== undefined ? { gen: p.gen } : {}), ...(p.reserveWei ? { reserveWei: p.reserveWei, reserveDeadline: p.reserveDeadline } : {}) }
    this.store.save()
    console.log(`[armed] ${acc.accountKey} ${op.opId} armed for ${acc.ctx.address} at Safe nonce ${p.tx.nonce}`)
    return { ...op }
  }

  /**
   * Puts an activation that could not be sent back to waiting armed, on the same op; it costs the owner nothing.
   * `tries` is what this attempt counts towards ARM_MAX_TRIES: none for a relayer short of ETH, one for a refusal.
   * Only while its execTransaction never went out (no hash on the op): once broadcast, it is the receipt's to settle.
   * A newer armed activation or an account that started meanwhile wins: this op is dropped as superseded.
   */
  private rearm(acc: AccountState, op: OpView, p: Prepared, signature: Hex, tries = 0): void {
    const current = acc.ops.find((o) => o.opId === op.opId)
    if (current?.txHash) return this.failOwner(acc, op, 'OWNER_TX_ERROR')
    if (acc.active || acc.armed) return this.patchOp(acc, op.opId, { state: 'failed', code: 'ARMED_SUPERSEDED' })
    acc.armed = { opId: op.opId, tx: p.tx, safeTxHash: p.safeTxHash, signature, grants: p.grants ?? [], armedAt: now(), ...(p.capUsdc ? { capUsdc: p.capUsdc } : {}), ...(p.gen !== undefined ? { gen: p.gen } : {}), ...(p.reserveWei ? { reserveWei: p.reserveWei, reserveDeadline: p.reserveDeadline } : {}), ...(tries || this.execTried.has(opKey(acc, op)) ? { tries, retryAt: retryAt(tries, this.execTried.has(opKey(acc, op))) } : {}), ...(this.execTried.has(opKey(acc, op)) ? { execSent: true } : {}) }
    this.armHold.delete(acc.accountKey)
    this.patchOp(acc, op.opId, { state: 'proposed', code: 'ARMED' })
    this.execTried.delete(opKey(acc, op))
    console.log(`[armed] ${acc.accountKey} ${op.opId} back to armed: ${tries ? 'the provider refused the transaction' : 'the relayer could not pay for it'}`)
  }

  /** Drops a pending armed activation, failing its op with `code` (and what `detail` adds to the op). */
  private disarm(acc: AccountState, code: string, detail: Partial<OpView> = {}): void {
    const a = acc.armed
    if (!a) return
    acc.armed = undefined
    this.patchOp(acc, a.opId, { state: 'failed', code, ...detail })
  }

  /** Every ARM_WATCH_MS: one pass over the armed accounts. */
  private async watchArmed(): Promise<void> {
    if (this.armStopped) return
    await this.checkArmed()
    if (!this.armStopped) this.armTimer = setTimeout(() => this.watchArmed(), ARM_WATCH_MS)
  }

  /**
   * The USDC balance of every armed Safe in one Multicall3 request, whatever their number; executes the armed
   * activation once 0 < USDC <= cap. The batch only says who received something: the amount acted on is read
   * again, on its own, right before executing.
   */
  private async checkArmed(): Promise<void> {
    const at = Date.now()
    const due = Object.values(this.store.state.accounts).filter((a) => a.armed && this.armDue(a, at))
    // One request per BATCH_MAX_CALLS accounts, each on its own: a request that fails loses only its accounts, until the next pass.
    for (let i = 0; i < due.length && !this.armStopped; i += BATCH_MAX_CALLS) await this.checkArmedGroup(due.slice(i, i + BATCH_MAX_CALLS), at)
  }

  private async checkArmedGroup(armed: AccountState[], at: number): Promise<void> {
    const client = this.cfg.watchClient ?? this.client
    const batch = new Batch(client, multicall3Of(this.cfg.registry))
    const balances = armed.map((acc) => batch.add(contractRead(client, { address: address('USDC', this.cfg.registry), abi: erc20Abi, functionName: 'balanceOf', args: [acc.ctx.address as Address] })))
    try {
      await batch.run()
    } catch (e) {
      return logErr('[armed] balances', e)
    }
    for (const [i, acc] of armed.entries()) {
      if (!acc.armed || this.armStopped) continue
      try {
        // Counted as read only once the balance is known: a failed read is tried again on the next pass.
        const seen = await balances[i]!.need()
        this.armRead.set(acc.accountKey, at)
        if (seen === 0n) {
          // The money left, but an approval sent once may have landed first: it still reads its Safe nonce.
          if (acc.armed.execSent) await this.lock(acc.accountKey).run(() => this.fireArmed(acc, 0n))
          continue
        }
        // Something landed: until it is executed or dropped, this account is read every pass (retries included).
        this.armSeen.set(acc.accountKey, at)
        const usdc = await this.usdcOf(acc.ctx.address as Address)
        if (usdc === 0n) continue
        await this.lock(acc.accountKey).run(() => this.fireArmed(acc, usdc))
      } catch (e) {
        logErr(`[armed] ${acc.accountKey}`, e)
      }
    }
  }

  /**
   * Whether an armed Safe is read in this pass: every pass while its owner is around, then slower the longer
   * nothing happens. A clock set back (a last read or a last sighting in the future) reads it at once.
   */
  private armDue(acc: AccountState, at: number): boolean {
    const read = this.armRead.get(acc.accountKey)
    if (read === undefined || read > at) return true
    // Parked: nothing to read until the hold ends. A hold further away than the longest one is a clock set back.
    const hold = this.armHold.get(acc.accountKey)
    if (hold !== undefined && at < hold && hold - at <= ARM_PARKED_MS) return false
    const armedAt = Date.parse(acc.ops.find((o) => o.opId === acc.armed?.opId)?.updatedAt ?? '') || 0
    const idle = at - Math.max(armedAt, this.armSeen.get(acc.accountKey) ?? 0)
    const every = idle < ARM_FRESH_MS ? 0 : idle < ARM_DAY_MS ? ARM_IDLE_MS : ARM_STALE_MS
    // Over the RPC budget no armed Safe is read more than once a minute.
    return at - read >= (this.rpcOverBudget(at) ? Math.max(every, ARM_IDLE_MS) : every)
  }

  /**
   * Leaves an armed approval waiting for something only time or the owner changes: the watcher does not read its
   * Safe again for `ms`. An approval whose execTransaction went to a provider is still read once a minute, so a copy
   * that landed reaches reconciliation while findOwnerTx can find it.
   */
  private park(acc: AccountState, ms: number): void {
    this.armSeen.delete(acc.accountKey)
    this.armHold.set(acc.accountKey, Date.now() + (acc.armed?.execSent ? Math.min(ms, ARM_IDLE_MS) : ms))
  }

  /**
   * The Safe nonce an armed activation was signed for is spent. Its execTransaction never handed to a provider:
   * another owner transaction took the nonce, the activation is dropped. Handed over before: that copy may have
   * landed after all. The chain says which: the permission ids of a signed activation are its own (random salt), so
   * one of them enabled on the Safe means this activation executed, however long ago, and the account is started.
   * Otherwise the op fails as an unknown receipt and reconcileOwner has the last word.
   */
  private async nonceMoved(acc: AccountState, a: ArmedActivation, nonce: bigint): Promise<void> {
    // The owner approved again while the nonce was being read: that approval was signed for the nonce there is now.
    if (acc.armed?.opId !== a.opId) return
    console.log(`[armed] ${acc.accountKey} Safe nonce ${nonce} != armed ${a.tx.nonce}`)
    const op = acc.ops.find((o) => o.opId === a.opId)
    if (!a.execSent && !op?.txHash) return this.disarm(acc, 'ARMED_NONCE_MOVED')
    const permissionId = a.grants[0]?.permissionId
    if (op && permissionId) {
      const enabledAt = (blockNumber?: bigint) =>
        this.client.readContract({ address: address('SmartSession', this.cfg.registry), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [permissionId, acc.ctx.address as Address], ...(blockNumber === undefined ? {} : { blockNumber }) })
      const enabled = await enabledAt()
      if (acc.armed?.opId !== a.opId) return
      if (enabled) {
        // The block it executed in, not the one it is noticed in: deposits and history are read from there. It is the
        // first block with the grant enabled, searched from just before the transaction was first handed over.
        const head = await this.client.getBlockNumber()
        const since = a.sentAt ?? (Date.parse(op.updatedAt) || Date.now())
        const back = BigInt(Math.ceil(Math.max(0, Date.now() - since) / 1000)) / BLOCK_SECONDS + ACTIVATION_SEARCH_MARGIN
        const floor = head > back ? head - back : 0n
        let block: bigint
        let depositsFrom: bigint | undefined
        // The head may come from a node behind the one that answered "enabled": the upper bound has to hold itself, or
        // the search (and an engine started on that head) would be looking at blocks before the execution. Stay armed
        // until the head has it, however many passes that takes; only a head that cannot be read at all counts below.
        let headHasIt: boolean | null = null
        try {
          headHasIt = await enabledAt(head)
        } catch {
          // no historical state: decided by the tries below
        }
        if (headHasIt === false) throw new Error(`grant enabled at latest but not at head ${head}: provider behind`)
        try {
          let lo = floor
          let hi = head
          if (headHasIt === null) throw new Error(`no state served for block ${head}`)
          if (await enabledAt(lo)) hi = lo
          while (lo + 1n < hi) {
            const mid = (lo + hi) / 2n
            if (await enabledAt(mid)) hi = mid
            else lo = mid
          }
          block = hi
          this.recoverFails.delete(acc.accountKey)
        } catch (e) {
          // No provider serves the state of those blocks (a long outage, no archive): tried again for a few passes,
          // then left to reconciliation as an unread receipt. Never started from grant state alone (I2).
          const fails = (this.recoverFails.get(acc.accountKey) ?? 0) + 1
          this.recoverFails.set(acc.accountKey, fails)
          if (fails < RECOVER_TRIES) throw e
          logErr('[alert]', `${acc.accountKey} ${a.opId} grants enabled but the block of its execution could not be read in ${fails} passes: left to reconciliation`)
          this.recoverFails.delete(acc.accountKey)
          block = -1n
        }
        // otto/mamoru#140 (I2): the grants enabled are not proof (the owner may enable the same sessions elsewhere).
        // The block where they were first enabled must hold the Safe's ExecutionSuccess of this approval's own Safe tx hash.
        const own = a.safeTxHash.toLowerCase()
        const proven =
          block >= 0n &&
          (await this.client.getLogs({ address: acc.ctx.address as Address, fromBlock: block, toBlock: block }).then(
            (ls) => ls.some((l) => l.topics[0] === EXECUTION_SUCCESS && l.topics[1]?.toLowerCase() === own),
            (e) => {
              logErr(`[armed] ${acc.accountKey} logs of block ${block} unreadable:`, e)
              return false
            },
          ))
        if (!proven) {
          if (acc.armed?.opId !== a.opId) return
          console.log(`[armed] ${acc.accountKey} ${a.opId} grants enabled but no ExecutionSuccess of its Safe tx hash at block ${block}: left to reconciliation`)
          acc.armed = undefined
          this.failOwner(acc, op, RECEIPT_UNKNOWN)
          this.reconcileSoon(acc)
          return
        }
        if (acc.armed?.opId !== a.opId) return
        console.log(`[armed] ${acc.accountKey} ${a.opId} executed on chain at block ${block} (ExecutionSuccess of its Safe tx hash): account started`)
        this.afterOwner(acc, { prepareId: `armed-${a.opId}`, accountKey: acc.accountKey, kind: 'activate', tx: a.tx, safeTxHash: a.safeTxHash, expires: 0, grants: a.grants, ...(a.capUsdc ? { capUsdc: a.capUsdc } : {}) }, { blockNumber: block } as TransactionReceipt, depositsFrom)
        return this.patchOp(acc, op.opId, { state: 'confirmed', code: 'EXEC_OK', block: Number(block) })
      }
    }
    acc.armed = undefined
    if (op) this.failOwner(acc, op, RECEIPT_UNKNOWN)
    this.reconcileSoon(acc)
  }

  private async fireArmed(acc: AccountState, usdc: bigint): Promise<void> {
    const a = acc.armed
    if (!a || acc.active) return this.disarm(acc, 'ALREADY_ACTIVE')
    // otto/mamoru#140 (part2 #3): armed before the account's last activation, stop or renewal: never run.
    if (this.staleActivation(acc, a) === 'ACTIVATION_STALE') return this.disarm(acc, 'ACTIVATION_STALE')
    // An op whose execTransaction went to a provider once reads its Safe nonce first, on every pass, before anything
    // can hold it (the wait between tries, budget, cap, relayer short): an attempt that landed after all must reach
    // reconciliation while its transaction is still recent.
    const tried = a.execSent === true
    const live = liveAccountFromContext(acc.ctx, this.cfg.registry)
    if (tried) {
      const { deployed, nonce } = await readSafeNonce(this.client, live.safe)
      if (deployed && nonce !== a.tx.nonce) return this.nonceMoved(acc, a, nonce)
    }
    // otto/mamoru#15: its reserve swap at or near its deadline can never run. An approval never sent is dropped and the
    // owner asked for a new one (a failed start); one sent before goes on to executeOwner, which leaves it to the chain.
    if (!tried && a.reserveDeadline && reserveExpired(BigInt(a.reserveDeadline), BigInt(Math.floor(Date.now() / 1000)))) {
      console.log(`[armed] ${acc.accountKey} ${a.opId} gas reserve swap near its deadline, never sent: dropped, the owner approves again`)
      return this.disarm(acc, RESERVE_SWAP_EXPIRED)
    }
    // Nothing in the Safe: the look was only for the nonce of an approval already sent once.
    if (usdc === 0n) return
    // otto/mamoru#140: earlier grants still enabled on the Safe (STOP_FIRST): not run beside them, held until a stop.
    if (acc.superseded?.length) {
      logErr(`[armed] ${acc.accountKey} ${a.opId} held: ${acc.superseded.length} earlier grants still enabled (STOP_FIRST)`, undefined)
      return this.park(acc, ARM_CAP_HOLD_MS)
    }
    // A failed attempt is not tried again at once: the wait grows with the tries.
    if (a.retryAt !== undefined && Date.now() < a.retryAt) return this.park(acc, a.retryAt - Date.now())
    // Over its failure budget the account waits, armed: the budget is a pause on what the relayer pays, and the day
    // that frees it must not cost the owner a new signature.
    if (this.overBudget(acc)) return this.park(acc, ARM_BUDGET_HOLD_MS)
    // Over the cap the approval waits too: it runs if the excess leaves through a path that keeps the Safe nonce, or
    // the cap is raised. The app reads the excess from funding and offers the withdrawal.
    // otto/mamoru#212: the relayer deploys a Safe only for USDC on this chain; money elsewhere never stands in for it.
    if (usdc < MIN_DEPLOY_USDC && !(await readSafeNonce(this.client, live.safe)).deployed) return
    const cap = this.activationCap(acc, a.capUsdc)
    // otto/mamoru#212: counted across chains. The other chains unreadable: the approval waits, kept.
    const peers = await this.peerRead(acc, PEER_START_MAX_AGE_MS)
    if (!peers.ok) {
      logErr(`[armed] ${acc.accountKey} ${a.opId} held: the other chains could not be read (CAP_CHECK_UNAVAILABLE)`, undefined)
      return this.park(acc, ARM_RETRY_MS)
    }
    // The whole of this chain (other tokens, positions, USDC in flight), read now; unreadable: the approval waits.
    const local = await this.localTotal(acc, live.safe).catch((e: unknown) => (logErr(`[armed] ${acc.accountKey} ${a.opId} held: Safe unreadable for the cap check`, e), null))
    if (local === null) return this.park(acc, ARM_RETRY_MS)
    const total = local + peers.chains.reduce((s, e) => s + totalOf(e), 0n)
    if (total > cap) {
      const shown = acc.ops.find((o) => o.opId === a.opId)
      if (shown?.amountUsdc !== total.toString() || shown.capUsdc !== cap.toString()) this.patchOp(acc, a.opId, { amountUsdc: total.toString(), capUsdc: cap.toString() })
      return this.park(acc, ARM_CAP_HOLD_MS)
    }
    // The relayer cannot pay for it yet: stay armed, without using up a try. Waiting is not activity, so the watcher
    // slows down on this account as it does on an idle one, instead of reading it every pass.
    const selfFunded = BigInt(a.reserveWei ?? 0) > 0n
    if (!tried && !(await this.relayerCanActivate(acc, selfFunded))) return this.park(acc, ARM_IDLE_MS)
    const { deployed, nonce } = await readSafeNonce(this.client, live.safe)
    if (deployed && nonce !== a.tx.nonce) return this.nonceMoved(acc, a, nonce)
    // Too little to deploy a Safe for: stay armed and wait for more (funding reports deployMinUsdc).
    if (!deployed && usdc < MIN_DEPLOY_USDC) return
    if (tried && !(await this.relayerCanActivate(acc, selfFunded))) return this.park(acc, ARM_IDLE_MS)
    // A copy handed to a provider earlier may still be pending: while the relayer has a transaction not yet mined,
    // nothing is sent again. Mined, it shows in the Safe nonce above; dropped, the pending count falls back.
    if (tried && (await this.relayerHasPending())) return this.park(acc, ARM_RETRY_MS)
    // otto/mamoru#140: a full grant sweep right before it runs. Unreadable: held (GRANT_CHECK_UNAVAILABLE), tried
    // again on a later pass; earlier grants found enabled: held until a stop (STOP_FIRST).
    if (!(await this.enforceGrants(acc))) {
      logErr(`[armed] ${acc.accountKey} ${a.opId} held: grant check unavailable (GRANT_CHECK_UNAVAILABLE)`, undefined)
      return this.park(acc, ARM_RETRY_MS)
    }
    if (acc.superseded?.length) {
      logErr(`[armed] ${acc.accountKey} ${a.opId} held: ${acc.superseded.length} earlier grants still enabled (STOP_FIRST)`, undefined)
      return this.park(acc, ARM_CAP_HOLD_MS)
    }
    // The approval stays in the state file through the attempt: a restart in the middle must not lose it. It is
    // cleared when the account starts, or when the attempt ends in a failure that is final.
    this.patchOp(acc, a.opId, { code: undefined })
    console.log(`[armed] ${acc.accountKey} ${a.opId} deposit ${usdc} landed, executing`)
    const p: Prepared = { prepareId: `armed-${a.opId}`, accountKey: acc.accountKey, kind: 'activate', tx: a.tx, safeTxHash: a.safeTxHash, expires: Number.MAX_SAFE_INTEGER, grants: a.grants, ...(a.capUsdc ? { capUsdc: a.capUsdc } : {}), ...(a.gen !== undefined ? { gen: a.gen } : {}), ...(a.reserveWei ? { reserveWei: a.reserveWei, reserveDeadline: a.reserveDeadline } : {}) }
    const op = acc.ops.find((o) => o.opId === a.opId)!
    if (a.execSent) this.retried.add(opKey(acc, op))
    try {
      await this.execute(acc, live, p, a.signature, op)
    } catch (e) {
      // Transient RPC/relay failures keep the signed activation armed; the watcher retries it on the next pass.
      // A relayer short of ETH before the execTransaction went out is ours to fix, not the owner's: it does not use up a try.
      this.relayerBalanceCache = null
      const unsent = !acc.ops.find((o) => o.opId === op.opId)?.txHash
      const tries = (a.tries ?? 0) + (relayerShort(e) && unsent ? 0 : 1)
      logErr(`[armed] ${op.opId} attempt ${tries}:`, e)
      // Once the execTransaction went out it is never sent again: the receipt settles it (reconcileOwner reads it).
      // Nor when the answer may mean an earlier copy of it is already in a node (a transport retry after a lost reply).
      if (acc.active) return
      // The owner approved again while this attempt was out: that approval is the one that counts now.
      const current = acc.armed?.opId === op.opId
      if (!unsent || (this.execTried.has(opKey(acc, op)) && maybeBroadcast(e))) {
        if (current) acc.armed = undefined
        return this.failOwner(acc, op, 'OWNER_TX_ERROR')
      }
      if (!current) return
      // Never dropped for failing: past ARM_MAX_TRIES it is parked and tried again every ARM_PARKED_MS, and says so.
      if (tries >= ARM_MAX_TRIES && tries > (a.tries ?? 0)) logErr('[alert]', `${acc.accountKey} ${op.opId} failed ${tries} times, parked: next try in ${ARM_PARKED_MS / 60_000} min`)
      const handed = this.execTried.has(opKey(acc, op))
      acc.armed = { ...a, tries, retryAt: tries > (a.tries ?? 0) || handed ? retryAt(tries, handed) : undefined, execSent: a.execSent || handed || undefined }
      this.execTried.delete(opKey(acc, op))
      this.patchOp(acc, op.opId, { state: 'proposed', code: 'ARMED' })
      return
    }
    if (acc.active || acc.armed?.opId !== op.opId) return
    const ended = acc.ops.find((o) => o.opId === op.opId)
    if (ended?.state !== 'failed') return
    // The cap was met inside the attempt (a deposit landed meanwhile): same wait as above, the approval is kept.
    if ((ended.code === 'DEPOSIT_OVER_CAP' || ended.code === 'CAP_CHECK_UNAVAILABLE') && !ended.txHash) {
      this.patchOp(acc, op.opId, { state: 'proposed', code: 'ARMED' })
      return this.park(acc, ARM_CAP_HOLD_MS)
    }
    // Any other failure the attempt recorded is final for this signature.
    acc.armed = undefined
    this.store.save()
  }

  private newOp(acc: AccountState, kind: OpView['kind']): OpView {
    const op: OpView = { opId: `own-${++acc.seq}-${kind}`, kind, state: 'proposed', updatedAt: now() }
    // When it was created, before anything is sent: the earliest its transaction can be on chain (findOwnerTx).
    ;(op as StoredOp).sentAt = Date.now()
    acc.ops.push(op)
    this.store.save()
    return op
  }

  /** Keeps on the op what a late receipt needs to apply the owner tx (grants, revokes) and what history shows (transfer). */
  private stash(acc: AccountState, op: OpView, p: Prepared): void {
    const o = op as StoredOp
    if ((p.kind === 'activate' || p.kind === 'renew') && p.grants) o.ownerGrants = p.grants
    if ((p.kind === 'activate' || p.kind === 'renew') && p.capUsdc) o.capUsdc = p.capUsdc
    if ((p.kind === 'stop' || p.kind === 'renew') && p.revokes) o.revokes = p.revokes
    if (p.kind === 'renew' && p.extend) o.extend = true
    o.safeTxHash = p.safeTxHash
    o.safeNonce = p.tx.nonce.toString()
    // otto/mamoru#15: past this time (at a final block, Safe nonce unspent) the activation can never run (settleByNonce).
    if (p.kind === 'activate' && p.reserveDeadline) o.reserveDeadline = p.reserveDeadline
    if (p.meta) Object.assign(o, p.meta)
    this.store.save()
  }

  private patchOp(acc: AccountState, opId: string, patch: Partial<OpView>): void {
    const op = acc.ops.find((o) => o.opId === opId)
    if (!op) return
    Object.assign(op, patch, { updatedAt: now() })
    if (patch.state === 'failed' || patch.state === 'confirmed') {
      this.execTried.delete(opKey(acc, op))
      this.retried.delete(opKey(acc, op))
    }
    this.fundingMoved(acc)
    this.store.save()
  }

  private async execute(acc: AccountState, live: LiveAccount, p: Prepared, signature: Hex, op: OpView): Promise<void> {
    this.setBusy(acc, p.kind === 'activate' || p.kind === 'renew' ? 'activating' : p.kind === 'stop' ? 'closing' : 'withdrawing')
    try {
      await this.executeOwner(acc, live, p, signature, op)
    } finally {
      this.busy.delete(acc.accountKey)
      // otto/mamoru#212: whatever an owner transfer or stop moved is not the engine's to put back above the cap.
      if (p.kind === 'transfer' || p.kind === 'stop') this.runners.get(acc.accountKey)?.engine.resetCapReinvest()
      this.fundingMoved(acc)
    }
  }

  /**
   * A retried activation that finds its Safe nonce spent, or its execTransaction reverting, may be looking at its own
   * earlier copy, executed behind an answer that said no. It fails as an unknown receipt with no hash, and
   * reconcileOwner reads the Safe's logs: the account is activated if that copy landed. Returns false for any other op.
   */
  private settleRetried(acc: AccountState, op: OpView, code: string): boolean {
    if (!this.retried.has(opKey(acc, op)) || !SPENT_NONCE_CODES.has(code)) return false
    console.log(`[armed] ${op.opId} retry met ${code}: left to reconciliation`)
    this.failOwner(acc, op, RECEIPT_UNKNOWN, { txHash: undefined })
    this.reconcileSoon(acc)
    return true
  }

  /**
   * otto/mamoru#15: an activation whose reserve swap can no longer be sent (at or near its deadline): nothing more is
   * sent for it. A copy an earlier attempt may have handed to a provider may have landed before the deadline: that op
   * is an unread receipt, settled from the chain (settleByNonce). Otherwise the owner approves again.
   */
  private async reserveExpiredOwner(acc: AccountState, op: OpView, p: Prepared): Promise<boolean> {
    if (p.kind !== 'activate' || !p.reserveDeadline || !reserveExpired(BigInt(p.reserveDeadline), await this.chainNow())) return false
    logErr(`[owner] ${op.opId} gas reserve swap near its deadline, not sent:`, { deadline: p.reserveDeadline })
    if (this.retried.has(opKey(acc, op)) || this.execTried.has(opKey(acc, op))) {
      this.failOwner(acc, op, RECEIPT_UNKNOWN, { txHash: undefined })
      this.reconcileSoon(acc)
    } else this.failOwner(acc, op, RESERVE_SWAP_EXPIRED)
    return true
  }

  /** Unix seconds: the later of this clock and the provider's head, so neither one lagging lets a stale swap through. */
  private async chainNow(): Promise<bigint> {
    const wall = BigInt(Math.floor(Date.now() / 1000))
    try {
      const { timestamp } = await this.client.getBlock()
      return timestamp > wall ? timestamp : wall
    } catch {
      return wall
    }
  }

  private async executeOwner(acc: AccountState, live: LiveAccount, p: Prepared, signature: Hex, op: OpView): Promise<void> {
    let activation: SponsorEntry | null = null
    // otto/mamoru#15: a reserve swap at or near its deadline reverts: nothing is reserved, simulated or sent for it.
    if (await this.reserveExpiredOwner(acc, op, p)) return
    // Under the account lock, right before anything is sent: what was true at submit may not be any more.
    if (p.kind === 'renew') {
      await this.settleRenewals(acc)
      const no = this.renewRefusal(acc, op.opId)
      if (no) return this.failOwner(acc, op, no.code)
    }
    // otto/mamoru#140 (part2 #3): under the account lock, the last word on an activation: not on an account that runs,
    // nor once the account's owner generation moved past the one it was prepared (or armed) at.
    if (p.kind === 'activate') {
      // otto/mamoru#140 (#60): a Start's checks at submit ran outside this lock; the grant state may have changed since
      // (a reconciliation, a settle pass). Checked again here, under the lock, right before anything is sent.
      if (!(await this.enforceGrants(acc))) return this.failOwner(acc, op, 'GRANT_CHECK_UNAVAILABLE')
      if (acc.superseded?.length) return this.failOwner(acc, op, 'STOP_FIRST')
      if (acc.active) return this.failOwner(acc, op, 'ALREADY_ACTIVE')
      const stale = this.staleActivation(acc, p)
      if (stale) return this.failOwner(acc, op, stale)
      // Sol review #3: successful activations are bounded per Safe too, or activate/stop cycles drain the relayer.
      const at = Date.now()
      const done = recentSponsored(acc.sponsored, at).filter((e) => e.kind === 'activate')
      if (done.length >= ACTIVATIONS_PER_DAY) return this.failOwner(acc, op, 'ACTIVATION_LIMIT')
      // Sol review round 2 #1: and across all Safes, what the relayer spends on them (deploy, top-up, exec) is reserved
      // against the daily activation budget before anything is sent, so fresh Safes cannot drain it either.
      const price = await this.gasPrice()
      const { deployed } = await readSafeNonce(this.client, live.safe)
      // otto/mamoru#15: what the batch's own swap pays into the Safe (at least its minimum, or the whole transaction
      // reverts) counts as held: a self-funded activation reserves only its deploy and exec gas, never a top-up.
      const eth = (await this.client.getBalance({ address: live.safe })) + BigInt(p.reserveWei ?? 0)
      const target = this.cfg.policy.gasReserveWei + (await this.topUpMarginWei())
      const reserved = this.chargeActivation(acc, op.opId, ((deployed ? 0n : DEPLOY_GAS) + ACTIVATE_TX_GAS) * price + (eth < target ? target - eth : 0n))
      if ('code' in reserved) return this.failOwner(acc, op, reserved.code)
      activation = reserved
    }
    // A Stop revokes what it was prepared with: a grant enabled since (a renewal that landed meanwhile) would stay on
    // the Safe with the account shown stopped. Prepare again (Sol review #2).
    if (p.kind === 'stop') {
      const signed = new Set((p.revokes ?? []).map((id) => id.toLowerCase()))
      if (this.stopRevokes(acc).some((id) => !signed.has(id.toLowerCase()))) return this.failOwner(acc, op, 'STOP_STALE')
    }
    // part2 #6: a sponsored transaction is counted against the limits in one synchronous step (no await between the
    // check and the record) before anything is sent, deploy included; the reservation goes if nothing is spent after all.
    let sponsored: SponsorEntry | { code: string } | null = null
    if (p.sponsorKind) {
      const price = await this.gasPrice()
      // An undeployed Safe: the deploy is paid by the relayer too, reserved with the transaction (Sol review #4).
      const deployGas = (await readSafeNonce(this.client, live.safe)).deployed ? 0n : DEPLOY_GAS
      sponsored = this.chargeSponsor(acc, p.sponsorKind, price, deployGas)
      // A revoke-only Stop over the stop limit by now is still an emergency revocation, within its own limit.
      if ('code' in sponsored && p.revokeOnly && p.sponsorKind === 'stop') sponsored = this.chargeSponsor(acc, 'revoke', price, deployGas)
    }
    if (sponsored && 'code' in sponsored) {
      if (activation) this.unchargeSponsor(acc, activation)
      return this.failOwner(acc, op, sponsored.code)
    }
    const spent: { any: boolean; deployWei?: bigint; deploySent?: boolean; deployMaxWei?: bigint; exec?: boolean } = { any: false }
    try {
      return await this.executeCharged(acc, live, p, signature, op, sponsored as SponsorEntry | null, spent)
    } finally {
      if (sponsored && !spent.any && !this.execTried.has(opKey(acc, op))) this.unchargeSponsor(acc, sponsored)
      // The activation's reservation stays at its estimate once anything was sent (an upper bound: the top-up is in it).
      if (activation && !spent.any && !this.execTried.has(opKey(acc, op))) this.unchargeSponsor(acc, activation)
      // A Safe-paid transaction whose Safe the relayer deployed but whose exec never went out: no refund came back.
      // Its receipt lost (Sol review round 3 #1): the deploy is counted at the most it could cost, its gas limit at the
      // maxFeePerGas it was signed with when it was sent (round 4), not the SafeTx's earlier price.
      if (!sponsored && p.tx.refund && spent.deploySent && !spent.exec) this.recordSponsor(acc, p.kind as SponsoredKind, {} as TransactionReceipt, spent.deployWei ?? spent.deployMaxWei ?? DEPLOY_GAS * p.tx.refund.gasPrice)
    }
  }

  private async executeCharged(acc: AccountState, live: LiveAccount, p: Prepared, signature: Hex, op: OpView, sponsored: SponsorEntry | null, spent: { any: boolean; deployWei?: bigint; deploySent?: boolean; deployMaxWei?: bigint; exec?: boolean }): Promise<void> {
    const safe = live.safe
    // Before any relayer transaction: signature, guards and a simulation of everything about to be sent.
    const refusal = await this.preflight(acc, live, p, signature)
    if (refusal) return this.settleRetried(acc, op, refusal.code) ? undefined : this.failOwner(acc, op, refusal.code, refusal.detail)
    // A transfer may be the first owner tx of a Safe that never started (deposit over the cap): deploy it first too.
    if (p.kind === 'activate' || p.kind === 'transfer') {
      const { deployed } = await readSafeNonce(this.client, safe)
      if (!deployed) {
        this.setBusy(acc, 'deploying')
        const d = deployCall(live)
        // Spent from the moment the signed deploy goes to the provider (onSending), not before: a failure in the gas
        // estimate or the fee reads sends nothing (Sol review round 3 #2). From then on a lost receipt still counts.
        const { hash, receipt } = await this.relayer.send(d, undefined, (maxFeeWei) => {
          spent.any = true
          spent.deploySent = true
          spent.deployMaxWei = maxFeeWei
        })
        if (receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined) spent.deployWei = receipt.gasUsed * receipt.effectiveGasPrice
        console.log(`[owner] deploy ${safe} tx ${hash} ${receipt.status}`)
        if (receipt.status !== 'success') return this.failOwner(acc, op, 'DEPLOY_FAILED', { txHash: hash })
        this.setBusy(acc, p.kind === 'activate' ? 'activating' : 'withdrawing')
      }
    }
    // otto/mamoru#140 (part 1 #5): the nonce is read before the top-up, not after it, so a Safe whose nonce moved since
    // the preflight never receives the relayer's ETH for a transaction that can no longer run.
    const { nonce } = await readSafeNonce(this.client, safe)
    if (nonce !== p.tx.nonce) return this.settleRetried(acc, op, 'SAFE_NONCE_MOVED') ? undefined : this.patchOp(acc, op.opId, { state: 'failed', code: 'SAFE_NONCE_MOVED' })
    if (p.kind === 'activate') {
      const target = this.cfg.policy.gasReserveWei + (await this.topUpMarginWei())
      // otto/mamoru#15: the batch's own swap fills the reserve (or the whole activation reverts): no top-up for it.
      const own = BigInt(p.reserveWei ?? 0)
      if (own > 0n) console.log(`[owner] ${op.opId} the batch buys the gas reserve: at least ${own} wei into ${safe}`)
      const eth = (await this.client.getBalance({ address: safe })) + own
      if (eth < target) {
        const { hash, receipt } = await this.relayer.send({ to: safe, value: target - eth, gas: 50_000n }, undefined, () => {
          spent.any = true
        })
        console.log(`[owner] top-up ${safe} +${target - eth} wei tx ${hash} ${receipt.status}`)
      }
    }
    const data = execData(p.tx, signature)
    // A load-balanced provider can answer from a lagging node: retry the static check before failing the op.
    for (let attempt = 0; ; attempt++) {
      try {
        // otto/mamoru#140 (part2 #5): only an execTransaction that returns true passes; anything else is a revert.
        const res = await this.client.call({ account: this.relayer.address, to: safe, data })
        if (!execReturnsTrue(res.data)) throw Object.assign(new Error('execution reverted: execTransaction did not return true'), { code: 3 })
        break
      } catch (e) {
        const why = revertReason(e)
        if (attempt >= 2) {
          if (!isRevert(e)) {
            // The provider could not answer; that is not a revert. The signature is proven, so the transaction goes out.
            logErr(`[owner] ${op.opId} eth_call unavailable, sending on the verified signature:`, why)
            break
          }
          logErr(`[owner] ${op.opId} simulation reverts:`, why)
          return this.settleRetried(acc, op, 'OWNER_TX_REVERTS') ? undefined : this.failOwner(acc, op, 'OWNER_TX_REVERTS')
        }
        logErr(`[owner] ${op.opId} simulation reverts, retry ${attempt + 1}:`, why)
        await Bun.sleep(this.retryMs)
      }
    }
    if (p.kind === 'activate') {
      // The balance is read again right before the send, so a deposit that landed since the prepare or the preflight is
      // counted. This narrows the window; it is not atomic: a deposit mined between this read and the activation still
      // gets through, and the chain itself enforces no account cap. Deposits to an account that is already running are
      // outside this check altogether (otto/mamoru#71).
      const usdc = await this.usdcOf(safe)
      // The relayer deploys a Safe only for USDC on this chain, whatever the account holds elsewhere (otto/mamoru#212).
      if (!(await readSafeNonce(this.client, safe)).deployed && usdc < MIN_DEPLOY_USDC) return this.failOwner(acc, op, 'BELOW_DEPLOY_MINIMUM')
      const cap = this.activationCap(acc, p.capUsdc)
      // otto/mamoru#212: the total across chains; a peer that cannot be read keeps it from running now.
      const start = await this.localTotal(acc, safe).then((local) => this.startTotal(acc, local)).catch(() => null)
      if (!start) {
        logErr(`[owner] ${op.opId} the other chains could not be read at send time, not activating`, undefined)
        return this.failOwner(acc, op, 'CAP_CHECK_UNAVAILABLE')
      }
      if (start.total > cap) {
        logErr(`[owner] ${op.opId} deposit over cap at send time, not activating:`, { usdc: start.total.toString(), cap: cap.toString() })
        return this.failOwner(acc, op, 'DEPOSIT_OVER_CAP', { amountUsdc: start.total.toString(), capUsdc: cap.toString() })
      }
    }
    // otto/mamoru#15: checked again right before the exec leaves (the deploy and the simulation took time).
    if (await this.reserveExpiredOwner(acc, op, p)) return
    // Keep the hash as soon as the tx is out: if the receipt poll fails, reconciliation reads it later.
    const sent = this.relayer.send(
      { to: safe, data },
      (h) => this.patchOp(acc, op.opId, { state: 'submitted', txHash: h }),
      (_maxFeeWei, signed?: { hash: Hex; nonce: number }) => {
        this.execTried.add(opKey(acc, op))
        // otto/mamoru#140: when a copy was really handed to a provider (the first and the latest), not when the op was
        // prepared or armed: findOwnerTx searches for its ExecutionSuccess from there.
        const so = op as StoredOp
        so.broadcastAt ??= Date.now()
        so.lastBroadcastAt = Date.now()
        // otto/mamoru#163: every copy of an activation or renewal, by hash, before it leaves.
        if (RELAYABLE_KINDS.has(p.kind) && signed) so.signedTxs = [...(so.signedTxs ?? []), { hash: signed.hash, nonce: signed.nonce }]
        this.store.save()
        // Written before the provider gets it: a restart from here on must know a copy may be out.
        if (acc.armed?.opId === op.opId && !acc.armed.execSent) {
          acc.armed.execSent = true
          acc.armed.sentAt = Date.now()
          this.store.save()
        }
      },
    )
    const { hash, receipt } = await sent
    spent.any = true
    spent.exec = true
    if (sponsored) this.settleSponsor(acc, sponsored, receipt, spent.deployWei ?? 0n)
    // A Safe-paid transaction that reverted (the Safe short of its fee by then, GS011) was paid by the relayer after
    // all: it counts against the account's limits like a sponsored one, so it cannot be repeated for free.
    else if (p.tx.refund && receipt.status !== 'success') this.recordSponsor(acc, p.kind as SponsoredKind, receipt, spent.deployWei ?? 0n)
    this.patchOp(acc, op.opId, { state: 'submitted', txHash: hash })
    const ok = receipt.status === 'success' && receipt.logs.some((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === EXECUTION_SUCCESS)
    console.log(`[owner] ${op.opId} tx ${hash} block ${receipt.blockNumber} ${ok ? 'ok' : 'FAILED'}`)
    // A second copy fails when the first one executed after all (the Safe nonce it was signed for is spent).
    if (!ok && this.settleRetried(acc, op, 'OWNER_TX_FAILED')) return
    // otto/mamoru#163: a reverted activation or renewal leaves its Safe nonce unspent, and the owner's signature can be
    // relayed by anyone until something else takes that nonce. Not final: an unread outcome that only the Safe nonce
    // moving settles (reconcileOwner), and a new approval of it is signed for that same nonce (hold), so only one runs.
    if (!ok && RELAYABLE_KINDS.has(p.kind)) {
      const copy = (op as StoredOp).signedTxs?.at(-1)
      if (copy) copy.reverted = true
      this.failOwner(acc, op, RECEIPT_UNKNOWN, { block: Number(receipt.blockNumber) })
      this.reconcileSoon(acc)
      return
    }
    if (!ok) return this.failOwner(acc, op, 'OWNER_TX_FAILED', { block: Number(receipt.blockNumber) })
    if (p.kind === 'renew' && p.grants?.length) {
      // The same check as every other path that applies a renewal (otto/mamoru#140): its grants are read at the head.
      // A head not past the receipt yet cannot show a later removal; the receipt itself proves them enabled then. A
      // read that fails decides nothing: the op becomes an unread receipt (hash kept) and reconciliation reads again.
      const ids = p.grants.map((g) => g.permissionId)
      const cur = await this.renewalGrantsNow(acc, ids, receipt.blockNumber)
      if (cur === null) {
        this.patchOp(acc, op.opId, { state: 'failed', code: RECEIPT_UNKNOWN, block: Number(receipt.blockNumber) })
        this.reconcileSoon(acc)
        return
      }
      if (cur !== 'behind' && !cur.on.every(Boolean)) {
        this.partlyRevoked(acc, { opId: op.opId, revokes: p.revokes, extend: p.extend }, ids, cur.on, cur.block)
        return this.patchOp(acc, op.opId, { state: 'failed', code: 'RENEWAL_PARTLY_REVOKED', block: Number(receipt.blockNumber) })
      }
    }
    this.afterOwner(acc, p, receipt)
    this.patchOp(acc, op.opId, { state: 'confirmed', code: 'EXEC_OK', block: Number(receipt.blockNumber) })
  }

  /** `depositsFrom`: where deposits are read from when it is not the block of the receipt (a recovered activation). */
  private afterOwner(acc: AccountState, p: Prepared, receipt: TransactionReceipt, depositsFrom?: bigint): void {
    // otto/mamoru#140 (part2 #3): what the account's grants are changed: every activation prepared before is stale.
    if (p.kind !== 'transfer') acc.gen = (acc.gen ?? 0) + 1
    if (p.kind === 'activate') {
      acc.trusted = true
      acc.active = true
      acc.deactivated = undefined
      acc.sponsored = [...recentSponsored(acc.sponsored, Date.now()), { at: now(), wei: receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined ? (receipt.gasUsed * receipt.effectiveGasPrice).toString() : '0', kind: 'activate' }]
      // The approval ran: it is spent. One armed meanwhile for the same Safe nonce can no longer run.
      if (acc.armed?.opId === p.prepareId.replace(/^armed-/, '')) acc.armed = undefined
      else this.disarm(acc, 'ALREADY_ACTIVE')
      acc.grants = p.grants ?? []
      // The engine's own grants are never also in `superseded` (a renewal or stop revokes those).
      acc.superseded = unrevokedIds(acc.superseded ?? [], acc.grants.map((g) => g.permissionId))
      acc.policyId = p.grants?.[0]?.grant.policyId ?? this.cfg.policy.policyId
      // Unknown (a late receipt of an op from before spec 006): the default, the conservative side.
      acc.signedCapUsdc = p.capUsdc ?? LIVE_CAP_USDC.toString()
      acc.managedTokenIds = []
      // part2 #4: from this activation on, the positions this engine mints are the ones that count (sizingPositions).
      // The ones an earlier run minted (left by a bounded Stop) stay counted.
      acc.admittedTokenIds ??= []
      acc.depositsAfter = (depositsFrom ?? receipt.blockNumber).toString()
      acc.historyFromBlock = receipt.blockNumber.toString()
      acc.epoch++
      this.store.save()
      this.startLoop(acc)
    } else if (p.kind === 'stop') {
      this.stopLoop(acc.accountKey)
      this.disarm(acc, 'STOPPED')
      acc.active = false
      acc.revoked.push(...(p.revokes ?? []))
      acc.superseded = unrevoked(acc, p.revokes ?? [])
      acc.grants = []
      acc.managedTokenIds = []
      this.store.save()
    } else if (p.kind === 'renew') {
      const gone = new Set((p.revokes ?? []).map((id) => id.toLowerCase()))
      const kept = (ids: Hex[]) => ids.filter((id) => !gone.has(id.toLowerCase()))
      acc.revoked.push(...(p.revokes ?? []))
      if (acc.active && p.grants?.length) {
        // The engine works with the renewed grants from here on: positions, deposits and history stay as they are.
        // What the transaction did not revoke of the old ones stays enabled until it lapses: remembered for a stop.
        // An extension adds its grants to the ones the engine has; one of the same name (never expected: it is built
        // on the missing ones) replaces the old, which stays enabled and is remembered the same way.
        const names = new Set(p.grants.map((g) => g.name))
        const replaced = p.extend ? acc.grants.filter((g) => names.has(g.name)) : acc.grants
        acc.superseded = kept([...(acc.superseded ?? []), ...replaced.map((g) => g.permissionId)])
        acc.grants = p.extend ? [...acc.grants.filter((g) => !names.has(g.name)), ...p.grants] : p.grants
        if (!p.extend) acc.signedCapUsdc = p.capUsdc ?? LIVE_CAP_USDC.toString()
        // Spec 007 T7: a full renewal into v4 grants moves the account to their policy (the move from v2/v3). Read from
        // the grants themselves, so a late receipt (settleRenewals, reconcileOwner) applies it the same way.
        const first = p.grants[0]?.grant
        if (!p.extend && first?.requiresActionPolicy && first.policyId !== acc.policyId) {
          console.log(`[v4] ${acc.accountKey} moved from ${acc.policyId ?? LEGACY_POLICY} to ${first.policyId}`)
          acc.policyId = first.policyId
        }
        acc.superseded = unrevokedIds(acc.superseded ?? [], acc.grants.map((g) => g.permissionId))
        // The engine restarts on these grants and must not look at the chain from before they were enabled.
        acc.grantsFromBlock = receipt.blockNumber.toString()
        acc.epoch++
        this.store.save()
        this.startLoop(acc)
      } else {
        // It landed on an account that is no longer running (the checks before the send make this a late receipt
        // at most): the grants it enabled are on the Safe with no engine using them. Remembered, so the next stop
        // revokes them.
        acc.superseded = kept([...(acc.superseded ?? []), ...(p.grants ?? []).map((g) => g.permissionId)])
        this.store.save()
      }
    } else {
      // The Safe nonce moved, so an activation signed earlier can never run: drop it and let the app ask for a fresh Start.
      this.disarm(acc, 'ARMED_SUPERSEDED')
    }
  }

  // ---- owner side: late receipts -------------------------------------------

  /** Background pass (throttled, under the account lock): owner ops failed only because the receipt poll failed. */
  private reconcileSoon(acc: AccountState): void {
    if (!this.unresolved(acc)) return
    const last = this.reconciled.get(acc.accountKey) ?? 0
    if (Date.now() - last < RECONCILE_EVERY_MS) return this.reconcileLater(acc)
    this.reconciled.set(acc.accountKey, Date.now())
    this.lock(acc.accountKey)
      .run(() => this.reconcileOwner(acc))
      .catch((e) => logErr(`[reconcile] ${acc.accountKey}`, e))
      .finally(() => this.reconcileLater(acc))
  }

  /** Owner ops whose outcome is still being asked: unread receipts, and renewals not proven yet. */
  private unresolved(acc: AccountState): boolean {
    return acc.ops.some((o) => o.opId.startsWith('own-') && o.state === 'failed' && (o.code === RECEIPT_UNKNOWN || (o.kind === 'renew' && o.code === 'RENEWAL_UNPROVEN')))
  }

  /**
   * otto/mamoru#140: while an account has unresolved owner ops, reconciliation runs again on its own, not only when
   * a request comes in: after reconcileRetryMs, doubling up to reconcileRetryMaxMs (an RPC outage is waited out without
   * hammering it). Nothing left unresolved: the timer and its backoff are dropped.
   */
  private reconcileLater(acc: AccountState): void {
    const key = acc.accountKey
    const t = this.reconcileTimers.get(key)
    if (!this.unresolved(acc) || this.shutDown) {
      if (t?.timer) clearTimeout(t.timer)
      this.reconcileTimers.delete(key)
      return
    }
    if (t?.timer) return
    const delay = t ? Math.min(t.delay * 2, this.reconcileRetryMaxMs) : this.reconcileRetryMs
    const timer = setTimeout(() => {
      const e = this.reconcileTimers.get(key)
      if (e) e.timer = null
      this.reconciled.delete(key)
      this.reconcileSoon(acc)
    }, delay)
    ;(timer as { unref?: () => void }).unref?.()
    this.reconcileTimers.set(key, { timer, delay })
  }

  /** Reads every owner op marked failed with an unknown receipt; a tx that executed becomes confirmed with its side effects. */
  async reconcileOwner(acc: AccountState): Promise<void> {
    const safe = (acc.ctx.address as string).toLowerCase()
    // An unproven renewal too (otto/mamoru#140): asked again until its receipt or log answers for good.
    for (const op of acc.ops.filter((o) => o.opId.startsWith('own-') && o.state === 'failed' && (o.code === RECEIPT_UNKNOWN || (o.kind === 'renew' && o.code === 'RENEWAL_UNPROVEN')))) {
      let found: { hash: Hex; block: number; ok: boolean } | null = null
      const receipt = op.txHash ? await this.receiptOf(op.txHash as Hex) : null
      if (receipt) {
        // The Safe's ExecutionSuccess must carry the Safe tx hash this op was signed for, when one is kept (otto/mamoru#140).
        const own = (op as StoredOp).safeTxHash?.toLowerCase()
        const ok = receipt.status === 'success' && receipt.logs.some((l) => l.address.toLowerCase() === safe && l.topics[0] === EXECUTION_SUCCESS && (!own || l.topics[1]?.toLowerCase() === own))
        found = { hash: receipt.transactionHash, block: Number(receipt.blockNumber), ok }
      } else if (!(RELAYABLE_KINDS.has(op.kind) && (op as StoredOp).safeNonce !== undefined && (op as StoredOp).safeTxHash)) found = await this.findOwnerTx(acc, op)
      // (An activation or renewal with its Safe nonce and Safe tx hash kept is read through executionAt below: no log
      // search while its nonce is unspent, a bounded one otherwise.)
      // otto/mamoru#163: a reverted activation or renewal is not final: its Safe nonce is unspent and anyone may relay its
      // signature. A renewal stays an unread receipt for settleRenewals (applied only once proven; its grants revoked by
      // the next renewal or stop meanwhile). An activation is settled by its Safe nonce (settleByNonce).
      // A renewal not proven by its own receipt (reverted, unreadable, missing; or recorded RENEWAL_UNPROVEN earlier):
      // its ExecutionSuccess in any transaction applies it (anyone may have relayed it). Not found: left as it is.
      if (!found?.ok && op.kind === 'renew' && (op as StoredOp).safeTxHash) {
        const v = await this.executionAt(acc, op as StoredOp)
        if (!v?.ran) continue
        found = { ...v.ran, ok: true }
      }
      // An activation not proven by its own receipt (reverted, or not readable, or not found): settled by the Safe
      // nonce whenever it has moved past its own, by its ExecutionSuccess in whatever transaction carried it.
      if (!found?.ok && op.kind === 'activate' && (op as StoredOp).safeNonce !== undefined) {
        const s = await this.settleByNonce(acc, op as StoredOp)
        if (s === 'open') continue
        if ('close' in s) {
          console.log(`[reconcile] ${op.opId} ${s.close}: ${s.close === RESERVE_SWAP_EXPIRED ? `Safe nonce still ${(op as StoredOp).safeNonce} at final block ${s.block}, past the reserve swap's deadline` : `Safe nonce past ${(op as StoredOp).safeNonce}, not by this Safe tx`}`)
          if (s.spentBy) (op as StoredOp).spentBy = s.spentBy
          this.patchOp(acc, op.opId, { code: s.close, ...(found ? { txHash: found.hash } : {}), ...(s.block !== undefined ? { block: s.block } : {}) })
          continue
        }
        found = s
      }
      if (!found) continue
      const { hash, block } = found
      if (!found.ok) {
        console.log(`[reconcile] ${op.opId} tx ${hash} did not execute`)
        this.patchOp(acc, op.opId, { code: 'OWNER_TX_FAILED', txHash: hash, block })
        continue
      }
      const i = acc.ops.indexOf(op)
      const later = (kind: OpView['kind']) => acc.ops.slice(i + 1).some((o) => o.opId.startsWith('own-') && o.kind === kind && o.state === 'confirmed')
      if (op.kind === 'exit' && !later('activate')) {
        this.stopLoop(acc.accountKey)
        this.disarm(acc, 'STOPPED')
        acc.active = false
        const revokes = op.revokes ?? acc.grants.map((g) => g.permissionId)
        acc.revoked.push(...revokes.filter((r) => !acc.revoked.includes(r)))
        // Grants enabled after this stop (a renewal once it no longer counted as in flight) are still on the Safe.
        acc.superseded = unrevoked(acc, revokes)
        acc.grants = []
        acc.managedTokenIds = []
        // Proven now: the account was stopped by this very stop, not by grants revoked elsewhere.
        if (acc.deactivated?.opId === op.opId) acc.deactivated = undefined
        this.store.save()
      } else if (op.kind === 'activate') {
        if (!op.ownerGrants) {
          console.log(`[reconcile] ${op.opId} landed but its grants were not kept; left as is`)
          continue
        }
        if (!later('exit') && !acc.active) {
          const r = receipt ?? ({ blockNumber: BigInt(block) } as TransactionReceipt)
          this.afterOwner(acc, { prepareId: op.opId, accountKey: acc.accountKey, kind: 'activate', tx: undefined as never, safeTxHash: '0x', expires: 0, grants: op.ownerGrants, ...(op.capUsdc ? { capUsdc: op.capUsdc } : {}) }, r)
        } else {
          // It ran but is not the account's approval: its grants are enabled with no engine using them. Remembered, so a stop revokes them.
          const known = new Set([...acc.revoked, ...acc.grants.map((g) => g.permissionId)].map((id) => id.toLowerCase()))
          acc.superseded = [...new Set([...(acc.superseded ?? []), ...op.ownerGrants.map((g) => g.permissionId).filter((id) => !known.has(id.toLowerCase()))])]
          this.store.save()
        }
      }
      else if (op.kind === 'renew' && op.ownerGrants && later('exit')) {
        // It landed, and a stop came after it: whatever that stop did not revoke of its grants is still enabled.
        const revokedNow = new Set(acc.revoked.map((id) => id.toLowerCase()))
        acc.superseded = [...new Set([...(acc.superseded ?? []), ...op.ownerGrants.map((g) => g.permissionId).filter((id) => !revokedNow.has(id.toLowerCase()))])]
        this.store.save()
      } else if (op.kind === 'renew' && op.ownerGrants && (later('renew') || later('activate'))) {
        // A later renewal or Start was applied without knowing this one had run: never applied over it (that would
        // put the engine back on this one's grants); what it did not revoke is still enabled, remembered for a stop.
        const revokedNow = new Set(acc.revoked.map((id) => id.toLowerCase()))
        acc.superseded = [...new Set([...(acc.superseded ?? []), ...op.ownerGrants.map((g) => g.permissionId).filter((id) => !revokedNow.has(id.toLowerCase()))])]
        this.store.save()
      } else if (op.kind === 'renew' && op.ownerGrants) {
        // Proven to have run, but applied only if every one of its grants is still enabled now (otto/mamoru#140): one
        // removed since must not restart the engine on it. Unreadable now: left as an unread receipt, asked again.
        const ids = op.ownerGrants.map((g) => g.permissionId)
        const cur = await this.renewalGrantsNow(acc, ids, BigInt(block))
        if (!cur || cur === 'behind') continue
        if (!cur.on.every(Boolean)) {
          this.partlyRevoked(acc, op, ids, cur.on, cur.block)
          this.patchOp(acc, op.opId, { state: 'failed', code: 'RENEWAL_PARTLY_REVOKED', txHash: hash, block })
          continue
        }
        this.afterOwner(acc, { prepareId: op.opId, accountKey: acc.accountKey, kind: 'renew', tx: undefined as never, safeTxHash: '0x', expires: 0, grants: op.ownerGrants, revokes: op.revokes, extend: op.extend, ...(op.capUsdc ? { capUsdc: op.capUsdc } : {}) }, receipt ?? ({ blockNumber: BigInt(block) } as TransactionReceipt))
      }
      console.log(`[reconcile] ${op.opId} tx ${hash} landed at block ${block}, confirmed`)
      this.patchOp(acc, op.opId, { state: 'confirmed', code: 'EXEC_OK', txHash: hash, block })
    }
    await this.enforceGrants(acc)
  }

  /** The receipt, or null when the provider does not serve it after a few tries (lagging node, or publicnode's archive gate). */
  private async receiptOf(hash: Hex): Promise<TransactionReceipt | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.client.getTransactionReceipt({ hash })
      } catch (e) {
        logErr(`[reconcile] receipt ${hash.slice(0, 10)}, retry ${attempt + 1}:`, e)
        await Bun.sleep(1_500)
      }
    }
    return null
  }

  /**
   * Without a receipt: the Safe's ExecutionSuccess log of the op's own Safe tx hash. Only an owner execTransaction
   * emits it (engine userOps run through the module), so the log proves the tx executed. otto/mamoru#140: searched
   * from the block it was first handed to a provider around (broadcastAt; else sentAt, else its time) up to the head,
   * at most OWNER_LOG_SEARCH_BLOCKS (about a day) past the latest handover (lastBroadcastAt), in pages of OWNER_LOG_PAGE_BLOCKS sent one after another and filtered by that Safe tx hash, so
   * a transaction that landed late (sent, its hash lost in a timeout) is still found. The Safe tx hash alone is the
   * match, in any transaction (otto/mamoru#163: the owner's signature can be relayed by anyone). `anyTx`: searched to
   * the head (the Safe nonce is past the op's). Without a Safe tx hash (an op stored before it was kept): only the old
   * narrow window around its time, and the log of the op's own relayer transaction, or nothing.
   */
  private async findOwnerTx(acc: AccountState, op: StoredOp, opts: { anyTx?: boolean; toBlock?: bigint } = {}): Promise<{ hash: Hex; block: number; ok: boolean } | null> {
    const head = await this.client.getBlock()
    // From the first time a copy was handed to a provider (an armed Start may wait days between prepare and send),
    // else its creation, else its time; to a day past the latest handover.
    const blockAt = (ms: number) => {
      const t = BigInt(Math.floor(ms / 1000))
      const lag = head.timestamp > t ? (head.timestamp - t) / BLOCK_SECONDS : 0n
      return head.number > lag ? head.number - lag : 0n
    }
    const at = blockAt(op.broadcastAt ?? op.sentAt ?? Date.parse(op.updatedAt))
    const fromBlock = at > 150n ? at - 150n : 0n
    const lastAt = blockAt(op.lastBroadcastAt ?? op.broadcastAt ?? op.sentAt ?? Date.parse(op.updatedAt))
    const own = op.safeTxHash?.toLowerCase() as Hex | undefined
    if (!own) {
      const toBlock = at + 10n < head.number ? at + 10n : head.number
      const logs = (await this.client.getLogs({ address: acc.ctx.address as Address, fromBlock, toBlock })).filter((l) => l.topics[0] === EXECUTION_SUCCESS && l.transactionHash)
      if (op.txHash) {
        const l = logs.find((x) => x.transactionHash!.toLowerCase() === op.txHash!.toLowerCase())
        return l ? { hash: l.transactionHash!, block: Number(l.blockNumber), ok: true } : null
      }
      return null
    }
    // `anyTx` (otto/mamoru#163): the Safe nonce is past this op's, so its Safe tx ran by now or never will: searched to
    // the head, in whatever transaction carried it.
    // `toBlock`: exactly to that block (a pinned view, executionAt), whatever this head says.
    const last = opts.toBlock ?? (!opts.anyTx && lastAt + OWNER_LOG_SEARCH_BLOCKS < head.number ? lastAt + OWNER_LOG_SEARCH_BLOCKS : head.number)
    const logs: Awaited<ReturnType<PublicClient['getLogs']>> = []
    for (let from = fromBlock; from <= last; from += OWNER_LOG_PAGE_BLOCKS) {
      const to = from + OWNER_LOG_PAGE_BLOCKS - 1n < last ? from + OWNER_LOG_PAGE_BLOCKS - 1n : last
      const page = await this.client.getLogs({ address: acc.ctx.address as Address, event: EXECUTION_SUCCESS_EVENT, args: { txHash: own }, fromBlock: from, toBlock: to } as never)
      // ExecutionSuccess(bytes32 indexed txHash, uint256 payment): checked here too, whatever the provider filtered.
      logs.push(...(page as typeof logs).filter((l) => l.topics[0] === EXECUTION_SUCCESS && l.transactionHash && l.topics[1]?.toLowerCase() === own))
      if (logs.length) break
    }
    // otto/mamoru#163: the Safe tx hash (topics[1]) is the match, in whatever transaction carried it: the owner's
    // signature can be relayed by anyone, so a log in another transaction than our copy is still this op's execution.
    // A Safe tx runs at most once, so there is at most one.
    return logs[0] ? { hash: logs[0].transactionHash!, block: Number(logs[0].blockNumber), ok: true } : null
  }

  // ---- engine side ---------------------------------------------------------

  private manageSession(acc: AccountState, tokenId: bigint, pool?: string): EngineSession {
    const policy = this.policyOf(acc)
    const key = pool && policy.session.grants.some((g) => g.name === 'manage' && g.pool === pool) ? `manage:${pool}` : 'manage'
    const grant = instantiateGrant(policy, key, {
      account: acc.ctx.address as Address,
      sessionKey: privateKeyToAccount(acc.sessionKey!).address,
      chainId: this.cfg.chainId,
      salt: toHex(randomBytes(32)),
      validAfter: 0,
      validUntil: 0,
      caps: Object.fromEntries(policy.session.caps.map((c) => [c.name, 0n])),
      tokenId,
      admittedTokenIds: [tokenId],
    })
    return { name: `manage:${tokenId}`, grant, permissionId: permissionIdOf(toSmartSession(grant, undefined, this.cfg.registry)) }
  }

  /** The live demo does not enable manage grants: every manage session is known to the engine but revoked, so decide never harvests. */
  private revokeManage(engine: Engine): void {
    for (const s of engine.sessions) if (s.grant.name === 'manage') engine.ledger.revoke(s.permissionId)
  }

  private startLoop(acc: AccountState): void {
    const refusal = this.writeRefusal()
    if (refusal) throw new ReasonError('CHAIN_UNSUPPORTED', `${acc.accountKey} engine not started: ${refusal}`)
    this.stopLoop(acc.accountKey)
    if (!acc.sessionKey) throw new Error(`${acc.accountKey} has no session key`)
    acc.runs = (acc.runs ?? 0) + 1
    this.store.save()
    const sessions: EngineSession[] = [...acc.grants.map((g) => ({ name: g.name, grant: g.grant, permissionId: g.permissionId, ...(g.admit?.length ? { admit: g.admit.map(BigInt) } : {}) })), ...(isV4(this.policyOf(acc)) ? [] : acc.managedTokenIds.map((id) => this.manageSession(acc, BigInt(id))))]
    const priorIncluded = priorIncludedOf(acc.ops, sessions)
    const engine = new Engine(
      {
        mode: 'live',
        chainId: this.cfg.chainId,
        signingChainIds: [this.cfg.chainId],
        rpcUrl: this.cfg.rpcUrl,
        bundlerUrl: this.cfg.bundlerUrl,
        policy: this.enginePolicyOf(acc),
        guardHistory: this.guardHistoryOf(this.enginePolicyOf(acc)),
        account: acc.ctx.address as Address,
        sessionKey: privateKeyToAccount(acc.sessionKey),
        nonceLane: 0,
        depositsAfter: BigInt(acc.depositsAfter),
        historyFromBlock: BigInt(acc.historyFromBlock),
        sessions,
        priorIncluded,
        carried: acc.carried ?? [],
        maxWaitBlocks: this.cfg.maxWaitBlocks,
        poolCache: this.poolCache,
        // otto/mamoru#61: off Base the engine reads the chain's registry, prices gas on its native pool and, where the
        // chain charges the gas limit, sizes each userOp from its simulation. On Base none of these is set (as before).
        ...(this.offBase() ? { registry: this.cfg.registry, nativePricePool: nativePricePool(this.cfg.registry), gasModel: chainOf(this.cfg.registry.chainId).gasModel } : {}),
        // The only owner intent the operator has today: a stop on its way pauses the engine (US6).
        intents: () => ({ paused: this.stopInFlight(acc), exitRequested: false }),
        peerPositions: () => this.peerPositionsOf(acc.accountKey),
        onEntering: (pool) => this.markEntering(acc, pool),
        // otto/mamoru#212: new money is placed only within the cap, counted across chains.
        cap: () => this.engineCap(acc),
      },
      {
        waitBlock: () => Bun.sleep(this.cfg.waitBlockMs),
        requestManageGrant: async (tokenId, pool) => {
          // A retried landing asks again: the id is kept once.
          if (!acc.managedTokenIds.includes(tokenId.toString())) acc.managedTokenIds.push(tokenId.toString())
          this.store.save()
          return this.manageSession(acc, tokenId, pool)
        },
        onMinted: (tokenId, block) => {
          const id = tokenId.toString()
          // An account from before the record counts every position until seedAdmitted has read them.
          if (!acc.admittedTokenIds || acc.admittedTokenIds.includes(id)) return
          acc.admittedTokenIds = [...acc.admittedTokenIds, id]
          if (block !== undefined) acc.admittedAt = { ...acc.admittedAt, [id]: block.toString() }
          this.store.save()
        },
        // Sol review round 2 #4: never more admitted positions than one bounded read sees (chain.ts MAX_INVENTORY).
        mintAllowed: () => mintAllowed(acc.admittedTokenIds),
      },
    )
    // The journal of a restarted engine is empty: the block of the last operation stored for the account stands in
    // for it, so the first review does not decide on a view from before that operation.
    engine.minObservationBlock = lastEngineBlock(acc.ops)
    // A renewal enabled the grants this engine starts on: a view from before it would show them as not enabled.
    if (acc.grantsFromBlock && BigInt(acc.grantsFromBlock) > engine.minObservationBlock) engine.minObservationBlock = BigInt(acc.grantsFromBlock)
    // An engine operation that was out when the process stopped has no block stored: it may have landed since. The
    // first tick then puts the floor a margin past the head it reads, so a provider still before it is not believed.
    const unsettled = acc.ops.some((o) => o.opId.startsWith('eng-') && o.state === 'submitted' && o.block === undefined)
    this.revokeManage(engine)
    const runner: Runner = { engine, timer: null, stopped: false, epoch: acc.epoch, run: acc.runs, seen: new Map(), alias: new Map() }
    this.runners.set(acc.accountKey, runner)
    runner.floorPending = unsettled
    // Every move of an engine operation is stored as it happens: a restart in the middle of a review still knows
    // which block the operation landed in.
    this.watchJournal(acc, runner)
    const tick = async () => {
      if (runner.stopped) return
      // Whether this review leaves the next one something to do at once.
      let more = false
      try {
      await this.lock(acc.accountKey).run(async () => {
        if (runner.stopped || this.reviewBraked(runner)) return
        try {
          if (runner.floorPending) {
            const head = await this.client.getBlockNumber()
            const floor = head + RESTART_FLOOR_MARGIN
            if (floor > engine.minObservationBlock) engine.minObservationBlock = floor
            runner.floorPending = false
            console.log(`[engine ${acc.accountKey}] an operation was out at the last stop: no review before block ${floor}`)
          }
          // The provider may still serve a block before the activation that enabled the grants: wait for it.
          if (!runner.pastActivation) {
            const head = await this.client.getBlockNumber()
            if (head <= BigInt(acc.historyFromBlock)) {
              console.log(`[engine ${acc.accountKey}] rpc head ${head} not past activation block ${acc.historyFromBlock}, waiting`)
              more = true
              return
            }
            // The head only moves forward past it: not asked again in this run.
            runner.pastActivation = true
          }
          // An owner tx prepared on the current positions is waiting for its passkey: an engine reduce or
          // re-range now would change the liquidity it withdraws (GS013). Hold until it runs or expires — but
          // only up to REVIEW_HOLD_MAX_MS: an unsigned prepare needs no passkey, so otherwise a compromised app
          // Worker (or a retry loop) could keep one outstanding forever and starve this account's engine.
          const now = Date.now()
          const pendingOwnerTx = [...this.prepared.values()].some((p) => p.accountKey === acc.accountKey && p.kind !== 'activate' && p.expires > now)
          const held = reviewHold(pendingOwnerTx, this.reviewHeldSince.get(acc.accountKey), now)
          if (held.since !== undefined) this.reviewHeldSince.set(acc.accountKey, held.since)
          else this.reviewHeldSince.delete(acc.accountKey)
          if (held.hold) {
            console.log(`[engine ${acc.accountKey}] owner tx pending, review held`)
            return
          }
          // I1 (otto/mamoru#140): every grant the engine uses must read enabled, checked at least every
          // GRANTS_CHECK_MS: one revoked elsewhere stops the loop here, before the engine acts on it.
          if (!(await this.grantGate(acc, now))) {
            // Never acts on a grant set it could not verify: no review this tick, the check is tried again at the next.
            console.log(`[engine ${acc.accountKey}] grant check unavailable, review held (GRANT_CHECK_UNAVAILABLE)`)
            safeMetrics(() => this.engineHealth.record(acc.accountKey, false, 'GRANT_CHECK_UNAVAILABLE', classifyEngineError('GRANT_CHECK_UNAVAILABLE')))
            more = true
            return
          }
          if (runner.stopped || !acc.active) return
          // otto/mamoru#212: the other chains as this review counts them (a failed read: nothing new is placed).
          if (this.readsElsewhere(acc)) this.enginePeers.set(acc.accountKey, await this.peerRead(acc, PEER_ENGINE_MAX_AGE_MS))
          if (runner.stopped || !acc.active) return
          const startedAt = Date.now()
          const r = await engine.review()
          this.revokeManage(engine)
          if (r.kind === 'observation-failed') {
            logErr(`[engine ${acc.accountKey}] observation failed ${r.code}:`, r.detail)
            // The provider is behind the engine's last operation: asked again in seconds, not a whole period later.
            if (r.code === 'EHG_OBSERVATION_STALE') more = true
            safeMetrics(() => this.engineHealth.record(acc.accountKey, false, r.code, classifyEngineError(r.code, r.detail)))
          } else {
            this.recordPeerView(acc, r.observation, r.op)
            const d = r.record.decision
            const pools = new Map<string, string | null>(this.enginePolicyOf(acc).buckets.map((b) => [b.id, b.pools[0] ?? null]))
            const waiting = (d.waiting ?? []).map((w) => ({ bucket: w.bucket, pool: pools.get(w.bucket) ?? null, code: w.code, amountUsdc: w.amount.toString() }))
            // otto/mamoru#135 follow-up: a new (or cleared) waiting reason is itself something /funding reports
            // (engineView), decided off this review's own observation of the chain (a deposit, a position). Without
            // this, that fresh decision could be paired with a balance /funding still answers from before it.
            if (!sameWaiting(runner.waiting, waiting)) this.fundingMoved(acc)
            runner.waiting = waiting
            const o = r.op ? engine.journal.op(r.op.opId) : null
            const last = o ? engine.journal.transitions.filter((t) => t.opId === o.opId).at(-1) : null
            // `last.detail` is free text (unlike d.reason/o.state/o.stateCode, all closed enums): redact it.
            const prefix = `[engine ${acc.accountKey}] block ${d.observationRef.block} ${d.kind} ${d.reason}${o ? ` -> ${o.opId} ${o.state} ${o.stateCode}` : ''}`
            if (last?.detail) logErr(prefix, last.detail)
            else console.log(prefix)
            safeMetrics(() => this.engineHealth.record(acc.accountKey, true, d.code, undefined))
            // otto/mamoru#8: this review's own balance read (no extra RPC call), against the account's alert threshold.
            safeMetrics(() => this.recordGasReserve(acc, r.observation.native, r.observation.gas))
            // Only a review that reached a decision counts, from when it started (it may then wait minutes on its
            // operation): one that was held, failed to observe or threw is tried again on the next tick.
            runner.reviewedAt = startedAt
            // Its operation landed: the next step of the entry (the mint after the swap, the next pool) is decided now.
            if (o?.state === 'confirmed') more = true
          }
        } catch (e) {
          // `e` goes to the classifier as it is: reading or coercing an odd thrown value here could itself throw.
          logErr(`[engine ${acc.accountKey}] review error:`, e)
          safeMetrics(() => this.engineHealth.record(acc.accountKey, false, 'REVIEW_ERROR', classifyEngineError('REVIEW_ERROR', e)))
        }
        // Persist how far deposits were read, so a restart or a failed review does not rescan from activation.
        if (runner.engine.depositsAfter - BigInt(acc.depositsAfter) >= DEPOSITS_SAVE_BLOCKS) {
          acc.depositsAfter = runner.engine.depositsAfter.toString()
          this.store.save()
        }
        this.syncEngineOps(acc, runner)
      })
      } catch (e) {
        // Nothing thrown by a tick may end the loop: the account would silently stop being reviewed.
        logErr(`[engine ${acc.accountKey}] tick error:`, e)
      } finally {
        if (!runner.stopped) {
          const g = graceLeft(more, runner.followUps ?? 0, runner.grace ?? 0)
          runner.grace = g.grace
          const next = nextReview(g.more, runner.followUps ?? 0, this.rpcOverBudget(Date.now()), this.cfg.reviewMs)
          this.setFollowUps(acc, runner, next.followUps)
          runner.nextAt = Date.now() + next.ms
          runner.timer = setTimeout(tick, next.ms)
        }
      }
    }
    runner.timer = setTimeout(tick, 0)
    console.log(`[engine ${acc.accountKey}] loop started for ${acc.ctx.address} every ${this.cfg.reviewMs}ms`)
  }

  /**
   * Over the hourly RPC budget, a review that can wait is skipped: its last review that reached a decision
   * started less than BUDGET_REVIEW_MS ago and the next review has nothing to finish. The only operation a
   * review picks up again is one left `included` (Engine.resumeIncluded, until `safe` reaches its block); every
   * other state is driven to its end inside the review that started it, or by the reconcile path, which the
   * budget does not touch. An operation can stay `included` without end (a `safe` head that does not move, an
   * event that cannot be read again), so it holds the brake off for BUDGET_RESUME_MS and no longer: after
   * that it is picked up at the braked pace. Reads are never moved to another provider; the operator does less.
   */
  private reviewBraked(runner: Pick<Runner, 'engine' | 'reviewedAt' | 'includedAt'>, now: number = Date.now()): boolean {
    // Kept whatever the budget says: how long the journal has had an operation left `included`.
    if (!runner.engine.journal.ops.some((o) => o.state === 'included')) runner.includedAt = undefined
    else if (runner.includedAt === undefined || now < runner.includedAt) runner.includedAt = now
    if (!this.rpcOverBudget(now)) return false
    if (runner.includedAt !== undefined && now - runner.includedAt < BUDGET_RESUME_MS) return false
    return runner.reviewedAt !== undefined && now >= runner.reviewedAt && now - runner.reviewedAt < BUDGET_REVIEW_MS
  }

  private budgetLoggedHour = -1
  /** Whether the keyed provider spent its hour; says so once per hour. */
  private rpcOverBudget(now: number): boolean {
    const budget = this.cfg.rpcBudget
    if (!budget?.over(now)) return false
    const hour = Math.floor(now / 3_600_000)
    if (hour !== this.budgetLoggedHour) {
      this.budgetLoggedHour = hour
      console.log(`[budget] keyed RPC provider over ${budget.cuPerHour} CU this hour: reviews at most every ${BUDGET_REVIEW_MS / 60_000} min and armed Safes read at most once a minute until the hour ends; owner operations are not affected`)
    }
    return true
  }

  /** Every move of an engine operation is stored as it happens, and the next funding read goes to the chain. */
  private watchJournal(acc: AccountState, runner: Runner): void {
    runner.engine.journal.onMove = (op) => {
      this.fundingMoved(acc)
      this.syncEngineOps(acc, runner, op)
    }
  }

  /** funding reports `engine.placing` as followUps > 0: when that flips, an entry started or ended. */
  private setFollowUps(acc: AccountState, runner: Runner, followUps: number): void {
    if ((runner.followUps ?? 0) > 0 !== followUps > 0) this.fundingMoved(acc)
    runner.followUps = followUps
  }

  /**
   * otto/mamoru#184: every other account's positions, as its last decided review saw them, so depth sizing holds
   * Mamoru as a whole under the share limit of a pool, from `peerView`, which every account keeps across stops and
   * restarts (a lapsed session leaves its positions in the pool; a stop that withdrew them overcounts until the account
   * runs again, never undercounts). Null while an account that may hold positions (activated, with any admitted or
   * managed id or none recorded yet) has no view: the pool-wide share is unknown and no account gets share room until it is seen. That
   * fails closed for entries only, and is logged with the account that holds it up.
   */
  private peerPositionsOf(key: string): Pick<Observation, 'peerPositions' | 'peerEntering'> {
    const now = Date.now()
    const positions: PeerPositionObs[] = []
    const entering = new Set<RegistryName>()
    for (const acc of Object.values(this.store.state.accounts)) {
      if (acc.accountKey === key) continue
      const v = acc.peerView
      if (v?.entering) entering.add(v.entering as RegistryName)
      if (!v?.positions) {
        // Holds no Mamoru position: none admitted or managed, or never activated (the engine mints only after that).
        if (acc.admittedTokenIds && acc.admittedTokenIds.length === 0 && acc.managedTokenIds.length === 0) continue
        if (!acc.runs && !acc.ops.some((o) => o.kind === 'activate' && o.state === 'confirmed')) continue
        if (now - this.peerUnknownLoggedAt > 60_000) {
          this.peerUnknownLoggedAt = now
          console.log(`[depth] no share room for new entries: ${acc.accountKey} may hold positions and has not been observed yet (otto/mamoru#184)`)
        }
        return { peerPositions: null }
      }
      for (const p of v.positions) positions.push({ ...p, pool: p.pool as RegistryName | null, liquidity: BigInt(p.liquidity) })
    }
    return { peerPositions: positions, ...(entering.size ? { peerEntering: [...entering] } : {}) }
  }

  private peerUnknownLoggedAt = 0

  /** otto/mamoru#184: an entry into `pool` was just proposed; the others see the pool as taken from this same step on. */
  private markEntering(acc: AccountState, pool: RegistryName): void {
    acc.peerView = { positions: acc.peerView?.positions ?? null, entering: pool }
    this.store.save()
  }

  /**
   * otto/mamoru#184: what the other accounts' depth sizing counts of this one, from a decided review. Only positions
   * Mamoru opened or was handed to manage: an NFT anyone transfers into a Safe must not take share room from the other
   * accounts (an account from before the admitted record counts all of its own). An entry decided now is not in this
   * observation: its pool stays marked until a review sees it, i.e. one with no operation of the account still out.
   */
  private recordPeerView(acc: AccountState, obs: Observation, op: OpRecord | null): void {
    const ours = acc.admittedTokenIds ? new Set([...acc.admittedTokenIds, ...acc.managedTokenIds]) : null
    const positions = obs.positions.filter((p) => !ours || ours.has(p.tokenId.toString())).map((p) => ({ pool: p.pool, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity.toString() }))
    const i = op?.intent
    const entering = i && (i.kind === 'enter_mint' || i.kind === 'increase_liquidity' || i.kind === 'rerange') ? i.pool : obs.slot ? (acc.peerView?.entering ?? null) : null
    const view = { positions, entering }
    if (JSON.stringify(view) === JSON.stringify(acc.peerView)) return
    acc.peerView = view
    this.store.save()
  }

  private stopLoop(key: string): void {
    const r = this.runners.get(key)
    if (!r) return
    r.stopped = true
    if (r.timer) clearTimeout(r.timer)
    this.runners.delete(key)
    this.reviewHeldSince.delete(key)
    this.enginePeers.delete(key)
    // otto/mamoru#8: a stopped (or about-to-restart, startLoop calls this first) account must not keep counting
    // towards gasReserveLowCount, nor hand its stale pre-stop balance to a restarted loop's first /metrics read.
    this.gasReserve.evict(key)
    console.log(`[engine ${key}] loop stopped`)
  }

  /** Journal ops that reached the chain path, as OpViews (discarded ones stay in the engine log only). */
  private syncEngineOps(acc: AccountState, runner: Runner, moved?: OpRecord): void {
    let changed = false
    // An op carried from an earlier engine that landed late: its stored row says so, with what it used (replayed).
    if (moved?.storedId && moved.lateIncluded && moved.included && !runner.engine.journal.ops.includes(moved)) {
      const row = acc.ops.find((x) => x.opId === moved.storedId)
      if (row && !row.lateIncluded) {
        // An op carried while still in flight (not settled failed first) is simply settled: confirmed or reverted.
        const inFlight = row.state === 'submitted'
        Object.assign(row, { lateIncluded: true, txHash: moved.included.txHash, block: Number(moved.included.blockNumber), ...(moved.userOpHash ? { userOpHash: moved.userOpHash } : {}), updatedAt: now(), ...(inFlight ? { state: moved.included.success ? 'confirmed' : 'failed', code: moved.included.success ? 'EXEC_OK' : 'EXEC_INNER_REVERT' } : {}), ...(moved.permissionId && moved.calls ? { permissionId: moved.permissionId, calls: moved.calls } : {}) })
        changed = true
      }
    }
    for (const o of runner.engine.journal.ops) {
      const state = ENGINE_STATE[o.state]
      if (!state) continue
      const own = `eng-${runner.epoch}-${runner.run}-${o.opId}-${o.kind}`
      const opId = runner.alias.get(own) ?? own
      const view: StoredOp = {
        opId,
        kind: engineKind(o.kind),
        state,
        code: o.stateCode,
        txHash: o.included?.txHash,
        block: o.included ? Number(o.included.blockNumber) : undefined,
        ...(o.userOpHash ? { userOpHash: o.userOpHash } : {}),
        updatedAt: now(),
        ...opIntentView(o.intent),
        ...((o.state === 'confirmed' || o.lateIncluded) && o.permissionId && o.calls ? { permissionId: o.permissionId, calls: o.calls } : {}),
        ...(o.lateIncluded ? { lateIncluded: true } : {}),
      }
      const sig = `${view.state}|${view.code}|${view.txHash ?? ''}`
      if (runner.seen.get(own) === sig) continue
      runner.seen.set(own, sig)
      const existing = acc.ops.find((x) => x.opId === opId)
      if (existing) {
        Object.assign(existing, view)
      } else {
        // An identical failure right after the last one (same kind and code, nothing in between) bumps its count instead of a new row.
        const last = acc.ops.at(-1)
        if (view.state === 'failed' && last && last.opId.startsWith('eng-') && last.state === 'failed' && last.kind === view.kind && last.code === view.code) {
          runner.alias.set(own, last.opId)
          Object.assign(last, { updatedAt: view.updatedAt, count: (last.count ?? 1) + 1 })
        } else acc.ops.push(view)
      }
      changed = true
    }
    // What a later engine must keep watching, each op named by its stored row.
    const carried = runner.engine.carried().map((o) => {
      if (!o.storedId) {
        const own = `eng-${runner.epoch}-${runner.run}-${o.opId}-${o.kind}`
        o.storedId = runner.alias.get(own) ?? own
      }
      return o
    })
    const key = (ops: readonly OpRecord[] | undefined) => (ops ?? []).map((o) => `${o.storedId}|${o.state}|${o.nonce}`).join(',')
    if (key(carried) !== key(acc.carried)) {
      acc.carried = carried.length ? carried.map((o) => ({ ...o })) : undefined
      changed = true
    }
    if (changed) this.store.save()
  }
}

/** GET /ops: failed engine ops with the same kind and code collapse into the newest one, with the summed count. */
export function collapseFailed(ops: StoredOp[]): OpView[] {
  const newest = new Map<string, number>()
  const counts = new Map<string, number>()
  const keyOf = (o: StoredOp) => (o.opId.startsWith('eng-') && o.state === 'failed' ? `${o.kind}|${o.code ?? ''}` : null)
  ops.forEach((o, i) => {
    const k = keyOf(o)
    if (!k) return
    newest.set(k, i)
    counts.set(k, (counts.get(k) ?? 0) + (o.count ?? 1))
  })
  const out: OpView[] = []
  ops.forEach((o, i) => {
    const k = keyOf(o)
    const { permissionId: _p, calls: _c, ownerGrants: _g, revokes: _r, safeTxHash: _h, safeNonce: _n, sentAt: _s, broadcastAt: _b, lastBroadcastAt: _lb, ...view } = o
    if (!k) return void out.push(view)
    if (newest.get(k) !== i) return
    const n = counts.get(k)!
    out.push(n > 1 ? { ...view, count: n } as OpView : view)
  })
  return out
}

/** Start refused: the Safe holds more USDC than the per-account cap. The message carries the amounts for the SPA. */
function depositOverCap(usdc: bigint, cap: bigint, across = false): HttpError {
  return new HttpError(409, 'DEPOSIT_OVER_CAP', `this account holds ${fmtUsdc(usdc)} USDC${across ? ' across its networks' : ''}, over the ${fmtUsdc(cap)} USDC cap; withdraw at least ${fmtUsdcUp(usdc - cap)} USDC to start`)
}

/** otto/mamoru#212: the renewal line that names a cap change, or nothing when the cap is the one signed before. */
function capChange(signed: bigint, cap: bigint): string[] {
  return signed === cap ? [] : [`Your cap changes from ${fmtUsdc(signed)} to ${fmtUsdc(cap)} USDC: the limits above are sized for the new one`]
}

/** otto/mamoru#212: Start refused because the account's other chains could not be read (fail closed). */
function capCheckUnavailable(): HttpError {
  return new HttpError(503, 'CAP_CHECK_UNAVAILABLE', 'your balance on the other networks could not be read just now: nothing was changed, try again in a minute')
}

function belowDeployMinimum(usdc: bigint, chain = 'Base'): HttpError {
  return new HttpError(409, 'BELOW_DEPLOY_MINIMUM', `this account holds ${fmtUsdc(usdc)} USDC; Mamoru creates the account on ${chain} from ${fmtUsdc(MIN_DEPLOY_USDC)} USDC`)
}

const COLLECT_SELECTOR = toFunctionSelector('collect((uint256,address,uint128,uint128))')

function revertReason(e: unknown): string {
  const data = revertData(e)
  if (data && data.startsWith('0x08c379a0')) {
    try {
      return String(decodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }], data }).args[0])
    } catch {}
  }
  return data ?? (e as Error).message.split('\n')[0] ?? 'reverted'
}

/** The non-secret shape of a submitted assertion, for the log. Fields that do not decode count as empty. */
function bodyShape(body: OwnerSignature): unknown {
  const bytes = (v: unknown) => {
    try {
      return typeof v === 'string' ? fromB64url(v) : new Uint8Array()
    } catch {
      return new Uint8Array()
    }
  }
  return assertionShape({ authenticatorData: bytes(body?.authenticatorData), clientDataJSON: bytes(body?.clientDataJSON), signature: bytes(body?.signature) })
}

type Outcome = { outcome: 'ok' } | { outcome: 'revert' | 'unavailable'; why: string }
/** `unproven`: one provider says the chain would accept it, which is not proof (otto/mamoru#140 part2 #5). */
type Proof = Outcome | { outcome: 'unproven'; why: string }

/** Whether execTransaction's return data is ABI `true`. */
function execReturnsTrue(data: Hex | undefined): boolean {
  try {
    return !!data && decodeFunctionResult({ abi: safeAbi, functionName: 'execTransaction', data }) === true
  } catch {
    return false
  }
}

/** True when the node executed the call and it reverted; false for transport, rate-limit and unsupported-method errors. */
function isRevert(e: unknown): boolean {
  if (revertData(e) !== undefined) return true
  let cur = e as { message?: string; details?: string; code?: number; cause?: unknown } | undefined
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.code === 3 || /execution reverted|\bGS\d{3}\b/i.test(`${cur.message ?? ''} ${cur.details ?? ''}`)) return true
    cur = cur.cause as typeof cur
  }
  return false
}

/**
 * Every token of the USDC pools the Safe holds outside a position, with its value in USDC at the pool's price. A
 * swap leaves its output there until the mint that follows; leaving it out would show the account short of it.
 */
export function idleTokens(r: Awaited<ReturnType<typeof readSafe>>, registry: Registry): NonNullable<FundingView['idle']> {
  const out: NonNullable<FundingView['idle']> = []
  for (const [token, amount] of Object.entries(r.tokens)) {
    if (amount === 0n) continue
    const pool = token === 'USDC' ? undefined : usdcPools(registry).find((p) => r.prices[p] && (entry(p, registry).token0 === token || entry(p, registry).token1 === token))
    if (token !== 'USDC' && !pool) continue
    const valueUsdc = pool ? inUsdc(pool, token, amount, r.prices[pool]!.sqrtPriceX96, registry) : amount
    out.push({ token, amount: amount.toString(), decimals: entry(token, registry).decimals ?? 18, valueUsdc: valueUsdc.toString() })
  }
  // USDC first, then by value.
  return out.sort((a, b) => (a.token === 'USDC' ? -1 : b.token === 'USDC' ? 1 : Number(BigInt(b.valueUsdc) - BigInt(a.valueUsdc))))
}

/** True when the node refused a relayer transaction for lack of ETH (geth: `insufficient funds for gas * price + value`). */
function relayerShort(e: unknown): boolean {
  let cur = e as { message?: string; details?: string; cause?: unknown } | undefined
  for (let i = 0; i < 8 && cur; i++) {
    if (/insufficient funds for gas/i.test(`${cur.message ?? ''} ${cur.details ?? ''}`)) return true
    cur = cur.cause as typeof cur
  }
  return false
}

/** Op ids restart at own-1 in every account: what is remembered about an op in memory is keyed by both. */
function opKey(acc: AccountState, op: { opId: string }): string {
  return `${acc.accountKey}:${op.opId}`
}

/** When an armed activation that failed `tries` times may be tried again. */
function retryAt(tries: number, execSent = false): number {
  if (tries >= ARM_MAX_TRIES) return Date.now() + ARM_PARKED_MS
  // A copy handed to a provider may be pending whatever the answer was: it gets the full wait to land before another
  // is sent (90 Base blocks). Left over: a copy pending longer than that which no node reports; the second then
  // fails at the Safe for its gas, and settleRetried still records the account from the first.
  if (execSent) return Date.now() + ARM_RETRY_MAX_MS
  return Date.now() + Math.min(ARM_RETRY_MAX_MS, ARM_RETRY_MS * 2 ** Math.max(0, tries - 1))
}

/**
 * True when a refusal may be about a copy of the transaction a node already holds or mined: the transport retries a
 * send whose reply was lost, and the second answer is then "already known" or a nonce error. Such an op is not sent
 * again; it fails as an unknown receipt and reconcileOwner settles it from the chain.
 */
function maybeBroadcast(e: unknown): boolean {
  let cur = e as { message?: string; details?: string; cause?: unknown } | undefined
  for (let i = 0; i < 8 && cur; i++) {
    if (/already known|known transaction|already imported|nonce too low|nonce provided|replacement transaction|already exists/i.test(`${cur.message ?? ''} ${cur.details ?? ''}`)) return true
    cur = cur.cause as typeof cur
  }
  return false
}

/**
 * True when a provider answered a send with a JSON-RPC error: the node looked at the transaction and did not take it,
 * so nothing was broadcast. A timeout or a transport failure carries no such code and says nothing either way, and
 * neither does -32603 (internal error): the operator's own proxy answers it when a provider took a request and the
 * reply was lost.
 */
function providerRefused(e: unknown): boolean {
  let cur = e as { code?: unknown; name?: string; cause?: unknown } | undefined
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.code === -32603) return false
    if (typeof cur.code === 'number' && cur.code < 0 && cur.name !== 'TimeoutError' && cur.name !== 'HttpRequestError') return true
    cur = cur.cause as typeof cur
  }
  return false
}

type Probe = { to: Address; data: Hex; decode: (ret: Hex) => bigint }

/** otto/mamoru#155: the owner's accepted quote is no longer on file or the price moved past it; nothing was sent. */
function divergenceStale(): HttpError {
  return new HttpError(409, 'PRICE_DIVERGENCE_STALE', 'the price moved since you accepted it: nothing was sent, review the new numbers')
}

/** A swap back to USDC with the quote its minimum was taken from (otto/mamoru#155). */
type QuotedSwap = SwapBack & { quoted: bigint }

const multicall3Abi = parseAbi(['function getEthBalance(address addr) view returns (uint256 balance)'])

/** A read of the recipient's balance of `asset`, run before and after the batch in the same simulation. */
function balanceProbe(asset: WithdrawAsset, holder: Address, registry: Registry): Probe {
  if (asset === 'ETH') {
    return { to: address('Multicall3', registry), data: encodeFunctionData({ abi: multicall3Abi, functionName: 'getEthBalance', args: [holder] }), decode: (d) => decodeFunctionResult({ abi: multicall3Abi, functionName: 'getEthBalance', data: d }) }
  }
  return { to: address(RECEIVE_ROUTES[asset as ReceiveAsset]?.tokenOut ?? asset, registry), data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [holder] }), decode: (d) => decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: d }) }
}

/** Registered pools a withdraw may route through, best quote wins. */
type ReceiveAsset = Exclude<WithdrawAsset, 'USDC'>
/**
 * Registered pools a withdraw may route through, best quote wins. `tokenOut` is the registry token read for
 * decimals and the recipient balance probe, `receive` the swap output handed to the batch (ETH unwraps WETH).
 * JPYC slot: official JPYC is not on Base (the "JPYC" at 0xaf94…2fb3 on Base is unofficial and never used),
 * so the yen payout is Dephaser JPYT, USDC-collateralized at an oracle USD/JPY rate.
 */
const RECEIVE_ROUTES: Record<ReceiveAsset, { tokenOut: string; receive: LiveReceive['asset']; pools: string[] }> = {
  EURC: { tokenOut: 'EURC', receive: 'EURC', pools: ['pool:EURC/USDC/500'] },
  ETH: { tokenOut: 'WETH', receive: 'ETH', pools: ['pool:WETH/USDC/500', 'pool:WETH/USDC/3000'] },
  JPYC: { tokenOut: 'JPYT', receive: 'JPYT', pools: ['pool:USDC/JPYT/3000'] },
}

/** Display label where it differs from the enum value. */
const ASSET_LABEL: Partial<Record<WithdrawAsset, string>> = { JPYC: 'JPY (JPYT)' }

/** Hard per-payout ceiling in USDC base units: JPYT is unregulated and its pool is thin (~$6.5k). */
export const PAYOUT_CAP_USDC: Partial<Record<WithdrawAsset, bigint>> = { JPYC: 25_000_000n }

/** `reason` on an available asset is a caption the app shows under it. */
export const WITHDRAW_ASSETS: { asset: WithdrawAsset; available: boolean; reason?: string }[] = [
  { asset: 'USDC', available: true },
  { asset: 'EURC', available: true },
  { asset: 'ETH', available: true },
  { asset: 'JPYC', available: true, reason: 'Dephaser JPYT, backed by USDC. Not a regulated issuer.' },
]

/** Raw units rounded down for a minimum: 2 decimals for 6-decimal stablecoins, 6 for ETH. */
function fmtUnits(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, '0')
  const frac = s.slice(-decimals).slice(0, decimals > 6 ? 6 : 2).replace(/0+$/, '')
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals)
}

function fmtUsdc(v: bigint): string {
  const s = v.toString().padStart(7, '0')
  return `${s.slice(0, -6)}.${s.slice(-6, -4)}`
}

/** Every decimal that is there, none that is not: an amount the owner signs to spend, shown exactly. */
function fmtUnitsExact(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, '0')
  const frac = s.slice(-decimals).replace(/0+$/, '')
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals)
}

/** Cents rounded up: an amount the owner must reach is never understated. */
function fmtUsdcUp(v: bigint): string {
  return fmtUsdc(((v + 9_999n) / 10_000n) * 10_000n)
}
