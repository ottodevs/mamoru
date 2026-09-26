import { decodeFunctionData, isAddressEqual, maxUint128, type Hex } from 'viem'
import type { Address, ReasonCode } from '@mamoru/domain'
import { canonicalJson, decide, type Decision } from '@mamoru/decide'
import { POLICIES, computeCaps, type PolicyVersion, type Price } from '@mamoru/policy'
import { address, entry, entryPointV07Abi, erc20Abi, nonfungiblePositionManagerAbi, swapRouter02Abi, uniswapV3PoolAbi } from '@mamoru/registry'
import { approve, exactInputSingle } from '@mamoru/uniswap-v3'
import { minOut, quoteExactInputSingle, sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { toPackedUserOperation } from 'viem/account-abstraction'
import { isTerminal } from '@mamoru/journal'
import { sessionNonceKey } from '@mamoru/account/sessions'
import { swapFills } from '@mamoru/projector'
import { Engine, type ReviewResult } from '../driver/engine.ts'
import type { OpRecord } from '../driver/journal.ts'
import { DEPOSIT_USDC, WHALE, activateGrants } from '../fixtures/world.ts'
import type { StepResult } from '../report/index.ts'
import type { ScenarioCtx, StepHandler } from './context.ts'
import { checkRecipient } from './state.ts'

/** `bundlerSeen` is how many userOps the group's bundler had received before this scenario's engine. */
type EngineRun = { engine: Engine; bundlerSeen: number; last?: Extract<ReviewResult, { kind: 'decided' }>; preHarvest?: AccountSnapshot }

const RUNS = new WeakMap<ScenarioCtx, EngineRun>()
const Q96 = 1n << 96n

function worldOf(ctx: ScenarioCtx) {
  if (!ctx.world) throw new Error('engine steps need a world')
  return ctx.world
}

function policyOf(ctx: ScenarioCtx): PolicyVersion {
  const p = POLICIES[ctx.scenario.policy]
  if (!p) throw new Error(`unknown policy ${ctx.scenario.policy}`)
  return p
}

function engineOf(ctx: ScenarioCtx): Engine {
  const existing = RUNS.get(ctx)
  if (existing) return existing.engine
  const w = worldOf(ctx)
  if (!ctx.enginePort || !ctx.bundler || ctx.engineBaseBlock === undefined) throw new Error('engine world without engine port, bundler or base block')
  const engine = new Engine(
    {
      mode: 'lab',
      chainId: ctx.run.manifest.fork.chainId,
      signingChainIds: [ctx.run.manifest.fork.chainId],
      rpcUrl: ctx.enginePort.url,
      bundlerUrl: ctx.bundler.url,
      policy: policyOf(ctx),
      account: w.a1.safe,
      sessionKey: w.a1.sessionKey,
      nonceLane: 0,
      depositsAfter: ctx.engineBaseBlock,
      sessions: w.a1.grants.map((g) => ({ name: g.name, grant: g.grant, permissionId: g.permissionId })),
    },
    {
      waitBlock: async () => {
        await w.lab.rpc('evm_mine')
      },
      requestManageGrant: async (tokenId) => {
        w.a1.managedTokenIds.push(tokenId)
        const [g] = await activateGrants(w, w.a1, [{ name: 'manage', tokenId }])
        return { name: g!.name, grant: g!.grant, permissionId: g!.permissionId }
      },
    },
  )
  RUNS.set(ctx, { engine, bundlerSeen: ctx.bundler.received().length })
  return engine
}

function runOf(ctx: ScenarioCtx): EngineRun {
  engineOf(ctx)
  return RUNS.get(ctx)!
}

/** Raw units of `asset` per raw unit of USDC at the pool's slot0, for the activation caps. */
async function activationPrices(ctx: ScenarioCtx, policy: PolicyVersion): Promise<Record<string, Price>> {
  const lab = worldOf(ctx).lab
  const prices: Record<string, Price> = {}
  for (const name of policy.buckets.flatMap((b) => b.pools)) {
    const e = entry(name)
    const [sqrt] = await lab.client.readContract({ address: e.address, abi: uniswapV3PoolAbi, functionName: 'slot0' })
    const q192 = 1n << 192n
    if (e.token0 === 'USDC') prices[e.token1!] = { num: sqrt * sqrt, den: q192 }
    else prices[e.token0!] = { num: q192, den: sqrt * sqrt }
  }
  return prices
}

/** Applies the scenario fixtures that the world does not already have, in the listed order. */
const fixturesStep: StepHandler = async (ctx) => {
  const w = worldOf(ctx)
  const out: StepResult[] = []
  const policy = policyOf(ctx)
  w.policy = policy
  for (const f of ctx.scenario.fixtures) {
    if (w.fixtures.includes(f)) continue
    if (f === 'fx-sessions') {
      w.a1.caps = computeCaps(policy, DEPOSIT_USDC, await activationPrices(ctx, policy))
      const active = await activateGrants(w, w.a1, [{ name: 'enter-swap' }, { name: 'enter-mint' }])
      const engine = RUNS.get(ctx)?.engine
      for (const g of active) engine?.addSession({ name: g.name, grant: g.grant, permissionId: g.permissionId })
      out.push({ step: 'fx-sessions', ok: true, detail: `owner activated ${active.map((g) => g.name).join(', ')} for ${policy.policyId}` })
    } else if (f === 'fx-usdc') {
      const r = await w.lab.whaleTransfer('USDC', WHALE, w.a1.safe, DEPOSIT_USDC)
      out.push({ step: 'fx-usdc', ok: r.ok, detail: `${DEPOSIT_USDC} USDC units transferred to the account in block ${r.receipt.blockNumber}` })
    } else if (f === 'fx-whale') {
      out.push({ step: 'fx-whale', ok: true, detail: `whale ${WHALE} is impersonated by each perturbation` })
    } else if (f === 'fx-lp') {
      out.push(...(await lpThroughEngine(ctx)))
    } else {
      throw new Error(`fixture ${f} is not an engine fixture`)
    }
  }
  return out
}

/** fx-lp: the engine itself runs the two entries of M02 until a managed position is in range. */
async function lpThroughEngine(ctx: ScenarioCtx): Promise<StepResult[]> {
  const out: StepResult[] = []
  if (!ctx.scenario.fixtures.includes('fx-usdc')) {
    const w = worldOf(ctx)
    const r = await w.lab.whaleTransfer('USDC', WHALE, w.a1.safe, DEPOSIT_USDC)
    out.push({ step: 'fx-lp deposit', ok: r.ok, detail: `${DEPOSIT_USDC} USDC units transferred to the account in block ${r.receipt.blockNumber}` })
  }
  await mineUntilSafe(ctx)
  const engine = engineOf(ctx)
  const ops: string[] = []
  for (let i = 0; i < 4 && engine.allowedTokenIds.length === 0; i++) {
    const r = await engine.review()
    if (r.kind === 'decided' && r.op) ops.push(`${r.op.kind}:${r.op.state}`)
  }
  const ok = engine.allowedTokenIds.length === 1 && ops.every((o) => o.endsWith(':confirmed'))
  out.push({ step: 'fx-lp', ok, detail: `engine ran ${ops.join(', ') || 'nothing'}; managed ${engine.allowedTokenIds.join(', ') || 'none'}` })
  return out
}

async function mineUntilSafe(ctx: ScenarioCtx): Promise<{ target: bigint; mined: number }> {
  const lab = worldOf(ctx).lab
  const target = (await lab.client.getBlock({ blockTag: 'latest' })).number
  let mined = 0
  while ((await lab.client.getBlock({ blockTag: 'safe' })).number < target) {
    await lab.rpc('evm_mine')
    mined++
  }
  return { target, mined }
}

const mineUntilSafeStep: StepHandler = async (ctx) => {
  const { target, mined } = await mineUntilSafe(ctx)
  return { step: 'mine until the deposit is below safe', ok: true, detail: `mined ${mined} blocks; block ${target} is safe` }
}

/** `eth` is the account balance plus its EntryPoint deposit, where the v0.7 prefund refund lands. */
type AccountSnapshot = { eth: bigint; nonce: bigint; tokens: Record<string, bigint>; liquidity: Record<string, bigint> }

async function snapshot(ctx: ScenarioCtx, engine: Engine): Promise<AccountSnapshot> {
  const w = worldOf(ctx)
  const c = w.lab.client
  const tokens: Record<string, bigint> = {}
  for (const t of ['USDC', 'cbBTC', 'WETH']) tokens[t] = await w.lab.balanceOf(t, w.a1.safe)
  const liquidity: Record<string, bigint> = {}
  for (const id of engine.allowedTokenIds) {
    const p = await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [id] })
    liquidity[String(id)] = p[7]
  }
  return {
    eth: (await c.getBalance({ address: w.a1.safe })) + (await c.readContract({ address: address('EntryPointV07'), abi: entryPointV07Abi, functionName: 'balanceOf', args: [w.a1.safe] })),
    nonce: await w.lab.entryPointNonce(w.a1.safe, sessionNonceKey(engine.cfg.nonceLane)),
    tokens,
    liquidity,
  }
}

function decisionCodes(d: Decision): Set<string> {
  return new Set<string>([
    ...d.observationCodes,
    d.code,
    d.reason,
    ...d.trail.map((t) => t.reason),
    ...d.shadow.map((s) => s.code),
    ...d.buckets.map((b) => b.code),
    ...d.positions.flatMap((p) => p.codes),
  ])
}

function policyTargets(policy: PolicyVersion): Set<string> {
  const tokens = policy.buckets.flatMap((b) => b.pools).flatMap((p) => [entry(p).token0!, entry(p).token1!])
  return new Set([...tokens, 'NonfungiblePositionManager', 'SwapRouter02'].map((n) => address(n).toLowerCase()))
}

/** INV-RECIPIENT, INV-TARGETS, INV-ETH-GAS, INV-NONCE and zero allowances, on one operation. */
async function checkOp(ctx: ScenarioCtx, engine: Engine, op: OpRecord, before: AccountSnapshot, after: AccountSnapshot): Promise<StepResult[]> {
  const w = worldOf(ctx)
  const out: StepResult[] = []
  const included = op.state === 'confirmed' || op.state === 'failed'
  const targets = policyTargets(engine.cfg.policy)
  const badTargets = (op.calls ?? []).filter((c) => !targets.has(c.target.toLowerCase())).map((c) => c.target)
  for (const t of badTargets) ctx.invariantErrors.push({ name: 'INV-TARGETS', detail: `${op.opId} calls ${t}` })
  const gasSpent = before.eth - after.eth
  const expectedGas = included ? op.included!.actualGasCost : 0n
  if (gasSpent !== expectedGas) ctx.invariantErrors.push({ name: 'INV-ETH-GAS', detail: `${op.opId}: ETH plus deposit fell ${gasSpent}, actualGasCost ${expectedGas}` })
  const nonceStep = after.nonce - before.nonce
  if (nonceStep !== (included ? 1n : 0n)) ctx.invariantErrors.push({ name: 'INV-NONCE', detail: `${op.opId}: lane moved ${nonceStep}` })
  if (included && op.nonce !== before.nonce) ctx.invariantErrors.push({ name: 'INV-NONCE', detail: `${op.opId} signed nonce ${op.nonce}, lane was ${before.nonce}` })
  if (included) {
    const receipt = await w.lab.client.getTransactionReceipt({ hash: op.included!.txHash })
    for (const e of checkRecipient(w.a1.safe, op.calls ?? [], receipt)) ctx.invariantErrors.push({ name: 'INV-RECIPIENT', detail: `${op.opId}: ${e}` })
  }
  const allowances: string[] = []
  for (const t of ['USDC', 'cbBTC', 'WETH']) {
    for (const s of ['SwapRouter02', 'NonfungiblePositionManager']) {
      const a = await w.lab.client.readContract({ address: address(t), abi: erc20Abi, functionName: 'allowance', args: [w.a1.safe, address(s)] })
      if (a !== 0n) allowances.push(`${t}->${s} ${a}`)
    }
  }
  out.push({ step: `${op.opId} leaves no allowance`, ok: allowances.length === 0, detail: allowances.join(', ') || 'USDC, cbBTC and WETH allowances to SwapRouter02 and NonfungiblePositionManager are 0' })
  return out
}

type CallView = { target: string; fn: string; args: readonly unknown[] }

function viewCalls(op: OpRecord): CallView[] {
  return (op.calls ?? []).map((c) => {
    const target = entry(nameFor(c.target)).name
    const abi = target === 'SwapRouter02' ? swapRouter02Abi : target === 'NonfungiblePositionManager' ? nonfungiblePositionManagerAbi : erc20Abi
    const d = decodeFunctionData({ abi, data: c.callData })
    return { target, fn: d.functionName, args: d.args ?? [] }
  })
}

function nameFor(a: Address): string {
  for (const n of ['USDC', 'cbBTC', 'WETH', 'SwapRouter02', 'NonfungiblePositionManager']) if (isAddressEqual(address(n), a)) return n
  throw new Error(`call to ${a} outside the policy targets`)
}

/** The call shape M02, M04 and M07 expect for each kind. Returns the problems found. */
function callShape(op: OpRecord, account: Address): string[] {
  const calls = viewCalls(op)
  const errs: string[] = []
  const sig = calls.map((c) => `${c.target}.${c.fn}`).join(' ')
  const p = op.intent
  if (p.kind === 'enter_swap') {
    if (sig !== `${p.tokenIn}.approve SwapRouter02.exactInputSingle`) errs.push(`calls ${sig}`)
    const [spender, amount] = calls[0]!.args as [Address, bigint]
    if (!isAddressEqual(spender, address('SwapRouter02')) || amount !== p.amountIn) errs.push('approve is not exact to SwapRouter02')
    const s = calls[1]!.args[0] as { tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }
    if (!isAddressEqual(s.tokenIn, address(p.tokenIn)) || !isAddressEqual(s.tokenOut, address(p.tokenOut)) || s.fee !== p.fee) errs.push('swap pair or fee')
    if (!isAddressEqual(s.recipient, account)) errs.push('swap recipient is not the account')
    if (s.amountOutMinimum <= 0n) errs.push('amountOutMinimum is not positive')
    if (s.sqrtPriceLimitX96 !== 0n) errs.push('sqrtPriceLimitX96 is not 0')
  } else if (p.kind === 'enter_mint') {
    const pool = entry(p.pool)
    const want = `${pool.token0}.approve ${pool.token1}.approve NonfungiblePositionManager.mint ${pool.token0}.approve ${pool.token1}.approve`
    if (sig !== want) errs.push(`calls ${sig}`)
    const m = calls[2]!.args[0] as { tickLower: number; tickUpper: number; amount0Min: bigint; amount1Min: bigint; recipient: Address }
    if (m.tickLower % pool.tickSpacing! !== 0 || m.tickUpper % pool.tickSpacing! !== 0) errs.push(`ticks ${m.tickLower}, ${m.tickUpper} not multiples of ${pool.tickSpacing}`)
    if (m.amount0Min <= 0n || m.amount1Min <= 0n) errs.push('mint minimums are not positive')
    if (!isAddressEqual(m.recipient, account)) errs.push('mint recipient is not the account')
    for (const i of [3, 4]) if ((calls[i]!.args as [Address, bigint])[1] !== 0n) errs.push(`call ${i} does not reset the approval to 0`)
  } else if (p.kind === 'harvest') {
    const want = p.convert ? `NonfungiblePositionManager.collect ${p.convert.token}.approve SwapRouter02.exactInputSingle` : 'NonfungiblePositionManager.collect'
    if (sig !== want) errs.push(`calls ${sig}`)
    const c = calls[0]!.args[0] as { tokenId: bigint; recipient: Address; amount0Max: bigint; amount1Max: bigint }
    if (c.tokenId !== p.tokenId || !isAddressEqual(c.recipient, account) || c.amount0Max !== maxUint128 || c.amount1Max !== maxUint128) errs.push('collect is not tokenId, account, max')
    if (p.convert) {
      const [spender, amount] = calls[1]!.args as [Address, bigint]
      if (!isAddressEqual(spender, address('SwapRouter02')) || amount !== p.convert.amount) errs.push('convert approve is not exact')
      const s = calls[2]!.args[0] as { tokenIn: Address; tokenOut: Address; amountIn: bigint; recipient: Address }
      if (!isAddressEqual(s.tokenIn, address(p.convert.token)) || !isAddressEqual(s.tokenOut, address('USDC')) || s.amountIn !== p.convert.amount) errs.push('convert swap')
      if (!isAddressEqual(s.recipient, account)) errs.push('convert recipient is not the account')
    }
    if (calls.some((c) => c.fn === 'decreaseLiquidity')) errs.push('harvest decreases liquidity')
  }
  return errs
}

const HAPPY_PATH = ['proposed', 'prepared', 'simulated', 'signed', 'submitted', 'included', 'confirmed']

type ReviewExpect = {
  observation?: string
  decision?: string
  reason?: string
  codes?: string[]
  buckets?: Record<string, string>
  op?: 'none' | { kind: string; state: string; code?: string; grant?: string }
  managed?: boolean
}

async function reviewAndCheck(ctx: ScenarioCtx, label: string, expect: ReviewExpect): Promise<StepResult[]> {
  const engine = engineOf(ctx)
  const before = await snapshot(ctx, engine)
  return checkReview(ctx, label, expect, await engine.review(), before)
}

async function checkReview(ctx: ScenarioCtx, label: string, expect: ReviewExpect, r: ReviewResult, before: AccountSnapshot): Promise<StepResult[]> {
  const run = runOf(ctx)
  const engine = run.engine
  const w = worldOf(ctx)
  const out: StepResult[] = []
  if (r.kind !== 'decided') {
    ctx.codes.add(r.code)
    return [{ step: label, ok: false, detail: `observation failed: ${r.code} ${r.detail ?? ''}`, codes: [r.code] }]
  }
  run.last = r
  const d = r.record.decision
  const codes = decisionCodes(d)
  if (r.record.code) codes.add(r.record.code)
  const op = r.op
  if (op) {
    for (const t of engine.journal.transitions.filter((x) => x.opId === op.opId)) codes.add(t.code)
    if (op.precheck) codes.add(op.precheck)
  }
  for (const c of codes) ctx.codes.add(c)

  const canon = (await w.lab.client.getBlock({ blockNumber: r.observation.block.number })).hash
  const obsOk = canon === r.observation.block.hash
  const lines: string[] = [`block ${r.observation.block.number} ${obsOk ? 'canonical on the fork' : 'NOT canonical'}`, `${d.code}/${d.reason}`]
  const errs: string[] = []
  if (expect.observation && (!obsOk || !d.observationCodes.includes(expect.observation as ReasonCode))) errs.push(`observation ${d.observationCodes.join(',')}`)
  if (expect.decision && d.code !== expect.decision) errs.push(`decision ${d.code}, expected ${expect.decision}`)
  if (expect.reason && d.reason !== expect.reason) errs.push(`reason ${d.reason}, expected ${expect.reason}`)
  for (const c of expect.codes ?? []) if (!codes.has(c)) errs.push(`missing ${c}`)
  for (const [b, c] of Object.entries(expect.buckets ?? {})) {
    const got = d.buckets.find((x) => x.bucket === b)?.code
    if (got !== c) errs.push(`bucket ${b} ${got}, expected ${c}`)
  }
  lines.push(`buckets ${d.buckets.map((b) => `${b.bucket}=${b.code}`).join(' ')}`)
  if (d.positions.length) lines.push(`positions ${d.positions.map((p) => `${p.tokenId}:${p.codes.join('+')}`).join(' ')}`)
  if (d.shadow.length) lines.push(`shadow ${d.shadow.map((s) => s.code).join(',')}`)
  out.push({ step: `${label}: decision`, ok: errs.length === 0, detail: `${lines.join('; ')}${errs.length ? ` | ${errs.join('; ')}` : ''}`, codes: [...codes].sort() })

  if (expect.op === 'none') {
    out.push({ step: `${label}: no operation`, ok: !op, detail: op ? `${op.opId} ${op.kind} ${op.state}` : 'no operation proposed' })
  } else if (expect.op) {
    const e = expect.op
    if (!op) {
      out.push({ step: `${label}: operation`, ok: false, detail: `expected ${e.kind}, none proposed` })
    } else {
      const path = engine.journal.pathOf(op.opId)
      const opErrs: string[] = []
      if (op.kind !== e.kind) opErrs.push(`kind ${op.kind}`)
      if (op.state !== e.state) opErrs.push(`state ${op.state} (${op.stateCode})`)
      if (e.code && op.stateCode !== e.code) opErrs.push(`code ${op.stateCode}`)
      if (e.grant && op.grantName !== e.grant) opErrs.push(`grant ${op.grantName}`)
      if (e.state === 'confirmed' && path.join('>') !== HAPPY_PATH.join('>')) opErrs.push(`path ${path.join('>')}`)
      opErrs.push(...callShape(op, w.a1.safe))
      const safeNote = op.confirmedSafeBlock !== undefined ? `, included in ${op.included!.blockNumber}, safe ${op.confirmedSafeBlock}` : ''
      out.push({
        step: `${label}: ${e.kind}`,
        ok: opErrs.length === 0,
        detail: `${op.opId} ${path.join(' > ')} ${op.stateCode} grant ${op.grantName}${safeNote}${opErrs.length ? ` | ${opErrs.join('; ')}` : ''}`,
        codes: [op.stateCode],
      })
      const after = await snapshot(ctx, engine)
      out.push(...(await checkOp(ctx, engine, op, before, after)))
      if (e.kind === 'harvest') run.preHarvest = before
    }
  }
  if (expect.managed) {
    const id = op?.mintedTokenId
    const owner = id === undefined ? undefined : await w.lab.client.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', args: [id] })
    const ok = id !== undefined && engine.allowedTokenIds.includes(id) && !!owner && isAddressEqual(owner, w.a1.safe) && engine.sessions.some((s) => s.name === `manage:${id}`)
    out.push({ step: `${label}: new position is managed`, ok, detail: ok ? `tokenId ${id} owned by the account, in allowedTokenIds, grant manage:${id}` : `tokenId ${id ?? 'none'}` })
  }
  return out
}

const reviewStep: StepHandler = async (ctx, args) => reviewAndCheck(ctx, String(args.label ?? 'review'), (args.expect ?? {}) as ReviewExpect)

const journalStep: StepHandler = async (ctx, args) => {
  const j = engineOf(ctx).journal
  const want = args as { decisions?: number; ops?: number }
  const live = j.ops.filter((o) => !isTerminal(o.state)).length
  if (live > 1) ctx.invariantErrors.push({ name: 'INV-SLOT', detail: `${live} live operations` })
  const ok = (want.decisions === undefined || j.decisions.length === want.decisions) && (want.ops === undefined || j.ops.length === want.ops)
  return { step: 'journal', ok, detail: `${j.decisions.length} decisions, ${j.ops.length} operations, ${live} live` }
}

/** FR-DEC-001: decide again on the same observation; same decision and trail, byte for byte. */
const decideAgainStep: StepHandler = async (ctx) => {
  const run = runOf(ctx)
  if (!run.last) throw new Error('decide-again needs a review first')
  const first = canonicalJson(run.last.record.decision)
  const again = canonicalJson(decide(run.last.observation, run.engine.cfg.policy))
  return { step: 'decide again on the same observation', ok: first === again, detail: first === again ? `same decision ${run.last.record.decision.decisionId}, ${first.length} bytes identical` : 'the decisions differ' }
}

/** M07: the same observation decided with another policy marks the position unmanaged. */
const decideWithPolicyStep: StepHandler = async (ctx, args) => {
  const run = runOf(ctx)
  const obs = await run.engine.observe()
  const policy = POLICIES[String(args.policy)]
  if (!policy) throw new Error(`unknown policy ${args.policy}`)
  const d = decide(obs, policy)
  const want = String(args.positionCode)
  for (const c of decisionCodes(d)) ctx.codes.add(c)
  const ok = d.positions.length > 0 && d.positions.every((p) => p.codes.includes(want as ReasonCode)) && d.proposal === null
  return { step: `decide with ${policy.policyId} on the same state`, ok, detail: `positions ${d.positions.map((p) => `${p.tokenId}:${p.codes.join('+')}`).join(' ')}; ${d.code}/${d.reason}` }
}

/**
 * USDC that moves the pool at most half-way from its tick to the edge of the managed range,
 * at the pool's in-range liquidity, so a round never leaves the range.
 */
async function inRangeSwapUsdc(ctx: ScenarioCtx, poolName: string, tokenId: bigint): Promise<bigint> {
  const c = worldOf(ctx).lab.client
  const e = entry(poolName)
  const [sqrt, tick] = await c.readContract({ address: e.address, abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const liquidity = await c.readContract({ address: e.address, abi: uniswapV3PoolAbi, functionName: 'liquidity' })
  const pos = await c.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] })
  const [lower, upper] = [pos[5], pos[6]]
  if (e.token0 === 'USDC') {
    const target = sqrtRatioAtTick(tick - Math.floor((tick - lower) / 2))
    return (liquidity * Q96 * (sqrt - target)) / (sqrt * target)
  }
  const target = sqrtRatioAtTick(tick + Math.floor((upper - tick) / 2))
  return (liquidity * (target - sqrt)) / Q96
}

/** swaps-in-range: the whale swaps both ways on the pool without leaving the range. */
async function swapsInRange(ctx: ScenarioCtx, poolName: string, tokenId: bigint): Promise<bigint> {
  const w = worldOf(ctx)
  const e = entry(poolName)
  const volatile = e.token0 === 'USDC' ? e.token1! : e.token0!
  const amount = await inRangeSwapUsdc(ctx, poolName, tokenId)
  await w.lab.setBalance(WHALE, 10n ** 18n)
  const approveData = approve('USDC', 'SwapRouter02', amount)
  if (!(await w.lab.sendAs(WHALE, approveData.to, approveData.data)).ok) throw new Error('whale approve failed')
  const before = await w.lab.balanceOf(volatile, WHALE)
  const buy = exactInputSingle({ account: WHALE, tokenIn: 'USDC', tokenOut: volatile, fee: e.fee!, amountIn: amount, amountOutMinimum: 1n })
  if (!(await w.lab.sendAs(WHALE, buy.to, buy.data)).ok) throw new Error('whale buy failed')
  const got = (await w.lab.balanceOf(volatile, WHALE)) - before
  const approveBack = approve(volatile, 'SwapRouter02', got)
  if (!(await w.lab.sendAs(WHALE, approveBack.to, approveBack.data)).ok) throw new Error('whale approve back failed')
  const sell = exactInputSingle({ account: WHALE, tokenIn: volatile, tokenOut: 'USDC', fee: e.fee!, amountIn: got, amountOutMinimum: 1n })
  if (!(await w.lab.sendAs(WHALE, sell.to, sell.data)).ok) throw new Error('whale sell failed')
  return amount
}

const harvestRoundsStep: StepHandler = async (ctx, args) => {
  const max = Number(args.maxRounds ?? 12)
  const pool = String(args.pool ?? 'pool:USDC/cbBTC/500')
  const engine = engineOf(ctx)
  const tokenId = engine.allowedTokenIds[0]
  if (tokenId === undefined) throw new Error('harvest-rounds needs a managed position')
  const held: string[] = []
  for (let round = 1; round <= max; round++) {
    await swapsInRange(ctx, pool, tokenId)
    const before = await snapshot(ctx, engine)
    const r = await engine.review()
    if (r.kind === 'decided' && r.record.decision.code !== 'DECIDE_HARVEST') {
      held.push(r.record.decision.positions.flatMap((p) => p.codes).join('+'))
      continue
    }
    const res = await checkReview(ctx, `round ${round}`, (args.expect ?? {}) as ReviewExpect, r, before)
    const detail = `${round - 1} review(s) held (${held.join(', ') || 'none'}), review ${round} decided DECIDE_HARVEST`
    return [{ step: 'swaps-in-range, a review after each round, until the decision changes', ok: true, detail }, ...res]
  }
  return { step: 'swaps-in-range until the decision changes', ok: false, detail: `still below cost after ${max} rounds` }
}

/** M04, step 2: liquidity unchanged, tokenId still managed, USDC up, the volatile token back to its pre-harvest balance. */
const harvestStateStep: StepHandler = async (ctx) => {
  const run = runOf(ctx)
  const pre = run.preHarvest
  if (!pre) throw new Error('harvest-state needs a harvest first')
  const post = await snapshot(ctx, run.engine)
  const id = String(run.engine.allowedTokenIds[0])
  const errs: string[] = []
  if (post.liquidity[id] !== pre.liquidity[id]) errs.push(`liquidity ${pre.liquidity[id]} -> ${post.liquidity[id]}`)
  if (!run.engine.allowedTokenIds.includes(BigInt(id))) errs.push('tokenId no longer managed')
  if (!(post.tokens.USDC! > pre.tokens.USDC!)) errs.push(`USDC ${pre.tokens.USDC} -> ${post.tokens.USDC}`)
  if (post.tokens.cbBTC !== pre.tokens.cbBTC) errs.push(`cbBTC ${pre.tokens.cbBTC} -> ${post.tokens.cbBTC}`)
  return {
    step: 'account after the harvest',
    ok: errs.length === 0,
    detail: errs.join('; ') || `liquidity of ${id} unchanged (${post.liquidity[id]}); USDC ${pre.tokens.USDC} -> ${post.tokens.USDC}; cbBTC back to ${post.tokens.cbBTC}`,
  }
}

/** M04 Savings Log: principal 0, fees equal to Collect, conversion equal to Swap, confirmed, both sources, total up by the credit. */
const savingsLogStep: StepHandler = async (ctx) => {
  const engine = engineOf(ctx)
  const row = engine.savingsLog.at(-1)
  if (!row) return { step: 'Savings Log harvest row', ok: false, detail: 'no row' }
  const op = engine.journal.op(row.opId)
  const logs = (await worldOf(ctx).lab.client.getTransactionReceipt({ hash: row.txHash })).logs
  const collect = logs.find((l) => isAddressEqual(l.address, address('NonfungiblePositionManager')) && l.logIndex === row.logIndex)
  const swap = swapFills(logs, entry((op.intent as { pool: string }).pool).address)[0]
  const errs: string[] = []
  if (row.principal[0] !== 0n || row.principal[1] !== 0n) errs.push(`principal ${row.principal}`)
  if (!collect) errs.push('no Collect event at the row log index')
  if (op.simulation && swap && row.conversion && (row.conversion.amountIn !== swap.amountIn || row.conversion.amountOut !== swap.amountOut)) errs.push('conversion differs from Swap')
  if ((op.intent.kind === 'harvest' && op.intent.convert !== null) !== (row.conversion !== null)) errs.push('conversion presence')
  if (row.status !== 'confirmed' || row.code !== 'PROJ_CONFIRMED') errs.push(`${row.status} ${row.code}`)
  const sources = row.provenance.map((p) => p.source).join('+')
  if (sources !== 'journal+fork_rpc') errs.push(`provenance ${sources}`)
  const total = engine.savingsTotal()
  if (total !== engine.savingsLog.reduce((s, r) => s + r.credited, 0n) || row.credited <= 0n) errs.push(`total ${total}, credited ${row.credited}`)
  ctx.codes.add(row.code)
  return {
    step: 'Savings Log harvest row',
    ok: errs.length === 0,
    detail: `${row.opId}: principal 0, fees ${row.fees[0]} USDC + ${row.fees[1]} volatile, conversion ${row.conversion ? `${row.conversion.amountIn} -> ${row.conversion.amountOut} USDC` : 'none'}, credited ${row.credited}; ${row.status} ${row.code}; ${sources}; ledger total ${total}${errs.length ? ` | ${errs.join('; ')}` : ''}`,
    codes: [row.code],
  }
}

/** M03: the minimum, the deltas, the allowance, the userOp hash and the receipt, checked against independent reads. */
const swapChecksStep: StepHandler = async (ctx) => {
  const run = runOf(ctx)
  const w = worldOf(ctx)
  const op = run.engine.journal.ops.find((o) => o.kind === 'enter_swap' && o.state === 'confirmed')
  if (!op || op.intent.kind !== 'enter_swap' || !op.quote || !op.userOp || !op.included) return { step: 'swap checks', ok: false, detail: 'no confirmed enter_swap' }
  const p = op.intent
  const out: StepResult[] = []
  const quote = await quoteExactInputSingle(w.lab.client, { tokenIn: address(p.tokenIn), tokenOut: address(p.tokenOut), fee: p.fee, amountIn: p.amountIn, blockNumber: op.prepareBlock! })
  const recomputed = minOut(quote, run.engine.cfg.policy.execution.slippageBps)
  out.push({ step: 'amountOutMinimum from QuoterV2 at the prepare block', ok: recomputed === op.quote.amountOutMinimum, detail: `recomputed ${recomputed}, signed ${op.quote.amountOutMinimum} (quote ${quote}, block ${op.prepareBlock})` })
  const simOut = op.simulation!.deltas[p.tokenOut] ?? 0n
  const receipt = await w.lab.client.getTransactionReceipt({ hash: op.included.txHash })
  const fill = swapFills(receipt.logs, entry(p.pool).address)[0]
  out.push({ step: `${p.tokenOut} delta >= minimum`, ok: simOut >= op.quote.amountOutMinimum && !!fill && fill.amountOut >= op.quote.amountOutMinimum, detail: `simulation ${simOut}, Swap event ${fill?.amountOut}, minimum ${op.quote.amountOutMinimum}` })
  const allowance = await w.lab.client.readContract({ address: address(p.tokenIn), abi: erc20Abi, functionName: 'allowance', args: [w.a1.safe, address('SwapRouter02')] })
  out.push({ step: `${p.tokenIn} allowance to SwapRouter02`, ok: allowance === 0n, detail: `${allowance}` })
  const epHash = (await w.lab.client.readContract({ address: address('EntryPointV07'), abi: entryPointV07Abi, functionName: 'getUserOpHash', args: [toPackedUserOperation(op.userOp)] })) as Hex
  out.push({ step: 'journal userOpHash equals EntryPoint.getUserOpHash', ok: epHash === op.userOpHash, detail: `${op.userOpHash}` })
  const b = op.bundlerReceipt
  const same = !!b && b.txHash === op.included.txHash && b.success === op.included.success && b.actualGasCost === op.included.actualGasCost && b.blockHash === op.included.blockHash
  out.push({ step: 'bundler receipt matches the UserOperationEvent read by RPC', ok: same, detail: same ? `tx ${b!.txHash}, success ${b!.success}, actualGasCost ${b!.actualGasCost}` : 'mismatch or missing' })
  out.push({ step: 'pre-check accepts the batch', ok: op.precheck === 'SESSION_ACTIVE', detail: String(op.precheck), codes: op.precheck ? [op.precheck] : [] })
  if (op.precheck) ctx.codes.add(op.precheck)
  return out
}

/** INV-PERSIST-FIRST: every userOp the bundler got was `signed` in the journal first. */
const persistFirstStep: StepHandler = async (ctx) => {
  const run = runOf(ctx)
  const j = run.engine.journal
  const received = ctx.bundler!.received().slice(run.bundlerSeen)
  const missing = received.filter((h) => !j.signedHashes.some((s) => s.toLowerCase() === h.toLowerCase()))
  for (const m of missing) ctx.invariantErrors.push({ name: 'INV-PERSIST-FIRST', detail: `${m} reached the bundler without a signed row` })
  return { step: 'every userOp at the bundler has a signed journal row', ok: missing.length === 0, detail: `${received.length} userOps, ${missing.length} without a row` }
}

export const ENGINE_STEPS: Record<string, StepHandler> = {
  fixtures: fixturesStep,
  'mine-until-safe': mineUntilSafeStep,
  review: reviewStep,
  journal: journalStep,
  'decide-again': decideAgainStep,
  'decide-with-policy': decideWithPolicyStep,
  'harvest-rounds': harvestRoundsStep,
  'harvest-state': harvestStateStep,
  'savings-log': savingsLogStep,
  'swap-checks': swapChecksStep,
  'persist-first': persistFirstStep,
}

