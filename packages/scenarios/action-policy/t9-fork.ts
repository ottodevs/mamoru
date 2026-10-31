// otto/mamoru#251 (GPT-6 review round 2, P1 5): the real v5 -> v6 migration the operator's renew row does, on a Base fork,
// through the same builders the operator uses (`instantiateGrant`, `retargetToPolicy`, `v4PoliciesFor`, `activationBatch`,
// `revocationCalls`, `remoteSafe(remoteInput(..))`, `v4DeploymentOf`, the findModule/findAttestation reads of v4Context),
// never hand-built sessions. Modelled on t8-fork.ts (v4 -> v5):
//   1. deploy on the local fork only: Deploy.s.sol (V1 + MamoruGasPolicy) and DeployV2.s.sol (V2) as t8, then
//      MamoruActionPolicyV3 with DeployV3.s.sol `argsFor(8453)` and MamoruPauseGate(SMART_SESSION, V3), each in one
//      `ModuleRegistry.deployModule` call (ModuleRecord checked under Mamoru's resolver);
//   2. a v5 account as in production: conservadorLabV5 on V2 (generation 1), an engine mint through V2.mint in WETH/USDC and
//      one in USDC/cbBTC;
//   3. the move to v6 in ONE owner transaction: conservadorLabV6 wired as boot.ts deployedV6, a remote Safe address from
//      remoteSafe(remoteInput(ctx, spec, withPinnedV3())), every v6 grant instantiated with it, retargeted to V3, generation
//      = V2's + 1, both positions admitted, every v5 session revoked, V3/gas/gate attested; asserted under
//      V4_TX_GAS_TARGET and Base's 2^24 (the transaction is sent with 2^24 as its gas limit);
//   4. after: v5 permissions disabled, v6 enabled, generation, admittedPool, a v5 session refused;
//   5. v6 manage-any sessions (V3 only) and the cbBTC exit-only session: what is included and what is refused;
//   6. bridge-out: depositForBurn to the remote Safe included, to another recipient refused; the guardian pauses at V3:
//      refused by the gate; unpaused: passes.
//
// Run (builds the contracts, then the scenario):
//   nix shell nixpkgs#foundry --command bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t9-fork.ts'
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1..t8. Nothing is
// broadcast anywhere but the local anvil.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { concat, encodeAbiParameters, encodeFunctionData, getAddress, pad, parseAbi, parseEventLogs, toHex, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, erc20Abi, mamoruActionPolicyV2Abi, moduleRegistryAbi, nonfungiblePositionManagerAbi, safeAbi, swapRouter02Abi, tokenMessengerV2Abi, uniswapV3PoolAbi, baseRegistry } from '@mamoru/registry'
import {
  V4_GAS_CAPS,
  V4_POOLS,
  V6_POOLS,
  computeCaps,
  conservadorLabV4,
  conservadorLabV5,
  conservadorLabV6,
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
import { remoteInput, remoteSafe, REMOTE_FIRST_GENERATION } from '@mamoru/account/remote'
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
import { simulateCalls } from '@mamoru/rpc'

const CAP_USDC = 1_000_000_000n // 1,000 USDC, as t7/t8
const BASE_PER_TX_GAS_CAP = 16_777_216n
const BTC = V4_POOLS.btc.pool
const RISK = V6_POOLS.balance.pool
const STABLES = V6_POOLS.stables.pool
const CCTP_DOMAIN_MONAD = 15
const CCTP_STANDARD = 2000
const policyAbi = parseAbi([
  'function swapBounds(address account, address pool, address tokenIn, uint256 amountIn) view returns (uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)',
  'function decreaseMins(address account, address pool, uint256 tokenId, uint128 liquidity) view returns (uint256, uint256)',
  'function generationOf(address account) view returns (uint64)',
  'function admittedPool(address account, uint256 tokenId) view returns (address)',
])
const registryDeployAbi = parseAbi(['function deployModule(bytes32 salt, bytes32 resolverUID, bytes initCode, bytes metadata, bytes resolverContext) returns (address)'])
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
  console.error(`t9-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t9-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
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
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t9`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  // base.json now pins MamoruActionPolicyV2 and MamoruPauseGate (live since 27 Oct 2026); the fork block predates them, so
  // they are checked on the live chain, not here (t8-fork.ts fails the same check today).
  const pinnedLater = new Set(['MamoruActionPolicyV2', 'MamoruPauseGate', 'MamoruActionPolicyV3'])
  await assertCodeHashes(lab.client, { ...baseRegistry, entries: baseRegistry.entries.filter((e) => !pinnedLater.has(e.name)) })
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}`)
  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, conservadorLabV4, engineNow)
  const safe = world.a1.safe
  note('fx-safe', true, `Safe7579 account ${safe}`)

  // ---------------------------------------------------------------------------------------------- 1. deploy V1 + gas, V2, V3, gate

  const deployerKey = ANVIL_DEV_KEYS[9] as Hex
  const deployer = devAccount(9)
  const guardian = devAccount(8)
  const outV1 = await forgeScript(handle.url, 'script/Deploy.s.sol', deployer, deployerKey, { POLICY_SALT_NONCE: '7', GAS_POLICY_SALT_NONCE: '8', CARDINALITY_TARGET: '3600' })
  const v1 = /MamoruActionPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(outV1)?.[1] as Address
  const gasPolicy = /MamoruGasPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(outV1)?.[1] as Address
  const outV2 = await forgeScript(handle.url, 'script/DeployV2.s.sol', deployer, deployerKey, { GUARDIAN: guardian.address, POLICY_V2_SALT_NONCE: '9', CARDINALITY_TARGET: '3600' })
  const v2 = /MamoruActionPolicyV2:\s*(0x[0-9a-fA-F]{40})/.exec(outV2)?.[1] as Address
  if (!v1 || !gasPolicy || !v2) throw new Error('forge scripts printed no addresses')
  note('Deploy.s.sol + DeployV2.s.sol --broadcast on the local fork', true, `V1 ${v1}, MamoruGasPolicy ${gasPolicy}, V2 ${v2}`)

  const registryAddr = address('ModuleRegistry', baseRegistry)
  const reference = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findModule', args: [address('TimeFramePolicy', baseRegistry)] })
  // DeployV3.s.sol's `deploy` for Base: the same constructor arguments (`argsFor(8453)`), through ModuleRegistry.deployModule
  // from a dev account (the script's `run` is pinned to the production deployer, guardian and address).
  const smartSession = address('SmartSession', baseRegistry)
  const v3Args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address[]' }, { type: 'address' }, { type: 'address' }, { type: 'uint32' }],
    [
      smartSession,
      '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', // npm
      '0x2626664c2603336E57B271c5C0b26F421741e481', // Router02
      '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // factory
      guardian.address,
      ['0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61', '0xC768c589647798a6EE01A91FdE98EF2ed046DBD6'], // gtUSDCp, waBasUSDC
      '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', // TokenMessengerV2
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      15,
    ],
  )
  const deployModule = async (salt: bigint, initCode: Hex): Promise<Address> => {
    const saltB32 = concat([deployer.address, toHex(salt, { size: 12 })]) as Hex
    const data = encodeFunctionData({ abi: registryDeployAbi, functionName: 'deployModule', args: [saltB32, reference.resolverUID, initCode, '0x', '0x'] })
    const predicted = (await lab.client.call({ account: deployer.address, to: registryAddr, data, gas: 16_000_000n })).data
    const r = await lab.send(deployer, registryAddr, data, 0n, 16_000_000n)
    if (!r.ok) throw new Error(`deployModule reverted (${r.hash})`)
    gas[`deployModule-${salt}`] = r.receipt.gasUsed.toString()
    return getAddress(`0x${(predicted ?? '0x').slice(-40)}`) as Address
  }
  const v3 = await deployModule(40n, concat([creationCode('MamoruActionPolicyV3', 'MamoruActionPolicyV3'), v3Args]))
  const gate = await deployModule(41n, concat([creationCode('MamoruPauseGate', 'MamoruPauseGate'), encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [smartSession, v3])]))
  note('MamoruActionPolicyV3 (argsFor(8453)) and MamoruPauseGate(SMART_SESSION, V3) deployed through deployModule on the local fork', true, `V3 ${v3}, gate ${gate}`)
  for (const [name, m] of [['V2', v2], ['V3', v3], ['MamoruPauseGate', gate], ['MamoruGasPolicy', gasPolicy]] as const) {
    const rec = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findModule', args: [m] })
    note(`findModule(${name}): a ModuleRecord under Mamoru's resolver (what v4Context requires)`, BigInt(rec.sender) !== 0n && rec.resolverUID === reference.resolverUID, `sender ${rec.sender}`)
  }
  const g3 = await lab.client.readContract({ address: v3, abi: mamoruActionPolicyV2Abi, functionName: 'GUARDIAN' })
  note('V3.GUARDIAN is the key the deploy named', g3.toLowerCase() === guardian.address.toLowerCase(), g3)
  const bound = await lab.client.readContract({ address: gate, abi: parseAbi(['function ACTION_POLICY() view returns (address)']), functionName: 'ACTION_POLICY' })
  note('gate.ACTION_POLICY is V3 (boot.ts assertV6Gate)', bound.toLowerCase() === v3.toLowerCase(), bound)
  const v3Code = await lab.client.getCode({ address: v3 })
  note('V3 runtime under EIP-170', ((v3Code?.length ?? 2) - 2) / 2 <= 24_576, `${((v3Code?.length ?? 2) - 2) / 2} bytes`)

  // The operator's policy objects (boot.ts deployedV5 / deployedV6).
  const gasCfg = { address: gasPolicy, caps: V4_GAS_CAPS }
  const p5 = withActionPolicy(conservadorLabV5, v2, Object.values(V4_POOLS), { caps: v4BudgetCaps(conservadorLabV5, CAP_USDC), gasPolicy: gasCfg, contractVersion: 2 })
  const p6 = withActionPolicy(conservadorLabV6, v3, [V6_POOLS.stables, V6_POOLS.balance, V4_POOLS.btc], { gasPolicy: gasCfg, contractVersion: 3, pauseGate: gate })
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, BTC, 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, RISK, 'WETH', 'USDC', 'WETH'),
  }
  let salt = 0
  const nextSalt = (): Hex => `0x${(++salt).toString(16).padStart(64, '0')}` as Hex

  /** t8's approveAll: one v5 approval at `generation`, split by simulated gas as the operator's fitV4. */
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
    const onChain = await lab.client.readContract({ address: d.actionPolicy, abi: policyAbi, functionName: 'generationOf', args: [safe] })
    note(`${label}: generation on chain`, onChain === generation, `${onChain}`)
    return out
  }

  function pick(parts: Built[], key: string): Session {
    for (const p of parts) {
      const i = p.keys.indexOf(key)
      if (i >= 0) {
        world.a1.ledger.activate(p.permissionIds[i]!, p.grants[i]!)
        return { name: key, grant: p.grants[i]!, permissionId: p.permissionIds[i]! }
      }
    }
    throw new Error(`no session ${key}`)
  }

  async function op(label: string, s: Session, calls: { to: Address; data: Hex }[], key: PrivateKeyAccount): Promise<SessionOpOutcome> {
    const eg = engineGas((await lab.client.getBlock()).baseFeePerGas ?? 0n, V4_GAS_CAPS)
    if (!eg) throw new Error('basefee over the gas cap on the fork')
    return sendSessionOp(world, world.a1, s, label, calls, { gas: eg, sessionKey: key })
  }

  async function swapBatch(policyAddr: Address, pool: string, tokenIn: string, tokenOut: string, fee: number, amountIn: bigint, withDeadline: boolean): Promise<{ to: Address; data: Hex }[]> {
    const [minOut, limit] = await lab.client.readContract({ address: policyAddr, abi: policyAbi, functionName: 'swapBounds', args: [safe, address(pool, baseRegistry), address(tokenIn, baseRegistry), amountIn] })
    return [
      ...(withDeadline ? [deadlineCheck(BigInt(await engineNow()) + 300n)] : []),
      approve(tokenIn, 'SwapRouter02', amountIn),
      { to: address('SwapRouter02', baseRegistry), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address(tokenIn, baseRegistry), tokenOut: address(tokenOut, baseRegistry), fee, recipient: safe, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: limit }] }) },
    ]
  }

  const npm = address('NonfungiblePositionManager', baseRegistry)
  const liquidityOf = async (tokenId: bigint) => (await lab.client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] }))[7]
  const verdict = (o: SessionOpOutcome) => `${o.verdict}${o.failedOp?.reason ? ` (${o.failedOp.reason})` : ''}${o.validator ? ` validator=${o.validator}` : ''}`
  const poolAddr = (pool: string) => address(pool, baseRegistry).toLowerCase()
  const enabled = async (ids: Hex[]) => Promise.all(ids.map((id) => lab.client.readContract({ address: smartSession, abi: smartSessionStateAbi, functionName: 'isPermissionEnabled', args: [id, safe] })))
  const mintedId = (o: SessionOpOutcome) => (o.receipt ? parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: o.receipt.logs, eventName: 'Transfer' }).find((l) => l.args.to.toLowerCase() === safe.toLowerCase())?.args.tokenId : undefined)

  // ---------------------------------------------------------------------------------------------- 2. a v5 account on V2

  await lab.setBalance(safe, 10n ** 18n)
  await lab.whaleTransfer('USDC', WHALE, safe, 3_000_000_000n)
  const key5 = devAccount(5)
  const gen5 = await approveV5('v5 activation on V2 (generation 1)', p5, 1n, key5.address, [v2, gasPolicy])
  const v5Generation = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'generationOf', args: [safe] })
  let wethId: bigint
  let btcId: bigint
  {
    const sw = pick(gen5, `enter-swap:${RISK}`)
    const out = await op('t9-v5-swap-weth', sw, await swapBatch(v2, RISK, 'USDC', 'WETH', 3000, 80_000_000n, true), key5)
    note('v5: 80 USDC -> WETH through V2 (enter-swap)', out.verdict === 'INCLUDED', verdict(out))
    const tick = (await lab.client.readContract({ address: address(RISK, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
    const { tickLower, tickUpper } = rangeAround(tick, 2_000, 60)
    const weth = await lab.balanceOf('WETH', safe)
    const e = V4_POOLS.risk
    const params = { token0: address(e.token0, baseRegistry), token1: address(e.token1, baseRegistry), fee: e.fee, tickLower, tickUpper, amount0Desired: weth / 2n, amount1Desired: 40_000_000n, amount0Min: 1n, amount1Min: 1n, recipient: safe, deadline: BigInt(await engineNow()) + 3_600n }
    const m = await op('t9-v5-mint-weth', pick(gen5, `enter-mint:${RISK}`), [approveTo('WETH', v2, params.amount0Desired), approveTo('USDC', v2, params.amount1Desired), { to: v2, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }], key5)
    wethId = mintedId(m)!
    note('v5: the engine mints a WETH/USDC position through V2.mint', m.verdict === 'INCLUDED' && wethId !== undefined, `${verdict(m)} tokenId ${wethId}`)
  }
  {
    const sw = pick(gen5, `enter-swap:${BTC}`)
    const out = await op('t9-v5-swap-btc', sw, await swapBatch(v2, BTC, 'USDC', 'cbBTC', 500, 300_000_000n, true), key5)
    note('v5: 300 USDC -> cbBTC through V2 (enter-swap)', out.verdict === 'INCLUDED', verdict(out))
    const tick = (await lab.client.readContract({ address: address(BTC, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
    const { tickLower, tickUpper } = rangeAround(tick, 2_000, 10)
    const cbbtc = await lab.balanceOf('cbBTC', safe)
    const e = V4_POOLS.btc
    const params = { token0: address(e.token0, baseRegistry), token1: address(e.token1, baseRegistry), fee: e.fee, tickLower, tickUpper, amount0Desired: 300_000_000n, amount1Desired: cbbtc / 2n, amount0Min: 1n, amount1Min: 1n, recipient: safe, deadline: BigInt(await engineNow()) + 3_600n }
    const m = await op('t9-v5-mint-btc', pick(gen5, `enter-mint:${BTC}`), [approveTo('USDC', v2, params.amount0Desired), approveTo('cbBTC', v2, params.amount1Desired), { to: v2, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }], key5)
    btcId = mintedId(m)!
    note('v5: the engine mints a USDC/cbBTC position through V2.mint', m.verdict === 'INCLUDED' && btcId !== undefined, `${verdict(m)} tokenId ${btcId}`)
  }
  for (const [name, id, pool] of [['WETH/USDC', wethId, RISK], ['USDC/cbBTC', btcId, BTC]] as const) {
    const at = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'admittedPool', args: [safe, id] })
    note(`V2 holds the ${name} position as admitted`, at.toLowerCase() === poolAddr(pool), at)
  }

  // ---------------------------------------------------------------------------------------------- 3. the move to v6 on V3, one transaction

  const priorGen = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'generationOf', args: [safe] }) // priorGeneration
  const currentGen = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'generationOf', args: [safe] })
  const moveGen = (priorGen > currentGen ? priorGen : currentGen) + 1n
  const d6: V4Deployment = v4DeploymentOf(p6)!
  note('v4DeploymentOf(v6) names V3, the gas policy and the gate', d6.actionPolicy === v3 && d6.gasPolicy === gasPolicy && d6.pauseGate === gate, `${d6.actionPolicy} ${d6.gasPolicy} ${d6.pauseGate}`)

  // The remote Safe, as remoteFor: the account's keys, a (dev) session key for Monad, the bridge total at this cap.
  const remoteKey = devAccount(3)
  const bucket = p6.remoteBuckets![0]!
  const ctx = { owners: [address('SafeWebAuthnSharedSigner', baseRegistry), world.a1.backupOwner.address], saltNonce: '1', passkey: { x: toHex(world.a1.passkey.x), y: toHex(world.a1.passkey.y) } }
  const monad = withPinnedV3()
  const remotePolicy = remoteInput(ctx as never, { chainId: bucket.chainId, policyId: bucket.policyId, sessionKey: remoteKey.address, validAfter: 0, validUntil: 0, capUsdc: '1' }, monad).policy
  const bridgeTotal = p6.session.grants.find((g) => g.name === 'bridge-out')?.actions.flatMap((a) => a.params).find((r) => r.cumulative)?.cumulative
  const bridgeCap = bridgeTotal ? v4BudgetCaps(p6, CAP_USDC)[bridgeTotal.slice(4)] : undefined
  if (!bridgeCap || bridgeCap <= 0n) throw new Error('no bridge total to size the remote Safe at')
  const nowB = await engineNow()
  const spec = { chainId: bucket.chainId, policyId: bucket.policyId, sessionKey: remoteKey.address, validAfter: nowB - 60, validUntil: nowB + remotePolicy.session.validitySeconds, capUsdc: bridgeCap.toString() }
  const remoteAccount = remoteSafe(remoteInput(ctx as never, spec, monad)).address
  note('remoteSafe(remoteInput(..)): the account\'s Safe on Monad', true, `${remoteAccount}, bridge total ${bridgeCap}`)

  // v4Context: attest what the Safe has not attested (or whose attestation lapses), generation, Init.admit.
  const approvalEnd = nowB + p6.session.validitySeconds
  const attest: Address[] = []
  const reattest: Address[] = []
  for (const m of [d6.actionPolicy, d6.gasPolicy, ...(d6.pauseGate ? [d6.pauseGate] : [])]) {
    const a = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findAttestation', args: [m, safe] })
    const lapses = Number(a.expirationTime) !== 0 && Number(a.expirationTime) <= approvalEnd
    const inForce = Number(a.time) !== 0 && Number(a.revocationTime) === 0
    if (!inForce || lapses) attest.push(m)
    if (inForce && lapses) reattest.push(m)
  }
  note('v4Context attests: V3 and the gate (the gas policy is already attested)', attest.includes(v3) && attest.includes(gate) && !attest.includes(gasPolicy), attest.join(' '))
  const admitByPool: Partial<Record<string, bigint[]>> = { [RISK]: [wethId], [BTC]: [btcId] }
  const attestData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [moveGen, BigInt(nowB)])

  const key6 = devAccount(6)
  const caps6 = computeCaps(p6, CAP_USDC, prices)
  const budgets6 = v4BudgetCaps(p6, CAP_USDC)
  const keys6 = orderV4Keys(p6, p6.session.grants.filter((g) => !g.perPosition).map(grantKey))
  const old = gen5.flatMap((b) => b.permissionIds)
  const grants6 = keys6.map((k) => {
    const g = instantiateGrant(p6, k, { account: safe, sessionKey: key6.address, chainId: lab.chainId, salt: nextSalt(), validAfter: nowB - 60, validUntil: nowB + p6.session.validitySeconds, caps: caps6, admittedTokenIds: [], capUsdc: CAP_USDC, remoteAccount })
    return g.requiresActionPolicy ? retargetToPolicy(g, d6.actionPolicy) : g
  })
  const batch6 = activationBatch({ safe } as LiveAccount, grants6, [], { trust: false, policiesFor: v4PoliciesFor(grants6, d6, moveGen, budgets6, admitByPool), attest, reattest, attestData })
  const calls6 = [...revocationCalls(old), ...batch6.calls]
  const data6 = await ownerTxData(lab, world.a1, calls6)
  const est = await lab.client.estimateGas({ account: relayer.address, to: safe, data: data6 })
  const [sar] = await simulateCalls(lab.client as never, [{ from: relayer.address, to: safe, data: encodeFunctionData({ abi: parseAbi(['function simulateAndRevert(address, bytes)']), functionName: 'simulateAndRevert', args: [multiSendCallOnly(calls6).to, multiSendCallOnly(calls6).data] }) }], await lab.client.getBlockNumber())
  note('v6 move: simulated owner transaction', est <= V4_TX_GAS_TARGET && est < BASE_PER_TX_GAS_CAP, `eth_estimateGas ${est} (simulateAndRevert gasUsed ${sar?.gasUsed}), ${grants6.length} sessions (${grants6.reduce((n, g) => n + g.actions.length, 0)} actions), ${old.length} revokes, ${calls6.length} calls; target ${V4_TX_GAS_TARGET}, cap 2^24 = ${BASE_PER_TX_GAS_CAP}`)
  gas['v6-move-estimateGas'] = est.toString()
  const r6 = await lab.send(relayer, safe, data6, 0n, BASE_PER_TX_GAS_CAP)
  note('v6 move: ONE owner transaction, sent with 2^24 as its gas limit', r6.ok && r6.receipt.gasUsed <= V4_TX_GAS_TARGET, `${r6.receipt.gasUsed} gas used (target ${V4_TX_GAS_TARGET}, cap ${BASE_PER_TX_GAS_CAP})`)
  gas['v6-move-tx'] = r6.receipt.gasUsed.toString()
  if (!r6.ok) throw new Error('the v6 move reverted')
  const moved: Built = { keys: keys6, grants: grants6, permissionIds: batch6.permissionIds, calls: calls6 }

  // ---------------------------------------------------------------------------------------------- 4. after the move

  {
    const was = await enabled(old)
    note('every v5 permission is disabled', was.every((x) => !x), `${was.filter((x) => x).length} of ${old.length} still enabled`)
    const now = await enabled(moved.permissionIds)
    note('every v6 permission is enabled', now.every((x) => x), `${now.filter((x) => x).length} of ${moved.permissionIds.length}`)
    const gen = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'generationOf', args: [safe] })
    note('V3.generationOf(account) == G + 1', gen === v5Generation + 1n && gen === moveGen, `${gen} (V2 was ${v5Generation})`)
    for (const [name, id, pool] of [['WETH/USDC', wethId, RISK], ['USDC/cbBTC', btcId, BTC]] as const) {
      const at = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'admittedPool', args: [safe, id] })
      note(`V3.admittedPool(account, ${name} tokenId) is the pool`, at.toLowerCase() === poolAddr(pool), at)
    }
    for (const m of [v3, gate]) {
      const a = await lab.client.readContract({ address: registryAddr, abi: moduleRegistryAbi, functionName: 'findAttestation', args: [m, safe] })
      note(`the Safe attested ${m === v3 ? 'V3' : 'the gate'} in the move`, Number(a.time) > 0 && Number(a.revocationTime) === 0, `time ${a.time}`)
    }
    const out = await op('t9-v5-after-move', pick(gen5, `enter-swap:${RISK}`), await swapBatch(v2, RISK, 'USDC', 'WETH', 3000, 10_000_000n, true), key5)
    note('a v5 session op after the move is refused', out.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(out))
  }

  // ---------------------------------------------------------------------------------------------- 5. v6 manage-any (V3 only) and the cbBTC exit

  const mgRisk = pick([moved], `manage-any:${RISK}`)
  const mgBtc = pick([moved], `manage-any:${BTC}`)
  const mgStables = pick([moved], `manage-any:${STABLES}`)
  note('v6 sessions found', true, `${mgStables.name}, ${mgRisk.name}, ${mgBtc.name}`)
  const exitCalls = async (pool: string, tokenId: bigint, fraction: bigint) => {
    const liq = await liquidityOf(tokenId)
    const part = liq / fraction
    const [m0, m1] = await lab.client.readContract({ address: v3, abi: policyAbi, functionName: 'decreaseMins', args: [safe, address(pool, baseRegistry), tokenId, part] })
    return { part, calls: [decreaseLiquidity({ tokenId, liquidity: part, amount0Min: m0, amount1Min: m1, deadline: BigInt(await engineNow()) + 600n }), collect({ account: safe, tokenId })] }
  }
  {
    const before = await liquidityOf(wethId)
    const { part, calls } = await exitCalls(RISK, wethId, 2n)
    const out = await op('t9-v6-weth-decrease-collect', mgRisk, calls, key6)
    const after = await liquidityOf(wethId)
    note('v6 balance manage-any (V3 only): decrease + collect on the admitted WETH/USDC position is included', out.verdict === 'INCLUDED' && after === before - part, `${verdict(out)}, liquidity ${before} -> ${after}`)
    if (out.receipt) gas['v6-weth-decrease-collect-tx'] = out.receipt.gasUsed.toString()
  }
  {
    const w0 = await lab.balanceOf('WETH', safe)
    const out = await op('t9-v6-swap-usdc-weth', mgRisk, await swapBatch(v3, RISK, 'USDC', 'WETH', 3000, 50_000_000n, true), key6)
    const w1 = await lab.balanceOf('WETH', safe)
    note('v6 balance manage-any: swap USDC -> WETH (approve + swap + deadline) is included', out.verdict === 'INCLUDED' && w1 > w0, `${verdict(out)}, WETH ${w0} -> ${w1}`)
  }
  {
    const before = await liquidityOf(btcId)
    const { part, calls } = await exitCalls(BTC, btcId, 2n)
    const out = await op('t9-v6-btc-decrease-collect', mgBtc, calls, key6)
    const after = await liquidityOf(btcId)
    note('v6 cbBTC exit-only session (UniActionPolicy + V3): decrease + collect on the old cbBTC position is included', out.verdict === 'INCLUDED' && after === before - part, `${verdict(out)}, liquidity ${before} -> ${after}`)
  }
  {
    const cb0 = await lab.balanceOf('cbBTC', safe)
    const amt = cb0 / 4n
    const out = await op('t9-v6-swap-cbbtc-usdc', mgBtc, await swapBatch(v3, BTC, 'cbBTC', 'USDC', 500, amt, true), key6)
    const cb1 = await lab.balanceOf('cbBTC', safe)
    note('v6 cbBTC exit-only: swap cbBTC -> USDC is included', out.verdict === 'INCLUDED' && cb1 === cb0 - amt, `${verdict(out)}, cbBTC ${cb0} -> ${cb1}`)
    const buy = await op('t9-v6-swap-usdc-cbbtc', mgBtc, await swapBatch(v3, BTC, 'USDC', 'cbBTC', 500, 50_000_000n, true), key6)
    note('v6 cbBTC exit-only: swap USDC -> cbBTC (approve + swap) is refused at validation', buy.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(buy))
    const swapOnly = (await swapBatch(v3, BTC, 'USDC', 'cbBTC', 500, 10_000_000n, false)).slice(1)
    const direct = await op('t9-v6-swap-usdc-cbbtc-swap-only', mgBtc, swapOnly, key6)
    note('v6 cbBTC exit-only: the USDC -> cbBTC swap call alone is refused at validation', direct.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(direct))
  }

  // ---------------------------------------------------------------------------------------------- 6. bridge-out and the pause gate

  const bridge = pick([moved], 'bridge-out')
  const tm = address('TokenMessengerV2', baseRegistry)
  const burn = (amount: bigint, recipient: Address, opts: { domain?: number; finality?: number; fee?: bigint } = {}) => [
    approveTo('USDC', tm, amount),
    { to: tm, data: encodeFunctionData({ abi: tokenMessengerV2Abi, functionName: 'depositForBurn', args: [amount, opts.domain ?? CCTP_DOMAIN_MONAD, pad(recipient, { size: 32 }), address('USDC', baseRegistry), pad('0x00', { size: 32 }), opts.fee ?? 0n, opts.finality ?? CCTP_STANDARD] }) },
  ]
  const BURN = 100_000_000n
  {
    const u0 = await lab.balanceOf('USDC', safe)
    const out = await op('t9-bridge-out', bridge, burn(BURN, remoteAccount), key6)
    const u1 = await lab.balanceOf('USDC', safe)
    note('bridge-out: depositForBurn to the remote Safe (domain 15, fee 0, Standard) is included', out.verdict === 'INCLUDED' && u0 - u1 === BURN, `${verdict(out)}, USDC ${u0} -> ${u1}`)
    if (out.receipt) gas['bridge-out-tx'] = out.receipt.gasUsed.toString()
    const other = await op('t9-bridge-other', bridge, burn(BURN, devAccount(7).address), key6)
    note('bridge-out: depositForBurn to another recipient is refused at validation', other.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(other))
  }
  {
    const nobody = await lab.send(devAccount(7), v3, encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: 'pause', args: [safe] }), 0n, 200_000n).catch(() => null)
    note('anyone but the guardian cannot pause on V3', !nobody || !nobody.ok, nobody ? `status ${nobody.receipt.status}` : 'refused')
    const p = await lab.send(guardian, v3, encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: 'pause', args: [safe] }), 0n, 200_000n)
    const paused = await lab.client.readContract({ address: v3, abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', args: [safe] })
    note('the guardian pauses the account on V3', p.ok && paused, `gas ${p.receipt.gasUsed}`)
    const out = await op('t9-bridge-paused', bridge, burn(BURN, remoteAccount), key6)
    note('paused: the bridge-out is refused at validation (MamoruPauseGate)', out.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(out))
    const u = await lab.send(guardian, v3, encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: 'unpause', args: [safe] }), 0n, 200_000n)
    const again = await op('t9-bridge-unpaused', bridge, burn(BURN, remoteAccount), key6)
    note('unpaused: the same bridge-out is included', u.ok && again.verdict === 'INCLUDED', verdict(again))
  }

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, v1, v2, v3, gate, gasPolicy, guardian: guardian.address, safe, remoteAccount, REMOTE_FIRST_GENERATION: REMOTE_FIRST_GENERATION.toString(), gas, lines: reportLines })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t9-fork', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
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
