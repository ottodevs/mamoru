// Spec 007 (otto/mamoru#151), task T2: measures the production v4 grant builders (packages/policy's
// `grantsV4`/`retargetToPolicy`/`mamoruInitFor` + the extended `toSmartSession`) end to end on a Base fork — the
// full 3-pool grant set (stables, btc-usdc, risk), split into `enableSessions` transactions by
// `splitSessionsByGas`, each measured against Base's per-transaction gas cap (2^24). T1 (t1-fork.ts) did the same
// for a single hand-built pool; this is T2's own fork measurement (spec 007 Tasks T2 "Verify on the fork... that
// a full 3-pool v4 grant set enables in N transactions each under the ceiling, and report the measured gas per
// tx"), reusing T1's deploy/attest plumbing (loadPolicyArtifact, deployMamoruPolicy, resolverUidOf,
// registerMamoruPolicyCall, attestMamoruPolicyCall) from v4-grant.ts — that part needed no porting.
//
// Run (builds the contract, then the scenario):
//   PATH="$HOME/.foundry/bin:$PATH" bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t2-fork.ts'
//
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1-fork.ts.
import { encodeFunctionData, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, safeAbi, smartSessionAbi, swapRouter02Abi, uniswapV3PoolAbi } from '@mamoru/registry'
import {
  computeCaps,
  conservadorLabV4,
  DEFAULT_GAS_MODEL,
  encodeMamoruInit,
  estimateSessionGas,
  instantiateGrant,
  mamoruInitFor,
  RENEWAL_GAS_MODEL,
  retargetToPolicy,
  splitSessionsByGas,
  V4_POOLS,
  type Price,
  type SessionGrant,
  type V4GasModel,
} from '@mamoru/policy'
import { permissionIdOf, revocationCalls, toSmartSession, type SmartSessionStruct } from '@mamoru/account/sessions'
import { OPERATION_CALL, execTransactionData, signSafeTx, type SafeTx } from '@mamoru/account/safe'
import { approve } from '@mamoru/uniswap-v3'
import { Lab, devAccount, type TxResult } from '../fixtures/lab.ts'
import { buildBasicWorld, ownerBatch, WHALE, type AccountFixture, type World } from '../fixtures/world.ts'
import { sendSessionOp } from '../fixtures/session-op.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'
import { attestMamoruPolicyCall, deployMamoruPolicy, loadPolicyArtifact, raiseObservationCardinality } from './v4-grant.ts'

const DEPOSIT_USDC = 100_000_000_000n // 100,000 USDC (spec 007 "Max loss with a leaked key" uses the same example size)
const GAS_CEILING = 14_000_000n // same default as splitSessionsByGas; kept explicit so the report says what it used
const BASE_PER_TX_GAS_CAP = 16_777_216n // 2^24

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
  console.error(`t2-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t2-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})

/** Same as fixtures/world.ts's `ownerExec`, with an explicit gas limit: enabling a near-ceiling batch can need
 * more than that helper's 15M default. */
async function ownerExecGas(lab: Lab, relayer: PrivateKeyAccount, acct: AccountFixture, op: { to: Address; data: Hex }, gas: bigint): Promise<TxResult> {
  const nonce = await lab.client.readContract({ address: acct.safe, abi: safeAbi, functionName: 'nonce' })
  const tx: SafeTx = { to: op.to, value: 0n, data: op.data, operation: OPERATION_CALL, nonce }
  const signature = await signSafeTx(acct.backupOwner, acct.safe, lab.chainId, tx)
  const data = execTransactionData(tx, signature)
  return lab.send(relayer, acct.safe, data, 0n, gas)
}

async function usdcPrice(lab: Lab, pool: string, token0: string, token1: string, asset: string): Promise<Price> {
  const [sqrtPriceX96] = await lab.client.readContract({ address: address(pool), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const ratio: Price = { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n } // token1 per token0, raw units
  if (token0 === 'USDC' && token1 === asset) return ratio
  if (token1 === 'USDC' && token0 === asset) return { num: ratio.den, den: ratio.num }
  throw new Error(`usdcPrice: ${pool} does not pair USDC with ${asset}`)
}

type V4Item = { label: string; grant: SessionGrant; session: SmartSessionStruct; actions: SmartSessionStruct['actions'] }

/** Builds the full 9-session v4 grant set (3 pools x enter-swap/enter-mint/manage-any) at `generation`. */
function buildV4GrantSet(mamoruPolicy: Address, generation: bigint, caps: Record<string, bigint>, account: Address, sessionKey: Address, chainId: number, now: number, nextSalt: () => Hex): V4Item[] {
  const items: V4Item[] = []
  for (const pool of Object.values(V4_POOLS)) {
    const mamoruInit = encodeMamoruInit(mamoruInitFor(pool, generation, caps))
    for (const name of ['enter-swap', 'enter-mint', 'manage-any'] as const) {
      const grant = instantiateGrant(conservadorLabV4, `${name}:${pool.pool}`, {
        account,
        sessionKey,
        chainId,
        salt: nextSalt(),
        validAfter: now - 60,
        validUntil: now + conservadorLabV4.session.validitySeconds,
        caps,
      })
      const retargeted = retargetToPolicy(grant, mamoruPolicy)
      const session = toSmartSession(retargeted, { policy: mamoruPolicy, initData: mamoruInit })
      items.push({ label: `${name}:${pool.pool}`, grant: retargeted, session, actions: session.actions })
    }
  }
  return items
}

async function enableInBatches(lab: Lab, relayer: PrivateKeyAccount, acct: AccountFixture, items: V4Item[], label: string, model: V4GasModel = DEFAULT_GAS_MODEL): Promise<void> {
  const batches = splitSessionsByGas(items, model, GAS_CEILING)
  note(`${label}: split into batches`, true, `${items.length} sessions / ${items.reduce((n, i) => n + i.actions.length, 0)} actions -> ${batches.length} enableSessions transaction(s), ceiling ${GAS_CEILING}`)
  let txIndex = 0
  for (const batch of batches) {
    txIndex++
    const data = encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableSessions', args: [batch.map((i) => i.session)] })
    const modeled = batch.reduce((n, i) => n + estimateSessionGas(i.actions.length, model), 0n)
    const r = await ownerExecGas(lab, relayer, acct, { to: address('SmartSession'), data }, 20_000_000n)
    const names = batch.map((i) => i.label).join(', ')
    note(`${label}: tx ${txIndex}/${batches.length}`, r.ok, r.ok ? `${r.receipt.gasUsed} gas (modeled ${modeled}), sessions: ${names}` : `reverted (${r.hash})`)
    if (!r.ok) throw new Error(`${label}: enableSessions batch ${txIndex} reverted`)
    recordGas(`${label}-tx${txIndex}-actual`, r.receipt.gasUsed)
    note(`${label}: tx ${txIndex} under Base's per-tx cap (2^24)`, r.receipt.gasUsed < BASE_PER_TX_GAS_CAP, `${r.receipt.gasUsed} < ${BASE_PER_TX_GAS_CAP}`)
    note(`${label}: tx ${txIndex} under the configured ceiling`, r.receipt.gasUsed <= GAS_CEILING, `${r.receipt.gasUsed} <= ${GAS_CEILING}`)
  }
}

// ------------------------------------------------------------------------------------------------ setup

const manifest = await loadManifest()
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t2`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  await assertCodeHashes(lab.client)
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}`)

  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, conservadorLabV4, engineNow)
  note('fx-safe', true, `Safe7579 account ${world.a1.safe}, registry trust self-attested (TimeFramePolicy, UsageLimitPolicy)`)

  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, 'pool:USDC/cbBTC/500', 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, 'pool:WETH/USDC/3000', 'WETH', 'USDC', 'WETH'),
  }
  const caps = computeCaps(conservadorLabV4, DEPOSIT_USDC, prices)
  note('caps computed for all 3 pools (computeCaps)', true, `deposit ${DEPOSIT_USDC} raw USDC, ${Object.keys(caps).length} cap formulas`)

  // --------------------------------------------------------------------------------------------- deploy + register the policy (one tx), raise oracle rings

  const artifact = await loadPolicyArtifact()
  const mamoruPolicy = await deployMamoruPolicy(lab, artifact, relayer)
  note('MamoruActionPolicy deployed and registered in one ModuleRegistry.deployModule tx (T6 L-3)', true, mamoruPolicy)

  // T6 L-4: the policy refuses a pool whose observation ring cannot hold the 1,800 s window at 1 s blocks. USDC/USDT
  // has 1,000 at this block: the deploy step raises every pool to 3,600 first (script/Deploy.s.sol).
  for (const p of Object.values(V4_POOLS)) {
    const gas = await raiseObservationCardinality(lab, relayer, address(p.pool), 3_600)
    note(`observationCardinalityNext >= 3,600: ${p.pool}`, true, gas > 0n ? `${gas} gas` : 'already there')
    if (gas > 0n) recordGas(`raise-cardinality-${p.pool}`, gas)
  }

  // self-attest, through the SAME owner batch pattern the app would use (registryTrustCalls already ran in fx-safe)
  const attestTx = await ownerExecGas(lab, relayer, world.a1, attestMamoruPolicyCall(mamoruPolicy), 2_000_000n)
  note('self-attest MamoruActionPolicy (per account)', attestTx.ok, attestTx.ok ? `${attestTx.receipt.gasUsed} gas` : 'reverted')
  if (!attestTx.ok) throw new Error('attest reverted')

  // --------------------------------------------------------------------------------------------- generation 1: full 3-pool v4 grant set, split + enabled

  const sessionKey1 = devAccount(5).address // same slot buildBasicWorld would use for A1's session key (fx-safe deployAccount(.., 5))
  let saltCounter = 0
  const nextSalt = (): Hex => {
    saltCounter++
    return `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex
  }
  const now1 = await engineNow()
  const gen1 = buildV4GrantSet(mamoruPolicy, 1n, caps, world.a1.safe, sessionKey1, lab.chainId, now1, nextSalt)
  note('generation 1: grant set built', true, `${gen1.length} sessions (enter-swap/enter-mint/manage-any x 3 pools), ${gen1.reduce((n, i) => n + i.actions.length, 0)} actions total`)
  for (const i of gen1) note(`  session: ${i.label}`, null, `${i.actions.length} actions`)
  await enableInBatches(lab, relayer, world.a1, gen1, 'enable-gen1')

  // --------------------------------------------------------------------------------------------- functional smoke check: the btc enter-swap grant actually works

  {
    const btcSwap = gen1.find((i) => i.label === `enter-swap:${V4_POOLS.btc.pool}`)!
    const permissionId = permissionIdOf(btcSwap.session)
    world.a1.ledger.activate(permissionId, btcSwap.grant)
    world.a1.grants.push({ name: btcSwap.label, grant: btcSwap.grant, permissionId })
    await lab.whaleTransfer('USDC', WHALE, world.a1.safe, 20_000_000_000n)
    const policyAbi = artifact.abi
    const [minOut, limit] = (await lab.client.readContract({
      address: mamoruPolicy,
      abi: policyAbi,
      functionName: 'swapBounds',
      args: [world.a1.safe, address(V4_POOLS.btc.pool), address('USDC'), 10_000_000_000n],
    })) as readonly [bigint, bigint]
    const out = await sendSessionOp(world, world.a1, { name: btcSwap.label, grant: btcSwap.grant, permissionId }, 'engine-op-swap-v4', [
      approve('USDC', 'SwapRouter02', 10_000_000_000n),
      {
        to: address('SwapRouter02'),
        data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC'), tokenOut: address('cbBTC'), fee: 500, recipient: world.a1.safe, amountIn: 10_000_000_000n, amountOutMinimum: minOut, sqrtPriceLimitX96: limit }] }),
      },
    ])
    note('functional check: production-built v4 enter-swap session, 10,000 USDC -> cbBTC within band', out.verdict === 'INCLUDED', `${out.verdict}${out.failedOp?.reason ? ` (${out.failedOp.reason})` : ''}`)
  }

  // --------------------------------------------------------------------------------------------- generation 2: renewal, full grant set again

  const sessionKey2 = devAccount(6).address
  const now2 = await engineNow()
  const gen2 = buildV4GrantSet(mamoruPolicy, 2n, caps, world.a1.safe, sessionKey2, lab.chainId, now2, nextSalt)
  await enableInBatches(lab, relayer, world.a1, gen2, 'enable-gen2-renewal', RENEWAL_GAS_MODEL)

  // the generation-1 session is retired by the policy's own generation check, even before removeSession
  {
    const btcSwap1 = gen1.find((i) => i.label === `enter-swap:${V4_POOLS.btc.pool}`)!
    const pid1 = permissionIdOf(btcSwap1.session)
    const out = await sendSessionOp(world, world.a1, { name: btcSwap1.label, grant: btcSwap1.grant, permissionId: pid1 }, 'renewal-old-session-after-gen2', [
      approve('USDC', 'SwapRouter02', 1_000_000n),
    ])
    note('(d) generation-1 session refused after generation-2 renewal (policy-level, not SmartSession)', out.verdict === 'CHAIN_REJECTED_VALIDATION', `${out.verdict} validator=${out.validator}`)
  }

  const gen1PermissionIds = gen1.map((i) => permissionIdOf(i.session))
  const revoke = await ownerBatch(lab, relayer, world.a1, revocationCalls(gen1PermissionIds))
  note('removeSession: all 9 generation-1 permissionIds (defense in depth)', revoke.ok, revoke.ok ? `${revoke.receipt.gasUsed} gas` : 'reverted')
  if (revoke.ok) recordGas('renewal-removeSession-gen1-all', revoke.receipt.gasUsed)

  // --------------------------------------------------------------------------------------------- report

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, mamoruPolicy, safe: world.a1.safe, gas: gasReport, lines: reportLines })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t2-fork', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
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
