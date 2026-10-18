// Spec 007 (otto/mamoru#151), task T7 (f): the v4 approval end to end on a Base fork, through the same builders the
// operator's activation and renewal use (`splitV4Keys`, `retargetToPolicy`, `v4PoliciesFor`, `activationBatch`,
// `v4BudgetCaps`, `engineGas`, `readPolicyBudgets`), never hand-built sessions:
//   1. deploy: `forge script script/Deploy.s.sol --broadcast` against the local anvil fork only (MamoruActionPolicy and
//      MamoruGasPolicy, each deployed and registered in one `deployModule` call; pool rings raised), then the
//      `findModule` check the operator makes before any account attests them;
//   2. activation in consecutive owner transactions (2 for the full 3-pool set), self-attesting both policies in the
//      first, each under Base's 2^24 gas cap;
//   3. an engine op (swap at the policy's bounds, gas from `engineGas` under the caps) is included;
//   4. a leaked session key signing an op over MamoruGasPolicy's caps (maxFeePerGas, then priority fee) is refused at
//      validation, with ETH in the Safe so only the policy can refuse it;
//   5. a position minted outside the policy (as v2/v3 grants or the owner did) cannot be decreased by the session;
//      the renewal (generation 2, new key, revoking every generation-1 session, again 2 transactions) admits it in
//      `Init.admit`, and the same decrease, at `decreaseMins`, is included;
//   6. the usage-triggered signal: stables swaps spend 80% of T_p over two budget windows; the operator's reader
//      (`readPolicyBudgets` + `budgetUsedBps`) reports >= USAGE_RENEW_BPS, and a swap past T_p is refused.
//
// Run (builds the contracts, then the scenario):
//   PATH="$HOME/.foundry/bin:$PATH" bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t7-fork.ts'
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1..t4.
import { join } from 'node:path'
import { encodeFunctionData, parseAbi, parseEventLogs, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, moduleRegistryAbi, nonfungiblePositionManagerAbi, safeAbi, swapRouter02Abi, uniswapV3PoolAbi } from '@mamoru/registry'
import {
  USAGE_RENEW_BPS,
  V4_GAS_CAPS,
  V4_POOLS,
  budgetUsedBps,
  computeCaps,
  conservadorLabV4,
  grantKey,
  instantiateGrant,
  maxGasCostPerOp,
  retargetToPolicy,
  splitV4Keys,
  v4BudgetCaps,
  withActionPolicy,
  type Price,
  type SessionGrant,
} from '@mamoru/policy'
import { revocationCalls, toSmartSession, v4DeploymentOf, v4PoliciesFor, type V4Deployment } from '@mamoru/account/sessions'
import { activationBatch, type LiveAccount } from '@mamoru/account/live'
import { OPERATION_CALL, execTransactionData, multiSendCallOnly, signSafeTx, type MultiSendCall, type SafeTx } from '@mamoru/account/safe'
import { approve, collect, decreaseLiquidity, mint } from '@mamoru/uniswap-v3'
import { ANVIL_DEV_KEYS, Lab, devAccount, type TxResult } from '../fixtures/lab.ts'
import { buildBasicWorld, rangeAround, WHALE, type AccountFixture, type World } from '../fixtures/world.ts'
import { sendSessionOp, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { engineGas } from '../driver/engine.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'
import { readPolicyBudgets } from '../../../apps/mamoru-operator/src/session-usage.ts'

const CAP_USDC = 1_000_000_000n // 1,000 USDC: the account cap the grants and Inits are sized for (spec 007 loss table)
const BASE_PER_TX_GAS_CAP = 16_777_216n
const policyAbi = parseAbi([
  'function swapBounds(address account, address pool, address tokenIn, uint256 amountIn) view returns (uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)',
  'function decreaseMins(address account, address pool, uint256 tokenId, uint128 liquidity) view returns (uint256, uint256)',
  'function generationOf(address account) view returns (uint64)',
  'function admittedPool(address account, uint256 tokenId) view returns (address)',
])

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
  console.error(`t7-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t7-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})

/** One owner Safe transaction carrying `calls` (MultiSend), with a gas limit above the 15M fixture default. */
async function ownerCalls(lab: Lab, relayer: PrivateKeyAccount, acct: AccountFixture, calls: MultiSendCall[], gasLimit = 20_000_000n): Promise<TxResult> {
  const nonce = await lab.client.readContract({ address: acct.safe, abi: safeAbi, functionName: 'nonce' })
  const op = (calls.length === 1 ? { to: calls[0]!.to, data: calls[0]!.data, operation: OPERATION_CALL } : multiSendCallOnly(calls)) as { to: Address; data: Hex; operation: 0 | 1 }
  const tx: SafeTx = { to: op.to, value: 0n, data: op.data, operation: op.operation, nonce }
  const signature = await signSafeTx(acct.backupOwner, acct.safe, lab.chainId, tx)
  return lab.send(relayer, acct.safe, execTransactionData(tx, signature), 0n, gasLimit)
}

async function usdcPrice(lab: Lab, pool: string, token0: string, token1: string, asset: string): Promise<Price> {
  const [sqrtPriceX96] = await lab.client.readContract({ address: address(pool), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  const ratio: Price = { num: sqrtPriceX96 * sqrtPriceX96, den: 1n << 192n }
  if (token0 === 'USDC' && token1 === asset) return ratio
  if (token1 === 'USDC' && token0 === asset) return { num: ratio.den, den: ratio.num }
  throw new Error(`usdcPrice: ${pool} does not pair USDC with ${asset}`)
}

/** `forge script script/Deploy.s.sol` against the local anvil only (the URL is the Lab's loopback fork). */
async function forgeDeploy(rpcUrl: string, deployer: PrivateKeyAccount, key: Hex): Promise<{ policy: Address; gasPolicy: Address; out: string }> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(rpcUrl)) throw new Error(`refusing to broadcast anywhere but the local fork (${rpcUrl})`)
  const forge = Bun.which('forge') ?? join(process.env.HOME ?? '', '.foundry/bin/forge')
  // Async: the fork's loopback proxy runs in this process and must keep answering anvil while forge runs.
  const r = Bun.spawn([forge, 'script', 'script/Deploy.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--private-key', key, '--sender', deployer.address, '--slow', '--skip-simulation', '--rpc-timeout', '900', '--timeout', '900'], {
    cwd: join(REPO_ROOT, 'contracts/action-policy'),
    env: { ...process.env, POLICY_SALT_NONCE: '7', GAS_POLICY_SALT_NONCE: '8', CARDINALITY_TARGET: '3600' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited])
  const out = `${stdout}\n${stderr}`
  if (exitCode !== 0) throw new Error(`forge script failed (${exitCode}):\n${out.slice(-3000)}`)
  const policy = /MamoruActionPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(out)?.[1]
  const gasPolicy = /MamoruGasPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(out)?.[1]
  if (!policy || !gasPolicy) throw new Error(`forge script printed no addresses:\n${out.slice(-3000)}`)
  return { policy: policy as Address, gasPolicy: gasPolicy as Address, out }
}

type Built = { keys: string[]; grants: SessionGrant[]; permissionIds: Hex[]; calls: MultiSendCall[] }

// ------------------------------------------------------------------------------------------------ setup

const manifest = await loadManifest()
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t7`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  await assertCodeHashes(lab.client)
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}`)
  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, conservadorLabV4, engineNow)
  const safe = world.a1.safe
  note('fx-safe', true, `Safe7579 account ${safe}, registry trust set (TimeFramePolicy, UsageLimitPolicy self-attested)`)

  // ---------------------------------------------------------------------------------------------- 1. deploy (Deploy.s.sol)

  const deployerKey = ANVIL_DEV_KEYS[9] as Hex
  const deployer = devAccount(9)
  const dep = await forgeDeploy(handle.url, deployer, deployerKey)
  note('Deploy.s.sol --broadcast on the local fork', true, `MamoruActionPolicy ${dep.policy}, MamoruGasPolicy ${dep.gasPolicy}`)
  const reference = await lab.client.readContract({ address: address('ModuleRegistry'), abi: moduleRegistryAbi, functionName: 'findModule', args: [address('TimeFramePolicy')] })
  for (const [name, m] of [['MamoruActionPolicy', dep.policy], ['MamoruGasPolicy', dep.gasPolicy]] as const) {
    const rec = await lab.client.readContract({ address: address('ModuleRegistry'), abi: moduleRegistryAbi, functionName: 'findModule', args: [m] })
    note(`findModule(${name}): registered by the deployer under Mamoru's resolver (the operator's check before any attest)`, rec.sender.toLowerCase() === deployer.address.toLowerCase() && rec.resolverUID === reference.resolverUID, `sender ${rec.sender}`)
  }
  for (const p of Object.values(V4_POOLS)) {
    const s = await lab.client.readContract({ address: address(p.pool), abi: parseAbi(['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)']), functionName: 'slot0' })
    note(`ring raised: ${p.pool}`, s[4] >= 3_600, `observationCardinalityNext ${s[4]}`)
  }

  // The operator's policy object: conservadorLabV4 bound to both deployed addresses (boot.ts deployedV4).
  const policy = withActionPolicy(conservadorLabV4, dep.policy, Object.values(V4_POOLS), { caps: v4BudgetCaps(conservadorLabV4, CAP_USDC), gasPolicy: { address: dep.gasPolicy, caps: V4_GAS_CAPS } })
  const d: V4Deployment = v4DeploymentOf(policy)!
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, 'pool:USDC/cbBTC/500', 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, 'pool:WETH/USDC/3000', 'WETH', 'USDC', 'WETH'),
  }
  const caps = computeCaps(policy, CAP_USDC, prices)
  const budgets = v4BudgetCaps(policy, CAP_USDC)
  const allKeys = policy.session.grants.map(grantKey)
  let salt = 0
  const nextSalt = (): Hex => `0x${(++salt).toString(16).padStart(64, '0')}` as Hex

  /** The operator's approval(): instantiate + retarget, `v4PoliciesFor` at `generation`, `activationBatch`. */
  async function build(keys: string[], generation: bigint, sessionKey: Address, admitByPool: Partial<Record<string, bigint[]>>, attest: Address[], revokes: Hex[]): Promise<Built> {
    const now = await engineNow()
    const grants = keys.map((k) => retargetToPolicy(instantiateGrant(policy, k, { account: safe, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now - 60, validUntil: now + policy.session.validitySeconds, caps, capUsdc: CAP_USDC }), d.actionPolicy))
    const batch = activationBatch({ safe } as LiveAccount, grants, [], { trust: false, policiesFor: v4PoliciesFor(grants, d, generation, budgets, admitByPool), attest })
    return { keys, grants, permissionIds: batch.permissionIds, calls: [...revocationCalls(revokes), ...batch.calls] }
  }

  /** One v4 approval: split like the operator (`splitV4Keys` with this transaction's overhead), every part sent. */
  async function approveV4(label: string, generation: bigint, sessionKey: Address, admitByPool: Partial<Record<string, bigint[]>>, revokes: Hex[]): Promise<Built[]> {
    const attest = generation === 1n ? [d.actionPolicy, d.gasPolicy] : []
    const parts = splitV4Keys(policy, allKeys, { overheadGas: BigInt(revokes.length) * 190_000n + 150_000n })
    note(`${label}: split`, parts.length === 2, `${parts.length} owner transactions: ${parts.map((p) => p.length).join(' + ')} sessions`)
    const out: Built[] = []
    for (const [i, keys] of parts.entries()) {
      const b = await build(keys, generation, sessionKey, admitByPool, i === 0 ? attest : [], i === 0 ? revokes : [])
      const r = await ownerCalls(lab, relayer, world.a1, b.calls)
      note(`${label}: tx ${i + 1}/${parts.length}`, r.ok && r.receipt.gasUsed < BASE_PER_TX_GAS_CAP, `${r.receipt.gasUsed} gas (< 2^24), ${keys.join(', ')}`)
      gas[`${label}-tx${i + 1}`] = r.receipt.gasUsed.toString()
      if (!r.ok) throw new Error(`${label} tx ${i + 1} reverted`)
      out.push(b)
    }
    const g = await lab.client.readContract({ address: d.actionPolicy, abi: policyAbi, functionName: 'generationOf', args: [safe] })
    note(`${label}: generation on chain`, g === generation, `${g}`)
    return out
  }

  function session(parts: Built[], key: string): { name: string; grant: SessionGrant; permissionId: Hex } {
    for (const p of parts) {
      const i = p.keys.indexOf(key)
      if (i >= 0) {
        const grant = p.grants[i]!
        const permissionId = p.permissionIds[i]!
        world.a1.ledger.activate(permissionId, grant)
        return { name: key, grant, permissionId }
      }
    }
    throw new Error(`no session ${key}`)
  }

  async function engineOp(label: string, s: ReturnType<typeof session>, calls: { to: Address; data: Hex }[], key?: PrivateKeyAccount): Promise<SessionOpOutcome> {
    const g = engineGas((await lab.client.getBlock()).baseFeePerGas ?? 0n, V4_GAS_CAPS)
    if (!g) throw new Error('basefee over the gas cap on the fork')
    return sendSessionOp(world, world.a1, s, label, calls, { gas: g, ...(key ? { sessionKey: key } : {}) })
  }

  async function swapCalls(pool: string, tokenIn: string, tokenOut: string, fee: number, amountIn: bigint): Promise<{ to: Address; data: Hex }[]> {
    const [minOut, limit] = await lab.client.readContract({ address: d.actionPolicy, abi: policyAbi, functionName: 'swapBounds', args: [safe, address(pool), address(tokenIn), amountIn] })
    return [
      approve(tokenIn, 'SwapRouter02', amountIn),
      { to: address('SwapRouter02'), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address(tokenIn), tokenOut: address(tokenOut), fee, recipient: safe, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: limit }] }) },
    ]
  }

  // ---------------------------------------------------------------------------------------------- 2. activation, 2 txs

  const key1 = devAccount(5) // A1's session key in buildBasicWorld
  const gen1 = await approveV4('activation (generation 1)', 1n, key1.address, {}, [])
  for (const m of [d.actionPolicy, d.gasPolicy]) {
    const a = await lab.client.readContract({ address: address('ModuleRegistry'), abi: moduleRegistryAbi, functionName: 'findAttestation', args: [m, safe] })
    note(`self-attested by the Safe in tx 1: ${m}`, Number(a.time) > 0 && Number(a.revocationTime) === 0, `time ${a.time}`)
  }
  {
    const s = toSmartSession(gen1[0]!.grants[0]!, v4PoliciesFor(gen1[0]!.grants, d, 1n, budgets)(gen1[0]!.grants[0]!, 0))
    note('every v4 session carries MamoruGasPolicy as its third userOp policy', s.userOpPolicies[2]?.policy.toLowerCase() === d.gasPolicy.toLowerCase(), `${s.userOpPolicies.length} userOp policies`)
  }

  // ---------------------------------------------------------------------------------------------- 3. an engine op

  await lab.setBalance(safe, 10n ** 18n) // the leaked-key step below must be refused by the policy, not by a missing prefund
  const btcSwap1 = session(gen1, `enter-swap:${V4_POOLS.btc.pool}`)
  {
    const out = await engineOp('t7-engine-swap', btcSwap1, await swapCalls(V4_POOLS.btc.pool, 'USDC', 'cbBTC', 500, 300_000_000n))
    note('engine op: 300 USDC -> cbBTC at the policy bounds, gas from engineGas under the caps', out.verdict === 'INCLUDED', `${out.verdict}${out.failedOp?.reason ? ` (${out.failedOp.reason})` : ''}`)
  }

  // ---------------------------------------------------------------------------------------------- 4. leaked key over the gas caps

  {
    const calls = await swapCalls(V4_POOLS.btc.pool, 'USDC', 'cbBTC', 500, 10_000_000n)
    const over = await sendSessionOp(world, world.a1, btcSwap1, 't7-leaked-maxfee', calls, { gas: { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n } })
    note('leaked key: maxFeePerGas 1 gwei (over the 0.1 gwei cap) refused at validation', over.verdict === 'CHAIN_REJECTED_VALIDATION', `${over.verdict} validator=${over.validator}`)
    const prio = await sendSessionOp(world, world.a1, btcSwap1, 't7-leaked-priority', calls, { gas: { maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 50_000_000n } })
    note('leaked key: priority fee 0.05 gwei (over the 0.01 gwei cap) refused at validation', prio.verdict === 'CHAIN_REJECTED_VALIDATION', `${prio.verdict} validator=${prio.validator}`)
    const pvg = await sendSessionOp(world, world.a1, btcSwap1, 't7-leaked-pvg', calls, { gas: { preVerificationGas: 1_000_000n } })
    note('leaked key: preVerificationGas 1M (over the 200k cap) refused at validation', pvg.verdict === 'CHAIN_REJECTED_VALIDATION', `${pvg.verdict} validator=${pvg.validator}`)
    note('per-op bound the caps leave', null, `${maxGasCostPerOp(V4_GAS_CAPS)} wei (0.1 gwei x 5.2M gas)`)
  }

  // ---------------------------------------------------------------------------------------------- 5. a position minted outside, then the renewal admits it

  const tick = (await lab.client.readContract({ address: address(V4_POOLS.btc.pool), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
  const { tickLower, tickUpper } = rangeAround(tick, 2_000, 10)
  const cbbtc = await lab.balanceOf('cbBTC', safe)
  const deadline = BigInt(await engineNow()) + 3_600n
  const minted = await ownerCalls(lab, relayer, world.a1, [
    approve('USDC', 'NonfungiblePositionManager', 300_000_000n),
    approve('cbBTC', 'NonfungiblePositionManager', cbbtc),
    mint({ account: safe, pool: V4_POOLS.btc.pool, tickLower, tickUpper, amount0Desired: 300_000_000n, amount1Desired: cbbtc, amount0Min: 1n, amount1Min: 1n, deadline }),
  ].map((c) => ({ ...c, value: 0n })))
  const tokenId = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: minted.receipt.logs, eventName: 'Transfer' }).find((l) => l.args.to.toLowerCase() === safe.toLowerCase())?.args.tokenId
  note('owner mints a btc position outside the policy (as v2/v3 grants did)', minted.ok && tokenId !== undefined, `tokenId ${tokenId}`)
  const liquidity = (await lab.client.readContract({ address: address('NonfungiblePositionManager'), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId!] }))[7]
  const manage1 = session(gen1, `manage-any:${V4_POOLS.btc.pool}`)
  {
    const out = await engineOp('t7-decrease-not-admitted', manage1, [decreaseLiquidity({ tokenId: tokenId!, liquidity: liquidity / 2n, amount0Min: 1n, amount1Min: 1n, deadline })])
    note('generation 1: the session cannot decrease a position it was not given', out.verdict === 'CHAIN_REJECTED_VALIDATION', `${out.verdict} validator=${out.validator}`)
  }
  const key2 = devAccount(6)
  const gen2 = await approveV4('renewal (generation 2, admit)', 2n, key2.address, { [V4_POOLS.btc.pool]: [tokenId!] }, gen1.flatMap((b) => b.permissionIds))
  const at = await lab.client.readContract({ address: d.actionPolicy, abi: policyAbi, functionName: 'admittedPool', args: [safe, tokenId!] })
  note('Init.admit: the position is admitted to its pool at enable', at.toLowerCase() === address(V4_POOLS.btc.pool).toLowerCase(), at)
  {
    const old = await engineOp('t7-gen1-after-renewal', btcSwap1, await swapCalls(V4_POOLS.btc.pool, 'USDC', 'cbBTC', 500, 10_000_000n))
    note('a generation-1 session after the renewal (revoked and retired) is refused', old.verdict === 'CHAIN_REJECTED_VALIDATION', `${old.verdict} validator=${old.validator}`)
    const manage2 = session(gen2, `manage-any:${V4_POOLS.btc.pool}`)
    const [m0, m1] = await lab.client.readContract({ address: d.actionPolicy, abi: policyAbi, functionName: 'decreaseMins', args: [safe, address(V4_POOLS.btc.pool), tokenId!, liquidity / 2n] })
    const out = await engineOp('t7-decrease-admitted', manage2, [decreaseLiquidity({ tokenId: tokenId!, liquidity: liquidity / 2n, amount0Min: m0 > 0n ? m0 : 1n, amount1Min: m1 > 0n ? m1 : 1n, deadline }), { ...collect({ account: safe, tokenId: tokenId! }) }], key2)
    note('generation 2 (new key): the admitted position is decreased and collected at decreaseMins', out.verdict === 'INCLUDED', `${out.verdict}${out.failedOp?.reason ? ` (${out.failedOp.reason})` : ''} mins ${m0}/${m1}`)
  }

  // ---------------------------------------------------------------------------------------------- 6. usage-triggered signal

  {
    const stables = V4_POOLS.stables.pool
    const swap2 = session(gen2, `enter-swap:${stables}`)
    await lab.whaleTransfer('USDC', WHALE, safe, 10_000_000_000n)
    const total = budgets[V4_POOLS.stables.caps.budgetTotal]!
    const perCall = caps[V4_POOLS.stables.caps.stableSwapPerCall]!
    const read = async () => (await readPolicyBudgets(lab.client as never, d.actionPolicy, safe, [{ name: stables, address: address(stables) }], budgetUsedBps)).get(stables) ?? -1
    note('budget before', null, `stables T_p ${total}, used ${await read()} bps, per call ${perCall}`)
    for (const day of [1, 2]) {
      const calls: { to: Address; data: Hex }[] = []
      for (let i = 0; i < 4; i++) calls.push(...(await swapCalls(stables, 'USDC', 'USDT', 100, perCall)))
      const out = await engineOp(`t7-stables-day${day}`, swap2, calls, key2)
      note(`day ${day}: 4 swaps of ${perCall} USDC in one batch`, out.verdict === 'INCLUDED', `${out.verdict}${out.failedOp?.reason ? ` (${out.failedOp.reason})` : ''}, used ${await read()} bps`)
      await lab.warp(86_400)
    }
    const used = await read()
    note('usage-triggered renewal signal: the operator reads >= USAGE_RENEW_BPS of T_p from the chain', used >= USAGE_RENEW_BPS, `${used} bps >= ${USAGE_RENEW_BPS}`)
    const calls: { to: Address; data: Hex }[] = []
    for (let i = 0; i < 3; i++) calls.push(...(await swapCalls(stables, 'USDC', 'USDT', 100, perCall)))
    const past = await engineOp('t7-stables-past-total', swap2, calls, key2)
    note('a batch past T_p is refused (what the signal asks the owner to renew before)', past.verdict === 'CHAIN_REJECTED_VALIDATION', `${past.verdict} validator=${past.validator}`)
  }

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, policy: dep.policy, gasPolicy: dep.gasPolicy, safe, gas, lines: reportLines })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t7-fork', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
  exitCode = 1
} finally {
  await handle.stop()
  proxy.stop()
}

console.log('\n=== gas ===')
for (const [k, v] of Object.entries(gas)) console.log(`${k}: ${v}`)
console.log('\n=== summary ===')
for (const l of reportLines) console.log(`${l.ok === null ? '-' : l.ok ? '✓' : '✗'} ${l.step}: ${l.detail}`)
process.exit(exitCode)
