// Spec 007 (otto/mamoru#151), task T1: "the TS scenario fixtures enable a v4 grant with both policies on a fork
// and run the engine's ops and the three attacks through handleOps; measure enable and renewal gas."
//
// What the Foundry PoC (contracts/action-policy) does not show, and this script does: a real Safe7579 account,
// the deployed SmartSession (0x00000000002B0eCfbD0496EE71e01257dA0E37DE on Base) with TWO action policies per
// action (UniActionPolicy + MamoruActionPolicy), ERC-7484 attestation as the deployed setup requires, and every
// op and attack sent as a batch userOp through EntryPoint.handleOps — not a direct `checkAction` call.
//
// Run (builds the contract, then the scenario):
//   nix shell nixpkgs#foundry --command bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t1-fork.ts'
//
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org, same as the Foundry tests), through the loopback
// proxy so the upstream URL never reaches anvil's argv or this script's own log output.
import { encodeFunctionData, maxUint256, parseEventLogs, type Hex, type TransactionReceipt } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, erc20Abi, nonfungiblePositionManagerAbi, smartSessionAbi, swapRouter02Abi } from '@mamoru/registry'
import { conservadorLabGeometryV1, instantiateGrant, type Caps, type SessionGrant } from '@mamoru/policy'
import { approve, collect, decreaseLiquidity } from '@mamoru/uniswap-v3'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { permissionIdOf, revocationCalls } from '@mamoru/account/sessions'
import { Lab, devAccount } from '../fixtures/lab.ts'
import { buildBasicWorld, ownerBatch, ownerExec, ownerMint, poolTick, rangeAround, WHALE, type World } from '../fixtures/world.ts'
import { sendSessionOp, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'
import { attestMamoruPolicyCall, buildV4EnterSwap, buildV4ManageAny, deployMamoruPolicy, encodeMamoruInit, loadPolicyArtifact, registerMamoruPolicyCall, resolverUidOf, type MamoruInit } from './v4-grant.ts'

const POOL = 'pool:USDC/cbBTC/500'
const BAND_TICKS = 100 // = execution.maxTwapDeviationTicks (spec 007 table)
const TWAP_WINDOW = 1800 // seconds
const BUDGET_WINDOW = 86_400 // 1 day
// Same numbers as the Foundry PoC (contracts/action-policy/test/MamoruActionPolicy.t.sol `_init`), so behaviour
// and (roughly) gas are comparable across the two harnesses.
const PER_WINDOW_USDC = 60_000_000_000n
const PER_WINDOW_CBBTC = 60_000_000n
const TOTAL_USDC = 180_000_000_000n
const TOTAL_CBBTC = 180_000_000n

// ------------------------------------------------------------------------------------------------ reporting

type Line = { step: string; ok: boolean | null; detail: string }
const reportLines: Line[] = []
const gasReport: Record<string, string> = {}
const t0 = Date.now()
let exitCode = 0

function note(step: string, ok: boolean | null, detail: string): void {
  reportLines.push({ step, ok, detail })
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${ok === null ? 'info' : ok ? 'ok  ' : 'FAIL'} ${step}: ${detail}`)
  if (ok === false) exitCode = 1
}

function recordGas(label: string, used: bigint): void {
  gasReport[label] = used.toString()
  note(`gas: ${label}`, null, `${used}`)
}

process.on('uncaughtException', (e) => {
  console.error(`t1-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t1-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})

function expect(outcome: SessionOpOutcome, label: string, want: SessionOpOutcome['verdict']): SessionOpOutcome {
  const ok = outcome.verdict === want
  const extra = [
    outcome.failedOp?.reason ? `reason=${outcome.failedOp.reason}` : undefined,
    outcome.failedOp?.inner ? `inner=${outcome.failedOp.inner}` : undefined,
    outcome.validator ? `validator=${outcome.validator}` : undefined,
    outcome.actualGasCost !== undefined ? `actualGasCost=${outcome.actualGasCost}` : undefined,
  ]
    .filter(Boolean)
    .join(' ')
  note(label, ok, `${outcome.verdict}${extra ? ` (${extra})` : ''}`)
  return outcome
}

function mintedPosition(receipt: TransactionReceipt, safe: Address): { tokenId: bigint; liquidity: bigint } {
  const npm = address('NonfungiblePositionManager')
  const transfers = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: receipt.logs, eventName: 'Transfer' })
  const t = transfers.find((l) => l.address.toLowerCase() === npm.toLowerCase() && l.args.to.toLowerCase() === safe.toLowerCase())
  if (!t) throw new Error('no position minted to the account (no NPM Transfer log)')
  const incs = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: receipt.logs, eventName: 'IncreaseLiquidity' })
  const inc = incs.find((l) => l.args.tokenId === t.args.tokenId)
  if (!inc) throw new Error('no IncreaseLiquidity log for the minted position')
  return { tokenId: t.args.tokenId, liquidity: inc.args.liquidity }
}

// ------------------------------------------------------------------------------------------------ setup

const manifest = await loadManifest()
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t1`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  await assertCodeHashes(lab.client)
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId} (harness pin; the Foundry PoC pins 52,700,000 — see report)`)

  const relayer = devAccount(0)
  const policy = conservadorLabGeometryV1 // chain: 'fork'; carries enter-swap/manage-any grant templates for the btc pool
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, policy, engineNow)
  note('fx-safe', true, `Safe7579 account ${world.a1.safe}, passkey + backup owner, SmartSession installed, registry trust self-attested (TimeFramePolicy, UsageLimitPolicy)`)

  // More headroom than buildBasicWorld's default 10,000 USDC: swap (10k) + mint (20k) + a safety margin. The
  // budget-attack's 75k of calldata is never executed (refused at validation), so it needs no funding.
  await lab.whaleTransfer('USDC', WHALE, world.a1.safe, 100_000_000_000n)
  await lab.whaleTransfer('cbBTC', WHALE, world.a1.safe, 30_000_000n) // 0.3 cbBTC
  note('fx-usdc / fx-cbbtc top-up', true, 'A1 funded with 110,000 USDC and 0.3 cbBTC total')

  // --------------------------------------------------------------------------------------------- deploy the policy

  const artifact = await loadPolicyArtifact()
  const mamoruPolicy = await deployMamoruPolicy(lab, artifact, relayer)
  note('MamoruActionPolicy deployed', true, mamoruPolicy)
  const policyAbi = artifact.abi
  const pool = address(POOL)

  const swapBounds = async (amountIn: bigint) =>
    lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'swapBounds', args: [world.a1.safe, pool, address('USDC'), amountIn] }) as Promise<readonly [bigint, bigint]>
  const decreaseMins = async (tokenId: bigint, liquidity: bigint) =>
    lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'decreaseMins', args: [world.a1.safe, pool, tokenId, liquidity] }) as Promise<readonly [bigint, bigint]>
  const admittedPoolOf = async (tokenId: bigint) => lab.client.readContract({ address: mamoruPolicy, abi: policyAbi, functionName: 'admittedPool', args: [world.a1.safe, tokenId] }) as Promise<Address>

  // --------------------------------------------------------------------------------------------- self-attest + enable (generation 1)

  const mamoruInitAt = (generation: bigint): Hex => {
    const init: MamoruInit = { pool, twapWindow: TWAP_WINDOW, bandTicks: BAND_TICKS, generation, budgetWindow: BUDGET_WINDOW, perWindow0: PER_WINDOW_USDC, perWindow1: PER_WINDOW_CBBTC, total0: TOTAL_USDC, total1: TOTAL_CBBTC }
    return encodeMamoruInit(init)
  }

  const now0 = Number(await lab.timestamp())
  const caps: Caps = {
    btcSwapPerCall: 50_000_000_000n,
    btcSwapTotal: 200_000_000_000n, // UniActionPolicy's own ceiling; MamoruActionPolicy's own window/total budget binds first
    btcMint0: 30_000_000_000n,
    btcMint1: 50_000_000n,
    btcConvertPerCall: 50_000_000n,
    btcConvertTotal: 50_000_000n,
  }
  let saltCounter = 0
  const nextSalt = (): Hex => {
    saltCounter++
    return `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex
  }
  const grantCtx = (sessionKey: Address) => ({
    account: world.a1.safe,
    sessionKey,
    chainId: lab.chainId,
    salt: nextSalt(),
    validAfter: now0 - 60,
    validUntil: now0 + policy.session.validitySeconds,
    caps,
    tokenId: undefined,
    admittedTokenIds: [],
  })

  const swapGrant1: SessionGrant = instantiateGrant(policy, `enter-swap:${POOL}`, grantCtx(world.a1.sessionKey.address))
  const manageGrant1: SessionGrant = instantiateGrant(policy, `manage-any:${POOL}`, grantCtx(world.a1.sessionKey.address))
  const mamoruInit1 = mamoruInitAt(1n)
  const v4Swap1 = buildV4EnterSwap(swapGrant1, mamoruPolicy, mamoruInit1)
  const v4Manage1 = buildV4ManageAny(manageGrant1, mamoruPolicy, mamoruInit1)
  const swapPid1 = permissionIdOf(v4Swap1)
  const managePid1 = permissionIdOf(v4Manage1)

  // ERC-7484: a brand-new module address has no ModuleRecord, and `attest` reverts for it (found empirically —
  // custom error 0x4eb2dcd7, the module address as its only arg). `registerModule` is a one-time, per-CONTRACT
  // cost (not per account); production (T7) would pay it once at deploy time, under the same resolverUID the
  // already-deployed policies use. Only then can an account self-attest it, same as TimeFramePolicy/UsageLimitPolicy.
  const resolverUID = await resolverUidOf(lab, address('TimeFramePolicy'))
  const registerTx = await lab.send(relayer, address('ModuleRegistry'), registerMamoruPolicyCall(mamoruPolicy, resolverUID).data)
  note('registerModule: MamoruActionPolicy (one-time, per contract, ordinary account)', registerTx.ok, registerTx.ok ? `${registerTx.receipt.gasUsed} gas, resolverUID ${resolverUID}` : 'reverted')
  if (registerTx.ok) recordGas('register-mamoru-policy-one-time', registerTx.receipt.gasUsed)
  else throw new Error('registerModule reverted — MamoruActionPolicy cannot be attested without it')

  // Self-attestation on its own, so its gas (and whether it is even needed) is visible separately from enableSessions.
  const attestTx = await ownerExec(lab, relayer, world.a1, attestMamoruPolicyCall(mamoruPolicy))
  note('self-attest MamoruActionPolicy', attestTx.ok, attestTx.ok ? `${attestTx.receipt.gasUsed} gas` : 'reverted')
  if (attestTx.ok) recordGas('attest-mamoru-policy-per-account', attestTx.receipt.gasUsed)
  else throw new Error('attest (self-attestation) reverted even after registerModule')

  const enableData1 = encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableSessions', args: [[v4Swap1, v4Manage1]] })
  const enable1 = await ownerExec(lab, relayer, world.a1, { to: address('SmartSession'), data: enableData1 })
  note('enableSessions: v4 grants (generation 1, first enable)', enable1.ok, enable1.ok ? `${enable1.receipt.gasUsed} gas, permissionIds ${swapPid1.slice(0, 10)}…, ${managePid1.slice(0, 10)}…` : 'reverted')
  if (enable1.ok) recordGas('enable-v4-gen1-first-enable', enable1.receipt.gasUsed)
  else throw new Error('enableSessions (generation 1) reverted — see report for ERC-7484/attestation findings')

  world.a1.ledger.activate(swapPid1, swapGrant1)
  world.a1.ledger.activate(managePid1, manageGrant1)
  world.a1.grants.push({ name: 'enter-swap-v4', grant: swapGrant1, permissionId: swapPid1 }, { name: 'manage-any-v4', grant: manageGrant1, permissionId: managePid1 })

  // --------------------------------------------------------------------------------------------- engine op 1: a swap within band

  const swapAmountIn = 10_000_000_000n // 10,000 USDC — same as the Foundry PoC's test_normalSwapPasses
  {
    const [minOut, limit] = await swapBounds(swapAmountIn)
    const out = expect(
      await sendSessionOp(world, world.a1, { name: 'enter-swap-v4', grant: swapGrant1, permissionId: swapPid1 }, 'engine-op-swap', [
        approve('USDC', 'SwapRouter02', swapAmountIn),
        { to: address('SwapRouter02'), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.a1.safe, amountIn: swapAmountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: limit }] }) },
      ]),
      'engine op 1: swap 10,000 USDC -> cbBTC within band',
      'INCLUDED',
    )
    if (out.receipt) recordGas('op-swap', out.receipt.gasUsed)
  }

  // --------------------------------------------------------------------------------------------- engine op 2: a mint through the policy

  let tokenId = 0n
  let liquidity = 0n
  {
    const { tick } = await poolTick(lab)
    const { tickLower, tickUpper } = rangeAround(tick, 1200, 10)
    const deadline = BigInt(Number(await lab.timestamp()) + 3600)
    const mintUsdc = 20_000_000_000n
    const mintCbbtc = 20_000_000n
    const mintParams = { token0: address('USDC'), token1: address('cbBTC'), fee: 500, tickLower, tickUpper, amount0Desired: mintUsdc, amount1Desired: mintCbbtc, amount0Min: 0n, amount1Min: 0n, recipient: world.a1.safe, deadline }
    const out = expect(
      await sendSessionOp(world, world.a1, { name: 'manage-any-v4', grant: manageGrant1, permissionId: managePid1 }, 'engine-op-mint', [
        { to: address('USDC'), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [mamoruPolicy, mintUsdc] }) },
        { to: address('cbBTC'), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [mamoruPolicy, mintCbbtc] }) },
        { to: mamoruPolicy, data: encodeFunctionData({ abi: policyAbi, functionName: 'mint', args: [mintParams] }) },
      ]),
      'engine op 2: mint 20,000 USDC + 0.2 cbBTC through MamoruActionPolicy.mint',
      'INCLUDED',
    )
    if (out.receipt) recordGas('op-mint', out.receipt.gasUsed)
    if (out.verdict === 'INCLUDED' && out.receipt) {
      ;({ tokenId, liquidity } = mintedPosition(out.receipt, world.a1.safe))
      const admitted = await admittedPoolOf(tokenId)
      note('minted position admitted by the policy', admitted.toLowerCase() === pool.toLowerCase(), `tokenId ${tokenId}, liquidity ${liquidity}, admittedPool ${admitted}`)
      world.a1.managedTokenIds.push(tokenId)
    }
  }

  // --------------------------------------------------------------------------------------------- engine op 3: decrease + collect

  if (tokenId > 0n) {
    const [min0, min1] = await decreaseMins(tokenId, liquidity)
    const deadline = BigInt(Number(await lab.timestamp()) + 3600)
    const out = expect(
      await sendSessionOp(world, world.a1, { name: 'manage-any-v4', grant: manageGrant1, permissionId: managePid1 }, 'engine-op-decrease-collect', [
        decreaseLiquidity({ tokenId, liquidity, amount0Min: min0, amount1Min: min1, deadline }),
        collect({ account: world.a1.safe, tokenId }),
      ]),
      'engine op 3: decrease full liquidity + collect',
      'INCLUDED',
    )
    if (out.receipt) recordGas('op-decrease-collect', out.receipt.gasUsed)
  }

  // --------------------------------------------------------------------------------------------- attack (b): manage-any on a position the Safe did not mint through the policy

  {
    const unrelated = await ownerMint(world, world.a1, 5_000_000_000n, 5_000_000n) // owner-minted directly on NPM, never admitted
    const deadline = BigInt(Number(await lab.timestamp()) + 3600)
    const out = expect(
      await sendSessionOp(world, world.a1, { name: 'manage-any-v4', grant: manageGrant1, permissionId: managePid1 }, 'attack-unadmitted-nft-decrease', [decreaseLiquidity({ tokenId: unrelated, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline })]),
      `attack (b): decreaseLiquidity on tokenId ${unrelated} (Safe-owned, never minted through the policy) must be refused`,
      'CHAIN_REJECTED_VALIDATION',
    )
    note('  (b) detail', out.validator?.includes('PolicyViolation') ?? false, `UniActionPolicy's own rule (tokenId > 0) would pass this calldata; MamoruActionPolicy's admitted-set check is what refuses it — validator says: ${out.validator}`)
  }

  // --------------------------------------------------------------------------------------------- attack (c): batch over budget

  {
    await lab.warp(BUDGET_WINDOW) // fresh window, so the test is not sensitive to engine-op-1's prior spend
    const amountIn = 25_000_000_000n // 25,000 USDC; per-window budget is 60,000
    const [minOut, limit] = await swapBounds(amountIn)
    const swapCall = (n: bigint) => ({ to: address('SwapRouter02') as Address, data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.a1.safe, amountIn: n, amountOutMinimum: minOut, sqrtPriceLimitX96: limit }] }) })
    const out = expect(
      await sendSessionOp(world, world.a1, { name: 'enter-swap-v4', grant: swapGrant1, permissionId: swapPid1 }, 'attack-batch-over-budget', [
        approve('USDC', 'SwapRouter02', amountIn),
        swapCall(amountIn),
        approve('USDC', 'SwapRouter02', amountIn),
        swapCall(amountIn),
        approve('USDC', 'SwapRouter02', amountIn),
        swapCall(amountIn),
      ]),
      'attack (c): a batch of three 25,000 USDC swaps (75,000 total) in one window (budget 60,000) must be refused',
      'CHAIN_REJECTED_VALIDATION',
    )
    note('  (c) detail', out.validator?.includes('PolicyViolation') ?? false, `each 25,000 swap individually fits UniActionPolicy's per-call/cumulative caps; MamoruActionPolicy's per-window budget refuses the whole batch when the third call would push window spend to 75,000 > 60,000 — validator says: ${out.validator}`)
  }

  // --------------------------------------------------------------------------------------------- attack (a): a manipulated-price swap

  {
    const snap = await lab.snapshot()
    try {
      await lab.whaleTransfer('USDC', WHALE, world.attacker.address, 5_000_000_000_000n) // 5,000,000 USDC
      const { tick: spotBefore } = await poolTick(lab)
      const target = spotBefore - 500
      const limitAtTarget = sqrtRatioAtTick(target)
      const before = await lab.balanceOf('USDC', world.attacker.address)
      await lab.send(world.attacker, address('USDC'), encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address('SwapRouter02'), maxUint256] }))
      await lab.send(world.attacker, address('SwapRouter02'), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.attacker.address, amountIn: 5_000_000_000_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: limitAtTarget }] }))
      const spent = before - (await lab.balanceOf('USDC', world.attacker.address))
      const { tick: spotAfter } = await poolTick(lab)
      note('attacker pushes USDC/cbBTC by ~500 ticks', true, `spot ${spotBefore} -> ${spotAfter}, spent ${spent} raw USDC (${(Number(spent) / 1e6).toFixed(0)} USDC); same block, so the 1800s TWAP is unchanged`)

      // Today's grant shape (amountOutMinimum = 1, sqrtPriceLimitX96 = 0): refused at validation.
      const looseAmount = 10_000_000_000n
      const loose = expect(
        await sendSessionOp(world, world.a1, { name: 'enter-swap-v4', grant: swapGrant1, permissionId: swapPid1 }, 'attack-manipulated-swap-loose', [
          approve('USDC', 'SwapRouter02', looseAmount),
          { to: address('SwapRouter02'), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.a1.safe, amountIn: looseAmount, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] }) },
        ]),
        'attack (a.1): today\'s grant (amountOutMinimum=1, sqrtPriceLimitX96=0) must be refused at validation',
        'CHAIN_REJECTED_VALIDATION',
      )
      note('  (a.1) detail', loose.validator?.includes('PolicyViolation') ?? false, `validator says: ${loose.validator}`)

      // A policy-compliant minimum/limit (from swapBounds, at the unchanged TWAP) passes validation but cannot fill
      // at the manipulated spot: it reverts in the router at execution.
      const [tightMin, tightLimit] = await swapBounds(looseAmount)
      const tight = expect(
        await sendSessionOp(world, world.a1, { name: 'enter-swap-v4', grant: swapGrant1, permissionId: swapPid1 }, 'attack-manipulated-swap-tight', [
          approve('USDC', 'SwapRouter02', looseAmount),
          { to: address('SwapRouter02'), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.a1.safe, amountIn: looseAmount, amountOutMinimum: tightMin, sqrtPriceLimitX96: tightLimit }] }) },
        ]),
        'attack (a.2): a policy-compliant minimum passes validation but reverts in the router at the manipulated price',
        'CHAIN_REVERTED_EXECUTION',
      )
      void tight
    } finally {
      await lab.revert(snap)
      note('fork state reverted to before the price-manipulation attack', true, 'budgets, balances and pool price restored')
    }
  }

  // --------------------------------------------------------------------------------------------- (d) renewal retires the old grant

  {
    const renewalKey = devAccount(6)
    const now2 = Number(await lab.timestamp())
    const ctx2 = {
      account: world.a1.safe,
      sessionKey: renewalKey.address,
      chainId: lab.chainId,
      salt: nextSalt(),
      validAfter: now2 - 60,
      validUntil: now2 + policy.session.validitySeconds,
      caps,
      tokenId: undefined,
      admittedTokenIds: [],
    }
    const swapGrant2: SessionGrant = instantiateGrant(policy, `enter-swap:${POOL}`, { ...ctx2, salt: nextSalt() })
    const manageGrant2: SessionGrant = instantiateGrant(policy, `manage-any:${POOL}`, { ...ctx2, salt: nextSalt() })
    const mamoruInit2 = mamoruInitAt(2n)
    const v4Swap2 = buildV4EnterSwap(swapGrant2, mamoruPolicy, mamoruInit2)
    const v4Manage2 = buildV4ManageAny(manageGrant2, mamoruPolicy, mamoruInit2)
    const swapPid2 = permissionIdOf(v4Swap2)
    const managePid2 = permissionIdOf(v4Manage2)

    const enableData2 = encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableSessions', args: [[v4Swap2, v4Manage2]] })
    const enable2 = await ownerExec(lab, relayer, world.a1, { to: address('SmartSession'), data: enableData2 })
    note('enableSessions: v4 grants (generation 2, renewal)', enable2.ok, enable2.ok ? `${enable2.receipt.gasUsed} gas, old permissionIds NOT removed yet` : 'reverted')
    if (enable2.ok) recordGas('enable-v4-gen2-renewal', enable2.receipt.gasUsed)
    else throw new Error('enableSessions (generation 2, renewal) reverted')

    // The old session is still "enabled" at the SmartSession level (removeSession not sent yet): only
    // MamoruActionPolicy's own generation check can be refusing it, proving spec 007's "(d) renewal" claim that
    // the generation alone retires older configs of this policy even if a removeSession were missing.
    const [oldMin, oldLimit] = await swapBounds(1_000_000_000n)
    const oldOut = expect(
      await sendSessionOp(world, world.a1, { name: 'enter-swap-v4', grant: swapGrant1, permissionId: swapPid1 }, 'renewal-old-session-after-gen2', [
        approve('USDC', 'SwapRouter02', 1_000_000_000n),
        { to: address('SwapRouter02'), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.a1.safe, amountIn: 1_000_000_000n, amountOutMinimum: oldMin, sqrtPriceLimitX96: oldLimit }] }) },
      ]),
      '(d) the generation-1 session (still SmartSession-enabled) is refused after the generation-2 renewal',
      'CHAIN_REJECTED_VALIDATION',
    )
    note('  (d) detail: refused by the policy, not by SmartSession', oldOut.validator?.includes('PolicyViolation') ?? false, `validator says: ${oldOut.validator}`)

    world.a1.ledger.activate(swapPid2, swapGrant2)
    world.a1.ledger.activate(managePid2, manageGrant2)
    world.a1.grants.push({ name: 'enter-swap-v4-gen2', grant: swapGrant2, permissionId: swapPid2 }, { name: 'manage-any-v4-gen2', grant: manageGrant2, permissionId: managePid2 })
    world.a1.sessionKey = renewalKey // the account's active session key after the renewal
    const newOut = expect(
      await sendSessionOp(
        world,
        world.a1,
        { name: 'enter-swap-v4-gen2', grant: swapGrant2, permissionId: swapPid2 },
        'renewal-new-session',
        [
          approve('USDC', 'SwapRouter02', 1_000_000_000n),
          { to: address('SwapRouter02'), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.a1.safe, amountIn: 1_000_000_000n, amountOutMinimum: oldMin, sqrtPriceLimitX96: oldLimit }] }) },
        ],
        { sessionKey: renewalKey },
      ),
      '(d) the generation-2 session (fresh key) works',
      'INCLUDED',
    )
    if (newOut.receipt) recordGas('op-swap-after-renewal', newOut.receipt.gasUsed)

    const revoke = await ownerBatch(lab, relayer, world.a1, revocationCalls([swapPid1, managePid1]))
    note('removeSession: old generation-1 permissionIds (defense in depth, as spec 007 "Re-approval UX" prescribes)', revoke.ok, revoke.ok ? `${revoke.receipt.gasUsed} gas` : 'reverted')
    if (revoke.ok) recordGas('renewal-removeSession-old', revoke.receipt.gasUsed)
    world.a1.ledger.revoke(swapPid1)
    world.a1.ledger.revoke(managePid1)
  }

  // --------------------------------------------------------------------------------------------- report

  const ops = world.opLog.map((o) => `${o.batch}:${o.verdict}`)
  note('session operation log', null, ops.join(' | '))
  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, mamoruPolicy, safe: world.a1.safe, gas: gasReport, lines: reportLines, opLog: world.opLog })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t1-fork', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
  exitCode = 1
} finally {
  await handle.stop()
  proxy.stop()
}

console.log('\n=== gas summary ===')
for (const [k, v] of Object.entries(gasReport)) console.log(`${k}: ${v}`)
console.log('\n=== summary ===')
for (const l of reportLines) console.log(`${l.ok === null ? '-' : l.ok ? '✓' : '✗'} ${l.step}: ${l.detail}`)
process.exit(exitCode)
