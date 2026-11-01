// otto/mamoru#210: conservador-live-v7 on a Base fork, through the same builders the operator uses (`instantiateGrant`,
// `retargetToPolicy`, `v4PoliciesFor`, `activationBatch`, `revocationCalls`, `remoteSafe(remoteInput(..))`,
// `v4DeploymentOf`), never hand-built sessions. Modelled on t9-fork.ts (v5 -> v6):
//   1. deploy on the local fork only: Deploy.s.sol (V1 + MamoruGasPolicy) and DeployV2.s.sol (V2) from a dev key, as t9;
//      then MamoruActionPolicyV3 with DeployV3.s.sol `run()` and MamoruPauseGate with DeployPauseGate.s.sol, both sent
//      from the impersonated pinned deployer, so V3 lands at its pinned Base address 0xDD2E…6749 (the bytecode Monad runs);
//   2. a v5 account as in production (conservadorLabV5 on V2, a WETH/USDC, a USDC/cbBTC and a USDC/USDT position);
//   3. the moves, each in ONE owner transaction sent with 2^24 as its gas limit (gasUsed, and eth_estimateGas as the
//      limit it needs, against V4_TX_GAS_TARGET 14.5M and the operator's RENEW_GAS_BUDGET 16.2M):
//      a. v5 -> v7 (Brais's path: his account is v5), then the fork is reverted;
//      b. v5 -> v6, then v6 -> v7 (the v6 sessions revoked, generation + 1, the positions admitted again);
//      c. a fresh v7 activation (the same Safe before its v5 approval, then reverted: nothing to revoke or admit);
//   4. after the v6 -> v7 move: v6 permissions disabled, v7 enabled, generation;
//   5. the USDC/USDT exit-only session (V3 alone): decrease + collect of the old position and the USDT sold back are
//      included, a mint and a USDC approval refused; the vault-family sessions (V3 alone): approve + deposit and redeem on gtUSDCp and on waBasUSDC through a session
//      userOp; refused at validation: a vault outside V3's allowlist (steakUSDC: its deposit, and a USDC approval to it),
//      deposit receiver != account, redeem receiver != account, redeem owner != account, `withdraw` (not granted); the
//      guardian's pause on V3 stops a deposit, the unpause lets it through.
//
// Run (builds the contracts, then the scenario):
//   PATH=$HOME/.foundry/bin:$PATH bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t10-fork.ts'
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1..t9. Nothing is
// broadcast anywhere but the local anvil.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseEventLogs, toHex, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, erc20Abi, erc4626Abi, mamoruActionPolicyV2Abi, moduleRegistryAbi, nonfungiblePositionManagerAbi, safeAbi, swapRouter02Abi, uniswapV3PoolAbi, baseRegistry } from '@mamoru/registry'
import {
  V4_GAS_CAPS,
  V4_POOLS,
  V6_POOLS,
  computeCaps,
  conservadorLabV5,
  conservadorLabV6,
  conservadorLabV7,
  grantKey,
  instantiateGrant,
  retargetToPolicy,
  splitV4Keys,
  orderV4Keys,
  fitPrefixBySimulation,
  V4_TX_GAS_TARGET,
  v4BudgetCaps,
  withActionPolicy,
  type PolicyVersion,
  type Price,
  type SessionGrant,
} from '@mamoru/policy'
import { revocationCalls, v4DeploymentOf, v4PoliciesFor, type V4Deployment } from '@mamoru/account/sessions'
import { activationBatch, type LiveAccount } from '@mamoru/account/live'
import { OPERATION_CALL, execTransactionData, multiSendCallOnly, signSafeTx, type MultiSendCall, type SafeTx } from '@mamoru/account/safe'
import { remoteInput, remoteSafe } from '@mamoru/account/remote'
import { withPinnedV3 } from '../../account/remote/fixture.ts'
import { approve, approveTo, collect, deadlineCheck, decreaseLiquidity } from '@mamoru/uniswap-v3'
import { ANVIL_DEV_KEYS, Lab, devAccount, type TxResult } from '../fixtures/lab.ts'
import { buildBasicWorld, rangeAround, WHALE, type AccountFixture, type World } from '../fixtures/world.ts'
import { sendSessionOp, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { engineGas } from '../driver/engine.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'

const CAP_USDC = 1_000_000_000n // 1,000 USDC, as t7..t9
const BASE_PER_TX_GAS_CAP = 16_777_216n
/** apps/mamoru-operator/src/operator.ts RENEW_GAS_BUDGET: what the operator lets a renewal's estimate reach. */
const RENEW_GAS_BUDGET = 16_200_000n
const BTC = V4_POOLS.btc.pool
const RISK = V6_POOLS.balance.pool
const STABLES = V4_POOLS.stables.pool
/** DeployV3.s.sol / DeployPauseGate.s.sol pins (Base). */
const PINNED_DEPLOYER = '0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0' as Address
const PINNED_GUARDIAN = '0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD' as Address
const V3_BASE_PINNED = '0xDD2E387B748420C6501EC96Ec48F87cDEdf16749' as Address
/** steakUSDC (Steakhouse USDC, MetaMorpho on Base): a real ERC-4626 of USDC that V3's allowlist does not name. */
const STEAK = '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183' as Address
const policyAbi = parseAbi([
  'function swapBounds(address account, address pool, address tokenIn, uint256 amountIn) view returns (uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)',
  'function generationOf(address account) view returns (uint64)',
  'function admittedPool(address account, uint256 tokenId) view returns (address)',
  'function decreaseMins(address account, address pool, uint256 tokenId, uint128 liquidity) view returns (uint256, uint256)',
])
const routesAbi = parseAbi(['function ROUTES() view returns (address)', 'function vaultAsset(address) view returns (address)'])
const smartSessionStateAbi = parseAbi(['function isPermissionEnabled(bytes32 permissionId, address account) view returns (bool)'])

type Line = { step: string; ok: boolean | null; detail: string }
const reportLines: Line[] = []
const gas: Record<string, string> = {}
const t0 = Date.now()
let exitCode = 0

function note(step: string, ok: boolean | null, detail: string): void {
  reportLines.push({ step, ok, detail })
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${ok === null ? 'info' : ok ? 'ok  ' : 'FAIL'} ${step}: ${detail}`)
  if (ok === false) exitCode = 1
}

process.on('uncaughtException', (e) => {
  console.error(`t10-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t10-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})

/** The owner's signed Safe transaction carrying `calls` (MultiSend), as calldata to the Safe. */
async function ownerTxData(lab: Lab, acct: AccountFixture, calls: MultiSendCall[]): Promise<Hex> {
  const nonce = await lab.client.readContract({ address: acct.safe, abi: safeAbi, functionName: 'nonce' })
  const op = (calls.length === 1 ? { to: calls[0]!.to, data: calls[0]!.data, operation: OPERATION_CALL } : multiSendCallOnly(calls)) as { to: Address; data: Hex; operation: 0 | 1 }
  const tx: SafeTx = { to: op.to, value: 0n, data: op.data, operation: op.operation, nonce }
  return execTransactionData(tx, await signSafeTx(acct.backupOwner, acct.safe, lab.chainId, tx))
}

async function ownerCalls(lab: Lab, relayer: PrivateKeyAccount, acct: AccountFixture, calls: MultiSendCall[], gasLimit = 20_000_000n): Promise<TxResult> {
  return lab.send(relayer, acct.safe, await ownerTxData(lab, acct, calls), 0n, gasLimit)
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

/** `forge script <script>` sent from an impersonated `sender` (anvil only): the pinned production deployer of DeployV3.s.sol. */
async function forgeScriptAs(lab: Lab, rpcUrl: string, script: string, sender: Address, env: Record<string, string>): Promise<string> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(rpcUrl)) throw new Error(`refusing to broadcast anywhere but the local fork (${rpcUrl})`)
  await lab.setBalance(sender, 10n ** 19n)
  await lab.rpc('anvil_impersonateAccount', [sender])
  try {
    const forge = Bun.which('forge') ?? join(process.env.HOME ?? '', '.foundry/bin/forge')
    const r = Bun.spawn([forge, 'script', script, '--rpc-url', rpcUrl, '--broadcast', '--unlocked', '--sender', sender, '--slow', '--skip-simulation', '--rpc-timeout', '900', '--timeout', '900'], {
      cwd: join(REPO_ROOT, 'contracts/action-policy'),
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited])
    const out = `${stdout}\n${stderr}`
    if (code !== 0) throw new Error(`forge script ${script} failed (${code}):\n${out.slice(-3000)}`)
    return out
  } finally {
    await lab.rpc('anvil_stopImpersonatingAccount', [sender])
  }
}

/** The creation code forge built for `<File>.sol/<Contract>.json`. */
function creationCode(file: string, contract: string): Hex {
  const j = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/action-policy/out', `${file}.sol`, `${contract}.json`), 'utf8')) as { bytecode: { object: string } }
  return (j.bytecode.object.startsWith('0x') ? j.bytecode.object : `0x${j.bytecode.object}`) as Hex
}

type Built = { keys: string[]; grants: SessionGrant[]; permissionIds: Hex[]; calls: MultiSendCall[] }
type Session = { name: string; grant: SessionGrant; permissionId: Hex }


// ------------------------------------------------------------------------------------------------ setup

const manifest = await loadManifest()
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t10`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  // base.json pins contracts deployed after the fork block; they are checked on the live chain, not here (as t9).
  const pinnedLater = new Set(['MamoruActionPolicyV2', 'MamoruPauseGate', 'MamoruActionPolicyV3'])
  await assertCodeHashes(lab.client, { ...baseRegistry, entries: baseRegistry.entries.filter((e) => !pinnedLater.has(e.name)) })
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}; registry code hashes hold (the two vaults and waBasUSDC's implementation included)`)
  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, conservadorLabV5, engineNow)
  const safe = world.a1.safe
  note('fx-safe', true, `Safe7579 account ${safe}`)

  // ---------------------------------------------------------------------------------------------- 1. deploy

  const deployerKey = ANVIL_DEV_KEYS[9] as Hex
  const deployer = devAccount(9)
  const outV1 = await forgeScript(handle.url, 'script/Deploy.s.sol', deployer, deployerKey, { POLICY_SALT_NONCE: '7', GAS_POLICY_SALT_NONCE: '8', CARDINALITY_TARGET: '3600' })
  const gasPolicy = /MamoruGasPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(outV1)?.[1] as Address
  const outV2 = await forgeScript(handle.url, 'script/DeployV2.s.sol', deployer, deployerKey, { GUARDIAN: PINNED_GUARDIAN, POLICY_V2_SALT_NONCE: '9', CARDINALITY_TARGET: '3600' })
  const v2 = /MamoruActionPolicyV2:\s*(0x[0-9a-fA-F]{40})/.exec(outV2)?.[1] as Address
  if (!gasPolicy || !v2) throw new Error('forge scripts printed no addresses')
  note('Deploy.s.sol + DeployV2.s.sol --broadcast on the local fork', true, `MamoruGasPolicy ${gasPolicy}, V2 ${v2}`)
  // DeployV3.s.sol picks its arguments by block.chainid (Base or Monad only): the lab fork answers 8453 for the deploy alone,
  // then its own chain id again. V3's bytecode has no chain id in it, so it is the contract Base will run.
  await lab.rpc('anvil_setChainId', [8453])
  const outV3 = await forgeScriptAs(lab, handle.url, 'script/DeployV3.s.sol', PINNED_DEPLOYER, { GUARDIAN: PINNED_GUARDIAN }).finally(() => lab.rpc('anvil_setChainId', [lab.chainId]))
  const v3 = getAddress(/MamoruActionPolicyV3:\s*(0x[0-9a-fA-F]{40})/.exec(outV3)?.[1] ?? '0x0000000000000000000000000000000000000000') as Address
  note('DeployV3.s.sol run() from the pinned deployer: V3 at its pinned Base address', v3 === V3_BASE_PINNED, v3)
  const outGate = await forgeScriptAs(lab, handle.url, 'script/DeployPauseGate.s.sol', PINNED_DEPLOYER, {})
  const gate = getAddress(/MamoruPauseGate:\s*(0x[0-9a-fA-F]{40})/.exec(outGate)?.[1] ?? '0x0000000000000000000000000000000000000000') as Address
  note('DeployPauseGate.s.sol from the pinned deployer: the gate bound to V3', true, gate)
  const registryAddr = address('ModuleRegistry', baseRegistry)
  const smartSession = address('SmartSession', baseRegistry)
  const reference = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findModule', args: [address('TimeFramePolicy', baseRegistry)] })
  for (const [name, m] of [['V2', v2], ['V3', v3], ['MamoruPauseGate', gate], ['MamoruGasPolicy', gasPolicy]] as const) {
    const rec = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findModule', args: [m] })
    note(`findModule(${name}): a ModuleRecord under Mamoru's resolver (what v4Context requires)`, BigInt(rec.sender) !== 0n && rec.resolverUID === reference.resolverUID, `sender ${rec.sender}`)
  }
  const routes = await lab.client.readContract({ address: v3, abi: routesAbi, functionName: 'ROUTES' })
  for (const [name, vault] of [['gtUSDCp', address('vault:gtUSDCp', baseRegistry)], ['waBasUSDC', address('vault:waBasUSDC', baseRegistry)], ['steakUSDC', STEAK]] as const) {
    const asset = await lab.client.readContract({ address: routes, abi: routesAbi, functionName: 'vaultAsset', args: [vault] })
    const listed = BigInt(asset) !== 0n
    note(`V3 vault allowlist: ${name} ${listed ? 'listed (asset USDC)' : 'not listed'}`, name === 'steakUSDC' ? !listed : asset.toLowerCase() === address('USDC', baseRegistry).toLowerCase(), asset)
  }

  // The operator's policy objects (boot.ts deployedV5 / deployedV6 / deployedV7).
  const gasCfg = { address: gasPolicy, caps: V4_GAS_CAPS }
  const p5 = withActionPolicy(conservadorLabV5, v2, Object.values(V4_POOLS), { caps: v4BudgetCaps(conservadorLabV5, CAP_USDC), gasPolicy: gasCfg, contractVersion: 2 })
  const p6 = withActionPolicy(conservadorLabV6, v3, [V6_POOLS.stables, V6_POOLS.balance, V4_POOLS.btc], { gasPolicy: gasCfg, contractVersion: 3, pauseGate: gate })
  const p7 = withActionPolicy(conservadorLabV7, v3, [V4_POOLS.stables, V6_POOLS.balance, V4_POOLS.btc], { gasPolicy: gasCfg, contractVersion: 3, pauseGate: gate })
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, BTC, 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, RISK, 'WETH', 'USDC', 'WETH'),
  }
  let salt = 0
  const nextSalt = (): Hex => `0x${(++salt).toString(16).padStart(64, '0')}` as Hex

  /** t8/t9's approveAll: one v5 approval at `generation`, split by simulated gas as the operator's fitV4. */
  async function approveV5(label: string, policy: PolicyVersion, generation: bigint, sessionKey: Address, attest: Address[]): Promise<Built[]> {
    const d: V4Deployment = v4DeploymentOf(policy)!
    const caps = computeCaps(policy, CAP_USDC, prices)
    const budgets = v4BudgetCaps(policy, CAP_USDC)
    let remaining = orderV4Keys(policy, policy.session.grants.map(grantKey))
    const out: Built[] = []
    for (let i = 0; remaining.length; i++) {
      const first = i === 0
      const build = async (keys: string[]): Promise<Built> => {
        const now = await engineNow()
        const grants = keys.map((k) => retargetToPolicy(instantiateGrant(policy, k, { account: safe, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now - 60, validUntil: now + policy.session.validitySeconds, caps, capUsdc: CAP_USDC }), d.actionPolicy))
        const batch = activationBatch({ safe } as LiveAccount, grants, [], { trust: false, policiesFor: v4PoliciesFor(grants, d, generation, budgets, {}), attest: first ? attest : [] })
        return { keys, grants, permissionIds: batch.permissionIds, calls: batch.calls }
      }
      const guess = splitV4Keys(policy, remaining, { overheadGas: 150_000n, ceiling: V4_TX_GAS_TARGET })[0]?.length ?? 1
      const fit = await fitPrefixBySimulation(remaining, guess, async (keys) => lab.client.estimateGas({ account: relayer.address, to: safe, data: await ownerTxData(lab, world.a1, (await build(keys)).calls) }))
      if (fit.n === 0) throw new Error(`${label}: not even one session fits ${V4_TX_GAS_TARGET}`)
      const b = await build(remaining.slice(0, fit.n))
      const r = await ownerCalls(lab, relayer, world.a1, b.calls)
      note(`${label}: tx ${i + 1}`, r.ok && r.receipt.gasUsed <= V4_TX_GAS_TARGET, `${r.receipt.gasUsed} gas used, ${b.keys.length} sessions`)
      gas[`${label}-tx${i + 1}`] = r.receipt.gasUsed.toString()
      if (!r.ok) throw new Error(`${label} tx ${i + 1} reverted`)
      out.push(b)
      remaining = remaining.slice(fit.n)
    }
    return out
  }

  function pick(parts: Built[], key: string, acct: AccountFixture = world.a1): Session {
    for (const p of parts) {
      const i = p.keys.indexOf(key)
      if (i >= 0) {
        acct.ledger.activate(p.permissionIds[i]!, p.grants[i]!)
        return { name: key, grant: p.grants[i]!, permissionId: p.permissionIds[i]! }
      }
    }
    throw new Error(`no session ${key}`)
  }

  async function op(label: string, s: Session, calls: { to: Address; data: Hex }[], key: PrivateKeyAccount, acct: AccountFixture = world.a1): Promise<SessionOpOutcome> {
    const eg = engineGas((await lab.client.getBlock()).baseFeePerGas ?? 0n, V4_GAS_CAPS)
    if (!eg) throw new Error('basefee over the gas cap on the fork')
    return sendSessionOp(world, acct, s, label, calls, { gas: eg, sessionKey: key })
  }

  async function swapBatch(policyAddr: Address, pool: string, tokenIn: string, tokenOut: string, fee: number, amountIn: bigint): Promise<{ to: Address; data: Hex }[]> {
    const [minOut, limit] = await lab.client.readContract({ address: policyAddr, abi: policyAbi, functionName: 'swapBounds', args: [safe, address(pool, baseRegistry), address(tokenIn, baseRegistry), amountIn] })
    return [
      deadlineCheck(BigInt(await engineNow()) + 300n),
      approve(tokenIn, 'SwapRouter02', amountIn),
      { to: address('SwapRouter02', baseRegistry), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address(tokenIn, baseRegistry), tokenOut: address(tokenOut, baseRegistry), fee, recipient: safe, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: limit }] }) },
    ]
  }

  const verdict = (o: SessionOpOutcome) => `${o.verdict}${o.failedOp?.reason ? ` (${o.failedOp.reason})` : ''}${o.validator ? ` validator=${o.validator}` : ''}`
  const poolAddr = (pool: string) => address(pool, baseRegistry).toLowerCase()
  const enabled = async (ids: Hex[], who: Address = safe) => Promise.all(ids.map((id) => lab.client.readContract({ address: smartSession, abi: smartSessionStateAbi, functionName: 'isPermissionEnabled', args: [id, who] })))
  const mintedId = (o: SessionOpOutcome) => (o.receipt ? parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: o.receipt.logs, eventName: 'Transfer' }).find((l) => l.args.to.toLowerCase() === safe.toLowerCase())?.args.tokenId : undefined)

  // ---------------------------------------------------------------------------------------------- 3. the approvals (helpers)

  // The remote Safe, as remoteFor: the account's keys, a (dev) Monad session key, the bridge total at this cap.
  const remoteKey = devAccount(3)
  const remoteOf = async (acct: AccountFixture, p: PolicyVersion) => {
    const bucket = p.remoteBuckets![0]!
    const c = { owners: [address('SafeWebAuthnSharedSigner', baseRegistry), acct.backupOwner.address], saltNonce: '1', passkey: { x: toHex(acct.passkey.x), y: toHex(acct.passkey.y) } }
    const monad = withPinnedV3()
    const remotePolicy = remoteInput(c as never, { chainId: bucket.chainId, policyId: bucket.policyId, sessionKey: remoteKey.address, validAfter: 0, validUntil: 0, capUsdc: '1' }, monad).policy
    const bridgeTotal = p.session.grants.find((g) => g.name === 'bridge-out')?.actions.flatMap((a) => a.params).find((r) => r.cumulative)?.cumulative
    const bridgeCap = bridgeTotal ? v4BudgetCaps(p, CAP_USDC)[bridgeTotal.slice(4)] : undefined
    if (!bridgeCap || bridgeCap <= 0n) throw new Error('no bridge total to size the remote Safe at')
    const now = await engineNow()
    const spec = { chainId: bucket.chainId, policyId: bucket.policyId, sessionKey: remoteKey.address, validAfter: now - 60, validUntil: now + remotePolicy.session.validitySeconds, capUsdc: bridgeCap.toString() }
    return remoteSafe(remoteInput(c as never, spec, monad)).address
  }

  /**
   * One owner transaction as the operator's full approval builds it (planRenew / planActivate on a v4 policy): every
   * grant of `p`, retargeted to V3, generation = max(V2's, V3's) + 1, `admit` on the first grant of each pool, `old`
   * revoked, what the Safe has not attested yet attested. Sent with 2^24 as its gas limit.
   */
  async function approval(label: string, p: PolicyVersion, acct: AccountFixture, old: Hex[], admit: Partial<Record<string, bigint[]>>, sessionKey: Address, opts: { without?: string; estimateOnly?: boolean } = {}): Promise<Built & { gasUsed: bigint; estimate: bigint }> {
    const who = acct.safe
    const prior = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'generationOf', args: [who] })
    const current = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'generationOf', args: [who] })
    const generation = (prior > current ? prior : current) + 1n
    const d: V4Deployment = v4DeploymentOf(p)!
    const now = await engineNow()
    const attest: Address[] = []
    for (const m of [d.actionPolicy, d.gasPolicy, ...(d.pauseGate ? [d.pauseGate] : [])]) {
      const a = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findAttestation', args: [m, who] })
      if (Number(a.time) === 0 || Number(a.revocationTime) !== 0) attest.push(m)
    }
    const remoteAccount = await remoteOf(acct, p)
    const caps = computeCaps(p, CAP_USDC, prices)
    const keys = orderV4Keys(p, p.session.grants.filter((g) => !g.perPosition).map(grantKey)).filter((k) => k !== opts.without)
    const grants = keys.map((k) => {
      const g = instantiateGrant(p, k, { account: who, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now - 60, validUntil: now + p.session.validitySeconds, caps, admittedTokenIds: [], capUsdc: CAP_USDC, remoteAccount })
      return g.requiresActionPolicy ? retargetToPolicy(g, d.actionPolicy) : g
    })
    const attestData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [generation, BigInt(now)])
    const batch = activationBatch({ safe: who } as LiveAccount, grants, [], { trust: false, policiesFor: v4PoliciesFor(grants, d, generation, v4BudgetCaps(p, CAP_USDC), admit), attest, attestData })
    const calls = [...(old.length ? revocationCalls(old) : []), ...batch.calls]
    const data = await ownerTxData(lab, acct, calls)
    const estimate = await lab.client.estimateGas({ account: relayer.address, to: who, data })
    if (opts.estimateOnly) return { keys, grants, permissionIds: batch.permissionIds, calls, gasUsed: 0n, estimate }
    const r = await lab.send(relayer, who, data, 0n, BASE_PER_TX_GAS_CAP)
    const actions = grants.reduce((n, g) => n + g.actions.length, 0)
    note(`${label}: ONE owner transaction`, r.ok && r.receipt.gasUsed <= V4_TX_GAS_TARGET && estimate <= RENEW_GAS_BUDGET, `gasUsed ${r.receipt.gasUsed}, eth_estimateGas ${estimate} (limit needed) vs RENEW_GAS_BUDGET ${RENEW_GAS_BUDGET}, V4_TX_GAS_TARGET ${V4_TX_GAS_TARGET}, cap 2^24; ${grants.length} sessions (${actions} actions), ${old.length} revokes, generation ${generation}`)
    gas[`${label}-gasUsed`] = r.receipt.gasUsed.toString()
    gas[`${label}-estimateGas`] = estimate.toString()
    if (!r.ok) throw new Error(`${label} reverted`)
    const gen = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'generationOf', args: [who] })
    note(`${label}: V3.generationOf(account)`, gen === generation, `${gen}`)
    return { keys, grants, permissionIds: batch.permissionIds, calls, gasUsed: r.receipt.gasUsed, estimate }
  }

  // ---------------------------------------------------------------------------------------------- 3c. a fresh v7 activation

  // The Safe before any approval: no session to revoke, nothing to admit, generation 1. Reverted afterwards.
  await lab.setBalance(safe, 10n ** 18n)
  {
    const fresh = await lab.snapshot()
    // What each v7 session adds to the transaction (leave-one-out, eth_estimateGas): informational, for the gas budget.
    const full = await approval('v7 estimate', p7, world.a1, [], {}, devAccount(2).address, { estimateOnly: true })
    for (const k of full.keys) {
      const less = await approval('v7 estimate', p7, world.a1, [], {}, devAccount(2).address, { without: k, estimateOnly: true })
      note(`v7 session ${k} (${full.grants[full.keys.indexOf(k)]!.actions.length} actions): its share of a fresh activation`, null, `${full.estimate - less.estimate} gas (estimate)`)
      gas[`v7-session-${k}`] = (full.estimate - less.estimate).toString()
    }
    await approval('fresh v7 activation', p7, world.a1, [], {}, devAccount(2).address)
    await lab.revert(fresh)
  }

  // ---------------------------------------------------------------------------------------------- 2. a v5 account on V2

  await lab.setBalance(safe, 10n ** 18n)
  await lab.whaleTransfer('USDC', WHALE, safe, 3_000_000_000n)
  const key5 = devAccount(5)
  const gen5 = await approveV5('v5 activation on V2 (generation 1)', p5, 1n, key5.address, [v2, gasPolicy])
  let wethId: bigint
  let btcId: bigint
  {
    const out = await op('t10-v5-swap-weth', pick(gen5, `enter-swap:${RISK}`), await swapBatch(v2, RISK, 'USDC', 'WETH', 3000, 80_000_000n), key5)
    note('v5: 80 USDC -> WETH through V2', out.verdict === 'INCLUDED', verdict(out))
    const tick = (await lab.client.readContract({ address: address(RISK, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
    const { tickLower, tickUpper } = rangeAround(tick, 2_000, 60)
    const weth = await lab.balanceOf('WETH', safe)
    const e = V4_POOLS.risk
    const params = { token0: address(e.token0, baseRegistry), token1: address(e.token1, baseRegistry), fee: e.fee, tickLower, tickUpper, amount0Desired: weth / 2n, amount1Desired: 40_000_000n, amount0Min: 1n, amount1Min: 1n, recipient: safe, deadline: BigInt(await engineNow()) + 3_600n }
    const m = await op('t10-v5-mint-weth', pick(gen5, `enter-mint:${RISK}`), [approveTo('WETH', v2, params.amount0Desired), approveTo('USDC', v2, params.amount1Desired), { to: v2, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }], key5)
    wethId = mintedId(m)!
    note('v5: a WETH/USDC position through V2.mint', m.verdict === 'INCLUDED' && wethId !== undefined, `${verdict(m)} tokenId ${wethId}`)
  }
  {
    const out = await op('t10-v5-swap-btc', pick(gen5, `enter-swap:${BTC}`), await swapBatch(v2, BTC, 'USDC', 'cbBTC', 500, 300_000_000n), key5)
    note('v5: 300 USDC -> cbBTC through V2', out.verdict === 'INCLUDED', verdict(out))
    const tick = (await lab.client.readContract({ address: address(BTC, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
    const { tickLower, tickUpper } = rangeAround(tick, 2_000, 10)
    const cbbtc = await lab.balanceOf('cbBTC', safe)
    const e = V4_POOLS.btc
    const params = { token0: address(e.token0, baseRegistry), token1: address(e.token1, baseRegistry), fee: e.fee, tickLower, tickUpper, amount0Desired: 300_000_000n, amount1Desired: cbbtc / 2n, amount0Min: 1n, amount1Min: 1n, recipient: safe, deadline: BigInt(await engineNow()) + 3_600n }
    const m = await op('t10-v5-mint-btc', pick(gen5, `enter-mint:${BTC}`), [approveTo('USDC', v2, params.amount0Desired), approveTo('cbBTC', v2, params.amount1Desired), { to: v2, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }], key5)
    btcId = mintedId(m)!
    note('v5: a USDC/cbBTC position through V2.mint', m.verdict === 'INCLUDED' && btcId !== undefined, `${verdict(m)} tokenId ${btcId}`)
  }
  let lpId: bigint
  {
    const out = await op('t10-v5-swap-usdt', pick(gen5, `enter-swap:${STABLES}`), await swapBatch(v2, STABLES, 'USDC', 'USDT', 100, 200_000_000n), key5)
    note('v5: 200 USDC -> USDT through V2', out.verdict === 'INCLUDED', verdict(out))
    const tick = (await lab.client.readContract({ address: address(STABLES, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
    const { tickLower, tickUpper } = rangeAround(tick, 20, 1)
    const usdt = await lab.balanceOf('USDT', safe)
    const e = V4_POOLS.stables
    const params = { token0: address(e.token0, baseRegistry), token1: address(e.token1, baseRegistry), fee: e.fee, tickLower, tickUpper, amount0Desired: 200_000_000n, amount1Desired: usdt, amount0Min: 1n, amount1Min: 1n, recipient: safe, deadline: BigInt(await engineNow()) + 3_600n }
    const m = await op('t10-v5-mint-lp', pick(gen5, `enter-mint:${STABLES}`), [approveTo('USDC', v2, params.amount0Desired), approveTo('USDT', v2, params.amount1Desired), { to: v2, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }], key5)
    lpId = mintedId(m)!
    note('v5: a USDC/USDT position through V2.mint (what v7 keeps as exit only)', m.verdict === 'INCLUDED' && lpId !== undefined, `${verdict(m)} tokenId ${lpId}`)
  }
  const admitByPool: Partial<Record<string, bigint[]>> = { [RISK]: [wethId], [BTC]: [btcId], [STABLES]: [lpId] }

  const old5 = gen5.flatMap((b) => b.permissionIds)
  const snap = await lab.snapshot()
  const key7 = devAccount(6)
  // a. v5 -> v7 (Brais's account is v5)
  await approval('v5->v7 move', p7, world.a1, old5, admitByPool, key7.address)
  await lab.revert(snap)
  // b. v5 -> v6, then v6 -> v7
  const key6 = devAccount(4)
  const m6 = await approval('v5->v6 move (reference)', p6, world.a1, old5, admitByPool, key6.address)
  const m7 = await approval('v6->v7 move', p7, world.a1, m6.permissionIds, admitByPool, key7.address)

  // ---------------------------------------------------------------------------------------------- 4. after the v6 -> v7 move

  {
    const was = await enabled(m6.permissionIds)
    note('every v6 permission is disabled', was.every((x) => !x), `${was.filter((x) => x).length} of ${was.length} still enabled`)
    const now = await enabled(m7.permissionIds)
    note('every v7 permission is enabled', now.every((x) => x), `${now.filter((x) => x).length} of ${now.length}`)
    for (const [name, id, pool] of [['WETH/USDC', wethId, RISK], ['USDC/cbBTC', btcId, BTC], ['USDC/USDT', lpId, STABLES]] as const) {
      const at = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'admittedPool', args: [safe, id] })
      note(`V3.admittedPool(account, ${name} tokenId) is still the pool`, at.toLowerCase() === poolAddr(pool), at)
    }
  }

  const usdc = address('USDC', baseRegistry)
  const approveUsdc = (spender: Address, amount: bigint) => ({ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) })
  const deposit = (v: Address, assets: bigint, receiver: Address) => ({ to: v, data: encodeFunctionData({ abi: erc4626Abi, functionName: 'deposit', args: [assets, receiver] }) })
  const redeem = (v: Address, shares: bigint, receiver: Address, owner: Address) => ({ to: v, data: encodeFunctionData({ abi: erc4626Abi, functionName: 'redeem', args: [shares, receiver, owner] }) })
  const withdraw = (v: Address, assets: bigint) => ({ to: v, data: encodeFunctionData({ abi: erc4626Abi, functionName: 'withdraw', args: [assets, safe, safe] }) })
  const shareBal = (v: Address) => lab.client.readContract({ address: v, abi: erc4626Abi, functionName: 'balanceOf', args: [safe] })
  const stranger = devAccount(7).address as Address
  const A500 = 500_000_000n
  const refused = async (step: string, s: Session, calls: { to: Address; data: Hex }[]) => {
    const o = await op(`t10-${step}`, s, calls, key7)
    note(`refused at validation: ${step}`, o.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(o))
  }

  // ---------------------------------------------------------------------------------------------- 5a. the USDC/USDT exit (V3 alone)

  {
    const s = pick([m7], `manage-any:${STABLES}`)
    const npm = address('NonfungiblePositionManager', baseRegistry)
    const liquidityOf = async (tokenId: bigint) => (await lab.client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] }))[7]
    const before = await liquidityOf(lpId)
    const [m0, m1] = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'decreaseMins', args: [safe, address(STABLES, baseRegistry), lpId, before] })
    const out = await op('t10-v7-lp-exit', s, [decreaseLiquidity({ tokenId: lpId, liquidity: before, amount0Min: m0, amount1Min: m1, deadline: BigInt(await engineNow()) + 600n }), collect({ account: safe, tokenId: lpId })], key7)
    note('v7 USDC/USDT exit-only (V3 alone): decrease all + collect of the old position is included', out.verdict === 'INCLUDED' && (await liquidityOf(lpId)) === 0n, `${verdict(out)}, liquidity ${before} -> 0, userOp tx gas ${out.receipt?.gasUsed}`)
    const t0b = await lab.balanceOf('USDT', safe)
    const sell = await op('t10-v7-lp-sell-usdt', s, await swapBatch(v3, STABLES, 'USDT', 'USDC', 100, t0b), key7)
    note('v7 USDC/USDT exit-only: the USDT sold back to USDC is included', sell.verdict === 'INCLUDED' && (await lab.balanceOf('USDT', safe)) === 0n, `${verdict(sell)}, USDT ${t0b} -> 0`)
    const tick = (await lab.client.readContract({ address: address(STABLES, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
    const { tickLower, tickUpper } = rangeAround(tick, 20, 1)
    const e = V4_POOLS.stables
    const params = { token0: address(e.token0, baseRegistry), token1: address(e.token1, baseRegistry), fee: e.fee, tickLower, tickUpper, amount0Desired: 10_000_000n, amount1Desired: 0n, amount0Min: 0n, amount1Min: 0n, recipient: safe, deadline: BigInt(await engineNow()) + 3_600n }
    await refused('USDC/USDT exit-only: a new position (mint through V3)', s, [{ to: v3, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }])
    await refused('USDC/USDT exit-only: a USDC approval', s, [approveTo('USDC', v3, 10_000_000n)])
  }

  // ---------------------------------------------------------------------------------------------- 5b. vault sessions (V3 alone)

  for (const vname of ['vault:gtUSDCp', 'vault:waBasUSDC'] as const) {
    const s = pick([m7], `vault-supply:${vname}`)
    const v = address(vname, baseRegistry)
    const label = vname.slice(6)
    const u0 = await lab.balanceOf('USDC', safe)
    const o = await op(`t10-${label}-deposit`, s, [approveUsdc(v, A500), deposit(v, A500, safe)], key7)
    if (o.receipt) gas[`${label}-deposit-userop`] = o.receipt.gasUsed.toString()
    const shares = await shareBal(v)
    const assets = await lab.client.readContract({ address: v, abi: erc4626Abi, functionName: 'convertToAssets', args: [shares] })
    const u1 = await lab.balanceOf('USDC', safe)
    note(`${label}: approve + deposit(500 USDC, account) through the session (V3 vault family) is included`, o.verdict === 'INCLUDED' && u0 - u1 === A500 && shares > 0n && assets + 2n >= A500 && assets <= A500 + 2n, `${verdict(o)}, USDC ${u0} -> ${u1}, ${shares} shares worth ${assets}, userOp tx gas ${o.receipt?.gasUsed}`)

    await refused(`${label}: deposit receiver != account`, s, [approveUsdc(v, A500), deposit(v, 100_000_000n, stranger)])
    await refused(`${label}: redeem receiver != account`, s, [redeem(v, shares / 2n, stranger, safe)])
    await refused(`${label}: redeem owner != account`, s, [redeem(v, shares / 2n, safe, stranger)])
    await refused(`${label}: withdraw (not granted)`, s, [withdraw(v, 100_000_000n)])
    if (vname === 'vault:gtUSDCp') {
      await refused('a vault outside V3\'s allowlist: steakUSDC.deposit', s, [deposit(STEAK, 1_000_000n, safe)])
      await refused('a vault outside V3\'s allowlist: USDC.approve(steakUSDC)', s, [approveUsdc(STEAK, 1_000_000n)])
      // The guardian's pause on V3 stops the vault family too; the unpause lets it through.
      const pause = (fn: 'pause' | 'unpause') => lab.sendAs(PINNED_GUARDIAN, v3, encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: fn, args: [safe] }))
      await lab.setBalance(PINNED_GUARDIAN, 10n ** 18n)
      const p = await pause('pause')
      note('the guardian pauses the account on V3', p.ok && (await lab.client.readContract({ address: v3, abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', args: [safe] })), `gas ${p.receipt.gasUsed}`)
      await refused('paused: gtUSDCp deposit', s, [approveUsdc(v, 100_000_000n), deposit(v, 100_000_000n, safe)])
      const un = await pause('unpause')
      note('the guardian unpauses', un.ok, `gas ${un.receipt.gasUsed}`)
    }
    const all = await shareBal(v)
    const r = await op(`t10-${label}-redeem`, s, [redeem(v, all, safe, safe)], key7)
    if (r.receipt) gas[`${label}-redeem-userop`] = r.receipt.gasUsed.toString()
    const u2 = await lab.balanceOf('USDC', safe)
    note(`${label}: redeem(all shares, account, account) through the session is included, USDC back`, r.verdict === 'INCLUDED' && (await shareBal(v)) === 0n && u2 - u1 + 2n >= A500, `${verdict(r)}, +${u2 - u1} USDC, userOp tx gas ${r.receipt?.gasUsed}`)
  }

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, v2, v3, gate, gasPolicy, safe, gas, lines: reportLines })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t10-fork', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
  exitCode = 1
} finally {
  await handle.stop()
  proxy.stop()
}

console.log('\n=== gas ===')
for (const [k, v] of Object.entries(gas)) console.log(`${k}: ${v}`)
console.log('\n=== summary ===')
for (const l of reportLines) console.log(`${l.ok === null ? '-' : l.ok ? 'ok' : 'FAIL'} ${l.step}: ${l.detail}`)
process.exit(exitCode)
