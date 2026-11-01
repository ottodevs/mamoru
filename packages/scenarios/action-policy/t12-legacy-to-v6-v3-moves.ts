// otto/mamoru#254: gas of the move from legacy accounts (v2/v3 per-position grants, v4 on V1, v5 on V2) to v6 on
// MamoruActionPolicyV3 (main 986c0afd: one manage-any per pool, V3 alone), on a Base fork. MEASUREMENT ONLY: no grant,
// policy or v6/remote code is changed. Built on t9 (v5 -> v6) and t11 (legacy v2 with admitted positions, #166).
//
// Every move is built by the operator's own builders (`instantiateGrant`, `retargetToPolicy`, `v4PoliciesFor`,
// `activationBatch`, `revocationCalls`, `orderV4Keys`, `fitPrefixBySimulation`, `remoteSafe(remoteInput(..))`) and the
// operator's gas limit (`ownerTxGasLimit`: simulateAndRevert * 9/8 + 300k passkey check). Owner transactions are signed by
// the passkey (WebAuthn through the shared signer), as in production. For each account state:
//   A. the whole move as ONE owner transaction (revokes + attest + every v6 session), sent with 2^24 - 1 as gas limit:
//      gasUsed and the operator's limit;
//   B. the move as planRenew splits it today (planRenew -> fitV4: the longest prefix of whole sessions whose operator
//      limit is <= min(RENEW_GAS_BUDGET 16.2M, V4_TX_GAS_TARGET 14.5M); the rest follow as 'extend' owner transactions):
//      transactions (= passkey prompts), the sessions and gas of each.
//
// V3 is deployed at its pinned address 0xDD2E387B748420C6501EC96Ec48F87cDEdf16749 with DeployV3.s.sol's `deploy` call
// (ModuleRegistry.deployModule, pinned deployer impersonated by the local anvil, pinned guardian and nonce): the address
// only comes out if the init code hash is the pinned one. `run()` itself refuses the lab fork's chain id 31337.
//
// Run (builds the contracts, then the scenario):
//   nix shell nixpkgs#foundry --command bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t12-legacy-to-v6-v3-moves.ts'
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1..t11. Nothing is
// broadcast anywhere but the local anvil.
import { join } from 'node:path'
import { concat, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseEventLogs, toHex, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, baseRegistry, moduleRegistryAbi, nonfungiblePositionManagerAbi, safeAbi, swapRouter02Abi, uniswapV3PoolAbi } from '@mamoru/registry'
import {
  V4_GAS_CAPS,
  V4_POOLS,
  V4_TX_GAS_TARGET,
  V6_POOLS,
  computeCaps,
  conservadorLabV4,
  conservadorLabV5,
  conservadorLabV6,
  conservadorLiveV2,
  fitPrefixBySimulation,
  grantKey,
  instantiateGrant,
  orderV4Keys,
  retargetToPolicy,
  splitV4Keys,
  v4BudgetCaps,
  withActionPolicy,
  type PolicyVersion,
  type Price,
  type SessionGrant,
} from '@mamoru/policy'
import { revocationCalls, v4DeploymentOf, v4PoliciesFor, type V4Deployment } from '@mamoru/account/sessions'
import { activationBatch, type LiveAccount } from '@mamoru/account/live'
import { OPERATION_CALL, execTransactionData, multiSendCallOnly, type MultiSendCall, type SafeTx } from '@mamoru/account/safe'
import { remoteInput, remoteSafe } from '@mamoru/account/remote'
import { withPinnedV3 } from '../../account/remote/fixture.ts'
import { approve, approveTo, deadlineCheck, mint } from '@mamoru/uniswap-v3'
import { simulateCalls } from '@mamoru/rpc'
import { ANVIL_DEV_KEYS, Lab, devAccount, type TxResult } from '../fixtures/lab.ts'
import { buildBasicWorld, ownerSignature, rangeAround, WHALE, type World } from '../fixtures/world.ts'
import { sendSessionOp, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { engineGas } from '../driver/engine.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'
import { loadPolicyArtifact, resolverUidOf } from './v4-grant.ts'

const CAP_USDC = 1_000_000_000n // 1,000 USDC, as t7..t11
const BASE_PER_TX_GAS_CAP = 16_777_216n
/** operator.ts PASSKEY_VERIFY_GAS. */
const PASSKEY_VERIFY_GAS = 300_000n
/** operator.ts RENEW_GAS_BUDGET (planRenew -> fitV4) and the effective per-transaction fit target min(budget, V4_TX_GAS_TARGET). */
const RENEW_GAS_BUDGET = 16_200_000n
const FIT_TARGET = RENEW_GAS_BUDGET < V4_TX_GAS_TARGET ? RENEW_GAS_BUDGET : V4_TX_GAS_TARGET
const PINNED_DEPLOYER = '0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0' as Address
const PINNED_GUARDIAN = '0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD' as Address
const PINNED_V3 = '0xDD2E387B748420C6501EC96Ec48F87cDEdf16749' as Address
const BTC = V4_POOLS.btc.pool
const RISK = V6_POOLS.balance.pool
const STABLES = V6_POOLS.stables.pool
const policyAbi = parseAbi([
  'function swapBounds(address account, address pool, address tokenIn, uint256 amountIn) view returns (uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)',
  'function generationOf(address account) view returns (uint64)',
  'function admittedPool(address account, uint256 tokenId) view returns (address)',
])
const registryDeployAbi = parseAbi(['function deployModule(bytes32 salt, bytes32 resolverUID, bytes initCode, bytes metadata, bytes resolverContext) payable returns (address)'])
const smartSessionStateAbi = parseAbi(['function isPermissionEnabled(bytes32 permissionId, address account) view returns (bool)'])
const storageAccessibleAbi = parseAbi(['function simulateAndRevert(address, bytes)'])

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
  console.error(`t12 failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t12 failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})

/** `forge script <script>` against the local anvil only. `unlocked`: the sender is impersonated by anvil, no key. */
async function forgeScript(rpcUrl: string, script: string, sender: Address, auth: { key: Hex } | { unlocked: true }, env: Record<string, string>): Promise<string> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(rpcUrl)) throw new Error(`refusing to broadcast anywhere but the local fork (${rpcUrl})`)
  const forge = Bun.which('forge') ?? join(process.env.HOME ?? '', '.foundry/bin/forge')
  const authArgs = 'key' in auth ? ['--private-key', auth.key] : ['--unlocked']
  const r = Bun.spawn([forge, 'script', script, '--rpc-url', rpcUrl, '--broadcast', ...authArgs, '--sender', sender, '--slow', '--skip-simulation', '--rpc-timeout', '900', '--timeout', '900'], {
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

async function usdcPrice(lab: Lab, pool: string, token0: string, token1: string, asset: string): Promise<Price> {
  const [sqrtPriceX96] = await lab.client.readContract({ address: address(pool, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const ratio: Price = { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n }
  if (token0 === 'USDC' && token1 === asset) return ratio
  if (token1 === 'USDC' && token0 === asset) return { num: ratio.den, den: ratio.num }
  throw new Error(`usdcPrice: ${pool} does not pair USDC with ${asset}`)
}

type Built = { keys: string[]; grants: SessionGrant[]; permissionIds: Hex[]; calls: MultiSendCall[] }
type Session = { name: string; grant: SessionGrant; permissionId: Hex }
type Held = { old: Hex[]; prior: Address | null; admit: Partial<Record<string, bigint[]>>; ids: bigint[]; sessions: number }
type Row = {
  account: string
  oldSessions: number
  positions: number
  v6Sessions: number
  v6Actions: number
  oneTx: { gasUsed: string; ok: boolean; operatorLimit: string | null; estimateGasPlusPasskey: string; fits14_5: boolean | null; fits16_2: boolean | null; note: string }
  split: { txs: number; perTx: { sessions: number; actions: number; gasUsed: string; operatorLimit: string | null; keys: string[] }[]; totalGas: string }
}
const rows: Row[] = []

// ------------------------------------------------------------------------------------------------ setup

const manifest = await loadManifest()
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t12${Number(process.env.T12_STRESS ?? 0) > 0 ? `-stress${process.env.T12_STRESS}` : ''}`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  const pinnedLater = new Set(['MamoruActionPolicyV2', 'MamoruPauseGate', 'MamoruActionPolicyV3'])
  await assertCodeHashes(lab.client, { ...baseRegistry, entries: baseRegistry.entries.filter((e) => !pinnedLater.has(e.name)) })
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}`)
  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, conservadorLabV4, engineNow)
  const acct = world.a1
  const safe = acct.safe
  note('fx-safe', true, `Safe7579 account ${safe}`)

  // ---------------------------------------------------------------------------------------------- 1. deploy

  const deployerKey = ANVIL_DEV_KEYS[9] as Hex
  const deployer = devAccount(9)
  const guardian = devAccount(8)
  const outV1 = await forgeScript(handle.url, 'script/Deploy.s.sol', deployer.address, { key: deployerKey }, { POLICY_SALT_NONCE: '7', GAS_POLICY_SALT_NONCE: '8', CARDINALITY_TARGET: '3600' })
  const v1 = /MamoruActionPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(outV1)?.[1] as Address
  const gasPolicy = /MamoruGasPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(outV1)?.[1] as Address
  const outV2 = await forgeScript(handle.url, 'script/DeployV2.s.sol', deployer.address, { key: deployerKey }, { GUARDIAN: guardian.address, POLICY_V2_SALT_NONCE: '9', CARDINALITY_TARGET: '3600' })
  const v2 = /MamoruActionPolicyV2:\s*(0x[0-9a-fA-F]{40})/.exec(outV2)?.[1] as Address
  if (!v1 || !gasPolicy || !v2) throw new Error('forge scripts printed no addresses')
  note('Deploy.s.sol + DeployV2.s.sol --broadcast on the local fork', true, `V1 ${v1}, MamoruGasPolicy ${gasPolicy}, V2 ${v2}`)

  // V3 at its pinned address. DeployV3.s.sol `run()` refuses a chain id other than 8453/143 and the lab fork is 31337, so the
  // script cannot run as is; its `deploy` is `ModuleRegistry.deployModule(salt = PINNED_DEPLOYER ++ nonce 4, resolverUID,
  // initCode(PINNED_GUARDIAN, argsFor(8453)))` and CREATE2 depends only on the registry, the salt and the init code hash, so the
  // same call from the pinned deployer (impersonated by the local anvil, no key) lands at the pinned address iff the init code
  // hash is the pinned one (0x73a0d406...). The address equality below is that check.
  const registryAddr = address('ModuleRegistry', baseRegistry)
  const resolverRef = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findModule', args: [address('TimeFramePolicy', baseRegistry)] })
  const v3Artifact = await loadPolicyArtifact(join(REPO_ROOT, 'contracts/action-policy/out/MamoruActionPolicyV3.sol/MamoruActionPolicyV3.json'))
  const v3Args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address[]' }, { type: 'address' }, { type: 'address' }, { type: 'uint32' }],
    [
      address('SmartSession', baseRegistry),
      '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', // npm
      '0x2626664c2603336E57B271c5C0b26F421741e481', // Router02
      '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // factory
      PINNED_GUARDIAN,
      ['0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61', '0xC768c589647798a6EE01A91FdE98EF2ed046DBD6'], // gtUSDCp, waBasUSDC
      '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', // TokenMessengerV2
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      15,
    ],
  )
  const v3Init = concat([v3Artifact.bytecode, v3Args]) as Hex
  const v3Data = encodeFunctionData({ abi: registryDeployAbi, functionName: 'deployModule', args: [concat([PINNED_DEPLOYER, toHex(4n, { size: 12 })]) as Hex, resolverRef.resolverUID, v3Init, '0x', '0x'] })
  await lab.setBalance(PINNED_DEPLOYER, 10n ** 19n)
  const v3Tx = await lab.sendAs(PINNED_DEPLOYER, registryAddr, v3Data)
  const v3 = PINNED_V3
  const v3Code = await lab.client.getCode({ address: v3 })
  note('V3 deployed at its pinned address (pinned deployer impersonated, nonce 4, PINNED_GUARDIAN, argsFor(8453))', v3Tx.ok && (v3Code?.length ?? 2) > 2, `tx ${v3Tx.receipt.gasUsed} gas, ${((v3Code?.length ?? 2) - 2) / 2} bytes at ${v3}`)
  if (!v3Tx.ok || (v3Code?.length ?? 2) <= 2) throw new Error('V3 is not at its pinned address: the init code hash moved')
  const reference = resolverRef
  const smartSession = address('SmartSession', baseRegistry)
  // MamoruPauseGate(SMART_SESSION, V3), through deployModule from a dev account (DeployPauseGate.s.sol's steps; that script pins the production deployer).
  const gateArtifact = await loadPolicyArtifact(join(REPO_ROOT, 'contracts/action-policy/out/MamoruPauseGate.sol/MamoruPauseGate.json'))
  const gateInit = concat([gateArtifact.bytecode, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [smartSession, v3])]) as Hex
  const gateSalt = concat([deployer.address, toHex(41n, { size: 12 })]) as Hex
  const gateData = encodeFunctionData({ abi: registryDeployAbi, functionName: 'deployModule', args: [gateSalt, reference.resolverUID, gateInit, '0x', '0x'] })
  const gatePredicted = getAddress(`0x${((await lab.client.call({ account: deployer.address, to: registryAddr, data: gateData, gas: 16_000_000n })).data ?? '0x').slice(-40)}`) as Address
  const gateTx = await lab.send(deployer, registryAddr, gateData, 0n, 16_000_000n)
  if (!gateTx.ok) throw new Error('deployModule(MamoruPauseGate) reverted')
  const gate = gatePredicted
  for (const [name, m] of [['V2', v2], ['V3', v3], ['MamoruPauseGate', gate], ['MamoruGasPolicy', gasPolicy]] as const) {
    const rec = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findModule', args: [m] })
    note(`findModule(${name}): a ModuleRecord under Mamoru's resolver`, BigInt(rec.sender) !== 0n && rec.resolverUID === reference.resolverUID, `sender ${rec.sender}`)
  }

  // The operator's policy objects (boot.ts deployedV4 / deployedV5 / deployedV6).
  const gasCfg = { address: gasPolicy, caps: V4_GAS_CAPS }
  const p4 = withActionPolicy(conservadorLabV4, v1, Object.values(V4_POOLS), { caps: v4BudgetCaps(conservadorLabV4, CAP_USDC), gasPolicy: gasCfg })
  const p5 = withActionPolicy(conservadorLabV5, v2, Object.values(V4_POOLS), { caps: v4BudgetCaps(conservadorLabV5, CAP_USDC), gasPolicy: gasCfg, contractVersion: 2 })
  const p6 = withActionPolicy(conservadorLabV6, v3, [V6_POOLS.stables, V6_POOLS.balance, V4_POOLS.btc], { gasPolicy: gasCfg, contractVersion: 3, pauseGate: gate })
  // Legacy v2 (no action policy): 12 sessions + per-position `manage` grants. v3 has no policy object in the code (only a
  // name in the operator's migration sets): its on-chain grant set is v2's, so it is measured as v2.
  const p2: PolicyVersion = { ...conservadorLiveV2, policyId: 'conservador-lab-v2', chain: 'fork' }
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, BTC, 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, RISK, 'WETH', 'USDC', 'WETH'),
  }
  let salt = 0
  const nextSalt = (): Hex => `0x${(++salt).toString(16).padStart(64, '0')}` as Hex
  const tokenOf = (n: string) => address(n as never, baseRegistry)

  // ---------------------------------------------------------------------------------------------- owner transactions

  async function ownerTxData(calls: MultiSendCall[], by: 'passkey' | 'backup'): Promise<Hex> {
    const nonce = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
    const b = calls.length === 1 ? { to: calls[0]!.to, data: calls[0]!.data, operation: OPERATION_CALL } : multiSendCallOnly(calls)
    const tx: SafeTx = { to: b.to, value: 0n, data: b.data, operation: b.operation as 0 | 1, nonce }
    return execTransactionData(tx, await ownerSignature(lab, acct, tx, by))
  }
  /** The owner's passkey-signed transaction, gas limit just under Base's 2^24. */
  const ownerTx = async (calls: MultiSendCall[]): Promise<TxResult> => lab.send(relayer, safe, await ownerTxData(calls, 'passkey'), 0n, BASE_PER_TX_GAS_CAP - 1n)
  /** eth_estimateGas of the same transaction (backup-signed) plus the passkey check. */
  const estimated = async (calls: MultiSendCall[]): Promise<bigint> =>
    (await lab.client.estimateGas({ account: relayer.address, to: safe, data: await ownerTxData(calls, 'backup'), gas: BASE_PER_TX_GAS_CAP - 1n })) + PASSKEY_VERIFY_GAS
  /** operator.ts ownerTxGasLimit. */
  async function operatorLimit(calls: MultiSendCall[]): Promise<bigint | null> {
    const ms = multiSendCallOnly(calls)
    const call = [{ from: relayer.address, to: safe, data: encodeFunctionData({ abi: storageAccessibleAbi, functionName: 'simulateAndRevert', args: [ms.to, ms.data] }) }]
    const head = BigInt(await lab.rpc<Hex>('eth_blockNumber'))
    const [r] = await simulateCalls(lab.client as never, call, head).catch(() => simulateCalls(lab.client as never, call, head - 1n))
    if (!r || r.returnData.length < 130 || BigInt(r.returnData.slice(0, 66)) !== 1n) return null
    return (r.gasUsed * 9n) / 8n + PASSKEY_VERIFY_GAS
  }

  // ---------------------------------------------------------------------------------------------- account builders

  /** One approval of v4/v5 `policy` as the operator sends it: split by simulated gas under V4_TX_GAS_TARGET (fitV4). */
  async function approveSplit(label: string, policy: PolicyVersion, generation: bigint, sessionKey: Address, attest: Address[]): Promise<Built[]> {
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
      const fit = await fitPrefixBySimulation(remaining, guess, async (keys) => operatorLimit((await build(keys)).calls))
      if (fit.n === 0) throw new Error(`${label}: not even one session fits ${V4_TX_GAS_TARGET}`)
      const b = await build(remaining.slice(0, fit.n))
      const r = await ownerTx(b.calls)
      if (!r.ok) throw new Error(`${label} tx ${i + 1} reverted`)
      out.push(b)
      remaining = remaining.slice(fit.n)
    }
    return out
  }

  /** Legacy v2/v3 (no action policy): its 12 sessions enabled four at a time (today's activation dropped pairs to fit). */
  async function enableLegacy(policy: PolicyVersion, sessionKey: Address): Promise<Hex[]> {
    const keys = policy.session.grants.filter((g) => !g.perPosition).map(grantKey)
    const caps = computeCaps(policy, CAP_USDC, prices)
    const ids: Hex[] = []
    for (let i = 0; i < keys.length; i += 4) {
      const now = await engineNow()
      const grants = keys.slice(i, i + 4).map((k) => instantiateGrant(policy, k, { account: safe, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now - 60, validUntil: now + policy.session.validitySeconds, caps, capUsdc: CAP_USDC }))
      const batch = activationBatch({ safe } as LiveAccount, grants, [], { trust: false })
      const r = await ownerTx(batch.calls)
      if (!r.ok) throw new Error('legacy enable reverted')
      ids.push(...batch.permissionIds)
    }
    return ids
  }

  /** A legacy account's per-position `manage` grant for each of `tokenIds` (one per position, enabled after its mint). */
  async function enableManage(policy: PolicyVersion, sessionKey: Address, tokenIds: bigint[], pools: string[]): Promise<Hex[]> {
    const caps = computeCaps(policy, CAP_USDC, prices)
    const ids: Hex[] = []
    for (let i = 0; i < tokenIds.length; i += 4) {
      const now = await engineNow()
      const grants = tokenIds.slice(i, i + 4).map((tokenId, j) => instantiateGrant(policy, `manage:${pools[i + j]}`, { account: safe, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now - 60, validUntil: now + policy.session.validitySeconds, caps, capUsdc: CAP_USDC, tokenId, admittedTokenIds: [tokenId] }))
      const batch = activationBatch({ safe } as LiveAccount, grants, [], { trust: false })
      const r = await ownerTx(batch.calls)
      if (!r.ok) throw new Error('legacy manage enable reverted')
      ids.push(...batch.permissionIds)
    }
    return ids
  }

  const mintedId = (r: { receipt?: { logs: readonly unknown[] } } | undefined) =>
    r?.receipt ? parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: r.receipt.logs as never, eventName: 'Transfer' }).find((l) => l.args.to.toLowerCase() === safe.toLowerCase() && BigInt(l.args.from) === 0n)?.args.tokenId : undefined

  /** The owner mints a position in `pool` outside any policy (the legacy engine's mints are plain NPM mints to the Safe). */
  async function ownerMint(pool: { pool: string; token0: string; token1: string }, a0: bigint, a1: bigint): Promise<bigint> {
    const [, tick] = await lab.client.readContract({ address: address(pool.pool, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' })
    const sps = await lab.client.readContract({ address: address(pool.pool, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'tickSpacing' })
    const { tickLower, tickUpper } = rangeAround(tick, Math.max(200 * sps, 20), sps)
    const r = await ownerTx(
      [
        approve(pool.token0 as never, 'NonfungiblePositionManager', a0),
        approve(pool.token1 as never, 'NonfungiblePositionManager', a1),
        mint({ account: safe, pool: pool.pool, tickLower, tickUpper, amount0Desired: a0, amount1Desired: a1, amount0Min: 1n, amount1Min: 1n, deadline: BigInt(await engineNow()) + 600n }),
      ].map((c) => ({ ...c, value: 0n })),
    )
    const id = mintedId(r as never)
    if (!r.ok || id === undefined) throw new Error(`owner mint in ${pool.pool} failed`)
    return id
  }

  /** Two owner positions (WETH/USDC and USDC/USDT), as t11. */
  async function ownerPositions(): Promise<{ ids: bigint[]; pools: string[]; admit: Partial<Record<string, bigint[]>> }> {
    const buy = (tokenOut: string, fee: number, amountIn: bigint) => ({ to: address('SwapRouter02', baseRegistry), value: 0n, data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: tokenOf('USDC'), tokenOut: tokenOf(tokenOut), fee, recipient: safe, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] }) })
    const r = await ownerTx([{ ...approve('USDC', 'SwapRouter02', 100_000_000n), value: 0n }, buy('WETH', 3000, 50_000_000n), buy('USDT', 100, 50_000_000n)])
    if (!r.ok) throw new Error('owner swaps for the positions reverted')
    const inRisk = await ownerMint(V6_POOLS.balance, (await lab.balanceOf('WETH', safe)) / 2n, 20_000_000n)
    const inStables = await ownerMint(V6_POOLS.stables, 20_000_000n, (await lab.balanceOf('USDT', safe)) / 2n)
    return { ids: [inRisk, inStables], pools: [RISK, STABLES], admit: { [RISK]: [inRisk], [STABLES]: [inStables] } }
  }

  // v4/v5 sessions (t8/t9): swap + mint through the account's own policy contract, admitted there.
  function pick(parts: Built[], key: string): Session {
    for (const p of parts) {
      const i = p.keys.indexOf(key)
      if (i >= 0) {
        acct.ledger.activate(p.permissionIds[i]!, p.grants[i]!)
        return { name: key, grant: p.grants[i]!, permissionId: p.permissionIds[i]! }
      }
    }
    throw new Error(`no session ${key}`)
  }
  async function op(label: string, s: Session, calls: { to: Address; data: Hex }[], key: PrivateKeyAccount): Promise<SessionOpOutcome> {
    const eg = engineGas((await lab.client.getBlock()).baseFeePerGas ?? 0n, V4_GAS_CAPS)
    if (!eg) throw new Error('basefee over the gas cap on the fork')
    return sendSessionOp(world, acct, s, label, calls, { gas: eg, sessionKey: key })
  }
  async function swapBatch(policyAddr: Address, pool: string, tokenIn: string, tokenOut: string, fee: number, amountIn: bigint, withDeadline: boolean): Promise<{ to: Address; data: Hex }[]> {
    const [minOut, limit] = await lab.client.readContract({ address: policyAddr, abi: policyAbi, functionName: 'swapBounds', args: [safe, address(pool, baseRegistry), tokenOf(tokenIn), amountIn] })
    return [
      ...(withDeadline ? [deadlineCheck(BigInt(await engineNow()) + 300n)] : []),
      approve(tokenIn as never, 'SwapRouter02', amountIn),
      { to: address('SwapRouter02', baseRegistry), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: tokenOf(tokenIn), tokenOut: tokenOf(tokenOut), fee, recipient: safe, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: limit }] }) },
    ]
  }

  /** A v4 (on V1) or v5 (on V2) account with the engine's WETH/USDC and USDC/cbBTC positions minted through its policy contract. */
  async function engineAccount(label: string, policy: PolicyVersion, policyAddr: Address, withDeadline: boolean, positions: boolean): Promise<Held> {
    const key = devAccount(5)
    const parts = await approveSplit(`${label} activation`, policy, 1n, key.address, [policyAddr, gasPolicy])
    const old = parts.flatMap((b) => b.permissionIds)
    const admit: Partial<Record<string, bigint[]>> = {}
    const ids: bigint[] = []
    if (positions) {
      const sw = await op(`${label}-swap-weth`, pick(parts, `enter-swap:${RISK}`), await swapBatch(policyAddr, RISK, 'USDC', 'WETH', 3000, 80_000_000n, withDeadline), key)
      if (sw.verdict !== 'INCLUDED') throw new Error(`${label}: WETH swap ${sw.verdict}`)
      {
        const tick = (await lab.client.readContract({ address: address(RISK, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
        const { tickLower, tickUpper } = rangeAround(tick, 2_000, 60)
        const weth = await lab.balanceOf('WETH', safe)
        const e = V4_POOLS.risk
        const params = { token0: address(e.token0, baseRegistry), token1: address(e.token1, baseRegistry), fee: e.fee, tickLower, tickUpper, amount0Desired: weth / 2n, amount1Desired: 40_000_000n, amount0Min: 1n, amount1Min: 1n, recipient: safe, deadline: BigInt(await engineNow()) + 3_600n }
        const m = await op(`${label}-mint-weth`, pick(parts, `enter-mint:${RISK}`), [approveTo('WETH', policyAddr, params.amount0Desired), approveTo('USDC', policyAddr, params.amount1Desired), { to: policyAddr, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }], key)
        const id = mintedId(m)
        if (m.verdict !== 'INCLUDED' || id === undefined) throw new Error(`${label}: WETH mint ${m.verdict}`)
        admit[RISK] = [id]
        ids.push(id)
      }
      const sb = await op(`${label}-swap-btc`, pick(parts, `enter-swap:${BTC}`), await swapBatch(policyAddr, BTC, 'USDC', 'cbBTC', 500, 300_000_000n, withDeadline), key)
      if (sb.verdict !== 'INCLUDED') throw new Error(`${label}: cbBTC swap ${sb.verdict}`)
      {
        const tick = (await lab.client.readContract({ address: address(BTC, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
        const { tickLower, tickUpper } = rangeAround(tick, 2_000, 10)
        const cbbtc = await lab.balanceOf('cbBTC', safe)
        const e = V4_POOLS.btc
        const params = { token0: address(e.token0, baseRegistry), token1: address(e.token1, baseRegistry), fee: e.fee, tickLower, tickUpper, amount0Desired: 300_000_000n, amount1Desired: cbbtc / 2n, amount0Min: 1n, amount1Min: 1n, recipient: safe, deadline: BigInt(await engineNow()) + 3_600n }
        const m = await op(`${label}-mint-btc`, pick(parts, `enter-mint:${BTC}`), [approveTo('USDC', policyAddr, params.amount0Desired), approveTo('cbBTC', policyAddr, params.amount1Desired), { to: policyAddr, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }], key)
        const id = mintedId(m)
        if (m.verdict !== 'INCLUDED' || id === undefined) throw new Error(`${label}: cbBTC mint ${m.verdict}`)
        admit[BTC] = [id]
        ids.push(id)
      }
    }
    return { old, prior: policyAddr, admit, ids, sessions: old.length }
  }

  // ---------------------------------------------------------------------------------------------- the move to v6 on V3

  const registryAttested = async (m: Address, approvalEnd: number) => {
    const a = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findAttestation', args: [m, safe] })
    const lapses = Number(a.expirationTime) !== 0 && Number(a.expirationTime) <= approvalEnd
    const inForce = Number(a.time) !== 0 && Number(a.revocationTime) === 0
    return { need: !inForce || lapses, re: inForce && lapses }
  }

  const d6: V4Deployment = v4DeploymentOf(p6)!
  const key6 = devAccount(6)
  const caps6 = computeCaps(p6, CAP_USDC, prices)
  const budgets6 = v4BudgetCaps(p6, CAP_USDC)
  const keys6 = orderV4Keys(p6, p6.session.grants.filter((g) => !g.perPosition).map(grantKey))
  const actionsOf = (k: string) => p6.session.grants.find((g) => grantKey(g) === k)?.actions.length ?? 0
  note('v6 on V3: sessions and actions', null, `${keys6.length} sessions / ${keys6.reduce((n, k) => n + actionsOf(k), 0)} actions (${keys6.map((k) => `${k.replace('pool:', '')}=${actionsOf(k)}`).join(', ')})`)

  // The remote Safe, as t9 (the account's keys, a dev session key for Monad, the bridge total at this cap).
  const remoteKey = devAccount(3)
  const bucket = p6.remoteBuckets![0]!
  const ctx = { owners: [address('SafeWebAuthnSharedSigner', baseRegistry), acct.backupOwner.address], saltNonce: '1', passkey: { x: toHex(acct.passkey.x), y: toHex(acct.passkey.y) } }
  const monad = withPinnedV3()
  const remotePolicy = remoteInput(ctx as never, { chainId: bucket.chainId, policyId: bucket.policyId, sessionKey: remoteKey.address, validAfter: 0, validUntil: 0, capUsdc: '1' }, monad).policy
  const bridgeTotal = p6.session.grants.find((g) => g.name === 'bridge-out')?.actions.flatMap((a) => a.params).find((r) => r.cumulative)?.cumulative
  const bridgeCap = bridgeTotal ? v4BudgetCaps(p6, CAP_USDC)[bridgeTotal.slice(4)] : undefined
  if (!bridgeCap || bridgeCap <= 0n) throw new Error('no bridge total to size the remote Safe at')
  const nowB = await engineNow()
  const spec = { chainId: bucket.chainId, policyId: bucket.policyId, sessionKey: remoteKey.address, validAfter: nowB - 60, validUntil: nowB + remotePolicy.session.validitySeconds, capUsdc: bridgeCap.toString() }
  const remoteAccount = remoteSafe(remoteInput(ctx as never, spec, monad)).address

  const enabled = async (ids: Hex[]) => Promise.all(ids.map((id) => lab.client.readContract({ address: smartSession, abi: smartSessionStateAbi, functionName: 'isPermissionEnabled', args: [id, safe] })))

  /** Both ways of making the move for the account state `h` (taken from a snapshot each), then the checks on the split path. */
  async function measureMove(label: string, h: Held): Promise<void> {
    const prior = h.prior ? await lab.client.readContract({ address: h.prior, abi: policyAbi, functionName: 'generationOf', args: [safe] }) : 0n
    const current = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'generationOf', args: [safe] })
    const moveGen = (prior > current ? prior : current) + 1n // the operator's v4Context + priorGeneration
    const nowM = await engineNow()
    const approvalEnd = nowM + p6.session.validitySeconds
    const attest: Address[] = []
    const reattest: Address[] = []
    for (const m of [d6.actionPolicy, d6.gasPolicy, ...(d6.pauseGate ? [d6.pauseGate] : [])]) {
      const a = await registryAttested(m, approvalEnd)
      if (a.need) attest.push(m)
      if (a.re) reattest.push(m)
    }
    const attestData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [moveGen, BigInt(nowM)])
    /** `keys` of the move as one owner transaction; `first`: carries the revokes, attests and the generation jump. */
    const buildTx = async (keys: string[], first: boolean): Promise<Built> => {
      const now = await engineNow()
      const grants = keys.map((k) => {
        const g = instantiateGrant(p6, k, { account: safe, sessionKey: key6.address, chainId: lab.chainId, salt: nextSalt(), validAfter: now - 60, validUntil: now + p6.session.validitySeconds, caps: caps6, admittedTokenIds: [], capUsdc: CAP_USDC, remoteAccount })
        return g.requiresActionPolicy ? retargetToPolicy(g, d6.actionPolicy) : g
      })
      const batch = activationBatch({ safe } as LiveAccount, grants, [], {
        trust: false,
        policiesFor: v4PoliciesFor(grants, d6, moveGen, budgets6, h.admit),
        ...(first ? { attest, reattest, attestData } : { attest: [], reattest: [] }),
      })
      return { keys, grants, permissionIds: batch.permissionIds, calls: first ? [...revocationCalls(h.old), ...batch.calls] : batch.calls }
    }
    const actionsIn = (keys: string[]) => keys.reduce((n, k) => n + actionsOf(k), 0)

    // A. the whole move as ONE owner transaction
    const S1 = await lab.snapshot()
    const whole = await buildTx(keys6, true)
    const limitAll = await operatorLimit(whole.calls)
    const estAll = await estimated(whole.calls)
    const rAll = await ownerTx(whole.calls)
    const gasAll = rAll.receipt.gasUsed
    const fits145 = limitAll === null ? null : limitAll <= FIT_TARGET
    const fits162 = limitAll === null ? null : limitAll <= RENEW_GAS_BUDGET
    note(`${label}: ONE owner tx (${h.old.length} revoked + ${keys6.length} v6 sessions, ${h.ids.length} admitted)`, null, `${rAll.ok ? `${gasAll} gas used` : `REVERTED/OUT OF GAS at 2^24-1 (${gasAll} used)`}, operator limit ${limitAll}, estimateGas+passkey ${estAll}; <= ${FIT_TARGET} (fit target): ${fits145}; <= ${RENEW_GAS_BUDGET}: ${fits162}`)
    await lab.revert(S1)

    // B. the move as planRenew splits it today
    const S2 = await lab.snapshot()
    let remaining = keys6
    const perTx: Row['split']['perTx'] = []
    const built: Built[] = []
    let tooLarge = false
    for (let i = 0; remaining.length; i++) {
      const first = i === 0
      const guess = splitV4Keys(p6, remaining, { overheadGas: first ? BigInt(h.old.length) * 190_000n + 150_000n : 0n, ceiling: FIT_TARGET })[0]?.length ?? 1
      const fit = await fitPrefixBySimulation(remaining, guess, async (ks) => operatorLimit((await buildTx(ks, first)).calls), FIT_TARGET)
      if (fit.n === 0) {
        note(`${label}: RENEWAL_TOO_LARGE at transaction ${i + 1}`, null, 'not even one session fits: the operator refuses (HTTP 409), nothing changed')
        tooLarge = i === 0
        break
      }
      const b = await buildTx(remaining.slice(0, fit.n), first)
      const limit = await operatorLimit(b.calls)
      const r = await ownerTx(b.calls)
      if (!r.ok) throw new Error(`${label}: split tx ${i + 1} reverted`)
      perTx.push({ sessions: b.keys.length, actions: actionsIn(b.keys), gasUsed: r.receipt.gasUsed.toString(), operatorLimit: limit?.toString() ?? null, keys: b.keys })
      built.push(b)
      remaining = remaining.slice(fit.n)
    }
    const total = perTx.reduce((n, t) => n + BigInt(t.gasUsed), 0n)
    note(`${label}: as planRenew splits it`, null, `${perTx.length} owner tx (passkey prompts): ${perTx.map((t) => `${t.sessions} sessions/${t.actions} actions ${t.gasUsed} gas (limit ${t.operatorLimit})`).join(' | ')}; total ${total}`)

    // checks after the split path (none when the operator refused: nothing was sent)
    if (!tooLarge) {
      const wasOn = await enabled(h.old)
      note(`${label}: every old permission is disabled`, wasOn.every((x) => !x), `${wasOn.filter((x) => x).length} of ${h.old.length} still enabled`)
      const nowOn = await enabled(built.flatMap((b) => b.permissionIds))
      note(`${label}: every v6 permission is enabled`, nowOn.length === keys6.length && nowOn.every((x) => x), `${nowOn.filter((x) => x).length} of ${keys6.length}`)
      const gen = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'generationOf', args: [safe] })
      note(`${label}: V3.generationOf == prior + 1`, gen === moveGen, `${gen} (prior ${prior})`)
      for (const [pool, ids] of Object.entries(h.admit)) {
        for (const id of ids ?? []) {
          const at = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'admittedPool', args: [safe, id] })
          note(`${label}: V3 admitted position ${id} of ${pool.replace('pool:', '')}`, at.toLowerCase() === address(pool, baseRegistry).toLowerCase(), at)
        }
      }

    } else {
      const wasOn = await enabled(h.old)
      note(`${label}: operator refused; every old permission is still enabled, nothing changed`, wasOn.every((x) => x), `${wasOn.filter((x) => x).length} of ${h.old.length}`)
    }
    await lab.revert(S2)

    rows.push({
      account: label,
      oldSessions: h.old.length,
      positions: h.ids.length,
      v6Sessions: keys6.length,
      v6Actions: actionsIn(keys6),
      oneTx: { gasUsed: gasAll.toString(), ok: rAll.ok, operatorLimit: limitAll?.toString() ?? null, estimateGasPlusPasskey: estAll.toString(), fits14_5: fits145, fits16_2: fits162, note: rAll.ok ? 'landed' : 'reverted' },
      split: { txs: perTx.length, perTx, totalGas: total.toString() },
    })
  }

  // ---------------------------------------------------------------------------------------------- the accounts

  await lab.setBalance(safe, 10n ** 18n)
  await lab.whaleTransfer('USDC', WHALE, safe, 3_000_000_000n)
  const S0 = await lab.snapshot()
  let cur = S0
  const fresh = async () => {
    await lab.revert(cur)
    cur = await lab.snapshot()
  }

  // T12_STRESS=N: only a legacy v2/v3 account holding N positions (half in WETH/USDC, half in USDC/USDT), each with its own
  // per-position manage grant (N + 12 sessions revoked, N admitted): where the one-transaction move stops fitting.
  const stressN = Number(process.env.T12_STRESS ?? 0)
  if (stressN > 0) {
    const base = await enableLegacy(p2, key6.address)
    const buy = (tokenOut: string, fee: number, amountIn: bigint) => ({ to: address('SwapRouter02', baseRegistry), value: 0n, data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: tokenOf('USDC'), tokenOut: tokenOf(tokenOut), fee, recipient: safe, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] }) })
    const sw = await ownerTx([{ ...approve('USDC', 'SwapRouter02', 400_000_000n), value: 0n }, buy('WETH', 3000, 200_000_000n), buy('USDT', 100, 200_000_000n)])
    if (!sw.ok) throw new Error('stress swaps reverted')
    const w0 = await lab.balanceOf('WETH', safe)
    const t0b = await lab.balanceOf('USDT', safe)
    const ids: bigint[] = []
    const pools: string[] = []
    const admit: Partial<Record<string, bigint[]>> = {}
    for (let i = 0; i < stressN; i++) {
      const risk = i % 2 === 0
      const id = risk ? await ownerMint(V6_POOLS.balance, w0 / BigInt(stressN), 10_000_000n) : await ownerMint(V6_POOLS.stables, 10_000_000n, t0b / BigInt(stressN))
      const pool = risk ? RISK : STABLES
      ids.push(id)
      pools.push(pool)
      ;(admit[pool] ??= []).push(id)
    }
    const manage = await enableManage(p2, key6.address, ids, pools)
    await measureMove(`stress: legacy v2/v3 (12 sessions + ${stressN} per-position manage, ${stressN} positions)`, { old: [...base, ...manage], prior: null, admit, ids, sessions: base.length + manage.length })
    await fresh()
  } else {
  {
    const h = await engineAccount('v5', p5, v2, true, true)
    await measureMove('v5 (V2, 9 sessions, 2 engine positions)', h)
    await fresh()
  }
  {
    const h = await engineAccount('v5-nopos', p5, v2, true, false)
    await measureMove('v5 (V2, 9 sessions, no positions)', h)
    await fresh()
  }
  {
    const h = await engineAccount('v4', p4, v1, false, true)
    await measureMove('v4 (V1, 9 sessions, 2 engine positions)', h)
    await fresh()
  }
  {
    const h = await engineAccount('v4-nopos', p4, v1, false, false)
    await measureMove('v4 (V1, 9 sessions, no positions)', h)
    await fresh()
  }
  {
    const ids = await enableLegacy(p2, key6.address)
    await measureMove('v2/v3 legacy (12 sessions, no positions)', { old: ids, prior: null, admit: {}, ids: [], sessions: ids.length })
    await fresh()
  }
  {
    const base = await enableLegacy(p2, key6.address)
    const held = await ownerPositions()
    const manage = await enableManage(p2, key6.address, held.ids.slice(0, 1), held.pools.slice(0, 1))
    await measureMove('v2/v3 legacy (12 sessions + 1 per-position manage, 1 position)', { old: [...base, ...manage], prior: null, admit: { [RISK]: held.ids.slice(0, 1) }, ids: held.ids.slice(0, 1), sessions: base.length + manage.length })
    await fresh()
  }
  {
    const base = await enableLegacy(p2, key6.address)
    const held = await ownerPositions()
    const manage = await enableManage(p2, key6.address, held.ids, held.pools)
    await measureMove('v2/v3 legacy (12 sessions + 2 per-position manage, 2 positions)', { old: [...base, ...manage], prior: null, admit: held.admit, ids: held.ids, sessions: base.length + manage.length })
    await fresh()
  }

  }

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, v1, v2, v3, gate, gasPolicy, safe, fitTarget: FIT_TARGET.toString(), renewBudget: RENEW_GAS_BUDGET.toString(), rows, lines: reportLines })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t12', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
  exitCode = 1
} finally {
  await handle.stop()
  proxy.stop()
}

console.log('\n=== rows ===')
for (const r of rows) console.log(JSON.stringify(r))
console.log('\n=== summary ===')
for (const l of reportLines) console.log(`${l.ok === null ? '-' : l.ok ? 'ok' : 'FAIL'} ${l.step}: ${l.detail}`)
process.exit(exitCode)
