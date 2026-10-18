// Spec 007 (otto/mamoru#151), task T4: proves precheck's own mirror of MamoruActionPolicy.checkAction (a)-(c)
// (packages/account/precheck/action-policy.ts, wired into `precheck`/`SessionLedger` in index.ts and into
// `Engine.run`/`afterConfirmed` in packages/scenarios/driver/engine.ts) against the DEPLOYED contract on a fork —
// not just the pure unit tests (packages/account/precheck/action-policy.test.ts, precheck-action-policy.test.ts).
//
// For each of the three refusal classes, `sendSessionOp` (packages/scenarios/fixtures/session-op.ts) already runs
// the engine's own `precheck` before building the userOp AND sends it to `handleOps` regardless — so one call
// gives both answers to compare: `outcome.precheck` (what the engine would have done: discard, never sign or
// send) and `outcome.verdict` (what the chain independently decided). This script wires `world.a1.ledger` the same
// way `Engine.syncActionPolicyLedger` does (real `spendOf`/`generationOf`/`observe` eth_calls, the same
// `withActionPolicy({ caps })` config the engine would carry), so precheck's verdict is the real wiring, not a
// hand-rolled stand-in.
//
// Run (builds the contract, then the scenario):
//   PATH="$HOME/.foundry/bin:$PATH" bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t4-fork.ts'
//
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1/t2/t3-fork.ts.
import { encodeFunctionData, parseEventLogs, type Address as ViemAddress, type Hex, type TransactionReceipt } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, erc20Abi, nonfungiblePositionManagerAbi, smartSessionAbi, swapRouter02Abi, uniswapV3PoolAbi } from '@mamoru/registry'
import { computeCaps, conservadorLabV4, encodeMamoruInit, instantiateGrant, mamoruInitFor, retargetToPolicy, V4_POOLS, withActionPolicy, type Price, type SessionGrant } from '@mamoru/policy'
import type { ActionPolicyPoolConfig } from '@mamoru/account/precheck'
import { permissionIdOf, toSmartSession } from '@mamoru/account/sessions'
import { approve } from '@mamoru/uniswap-v3'
import { Lab, devAccount } from '../fixtures/lab.ts'
import { buildBasicWorld, ownerExec, ownerMint, WHALE, type World } from '../fixtures/world.ts'
import { sendSessionOp, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'
import { attestMamoruPolicyCall, deployMamoruPolicy, loadPolicyArtifact, registerMamoruPolicyCall, resolverUidOf } from './v4-grant.ts'

const POOL = V4_POOLS.btc.pool // 'pool:USDC/cbBTC/500'
const DEPOSIT_USDC = 100_000_000_000n // 100,000 USDC — same order of magnitude as t3-fork.ts

type Line = { step: string; ok: boolean | null; detail: string }
const reportLines: Line[] = []
const t0 = Date.now()
let exitCode = 0

function note(step: string, ok: boolean | null, detail: string): void {
  reportLines.push({ step, ok, detail })
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${ok === null ? 'info' : ok ? 'ok  ' : 'FAIL'} ${step}: ${detail}`)
  if (ok === false) exitCode = 1
}

process.on('uncaughtException', (e) => {
  console.error(`t4-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t4-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})

/** precheck's verdict, read out of a `SessionOpOutcome` as a short label for the report. */
function precheckLabel(o: SessionOpOutcome): string {
  return o.precheck.ok ? 'ACCEPT' : o.precheck.code
}

function expectPrecheck(o: SessionOpOutcome, label: string, want: 'ACCEPT' | string): void {
  const got = precheckLabel(o)
  note(label, got === want, `precheck: ${got}`)
}

function expectVerdict(o: SessionOpOutcome, label: string, want: SessionOpOutcome['verdict']): void {
  const extra = o.failedOp?.reason ? ` reason=${o.failedOp.reason}` : ''
  note(label, o.verdict === want, `verdict: ${o.verdict}${extra}`)
}

function mintedPosition(receipt: TransactionReceipt, safe: Address): { tokenId: bigint; liquidity: bigint } {
  const npm = address('NonfungiblePositionManager')
  const t = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: receipt.logs, eventName: 'Transfer' }).find((l) => l.address.toLowerCase() === npm.toLowerCase() && l.args.to.toLowerCase() === safe.toLowerCase())
  if (!t) throw new Error('no position minted to the account (no NPM Transfer log)')
  const inc = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: receipt.logs, eventName: 'IncreaseLiquidity' }).find((l) => l.args.tokenId === t.args.tokenId)
  if (!inc) throw new Error('no IncreaseLiquidity log for the minted position')
  return { tokenId: t.args.tokenId, liquidity: inc.args.liquidity }
}

async function usdcPrice(lab: Lab, pool: string, token0: string, token1: string, asset: string): Promise<Price> {
  const [sqrtPriceX96] = await lab.client.readContract({ address: address(pool), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const ratio: Price = { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n }
  if (token0 === 'USDC' && token1 === asset) return ratio
  if (token1 === 'USDC' && token0 === asset) return { num: ratio.den, den: ratio.num }
  throw new Error(`usdcPrice: ${pool} does not pair USDC with ${asset}`)
}

/** Same floor-rounding `Engine.poolTwapTick` / `OracleLibrary.consult` use. One `observe` eth_call. */
async function twapTick(lab: Lab, pool: ViemAddress, windowSeconds: number): Promise<number> {
  const [cumulatives] = await lab.client.readContract({
    address: pool,
    abi: [{ type: 'function', name: 'observe', stateMutability: 'view', inputs: [{ type: 'uint32[]' }], outputs: [{ type: 'int56[]' }, { type: 'uint160[]' }] }],
    functionName: 'observe',
    args: [[windowSeconds, 0]],
  })
  const delta = cumulatives[1]! - cumulatives[0]!
  let t = delta / BigInt(windowSeconds)
  if (delta < 0n && delta % BigInt(windowSeconds) !== 0n) t -= 1n
  return Number(t)
}

// ------------------------------------------------------------------------------------------------ setup

const manifest = await loadManifest()
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t4`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  await assertCodeHashes(lab.client)
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}`)

  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, conservadorLabV4, engineNow)
  note('fx-safe', true, `Safe7579 account ${world.a1.safe}`)
  await lab.whaleTransfer('USDC', WHALE, world.a1.safe, 100_000_000_000n)
  await lab.whaleTransfer('cbBTC', WHALE, world.a1.safe, 10_000_000n)
  note('fx-usdc / fx-cbbtc top-up', true, 'A1 funded with 100,000 USDC and 0.1 cbBTC total (on top of fx-usdc\'s own 10,000 USDC)')

  const pool = address(POOL)
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, 'pool:USDC/cbBTC/500', 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, 'pool:WETH/USDC/3000', 'WETH', 'USDC', 'WETH'),
  }
  const caps = computeCaps(conservadorLabV4, DEPOSIT_USDC, prices)
  note('caps computed', true, `deposit ${DEPOSIT_USDC} raw USDC, ${Object.keys(caps).length} cap formulas`)

  // --------------------------------------------------------------------------------------------- deploy + register + attest

  const artifact = await loadPolicyArtifact()
  const mamoruPolicy = await deployMamoruPolicy(lab, artifact, relayer)
  const policyAbi = artifact.abi
  note('MamoruActionPolicy deployed', true, mamoruPolicy)
  const resolverUID = await resolverUidOf(lab, address('TimeFramePolicy'))
  const registerTx = await lab.send(relayer, address('ModuleRegistry'), registerMamoruPolicyCall(mamoruPolicy, resolverUID).data)
  if (!registerTx.ok) throw new Error('registerModule reverted')
  const attestTx = await ownerExec(lab, relayer, world.a1, attestMamoruPolicyCall(mamoruPolicy))
  if (!attestTx.ok) throw new Error('self-attest reverted')
  note('register + self-attest MamoruActionPolicy', true, `${registerTx.receipt.gasUsed + attestTx.receipt.gasUsed} gas total`)

  // --------------------------------------------------------------------------------------------- generation 1: enter-swap + manage-any

  const sessionKey = world.a1.sessionKey.address
  const now0 = await engineNow()
  let saltCounter = 0
  const nextSalt = (): Hex => {
    saltCounter++
    return `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex
  }
  const grantCtx = () => ({ account: world.a1.safe, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now0 - 60, validUntil: now0 + conservadorLabV4.session.validitySeconds, caps })
  const btcMamoruInit = encodeMamoruInit(mamoruInitFor(V4_POOLS.btc, 1n, caps))

  const swapGrant: SessionGrant = retargetToPolicy(instantiateGrant(conservadorLabV4, `enter-swap:${POOL}`, grantCtx()), mamoruPolicy)
  const manageGrant: SessionGrant = retargetToPolicy(instantiateGrant(conservadorLabV4, `manage-any:${POOL}`, grantCtx()), mamoruPolicy)
  const swapSession = toSmartSession(swapGrant, { policy: mamoruPolicy, initData: btcMamoruInit })
  const manageSession = toSmartSession(manageGrant, { policy: mamoruPolicy, initData: btcMamoruInit })
  const swapPid = permissionIdOf(swapSession)
  const managePid = permissionIdOf(manageSession)

  const enableData = encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableSessions', args: [[swapSession, manageSession]] })
  const enableTx = await ownerExec(lab, relayer, world.a1, { to: address('SmartSession'), data: enableData })
  if (!enableTx.ok) throw new Error('enableSessions reverted')
  note('enableSessions: enter-swap + manage-any (gen 1)', true, `${enableTx.receipt.gasUsed} gas`)
  world.a1.ledger.activate(swapPid, swapGrant)
  world.a1.ledger.activate(managePid, manageGrant)
  world.a1.grants.push({ name: 'enter-swap-v4', grant: swapGrant, permissionId: swapPid }, { name: 'manage-any-v4', grant: manageGrant, permissionId: managePid })

  // The PolicyVersion an engine running against this deployed policy would carry (spec 007 T4's own
  // `withActionPolicy({ caps })`): full bandTicks AND the budgets mirrored from the SAME caps the real Init used.
  const enginePolicy = withActionPolicy(conservadorLabV4, mamoruPolicy, [V4_POOLS.btc], { caps })
  const apBudget = enginePolicy.actionPolicy!.budgetsByPool![POOL]!
  const apConfig: ActionPolicyPoolConfig = {
    pool: POOL,
    address: mamoruPolicy,
    token0: address('USDC'),
    token1: address('cbBTC'),
    feePips: 500,
    bandTicks: enginePolicy.actionPolicy!.bandTicksByPool[POOL]!,
    budgetWindowSeconds: apBudget.windowSeconds,
    perWindow0: apBudget.perWindow0,
    perWindow1: apBudget.perWindow1,
    total0: apBudget.total0,
    total1: apBudget.total1,
  }
  note('engine action-policy config', true, `bandTicks ${apConfig.bandTicks} (full, 1.0x), perWindow0 ${apConfig.perWindow0}, total0 ${apConfig.total0}`)

  /** Exactly what `Engine.syncActionPolicyLedger` does before precheck: watch the pool's config, then refresh the
   * TWAP + the policy's own on-chain Spend/generation from real eth_calls. */
  async function syncLedger(): Promise<void> {
    world.a1.ledger.watchActionPolicyPool(apConfig)
    const [spend, currentGeneration, tick] = await Promise.all([
      lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'spendOf', args: [world.a1.safe, pool] }) as Promise<{ epoch: bigint; generation: bigint; window0: bigint; window1: bigint; total0: bigint; total1: bigint }>,
      lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'generationOf', args: [world.a1.safe] }) as Promise<bigint>,
      twapTick(lab, pool, conservadorLabV4.execution.twapWindowSeconds),
    ])
    world.a1.ledger.syncActionPolicyReads(POOL, { twapTick: tick, spend, currentGeneration })
  }

  function swapExec(amountIn: bigint, amountOutMinimum: bigint, sqrtPriceLimitX96: bigint) {
    return [
      approve('USDC', 'SwapRouter02', amountIn),
      { to: address('SwapRouter02') as Address, data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.a1.safe, amountIn, amountOutMinimum, sqrtPriceLimitX96 }] }) },
    ]
  }

  // --------------------------------------------------------------------------------------------- (a) price band

  {
    await syncLedger()
    const looseAmount = 10_000_000_000n // 10,000 USDC

    const loose = await sendSessionOp(world, world.a1, { name: 'enter-swap-v4', grant: swapGrant, permissionId: swapPid }, 't4-price-band-refused', swapExec(looseAmount, 1n, 0n))
    expectPrecheck(loose, "(a) today's grant shape (amountOutMinimum=1, sqrtPriceLimitX96=0): precheck refuses it BEFORE anything is sent", 'POLICY_PRICE_BAND')
    expectVerdict(loose, '(a) the chain independently refuses the same calldata too', 'CHAIN_REJECTED_VALIDATION')

    await syncLedger()
    const [minOut, limit] = (await lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'swapBounds', args: [world.a1.safe, pool, address('USDC'), looseAmount] })) as readonly [bigint, bigint]
    const valid = await sendSessionOp(world, world.a1, { name: 'enter-swap-v4', grant: swapGrant, permissionId: swapPid }, 't4-price-band-valid', swapExec(looseAmount, minOut, limit))
    expectPrecheck(valid, "(a) the policy's own swapBounds minimum/limit: precheck accepts it", 'ACCEPT')
    expectVerdict(valid, '(a) the chain includes it', 'INCLUDED')
  }

  // --------------------------------------------------------------------------------------------- (b) positions (admission)

  let admittedTokenId = 0n
  {
    // A position the Safe owns but never minted through MamoruActionPolicy.mint: the owner mints it directly on
    // the NPM (same pattern as t1-fork.ts's attack (b): `ownerMint` funds, approves and mints in one batch).
    await lab.whaleTransfer('USDC', WHALE, world.a1.safe, 5_000_000_000n)
    await lab.whaleTransfer('cbBTC', WHALE, world.a1.safe, 5_000_000n)
    const unrelatedTokenId = await ownerMint(world, world.a1, 5_000_000_000n, 5_000_000n)
    const deadline = BigInt((await engineNow()) + 3600)
    note('fx: an unrelated position, owner-minted directly on NPM, never admitted', true, `tokenId ${unrelatedTokenId}`)

    await syncLedger()
    const refused = await sendSessionOp(world, world.a1, { name: 'manage-any-v4', grant: manageGrant, permissionId: managePid }, 't4-admission-refused', [
      { to: address('NonfungiblePositionManager') as Address, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'decreaseLiquidity', args: [{ tokenId: unrelatedTokenId, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline }] }) },
    ])
    expectPrecheck(refused, '(b) decreaseLiquidity on a never-admitted tokenId: precheck refuses it BEFORE anything is sent', 'POLICY_NOT_ADMITTED')
    expectVerdict(refused, '(b) the chain independently refuses the same calldata too', 'CHAIN_REJECTED_VALIDATION')

    // Mint a position THROUGH the policy (admits it on chain and in our ledger mirror), then decrease it.
    const mintUsdc = 10_000_000_000n
    const mintCbbtc = 2_000_000n
    const mintThroughPolicy = { token0: address('USDC'), token1: address('cbBTC'), fee: 500, tickLower: -600, tickUpper: 600, amount0Desired: mintUsdc, amount1Desired: mintCbbtc, amount0Min: 0n, amount1Min: 0n, recipient: world.a1.safe, deadline }
    await syncLedger()
    const minted = await sendSessionOp(world, world.a1, { name: 'manage-any-v4', grant: manageGrant, permissionId: managePid }, 't4-admission-mint', [
      { to: address('USDC') as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [mamoruPolicy, mintUsdc] }) },
      { to: address('cbBTC') as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [mamoruPolicy, mintCbbtc] }) },
      { to: mamoruPolicy, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [mintThroughPolicy] }) },
    ])
    expectPrecheck(minted, '(b) mint through the policy: precheck accepts it (admission + budget both ok)', 'ACCEPT')
    expectVerdict(minted, '(b) the chain includes it and admits the tokenId', 'INCLUDED')
    if (minted.verdict === 'INCLUDED' && minted.receipt) {
      admittedTokenId = mintedPosition(minted.receipt, world.a1.safe).tokenId
      world.a1.ledger.admitTokenId(admittedTokenId, POOL) // mirrors what Engine.afterConfirmed does for enter_mint
      const onChainAdmitted = (await lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'admittedPool', args: [world.a1.safe, admittedTokenId] })) as Address
      note('(b) the chain itself admitted this tokenId too (admittedPool)', onChainAdmitted.toLowerCase() === pool.toLowerCase(), `admittedPool(${admittedTokenId}) = ${onChainAdmitted}`)
    }

    if (admittedTokenId > 0n) {
      await syncLedger()
      const valid = await sendSessionOp(world, world.a1, { name: 'manage-any-v4', grant: manageGrant, permissionId: managePid }, 't4-admission-valid-decrease', [
        { to: address('NonfungiblePositionManager') as Address, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'decreaseLiquidity', args: [{ tokenId: admittedTokenId, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: BigInt((await engineNow()) + 3600) }] }) },
      ])
      expectPrecheck(valid, '(b) decreaseLiquidity on the now-admitted tokenId: precheck accepts it', 'ACCEPT')
      expectVerdict(valid, '(b) the chain includes it', 'INCLUDED')
    }
  }

  // --------------------------------------------------------------------------------------------- (c) budgets

  {
    // A FRESH enter-swap session (its own permissionId, its own grant-level cumulative counter starting at zero):
    // section (a) already spent some of swapGrant/swapPid's own UniActionPolicy-equivalent cumulative cap, which
    // would otherwise mask the action-policy's budget denial behind a grant-level POLICY_DENIED_CUMULATIVE first.
    // MamoruActionPolicy's own budget is scoped to (account, pool), never to a session, so it still correctly
    // carries every prior spend (section (a)'s swap, (b)'s mint) no matter which session section (c) uses.
    const swapGrant2: SessionGrant = retargetToPolicy(instantiateGrant(conservadorLabV4, `enter-swap:${POOL}`, grantCtx()), mamoruPolicy)
    const swapSession2 = toSmartSession(swapGrant2, { policy: mamoruPolicy, initData: btcMamoruInit })
    const swapPid2 = permissionIdOf(swapSession2)
    const enableTx2 = await ownerExec(lab, relayer, world.a1, { to: address('SmartSession'), data: encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableSessions', args: [[swapSession2]] }) })
    if (!enableTx2.ok) throw new Error('enableSessions (fresh enter-swap for the budget test) reverted')
    world.a1.ledger.activate(swapPid2, swapGrant2)
    const freshSwap = { name: 'enter-swap-v4-fresh', grant: swapGrant2, permissionId: swapPid2 }

    await lab.warp(apConfig.budgetWindowSeconds) // a fresh window; the account+pool TOTAL still carries (a)/(b)'s spend
    await syncLedger()
    const atCap = apConfig.perWindow0 // exactly the per-window budget; also the grant's own per-call cap at this deposit
    const [minOut, limit] = (await lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'swapBounds', args: [world.a1.safe, pool, address('USDC'), atCap] })) as readonly [bigint, bigint]
    const oneSwap = swapExec(atCap, minOut, limit)

    const first = await sendSessionOp(world, world.a1, freshSwap, 't4-budget-one-swap-at-cap', oneSwap)
    expectPrecheck(first, '(c) one swap exactly at the per-window cap: precheck accepts it', 'ACCEPT')
    expectVerdict(first, '(c) the chain includes it', 'INCLUDED')

    await syncLedger() // refreshes Spend: window0 now == perWindow0 on chain
    const second = await sendSessionOp(world, world.a1, freshSwap, 't4-budget-second-swap-refused', oneSwap)
    expectPrecheck(second, '(c) a second identical swap in the same window: precheck refuses it BEFORE anything is sent', 'POLICY_BUDGET')
    expectVerdict(second, '(c) the chain independently refuses it too', 'CHAIN_REJECTED_VALIDATION')
  }

  // --------------------------------------------------------------------------------------------- report

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, mamoruPolicy, safe: world.a1.safe, lines: reportLines, opLog: world.opLog })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t4-fork', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
  exitCode = 1
} finally {
  await handle.stop()
  proxy.stop()
}

console.log('\n=== summary ===')
for (const l of reportLines) console.log(`${l.ok === null ? '-' : l.ok ? '✓' : '✗'} ${l.step}: ${l.detail}`)
process.exit(exitCode)
