import { randomBytes } from 'node:crypto'
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, parseAbi, getAddress, isAddress, keccak256, stringToHex, toFunctionSelector, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { overCap, type AccountContext, type Address, type FundingView, type OpView, type OwnerSignature, type OwnerTxToSign, type TransferPlan, type TransferRequest, type WithdrawAsset } from '@mamoru/domain'
import { address, entry, erc20Abi, nonfungiblePositionManagerAbi, safeAbi } from '@mamoru/registry'
import { collect, decreaseLiquidity } from '@mamoru/uniswap-v3'
import { simulateCalls, type SimCallResult } from '@mamoru/rpc'
import { POLICIES, computeCaps, grantKey, hasManageAny, instantiateGrant, type PolicyVersion } from '@mamoru/policy'
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
  type LivePosition,
  type LiveReceive,
  type LiveSwap,
  type SafeTx,
} from '@mamoru/account/live'
import { permissionIdOf, toSmartSession } from '@mamoru/account/sessions'
import { minOut, quoteExactInputSingle } from '@mamoru/uniswap-v3/quote'
import { Engine, type EngineSession } from '@mamoru/scenarios/driver/engine.ts'
import type { OpRecord } from '@mamoru/scenarios/driver/journal.ts'
import { isTerminal } from '@mamoru/journal'
import { USDC_POOLS, amountsForLiquidity, positionUsdc, priceOf, readSafe, type PoolPosition, type SafeRead } from './chain.ts'
import { closeCalls, planReduce, routeOf, swapBackCalls, type SwapBack } from './unwind.ts'
import { Lock } from './lock.ts'
import { classifyEngineError, EngineHealthTracker, logErr, safeMetrics, type EngineHealthSnapshot } from './metrics.ts'
import type { Relayer } from './relayer.ts'
import { revertData } from './bundler.ts'
import type { AccountState, ArmedActivation, StateStore, StoredGrant, StoredOp } from './state.ts'

/** Known/active/armed account counts plus the operator's engine health for GET /metrics. */
export type AccountsSummary = { known: number; active: number; armed: number }
const RELAYER_BALANCE_CACHE_MS = 60_000

const EXECUTION_SUCCESS = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'))
/** An owner op whose receipt poll failed after the tx was sent: the tx may still have landed. */
const RECEIPT_UNKNOWN = 'OWNER_TX_ERROR'
/** Armed activations retry this many times across watcher passes before failing visibly. */
const ARM_MAX_TRIES = 20
/** Minimum gap between two receipt reconciliation passes of one account. */
const RECONCILE_EVERY_MS = 20_000
/** Base produces a block every 2 s; used to place a failure time on the chain when no tx hash was kept. */
const BLOCK_SECONDS = 2n
const PREPARE_TTL_MS = 5 * 60_000
/** On top of the policy reserve: the first userOp prefund leaves the Safe's balance into its EntryPoint deposit. */
const TOP_UP_MARGIN_WEI = 200_000_000_000_000n
/** Blocks of deposit progress (~10 min on Base) before it is written to the state file. */
const DEPOSITS_SAVE_BLOCKS = 300n
/** How long a POST waits for the owner transaction before answering with the op as it stands; the SPA polls /ops. */
const POST_WAIT_MS = 15_000
/** How often the armed-activation watcher reads the USDC balance of each armed Safe. */
const ARM_WATCH_MS = 6_000
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
/** How often an unavailable simulation or eth_call is tried again before the fallback. */
const SIM_TRIES = 3

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
  live: boolean
  rpcUrl: string
  bundlerUrl: string
  policy: PolicyVersion
  reviewMs: number
  waitBlockMs: number
  maxWaitBlocks: number
}

type OwnerKind = 'activate' | 'transfer' | 'stop'

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
  /** transfer: what the history line shows. */
  meta?: { amountUsdc: string; asset?: string; to: Hex }
}

type Runner = { engine: Engine; timer: ReturnType<typeof setTimeout> | null; stopped: boolean; epoch: number; run: number; seen: Map<string, string>; alias: Map<string, string> }

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

const now = () => new Date().toISOString()

type Progress = NonNullable<FundingView['progress']>

/** Engine op kind -> the progress line the SPA shows. close_position is the engine closing a position to re-range it. */
const ENGINE_STEP: Record<OpRecord['kind'], Progress['step']> = {
  enter_swap: 'swapping',
  enter_mint: 'opening',
  close_position: 'reranging',
  harvest: 'rebalancing',
  convert: 'rebalancing',
  rerange: 'reranging',
  reduce: 'rebalancing',
}

/** Accounts activated before the operator stored a policy id per account ran this policy. */
const LEGACY_POLICY = 'conservador-live-v1'
const LIVE_POOL_NAME = 'pool:USDC/cbBTC/500'
/** Base's per-tx gas cap is 2^24 (EIP-7825). Budget the activation well under it: the relayer adds a margin on top of its estimate. */
export const BASE_TX_GAS_CAP = 16_777_216n
const ACTIVATION_GAS_BUDGET = 15_000_000n
/** execTransaction, WebAuthn P-256 verify and MultiSend around the calls. */
const ACTIVATION_OVERHEAD_GAS = 600_000n
/** Measured on Base: enableSessions costs 1.4-2.1M gas per session of the live policies; 2.1M is the conservative bound. */
const STATIC_GAS_PER_SESSION = 2_100_000n

/** "USDC/cbBTC 0.05%" for pool:USDC/cbBTC/500. */
function poolLabel(pool: string): string {
  const e = entry(pool)
  return `${e.token0}/${e.token1} ${(e.fee! / 10_000).toFixed(2)}%`
}

export class Operator {
  private readonly prepared = new Map<string, Prepared>()
  private readonly locks = new Map<string, Lock>()
  private readonly runners = new Map<string, Runner>()
  private readonly reconciled = new Map<string, number>()
  private armTimer: ReturnType<typeof setTimeout> | null = null
  private armStopped = false
  /** Owner transactions being executed right now, by accountKey. */
  private readonly busy = new Map<string, Progress>()
  private readonly seenAt = new Map<string, string>()
  /** Pause between retries of a pre-send simulation that reverts (a load-balanced provider can answer from a lagging node). */
  private retryMs = 3_000
  /** Times the off-chain signature check said no and the chain said yes, since this process started. Logged with each one. */
  mirrorMismatches = 0
  private readonly engineHealth = new EngineHealthTracker()
  private relayerBalanceCache: { at: number; value: bigint } | null = null

  constructor(
    readonly cfg: OperatorConfig,
    private readonly client: PublicClient,
    readonly relayer: Relayer,
    private readonly store: StateStore,
  ) {}

  /** GET /metrics: accounts known / active / armed. */
  accountsSummary(): AccountsSummary {
    const all = Object.values(this.store.state.accounts)
    return { known: all.length, active: all.filter((a) => a.active).length, armed: all.filter((a) => !!a.armed).length }
  }

  /** GET /metrics: engine health of every account with a running loop, newest-first. */
  engineHealthSnapshot(): EngineHealthSnapshot[] {
    return [...this.runners.keys()].map((key) => this.engineHealth.snapshot(key))
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

  /** Restarts the engine loop of every account that was active. */
  resume(): void {
    for (const acc of Object.values(this.store.state.accounts)) if (acc.active) this.startLoop(acc)
    for (const acc of Object.values(this.store.state.accounts)) this.reconcileSoon(acc)
    const armed = Object.values(this.store.state.accounts).filter((a) => a.armed).length
    if (armed) console.log(`[armed] ${armed} armed activation(s) reloaded`)
    this.armStopped = false
    this.armTimer = setTimeout(() => this.watchArmed(), 0)
  }

  shutdown(): void {
    this.armStopped = true
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

  /** The stored account for this context; the Safe address is recomputed from the context and must match. */
  account(ctx: AccountContext): { acc: AccountState; live: LiveAccount } {
    if (ctx.chainId !== this.cfg.chainId) throw new HttpError(400, 'CHAIN_MISMATCH', `account is on ${ctx.chainId}, operator on ${this.cfg.chainId}`)
    let live: LiveAccount
    try {
      live = liveAccountFromContext(ctx)
    } catch (e) {
      logErr('[http] account context rejected:', e)
      throw safeHttpError(400, 'ACCOUNT_MISMATCH')
    }
    let acc = this.store.state.accounts[ctx.accountKey]
    if (!acc) {
      acc = { accountKey: ctx.accountKey, ctx, trusted: false, active: false, grants: [], revoked: [], managedTokenIds: [], depositsAfter: '0', historyFromBlock: '0', epoch: 0, ops: [], seq: 0 }
      this.store.state.accounts[ctx.accountKey] = acc
      this.store.save()
    } else if (acc.ctx.address.toLowerCase() !== ctx.address.toLowerCase()) {
      throw new HttpError(409, 'ACCOUNT_MISMATCH', 'accountKey is bound to another Safe')
    }
    return { acc, live }
  }

  /** The policy the account was activated with; accounts activated before policy ids were stored run conservador-live-v1. */
  policyOf(acc: AccountState): PolicyVersion {
    if (!acc.policyId) return acc.active || acc.grants.length ? (POLICIES[LEGACY_POLICY] ?? this.cfg.policy) : this.cfg.policy
    const p = POLICIES[acc.policyId]
    if (!p) throw new Error(`${acc.accountKey}: unknown policy ${acc.policyId}`)
    return p
  }

  private bucketPools(acc: AccountState): string[] {
    return this.policyOf(acc).buckets.flatMap((b) => b.pools)
  }

  async funding(ctx: AccountContext): Promise<FundingView> {
    const { acc, live } = this.account(ctx)
    const r = await readSafe(this.client, live.safe)
    return {
      address: live.safe,
      deployed: r.deployed,
      block: Number(r.block),
      usdc: r.usdc.toString(),
      eth: r.eth.toString(),
      capUsdc: LIVE_CAP_USDC.toString(),
      // Only while the engine is off: that is when the cap refuses Start.
      overCap: acc.active ? null : overCap(r.usdc, LIVE_CAP_USDC),
      deployMinUsdc: MIN_DEPLOY_USDC.toString(),
      cbbtc: r.cbbtc.toString(),
      gasReserveWei: this.policyOf(acc).gasReserveWei.toString(),
      active: acc.active,
      positions: r.positions.map((p) => ({
        tokenId: p.tokenId.toString(),
        pool: p.pool,
        liquidity: p.liquidity.toString(),
        inRange: p.inRange,
        amountUsdc: (p.token0 === 'USDC' ? p.amount0 : p.amount1).toString(),
        amountCbbtc: (p.token0 === 'cbBTC' ? p.amount0 : p.token1 === 'cbBTC' ? p.amount1 : 0n).toString(),
        amounts: [
          { token: p.token0, amount: p.amount0.toString(), decimals: entry(p.token0).decimals ?? 18 },
          { token: p.token1, amount: p.amount1.toString(), decimals: entry(p.token1).decimals ?? 18 },
        ],
        valueUsdc: positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96).toString(),
      })),
      progress: this.progressOf(acc),
    }
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
  }

  /** GET /ops. Failed engine ops are internal attempts: left out unless `all` (debugging). */
  ops(ctx: AccountContext, after: string | null, includeFailedEngine = false): { ops: OpView[] } {
    const { acc } = this.account(ctx)
    this.reconcileSoon(acc)
    const all = collapseFailed(includeFailedEngine ? acc.ops : acc.ops.filter((o) => !(o.opId.startsWith('eng-') && o.state === 'failed')))
    if (!after) return { ops: all }
    const i = all.findIndex((o) => o.opId === after)
    if (i >= 0) return { ops: all.slice(i + 1) }
    const t = Date.parse(after)
    return { ops: Number.isNaN(t) ? all : all.filter((o) => Date.parse(o.updatedAt) > t) }
  }

  // ---- owner side: prepare -------------------------------------------------

  private assertLive(): void {
    if (!this.cfg.live) throw new HttpError(503, 'DRY_RUN_STOP', 'operator is not live (MAMORU_LIVE=1 on chain 8453 required)')
  }

  private async hold(acc: AccountState, live: LiveAccount, kind: OwnerKind, calls: Parameters<typeof ownerSafeTx>[0], summary: string[], extra: Partial<Prepared> = {}): Promise<OwnerTxToSign> {
    const { nonce } = await readSafeNonce(this.client, live.safe)
    const tx = ownerSafeTx(calls, nonce)
    const safeTxHash = safeTxHashOf(live, tx)
    const prepareId = toHex(randomBytes(16)).slice(2)
    const expires = Date.now() + PREPARE_TTL_MS
    for (const [id, p] of this.prepared) if (p.expires < Date.now()) this.prepared.delete(id)
    this.prepared.set(prepareId, { prepareId, accountKey: acc.accountKey, kind, tx, safeTxHash, expires, ...extra })
    return { safe: live.safe, chainId: this.cfg.chainId, safeTxHash, summary, expiresAt: new Date(expires).toISOString(), prepareId }
  }

  /**
   * Base caps a transaction at 2^24 gas (EIP-7825); a fork does not. SmartSession.enableSessions costs ~1-3M gas per
   * session, so the full multi-pool v2 set (12 sessions, ~18.2M) reverts GS013 on real Base. Keep every entry grant
   * and drop the manage-any/convert-any pairs of the lowest-preference buckets until the simulated tx fits. The engine
   * discards a proposal whose session is missing (SESSION_MISSING), so a dropped pair only disables re-range/reduce
   * for that pool.
   */
  private async fitActivation(
    live: LiveAccount,
    policy: PolicyVersion,
    allKeys: string[],
    build: (keys: string[]) => ReturnType<typeof instantiateGrant>[],
    acc: AccountState,
    block: bigint,
  ): Promise<{ keys: string[]; grants: ReturnType<typeof instantiateGrant>[]; batch: ReturnType<typeof activationBatch> }> {
    const droppable = [...policy.buckets]
      .sort((a, b) => a.preference - b.preference)
      .flatMap((b) => b.pools)
      .map((pool) => allKeys.filter((k) => (k.startsWith('manage-any') || k.startsWith('convert-any')) && (k.endsWith(`:${pool}`) || !k.includes(':'))))
      .filter((ks) => ks.length > 0)
    let keys = allKeys
    for (let i = 0; ; i++) {
      const grants = build(keys)
      const batch = activationBatch(live, grants, acc.revoked, { trust: !acc.trusted })
      const gas = await this.activationGas(live, batch.calls, grants.length, block)
      if (gas <= ACTIVATION_GAS_BUDGET || i >= droppable.length) {
        if (keys.length < allKeys.length) console.log(`[activate] ${live.safe} ~${gas} gas: dropped ${allKeys.filter((k) => !keys.includes(k)).join(', ')} to fit Base's per-tx gas cap`)
        return { keys, grants, batch }
      }
      keys = keys.filter((k) => !droppable[i]!.includes(k))
    }
  }

  /** Simulated gas of the activation calls from the Safe plus calldata and Safe/WebAuthn overhead; a static estimate when the simulation is unavailable (e.g. undeployed Safe). */
  private async activationGas(live: LiveAccount, calls: Parameters<typeof ownerSafeTx>[0], sessions: number, block: bigint): Promise<bigint> {
    const bytes = calls.reduce((n, c) => n + BigInt((c.data.length - 2) / 2), 0n)
    const overhead = 16n * bytes + ACTIVATION_OVERHEAD_GAS
    try {
      const res = await simulateCalls(this.client, calls.map((c) => ({ from: live.safe, to: c.to, data: c.data })), block)
      if (res.every((x) => x.status === 'success')) return res.reduce((n, x) => n + x.gasUsed, 0n) + overhead
    } catch {
      // fall through to the static estimate
    }
    return 400_000n + BigInt(sessions) * STATIC_GAS_PER_SESSION + overhead
  }

  async prepareActivate(ctx: AccountContext): Promise<OwnerTxToSign> {
    this.assertLive()
    const { acc, live } = this.account(ctx)
    if (acc.active) throw new HttpError(409, 'ALREADY_ACTIVE', 'the engine is already active for this account')
    const r = await readSafe(this.client, live.safe)
    if (r.usdc > LIVE_CAP_USDC) throw depositOverCap(r.usdc)
    if (!r.deployed && r.usdc > 0n && r.usdc < MIN_DEPLOY_USDC) throw belowDeployMinimum(r.usdc)
    if (!acc.sessionKey) {
      acc.sessionKey = generatePrivateKey()
      this.store.save()
    }
    const sessionKey = privateKeyToAccount(acc.sessionKey).address
    const policy = this.cfg.policy
    // Sized at the account cap, not the observed deposit: the same signature bounds any deposit up to the cap,
    // so the owner can sign before any USDC arrives (armed activation).
    const prices = Object.fromEntries(
      [...new Set([LIVE_POOL_NAME, ...policy.buckets.flatMap((b) => b.pools)])].map((pool) => {
        const pr = priceOf(pool, r.prices[pool]!.sqrtPriceX96)
        return [pr.asset, { num: pr.num, den: pr.den }]
      }),
    )
    const caps = computeCaps(policy, LIVE_CAP_USDC, prices)
    const block = await this.client.getBlock({ blockNumber: r.block })
    const t = Number(block.timestamp)
    const allKeys = policy.session.grants.filter((g) => !g.perPosition).map(grantKey)
    const build = (keys: string[]) => keys.map((key) =>
      instantiateGrant(policy, key, {
        account: live.safe,
        sessionKey,
        chainId: this.cfg.chainId,
        salt: toHex(randomBytes(32)),
        validAfter: t - 60,
        validUntil: t + policy.session.validitySeconds,
        caps,
        admittedTokenIds: [],
      }),
    )
    const { keys, grants, batch } = await this.fitActivation(live, policy, allKeys, build, acc, r.block)
    const stored = grants.map((g, i) => ({ name: keys[i]!, grant: g, permissionId: batch.permissionIds[i]! }))
    const pools = policy.buckets.filter((b) => b.pools[0]).map((b) => `${poolLabel(b.pools[0]!)} ${b.preference / 100}%`)
    if (pools.length > 1) {
      const summary = [
        `${r.deployed ? 'Use' : 'Create'} your Safe ${live.safe} on Base`,
        r.usdc > 0n
          ? `Let Mamoru's engine keep your ${fmtUsdc(r.usdc)} USDC invested across Uniswap v3 ${pools.join(', ')}`
          : `Let Mamoru's engine keep your deposit (up to ${fmtUsdc(LIVE_CAP_USDC)} USDC) invested across Uniswap v3 ${pools.join(', ')} as soon as it arrives`,
        `Engine key ${sessionKey} may only swap USDC into those pools' tokens and mint those pools, for ${Math.round(policy.session.validitySeconds / 86_400)} days`,
        `Funds never leave your Safe without your passkey; cap ${fmtUsdc(LIVE_CAP_USDC)} USDC`,
      ]
      return this.hold(acc, live, 'activate', batch.calls, summary, { grants: stored })
    }
    const summary = [
      `${r.deployed ? 'Use' : 'Create'} your Safe ${live.safe} on Base`,
      r.usdc > 0n
        ? `Let Mamoru's engine allocate your ${fmtUsdc(r.usdc)} USDC into Uniswap v3 USDC/cbBTC 0.05%`
        : `Let Mamoru's engine allocate your deposit (up to ${fmtUsdc(LIVE_CAP_USDC)} USDC) into Uniswap v3 USDC/cbBTC 0.05% as soon as it arrives`,
      `Engine key ${sessionKey} may only swap USDC->cbBTC (max ${fmtUsdc(caps.usdcSwapPerCall ?? 0n)} per swap) and mint that pool, for ${Math.round(policy.session.validitySeconds / 86_400)} days`,
      ...(hasManageAny(policy)
        ? [`It may also re-range, reduce and harvest your positions in that pool (withdraw liquidity, collect fees, convert cbBTC->USDC); every token and position it touches is paid back to your Safe`]
        : []),
      `Funds never leave your Safe without your passkey; cap ${fmtUsdc(LIVE_CAP_USDC)} USDC`,
    ]
    return this.hold(acc, live, 'activate', batch.calls, summary, { grants: stored })
  }

  /** Planned under the account lock: an in-flight engine op (reduce, re-range) lands first, so the plan sees its liquidity. */
  prepareTransfer(ctx: AccountContext, req: TransferRequest): Promise<TransferPlan> {
    return this.lock(ctx.accountKey).run(() => this.planTransfer(ctx, req))
  }

  private async planTransfer(ctx: AccountContext, req: TransferRequest): Promise<TransferPlan> {
    this.assertLive()
    const { acc, live } = this.account(ctx)
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
    const payoutCap = PAYOUT_CAP_USDC[asset]
    if (payoutCap !== undefined && amount > payoutCap) throw new HttpError(409, 'CAP_EXCEEDED', `${ASSET_LABEL[asset] ?? asset} payouts are capped at ${fmtUsdc(payoutCap)} USD each`)
    const to = getAddress(req.to)
    if (to.toLowerCase() === live.safe.toLowerCase()) throw new HttpError(400, 'BAD_REQUEST', 'recipient is the Safe itself')
    // An undeployed Safe can still pay out: the relayer deploys it right before the owner transfer (executeOwner).
    const r = await readSafe(this.client, live.safe)
    if (!r.deployed && r.usdc < MIN_DEPLOY_USDC) throw belowDeployMinimum(r.usdc)
    const slip = this.policyOf(acc).execution.slippageBps
    let reduce: { pos: PoolPosition; bps: number; lp: LivePosition }[] = []
    let swaps: SwapBack[] = []
    if (r.usdc < amount) {
      const plan = await this.reducePlan(acc, live.safe, r, amount, slip)
      reduce = plan.reduce
      swaps = plan.swaps
    }
    const out = asset === 'USDC' ? undefined : await this.receiveQuote(asset, amount, r.block, slip)
    const deadline = (await this.client.getBlock()).timestamp + 1800n
    const calls = [
      ...closeCalls(live.safe, reduce.map((x) => x.lp), deadline, false),
      ...swapBackCalls(live.safe, swaps),
      ...transferBatch({ account: live.safe, to, amountUsdc: amount, reduce: [], deadline, receive: out?.receive }),
    ]
    const probe = out ? balanceProbe(asset, to) : undefined
    const sim = await this.checkFromSafe(live.safe, calls, r.block, probe)
    if (out && probe) {
      const delta = probe.decode(sim.after!) - probe.decode(sim.before!)
      if (delta < out.receive.amountOutMinimum) throw new HttpError(409, 'SIMULATION_FAILED', `the recipient would receive ${delta} ${asset} units, less than the minimum ${out.receive.amountOutMinimum}`)
    }
    const short = `${to.slice(0, 6)}…${to.slice(-4)}`
    const summary = [
      ...(r.deployed ? [] : [`Create your Safe ${live.safe} on Base`]),
      ...reduce.map((x) => `Withdraw ${(x.bps / 100).toFixed(2)}% of position #${x.pos.tokenId} (${poolLabel(x.pos.pool)})`),
      ...swaps.map((sw) => `Swap ${sw.amountIn} ${sw.token} units to at least ${fmtUsdc(sw.amountOutMinimum)} USDC`),
      ...(out
        ? [
            `Swap ${fmtUsdc(amount)} USDC from your Safe on ${out.route}`,
            `Receive at least ${fmtUnits(out.receive.amountOutMinimum, out.decimals)} ${ASSET_LABEL[asset] ?? asset} at ${short} (${to})`,
          ]
        : [`Send ${fmtUsdc(amount)} USDC from your Safe to ${to}`]),
    ]
    const ownerTx = await this.hold(acc, live, 'transfer', calls, summary, { meta: { amountUsdc: amount.toString(), ...(asset === 'USDC' ? {} : { asset }), to } })
    return {
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
        try {
          await this.receiveQuote(a.asset, 1_000_000n, block, this.cfg.policy.execution.slippageBps)
          return a
        } catch (e) {
          return { asset: a.asset, available: false, reason: `No Uniswap quote for ${a.asset} right now (${(e as Error).message.split('\n')[0]})` }
        }
      }),
    )
    return { assets }
  }

  /** QuoterV2 at the prepare block over every registered pool for the asset; the best output wins. */
  private async receiveQuote(asset: WithdrawAsset, amountIn: bigint, blockNumber: bigint, slip: number): Promise<{ receive: LiveReceive; quoted: bigint; decimals: number; route: string }> {
    const routes = RECEIVE_ROUTES[asset as ReceiveAsset]
    if (!routes) throw new HttpError(409, 'ASSET_UNAVAILABLE', `${asset} is not available`)
    let best: { pool: string; fee: number; out: bigint } | undefined
    for (const pool of routes.pools) {
      const fee = entry(pool).fee!
      try {
        const out = await quoteExactInputSingle(this.client, { tokenIn: address('USDC'), tokenOut: address(routes.tokenOut), fee, amountIn, blockNumber })
        if (!best || out > best.out) best = { pool, fee, out }
      } catch {
        // an empty or broken pool only drops out of the route set
      }
    }
    if (!best) throw new HttpError(503, 'QUOTE_UNAVAILABLE', `no Uniswap v3 quote for USDC -> ${asset}`)
    const pair = `USDC/${routes.tokenOut}`
    const route = `Uniswap v3 ${pair} ${(best.fee / 10_000).toFixed(2)}%${asset === 'ETH' ? ' + unwrap' : ''}`
    return { receive: { asset: routes.receive, fee: best.fee, amountOutMinimum: minOut(best.out, slip) }, quoted: best.out, decimals: entry(routes.tokenOut).decimals!, route }
  }

  /**
   * Withdraw: reduce the stables bucket first, then BTC, then risk (policy bucket order), only as far as needed,
   * plus swaps of what the reduce frees back to USDC; sized from a simulated decrease+collect at the prepare block.
   */
  private async reducePlan(acc: AccountState, safe: Address, r: SafeRead, amount: bigint, slip: number): Promise<{ reduce: { pos: PoolPosition; bps: number; lp: LivePosition }[]; swaps: SwapBack[] }> {
    const open = r.positions.filter((p) => p.liquidity > 0n)
    const value = open.reduce((s, p) => s + positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96), 0n)
    const need = amount - r.usdc
    if (value === 0n) throw new HttpError(409, 'INSUFFICIENT_FUNDS', `idle ${r.usdc} USDC and no position to reduce`)
    const keep = BigInt(10_000 - slip)
    const order = this.bucketPools(acc)
    let margin = 103n
    for (;;) {
      const target = (need * margin) / 100n
      const plan = planReduce(open, r.prices, target > value ? value : target, order)
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

  /** What decreaseLiquidity + collect of these positions returns to the Safe, per token, simulated from the Safe at `block`. */
  private async simulateCollect(safe: Address, lps: { lp: LivePosition; pos: PoolPosition }[], block: bigint): Promise<Record<string, bigint>> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const calls: { to: Address; data: Hex; pos?: PoolPosition }[] = lps.flatMap(({ lp: p, pos }) => [
      ...(p.liquidity > 0n ? [decreaseLiquidity({ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: p.amount0Min, amount1Min: p.amount1Min, deadline })] : []),
      { ...collect({ account: safe, tokenId: p.tokenId }), pos },
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

  /** Quotes every non-USDC amount back to USDC on its route; amounts too small to quote a positive minimum stay in the Safe. */
  private async swapQuotes(acc: AccountState, amounts: Record<string, bigint>, blockNumber: bigint, slip: number): Promise<SwapBack[]> {
    const out: SwapBack[] = []
    for (const [token, raw] of Object.entries(amounts)) {
      if (token === 'USDC') continue
      // one unit less: collect rounding can leave the Safe a unit short of the simulated amount
      const amountIn = raw > 1n ? raw - 1n : 0n
      if (amountIn <= 0n) continue
      const pool = routeOf(token, this.bucketPools(acc), USDC_POOLS)
      if (!pool) continue
      const q = await quoteExactInputSingle(this.client, { tokenIn: address(token), tokenOut: address('USDC'), fee: entry(pool).fee!, amountIn, blockNumber }).catch(() => 0n)
      if (q <= 1n) continue
      const amountOutMinimum = minOut(q, slip)
      if (amountOutMinimum > 0n) out.push({ token, pool, amountIn, amountOutMinimum })
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
    const out = await quoteExactInputSingle(this.client, { tokenIn: address('cbBTC'), tokenOut: address('USDC'), fee: 500, amountIn, blockNumber })
    return { amountIn, amountOutMinimum: minOut(out, slip) }
  }

  prepareStop(ctx: AccountContext): Promise<OwnerTxToSign> {
    return this.lock(ctx.accountKey).run(() => this.planStop(ctx))
  }

  private async planStop(ctx: AccountContext): Promise<OwnerTxToSign> {
    this.assertLive()
    const { acc, live } = this.account(ctx)
    const r = await readSafe(this.client, live.safe)
    if (!r.deployed) throw new HttpError(409, 'NOT_DEPLOYED', 'the Safe is not deployed yet')
    const slip = this.policyOf(acc).execution.slippageBps
    const keep = BigInt(10_000 - slip)
    const positions: LivePosition[] = r.positions.map((p) => ({ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: (p.amount0 * keep) / 10_000n, amount1Min: (p.amount1 * keep) / 10_000n }))
    const got = positions.length ? await this.simulateCollect(live.safe, positions.map((lp, i) => ({ lp, pos: r.positions[i]! })), r.block) : {}
    const held: Record<string, bigint> = {}
    for (const [t, v] of Object.entries(r.tokens)) if (t !== 'USDC' && v > 0n) held[t] = v + 1n
    for (const [t, v] of Object.entries(got)) if (t !== 'USDC') held[t] = (held[t] ?? 1n) + v
    const swaps = await this.swapQuotes(acc, held, r.block, slip)
    const revokes = acc.grants.map((g) => g.permissionId)
    if (!revokes.length && !positions.length && !swaps.length) throw new HttpError(409, 'NOTHING_TO_STOP', 'no grant, no position and nothing to swap back')
    const deadline = (await this.client.getBlock()).timestamp + 1800n
    const calls = [
      ...(revokes.length || positions.length ? stopBatch({ account: live.safe, permissionIds: revokes, positions, deadline }) : []),
      ...swapBackCalls(live.safe, swaps),
    ]
    await this.checkFromSafe(live.safe, calls, r.block, undefined)
    const summary = [
      ...(revokes.length ? [`Revoke the engine's ${revokes.length} session grant(s)`] : []),
      ...r.positions.map((p) => `Close and burn position #${p.tokenId} (${poolLabel(p.pool)})`),
      ...swaps.map((sw) => `Swap ${sw.amountIn} ${sw.token} units to at least ${fmtUsdc(sw.amountOutMinimum)} USDC`),
      'Everything stays in your Safe as USDC',
    ]
    return this.hold(acc, live, 'stop', calls, summary, { revokes })
  }

  // ---- owner side: submit --------------------------------------------------

  async submit(ctx: AccountContext, kind: OwnerKind, body: OwnerSignature): Promise<OpView> {
    this.assertLive()
    const { acc, live } = this.account(ctx)
    const p = body && typeof body.prepareId === 'string' ? this.prepared.get(body.prepareId) : undefined
    if (!p || p.accountKey !== acc.accountKey || p.kind !== kind) throw new HttpError(404, 'PREPARE_UNKNOWN', 'no such prepared transaction for this account')
    if (p.expires < Date.now()) {
      this.prepared.delete(p.prepareId)
      throw new HttpError(410, 'PREPARE_EXPIRED', 'the prepared transaction expired, prepare again')
    }
    let signature: Hex
    try {
      signature = browserOwnerSignature(body, p.safeTxHash)
    } catch (e) {
      // No Safe signature can be built from this body, so there is nothing to ask the chain about. The shape is kept for diagnosis.
      logErr(`[owner] OWNER_SIG_UNPARSEABLE ${acc.accountKey} ${kind} ${JSON.stringify(bodyShape(body))}:`, e)
      throw safeHttpError(400, 'BAD_SIGNATURE')
    }
    // The off-chain check mirrors the on-chain verifier and the chain is the ground truth: a "no" from the mirror is
    // never the reason to refuse an owner. When it says no, the exact sequence the relayer would send is simulated
    // with this signature. If that succeeds the signature is valid on chain and the request goes on; if it reverts
    // the signature is forged or wrong; if nothing can answer, the request is refused for now and can be sent again.
    if (!(await verifyOwnerSignature(signature, p.safeTxHash, live.webauthn))) {
      const truth = await this.groundTruth(live, execData(p.tx, signature))
      if (truth.outcome === 'unavailable') {
        logErr(`[owner] ${acc.accountKey} ${kind} signature not verified off chain and no simulation available, retryable:`, truth.why)
        throw safeHttpError(503, 'OWNER_CHECK_UNAVAILABLE')
      }
      if (truth.outcome === 'revert') {
        this.prepared.delete(p.prepareId)
        throw new HttpError(400, 'BAD_SIGNATURE', 'the passkey signature does not match this account and transaction')
      }
      this.mirrorMismatch(acc, kind, bodyShape(body))
    }
    this.prepared.delete(p.prepareId)
    if (kind === 'activate') {
      // Only a new activation is subject to the failure budget; a proven owner's transfer or stop never is.
      this.assertBudget(acc)
      const usdc = await this.usdcOf(live.safe)
      if (usdc === 0n) return this.arm(acc, p, signature)
      if (usdc > LIVE_CAP_USDC) throw depositOverCap(usdc)
      this.disarm(acc, 'ARMED_SUPERSEDED')
    }
    const op = this.newOp(acc, kind === 'stop' ? 'exit' : kind)
    this.stash(acc, op, p)
    const run = this.lock(acc.accountKey).run(() => this.execute(acc, live, p, signature, op))
    run.catch((e) => {
      logErr(`[owner] ${op.opId}:`, e)
      // A refusal before anything was sent keeps its own code; anything else may have reached the chain.
      this.failOwner(acc, op, e instanceof HttpError ? e.code : 'OWNER_TX_ERROR')
    })
    await Promise.race([run.catch(() => undefined), Bun.sleep(POST_WAIT_MS)])
    return { ...acc.ops.find((o) => o.opId === op.opId)! }
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
    // The mirror of the on-chain verifier. When it says yes the signature is proven. When it says no, only the chain
    // (the simulation below) decides: it must succeed for anything to be sent, and a revert is the refusal.
    const proven = await verifyOwnerSignature(signature, p.safeTxHash, live.webauthn)
    const data = execData(p.tx, signature)
    for (let attempt = 0; ; attempt++) {
      const { deployed, nonce } = await readSafeNonce(this.client, live.safe)
      if (nonce !== p.tx.nonce) return { code: 'SAFE_NONCE_MOVED' }
      const usdc = await this.usdcOf(live.safe)
      if (p.kind === 'activate' && usdc > LIVE_CAP_USDC) return { code: 'DEPOSIT_OVER_CAP', detail: { amountUsdc: usdc.toString(), capUsdc: LIVE_CAP_USDC.toString() } }
      if (!deployed && usdc < MIN_DEPLOY_USDC) return { code: 'BELOW_DEPLOY_MINIMUM' }
      let sim = await this.simulateOwner(live, deployed, data)
      if (sim.outcome === 'unavailable') {
        logErr(`[owner] ${acc.accountKey} ${p.kind} simulation unavailable:`, sim.why)
        if (deployed) sim = await this.callOwner(live, data)
        if (sim.outcome === 'unavailable') {
          // Neither proof is in hand: not refused for good, not sent, not counted. The caller may try again.
          if (!proven) {
            logErr(`[owner] ${acc.accountKey} ${p.kind} signature not verified off chain and no simulation available:`, sim.why)
            throw safeHttpError(503, 'OWNER_CHECK_UNAVAILABLE')
          }
          logErr(`[owner] ${acc.accountKey} ${p.kind}:`, `proceeding on the verified signature${deployed ? '' : ' and the minimum balance (Safe not deployed)'}`)
          return null
        }
      }
      if (sim.outcome === 'ok') {
        if (!proven) this.mirrorMismatch(acc, p.kind, ownerSignatureShape(signature))
        return null
      }
      if (attempt >= 2) {
        logErr(`[owner] ${acc.accountKey} ${p.kind} would revert, nothing sent:`, sim.why)
        return { code: proven ? 'OWNER_TX_REVERTS' : 'BAD_SIGNATURE' }
      }
      logErr(`[owner] ${acc.accountKey} ${p.kind} simulation reverts, retry ${attempt + 1}:`, sim.why)
      await Bun.sleep(this.retryMs)
    }
  }

  /** What the chain says about this execTransaction: the relayer's sequence simulated, or an eth_call when the Safe is deployed and the simulation cannot run. A revert is asked again twice (lagging node). */
  private async groundTruth(live: LiveAccount, data: Hex): Promise<Outcome> {
    for (let attempt = 0; ; attempt++) {
      const { deployed } = await readSafeNonce(this.client, live.safe)
      let sim = await this.simulateOwner(live, deployed, data)
      if (sim.outcome === 'unavailable' && deployed) sim = await this.callOwner(live, data)
      if (sim.outcome !== 'revert' || attempt >= 2) return sim
      await Bun.sleep(this.retryMs)
    }
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
  private async simulateOwner(live: LiveAccount, deployed: boolean, data: Hex): Promise<Outcome> {
    const from = this.relayer.address
    const calls = [...(deployed ? [] : [{ from, ...deployCall(live) }]), { from, to: live.safe, data }]
    let res: SimCallResult[] | undefined
    let why = 'simulation unavailable'
    for (let i = 0; i < SIM_TRIES && !res; i++) {
      try {
        res = await simulateCalls(this.client, calls, await this.client.getBlockNumber({ cacheTime: 0 }))
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

  /** A plain eth_call of execTransaction from the relayer on a deployed Safe: a revert is a revert, anything else is the provider. */
  private async callOwner(live: LiveAccount, data: Hex): Promise<Outcome> {
    let why = 'eth_call unavailable'
    for (let i = 0; i < SIM_TRIES; i++) {
      try {
        await this.client.call({ account: this.relayer.address, to: live.safe, data })
        return { outcome: 'ok' }
      } catch (e) {
        if (isRevert(e)) return { outcome: 'revert', why: revertReason(e) }
        why = (e as Error).message.split('\n')[0] ?? why
        if (i < SIM_TRIES - 1) await Bun.sleep(this.retryMs)
      }
    }
    return { outcome: 'unavailable', why }
  }

  private usdcOf(safe: Address): Promise<bigint> {
    return this.client.readContract({ address: address('USDC'), abi: erc20Abi, functionName: 'balanceOf', args: [safe] })
  }

  /** Stores the signed activation (0600 state file); the watcher executes it when USDC lands. */
  private arm(acc: AccountState, p: Prepared, signature: Hex): OpView {
    this.disarm(acc, 'ARMED_SUPERSEDED')
    const op = this.newOp(acc, 'activate')
    op.code = 'ARMED'
    this.stash(acc, op, p)
    acc.armed = { opId: op.opId, tx: p.tx, safeTxHash: p.safeTxHash, signature, grants: p.grants ?? [], armedAt: now() }
    this.store.save()
    console.log(`[armed] ${acc.accountKey} ${op.opId} armed for ${acc.ctx.address} at Safe nonce ${p.tx.nonce}`)
    return { ...op }
  }

  /** Drops a pending armed activation, failing its op with `code` (and what `detail` adds to the op). */
  private disarm(acc: AccountState, code: string, detail: Partial<OpView> = {}): void {
    const a = acc.armed
    if (!a) return
    acc.armed = undefined
    this.patchOp(acc, a.opId, { state: 'failed', code, ...detail })
  }

  /** One USDC balance read per armed account every ARM_WATCH_MS; executes the armed activation once 0 < USDC <= cap. */
  private async watchArmed(): Promise<void> {
    if (this.armStopped) return
    for (const acc of Object.values(this.store.state.accounts)) {
      if (!acc.armed || this.armStopped) continue
      try {
        const usdc = await this.usdcOf(acc.ctx.address as Address)
        if (usdc === 0n) continue
        await this.lock(acc.accountKey).run(() => this.fireArmed(acc, usdc))
      } catch (e) {
        logErr(`[armed] ${acc.accountKey}`, e)
      }
    }
    if (!this.armStopped) this.armTimer = setTimeout(() => this.watchArmed(), ARM_WATCH_MS)
  }

  private async fireArmed(acc: AccountState, usdc: bigint): Promise<void> {
    const a = acc.armed
    if (!a || acc.active) return this.disarm(acc, 'ALREADY_ACTIVE')
    if (this.overBudget(acc)) return this.disarm(acc, 'OWNER_FAILURE_BUDGET')
    if (usdc > LIVE_CAP_USDC) {
      logErr(`[armed] ${acc.accountKey} deposit over cap:`, { usdc: usdc.toString(), cap: LIVE_CAP_USDC.toString() })
      // On the op the SPA reads, with the amounts: the owner withdraws the excess, then approves Start again.
      return this.disarm(acc, 'DEPOSIT_OVER_CAP', { amountUsdc: usdc.toString(), capUsdc: LIVE_CAP_USDC.toString() })
    }
    const live = liveAccountFromContext(acc.ctx)
    const { deployed, nonce } = await readSafeNonce(this.client, live.safe)
    if (deployed && nonce !== a.tx.nonce) {
      console.log(`[armed] ${acc.accountKey} Safe nonce ${nonce} != armed ${a.tx.nonce}`)
      return this.disarm(acc, 'ARMED_NONCE_MOVED')
    }
    // Too little to deploy a Safe for: stay armed and wait for more (funding reports deployMinUsdc).
    if (!deployed && usdc < MIN_DEPLOY_USDC) return
    acc.armed = undefined
    this.patchOp(acc, a.opId, { code: undefined })
    console.log(`[armed] ${acc.accountKey} ${a.opId} deposit ${usdc} landed, executing`)
    const p: Prepared = { prepareId: `armed-${a.opId}`, accountKey: acc.accountKey, kind: 'activate', tx: a.tx, safeTxHash: a.safeTxHash, expires: Number.MAX_SAFE_INTEGER, grants: a.grants }
    const op = acc.ops.find((o) => o.opId === a.opId)!
    try {
      await this.execute(acc, live, p, a.signature, op)
    } catch (e) {
      // Transient RPC/relay failures keep the signed activation armed; the watcher retries it on the next pass.
      const tries = (a.tries ?? 0) + 1
      logErr(`[armed] ${op.opId} attempt ${tries}:`, e)
      if (tries < ARM_MAX_TRIES && !acc.active) {
        acc.armed = { ...a, tries }
        this.patchOp(acc, op.opId, { state: 'proposed', code: 'ARMED' })
      } else if (!acc.active) this.failOwner(acc, op, 'OWNER_TX_ERROR')
    }
  }

  private newOp(acc: AccountState, kind: OpView['kind']): OpView {
    const op: OpView = { opId: `own-${++acc.seq}-${kind}`, kind, state: 'proposed', updatedAt: now() }
    acc.ops.push(op)
    this.store.save()
    return op
  }

  /** Keeps on the op what a late receipt needs to apply the owner tx (grants, revokes) and what history shows (transfer). */
  private stash(acc: AccountState, op: OpView, p: Prepared): void {
    const o = op as StoredOp
    if (p.kind === 'activate' && p.grants) o.ownerGrants = p.grants
    if (p.kind === 'stop' && p.revokes) o.revokes = p.revokes
    if (p.meta) Object.assign(o, p.meta)
    this.store.save()
  }

  private patchOp(acc: AccountState, opId: string, patch: Partial<OpView>): void {
    const op = acc.ops.find((o) => o.opId === opId)
    if (!op) return
    Object.assign(op, patch, { updatedAt: now() })
    this.store.save()
  }

  private async execute(acc: AccountState, live: LiveAccount, p: Prepared, signature: Hex, op: OpView): Promise<void> {
    this.setBusy(acc, p.kind === 'activate' ? 'activating' : p.kind === 'stop' ? 'closing' : 'withdrawing')
    try {
      await this.executeOwner(acc, live, p, signature, op)
    } finally {
      this.busy.delete(acc.accountKey)
    }
  }

  private async executeOwner(acc: AccountState, live: LiveAccount, p: Prepared, signature: Hex, op: OpView): Promise<void> {
    const safe = live.safe
    // Before any relayer transaction: signature, guards and a simulation of everything about to be sent.
    const refusal = await this.preflight(acc, live, p, signature)
    if (refusal) return this.failOwner(acc, op, refusal.code, refusal.detail)
    // A transfer may be the first owner tx of a Safe that never started (deposit over the cap): deploy it first too.
    if (p.kind === 'activate' || p.kind === 'transfer') {
      const { deployed } = await readSafeNonce(this.client, safe)
      if (!deployed) {
        this.setBusy(acc, 'deploying')
        const d = deployCall(live)
        const { hash, receipt } = await this.relayer.send(d)
        console.log(`[owner] deploy ${safe} tx ${hash} ${receipt.status}`)
        if (receipt.status !== 'success') return this.failOwner(acc, op, 'DEPLOY_FAILED', { txHash: hash })
        this.setBusy(acc, p.kind === 'activate' ? 'activating' : 'withdrawing')
      }
    }
    if (p.kind === 'activate') {
      const target = this.cfg.policy.gasReserveWei + TOP_UP_MARGIN_WEI
      const eth = await this.client.getBalance({ address: safe })
      if (eth < target) {
        const { hash, receipt } = await this.relayer.send({ to: safe, value: target - eth, gas: 50_000n })
        console.log(`[owner] top-up ${safe} +${target - eth} wei tx ${hash} ${receipt.status}`)
      }
    }
    const { nonce } = await readSafeNonce(this.client, safe)
    if (nonce !== p.tx.nonce) return this.patchOp(acc, op.opId, { state: 'failed', code: 'SAFE_NONCE_MOVED' })
    const data = execData(p.tx, signature)
    // A load-balanced provider can answer from a lagging node: retry the static check before failing the op.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.call({ account: this.relayer.address, to: safe, data })
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
          return this.failOwner(acc, op, 'OWNER_TX_REVERTS')
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
      if (usdc > LIVE_CAP_USDC) {
        logErr(`[owner] ${op.opId} deposit over cap at send time, not activating:`, { usdc: usdc.toString(), cap: LIVE_CAP_USDC.toString() })
        return this.failOwner(acc, op, 'DEPOSIT_OVER_CAP', { amountUsdc: usdc.toString(), capUsdc: LIVE_CAP_USDC.toString() })
      }
    }
    // Keep the hash as soon as the tx is out: if the receipt poll fails, reconciliation reads it later.
    const { hash, receipt } = await this.relayer.send({ to: safe, data }, (h) => this.patchOp(acc, op.opId, { state: 'submitted', txHash: h }))
    this.patchOp(acc, op.opId, { state: 'submitted', txHash: hash })
    const ok = receipt.status === 'success' && receipt.logs.some((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === EXECUTION_SUCCESS)
    console.log(`[owner] ${op.opId} tx ${hash} block ${receipt.blockNumber} ${ok ? 'ok' : 'FAILED'}`)
    if (!ok) return this.failOwner(acc, op, 'OWNER_TX_FAILED', { block: Number(receipt.blockNumber) })
    this.afterOwner(acc, p, receipt)
    this.patchOp(acc, op.opId, { state: 'confirmed', code: 'EXEC_OK', block: Number(receipt.blockNumber) })
  }

  private afterOwner(acc: AccountState, p: Prepared, receipt: TransactionReceipt): void {
    if (p.kind === 'activate') {
      acc.trusted = true
      acc.active = true
      acc.grants = p.grants ?? []
      acc.policyId = p.grants?.[0]?.grant.policyId ?? this.cfg.policy.policyId
      acc.managedTokenIds = []
      acc.depositsAfter = receipt.blockNumber.toString()
      acc.historyFromBlock = receipt.blockNumber.toString()
      acc.epoch++
      this.store.save()
      this.startLoop(acc)
    } else if (p.kind === 'stop') {
      this.stopLoop(acc.accountKey)
      this.disarm(acc, 'STOPPED')
      acc.active = false
      acc.revoked.push(...(p.revokes ?? []))
      acc.grants = []
      acc.managedTokenIds = []
      this.store.save()
    } else {
      // The Safe nonce moved, so an activation signed earlier can never run: drop it and let the app ask for a fresh Start.
      this.disarm(acc, 'ARMED_SUPERSEDED')
    }
  }

  // ---- owner side: late receipts -------------------------------------------

  /** Background pass (throttled, under the account lock): owner ops failed only because the receipt poll failed. */
  private reconcileSoon(acc: AccountState): void {
    if (!acc.ops.some((o) => o.opId.startsWith('own-') && o.state === 'failed' && o.code === RECEIPT_UNKNOWN)) return
    const last = this.reconciled.get(acc.accountKey) ?? 0
    if (Date.now() - last < RECONCILE_EVERY_MS) return
    this.reconciled.set(acc.accountKey, Date.now())
    this.lock(acc.accountKey)
      .run(() => this.reconcileOwner(acc))
      .catch((e) => logErr(`[reconcile] ${acc.accountKey}`, e))
  }

  /** Reads every owner op marked failed with an unknown receipt; a tx that executed becomes confirmed with its side effects. */
  async reconcileOwner(acc: AccountState): Promise<void> {
    const safe = (acc.ctx.address as string).toLowerCase()
    for (const op of acc.ops.filter((o) => o.opId.startsWith('own-') && o.state === 'failed' && o.code === RECEIPT_UNKNOWN)) {
      let found: { hash: Hex; block: number; ok: boolean } | null = null
      const receipt = op.txHash ? await this.receiptOf(op.txHash as Hex) : null
      if (receipt) {
        const ok = receipt.status === 'success' && receipt.logs.some((l) => l.address.toLowerCase() === safe && l.topics[0] === EXECUTION_SUCCESS)
        found = { hash: receipt.transactionHash, block: Number(receipt.blockNumber), ok }
      } else found = await this.findOwnerTx(acc, op)
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
        acc.grants = []
        acc.managedTokenIds = []
        this.store.save()
      } else if (op.kind === 'activate') {
        if (!op.ownerGrants) {
          console.log(`[reconcile] ${op.opId} landed but its grants were not kept; left as is`)
          continue
        }
        if (!later('exit') && !acc.active) {
          const r = receipt ?? ({ blockNumber: BigInt(block) } as TransactionReceipt)
          this.afterOwner(acc, { prepareId: op.opId, accountKey: acc.accountKey, kind: 'activate', tx: undefined as never, safeTxHash: '0x', expires: 0, grants: op.ownerGrants }, r)
        }
      }
      console.log(`[reconcile] ${op.opId} tx ${hash} landed at block ${block}, confirmed`)
      this.patchOp(acc, op.opId, { state: 'confirmed', code: 'EXEC_OK', txHash: hash, block })
    }
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
   * Without a receipt: the Safe's ExecutionSuccess log in the blocks just before the failure time. Only an owner
   * execTransaction emits it (engine userOps run through the module), so the log proves the tx executed. With a kept
   * hash the log must carry it; without one, exactly one log not claimed by another op, or nothing.
   */
  private async findOwnerTx(acc: AccountState, op: StoredOp): Promise<{ hash: Hex; block: number; ok: boolean } | null> {
    const head = await this.client.getBlock()
    const t = BigInt(Math.floor(Date.parse(op.updatedAt) / 1000))
    const lag = head.timestamp > t ? (head.timestamp - t) / BLOCK_SECONDS : 0n
    const at = head.number - lag
    const fromBlock = at > 150n ? at - 150n : 0n
    const toBlock = at + 10n < head.number ? at + 10n : head.number
    const logs = (await this.client.getLogs({ address: acc.ctx.address as Address, fromBlock, toBlock })).filter((l) => l.topics[0] === EXECUTION_SUCCESS && l.transactionHash)
    const hit = (h: string) => logs.find((l) => l.transactionHash!.toLowerCase() === h.toLowerCase())
    if (op.txHash) {
      const l = hit(op.txHash)
      return l ? { hash: l.transactionHash!, block: Number(l.blockNumber), ok: true } : null
    }
    const claimed = new Set(acc.ops.map((o) => o.txHash?.toLowerCase()).filter(Boolean))
    const free = [...new Map(logs.filter((l) => !claimed.has(l.transactionHash!.toLowerCase())).map((l) => [l.transactionHash!, l])).values()]
    if (free.length !== 1) {
      if (free.length > 1) console.log(`[reconcile] ${op.opId} ${free.length} candidate txs, left as is`)
      return null
    }
    return { hash: free[0]!.transactionHash!, block: Number(free[0]!.blockNumber), ok: true }
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
    return { name: `manage:${tokenId}`, grant, permissionId: permissionIdOf(toSmartSession(grant)) }
  }

  /** The live demo does not enable manage grants: every manage session is known to the engine but revoked, so decide never harvests. */
  private revokeManage(engine: Engine): void {
    for (const s of engine.sessions) if (s.grant.name === 'manage') engine.ledger.revoke(s.permissionId)
  }

  private startLoop(acc: AccountState): void {
    this.stopLoop(acc.accountKey)
    if (!acc.sessionKey) throw new Error(`${acc.accountKey} has no session key`)
    acc.runs = (acc.runs ?? 0) + 1
    this.store.save()
    const prefix = `eng-${acc.epoch}-`
    const priorIncluded = acc.ops.filter((o) => o.opId.startsWith(prefix) && o.state === 'confirmed' && o.permissionId && o.calls).map((o) => ({ permissionId: o.permissionId!, calls: o.calls! }))
    const sessions: EngineSession[] = [...acc.grants.map((g) => ({ name: g.name, grant: g.grant, permissionId: g.permissionId })), ...acc.managedTokenIds.map((id) => this.manageSession(acc, BigInt(id)))]
    const engine = new Engine(
      {
        mode: 'live',
        chainId: this.cfg.chainId,
        signingChainIds: [this.cfg.chainId],
        rpcUrl: this.cfg.rpcUrl,
        bundlerUrl: this.cfg.bundlerUrl,
        policy: this.policyOf(acc),
        account: acc.ctx.address as Address,
        sessionKey: privateKeyToAccount(acc.sessionKey),
        nonceLane: 0,
        depositsAfter: BigInt(acc.depositsAfter),
        historyFromBlock: BigInt(acc.historyFromBlock),
        sessions,
        priorIncluded,
        maxWaitBlocks: this.cfg.maxWaitBlocks,
      },
      {
        waitBlock: () => Bun.sleep(this.cfg.waitBlockMs),
        requestManageGrant: async (tokenId, pool) => {
          acc.managedTokenIds.push(tokenId.toString())
          this.store.save()
          return this.manageSession(acc, tokenId, pool)
        },
      },
    )
    this.revokeManage(engine)
    const runner: Runner = { engine, timer: null, stopped: false, epoch: acc.epoch, run: acc.runs, seen: new Map(), alias: new Map() }
    this.runners.set(acc.accountKey, runner)
    const tick = async () => {
      if (runner.stopped) return
      try {
      await this.lock(acc.accountKey).run(async () => {
        if (runner.stopped) return
        try {
          // The provider may still serve a block before the activation that enabled the grants: wait for it.
          const head = await this.client.getBlockNumber()
          if (head <= BigInt(acc.historyFromBlock)) {
            console.log(`[engine ${acc.accountKey}] rpc head ${head} not past activation block ${acc.historyFromBlock}, waiting`)
            return
          }
          // An owner tx prepared on the current positions is waiting for its passkey: an engine reduce or
          // re-range now would change the liquidity it withdraws (GS013). Hold until it runs or expires.
          const now = Date.now()
          if ([...this.prepared.values()].some((p) => p.accountKey === acc.accountKey && p.kind !== 'activate' && p.expires > now)) {
            console.log(`[engine ${acc.accountKey}] owner tx pending, review held`)
            return
          }
          const r = await engine.review()
          this.revokeManage(engine)
          if (r.kind === 'observation-failed') {
            logErr(`[engine ${acc.accountKey}] observation failed ${r.code}:`, r.detail)
            safeMetrics(() => this.engineHealth.record(acc.accountKey, false, r.code, classifyEngineError(r.code, r.detail)))
          } else {
            const d = r.record.decision
            const o = r.op ? engine.journal.op(r.op.opId) : null
            const last = o ? engine.journal.transitions.filter((t) => t.opId === o.opId).at(-1) : null
            // `last.detail` is free text (unlike d.reason/o.state/o.stateCode, all closed enums): redact it.
            const prefix = `[engine ${acc.accountKey}] block ${d.observationRef.block} ${d.kind} ${d.reason}${o ? ` -> ${o.opId} ${o.state} ${o.stateCode}` : ''}`
            if (last?.detail) logErr(prefix, last.detail)
            else console.log(prefix)
            safeMetrics(() => this.engineHealth.record(acc.accountKey, true, d.code, undefined))
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
        if (!runner.stopped) runner.timer = setTimeout(tick, this.cfg.reviewMs)
      }
    }
    runner.timer = setTimeout(tick, 0)
    console.log(`[engine ${acc.accountKey}] loop started for ${acc.ctx.address} every ${this.cfg.reviewMs}ms`)
  }

  private stopLoop(key: string): void {
    const r = this.runners.get(key)
    if (!r) return
    r.stopped = true
    if (r.timer) clearTimeout(r.timer)
    this.runners.delete(key)
    console.log(`[engine ${key}] loop stopped`)
  }

  /** Journal ops that reached the chain path, as OpViews (discarded ones stay in the engine log only). */
  private syncEngineOps(acc: AccountState, runner: Runner): void {
    let changed = false
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
        updatedAt: now(),
        ...(o.state === 'confirmed' && o.permissionId && o.calls ? { permissionId: o.permissionId, calls: o.calls } : {}),
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
    const { permissionId: _p, calls: _c, ownerGrants: _g, revokes: _r, ...view } = o
    if (!k) return void out.push(view)
    if (newest.get(k) !== i) return
    const n = counts.get(k)!
    out.push(n > 1 ? { ...view, count: n } as OpView : view)
  })
  return out
}

/** Start refused: the Safe holds more USDC than the per-account cap. The message carries the amounts for the SPA. */
function depositOverCap(usdc: bigint): HttpError {
  return new HttpError(409, 'DEPOSIT_OVER_CAP', `this account holds ${fmtUsdc(usdc)} USDC, over the ${fmtUsdc(LIVE_CAP_USDC)} USDC cap; withdraw at least ${fmtUsdcUp(usdc - LIVE_CAP_USDC)} USDC to start`)
}

function belowDeployMinimum(usdc: bigint): HttpError {
  return new HttpError(409, 'BELOW_DEPLOY_MINIMUM', `this account holds ${fmtUsdc(usdc)} USDC; Mamoru creates the account on Base from ${fmtUsdc(MIN_DEPLOY_USDC)} USDC`)
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

type Probe = { to: Address; data: Hex; decode: (ret: Hex) => bigint }

const multicall3Abi = parseAbi(['function getEthBalance(address addr) view returns (uint256 balance)'])

/** A read of the recipient's balance of `asset`, run before and after the batch in the same simulation. */
function balanceProbe(asset: WithdrawAsset, holder: Address): Probe {
  if (asset === 'ETH') {
    return { to: address('Multicall3'), data: encodeFunctionData({ abi: multicall3Abi, functionName: 'getEthBalance', args: [holder] }), decode: (d) => decodeFunctionResult({ abi: multicall3Abi, functionName: 'getEthBalance', data: d }) }
  }
  return { to: address(RECEIVE_ROUTES[asset as ReceiveAsset]?.tokenOut ?? asset), data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [holder] }), decode: (d) => decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: d }) }
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

/** Cents rounded up: an amount the owner must reach is never understated. */
function fmtUsdcUp(v: bigint): string {
  return fmtUsdc(((v + 9_999n) / 10_000n) * 10_000n)
}
