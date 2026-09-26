import { randomBytes } from 'node:crypto'
import { getAddress, isAddress, keccak256, stringToHex, toHex, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address, FundingView, OpView, OwnerSignature, OwnerTxToSign, TransferPlan, TransferRequest } from '@mamoru/domain'
import { address, erc20Abi } from '@mamoru/registry'
import { computeCaps, instantiateGrant, type PolicyVersion } from '@mamoru/policy'
import {
  LIVE_CAP_USDC,
  activationBatch,
  browserOwnerSignature,
  deployCall,
  execData,
  liveAccountFromContext,
  ownerSafeTx,
  readSafeNonce,
  safeTxHashOf,
  stopBatch,
  transferBatch,
  type LiveAccount,
  type LivePosition,
  type LiveSwap,
  type SafeTx,
} from '@mamoru/account/live'
import { permissionIdOf, toSmartSession } from '@mamoru/account/sessions'
import { minOut, quoteExactInputSingle } from '@mamoru/uniswap-v3/quote'
import { Engine, type EngineSession } from '@mamoru/scenarios/driver/engine.ts'
import type { OpRecord } from '@mamoru/scenarios/driver/journal.ts'
import { LIVE_POOL, amountsForLiquidity, cbbtcInUsdc, readSafe, type PoolPosition, type SafeRead } from './chain.ts'
import { Lock } from './lock.ts'
import type { Relayer } from './relayer.ts'
import { revertData } from './bundler.ts'
import type { AccountState, ArmedActivation, StateStore, StoredGrant } from './state.ts'

const EXECUTION_SUCCESS = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'))
const PREPARE_TTL_MS = 5 * 60_000
/** On top of the policy reserve: the first userOp prefund leaves the Safe's balance into its EntryPoint deposit. */
const TOP_UP_MARGIN_WEI = 200_000_000_000_000n
/** How long a POST waits for the owner transaction before answering with the op as it stands; the SPA polls /ops. */
const POST_WAIT_MS = 15_000
/** How often the armed-activation watcher reads the USDC balance of each armed Safe. */
const ARM_WATCH_MS = 6_000

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
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
}

type Runner = { engine: Engine; timer: ReturnType<typeof setTimeout> | null; stopped: boolean; epoch: number; seen: Map<string, string> }

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
  return k === 'close_position' ? 'exit' : k === 'harvest' || k === 'convert' ? 'reduce' : 'enter'
}

const now = () => new Date().toISOString()

export class Operator {
  private readonly prepared = new Map<string, Prepared>()
  private readonly locks = new Map<string, Lock>()
  private readonly runners = new Map<string, Runner>()
  private armTimer: ReturnType<typeof setTimeout> | null = null
  private armStopped = false

  constructor(
    readonly cfg: OperatorConfig,
    private readonly client: PublicClient,
    readonly relayer: Relayer,
    private readonly store: StateStore,
  ) {}

  /** Restarts the engine loop of every account that was active. */
  resume(): void {
    for (const acc of Object.values(this.store.state.accounts)) if (acc.active) this.startLoop(acc)
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
      throw new HttpError(400, 'ACCOUNT_MISMATCH', (e as Error).message)
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
      cbbtc: r.cbbtc.toString(),
      gasReserveWei: this.cfg.policy.gasReserveWei.toString(),
      active: acc.active,
      positions: r.positions.map((p) => ({
        tokenId: p.tokenId.toString(),
        pool: LIVE_POOL,
        liquidity: p.liquidity.toString(),
        inRange: p.inRange,
        amountUsdc: p.amount0.toString(),
        amountCbbtc: p.amount1.toString(),
      })),
    }
  }

  ops(ctx: AccountContext, after: string | null): { ops: OpView[] } {
    const { acc } = this.account(ctx)
    if (!after) return { ops: acc.ops }
    const i = acc.ops.findIndex((o) => o.opId === after)
    if (i >= 0) return { ops: acc.ops.slice(i + 1) }
    const t = Date.parse(after)
    return { ops: Number.isNaN(t) ? acc.ops : acc.ops.filter((o) => Date.parse(o.updatedAt) > t) }
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

  async prepareActivate(ctx: AccountContext): Promise<OwnerTxToSign> {
    this.assertLive()
    const { acc, live } = this.account(ctx)
    if (acc.active) throw new HttpError(409, 'ALREADY_ACTIVE', 'the engine is already active for this account')
    const r = await readSafe(this.client, live.safe)
    if (r.usdc > LIVE_CAP_USDC) throw new HttpError(409, 'CAP_EXCEEDED', `the Safe holds ${r.usdc} USDC base units, cap is ${LIVE_CAP_USDC}`)
    if (!acc.sessionKey) {
      acc.sessionKey = generatePrivateKey()
      this.store.save()
    }
    const sessionKey = privateKeyToAccount(acc.sessionKey).address
    const policy = this.cfg.policy
    // Sized at the account cap, not the observed deposit: the same signature bounds any deposit up to the cap,
    // so the owner can sign before any USDC arrives (armed activation).
    const caps = computeCaps(policy, LIVE_CAP_USDC, { cbBTC: { num: r.sqrtPriceX96 * r.sqrtPriceX96, den: 1n << 192n } })
    const block = await this.client.getBlock({ blockNumber: r.block })
    const t = Number(block.timestamp)
    const grants = (['enter-swap', 'enter-mint'] as const).map((name) =>
      instantiateGrant(policy, name, {
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
    const batch = activationBatch(live, grants, acc.revoked, { trust: !acc.trusted })
    const stored = grants.map((g, i) => ({ name: g.name, grant: g, permissionId: batch.permissionIds[i]! }))
    const summary = [
      `${r.deployed ? 'Use' : 'Create'} your Safe ${live.safe} on Base`,
      r.usdc > 0n
        ? `Let Mamoru's engine allocate your ${fmtUsdc(r.usdc)} USDC into Uniswap v3 USDC/cbBTC 0.05%`
        : `Let Mamoru's engine allocate your deposit (up to ${fmtUsdc(LIVE_CAP_USDC)} USDC) into Uniswap v3 USDC/cbBTC 0.05% as soon as it arrives`,
      `Engine key ${sessionKey} may only swap USDC->cbBTC (max ${fmtUsdc(caps.usdcSwapPerCall ?? 0n)} per swap) and mint that pool, for ${Math.round(policy.session.validitySeconds / 86_400)} days`,
      `Funds never leave your Safe without your passkey; cap ${fmtUsdc(LIVE_CAP_USDC)} USDC`,
    ]
    return this.hold(acc, live, 'activate', batch.calls, summary, { grants: stored })
  }

  async prepareTransfer(ctx: AccountContext, req: TransferRequest): Promise<TransferPlan> {
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
    const to = getAddress(req.to)
    if (to.toLowerCase() === live.safe.toLowerCase()) throw new HttpError(400, 'BAD_REQUEST', 'recipient is the Safe itself')
    const r = await readSafe(this.client, live.safe)
    if (!r.deployed) throw new HttpError(409, 'NOT_DEPLOYED', 'the Safe is not deployed yet')
    const slip = this.cfg.policy.execution.slippageBps
    let reduce: { pos: PoolPosition; bps: number; lp: LivePosition }[] = []
    let swap: LiveSwap | undefined
    if (r.usdc < amount) {
      const plan = await this.reducePlan(r, amount, slip)
      reduce = plan.reduce
      swap = plan.swap
    }
    const deadline = (await this.client.getBlock()).timestamp + 1800n
    const calls = transferBatch({ account: live.safe, to, amountUsdc: amount, reduce: reduce.map((x) => x.lp), swapCbbtc: swap, deadline })
    const summary = [
      ...reduce.map((x) => `Withdraw ${(x.bps / 100).toFixed(2)}% of position #${x.pos.tokenId} (USDC/cbBTC 0.05%)`),
      ...(swap ? [`Swap ${swap.amountIn} cbBTC units to at least ${fmtUsdc(swap.amountOutMinimum)} USDC`] : []),
      `Send ${fmtUsdc(amount)} USDC from your Safe to ${to}`,
    ]
    const ownerTx = await this.hold(acc, live, 'transfer', calls, summary)
    return { reduce: reduce.map((x) => ({ tokenId: x.pos.tokenId.toString(), liquidityBps: x.bps })), ownerTx }
  }

  /** Proportional decrease of the pool positions plus a cbBTC->USDC swap, enough to cover `amount` with the policy slippage. */
  private async reducePlan(r: SafeRead, amount: bigint, slip: number): Promise<{ reduce: { pos: PoolPosition; bps: number; lp: LivePosition }[]; swap?: LiveSwap }> {
    const open = r.positions.filter((p) => p.liquidity > 0n)
    const value = open.reduce((s, p) => s + p.amount0 + cbbtcInUsdc(p.amount1, r.sqrtPriceX96), 0n)
    const need = amount - r.usdc
    if (value === 0n) throw new HttpError(409, 'INSUFFICIENT_FUNDS', `idle ${r.usdc} USDC and no position to reduce`)
    const keep = BigInt(10_000 - slip)
    let bps = Number((need * 10_000n * 103n) / (value * 100n)) + 1
    for (;;) {
      bps = Math.min(bps, 10_000)
      const reduce = open.map((pos) => {
        const liquidity = (pos.liquidity * BigInt(bps)) / 10_000n
        const a = amountsForLiquidity(r.sqrtPriceX96, pos.tickLower, pos.tickUpper, liquidity)
        return { pos, bps, lp: { tokenId: pos.tokenId, liquidity, amount0Min: (a.amount0 * keep) / 10_000n, amount1Min: (a.amount1 * keep) / 10_000n } }
      })
      const usdcMin = reduce.reduce((s, x) => s + x.lp.amount0Min, 0n)
      const cbbtcIn = r.cbbtc + reduce.reduce((s, x) => s + x.lp.amount1Min, 0n)
      const swap = await this.swapQuote(cbbtcIn, r.block, slip)
      if (r.usdc + usdcMin + (swap?.amountOutMinimum ?? 0n) >= amount) return { reduce, swap }
      if (bps >= 10_000) throw new HttpError(409, 'INSUFFICIENT_FUNDS', `the Safe cannot free ${amount} USDC base units`)
      bps = Math.ceil(bps * 1.2)
    }
  }

  private async swapQuote(amountIn: bigint, blockNumber: bigint, slip: number): Promise<LiveSwap | undefined> {
    if (amountIn <= 0n) return undefined
    const out = await quoteExactInputSingle(this.client, { tokenIn: address('cbBTC'), tokenOut: address('USDC'), fee: 500, amountIn, blockNumber })
    return { amountIn, amountOutMinimum: minOut(out, slip) }
  }

  async prepareStop(ctx: AccountContext): Promise<OwnerTxToSign> {
    this.assertLive()
    const { acc, live } = this.account(ctx)
    const r = await readSafe(this.client, live.safe)
    if (!r.deployed) throw new HttpError(409, 'NOT_DEPLOYED', 'the Safe is not deployed yet')
    const slip = this.cfg.policy.execution.slippageBps
    const keep = BigInt(10_000 - slip)
    const positions: LivePosition[] = r.positions.map((p) => ({ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: (p.amount0 * keep) / 10_000n, amount1Min: (p.amount1 * keep) / 10_000n }))
    const cbbtcIn = r.cbbtc + positions.reduce((s, p) => s + p.amount1Min, 0n)
    const swap = await this.swapQuote(cbbtcIn, r.block, slip)
    const revokes = acc.grants.map((g) => g.permissionId)
    if (!revokes.length && !positions.length && !swap) throw new HttpError(409, 'NOTHING_TO_STOP', 'no grant, no position and no cbBTC')
    const deadline = (await this.client.getBlock()).timestamp + 1800n
    const calls = stopBatch({ account: live.safe, permissionIds: revokes, positions, swapCbbtc: swap, deadline })
    const summary = [
      ...(revokes.length ? [`Revoke the engine's ${revokes.length} session grant(s)`] : []),
      ...positions.map((p) => `Close and burn position #${p.tokenId} (USDC/cbBTC 0.05%)`),
      ...(swap ? [`Swap ${swap.amountIn} cbBTC units to at least ${fmtUsdc(swap.amountOutMinimum)} USDC`] : []),
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
      throw new HttpError(400, 'BAD_SIGNATURE', (e as Error).message)
    }
    this.prepared.delete(p.prepareId)
    if (kind === 'activate') {
      const usdc = await this.usdcOf(live.safe)
      if (usdc === 0n) return this.arm(acc, p, signature)
      if (usdc > LIVE_CAP_USDC) throw new HttpError(409, 'CAP_EXCEEDED', `the Safe holds ${usdc} USDC base units, cap is ${LIVE_CAP_USDC}`)
      this.disarm(acc, 'ARMED_SUPERSEDED')
    }
    const op = this.newOp(acc, kind === 'stop' ? 'exit' : kind)
    const run = this.lock(acc.accountKey).run(() => this.execute(acc, live, p, signature, op))
    run.catch((e) => {
      console.error(`[owner] ${op.opId} ${(e as Error).message}`)
      this.patchOp(acc, op.opId, { state: 'failed', code: 'OWNER_TX_ERROR' })
    })
    await Promise.race([run.catch(() => undefined), Bun.sleep(POST_WAIT_MS)])
    return { ...acc.ops.find((o) => o.opId === op.opId)! }
  }

  private usdcOf(safe: Address): Promise<bigint> {
    return this.client.readContract({ address: address('USDC'), abi: erc20Abi, functionName: 'balanceOf', args: [safe] })
  }

  /** Stores the signed activation (0600 state file); the watcher executes it when USDC lands. */
  private arm(acc: AccountState, p: Prepared, signature: Hex): OpView {
    this.disarm(acc, 'ARMED_SUPERSEDED')
    const op = this.newOp(acc, 'activate')
    op.code = 'ARMED'
    acc.armed = { opId: op.opId, tx: p.tx, safeTxHash: p.safeTxHash, signature, grants: p.grants ?? [], armedAt: now() }
    this.store.save()
    console.log(`[armed] ${acc.accountKey} ${op.opId} armed for ${acc.ctx.address} at Safe nonce ${p.tx.nonce}`)
    return { ...op }
  }

  /** Drops a pending armed activation, failing its op with `code`. */
  private disarm(acc: AccountState, code: string): void {
    const a = acc.armed
    if (!a) return
    acc.armed = undefined
    this.patchOp(acc, a.opId, { state: 'failed', code })
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
        console.error(`[armed] ${acc.accountKey} ${(e as Error).message.split('\n')[0]}`)
      }
    }
    if (!this.armStopped) this.armTimer = setTimeout(() => this.watchArmed(), ARM_WATCH_MS)
  }

  private async fireArmed(acc: AccountState, usdc: bigint): Promise<void> {
    const a = acc.armed
    if (!a || acc.active) return this.disarm(acc, 'ALREADY_ACTIVE')
    if (usdc > LIVE_CAP_USDC) {
      console.log(`[armed] ${acc.accountKey} deposit ${usdc} over cap ${LIVE_CAP_USDC}`)
      return this.disarm(acc, 'CAP_EXCEEDED')
    }
    const live = liveAccountFromContext(acc.ctx)
    const { deployed, nonce } = await readSafeNonce(this.client, live.safe)
    if (deployed && nonce !== a.tx.nonce) {
      console.log(`[armed] ${acc.accountKey} Safe nonce ${nonce} != armed ${a.tx.nonce}`)
      return this.disarm(acc, 'ARMED_NONCE_MOVED')
    }
    acc.armed = undefined
    this.patchOp(acc, a.opId, { code: undefined })
    console.log(`[armed] ${acc.accountKey} ${a.opId} deposit ${usdc} landed, executing`)
    const p: Prepared = { prepareId: `armed-${a.opId}`, accountKey: acc.accountKey, kind: 'activate', tx: a.tx, safeTxHash: a.safeTxHash, expires: Number.MAX_SAFE_INTEGER, grants: a.grants }
    const op = acc.ops.find((o) => o.opId === a.opId)!
    try {
      await this.execute(acc, live, p, a.signature, op)
    } catch (e) {
      console.error(`[armed] ${op.opId} ${(e as Error).message.split('\n')[0]}`)
      this.patchOp(acc, op.opId, { state: 'failed', code: 'OWNER_TX_ERROR' })
    }
  }

  private newOp(acc: AccountState, kind: OpView['kind']): OpView {
    const op: OpView = { opId: `own-${++acc.seq}-${kind}`, kind, state: 'proposed', updatedAt: now() }
    acc.ops.push(op)
    this.store.save()
    return op
  }

  private patchOp(acc: AccountState, opId: string, patch: Partial<OpView>): void {
    const op = acc.ops.find((o) => o.opId === opId)
    if (!op) return
    Object.assign(op, patch, { updatedAt: now() })
    this.store.save()
  }

  private async execute(acc: AccountState, live: LiveAccount, p: Prepared, signature: Hex, op: OpView): Promise<void> {
    const safe = live.safe
    if (p.kind === 'activate') {
      const { deployed } = await readSafeNonce(this.client, safe)
      if (!deployed) {
        const d = deployCall(live)
        const { hash, receipt } = await this.relayer.send(d)
        console.log(`[owner] deploy ${safe} tx ${hash} ${receipt.status}`)
        if (receipt.status !== 'success') return this.patchOp(acc, op.opId, { state: 'failed', code: 'DEPLOY_FAILED', txHash: hash })
      }
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
    try {
      await this.client.call({ account: this.relayer.address, to: safe, data })
    } catch (e) {
      console.error(`[owner] ${op.opId} simulation reverts: ${revertData(e) ?? (e as Error).message.split('\n')[0]}`)
      return this.patchOp(acc, op.opId, { state: 'failed', code: 'OWNER_TX_REVERTS' })
    }
    const sent = this.relayer.send({ to: safe, data })
    const { hash, receipt } = await sent
    this.patchOp(acc, op.opId, { state: 'submitted', txHash: hash })
    const ok = receipt.status === 'success' && receipt.logs.some((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === EXECUTION_SUCCESS)
    console.log(`[owner] ${op.opId} tx ${hash} block ${receipt.blockNumber} ${ok ? 'ok' : 'FAILED'}`)
    if (!ok) return this.patchOp(acc, op.opId, { state: 'failed', code: 'OWNER_TX_FAILED', block: Number(receipt.blockNumber) })
    this.afterOwner(acc, p, receipt)
    this.patchOp(acc, op.opId, { state: 'confirmed', code: 'EXEC_OK', block: Number(receipt.blockNumber) })
  }

  private afterOwner(acc: AccountState, p: Prepared, receipt: TransactionReceipt): void {
    if (p.kind === 'activate') {
      acc.trusted = true
      acc.active = true
      acc.grants = p.grants ?? []
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
    }
  }

  // ---- engine side ---------------------------------------------------------

  private manageSession(acc: AccountState, tokenId: bigint): EngineSession {
    const grant = instantiateGrant(this.cfg.policy, 'manage', {
      account: acc.ctx.address as Address,
      sessionKey: privateKeyToAccount(acc.sessionKey!).address,
      chainId: this.cfg.chainId,
      salt: toHex(randomBytes(32)),
      validAfter: 0,
      validUntil: 0,
      caps: Object.fromEntries(this.cfg.policy.session.caps.map((c) => [c.name, 0n])),
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
    const sessions: EngineSession[] = [...acc.grants.map((g) => ({ name: g.name, grant: g.grant, permissionId: g.permissionId })), ...acc.managedTokenIds.map((id) => this.manageSession(acc, BigInt(id)))]
    const engine = new Engine(
      {
        mode: 'live',
        chainId: this.cfg.chainId,
        signingChainIds: [this.cfg.chainId],
        rpcUrl: this.cfg.rpcUrl,
        bundlerUrl: this.cfg.bundlerUrl,
        policy: this.cfg.policy,
        account: acc.ctx.address as Address,
        sessionKey: privateKeyToAccount(acc.sessionKey),
        nonceLane: 0,
        depositsAfter: BigInt(acc.depositsAfter),
        historyFromBlock: BigInt(acc.historyFromBlock),
        sessions,
        maxWaitBlocks: this.cfg.maxWaitBlocks,
      },
      {
        waitBlock: () => Bun.sleep(this.cfg.waitBlockMs),
        requestManageGrant: async (tokenId) => {
          acc.managedTokenIds.push(tokenId.toString())
          this.store.save()
          return this.manageSession(acc, tokenId)
        },
      },
    )
    this.revokeManage(engine)
    const runner: Runner = { engine, timer: null, stopped: false, epoch: acc.epoch, seen: new Map() }
    this.runners.set(acc.accountKey, runner)
    const tick = async () => {
      if (runner.stopped) return
      await this.lock(acc.accountKey).run(async () => {
        if (runner.stopped) return
        try {
          // The provider may still serve a block before the activation that enabled the grants: wait for it.
          const head = await this.client.getBlockNumber()
          if (head <= BigInt(acc.historyFromBlock)) {
            console.log(`[engine ${acc.accountKey}] rpc head ${head} not past activation block ${acc.historyFromBlock}, waiting`)
            return
          }
          const r = await engine.review()
          this.revokeManage(engine)
          if (r.kind === 'observation-failed') console.log(`[engine ${acc.accountKey}] observation failed ${r.code} ${r.detail ?? ''}`)
          else {
            const d = r.record.decision
            const o = r.op ? engine.journal.op(r.op.opId) : null
            const last = o ? engine.journal.transitions.filter((t) => t.opId === o.opId).at(-1) : null
            console.log(`[engine ${acc.accountKey}] block ${d.observationRef.block} ${d.kind} ${d.reason}${o ? ` -> ${o.opId} ${o.state} ${o.stateCode}${last?.detail ? ` (${last.detail})` : ''}` : ''}`)
          }
        } catch (e) {
          console.error(`[engine ${acc.accountKey}] review error: ${(e as Error).message.split('\n')[0]}`)
        }
        this.syncEngineOps(acc, runner)
      })
      if (!runner.stopped) runner.timer = setTimeout(tick, this.cfg.reviewMs)
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
      const opId = `eng-${runner.epoch}-${o.opId}-${o.kind}`
      const view: OpView = {
        opId,
        kind: engineKind(o.kind),
        state,
        code: o.stateCode,
        txHash: o.included?.txHash,
        block: o.included ? Number(o.included.blockNumber) : undefined,
        updatedAt: now(),
      }
      const sig = `${view.state}|${view.code}|${view.txHash ?? ''}`
      if (runner.seen.get(opId) === sig) continue
      runner.seen.set(opId, sig)
      const existing = acc.ops.find((x) => x.opId === opId)
      if (existing) Object.assign(existing, view)
      else acc.ops.push(view)
      changed = true
    }
    if (changed) this.store.save()
  }
}

function fmtUsdc(v: bigint): string {
  const s = v.toString().padStart(7, '0')
  return `${s.slice(0, -6)}.${s.slice(-6, -4)}`
}
