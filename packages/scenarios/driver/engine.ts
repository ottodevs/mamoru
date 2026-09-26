import { isAddressEqual, parseEventLogs, type Hex, type Log, type PublicClient } from 'viem'
import type { LocalAccount } from 'viem/accounts'
import { ReasonError, type Address, type ReasonCode } from '@mamoru/domain'
import { decide, type Decision, type Observation, type Proposal, type SessionObs } from '@mamoru/decide'
import { signBlocker } from '@mamoru/journal'
import type { PolicyVersion, SessionGrant } from '@mamoru/policy'
import { address, entry, entryPointV07Abi, nonfungiblePositionManagerAbi, smartSessionAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { isSafeAndCanonical, observe, principalOwedBefore, readUserOpEvent, rpcClient, simulateFromEntryPoint, type Simulation } from '@mamoru/rpc'
import { BundlerClient, BundlerRpcError } from '@mamoru/erc4337'
import { SessionLedger, precheck } from '@mamoru/account/precheck'
import { draftUserOp, executeCallData, sessionNonceKey, signSessionUserOp, useModeSignature, userOpHash, type GasSettings } from '@mamoru/account/sessions'
import type { Execution } from '@mamoru/account/safe'
import { approve, collect, exactInputSingle, mint, type V3Call } from '@mamoru/uniswap-v3'
import { minOut, quoteExactInputSingle, quoteMint } from '@mamoru/uniswap-v3/quote'
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
}

export type EngineHooks = {
  /** Lets one block pass on the fork. The engine itself never calls anvil methods. */
  waitBlock: () => Promise<void>
  /** The owner activates `manage:<tokenId>` for a position that enter-mint minted (plan §12.4). */
  requestManageGrant: (tokenId: bigint, pool: string) => Promise<EngineSession>
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
  depositsAfter: bigint
  lastObservation?: Observation
  /** Live: premises the bundler rejected as unincludable, held back until `until` (block timestamp, seconds). */
  private readonly backoff: { premiseHash: string; key: string; until: bigint }[] = []
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
  }

  /** Live: a session the owner removed on chain (SmartSession) is revoked in the ledger, so decide never proposes an op it cannot authorize. */
  private async syncEnabled(): Promise<void> {
    if (this.cfg.mode !== 'live') return
    for (const s of this.sessions) {
      if (this.ledger.get(s.permissionId)?.revoked) continue
      const on = await this.client.readContract({ address: address('SmartSession'), abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [s.permissionId, this.cfg.account] })
      if (!on) this.ledger.revoke(s.permissionId)
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
    }))
  }

  async observe(): Promise<Observation> {
    const live = this.journal.live
    return observe(this.client, {
      chainId: this.cfg.chainId,
      account: this.cfg.account,
      nonceKey: this.nonceKey,
      depositsAfter: this.depositsAfter,
      sessions: this.sessionObs(),
      allowedTokenIds: this.allowedTokenIds,
      historyFromBlock: this.historyFromBlock,
      intents: { paused: false, exitRequested: false },
      slot: live ? { opId: live.opId, state: live.state } : null,
      twapWindowSeconds: this.cfg.policy.execution.twapWindowSeconds,
      opGasUnits: OP_GAS_UNITS,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
      savingsAsset: this.cfg.policy.savingsAsset,
      ethPricePool: ETH_PRICE_POOL,
    })
  }

  /** One review: observe at a fixed block, decide, and run at most one operation. */
  async review(): Promise<ReviewResult> {
    await this.resumeIncluded()
    let obs: Observation
    try {
      await this.syncEnabled()
      obs = await this.observe()
    } catch (e) {
      if (e instanceof ReasonError) return { kind: 'observation-failed', code: e.code, detail: e.detail }
      throw e
    }
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
      this.addSession(await this.hooks.requestManageGrant(minted.args.tokenId, proposal.pool))
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

  /** FR-UNI-001 to FR-UNI-006: calls from fresh quotes, exact approvals, nothing left approved. */
  private async prepareCalls(p: Proposal, blockNumber: bigint, timestamp: bigint): Promise<Prepared> {
    const acct = this.cfg.account
    const slippage = this.cfg.policy.execution.slippageBps
    if (p.kind === 'enter_swap') {
      const amountOut = await quoteExactInputSingle(this.client, { tokenIn: address(p.tokenIn), tokenOut: address(p.tokenOut), fee: p.fee, amountIn: p.amountIn, blockNumber })
      const amountOutMinimum = minOut(amountOut, slippage)
      return {
        quote: { amountIn: p.amountIn, amountOut, amountOutMinimum },
        calls: [approve(p.tokenIn, 'SwapRouter02', p.amountIn), exactInputSingle({ account: acct, tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, amountIn: p.amountIn, amountOutMinimum })].map(exec),
      }
    }
    if (p.kind === 'enter_mint') {
      const pool = entry(p.pool)
      const [sqrtPriceX96] = await this.client.readContract({ address: pool.address, abi: uniswapV3PoolAbi, functionName: 'slot0', blockNumber })
      const q = quoteMint({ sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps: slippage })
      const deadline = timestamp + BigInt(this.cfg.policy.execution.observationTtlSeconds)
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
