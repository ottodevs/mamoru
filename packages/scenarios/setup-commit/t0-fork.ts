// SPIKE otto/mamoru#116, step T0: fork measurements for design D (session grants committed in the Safe setup through a
// chain-switched, stateless MamoruChainInit). Throwaway: nothing here is imported by the app, the operator or any
// package. Results: packages/scenarios/setup-commit/RESULTS.md.
//
// What it does, on an anvil fork of Base (lab chain id 31337) and one of Monad (lab chain id 314143), never on a live
// chain:
//   1. deploys MamoruActionPolicy (V1) + MamoruGasPolicy and MamoruActionPolicyV2 on the Base fork (the repo's forge
//      scripts, as t8-fork.ts), and the spike MamoruChainInit on both forks at the same CREATE2 address;
//   2. builds today's v5 grant set (conservador-lab-v5, 9 sessions: UniActionPolicy + V2 + gas policy, TimeFrame,
//      UsageLimit) with the operator's builders, a "V3-shaped" set (same 9 grants, actions under the Mamoru policy
//      only, userOp policies TimeFrame + gas policy, no UniActionPolicy) and a Monad set (lab-wmon-usdc-monad-v1's
//      enter-swap + enter-mint);
//   3. deploys Safes through SafeProxyFactory_141.createProxyWithNonce with the extended initializer (MultiSend 1.4.1:
//      launchpad with no validators, passkey signer configure, MamoruChainInit.init) and checks (a)-(d);
//   4. measures deploy gas per set and per session count, then sweeps the deploy tx gas limit downwards and classifies
//      every outcome (reverted / fully configured / empty SmartSession / partial).
//
// Run (needs foundry on PATH):
//   nix shell nixpkgs#foundry --command bash -c '
//     (cd contracts/action-policy && ./install.sh && forge build --silent) &&
//     forge build --root packages/scenarios/setup-commit --silent &&
//     bun packages/scenarios/setup-commit/t0-fork.ts'
// RPC: BASE_FORK_RPC_URL / MONAD_FORK_RPC_URL (default the public endpoints), through the loopback proxy.
import { join } from 'node:path'
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodePacked, getContractAddress, keccak256, pad, parseAbi, size, toHex, zeroAddress, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, monadRegistry, multiSendCallOnlyAbi, safe7579LaunchpadAbi, safeAbi, safeProxyFactoryAbi, smartSessionAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import {
  POLICIES,
  V4_GAS_CAPS,
  V4_POOLS,
  computeCaps,
  conservadorLabV5,
  conservadorLiveV4,
  conservadorLiveV5,
  grantKey,
  instantiateGrant,
  labWmonUsdcMonadV1,
  liveWmonUsdcMonadV1,
  orderV4Keys,
  retargetToPolicy,
  v4BudgetCaps,
  withActionPolicy,
  type PolicyVersion,
  type Price,
} from '@mamoru/policy'
import { permissionIdOf, toSmartSession, v4DeploymentOf, v4PoliciesFor, type SmartSessionStruct } from '@mamoru/account/sessions'
import { OPERATION_DELEGATECALL, configureSharedSigner, createProxyCall, webAuthnSigner } from '@mamoru/account/safe'
import { SAFE_PROXY_141_CREATION_CODE, accountSetup } from '@mamoru/account/recovery'
import { ANVIL_DEV_KEYS, Lab, devAccount } from '../fixtures/lab.ts'
import { startAnvil, type AnvilHandle } from '../fork/anvil.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { REPO_ROOT } from '../runner/manifest.ts'

// Recent blocks, pinned for this run (the scenario manifests' Monad block predates TimeFramePolicy/UsageLimitPolicy
// on Monad).
const BASE_BLOCK = Number(process.env.T0_BASE_BLOCK ?? 53_140_000)
const MONAD_BLOCK = Number(process.env.T0_MONAD_BLOCK ?? 116_980_000)
const BASE_LAB_CHAIN = 31_337
const MONAD_LAB_CHAIN = 314_143
const UNLISTED_LAB_CHAIN = 31_338
const CAP_USDC = 1_000_000_000n // 1,000 USDC, as t7/t8
const BASE_TX_GAS_CAP = 16_777_216n
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c' as Address
/** ACCOUNT refs need the account address, which the setup itself derives: placeholder for the measurement. */
const ACCOUNT_PLACEHOLDER = '0x00000000000000000000000000000000000000aa' as Address

const out: Record<string, unknown> = {}
const lines: string[] = []
const t0 = Date.now()
function note(s: string): void {
  lines.push(s)
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`)
}

const chainInitAbi = parseAbi([
  'function init((uint256 chainId, bytes sessions)[] entries)',
  'function initOrEmpty((uint256 chainId, bytes sessions)[] entries, uint256 minGas)',
])
const probeAbi = parseAbi([
  'function isModuleInstalled(uint256 moduleType, address module, bytes context) view returns (bool)',
  'function isPermissionEnabled(bytes32 permissionId, address account) view returns (bool)',
  'function isInitialized(address account) view returns (bool)',
  'function isModuleEnabled(address module) view returns (bool)',
])
const SESSION_ARRAY = (smartSessionAbi.find((x) => x.type === 'function' && x.name === 'enableSessions') as { inputs: readonly [{ type: string; components: unknown }] }).inputs[0]

type ChainSessions = { chainId: number; sessions: SmartSessionStruct[] }
type InitMode = { kind: 'strict' } | { kind: 'try'; minGas: bigint }

const encodeSessions = (s: SmartSessionStruct[]): Hex => encodeAbiParameters([SESSION_ARRAY as never], [s] as never)

// ------------------------------------------------------------------------------------------------ setup builders

let chainInit: Address

/** Today's v1 initializer (packages/account/safe): launchpad installs SmartSession empty. */
function v1Call(salt: bigint): { to: Address; data: Hex } {
  const signer = address('SafeWebAuthnSharedSigner', baseRegistry)
  return createProxyCall(accountSetup([signer], salt, webAuthnSigner(1n, 2n, baseRegistry), baseRegistry), baseRegistry)
}

/**
 * Design D initializer: MultiSend 1.4.1 delegatecalls the launchpad (no validators), the passkey signer's configure
 * (as today) and MamoruChainInit with the whole chain list. Byte-identical for every chain.
 */
function v2Call(salt: bigint, list: ChainSessions[], mode: InitMode = { kind: 'strict' }): { to: Address; data: Hex; initializer: Hex } {
  const reg = baseRegistry
  const signer = address('SafeWebAuthnSharedSigner', reg)
  const launch = encodeFunctionData({
    abi: safe7579LaunchpadAbi,
    functionName: 'addSafe7579',
    args: [address('Safe7579', reg), [], [], [], [], [address('RhinestoneAttester', reg)], 1],
  })
  const cfg = configureSharedSigner(1n, 2n, webAuthnSigner(1n, 2n, reg).verifiers, reg)
  const entries = list.map((c) => ({ chainId: BigInt(c.chainId), sessions: encodeSessions(c.sessions) }))
  const initData =
    mode.kind === 'strict'
      ? encodeFunctionData({ abi: chainInitAbi, functionName: 'init', args: [entries] })
      : encodeFunctionData({ abi: chainInitAbi, functionName: 'initOrEmpty', args: [entries, mode.minGas] })
  const calls = [
    { to: address('Safe7579Launchpad', reg), data: launch },
    { to: cfg.to, data: cfg.data },
    { to: chainInit, data: initData },
  ]
  const packed = concat(calls.map((c) => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [OPERATION_DELEGATECALL, c.to, 0n, BigInt(size(c.data)), c.data])))
  const multi = encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName: 'multiSend', args: [packed] })
  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [[signer], 1n, address('MultiSend_141', reg), multi, address('Safe7579', reg), zeroAddress, 0n, zeroAddress],
  })
  return {
    to: address('SafeProxyFactory_141', reg),
    data: encodeFunctionData({ abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', args: [address('SafeL2_141', reg), initializer, salt] }),
    initializer,
  }
}

function predicted(call: { to: Address; data: Hex }): Address {
  const { args } = decodeFunctionData({ abi: safeProxyFactoryAbi, data: call.data })
  const [singleton, initializer, saltNonce] = args as [Address, Hex, bigint]
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), saltNonce]))
  return getContractAddress({ opcode: 'CREATE2', from: call.to, salt, bytecode: concat([SAFE_PROXY_141_CREATION_CODE, pad(singleton)]) })
}

/** Intrinsic gas of a CALL tx with this calldata: max(EIP-2028 cost, EIP-7623 floor). */
function intrinsic(data: Hex): { standard: bigint; floor: bigint; bytes: number } {
  const b = Buffer.from(data.slice(2), 'hex')
  let z = 0n
  let nz = 0n
  for (const x of b) x === 0 ? z++ : nz++
  const tokens = z + 4n * nz
  return { standard: 21_000n + 4n * z + 16n * nz, floor: 21_000n + 10n * tokens, bytes: b.length }
}

// ------------------------------------------------------------------------------------------------ fork helpers

type Outcome = 'rejected' | 'reverted' | 'full' | 'empty' | 'partial' | 'no-smartsession'

async function classify(lab: Lab, safe: Address, expected: Hex[]): Promise<{ outcome: Outcome; enabled: number }> {
  const code = await lab.client.getCode({ address: safe })
  if (!code || code === '0x') return { outcome: 'reverted', enabled: 0 }
  const ss = address('SmartSession', baseRegistry)
  const installed = await lab.client.readContract({ address: safe, abi: probeAbi, functionName: 'isModuleInstalled', args: [1n, ss, '0x'] })
  let enabled = 0
  for (const pid of expected) {
    if (await lab.client.readContract({ address: ss, abi: probeAbi, functionName: 'isPermissionEnabled', args: [pid, safe] })) enabled++
  }
  if (!installed) return { outcome: 'no-smartsession', enabled }
  if (enabled === expected.length) return { outcome: expected.length === 0 ? 'empty' : 'full', enabled }
  return { outcome: enabled === 0 ? 'empty' : 'partial', enabled }
}

/** Sends the deploy with `gas` from a dev account; with `keep` false the fork is reverted afterwards. */
async function deploy(lab: Lab, from: PrivateKeyAccount, call: { to: Address; data: Hex }, gas: bigint, expected: Hex[], keep = false) {
  const snap = keep ? null : await lab.snapshot()
  const safe = predicted(call)
  try {
    let gasUsed = 0n
    try {
      const r = await lab.send(from, call.to, call.data, 0n, gas)
      gasUsed = r.receipt.gasUsed
      if (!r.ok) return { safe, outcome: 'reverted' as Outcome, enabled: 0, gasUsed }
    } catch (e) {
      return { safe, outcome: 'rejected' as Outcome, enabled: 0, gasUsed, error: (e as Error).message.split('\n')[0] }
    }
    return { safe, ...(await classify(lab, safe, expected)), gasUsed }
  } finally {
    if (snap) await lab.revert(snap)
  }
}

async function forgeScript(rpcUrl: string, script: string, deployer: PrivateKeyAccount, key: Hex, env: Record<string, string>): Promise<string> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(rpcUrl)) throw new Error(`refusing to broadcast anywhere but the local fork (${rpcUrl})`)
  const forge = Bun.which('forge')
  if (!forge) throw new Error('forge is not on PATH')
  const r = Bun.spawn([forge, 'script', script, '--rpc-url', rpcUrl, '--broadcast', '--private-key', key, '--sender', deployer.address, '--slow', '--skip-simulation', '--rpc-timeout', '900', '--timeout', '900'], {
    cwd: join(REPO_ROOT, 'contracts/action-policy'),
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [so, se, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited])
  if (code !== 0) throw new Error(`forge script ${script} failed (${code}):\n${`${so}\n${se}`.slice(-3000)}`)
  return so
}

async function deployChainInit(lab: Lab): Promise<Address> {
  const art = (await Bun.file(join(REPO_ROOT, 'packages/scenarios/setup-commit/out/MamoruChainInit.sol/MamoruChainInit.json')).json()) as { bytecode: { object: Hex } }
  const initCode = concat([art.bytecode.object, encodeAbiParameters([{ type: 'address' }], [address('SmartSession', baseRegistry)])])
  const salt = pad('0x116', { size: 32 })
  const at = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt, bytecode: initCode })
  const r = await lab.send(devAccount(2), CREATE2_DEPLOYER, concat([salt, initCode]), 0n, 3_000_000n)
  if (!r.ok) throw new Error('MamoruChainInit deploy reverted')
  return at
}

async function usdcPrice(lab: Lab, pool: string, token0: string, token1: string, asset: string): Promise<Price> {
  const [sqrtPriceX96] = await lab.client.readContract({ address: address(pool, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const ratio: Price = { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n }
  if (token0 === 'USDC' && token1 === asset) return ratio
  if (token1 === 'USDC' && token0 === asset) return { num: ratio.den, den: ratio.num }
  throw new Error(`usdcPrice: ${pool} does not pair USDC with ${asset}`)
}

async function fork(envVar: string, dflt: string, block: number, chainId: number, logPath: string): Promise<{ lab: Lab; handle: AnvilHandle; stop: () => Promise<void> }> {
  if (!process.env[envVar]) process.env[envVar] = dflt
  const proxy = startForkProxy(envVar)
  const handle = await startAnvil({ forkUrl: proxy.url, forkBlock: block, chainId, slotsInAnEpoch: 2, logPath, hardfork: process.env.T0_HARDFORK })
  return {
    lab: new Lab(handle.url, chainId, chainId === MONAD_LAB_CHAIN ? monadRegistry : baseRegistry),
    handle,
    stop: async () => {
      await handle.stop()
      proxy.stop()
    },
  }
}

// ------------------------------------------------------------------------------------------------ 5. ACCOUNT rules (static)

function accountRules(): string[] {
  const all: PolicyVersion[] = [...Object.values(POLICIES), conservadorLiveV4, conservadorLiveV5, liveWmonUsdcMonadV1]
  const rows: string[] = []
  for (const p of all) {
    for (const g of p.session.grants) {
      for (const a of g.actions) {
        for (const r of a.params) {
          if (r.ref === 'ACCOUNT') rows.push(`${p.policyId} | ${grantKey(g)} | ${a.target}.${a.signature.split('(')[0]} | ${r.field} ${r.condition} ACCOUNT`)
        }
      }
    }
  }
  return rows
}

// ------------------------------------------------------------------------------------------------ main

const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/setup-commit-t0`)
const base = await fork('BASE_FORK_RPC_URL', 'https://mainnet.base.org', BASE_BLOCK, BASE_LAB_CHAIN, `${dir}/anvil-base.log`)
const monad = await fork('MONAD_FORK_RPC_URL', 'https://rpc.monad.xyz', MONAD_BLOCK, MONAD_LAB_CHAIN, `${dir}/anvil-monad.log`)
let exit = 0
try {
  const B = base.lab
  const M = monad.lab
  const relayer = devAccount(0)
  const baseGasLimit = (await B.client.getBlock()).gasLimit
  const monadGasLimit = (await M.client.getBlock()).gasLimit
  note(`forks: Base block ${BASE_BLOCK} (block gasLimit ${baseGasLimit}), Monad block ${MONAD_BLOCK} (block gasLimit ${monadGasLimit}), anvil hardfork ${process.env.T0_HARDFORK ?? 'default'}`)

  // 1. policies on Base, MamoruChainInit on both
  const deployer = devAccount(9)
  const key = ANVIL_DEV_KEYS[9] as Hex
  const outV1 = await forgeScript(B.url, 'script/Deploy.s.sol', deployer, key, { POLICY_SALT_NONCE: '7', GAS_POLICY_SALT_NONCE: '8', CARDINALITY_TARGET: '3600' })
  const gasPolicy = /MamoruGasPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(outV1)?.[1] as Address
  const outV2 = await forgeScript(B.url, 'script/DeployV2.s.sol', deployer, key, { GUARDIAN: devAccount(8).address, POLICY_V2_SALT_NONCE: '9', CARDINALITY_TARGET: '3600' })
  const v2 = /MamoruActionPolicyV2:\s*(0x[0-9a-fA-F]{40})/.exec(outV2)?.[1] as Address
  if (!gasPolicy || !v2) throw new Error('forge scripts printed no addresses')
  const ciB = await deployChainInit(B)
  const ciM = await deployChainInit(M)
  if (ciB !== ciM) throw new Error('MamoruChainInit address differs')
  chainInit = ciB
  note(`deployed on Base fork: MamoruGasPolicy ${gasPolicy}, MamoruActionPolicyV2 ${v2}; MamoruChainInit ${chainInit} on both forks`)
  for (const n of ['TimeFramePolicy', 'UsageLimitPolicy', 'UniActionPolicy', 'OwnableValidator', 'SmartSession', 'Safe7579', 'Safe7579Launchpad']) {
    const a = address(n as never, baseRegistry)
    const [cb, cm] = await Promise.all([B.client.getCode({ address: a }), M.client.getCode({ address: a })])
    if (!cm || cm === '0x') note(`  Monad fork: no code at ${n} ${a}`)
    else if (keccak256(cb!) !== keccak256(cm)) note(`  Monad fork: ${n} code differs from Base`)
  }

  // 2. grant sets
  const p5 = withActionPolicy(conservadorLabV5, v2, Object.values(V4_POOLS), { caps: v4BudgetCaps(conservadorLabV5, CAP_USDC), gasPolicy: { address: gasPolicy, caps: V4_GAS_CAPS }, contractVersion: 2 })
  const d = v4DeploymentOf(p5)!
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(B, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(B, V4_POOLS.btc.pool, 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(B, 'pool:WETH/USDC/3000', 'WETH', 'USDC', 'WETH'),
  }
  const now = Number((await B.client.getBlock()).timestamp)
  const sessionKey = devAccount(5).address
  const keys = orderV4Keys(p5, p5.session.grants.map(grantKey))
  const grants = keys.map((k, i) =>
    retargetToPolicy(
      instantiateGrant(p5, k, { account: ACCOUNT_PLACEHOLDER, sessionKey, chainId: BASE_LAB_CHAIN, salt: pad(toHex(i + 1), { size: 32 }), validAfter: now - 60, validUntil: now + p5.session.validitySeconds, caps: computeCaps(p5, CAP_USDC, prices), capUsdc: CAP_USDC }),
      d.actionPolicy,
    ),
  )
  const policiesFor = v4PoliciesFor(grants, d, 1n, v4BudgetCaps(p5, CAP_USDC))
  const v5: SmartSessionStruct[] = grants.map((g, i) => toSmartSession(g, policiesFor(g, i)))
  // V3-shaped: same grants, the Mamoru policy is the only action policy; userOp policies TimeFrame + gas policy.
  const v3: SmartSessionStruct[] = v5.map((s) => ({
    ...s,
    salt: keccak256(concat([s.salt, '0x03'])),
    userOpPolicies: [s.userOpPolicies[0]!, s.userOpPolicies.find((p) => p.policy.toLowerCase() === gasPolicy.toLowerCase())!],
    actions: s.actions.map((a) => ({ ...a, actionPolicies: a.actionPolicies.filter((p) => p.policy.toLowerCase() === v2.toLowerCase()) })),
  }))
  const monadCaps = computeCaps(labWmonUsdcMonadV1, CAP_USDC, { WMON: { num: 30n * 10n ** 12n, den: 1n } })
  const monadSessions: SmartSessionStruct[] = ['enter-swap', 'enter-mint'].map((k, i) =>
    toSmartSession(instantiateGrant(labWmonUsdcMonadV1, k, { account: ACCOUNT_PLACEHOLDER, sessionKey, chainId: MONAD_LAB_CHAIN, salt: pad(toHex(0x143_00 + i), { size: 32 }), validAfter: now - 60, validUntil: now + labWmonUsdcMonadV1.session.validitySeconds, caps: monadCaps }), undefined, baseRegistry),
  )
  const ids = (s: SmartSessionStruct[]) => s.map(permissionIdOf)
  const shape = (s: SmartSessionStruct[]) => s.map((x) => `${x.actions.length}a/${x.actions.reduce((n, a) => n + a.actionPolicies.length, 0)}p/${x.userOpPolicies.length}u`).join(' ')
  note(`sets: v5 ${v5.length} sessions [${shape(v5)}] ${size(encodeSessions(v5))} B; V3-shaped ${v3.length} [${shape(v3)}] ${size(encodeSessions(v3))} B; Monad ${monadSessions.length} [${shape(monadSessions)}] ${size(encodeSessions(monadSessions))} B`)

  // 3. (a)(b)(c)(d): one initializer, both forks, and an unlisted chain id
  const list: ChainSessions[] = [
    { chainId: BASE_LAB_CHAIN, sessions: v3 },
    { chainId: MONAD_LAB_CHAIN, sessions: monadSessions },
  ]
  const both = v2Call(7n, list)
  const want = predicted(both)
  const ss = address('SmartSession', baseRegistry)
  // (d) first, on a snapshot: the same initializer under a chain id the list does not name.
  const snap = await B.snapshot()
  await B.rpc('anvil_setChainId', [UNLISTED_LAB_CHAIN])
  const unlisted = await deploy(B, relayer, both, 60_000_000n, ids(v3), true)
  const initd = await B.client.readContract({ address: ss, abi: probeAbi, functionName: 'isInitialized', args: [unlisted.safe] })
  note(`(d) chain id ${UNLISTED_LAB_CHAIN}, same initializer: ${unlisted.outcome} (SmartSession installed, ${unlisted.enabled} sessions, isInitialized ${initd}), same address ${unlisted.safe === want}, gas ${unlisted.gasUsed}`)
  await B.revert(snap)
  await B.rpc('anvil_setChainId', [BASE_LAB_CHAIN]) // evm_revert does not restore the chain id
  if ((await B.client.getChainId()) !== BASE_LAB_CHAIN) throw new Error('Base fork chain id not restored')
  const onBase = await deploy(B, relayer, both, 60_000_000n, ids(v3), true)
  const onMonad = await deploy(M, relayer, both, 60_000_000n, ids(monadSessions), true)
  const baseHasMonad = (await classify(B, onBase.safe, ids(monadSessions))).enabled
  const monadHasBase = (await classify(M, onMonad.safe, ids(v3))).enabled
  const modEnabled = await B.client.readContract({ address: onBase.safe, abi: probeAbi, functionName: 'isModuleEnabled', args: [address('Safe7579', baseRegistry)] })
  note(`(a)+(b) Base: ${onBase.outcome}, ${onBase.enabled}/${v3.length} sessions enabled, Safe7579 module ${modEnabled}, gas ${onBase.gasUsed}`)
  note(`(a)+(b) Monad: ${onMonad.outcome}, ${onMonad.enabled}/${monadSessions.length} sessions enabled, gas ${onMonad.gasUsed}`)
  note(`(c) predicted ${want}; Base ${onBase.safe} Monad ${onMonad.safe}: same=${onBase.safe === onMonad.safe && onBase.safe === want}; Base has ${baseHasMonad} Monad sessions, Monad has ${monadHasBase} Base sessions`)
  out.checks = { onBase, onMonad, unlisted, want, baseHasMonad, monadHasBase }
  const v3BytesBoth = intrinsic(both.data)
  note(`initializer with both lists: calldata ${v3BytesBoth.bytes} B, intrinsic ${v3BytesBoth.standard} (EIP-7623 floor ${v3BytesBoth.floor})`)

  // 4. gas: today's v1, empty, v5 and V3-shaped at 1/3/9 sessions (Base list only)
  let salt = 100n
  const gasRows: { set: string; n: number; gas: bigint; calldata: number; intrinsic: bigint; outcome: Outcome; fitsBase: boolean }[] = []
  const measure = async (label: string, call: { to: Address; data: Hex }, expected: Hex[], lab = B) => {
    const r = await deploy(lab, relayer, call, 60_000_000n, expected)
    const i = intrinsic(call.data)
    const row = { set: label, n: expected.length, gas: r.gasUsed, calldata: i.bytes, intrinsic: i.standard > i.floor ? i.standard : i.floor, outcome: r.outcome, fitsBase: r.gasUsed <= BASE_TX_GAS_CAP }
    gasRows.push(row)
    note(`gas ${label} n=${row.n}: ${r.gasUsed} (${r.outcome}; calldata ${i.bytes} B, intrinsic ${row.intrinsic}) ${row.fitsBase ? 'fits' : 'OVER'} Base 2^24${'error' in r ? ` ${r.error}` : ''}`)
    return r
  }
  await measure('v1 today (launchpad, SmartSession empty)', v1Call(salt++), [])
  await measure('v2 unlisted chain', v2Call(salt++, [{ chainId: MONAD_LAB_CHAIN, sessions: monadSessions }]), [])
  for (const n of [1, 3, 9]) await measure('v2 v5-set', v2Call(salt++, [{ chainId: BASE_LAB_CHAIN, sessions: v5.slice(0, n) }]), ids(v5.slice(0, n)))
  for (const n of [1, 3, 9]) await measure('v2 V3-shaped', v2Call(salt++, [{ chainId: BASE_LAB_CHAIN, sessions: v3.slice(0, n) }]), ids(v3.slice(0, n)))
  await measure('v2 V3-shaped + Monad list', v2Call(salt++, list), ids(v3))
  await measure('v2 Monad set on Monad', v2Call(salt++, list), ids(monadSessions), M)
  out.gas = gasRows

  // 5. griefing: sweep the deploy gas limit downwards
  const sweepRows: Record<string, unknown> = {}
  const sweep = async (label: string, call: { to: Address; data: Hex }, expected: Hex[]) => {
    const full = await deploy(B, relayer, call, 60_000_000n, expected)
    const lo0 = intrinsic(call.data)
    const lo = (lo0.standard > lo0.floor ? lo0.standard : lo0.floor) + 1n
    const hi = full.gasUsed + full.gasUsed / 10n
    const seen: Record<string, { min: bigint; max: bigint; count: number }> = {}
    const add = (g: bigint, o: Outcome) => {
      const s = (seen[o] ??= { min: g, max: g, count: 0 })
      s.min = g < s.min ? g : s.min
      s.max = g > s.max ? g : s.max
      s.count++
    }
    const at = new Map<bigint, Outcome>()
    const probe = async (g: bigint) => {
      if (at.has(g)) return at.get(g)!
      const r = await deploy(B, relayer, call, g, expected)
      at.set(g, r.outcome)
      add(g, r.outcome)
      return r.outcome
    }
    const steps = 48n
    for (let k = 0n; k <= steps; k++) await probe(hi - ((hi - lo) * k) / steps)
    // Fine scan around every boundary between neighbouring outcomes of the coarse scan.
    const coarse = [...at.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    for (let i = 1; i < coarse.length; i++) {
      if (coarse[i]![1] === coarse[i - 1]![1]) continue
      let [a, b] = [coarse[i - 1]![0], coarse[i]![0]]
      const oa = coarse[i - 1]![1]
      while (b - a > 200n) {
        const m = (a + b) / 2n
        if ((await probe(m)) === oa) a = m
        else b = m
      }
      for (let g = a - 20_000n; g <= b + 20_000n; g += 2_000n) await probe(g)
    }
    const boundaries = [...at.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).reduce<string[]>((acc, [g, o], i, arr) => (i > 0 && arr[i - 1]![1] !== o ? [...acc, `${arr[i - 1]![1]}@${arr[i - 1]![0]} -> ${o}@${g}`] : acc), [])
    sweepRows[label] = { gasUsedAtFullLimit: full.gasUsed, probes: at.size, ranges: seen, boundaries }
    note(`sweep ${label}: used ${full.gasUsed}, ${at.size} probes; ${Object.entries(seen).map(([o, s]) => `${o} ${s.min}..${s.max} (${s.count})`).join('; ')}; boundaries ${boundaries.join(', ')}`)
    return seen
  }
  const v3list = [{ chainId: BASE_LAB_CHAIN, sessions: v3 }]
  await sweep('strict V3-shaped 9', v2Call(900n, v3list), ids(v3))
  await sweep('try/catch no floor V3-shaped 9', v2Call(901n, v3list, { kind: 'try', minGas: 0n }), ids(v3))
  // Floor: the enable's own cost measured above, times 64/63 plus a margin.
  const strictUsed = gasRows.find((r) => r.set === 'v2 V3-shaped' && r.n === 9)!.gas
  const emptyUsed = gasRows.find((r) => r.set === 'v2 unlisted chain')!.gas
  const floor = ((strictUsed - emptyUsed) * 64n) / 63n + 200_000n
  await sweep(`try/catch floor ${floor} V3-shaped 9`, v2Call(902n, v3list, { kind: 'try', minGas: floor }), ids(v3))
  await sweep('strict v5-set 3', v2Call(903n, [{ chainId: BASE_LAB_CHAIN, sessions: v5.slice(0, 3) }]), ids(v5.slice(0, 3)))
  out.sweeps = sweepRows
} catch (e) {
  exit = 1
  note(`FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
} finally {
  out.accountRules = accountRules()
  for (const r of out.accountRules as string[]) note(`ACCOUNT rule: ${r}`)
  out.lines = lines
  await writeJson(`${dir}/t0.json`, out)
  await base.stop()
  await monad.stop()
  console.log(`report: ${dir}/t0.json`)
  process.exit(exit)
}
