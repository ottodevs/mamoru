import { encodeFunctionData, isAddressEqual, parseAbi, parseEventLogs, type Hex, type Log, type PublicClient } from 'viem'
import type { LocalAccount } from 'viem/accounts'
import { ReasonError, type Address, type ReasonCode } from '@mamoru/domain'
import { amountsOf, decide, twapFloor, type Decision, type Observation, type Proposal, type SessionObs } from '@mamoru/decide'
import { signBlocker } from '@mamoru/journal'
import { hasManageAny, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { address, entry, entryPointV07Abi, erc20Abi, nonfungiblePositionManagerAbi, smartSessionAbi, uniswapV3PoolAbi, type RegistryName } from '@mamoru/registry'
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
import { SessionLedger, precheck, type ActionPolicyPoolConfig } from '@mamoru/account/precheck'
import { draftUserOp, executeCallData, sessionNonceKey, signSessionUserOp, useModeSignature, userOpHash, type GasSettings } from '@mamoru/account/sessions'
import type { Execution } from '@mamoru/account/safe'
import { approve, burn, collect, decreaseLiquidity, exactInputSingle, mint, type V3Call } from '@mamoru/uniswap-v3'
import { minOut, quoteExactInputSingle, quoteMint } from '@mamoru/uniswap-v3/quote'
import { DEFAULT_BAND_FACTOR_BPS, decreaseMinsAtBand, swapBoundsAtBand } from '@mamoru/uniswap-v3/policy-bounds'
import { harvestRow, ledgerTotal, positionEvents, type Pair, type SavingsLogRow } from '@mamoru/projector'
import { MemoryJournal, type DecisionRecord, type OpRecord } from './journal.ts'

const observeAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])
/** Spec 007 (#151) T4: the two MamoruActionPolicy views precheck's mirror needs that are not already read for T3's
 * bounds (`swapBounds`/`decreaseMins`, which the engine never calls directly — see `@mamoru/uniswap-v3/policy-bounds`'s
 * TS port). `spendOf` returns the `Spend` struct as one named tuple, same pattern as `findModule` elsewhere in this
 * codebase (`packages/scenarios/action-policy/v4-grant.ts`). */
const mamoruActionPolicyReadAbi = parseAbi([
  'struct Spend { uint64 epoch; uint64 generation; uint128 window0; uint128 window1; uint128 total0; uint128 total1; }',
  'function spendOf(address account, address pool) view returns (Spend)',
  'function generationOf(address account) view returns (uint64)',
])
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
}

export type EngineHooks = {
  /** Lets one block pass on the fork. The engine itself never calls anvil methods. */
  waitBlock: () => Promise<void>
  /**
   * The owner activates `manage:<tokenId>` for a position that enter-mint minted (plan §12.4).
   * Not called under a policy with the live `manage-any` grants, enabled at activation.
   */
  requestManageGrant?: (tokenId: bigint, pool: string) => Promise<EngineSession>
}

/** The block of the latest operation that reached the chain: no review may observe before it. */
export function observationFloor(ops: readonly Pick<OpRecord, 'included'>[]): bigint {
  return ops.reduce((floor, o) => (o.included && o.included.blockNumber > floor ? o.included.blockNumber : floor), 0n)
}

export type ReviewResult =
  | { kind: 'observation-failed'; code: ReasonCode; detail?: string }
  | { kind: 'decided'; observation: Observation; record: DecisionRecord; op: OpRecord | null }

type Prepared = { calls: Execution[]; quote?: OpRecord['quote']; /** Harvest: principal owed for the tokenId at the prepare block. */ owed?: Pair }

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
      intents: { paused: false, exitRequested: false },
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
    await this.run(op, obs, decision)
    if (this.journal.op(op.opId)?.stateCode === 'RECON_UNINCLUDABLE') {
      this.backoff.push({ premiseHash: decision.premiseHash, key, until: obs.block.timestamp + UNINCLUDABLE_BACKOFF_SECONDS })
    }
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

    // prepare: fresh block, quotes, calls, pre-check and the unsigned userOp.
    const block = await this.client.getBlock({ blockTag: 'latest' })
    let prepared: Prepared
    try {
      prepared = await this.prepareCalls(proposal, block.number, block.timestamp)
    } catch (e) {
      if (e instanceof ReasonError) return void j.move(op.opId, 'discarded', e.code, {}, e.detail)
      throw e
    }
    const callData = executeCallData(prepared.calls)
    await this.syncActionPolicyLedger(proposal.pool, block.number)
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
    if (proposal.kind === 'harvest' && (sim.deltas[this.cfg.policy.savingsAsset] ?? 0n) <= 0n) {
      return void j.move(op.opId, 'discarded', 'OP_DECISION_STALE', {}, 'the harvest no longer collects anything')
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
        // Live: a userOp the bundler never accepted, with the nonce unmoved, cannot land; free the slot so the next review retries.
        if (this.cfg.mode === 'live' && (await this.entryPointNonce(await this.client.getBlockNumber())) === nonce) {
          j.move(op.opId, 'failed', 'RECON_UNINCLUDABLE', {}, `bundler rejected (${e.message}); nonce ${nonce} unmoved`)
        }
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
    this.ledger.recordIncluded(op.permissionId!, calls)
    if (proposal.kind === 'enter_mint') {
      const minted = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs, eventName: 'Transfer' }).find(
        (l) => isAddressEqual(l.address, address('NonfungiblePositionManager')) && isAddressEqual(l.args.to, this.cfg.account),
      )
      if (!minted) throw new Error(`${op.opId}: confirmed mint without a position transfer to the account`)
      op.mintedTokenId = minted.args.tokenId
      if (!this.allowedTokenIds.includes(minted.args.tokenId)) this.allowedTokenIds.push(minted.args.tokenId)
      // Spec 007 (#151) T4: a tokenId minted under a pool MamoruActionPolicy covers went through the policy's own
      // `mint` (T3's `prepareCalls`), which is exactly what `admittedPool` on chain records — mirror it here so a
      // later decrease/collect/burn of this tokenId passes precheck's admission check.
      if (this.actionPolicyConfigFor(proposal.pool)) this.ledger.admitTokenId(minted.args.tokenId, proposal.pool)
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
          converted: proposal.convert !== null,
        }),
      )
    }
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
   * The pool's TWAP tick at `blockNumber` (`OracleLibrary.consult`'s own rounding: floor, including for a negative
   * delta — the same formula `MamoruActionPolicy._twapTick` uses on chain). One `observe` eth_call, shared by depth
   * sizing (`depthFloor`) and a v4 policy's own band math (`swapBoundsAtBand`/`decreaseMinsAtBand`) for the same
   * pool, so a swap under both needs only one read (spec 007 T3: "no extra RPC per op if avoidable").
   */
  private async poolTwapTick(pool: RegistryName, windowSeconds: number, blockNumber: bigint): Promise<number> {
    try {
      const [cumulatives] = await this.client.readContract({ address: entry(pool).address as Address, abi: observeAbi, functionName: 'observe', args: [[windowSeconds, 0]], blockNumber })
      const delta = cumulatives[1]! - cumulatives[0]!
      let t = delta / BigInt(windowSeconds)
      if (delta < 0n && delta % BigInt(windowSeconds) !== 0n) t -= 1n
      return Number(t)
    } catch {
      throw new ReasonError('EHG_TWAP_UNAVAILABLE', `${pool}: observe(${windowSeconds}) did not answer at ${blockNumber}`)
    }
  }

  /**
   * otto/mamoru#127, with depth sizing on. Slot0 and a quote at the block we read can both be moved by a swap in that
   * same block, so the entry swap is judged against the pool's TWAP, never against its spot:
   * - the quote (which crosses ticks) must be within `maxImpactBps` of what the input buys at the TWAP, the pool fee
   *   aside; otherwise it is refused before anything is sent (EHG_SWAP_IMPACT_OVER_LIMIT);
   * - the router minimum is the larger of the usual slippage minimum on the quote and that TWAP bound, so whatever
   *   happens to the price before inclusion, the swap never executes worse than the limit against the TWAP.
   * `tick`: the pool's TWAP at the review block, already read once by the caller (`poolTwapTick`). Returns the
   * minimum out to use, or null when depth sizing is off (the usual minimum applies).
   */
  private depthFloor(p: Extract<Proposal, { kind: 'enter_swap' }>, amountOut: bigint, tick: number): bigint | null {
    const depth = this.cfg.policy.depth
    if (!depth) return null
    const pool = entry(p.pool)
    const limit = depth.maxImpactBpsByPool?.[p.pool] ?? depth.maxImpactBps
    const floor = twapFloor(p.amountIn, p.fee, tick, pool.token0 === p.tokenIn, limit)
    if (amountOut < floor) throw new ReasonError('EHG_SWAP_IMPACT_OVER_LIMIT', `${p.pool}: quote ${amountOut} for ${p.amountIn}, under ${floor} (TWAP tick ${tick}, ${limit} bps)`)
    return floor
  }

  /**
   * Spec 007 (#151) T3: when the engine's policy carries a deployed MamoruActionPolicy covering `pool`
   * (`cfg.policy.actionPolicy.bandTicksByPool[pool]`), the narrower band it computes bounds at — the pool's own
   * `bandTicks` scaled down by `bandFactorBps` (default 0.8x, `DEFAULT_BAND_FACTOR_BPS`). A pool the config does
   * not list, or no `actionPolicy` at all (every live policy today), returns `undefined`: every call for it stays
   * byte-identical to today (fail safe — never assume a band the caller did not confirm it enabled on chain).
   */
  private v4PoolConfig(pool: RegistryName): { address: Address; bandTicks: number } | undefined {
    const ap = this.cfg.policy.actionPolicy
    const bandTicks = ap?.bandTicksByPool[pool]
    if (!ap || bandTicks === undefined) return undefined
    const factor = ap.bandFactorBps ?? DEFAULT_BAND_FACTOR_BPS
    return { address: ap.address, bandTicks: Math.floor((bandTicks * factor) / 10_000) }
  }

  /**
   * Spec 007 (#151) T4: `pool`'s FULL (1.0x, the account's actually-enabled) MamoruActionPolicy config for
   * precheck's own mirror of `checkAction` — never `v4PoolConfig`'s narrower band, which only exists to build
   * calls the policy accepts with margin. `undefined`: same fail-safe as `v4PoolConfig` (no `actionPolicy`, the
   * pool is not in `bandTicksByPool`, or it has no `budgetsByPool` entry — precheck cannot mirror (c) without
   * knowing the budget caps, since the contract exposes no getter for them) — precheck then runs grant-only
   * checks for this pool, exactly as it did before this unit.
   */
  private actionPolicyConfigFor(pool: RegistryName): ActionPolicyPoolConfig | undefined {
    const ap = this.cfg.policy.actionPolicy
    const bandTicks = ap?.bandTicksByPool[pool]
    const budget = ap?.budgetsByPool?.[pool]
    if (!ap || bandTicks === undefined || !budget) return undefined
    const e = entry(pool)
    if (!e.token0 || !e.token1 || !e.fee) return undefined
    return {
      pool,
      address: ap.address,
      token0: address(e.token0),
      token1: address(e.token1),
      feePips: e.fee,
      bandTicks,
      budgetWindowSeconds: budget.windowSeconds,
      perWindow0: budget.perWindow0,
      perWindow1: budget.perWindow1,
      total0: budget.total0,
      total1: budget.total1,
    }
  }

  /**
   * Spec 007 (#151) T4: refreshes the ledger's mirror of MamoruActionPolicy for `pool` right before precheck runs
   * on this op — the same "read right before validating" discipline T3's bound-building already follows for the
   * TWAP (`poolTwapTick`). Two extra eth_calls (`spendOf`, `generationOf`) plus one `observe`, all at this op's own
   * block; a no-op for any pool `actionPolicyConfigFor` does not cover — every live policy today, since
   * `actionPolicy` is never set on `POLICIES`.
   */
  private async syncActionPolicyLedger(pool: RegistryName, blockNumber: bigint): Promise<void> {
    const cfg = this.actionPolicyConfigFor(pool)
    if (!cfg) return
    this.ledger.watchActionPolicyPool(cfg)
    const poolAddress = entry(pool).address
    const [spend, currentGeneration, twapTick] = await Promise.all([
      this.client.readContract({ address: cfg.address, abi: mamoruActionPolicyReadAbi, functionName: 'spendOf', args: [this.cfg.account, poolAddress], blockNumber }),
      this.client.readContract({ address: cfg.address, abi: mamoruActionPolicyReadAbi, functionName: 'generationOf', args: [this.cfg.account], blockNumber }),
      this.poolTwapTick(pool, this.cfg.policy.execution.twapWindowSeconds, blockNumber),
    ])
    this.ledger.syncActionPolicyReads(pool, { twapTick, spend, currentGeneration })
  }

  /** FR-UNI-001 to FR-UNI-006: calls from fresh quotes, exact approvals, nothing left approved. */
  private async prepareCalls(p: Proposal, blockNumber: bigint, timestamp: bigint): Promise<Prepared> {
    const acct = this.cfg.account
    const slippage = this.cfg.policy.execution.slippageBps
    if (p.kind === 'enter_swap') {
      const amountOut = await quoteExactInputSingle(this.client, { tokenIn: address(p.tokenIn), tokenOut: address(p.tokenOut), fee: p.fee, amountIn: p.amountIn, blockNumber })
      const v4 = this.v4PoolConfig(p.pool)
      const needsTwap = !!this.cfg.policy.depth || !!v4
      const tick = needsTwap ? await this.poolTwapTick(p.pool, this.cfg.policy.execution.twapWindowSeconds, blockNumber) : undefined
      const floor = tick !== undefined ? this.depthFloor(p, amountOut, tick) : null
      const usual = minOut(amountOut, slippage)
      let amountOutMinimum = floor !== null && floor > usual ? floor : usual
      let sqrtPriceLimitX96: bigint | undefined
      if (v4 && tick !== undefined) {
        // Spec 007 T3: amountOutMinimum and sqrtPriceLimitX96 from the same math as MamoruActionPolicy._swapBounds,
        // at a narrower band (v4.bandTicks is already scaled by bandFactorBps) — "never below today's TWAP floor
        // (take the max of minimums, the tighter limit)".
        const pool = entry(p.pool)
        const bound = swapBoundsAtBand({
          twap: tick,
          bandTicks: v4.bandTicks,
          feePips: p.fee,
          zeroForOne: pool.token0 === p.tokenIn,
          tokenIn: address(p.tokenIn),
          tokenOut: address(p.tokenOut),
          amountIn: p.amountIn,
        })
        if (bound.minOut > amountOutMinimum) amountOutMinimum = bound.minOut
        sqrtPriceLimitX96 = bound.sqrtPriceLimitX96
      }
      return {
        quote: { amountIn: p.amountIn, amountOut, amountOutMinimum },
        calls: [approve(p.tokenIn, 'SwapRouter02', p.amountIn), exactInputSingle({ account: acct, tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, amountIn: p.amountIn, amountOutMinimum, sqrtPriceLimitX96 })].map(exec),
      }
    }
    if (p.kind === 'enter_mint') {
      const pool = entry(p.pool)
      const [sqrtPriceX96] = await this.client.readContract({ address: pool.address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber })
      const q = quoteMint({ sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps: slippage })
      const deadline = timestamp + BigInt(this.cfg.policy.execution.observationTtlSeconds)
      const v4 = this.v4PoolConfig(p.pool)
      if (!v4) {
        return {
          calls: [
            approve(pool.token0!, 'NonfungiblePositionManager', p.amount0Desired),
            approve(pool.token1!, 'NonfungiblePositionManager', p.amount1Desired),
            mint({ account: acct, pool: p.pool, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, amount0Min: q.amount0Min, amount1Min: q.amount1Min, deadline }),
            approve(pool.token0!, 'NonfungiblePositionManager', 0n),
            approve(pool.token1!, 'NonfungiblePositionManager', 0n),
          ].map(exec),
        }
      }
      // Spec 007 T3 "(b) positions": mint through the policy, not the manager; approvals go to the policy, which
      // pulls exactly amount*Desired and refunds what it does not use (MamoruActionPolicy.mint), so the allowance
      // is spent in full without a trailing reset — packages/scenarios/action-policy/t1-fork.ts's "engine op 2"
      // mint does the same, no zero-approves.
      const mintParams = {
        token0: address(pool.token0!),
        token1: address(pool.token1!),
        fee: pool.fee!,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        amount0Desired: p.amount0Desired,
        amount1Desired: p.amount1Desired,
        amount0Min: q.amount0Min,
        amount1Min: q.amount1Min,
        recipient: acct,
        deadline,
      }
      const approveToPolicy = (tokenName: RegistryName, amount: bigint): Execution => ({
        target: address(tokenName),
        value: 0n,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [v4.address, amount] }),
      })
      return {
        calls: [
          approveToPolicy(pool.token0!, p.amount0Desired),
          approveToPolicy(pool.token1!, p.amount1Desired),
          { target: v4.address, value: 0n, callData: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [mintParams] }) },
        ],
      }
    }
    if (p.kind === 'rerange' || p.kind === 'reduce') {
      // decreaseLiquidity(all or part) + collect(to the Safe) [+ burn]: nothing leaves the account.
      const [pos, [sqrtPriceX96]] = await Promise.all([
        this.client.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [p.tokenId], blockNumber }),
        this.client.readContract({ address: entry(p.pool).address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber }),
      ])
      const liquidity = p.kind === 'rerange' ? pos[7] : p.liquidity < pos[7] ? p.liquidity : pos[7]
      const deadline = timestamp + BigInt(this.cfg.policy.execution.observationTtlSeconds)
      const calls: V3Call[] = []
      if (liquidity > 0n) {
        const a = amountsOf(sqrtPriceX96, pos[5], pos[6], liquidity)
        let amount0Min = a.amount0 > 0n ? minOut(a.amount0, slippage) : 0n
        let amount1Min = a.amount1 > 0n ? minOut(a.amount1, slippage) : 0n
        const v4 = this.v4PoolConfig(p.pool)
        if (v4) {
          // Spec 007 T3: decrease minimums from the same math as MamoruActionPolicy._decreaseMins, at the narrower
          // band; never below the usual slippage minimum either (take the max, same reasoning as the swap floor).
          const tick = await this.poolTwapTick(p.pool, this.cfg.policy.execution.twapWindowSeconds, blockNumber)
          const bound = decreaseMinsAtBand({ twap: tick, bandTicks: v4.bandTicks, tickLower: pos[5], tickUpper: pos[6], liquidity })
          if (bound.amount0Min > amount0Min) amount0Min = bound.amount0Min
          if (bound.amount1Min > amount1Min) amount1Min = bound.amount1Min
        }
        calls.push(decreaseLiquidity({ tokenId: p.tokenId, liquidity, amount0Min, amount1Min, deadline }))
      }
      calls.push(collect({ account: acct, tokenId: p.tokenId }))
      if (p.kind === 'rerange') calls.push(burn(p.tokenId))
      return { calls: calls.map(exec) }
    }
    const owedAt = await principalOwedBefore(this.client, [p.tokenId], this.historyFromBlock, { block: blockNumber + 1n, logIndex: 0 })
    const owed = owedAt.get(p.tokenId) ?? [0n, 0n]
    const calls = [collect({ account: acct, tokenId: p.tokenId })]
    if (!p.convert) return { calls: calls.map(exec), owed }
    const savings = this.cfg.policy.savingsAsset
    const fee = entry(p.pool).fee!
    const amountOut = await quoteExactInputSingle(this.client, { tokenIn: address(p.convert.token), tokenOut: address(savings), fee, amountIn: p.convert.amount, blockNumber })
    const amountOutMinimum = minOut(amountOut, slippage)
    calls.push(
      approve(p.convert.token, 'SwapRouter02', p.convert.amount),
      exactInputSingle({ account: acct, tokenIn: p.convert.token, tokenOut: savings, fee, amountIn: p.convert.amount, amountOutMinimum }),
    )
    return { calls: calls.map(exec), quote: { amountIn: p.convert.amount, amountOut, amountOutMinimum }, owed }
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
    // FR-UNI-005: the conversion spends fees only; principal collected from an external decrease stays in the account.
    const pool = entry(p.pool)
    const savings = this.cfg.policy.savingsAsset
    const savingsIs0 = pool.token0 === savings
    const volatile = savingsIs0 ? pool.token1! : pool.token0!
    const collects = positionEvents(sim.logs).filter((e) => e.kind === 'collect' && e.tokenId === p.tokenId)
    if (collects.length !== 1) return `${collects.length} Collect events for ${p.tokenId}`
    const c = collects[0]!
    const [collectedSavings, collectedVolatile] = savingsIs0 ? [c.amount0, c.amount1] : [c.amount1, c.amount0]
    const owedVolatile = (savingsIs0 ? prepared.owed?.[1] : prepared.owed?.[0]) ?? 0n
    const converting = p.convert?.amount ?? 0n
    if (p.convert && p.convert.token !== volatile) return `converts ${p.convert.token}, the volatile token is ${volatile}`
    const retained = collectedVolatile - converting
    if (retained < owedVolatile) return `converting ${converting} ${volatile} would spend principal: collected ${collectedVolatile}, principal owed ${owedVolatile}`
    if (d(volatile) !== retained) return `${volatile} moved ${d(volatile)}, expected the ${retained} left after converting the fees`
    const minimum = collectedSavings + (prepared.quote?.amountOutMinimum ?? 0n)
    if (d(savings) < minimum) return `${savings} rose ${d(savings)}, below the collected ${collectedSavings} plus the minimum out`
    return null
  }
}
