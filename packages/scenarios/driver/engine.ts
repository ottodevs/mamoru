import { isAddressEqual, parseEventLogs, toFunctionSelector, type Hex, type Log, type PublicClient } from 'viem'
import type { LocalAccount } from 'viem/accounts'
import { ReasonError, type Address, type ReasonCode } from '@mamoru/domain'
import { amountsOf, decide, twapFloor, type Decision, type Observation, type Proposal, type SessionObs } from '@mamoru/decide'
import { signBlocker } from '@mamoru/journal'
import { hasManageAny, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { address, entry, entryPointV07Abi, nonfungiblePositionManagerAbi, smartSessionAbi, uniswapV3PoolAbi, type RegistryName } from '@mamoru/registry'
import {
  Batch,
  MULTICALL3,
  contractRead,
  historyCursor,
  isSafeAndCanonical,
  observe,
  observeGuardHistory,
  principalOwedBefore,
  readUserOpEvent,
  rpcClient,
  simulateFromEntryPoint,
  type GuardSeries,
  type PoolStateCache,
  type Simulation,
} from '@mamoru/rpc'
import { BundlerClient, BundlerRpcError } from '@mamoru/erc4337'
import { SessionLedger, precheck } from '@mamoru/account/precheck'
import { draftUserOp, executeCallData, sessionNonceKey, signSessionUserOp, useModeSignature, userOpHash, type GasSettings } from '@mamoru/account/sessions'
import type { Execution } from '@mamoru/account/safe'
import { approve, burn, collect, deadlineCheck, decreaseLiquidity, exactInputSingle, mint, type V3Call } from '@mamoru/uniswap-v3'
import { minOut, quoteExactInputSingle, quoteMint } from '@mamoru/uniswap-v3/quote'
import { diverges, swapMinimum, twapFloor as deviationFloor, twapTickAt } from '@mamoru/uniswap-v3/twap'
import { harvestRow, ledgerTotal, positionEvents, type Pair, type SavingsLogRow } from '@mamoru/projector'
import { MemoryJournal, type DecisionRecord, type OpRecord } from './journal.ts'
import { reconcileReceipt } from './receipt.ts'

/** Gas limits of every engine userOp. Their sum is the budget `decide` prices for the harvest cost. */
export const LAB_GAS_LIMITS = { verificationGasLimit: 3_000_000n, callGasLimit: 2_000_000n, preVerificationGas: 100_000n } as const
export const MAX_PRIORITY_FEE_PER_GAS = 1_000_000n
const OP_GAS_UNITS = LAB_GAS_LIMITS.verificationGasLimit + LAB_GAS_LIMITS.callGasLimit + LAB_GAS_LIMITS.preVerificationGas
const ETH_PRICE_POOL = 'pool:WETH/USDC/3000'
/** Bounded waits for the bundler receipt and for `safe`, in blocks the lab lets pass. */
const MAX_WAIT_BLOCKS = 32
/** Live: after a bundler rejection that left the nonce unmoved, the same premise or kind+pool is not proposed again for this long. */
export const UNINCLUDABLE_BACKOFF_SECONDS = 600n

export type EngineSession = { name: string; grant: SessionGrant; permissionId: Hex }

export type EngineConfig = {
  /** 'live' signs and sends on Base only with MAMORU_LIVE=1 (journal signBlocker and the bundler client both check). */
  mode: 'production' | 'lab' | 'live'
  chainId: number
  signingChainIds: readonly number[]
  rpcUrl: string
  bundlerUrl: string
  policy: PolicyVersion
  account: Address
  /** Generated in the test process, never written anywhere. */
  sessionKey: LocalAccount
  nonceLane: number
  depositsAfter: bigint
  sessions: EngineSession[]
  /** Blocks to wait for the UserOperationEvent and for `safe`. Default 32; live Base needs more for its safe head. */
  maxWaitBlocks?: number
  /** First block of the managed positions' history on a restarted engine. Default: depositsAfter. */
  historyFromBlock?: bigint
  /** Session uses already confirmed on chain before this engine started (restart): replayed into the ledger so caps and usage limits count them. */
  priorIncluded?: { permissionId: Hex; calls: Execution[] }[]
  /**
   * otto/mamoru#140 (Sol review round 2 of #64): ops a previous engine of this account signed whose bytes may still be
   * included (see `carried()`): watched from the start like `released`, so a restart or a renewal never drops them.
   */
  carried?: OpRecord[]
  /** Pool state per block, shared with the other engines of the process. */
  poolCache?: PoolStateCache
  /**
   * Spec 004 (#101) LC-T6: builds `Observation.guard.pools` for these pools every review, one more Multicall3
   * batch pinned to the same block as the rest of the observation (`@mamoru/rpc`'s `observeGuardHistory`).
   * Absent, or `pools` empty: `Observation.guard` is never set, byte-identical to before this field existed
   * (FR-LC-001). `series` seeds the rolling fallback for a pool whose on-chain oracle cannot answer the full
   * 24.5 h window (restores it after a restart, when the caller persisted `Engine.guardSeries`); omitted, every
   * such pool starts cold and abstains until its series is long enough (FR-LC-007, fail safe, never a guess).
   * Enabling a policy's guard rules to act on this is a later decision (LC-T9); conservador-live-v2 itself does
   * not change here.
   */
  guardHistory?: { pools: readonly RegistryName[]; series?: ReadonlyMap<RegistryName, GuardSeries> }
  /**
   * The owner's intents, read at every observation (plan §9 step 4, US6). Absent: neither paused nor exiting.
   * Paused, decide holds with DECIDE_PAUSED; an operation already out is still reconciled.
   */
  intents?: () => Observation['intents']
}

export type EngineHooks = {
  /** Lets one block pass on the fork. The engine itself never calls anvil methods. */
  waitBlock: () => Promise<void>
  /**
   * The owner activates `manage:<tokenId>` for a position that enter-mint minted (plan §12.4).
   * Not called under a policy with the live `manage-any` grants, enabled at activation.
   */
  requestManageGrant?: (tokenId: bigint, pool: string) => Promise<EngineSession>
  /**
   * A position this engine minted for the account, once its mint is confirmed (otto/mamoru#140 part2 #4: the live
   * operator records it as admitted), with the block it was minted in.
   */
  onMinted?: (tokenId: bigint, block?: bigint) => void
  /** Whether one more position may be minted (the live operator: under MAX_INVENTORY admitted). Absent: always. */
  mintAllowed?: () => boolean
}

/** The block of the latest operation that reached the chain: no review may observe before it. */
export function observationFloor(ops: readonly Pick<OpRecord, 'included'>[]): bigint {
  return ops.reduce((floor, o) => (o.included && o.included.blockNumber > floor ? o.included.blockNumber : floor), 0n)
}

export type ReviewResult =
  | { kind: 'observation-failed'; code: ReasonCode; detail?: string }
  | { kind: 'decided'; observation: Observation; record: DecisionRecord; op: OpRecord | null }

type Prepared = {
  calls: Execution[]
  quote?: OpRecord['quote']
  /** Harvest: principal owed for the tokenId at the prepare block. */
  owed?: Pair
  /** See OpRecord.expiresAt. */
  expiresAt: bigint | null
}

/** SwapRouter02.multicall(uint256,bytes[]): the action a session grant holds for an on-chain swap expiry. */
const DEADLINE_SELECTOR = toFunctionSelector('function multicall(uint256,bytes[])').toLowerCase()

/** The grant has the SwapRouter02 deadline action (grants from before otto/mamoru#140 do not). */
export function grantHasSwapDeadline(grant: SessionGrant): boolean {
  return grant.actions.some((a) => a.selector.toLowerCase() === DEADLINE_SELECTOR && isAddressEqual(a.targetAddress, address('SwapRouter02')))
}

/**
 * otto/mamoru#140: what a signed userOp the bundler did not include (rejected, or accepted and not seen) becomes.
 * An unmoved nonce does not mean the op cannot land: the bundler (or anyone it gave the bytes to) may still include
 * it. A terminal verdict is taken only on reads at the `safe` block, which no reorg undoes (Sol review of #64):
 * - its UserOperationEvent is on chain (at any height): `included`; confirmation then waits for `safe` as usual;
 * - the nonce moved at `safe` and there is no event: another op took the nonce, ours can never land;
 * - the nonce did not move at `safe` and `safe` is past the op's on-chain expiry: every block it could still land in
 *   is past the expiry too, so its priced calls revert (it may still spend the nonce: see `Engine.released`);
 * - the nonce did not move at `safe` and its permission is not enabled there: it cannot validate any more;
 * - an op that prices nothing (`expiresAt` null) and that the bundler rejected is freed at once, as before: run late,
 *   it only collects to the account (and is still watched, `Engine.released`).
 * Anything else stays pending and holds the slot.
 */
export function settleUnincluded(p: {
  opNonce: bigint
  /** EntryPoint nonce of the op's key at the `safe` block. */
  nonceAtSafe: bigint
  /** The op's UserOperationEvent, read up to `latest`. */
  eventFound: boolean
  safeTimestamp: bigint
  expiresAt: bigint | null
  permissionEnabledAtSafe: boolean
  rejected: boolean
}): { to: 'included' } | { to: 'failed'; code: 'RECON_UNINCLUDABLE' | 'RECON_NONCE_CONSUMED_BY_OTHER'; detail: string } | null {
  if (p.eventFound) return { to: 'included' }
  if (p.nonceAtSafe !== p.opNonce) return { to: 'failed', code: 'RECON_NONCE_CONSUMED_BY_OTHER', detail: `nonce ${p.opNonce} spent by another userOp (${p.nonceAtSafe} at safe)` }
  if (p.expiresAt === null) return p.rejected ? { to: 'failed', code: 'RECON_UNINCLUDABLE', detail: `bundler rejected; nonce ${p.opNonce} unmoved, the op prices nothing` } : null
  if (p.safeTimestamp > p.expiresAt) return { to: 'failed', code: 'RECON_UNINCLUDABLE', detail: `nonce ${p.opNonce} unmoved at a safe block past the on-chain expiry ${p.expiresAt}` }
  if (!p.permissionEnabledAtSafe) return { to: 'failed', code: 'RECON_UNINCLUDABLE', detail: `nonce ${p.opNonce} unmoved and its permission not enabled at a safe block` }
  return null
}

/** Kind and pool of a proposal: the unit a live backoff holds back. */
function proposalKey(p: Proposal): string {
  return `${p.kind}|${p.pool}`
}

function exec(c: V3Call): Execution {
  return { target: c.to, value: c.value, callData: c.data }
}

/**
 * The engine in one process (plan §13.1 without the Durable Object and the
 * Workflow): observe, decide, then take one operation from `proposed` to a
 * terminal state through the plan §10 machine. Same packages as production;
 * only the configuration differs (FR-LAB-006).
 */
export class Engine {
  readonly journal = new MemoryJournal()
  readonly ledger = new SessionLedger()
  readonly sessions: EngineSession[] = []
  readonly allowedTokenIds: bigint[] = []
  readonly savingsLog: SavingsLogRow[] = []
  /** Managed positions are minted by this engine after this block (plan §12.4), so their whole history is on chain from here. */
  readonly historyFromBlock: bigint
  /** Position history read so far: each review scans only the blocks after it. */
  private readonly historyCursor = historyCursor()
  depositsAfter: bigint
  lastObservation?: Observation
  /** Live: premises the bundler rejected as unincludable, held back until `until` (block timestamp, seconds). */
  private readonly backoff: { premiseHash: string; key: string; until: bigint }[] = []
  /** Block timestamp of the last confirmed re-range, for the policy cooldown. */
  lastRerangeAt: bigint | null = null
  /**
   * Spec 004 (#101) LC-T6: the rolling fallback series `cfg.guardHistory` feeds from each review (per pool),
   * updated after every `observe()`. Read this after a review and persist it (`state.ts`-style, atomic write)
   * so a restart passes `cfg.guardHistory.series` back in instead of starting cold.
   */
  readonly guardSeries = new Map<RegistryName, GuardSeries>()
  private readonly client: PublicClient
  private readonly bundler: BundlerClient
  private readonly nonceKey: bigint

  constructor(
    readonly cfg: EngineConfig,
    private readonly hooks: EngineHooks,
  ) {
    this.client = rpcClient(cfg.rpcUrl)
    this.bundler = new BundlerClient({ url: cfg.bundlerUrl, mode: cfg.mode, chainId: cfg.chainId, signingChainIds: cfg.signingChainIds })
    this.nonceKey = sessionNonceKey(cfg.nonceLane)
    this.depositsAfter = cfg.depositsAfter
    this.historyFromBlock = cfg.historyFromBlock ?? cfg.depositsAfter
    for (const s of cfg.sessions) this.addSession(s)
    for (const u of cfg.priorIncluded ?? []) this.ledger.recordIncluded(u.permissionId, u.calls)
    for (const op of cfg.carried ?? []) if (op.userOpHash && op.nonce !== undefined && op.prepareBlock !== undefined) this.released.push(op)
    for (const [name, series] of cfg.guardHistory?.series ?? []) this.guardSeries.set(name, series)
  }

  /** Live: a session the owner removed on chain (SmartSession) is revoked in the ledger, so decide never proposes an op it cannot authorize. */
  /**
   * The sessions' on-chain state, read with the observation: one isPermissionEnabled per session in its first
   * batch, at its block (the provider's head minus its lag, a few seconds behind `latest`: a permission removed
   * in between is still listed for one review, and its userOp is refused on chain by the SmartSession validator).
   * A session the chain no longer has enabled is revoked in the ledger before the observation lists the sessions.
   */
  private readEnabled(batch: Batch, blockNumber: bigint): (() => Promise<void>) | void {
    if (this.cfg.mode !== 'live') return
    // A provider that is behind the activation does not have the grants yet: every permission would read as
    // not enabled and be revoked here for good. That view is no observation of this account.
    if (blockNumber <= this.historyFromBlock) throw new ReasonError('OBS_BLOCK_INCONSISTENT', `rpc block ${blockNumber} is not past the activation block ${this.historyFromBlock}`)
    // The same for any later point the engine must not look before: the block a renewal enabled the current grants
    // in, or its own last operation. Checked here, before a session is read: a view from before a renewal shows
    // the renewed grants as not enabled, and they would be revoked in the ledger for good.
    const floor = this.observationFloorNow()
    if (blockNumber < floor) throw new ReasonError('EHG_OBSERVATION_STALE', `observed at block ${blockNumber}, not before block ${floor}`)
    const sessions = this.sessions.filter((s) => !this.ledger.get(s.permissionId)?.revoked)
    if (sessions.length === 0) return
    const enabled = sessions.map((s) => batch.add(contractRead(this.client, { address: address('SmartSession'), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [s.permissionId, this.cfg.account], blockNumber })))
    return async () => {
      // Every answer first: a read that fails revokes nothing.
      const answers = await Promise.all(enabled.map((h) => h.need()))
      for (const [i, s] of sessions.entries()) if (!answers[i]) this.ledger.revoke(s.permissionId)
    }
  }

  addSession(s: EngineSession): void {
    this.sessions.push(s)
    this.ledger.activate(s.permissionId, s.grant)
    if (s.grant.tokenId !== undefined && !this.allowedTokenIds.includes(s.grant.tokenId)) this.allowedTokenIds.push(s.grant.tokenId)
  }

  savingsTotal(): bigint {
    return ledgerTotal(this.savingsLog)
  }

  private sessionObs(): SessionObs[] {
    return this.sessions.map((s) => ({
      grant: s.name,
      permissionId: s.permissionId,
      tokenId: s.grant.tokenId,
      validUntil: s.grant.userOp.validUntil,
      active: !this.ledger.get(s.permissionId)?.revoked,
      usesLeft: Math.max(0, s.grant.userOp.usageLimit - this.ledger.usesOf(s.permissionId)),
    }))
  }

  /**
   * Set by whoever restores this engine after a restart: the block of the last operation it ran before. The journal
   * starts empty then, and the first review must not look at the chain from before that operation either.
   */
  minObservationBlock = 0n

  /** The block no observation may be before: the latest of the engine's own operations and what its restorer set. */
  private observationFloorNow(): bigint {
    const inJournal = observationFloor(this.journal.ops)
    return inJournal > this.minObservationBlock ? inJournal : this.minObservationBlock
  }

  async observe(): Promise<Observation> {
    const live = this.journal.live
    const obs = await observe(this.client, {
      chainId: this.cfg.chainId,
      account: this.cfg.account,
      nonceKey: this.nonceKey,
      depositsAfter: this.depositsAfter,
      sessions: () => this.sessionObs(),
      firstBatch: (batch, blockNumber) => this.readEnabled(batch, blockNumber),
      allowedTokenIds: this.allowedTokenIds,
      historyFromBlock: this.historyFromBlock,
      historyCursor: this.historyCursor,
      poolCache: this.cfg.poolCache,
      intents: this.cfg.intents?.() ?? { paused: false, exitRequested: false },
      slot: live ? { opId: live.opId, state: live.state } : null,
      twapWindowSeconds: this.cfg.policy.execution.twapWindowSeconds,
      opGasUnits: OP_GAS_UNITS,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
      savingsAsset: this.cfg.policy.savingsAsset,
      ethPricePool: ETH_PRICE_POOL,
    })
    const gh = this.cfg.guardHistory
    if (!gh || gh.pools.length === 0) return obs
    // Pinned to the same block as the rest of the observation (FR-RPC-001): a second Multicall3 batch, never a second block.
    const targets = gh.pools.map((name) => ({ name, address: entry(name).address }))
    const result = await observeGuardHistory(this.client, MULTICALL3, targets, obs.block.number, Number(obs.block.timestamp), this.cfg.policy.execution.twapWindowSeconds, this.guardSeries)
    this.guardSeries.clear()
    for (const [name, series] of result.series) this.guardSeries.set(name, series)
    return { ...obs, guard: { pools: result.pools } }
  }

  /** One review: observe at a fixed block, decide, and run at most one operation. */
  private pendingRetune: { policy: PolicyVersion; guardHistory: EngineConfig['guardHistory'] } | null = null

  /**
   * Spec 006 (otto/mamoru#147): new engine settings for the next review. Applied at the start of a review, never in
   * the middle of one, so a review decides and executes under one policy. Only the decision side may change (depth
   * sizing, guards): the policy id, buckets and session templates must be the ones the engine started with, since
   * its sessions were granted for them.
   */
  retune(policy: PolicyVersion, guardHistory: EngineConfig['guardHistory']): void {
    const cur = this.cfg.policy
    if (policy.policyId !== cur.policyId || policy.session !== cur.session || policy.buckets !== cur.buckets) throw new Error(`retune: ${policy.policyId} is not a retuning of ${cur.policyId}`)
    this.pendingRetune = { policy, guardHistory }
  }

  async review(): Promise<ReviewResult> {
    if (this.pendingRetune) {
      this.cfg.policy = this.pendingRetune.policy
      this.cfg.guardHistory = this.pendingRetune.guardHistory
      this.pendingRetune = null
    }
    await this.watchReleased()
    await this.resumePending()
    await this.resumeIncluded()
    let obs: Observation
    try {
      obs = await this.observe()
    } catch (e) {
      if (e instanceof ReasonError) return { kind: 'observation-failed', code: e.code, detail: e.detail }
      throw e
    }
    // Never decide on a view older than the engine's own last operation: a provider serving a head behind it shows
    // the account as it was before that operation, and the same step would be proposed again. The reviews used to be
    // minutes apart, which hid this; they can now follow each other in seconds.
    const floor = this.observationFloorNow()
    if (obs.block.number < floor) {
      return { kind: 'observation-failed', code: 'EHG_OBSERVATION_STALE', detail: `observed at block ${obs.block.number}, the last operation is in block ${floor}` }
    }
    obs = { ...obs, lastRerangeAt: this.lastRerangeAt }
    this.lastObservation = obs
    const decision = decide(obs, this.cfg.policy)
    this.depositsAfter = obs.safeBlock.number > this.depositsAfter ? obs.safeBlock.number : this.depositsAfter
    const key = decision.proposal ? proposalKey(decision.proposal) : ''
    const backedOff = !!decision.proposal && this.backoff.some((b) => b.until > obs.block.timestamp && (b.premiseHash === decision.premiseHash || b.key === key))
    const deduped = (!!decision.proposal && this.journal.lastDiscarded()?.premiseHash === decision.premiseHash) || backedOff
    const record = this.journal.recordDecision(decision, deduped ? 'REVIEW_DEDUPED' : undefined)
    if (!decision.proposal || deduped) return { kind: 'decided', observation: obs, record, op: null }
    const op = this.journal.propose(record, decision.proposal.grant)
    // An op settled RECON_UNINCLUDABLE is backed off where it is settled (`settlePending`).
    await this.run(op, obs, decision)
    return { kind: 'decided', observation: obs, record, op }
  }

  private session(name: string): EngineSession | undefined {
    return [...this.sessions].reverse().find((s) => s.name === name)
  }

  private async run(op: OpRecord, obs: Observation, decision: Decision): Promise<void> {
    const j = this.journal
    const proposal = decision.proposal!
    const session = this.session(proposal.grant)
    if (!session) return void j.move(op.opId, 'discarded', 'SESSION_MISSING')
    if (proposal.kind === 'enter_mint' && this.hooks.mintAllowed && !this.hooks.mintAllowed()) return void j.move(op.opId, 'discarded', 'INVENTORY_FULL')

    // prepare: fresh block, quotes, calls, pre-check and the unsigned userOp.
    const block = await this.client.getBlock({ blockTag: 'latest' })
    let prepared: Prepared
    try {
      prepared = await this.prepareCalls(proposal, block.number, block.timestamp, session)
    } catch (e) {
      if (e instanceof ReasonError) return void j.move(op.opId, 'discarded', e.code, {}, e.detail)
      throw e
    }
    const callData = executeCallData(prepared.calls)
    const pre = precheck(
      { sender: this.cfg.account, callData, signature: useModeSignature(session.permissionId, '0x') },
      { chainId: this.cfg.chainId, now: Number(block.timestamp), ledger: this.ledger },
    )
    if (!pre.ok && pre.code.startsWith('SESSION_')) return void j.move(op.opId, 'discarded', pre.code, {}, pre.detail)
    const nonce = await this.entryPointNonce(block.number)
    const baseFee = block.baseFeePerGas ?? 0n
    const gas: GasSettings = { ...LAB_GAS_LIMITS, maxFeePerGas: baseFee * 2n + MAX_PRIORITY_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS }
    const userOp = draftUserOp(this.cfg.account, nonce, callData, gas)
    j.move(op.opId, 'prepared', 'EHG_OK', {
      prepareBlock: block.number,
      permissionId: session.permissionId,
      calls: prepared.calls,
      callData,
      quote: prepared.quote,
      expiresAt: prepared.expiresAt,
      precheck: pre.ok ? 'SESSION_ACTIVE' : pre.code,
      nonceKey: this.nonceKey,
      nonce,
      userOp,
      ehg: [{ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' }],
    })
    if (!pre.ok) return void j.move(op.opId, 'discarded', pre.code, {}, pre.detail)

    // simulate: eth_simulateV1 from the EntryPoint, deltas against the intent.
    let sim: Simulation
    try {
      sim = await simulateFromEntryPoint(this.client, this.cfg.account, callData, block.number)
    } catch (e) {
      if (e instanceof ReasonError) return void j.move(op.opId, 'discarded', e.code, {}, e.detail)
      throw e
    }
    if (!sim.ok) return void j.move(op.opId, 'discarded', 'EHG_SIM_REVERT', { simulation: sim }, sim.revert)
    const mismatch = this.deltaMismatch(proposal, prepared, sim)
    if (mismatch) return void j.move(op.opId, 'discarded', 'EHG_SIM_DELTA_MISMATCH', { simulation: sim }, mismatch)
    j.move(op.opId, 'simulated', 'EHG_OK', { simulation: sim, ehg: [...op.ehg, { gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' }] })
    if (proposal.kind === 'harvest' && !this.harvestCollectsFees(proposal, prepared, sim)) {
      return void j.move(op.opId, 'discarded', 'OP_DECISION_STALE', {}, 'the harvest no longer collects any fees')
    }

    // sign: nonce, userOp, hash and signature in one step, only from `simulated`.
    const now = await this.client.getBlock({ blockTag: 'latest' })
    const premise = await this.client.getBlock({ blockNumber: obs.block.number })
    const blocker = signBlocker({
      mode: this.cfg.mode,
      chainId: this.cfg.chainId,
      signingChainIds: this.cfg.signingChainIds,
      observationAgeSeconds: Number(now.timestamp - obs.block.timestamp),
      observationTtlSeconds: this.cfg.policy.execution.observationTtlSeconds,
      observationCanonical: premise.hash === obs.block.hash,
      preparedNonce: nonce,
      chainNonce: await this.entryPointNonce(now.number),
    })
    if (blocker) return void j.move(op.opId, 'discarded', blocker)
    const signed = await signSessionUserOp(userOp, this.cfg.chainId, session.permissionId, this.cfg.sessionKey)
    const hash = userOpHash(userOp, this.cfg.chainId)
    j.move(op.opId, 'signed', 'OP_SIGNED', { userOp: signed, userOpHash: hash })

    // send: the same bytes to a standard ERC-4337 endpoint.
    try {
      const accepted = await this.bundler.sendUserOperation(signed)
      if (accepted.toLowerCase() !== hash.toLowerCase()) throw new Error(`bundler answered hash ${accepted}, journal has ${hash}`)
    } catch (e) {
      if (e instanceof BundlerRpcError) {
        j.move(op.opId, 'pending_reconciliation', 'BUNDLER_REJECTED', {}, e.message)
        // Live (otto/mamoru#140): a rejection is not a cancellation. The signed bytes may still land while the nonce is
        // unused; the op is settled from the chain (nonce, expiry, permission) now and at every later review.
        if (this.cfg.mode === 'live') await this.settlePending(this.journal.op(op.opId))
        return
      }
      if (e instanceof ReasonError && e.code === 'BUNDLER_UNAVAILABLE') return void j.move(op.opId, 'pending_reconciliation', 'BUNDLER_UNAVAILABLE', {}, e.detail)
      throw e
    }
    j.move(op.opId, 'submitted', 'BUNDLER_ACCEPTED')

    // await: the RPC's UserOperationEvent is the proof; the bundler receipt is checked against it.
    let ev = null
    const maxWait = this.cfg.maxWaitBlocks ?? MAX_WAIT_BLOCKS
    for (let i = 0; i < maxWait && !ev; i++) {
      ev = await readUserOpEvent(this.client, hash, block.number)
      if (!ev) await this.hooks.waitBlock()
    }
    if (!ev) return void j.move(op.opId, 'pending_reconciliation', 'RECON_TIMEOUT')
    // The RPC event stays the authority; the bundler receipt is reconciled against it and the journal, and any conflict is kept.
    const receipt = await this.bundler.getUserOperationReceipt(hash)
    const receiptCheck = reconcileReceipt({ userOpHash: hash, sender: this.cfg.account, nonce }, ev, receipt)
    if (ev.sender.toLowerCase() !== this.cfg.account.toLowerCase() || ev.nonce !== nonce) throw new Error(`${op.opId}: UserOperationEvent of ${ev.sender} nonce ${ev.nonce} for our hash`)
    j.move(
      op.opId,
      'included',
      'OP_INCLUDED',
      {
        included: { blockNumber: ev.blockNumber, blockHash: ev.blockHash, txHash: ev.txHash, success: ev.success, actualGasCost: ev.actualGasCost },
        bundlerReceipt: receipt ?? undefined,
        receiptCheck,
      },
      receiptCheck.status === 'match' ? undefined : `bundler receipt ${receiptCheck.status}${receiptCheck.status === 'mismatch' ? `: ${receiptCheck.fields.join(', ')}` : ''}; RPC event kept`,
    )

    // confirm: only in a block at or below `safe` whose hash is still canonical (FR-ENG-008).
    for (let i = 0; i < maxWait; i++) {
      const s = await isSafeAndCanonical(this.client, ev.blockNumber, ev.blockHash)
      if (!s.canonical) return void j.move(op.opId, 'pending_reconciliation', 'RECON_REORGED')
      if (s.safe) {
        if (!ev.success) return void j.move(op.opId, 'failed', 'EXEC_INNER_REVERT', { confirmedSafeBlock: s.safeBlock })
        j.move(op.opId, 'confirmed', 'EXEC_OK', { confirmedSafeBlock: s.safeBlock })
        await this.afterConfirmed(op, proposal, pre.calls, ev.logs)
        return
      }
      await this.hooks.waitBlock()
    }
    // Still above `safe`: stays `included`; the next review holds on the busy slot.
  }

  /** A live op left `pending_reconciliation` with signed bytes: settled from the chain when it can be (`settleUnincluded`). */
  private async resumePending(): Promise<void> {
    const op = this.journal.live
    // RECON_REORGED too: an op whose block was reorged out is looked for again, like any other (Sol review of #64).
    if (this.cfg.mode !== 'live' || !op || op.state !== 'pending_reconciliation') return
    await this.settlePending(op)
  }

  private async settlePending(op: OpRecord): Promise<void> {
    if (!op.userOpHash || op.nonce === undefined || !op.permissionId || op.prepareBlock === undefined) return
    const safe = await this.client.getBlock({ blockTag: 'safe' })
    const [nonceAtSafe, permissionEnabledAtSafe, ev] = await Promise.all([
      this.entryPointNonce(safe.number),
      this.client.readContract({ address: address('SmartSession'), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [op.permissionId, this.cfg.account], blockNumber: safe.number }),
      readUserOpEvent(this.client, op.userOpHash, op.prepareBlock),
    ])
    const verdict = settleUnincluded({
      opNonce: op.nonce,
      nonceAtSafe,
      eventFound: !!ev,
      safeTimestamp: safe.timestamp,
      expiresAt: op.expiresAt ?? null,
      permissionEnabledAtSafe,
      rejected: op.stateCode === 'BUNDLER_REJECTED',
    })
    if (!verdict) return
    if (verdict.to === 'included') {
      if (ev!.sender.toLowerCase() !== this.cfg.account.toLowerCase() || ev!.nonce !== op.nonce) throw new Error(`${op.opId}: UserOperationEvent of ${ev!.sender} nonce ${ev!.nonce} for our hash`)
      return void this.journal.move(op.opId, 'included', 'OP_INCLUDED', { included: { blockNumber: ev!.blockNumber, blockHash: ev!.blockHash, txHash: ev!.txHash, success: ev!.success, actualGasCost: ev!.actualGasCost } }, 'found on chain after the bundler did not report it')
    }
    this.journal.move(op.opId, 'failed', verdict.code, {}, verdict.detail)
    if (verdict.code === 'RECON_UNINCLUDABLE') {
      this.backoff.push({ premiseHash: op.premiseHash, key: proposalKey(op.intent), until: safe.timestamp + UNINCLUDABLE_BACKOFF_SECONDS })
      // Its bytes can still be included (past the expiry they revert, but they spend the nonce): watched until then.
      this.released.push(op)
    }
  }

  /**
   * otto/mamoru#140 (Sol review of #64): ops freed as RECON_UNINCLUDABLE whose signed bytes may still be included. Past
   * its expiry a swap, mint or decrease reverts inside the batch, but the userOp still validates, spends the nonce and
   * counts against the session's usage; a collect-only op still collects. The next op signed on that nonce then sees it
   * spent by another (RECON_NONCE_CONSUMED_BY_OTHER, handled). This keeps the account's own books right: once such an
   * op lands at a safe, canonical block it is recorded on its op (`lateIncluded`), its uses go into the ledger and, if
   * it executed, its effects (a harvest's savings row, a burn) are applied. An op is dropped from here once the nonce
   * at `safe` is past its own without its event: it can never land.
   */
  private readonly released: OpRecord[] = []

  /**
   * What the account must keep watching past this engine (a restart, a renewal): every released op, and the live op
   * when it waits in pending_reconciliation with signed bytes (a bundler rejection, a reorg). The operator stores
   * these and hands them to the next engine (`carried`).
   */
  carried(): OpRecord[] {
    const live = this.journal.live
    const pending = live && live.state === 'pending_reconciliation' && live.userOpHash && live.nonce !== undefined && live.prepareBlock !== undefined ? [live] : []
    return [...this.released, ...pending.filter((o) => !this.released.includes(o))]
  }

  private async watchReleased(): Promise<void> {
    if (!this.released.length) return
    const safe = await this.client.getBlock({ blockTag: 'safe' })
    const nonceAtSafe = await this.entryPointNonce(safe.number)
    for (const op of [...this.released]) {
      const ev = await readUserOpEvent(this.client, op.userOpHash!, op.prepareBlock!)
      if (!ev) {
        if (nonceAtSafe !== op.nonce) {
          this.released.splice(this.released.indexOf(op), 1)
          // The operator's stored copy goes too.
          try {
            this.journal.onMove?.(op)
          } catch {
            // dropped here all the same
          }
        }
        continue
      }
      if (ev.sender.toLowerCase() !== this.cfg.account.toLowerCase() || ev.nonce !== op.nonce) throw new Error(`${op.opId}: UserOperationEvent of ${ev.sender} nonce ${ev.nonce} for our hash`)
      const s = await isSafeAndCanonical(this.client, ev.blockNumber, ev.blockHash)
      if (!s.canonical || !s.safe) continue
      // Sol review round 3 of #64: the op stays watched until its effects are applied and the operator has stored it.
      // Effects that throw (an RPC read inside afterConfirmed) leave it here for the next tick; applied once
      // (`lateApplied`), they are not applied again when only the store failed.
      if (!op.lateApplied) {
        op.included = { blockNumber: ev.blockNumber, blockHash: ev.blockHash, txHash: ev.txHash, success: ev.success, actualGasCost: ev.actualGasCost }
        op.confirmedSafeBlock = s.safeBlock
        if (ev.success) await this.afterConfirmed(op, op.intent, op.calls ?? [], ev.logs)
        else this.recordUse(op, op.calls ?? [])
        op.lateIncluded = true
        op.lateApplied = true
      }
      this.released.splice(this.released.indexOf(op), 1)
      try {
        this.journal.onMove?.(op)
      } catch {
        // Not stored: watched again, so the next tick stores it (its effects are not applied twice).
        this.released.push(op)
      }
    }
  }

  /** An op left `included` when the wait ran out (slow `safe` head): confirm it once `safe` reaches its block. */
  private async resumeIncluded(): Promise<void> {
    const op = this.journal.live
    if (!op || op.state !== 'included' || !op.included || !op.userOpHash) return
    const s = await isSafeAndCanonical(this.client, op.included.blockNumber, op.included.blockHash)
    if (!s.canonical) return void this.journal.move(op.opId, 'pending_reconciliation', 'RECON_REORGED')
    if (!s.safe) return
    if (!op.included.success) return void this.journal.move(op.opId, 'failed', 'EXEC_INNER_REVERT', { confirmedSafeBlock: s.safeBlock })
    const ev = await readUserOpEvent(this.client, op.userOpHash, op.included.blockNumber)
    if (!ev) return
    this.journal.move(op.opId, 'confirmed', 'EXEC_OK', { confirmedSafeBlock: s.safeBlock })
    await this.afterConfirmed(op, op.intent, op.calls ?? [], ev.logs)
  }

  private async afterConfirmed(op: OpRecord, proposal: Proposal, calls: Execution[], logs: Log[]): Promise<void> {
    // Once per op: a late landing whose later effects failed (a history read) is retried, its use is not counted again
    // (Sol review round 4 of #64).
    this.recordUse(op, calls)
    if (proposal.kind === 'enter_mint') {
      const minted = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs, eventName: 'Transfer' }).find(
        (l) => isAddressEqual(l.address, address('NonfungiblePositionManager')) && isAddressEqual(l.args.to, this.cfg.account),
      )
      if (!minted) throw new Error(`${op.opId}: confirmed mint without a position transfer to the account`)
      op.mintedTokenId = minted.args.tokenId
      if (!this.allowedTokenIds.includes(minted.args.tokenId)) this.allowedTokenIds.push(minted.args.tokenId)
      this.hooks.onMinted?.(minted.args.tokenId, op.included?.blockNumber)
      if (!hasManageAny(this.cfg.policy)) {
        if (!this.hooks.requestManageGrant) throw new Error(`${op.opId}: policy ${this.cfg.policy.policyId} needs a manage grant per position`)
        this.addSession(await this.hooks.requestManageGrant(minted.args.tokenId, proposal.pool))
      }
    }
    if (proposal.kind === 'rerange') {
      const inc = op.included!
      this.lastRerangeAt = (await this.client.getBlock({ blockNumber: inc.blockNumber })).timestamp
      const i = this.allowedTokenIds.indexOf(proposal.tokenId)
      if (i >= 0) this.allowedTokenIds.splice(i, 1)
    }
    if (proposal.kind === 'harvest') {
      const inc = op.included!
      const pool = entry(proposal.pool)
      const collect = positionEvents(logs).find((e) => e.kind === 'collect' && e.tokenId === proposal.tokenId)
      if (!collect) throw new Error(`${op.opId}: confirmed harvest without a Collect of ${proposal.tokenId}`)
      // FR-PRJ-003: the principal owed right before this Collect, folded from the canonical history, owner actions included.
      const owed = await principalOwedBefore(this.client, [proposal.tokenId], this.historyFromBlock, { block: inc.blockNumber, logIndex: collect.logIndex })
      this.savingsLog.push(
        harvestRow({
          opId: op.opId,
          tokenId: proposal.tokenId,
          chainId: this.cfg.chainId,
          block: inc.blockNumber,
          blockHash: inc.blockHash,
          txHash: inc.txHash,
          at: new Date(Number((await this.client.getBlock({ blockNumber: inc.blockNumber })).timestamp) * 1000).toISOString(),
          logs,
          account: this.cfg.account,
          pool: pool.address,
          pendingBefore: owed.get(proposal.tokenId) ?? [0n, 0n],
          savingsIsToken0: pool.token0 === this.cfg.policy.savingsAsset,
          // otto/mamoru#140: a harvest only collects; the volatile fees stay in the account.
          converted: false,
        }),
      )
    }
  }

  /** The op's session use, into the ledger once (`useRecorded`). */
  private recordUse(op: OpRecord, calls: Execution[]): void {
    if (op.useRecorded) return
    this.ledger.recordIncluded(op.permissionId!, calls)
    op.useRecorded = true
  }

  private async entryPointNonce(blockNumber: bigint): Promise<bigint> {
    return this.client.readContract({
      address: address('EntryPointV07'),
      abi: entryPointV07Abi,
      functionName: 'getNonce',
      args: [this.cfg.account, this.nonceKey],
      blockNumber,
    })
  }

  /**
   * otto/mamoru#140. `decide` checked spot against the TWAP at the observation block; the calls are priced at a later
   * block, where a swap in that block could have moved slot0 and QuoterV2. The same check runs again here, at the
   * prepare block, for every operation that prices a pool. Returns the TWAP tick.
   */
  private async priceGuard(pool: string, blockNumber: bigint): Promise<number> {
    const e = entry(pool)
    const { twapWindowSeconds, maxTwapDeviationTicks } = this.cfg.policy.execution
    const [[, tick], twap] = await Promise.all([
      this.client.readContract({ address: e.address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber }),
      twapTickAt(this.client, e.address, twapWindowSeconds, blockNumber),
    ])
    if (diverges(tick, twap, maxTwapDeviationTicks)) throw new ReasonError('EHG_PRICE_DIVERGENCE', `${pool}: tick ${tick} at block ${blockNumber}, TWAP ${twap}`)
    return twap
  }

  /**
   * The router minimum of an engine swap, judged at the pool's TWAP and never at its spot: slot0 and a quote at the
   * block we read can both be moved by a swap in that same block, and the grant only asks amountOutMinimum > 0.
   * - otto/mamoru#140: never under what the input buys at the TWAP moved `maxTwapDeviationTicks` against the swap,
   *   less the tolerance (slippage, or the impact budget with depth sizing on); a quote under it is refused
   *   (EHG_PRICE_DIVERGENCE).
   * - otto/mamoru#127, depth sizing on: the quote (which crosses ticks) must be within `maxImpactBps` of what the
   *   input buys at the TWAP itself, the pool fee aside (EHG_SWAP_IMPACT_OVER_LIMIT).
   * The minimum is the largest of the usual slippage minimum on the quote and both floors.
   */
  private async swapMin(p: { pool: string; tokenIn: string; fee: number; amountIn: bigint }, amountOut: bigint, blockNumber: bigint): Promise<bigint> {
    const e = entry(p.pool)
    const { slippageBps, maxTwapDeviationTicks } = this.cfg.policy.execution
    const depth = this.cfg.policy.depth
    const impactBps = depth ? (depth.maxImpactBpsByPool?.[p.pool] ?? depth.maxImpactBps) : null
    const tokenInIsToken0 = e.token0 === p.tokenIn
    const twapTick = await this.priceGuard(p.pool, blockNumber)
    const tolerance = impactBps !== null && impactBps > slippageBps ? impactBps : slippageBps
    const floor = deviationFloor({ amountIn: p.amountIn, fee: p.fee, twapTick, tokenInIsToken0, deviationTicks: maxTwapDeviationTicks, slippageBps: tolerance })
    const impactFloor = impactBps !== null ? twapFloor(p.amountIn, p.fee, twapTick, tokenInIsToken0, impactBps) : 0n
    if (amountOut < impactFloor) throw new ReasonError('EHG_SWAP_IMPACT_OVER_LIMIT', `${p.pool}: quote ${amountOut} for ${p.amountIn}, under ${impactFloor} (TWAP tick ${twapTick}, ${impactBps} bps)`)
    const min = swapMinimum(amountOut, slippageBps, floor)
    if (min === null) throw new ReasonError('EHG_PRICE_DIVERGENCE', `${p.pool}: quote ${amountOut} for ${p.amountIn} ${p.tokenIn}, under the TWAP floor ${floor} (tick ${twapTick})`)
    return impactFloor > min ? impactFloor : min
  }

  /**
   * otto/mamoru#140: the on-chain expiry of a swap batch. With the deadline action in the session grant, the batch
   * carries SwapRouter02.multicall(deadline, []) and cannot execute after `deadline`. A grant from before has no
   * such action: the only on-chain bound is then the session's own validUntil (TimeFramePolicy), until the owner
   * renews to grants that have it.
   */
  private swapExpiry(session: EngineSession, deadline: bigint): { calls: V3Call[]; expiresAt: bigint } {
    if (grantHasSwapDeadline(session.grant)) return { calls: [deadlineCheck(deadline)], expiresAt: deadline }
    // validUntil 0 is no bound at all (ERC-4337 validationData): nothing settles the op but its nonce then.
    const until = session.grant.userOp.validUntil
    return { calls: [], expiresAt: until > 0 ? BigInt(until) : 2n ** 64n }
  }

  /** FR-UNI-001 to FR-UNI-006: calls from fresh quotes, exact approvals, nothing left approved. */
  private async prepareCalls(p: Proposal, blockNumber: bigint, timestamp: bigint, session: EngineSession): Promise<Prepared> {
    const acct = this.cfg.account
    const slippage = this.cfg.policy.execution.slippageBps
    // Every priced call of the batch expires on chain at the same time (NonfungiblePositionManager and SwapRouter02).
    const deadline = timestamp + BigInt(this.cfg.policy.execution.observationTtlSeconds)
    if (p.kind === 'enter_swap') {
      const amountOut = await quoteExactInputSingle(this.client, { tokenIn: address(p.tokenIn), tokenOut: address(p.tokenOut), fee: p.fee, amountIn: p.amountIn, blockNumber })
      const amountOutMinimum = await this.swapMin(p, amountOut, blockNumber)
      const expiry = this.swapExpiry(session, deadline)
      return {
        quote: { amountIn: p.amountIn, amountOut, amountOutMinimum },
        calls: [...expiry.calls, approve(p.tokenIn, 'SwapRouter02', p.amountIn), exactInputSingle({ account: acct, tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, amountIn: p.amountIn, amountOutMinimum })].map(exec),
        expiresAt: expiry.expiresAt,
      }
    }
    if (p.kind === 'enter_mint') {
      await this.priceGuard(p.pool, blockNumber)
      const pool = entry(p.pool)
      const [sqrtPriceX96] = await this.client.readContract({ address: pool.address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber })
      const q = quoteMint({ sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps: slippage })
      return {
        expiresAt: deadline,
        calls: [
          approve(pool.token0!, 'NonfungiblePositionManager', p.amount0Desired),
          approve(pool.token1!, 'NonfungiblePositionManager', p.amount1Desired),
          mint({ account: acct, pool: p.pool, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, amount0Min: q.amount0Min, amount1Min: q.amount1Min, deadline }),
          approve(pool.token0!, 'NonfungiblePositionManager', 0n),
          approve(pool.token1!, 'NonfungiblePositionManager', 0n),
        ].map(exec),
      }
    }
    if (p.kind === 'rerange' || p.kind === 'reduce') {
      // decreaseLiquidity(all or part) + collect(to the Safe) [+ burn]: nothing leaves the account.
      await this.priceGuard(p.pool, blockNumber)
      const [pos, [sqrtPriceX96]] = await Promise.all([
        this.client.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [p.tokenId], blockNumber }),
        this.client.readContract({ address: entry(p.pool).address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber }),
      ])
      const liquidity = p.kind === 'rerange' ? pos[7] : p.liquidity < pos[7] ? p.liquidity : pos[7]
      const calls: V3Call[] = []
      if (liquidity > 0n) {
        const a = amountsOf(sqrtPriceX96, pos[5], pos[6], liquidity)
        calls.push(decreaseLiquidity({ tokenId: p.tokenId, liquidity, amount0Min: a.amount0 > 0n ? minOut(a.amount0, slippage) : 0n, amount1Min: a.amount1 > 0n ? minOut(a.amount1, slippage) : 0n, deadline }))
      }
      calls.push(collect({ account: acct, tokenId: p.tokenId }))
      if (p.kind === 'rerange') calls.push(burn(p.tokenId))
      // Without a decrease the batch prices nothing (collect and burn to the account): late, it is harmless.
      return { calls: calls.map(exec), expiresAt: liquidity > 0n ? deadline : null }
    }
    // otto/mamoru#140: a harvest only collects, to the account. A conversion in the same batch swapped a fixed amount
    // checked against the simulated Collect only: if the fees were collected elsewhere before inclusion, it swapped
    // idle principal instead. The volatile fees stay in the account, where a later idle sell-back (priced at the
    // TWAP, on the balance the chain shows then) or an entry uses them.
    if (p.convert) throw new ReasonError('EHG_SIM_DELTA_MISMATCH', `harvest of ${p.tokenId} asks to convert ${p.convert.amount} ${p.convert.token}: harvests only collect`)
    const owedAt = await principalOwedBefore(this.client, [p.tokenId], this.historyFromBlock, { block: blockNumber + 1n, logIndex: 0 })
    const owed = owedAt.get(p.tokenId) ?? [0n, 0n]
    return { calls: [collect({ account: acct, tokenId: p.tokenId })].map(exec), owed, expiresAt: null }
  }

  /** The harvest's simulated Collect pays more than the principal owed on at least one side. */
  private harvestCollectsFees(p: Extract<Proposal, { kind: 'harvest' }>, prepared: Prepared, sim: Simulation): boolean {
    const c = positionEvents(sim.logs).find((e) => e.kind === 'collect' && e.tokenId === p.tokenId)
    if (!c) return false
    const [owed0, owed1] = prepared.owed ?? [0n, 0n]
    return c.amount0 > owed0 || c.amount1 > owed1
  }

  /** FR-RPC-002: the simulated deltas must be the ones the intent expects. Returns why not, or null. */
  private deltaMismatch(p: Proposal, prepared: Prepared, sim: Simulation): string | null {
    const d = (t: string) => sim.deltas[t] ?? 0n
    if (p.kind === 'enter_swap') {
      if (d(p.tokenIn) !== -p.amountIn) return `${p.tokenIn} moved ${d(p.tokenIn)}, intent ${-p.amountIn}`
      if (d(p.tokenOut) < prepared.quote!.amountOutMinimum) return `${p.tokenOut} rose ${d(p.tokenOut)}, below the minimum`
      return null
    }
    if (p.kind === 'enter_mint') {
      const pool = entry(p.pool)
      if (sim.nftDelta !== 1n) return `positions changed by ${sim.nftDelta}`
      if (d(pool.token0!) > 0n || -d(pool.token0!) > p.amount0Desired) return `${pool.token0} moved ${d(pool.token0!)}`
      if (d(pool.token1!) > 0n || -d(pool.token1!) > p.amount1Desired) return `${pool.token1} moved ${d(pool.token1!)}`
      return null
    }
    if (p.kind === 'rerange' || p.kind === 'reduce') {
      const want = p.kind === 'rerange' ? -1n : 0n
      if (sim.nftDelta !== want) return `positions changed by ${sim.nftDelta}, intent ${want}`
      const pool = entry(p.pool)
      if (d(pool.token0!) < 0n || d(pool.token1!) < 0n) return `${pool.token0} moved ${d(pool.token0!)}, ${pool.token1} moved ${d(pool.token1!)}: a ${p.kind} only returns tokens to the account`
      return null
    }
    if (sim.nftDelta !== 0n) return `positions changed by ${sim.nftDelta}`
    // FR-UNI-005, otto/mamoru#140: a harvest only collects to the account; nothing else moves.
    const pool = entry(p.pool)
    const collects = positionEvents(sim.logs).filter((e) => e.kind === 'collect' && e.tokenId === p.tokenId)
    if (collects.length !== 1) return `${collects.length} Collect events for ${p.tokenId}`
    const c = collects[0]!
    if (d(pool.token0!) !== c.amount0) return `${pool.token0} moved ${d(pool.token0!)}, the Collect paid ${c.amount0}`
    if (d(pool.token1!) !== c.amount1) return `${pool.token1} moved ${d(pool.token1!)}, the Collect paid ${c.amount1}`
    for (const [t, v] of Object.entries(sim.deltas)) if (t !== pool.token0 && t !== pool.token1 && v !== 0n) return `${t} moved ${v} in a harvest`
    return null
  }
}
