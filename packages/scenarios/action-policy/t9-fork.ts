// otto/mamoru#210: the vault-supply grants of conservador-lab-v7 end to end on a Base fork, through the real
// SmartSession + Safe7579 stack and the builders the operator's activation uses (`instantiateGrant`, `computeCaps`,
// `v4PoliciesFor`, `activationBatch`, `engineGas`), never hand-built sessions. Like t8-fork.ts:
//   1. deploy on the local fork only: Deploy.s.sol (V1 + MamoruGasPolicy) and DeployV2.s.sol (V2, GUARDIAN a dev
//      account), then MamoruPauseGate(SmartSession, V2) through ModuleRegistry.deployModule (the same call
//      DeployPauseGate.s.sol makes, which names the live V2 address, so it cannot be used against a fresh local V2);
//   2. a funded Safe7579 account; ONLY the two vault-supply grants (gtUSDCp, waBasUSDC) activated at a 1,000 USDC cap in
//      one owner transaction, with the pause gate as second action policy and MamoruGasPolicy as userOp policy;
//   3. session userOp approve(500 USDC) + gtUSDCp.deposit(500 USDC, safe) is included: shares > 0, convertToAssets
//      ~ 500 USDC, USDC down by exactly 500;
//   4. refused at validation: deposit with another receiver, deposit above the per-call cap (700 > 600), redeem with
//      another receiver, redeem with another owner, deposit into steakUSDC (not granted), gtUSDCp.withdraw (not granted);
//   5. the guardian pauses the account on V2: the deposit and the redeem are refused; unpaused, redeem(all shares,
//      safe, safe) is included and USDC comes back (>= 500 USDC - 2 units);
//   6. the same deposit + redeem cycle on waBasUSDC (Aave static aToken, 6 decimals);
//   7. gas of every included userOp (#186 assumed deposit ~797k, redeem ~783k) and a summary; exit code = failed checks.
//
// Run (builds the contracts, then the scenario):
//   export BASE_FORK_RPC_URL="$(. ~/.config/mamoru/alchemy.env && echo $BASE_RPC_URL)"   # or any Base archive RPC
//   nix shell nixpkgs#foundry --command bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent'
//   PATH="$HOME/.foundry/bin:$PATH" bun packages/scenarios/action-policy/t9-fork.ts
// (the scenario needs the pinned anvil 1.7.1 of ~/.foundry/bin; nixpkgs' foundry reports 1.7.1-dev and is refused.)
// Fork block: head - 20, or T9_FORK_BLOCK, because scenarios/manifest.json's pin (51811000) predates V2 on Base.
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1..t8.
import { join } from 'node:path'
import { concat, encodeAbiParameters, encodeFunctionData, getAddress, pad, parseAbi, toHex, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, erc20Abi, erc4626Abi, mamoruActionPolicyV2Abi, moduleRegistryAbi, uniswapV3PoolAbi, baseRegistry } from '@mamoru/registry'
import { V4_GAS_CAPS, computeCaps, conservadorLabV7, grantKey, instantiateGrant, v4BudgetCaps, withActionPolicy, type Price } from '@mamoru/policy'
import { v4DeploymentOf, v4PoliciesFor, type V4Deployment } from '@mamoru/account/sessions'
import { activationBatch, type LiveAccount } from '@mamoru/account/live'
import { OPERATION_CALL, execTransactionData, multiSendCallOnly, signSafeTx, type MultiSendCall, type SafeTx } from '@mamoru/account/safe'
import { safeAbi } from '@mamoru/registry'
import { ANVIL_DEV_KEYS, Lab, devAccount, type TxResult } from '../fixtures/lab.ts'
import { buildBasicWorld, type World } from '../fixtures/world.ts'
import { sendSessionOp, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { engineGas } from '../driver/engine.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'

const CAP_USDC = 1_000_000_000n // 1,000 USDC
const STEAK = '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183'.toLowerCase() as Address
const VAULTS = ['vault:gtUSDCp', 'vault:waBasUSDC'] as const
const withdrawAbi = parseAbi(['function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)'])
const registryDeployAbi = parseAbi(['function deployModule(bytes32 salt, bytes32 resolverUID, bytes initCode, bytes metadata, bytes resolverContext) payable returns (address)'])

type Line = { step: string; ok: boolean | null; detail: string }
const reportLines: Line[] = []
const gas: Record<string, string> = {}
const t0 = Date.now()
let failed = 0

function note(step: string, ok: boolean | null, detail: string): void {
  reportLines.push({ step, ok, detail })
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${ok === null ? 'info' : ok ? 'ok  ' : 'FAIL'} ${step}: ${detail}`)
  if (ok === false) failed++
}

process.on('uncaughtException', (e) => {
  console.error(`t9-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(failed + 1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t9-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(failed + 1)
})

async function ownerCalls(lab: Lab, relayer: PrivateKeyAccount, acct: World['a1'], calls: MultiSendCall[]): Promise<TxResult> {
  const nonce = await lab.client.readContract({ address: acct.safe, abi: safeAbi, functionName: 'nonce' })
  const op = (calls.length === 1 ? { to: calls[0]!.to, data: calls[0]!.data, operation: OPERATION_CALL } : multiSendCallOnly(calls)) as { to: Address; data: Hex; operation: 0 | 1 }
  const tx: SafeTx = { to: op.to, value: 0n, data: op.data, operation: op.operation, nonce }
  const data = execTransactionData(tx, await signSafeTx(acct.backupOwner, acct.safe, lab.chainId, tx))
  return lab.send(relayer, acct.safe, data, 0n, 20_000_000n)
}

async function usdcPrice(lab: Lab, pool: string, token0: string, token1: string, asset: string): Promise<Price> {
  const [sqrtPriceX96] = await lab.client.readContract({ address: address(pool, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const ratio: Price = { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n }
  if (token0 === 'USDC' && token1 === asset) return ratio
  if (token1 === 'USDC' && token0 === asset) return { num: ratio.den, den: ratio.num }
  throw new Error(`usdcPrice: ${pool} does not pair USDC with ${asset}`)
}

/** `forge script <script>` against the local anvil only. */
async function forgeScript(rpcUrl: string, script: string, deployer: PrivateKeyAccount, key: Hex, env: Record<string, string>): Promise<string> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(rpcUrl)) throw new Error(`refusing to broadcast anywhere but the local fork (${rpcUrl})`)
  const forge = Bun.which('forge') ?? join(process.env.HOME ?? '', '.foundry/bin/forge')
  const r = Bun.spawn([forge, 'script', script, '--rpc-url', rpcUrl, '--broadcast', '--private-key', key, '--sender', deployer.address, '--slow', '--skip-simulation', '--rpc-timeout', '900', '--timeout', '900'], {
    cwd: join(REPO_ROOT, 'contracts/action-policy'),
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited])
  const out = `${stdout}\n${stderr}`
  if (code !== 0) throw new Error(`forge script ${script} failed (${code}):\n${out.slice(-3000)}`)
  return out
}

// ------------------------------------------------------------------------------------------------ setup

if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
// The manifest's pinned block (scenarios/manifest.json) predates MamoruActionPolicyV2 on Base, so the registry code-hash
// check fails there. This scenario forks a recent block instead (T9_FORK_BLOCK, default head - 20); the pin stays as is.
const baseManifest = await loadManifest()
const rpcCall = async <T>(method: string, params: unknown[]): Promise<T> =>
  ((await (await fetch(process.env.BASE_FORK_RPC_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: T }).result
const forkBlock = process.env.T9_FORK_BLOCK ? Number(process.env.T9_FORK_BLOCK) : Number(await rpcCall<string>('eth_blockNumber', [])) - 20
const forkHead = await rpcCall<{ hash: Hex; timestamp: string }>('eth_getBlockByNumber', [`0x${forkBlock.toString(16)}`, false])
const manifest = { ...baseManifest, fork: { ...baseManifest.fork, block: forkBlock, blockHash: forkHead.hash, timestamp: Number(BigInt(forkHead.timestamp)) } }
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t9`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  await assertCodeHashes(lab.client, baseRegistry)
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}`)
  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)

  // ---------------------------------------------------------------------------------------------- 1. deploy

  const deployerKey = ANVIL_DEV_KEYS[9] as Hex
  const deployer = devAccount(9)
  const guardian = devAccount(8)
  const outV1 = await forgeScript(handle.url, 'script/Deploy.s.sol', deployer, deployerKey, { POLICY_SALT_NONCE: '7', GAS_POLICY_SALT_NONCE: '8', CARDINALITY_TARGET: '3600' })
  const gasPolicy = /MamoruGasPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(outV1)?.[1] as Address
  const outV2 = await forgeScript(handle.url, 'script/DeployV2.s.sol', deployer, deployerKey, { GUARDIAN: guardian.address, POLICY_V2_SALT_NONCE: '9', CARDINALITY_TARGET: '3600' })
  const v2 = /MamoruActionPolicyV2:\s*(0x[0-9a-fA-F]{40})/.exec(outV2)?.[1] as Address
  if (!gasPolicy || !v2) throw new Error('forge scripts printed no addresses')
  note('Deploy.s.sol + DeployV2.s.sol --broadcast on the local fork', true, `MamoruGasPolicy ${gasPolicy}, V2 ${v2}`)

  // MamoruPauseGate(SmartSession, V2) through ModuleRegistry.deployModule, as DeployPauseGate.s.sol does.
  const artifact = (await Bun.file(join(REPO_ROOT, 'contracts/action-policy/out/MamoruPauseGate.sol/MamoruPauseGate.json')).json()) as { bytecode: { object: Hex } }
  const registryAddr = address('ModuleRegistry', baseRegistry)
  const reference = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findModule', args: [address('TimeFramePolicy', baseRegistry)] })
  const initCode = concat([artifact.bytecode.object, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [address('SmartSession', baseRegistry), v2])])
  const salt = concat([deployer.address, pad(toHex(4), { size: 12 })])
  const deployData = encodeFunctionData({ abi: registryDeployAbi, functionName: 'deployModule', args: [salt, reference.resolverUID, initCode, '0x', '0x'] })
  const sim = await lab.client.call({ account: deployer.address, to: registryAddr, data: deployData, gas: 8_000_000n })
  const pauseGate = getAddress(`0x${(sim.data ?? '0x').slice(-40)}`) as Address
  const dep = await lab.send(deployer, registryAddr, deployData, 0n, 8_000_000n)
  if (!dep.ok) throw new Error('deployModule(MamoruPauseGate) reverted')
  const gateAbi = parseAbi(['function SMART_SESSION() view returns (address)', 'function ACTION_POLICY() view returns (address)'])
  const ap = await lab.client.readContract({ address: pauseGate, abi: gateAbi, functionName: 'ACTION_POLICY' })
  note('gate.ACTION_POLICY is the local V2', ap.toLowerCase() === v2.toLowerCase(), ap)
  const rec = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findModule', args: [pauseGate] })
  note('MamoruPauseGate deployed via deployModule: record under the deployer and the resolver of Mamoru policies', rec.sender.toLowerCase() === deployer.address.toLowerCase() && rec.resolverUID === reference.resolverUID, `gate ${pauseGate}`)
  const ss = await lab.client.readContract({ address: pauseGate, abi: gateAbi, functionName: 'SMART_SESSION' })
  note('gate.SMART_SESSION is SmartSession', ss.toLowerCase() === address('SmartSession', baseRegistry).toLowerCase(), ss)

  // ---------------------------------------------------------------------------------------------- 2. account + grants

  const p7 = withActionPolicy(conservadorLabV7, v2, [], { gasPolicy: { address: gasPolicy, caps: V4_GAS_CAPS }, contractVersion: 2, pauseGate })
  const d: V4Deployment = v4DeploymentOf(p7)!
  if (d.pauseGate !== pauseGate) throw new Error('v4DeploymentOf lost the pause gate')
  const world: World = await buildBasicWorld(lab, p7, engineNow)
  const safe = world.a1.safe
  note('fx-safe', true, `Safe7579 account ${safe}, ${await lab.balanceOf('USDC', safe)} USDC`)
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, 'pool:USDC/cbBTC/500', 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, 'pool:WETH/USDC/3000', 'WETH', 'USDC', 'WETH'),
  }
  const caps = computeCaps(p7, CAP_USDC, prices)
  const sessionKey = devAccount(5)
  const now = await engineNow()
  const keys = VAULTS.map((v) => `vault-supply:${v}`)
  for (const k of keys) if (!p7.session.grants.some((g) => grantKey(g) === k)) throw new Error(`no grant ${k}`)
  let salt1 = 0
  const grants = keys.map((k) => instantiateGrant(p7, k, { account: safe, sessionKey: sessionKey.address, chainId: lab.chainId, salt: `0x${(++salt1).toString(16).padStart(64, '0')}` as Hex, validAfter: now - 60, validUntil: now + p7.session.validitySeconds, caps, capUsdc: CAP_USDC }))
  const batch = activationBatch({ safe } as LiveAccount, grants, [], { trust: false, policiesFor: v4PoliciesFor(grants, d, 1n, v4BudgetCaps(p7, CAP_USDC), {}), attest: [pauseGate, gasPolicy] })
  const act = await ownerCalls(lab, relayer, world.a1, batch.calls)
  note('activation of the two vault-supply grants (pause gate + gas policy)', act.ok, `${act.receipt.gasUsed} gas, caps perCall ${caps.vaultPerCall} total ${caps.vaultTotal}`)
  if (!act.ok) throw new Error('activation reverted')
  gas['activation-tx'] = act.receipt.gasUsed.toString()
  grants.forEach((g, i) => world.a1.ledger.activate(batch.permissionIds[i]!, g))
  const sessions = Object.fromEntries(VAULTS.map((v, i) => [v, { name: keys[i]!, grant: grants[i]!, permissionId: batch.permissionIds[i]! }]))

  const op = async (label: string, vault: (typeof VAULTS)[number], calls: { to: Address; data: Hex }[]): Promise<SessionOpOutcome> => {
    const eg = engineGas((await lab.client.getBlock()).baseFeePerGas ?? 0n, V4_GAS_CAPS)
    if (!eg) throw new Error('basefee over the gas cap on the fork')
    return sendSessionOp(world, world.a1, sessions[vault]!, label, calls, { gas: eg, sessionKey })
  }
  const verdict = (o: SessionOpOutcome) => `${o.verdict}${o.failedOp?.reason ? ` (${o.failedOp.reason})` : ''}${o.validator ? ` validator=${o.validator}` : ''}`
  const usdc = address('USDC', baseRegistry)
  const approveUsdc = (spender: Address, amount: bigint) => ({ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) })
  const deposit = (v: Address, assets: bigint, receiver: Address) => ({ to: v, data: encodeFunctionData({ abi: erc4626Abi, functionName: 'deposit', args: [assets, receiver] }) })
  const redeem = (v: Address, shares: bigint, receiver: Address, owner: Address) => ({ to: v, data: encodeFunctionData({ abi: erc4626Abi, functionName: 'redeem', args: [shares, receiver, owner] }) })
  const shareBal = (v: Address) => lab.client.readContract({ address: v, abi: erc4626Abi, functionName: 'balanceOf', args: [safe] })
  const stranger = devAccount(7).address as Address
  const A500 = 500_000_000n

  const refused = async (step: string, vault: (typeof VAULTS)[number], calls: { to: Address; data: Hex }[]) => {
    const o = await op(`t9-${step}`, vault, calls)
    note(`refused at validation: ${step}`, o.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(o))
  }

  // One included userOp, with its gas.
  const included = async (label: string, vault: (typeof VAULTS)[number], calls: { to: Address; data: Hex }[]) => {
    const o = await op(label, vault, calls)
    if (o.receipt) gas[label] = o.receipt.gasUsed.toString()
    return o
  }

  // ---------------------------------------------------------------------------------------------- 3..5 gtUSDCp

  const gt = address('vault:gtUSDCp', baseRegistry)
  {
    const u0 = await lab.balanceOf('USDC', safe)
    const o = await included('gtUSDCp-deposit-userop', 'vault:gtUSDCp', [approveUsdc(gt, A500), deposit(gt, A500, safe)])
    const shares = await shareBal(gt)
    const assets = await lab.client.readContract({ address: gt, abi: erc4626Abi, functionName: 'convertToAssets', args: [shares] })
    const u1 = await lab.balanceOf('USDC', safe)
    note('gtUSDCp: approve + deposit(500 USDC, safe) included', o.verdict === 'INCLUDED', `${verdict(o)}, gas ${o.receipt?.gasUsed}`)
    note('gtUSDCp: shares > 0 and convertToAssets within 2 units of 500 USDC', shares > 0n && assets <= A500 + 2n && assets + 2n >= A500, `${shares} shares -> ${assets}`)
    note('gtUSDCp: USDC down by exactly 500', u0 - u1 === A500, `${u0} -> ${u1}`)

    await refused('deposit receiver != safe', 'vault:gtUSDCp', [approveUsdc(gt, A500), deposit(gt, 100_000_000n, stranger)])
    await refused('deposit 700 USDC over the per-call cap', 'vault:gtUSDCp', [approveUsdc(gt, A500), deposit(gt, 700_000_000n, safe)])
    await refused('redeem receiver != safe', 'vault:gtUSDCp', [redeem(gt, shares / 2n, stranger, safe)])
    await refused('redeem owner != safe', 'vault:gtUSDCp', [redeem(gt, shares / 2n, safe, stranger)])
    await refused('steakUSDC.deposit (not granted)', 'vault:gtUSDCp', [deposit(STEAK, 1_000_000n, safe)])
    await refused('gtUSDCp.withdraw (not granted)', 'vault:gtUSDCp', [{ to: gt, data: encodeFunctionData({ abi: withdrawAbi, functionName: 'withdraw', args: [100_000_000n, safe, safe] }) }])

    // 5. guardian pause
    const pause = (fn: 'pause' | 'unpause') => lab.send(guardian, v2, encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: fn, args: [safe] }), 0n, 200_000n)
    const p = await pause('pause')
    note('the guardian pauses the Safe on V2', p.ok && (await lab.client.readContract({ address: v2, abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', args: [safe] })), `gas ${p.receipt.gasUsed}`)
    await refused('paused: deposit', 'vault:gtUSDCp', [approveUsdc(gt, A500), deposit(gt, 100_000_000n, safe)])
    await refused('paused: redeem', 'vault:gtUSDCp', [redeem(gt, shares, safe, safe)])
    const un = await pause('unpause')
    const u2 = await lab.balanceOf('USDC', safe)
    const r = await included('gtUSDCp-redeem-userop', 'vault:gtUSDCp', [redeem(gt, shares, safe, safe)])
    const u3 = await lab.balanceOf('USDC', safe)
    note('unpaused: redeem(all shares, safe, safe) included', un.ok && r.verdict === 'INCLUDED', `${verdict(r)}, gas ${r.receipt?.gasUsed}`)
    note('gtUSDCp: USDC comes back (>= 500 - 2 units), no shares left', u3 - u2 + 2n >= A500 && (await shareBal(gt)) === 0n, `+${u3 - u2} USDC`)
  }

  // ---------------------------------------------------------------------------------------------- 6. waBasUSDC

  {
    const wa = address('vault:waBasUSDC', baseRegistry)
    const u0 = await lab.balanceOf('USDC', safe)
    const o = await included('waBasUSDC-deposit-userop', 'vault:waBasUSDC', [approveUsdc(wa, A500), deposit(wa, A500, safe)])
    const shares = await shareBal(wa)
    const assets = await lab.client.readContract({ address: wa, abi: erc4626Abi, functionName: 'convertToAssets', args: [shares] })
    const u1 = await lab.balanceOf('USDC', safe)
    note('waBasUSDC: approve + deposit(500 USDC, safe) included', o.verdict === 'INCLUDED', `${verdict(o)}, gas ${o.receipt?.gasUsed}`)
    note('waBasUSDC: shares > 0, convertToAssets within 2 units, USDC down by 500', shares > 0n && assets <= A500 + 2n && assets + 2n >= A500 && u0 - u1 === A500, `${shares} shares -> ${assets}, USDC ${u0} -> ${u1}`)
    const r = await included('waBasUSDC-redeem-userop', 'vault:waBasUSDC', [redeem(wa, shares, safe, safe)])
    const u2 = await lab.balanceOf('USDC', safe)
    note('waBasUSDC: redeem(all shares, safe, safe) included, USDC back (>= 500 - 2 units)', r.verdict === 'INCLUDED' && u2 - u1 + 2n >= A500 && (await shareBal(wa)) === 0n, `${verdict(r)}, +${u2 - u1} USDC, gas ${r.receipt?.gasUsed}`)
  }

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, v2, gasPolicy, pauseGate, guardian: guardian.address, safe, gas, lines: reportLines })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t9-fork', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
} finally {
  await handle.stop()
  proxy.stop()
}

console.log('\n=== gas (userOp tx gasUsed) ===')
for (const [k, v] of Object.entries(gas)) console.log(`${k}: ${v}`)
console.log('\n=== summary ===')
for (const l of reportLines) console.log(`${l.ok === null ? '-' : l.ok ? 'ok' : 'FAIL'} ${l.step}: ${l.detail}`)
process.exit(failed)
