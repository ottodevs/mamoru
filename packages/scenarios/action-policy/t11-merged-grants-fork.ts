// otto/mamoru#225: conservador-lab-v7 (v6 with one session per pool) end to end on a Base fork, through the real
// SmartSession + Safe7579 stack, MamoruActionPolicyV2, MamoruGasPolicy and MamoruPauseGate, and the same builders the
// operator's activation, renewal and move use (`instantiateGrant`, `retargetToPolicy`, `v4PoliciesFor`,
// `activationBatch`, `revocationCalls`, `v4BudgetCaps`, `grantKeyFor`, `engineGas`), never hand-built sessions. Every
// owner transaction is signed by the passkey (WebAuthn through the shared signer), as in production.
//   1. deploy on the local fork only: Deploy.s.sol (V1 + MamoruGasPolicy), DeployV2.s.sol (V2), MamoruPauseGate through
//      ModuleRegistry.deployModule bound to that V2;
//   2. ONE owner transaction each, gas recorded, each checked against the operator's own measure (simulateAndRevert in
//      the Safe x 9/8 + passkey margin, fitV4/oneTxV4) and V4_TX_GAS_TARGET: a fresh v7 activation; the move from a v5
//      account (9 sessions) and from a legacy v2 account (12 sessions) (each set up as today, in the transactions today's
//      split takes); then the same moves from accounts holding positions (2 admitted in the Init; a legacy account also
//      revoking 1 or 2 per-position `manage` grants): over the budget the operator falls back to the v6 move, sent as
//      today's split;
//   3. main line: a v6 account as today (its split counted), the engine's swap and mint under v6, the owner's own
//      positions; the move v6 -> v7 in ONE transaction (8 sessions revoked, 4 enabled, the owner's btc position
//      admitted); a v6 session refused afterwards;
//   4. the engine's ops under the merged sessions, each on the session `grantKeyFor` (decide's mapping) names: entry swap
//      with the deadline, mint through V2, increase, collect, the re-range close (decrease at V2's minimums + collect +
//      burn) and the re-mint, the harvest swap back to USDC, the stables entry, the USDC/cbBTC exit;
//   5. the attack set of t1/t4 against the merged sessions, plus one attack per UniActionPolicy rule the merge drops (swap
//      direction / tokens, approve spender, collect recipient, the deadline's encoding, decrease minimums, mint and
//      increase on positions or pools the session must not touch): each refused at validation by V2;
//   6. the v7 renewal in ONE transaction; the previous v7 session refused, the renewed one included.
//
// Run (contracts built as for t8/t10; pinned anvil from ~/.foundry/bin first on PATH):
//   PATH="$HOME/.foundry/bin:$PATH" bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t11-merged-grants-fork.ts'
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1..t10. Nothing is
// broadcast anywhere but the local anvil.
import { join } from 'node:path'
import { encodeDeployData, encodeFunctionData, encodePacked, maxUint256, parseAbi, parseEventLogs, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, checkCodeHashes, erc20Abi, mamoruActionPolicyV2Abi, moduleRegistryAbi, nonfungiblePositionManagerAbi, safeAbi, swapRouter02Abi, uniswapV3PoolAbi } from '@mamoru/registry'
import {
  V4_GAS_CAPS,
  V4_POOLS,
  V4_TX_GAS_TARGET,
  V6_POOLS,
  computeCaps,
  conservadorLabV5,
  conservadorLabV6,
  conservadorLabV7,
  conservadorLiveV2,
  fitPrefixBySimulation,
  grantKey,
  grantKeyFor,
  instantiateGrant,
  orderV4Keys,
  retargetToPolicy,
  splitV4Keys,
  v4BudgetCaps,
  withActionPolicy,
  type GrantName,
  type PolicyVersion,
  type Price,
  type SessionGrant,
  type V4PoolSpec,
} from '@mamoru/policy'
import { revocationCalls, v4DeploymentOf, v4PoliciesFor, type V4Deployment } from '@mamoru/account/sessions'
import { activationBatch, type LiveAccount } from '@mamoru/account/live'
import { OPERATION_CALL, execTransactionData, multiSendCallOnly, type MultiSendCall, type SafeTx } from '@mamoru/account/safe'
import { simulateCalls } from '@mamoru/rpc'
import { approve, approveTo, burn, collect, decreaseLiquidity, deadlineCheck, mint, policyIncrease } from '@mamoru/uniswap-v3'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { ANVIL_DEV_KEYS, Lab, devAccount, type TxResult } from '../fixtures/lab.ts'
import { buildBasicWorld, ownerSignature, rangeAround, WHALE, type World } from '../fixtures/world.ts'
import { sendSessionOp, type CallLike, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { engineGas } from '../driver/engine.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'
import { loadPolicyArtifact, resolverUidOf } from './v4-grant.ts'

const CAP_USDC = 1_000_000_000n // 1,000 USDC, as t7/t8
const BASE_PER_TX_GAS_CAP = 16_777_216n
/** operator.ts PASSKEY_VERIFY_GAS: what ownerTxGasLimit adds for the WebAuthn check on top of 9/8 of the simulation. */
const PASSKEY_VERIFY_GAS = 300_000n
const STABLES = V6_POOLS.stables.pool
const BALANCE = V6_POOLS.balance.pool
const BTC = V4_POOLS.btc.pool
const policyAbi = parseAbi([
  'function swapBounds(address account, address pool, address tokenIn, uint256 amountIn) view returns (uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)',
  'function decreaseMins(address account, address pool, uint256 tokenId, uint128 liquidity) view returns (uint256, uint256)',
  'function generationOf(address account) view returns (uint64)',
  'function admittedPool(address account, uint256 tokenId) view returns (address)',
  'function initializeWithMultiplexer(address account, bytes32 configId, bytes initData)',
])
const registryDeployAbi = parseAbi(['function deployModule(bytes32 salt, bytes32 resolverUID, bytes initCode, bytes metadata, bytes resolverContext) payable returns (address)'])
const multicallAbi = parseAbi(['function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])'])
const npmIncreaseAbi = parseAbi(['function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint128, uint256, uint256)'])

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
  console.error(`t11 failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t11 failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})

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

/** MamoruPauseGate bound to `v2`, created and registered in one ModuleRegistry.deployModule call (DeployPauseGate.s.sol's steps; that script pins Base's V2). */
async function deployPauseGate(lab: Lab, deployer: PrivateKeyAccount, v2: Address): Promise<Address> {
  const artifact = await loadPolicyArtifact(join(REPO_ROOT, 'contracts/action-policy/out/MamoruPauseGate.sol/MamoruPauseGate.json'))
  const initCode = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [address('SmartSession', baseRegistry), v2] })
  const salt = encodePacked(['address', 'uint96'], [deployer.address, 4n])
  const resolverUID = await resolverUidOf(lab, address('TimeFramePolicy', baseRegistry))
  const args = [salt, resolverUID, initCode, '0x', '0x'] as const
  const { result } = await lab.client.simulateContract({ account: deployer.address, address: address('ModuleRegistry', baseRegistry), abi: registryDeployAbi, functionName: 'deployModule', args })
  const tx = await lab.send(deployer, address('ModuleRegistry', baseRegistry), encodeFunctionData({ abi: registryDeployAbi, functionName: 'deployModule', args }), 0n, 4_000_000n)
  if (!tx.ok) throw new Error('ModuleRegistry.deployModule(MamoruPauseGate) reverted')
  return result
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

// ------------------------------------------------------------------------------------------------ setup

const manifest = await loadManifest()
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t11`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  {
    // Mamoru's own contracts are pinned at their Base addresses, deployed after the fork block: deployed here instead.
    const bad = (await checkCodeHashes(lab.client, baseRegistry)).filter((c) => !c.ok && !/^Mamoru/.test(c.name))
    if (bad.length) throw new Error(`LAB_REGISTRY_CODE_MISMATCH: ${bad.map((c) => c.name).join(', ')}`)
  }
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}`)
  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, conservadorLabV6, engineNow)
  const acct = world.a1
  const safe = acct.safe
  note('fx-safe', true, `Safe7579 account ${safe}`)

  // ---------------------------------------------------------------------------------------------- 1. deploy

  const deployerKey = ANVIL_DEV_KEYS[9] as Hex
  const deployer = devAccount(9)
  const guardian = devAccount(8)
  const outV1 = await forgeScript(handle.url, 'script/Deploy.s.sol', deployer, deployerKey, { POLICY_SALT_NONCE: '7', GAS_POLICY_SALT_NONCE: '8', CARDINALITY_TARGET: '3600' })
  const gasPolicy = /MamoruGasPolicy:\s*(0x[0-9a-fA-F]{40})/.exec(outV1)?.[1] as Address
  const outV2 = await forgeScript(handle.url, 'script/DeployV2.s.sol', deployer, deployerKey, { GUARDIAN: guardian.address, POLICY_V2_SALT_NONCE: '9', CARDINALITY_TARGET: '3600' })
  const v2 = /MamoruActionPolicyV2:\s*(0x[0-9a-fA-F]{40})/.exec(outV2)?.[1] as Address
  if (!gasPolicy || !v2) throw new Error('forge scripts printed no addresses')
  const gate = await deployPauseGate(lab, deployer, v2)
  const gateRec = await lab.client.readContract({ address: address('ModuleRegistry', baseRegistry), abi: moduleRegistryAbi, functionName: 'findModule', args: [gate] })
  note('deploy: MamoruGasPolicy, MamoruActionPolicyV2, MamoruPauseGate (registered)', gateRec.sender.toLowerCase() === deployer.address.toLowerCase(), `gas ${gasPolicy}, V2 ${v2}, gate ${gate}`)

  // The operator's policy objects (boot.ts deployedV5 / deployedV6, wired the same way for v7).
  const gasCfg = { address: gasPolicy, caps: V4_GAS_CAPS }
  const wire = (p: PolicyVersion, pools: V4PoolSpec[]) => {
    const w = withActionPolicy(p, v2, pools, { caps: v4BudgetCaps(p, CAP_USDC), gasPolicy: gasCfg, contractVersion: 2 })
    return { ...w, actionPolicy: { ...w.actionPolicy!, pauseGate: gate } }
  }
  const p5 = wire(conservadorLabV5, Object.values(V4_POOLS))
  const p6 = wire(conservadorLabV6, [V6_POOLS.stables, V6_POOLS.balance, V4_POOLS.btc])
  const p7 = wire(conservadorLabV7, [V6_POOLS.stables, V6_POOLS.balance, V4_POOLS.btc])
  const p2: PolicyVersion = { ...conservadorLiveV2, policyId: 'conservador-lab-v2', chain: 'fork' }
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, STABLES, 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, BTC, 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, BALANCE, 'WETH', 'USDC', 'WETH'),
  }
  let salt = 0
  const nextSalt = (): Hex => `0x${(++salt).toString(16).padStart(64, '0')}` as Hex
  await lab.setBalance(safe, 10n ** 18n)
  await lab.whaleTransfer('USDC', WHALE, safe, 3_000_000_000n)

  /** The owner's passkey-signed Safe transaction carrying `calls`, sent by the relayer with room up to Base's cap. */
  async function ownerTx(calls: MultiSendCall[]): Promise<TxResult> {
    const nonce = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
    const b = calls.length === 1 ? { to: calls[0]!.to, data: calls[0]!.data, operation: OPERATION_CALL } : multiSendCallOnly(calls)
    const tx: SafeTx = { to: b.to, value: 0n, data: b.data, operation: b.operation as 0 | 1, nonce }
    return lab.send(relayer, safe, execTransactionData(tx, await ownerSignature(lab, acct, tx, 'passkey')), 0n, BASE_PER_TX_GAS_CAP - 1n)
  }

  /** eth_estimateGas of the owner transaction signed by the backup EOA, plus the passkey check: the limit it really needs. */
  async function estimated(calls: MultiSendCall[]): Promise<bigint> {
    const nonce = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
    const b = calls.length === 1 ? { to: calls[0]!.to, data: calls[0]!.data, operation: OPERATION_CALL } : multiSendCallOnly(calls)
    const tx: SafeTx = { to: b.to, value: 0n, data: b.data, operation: b.operation as 0 | 1, nonce }
    return (await lab.client.estimateGas({ account: relayer.address, to: safe, data: execTransactionData(tx, await ownerSignature(lab, acct, tx, 'backup')), gas: BASE_PER_TX_GAS_CAP - 1n })) + PASSKEY_VERIFY_GAS
  }

  /** The operator's gas limit for an owner transaction (operator.ts ownerTxGasLimit): the batch once in the Safe, reverted. */
  // The head read fresh (not viem's cached block number): a snapshot revert moves it back.
  async function operatorLimit(calls: MultiSendCall[]): Promise<bigint | null> {
    const ms = multiSendCallOnly(calls)
    const call = [{ from: relayer.address, to: safe, data: encodeFunctionData({ abi: parseAbi(['function simulateAndRevert(address, bytes)']), functionName: 'simulateAndRevert', args: [ms.to, ms.data] }) }]
    const head = BigInt(await lab.rpc<Hex>('eth_blockNumber'))
    // After a snapshot revert anvil can report a head one past what eth_simulateV1 accepts: one block back then.
    const [r] = await simulateCalls(lab.client as never, call, head).catch(() => simulateCalls(lab.client as never, call, head - 1n))
    if (!r || r.returnData.length < 130 || BigInt(r.returnData.slice(0, 66)) !== 1n) return null
    return (r.gasUsed * 9n) / 8n + PASSKEY_VERIFY_GAS
  }

  function build(policy: PolicyVersion, keys: string[], generation: bigint, sessionKey: Address, admitByPool: Partial<Record<string, bigint[]>>, attest: Address[], revokes: Hex[], now: number): Built {
    const d: V4Deployment | null = v4DeploymentOf(policy)
    const caps = computeCaps(policy, CAP_USDC, prices)
    const grants = keys.map((k) => {
      const g = instantiateGrant(policy, k, { account: safe, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now - 60, validUntil: now + policy.session.validitySeconds, caps, capUsdc: CAP_USDC })
      return d && g.requiresActionPolicy ? retargetToPolicy(g, d.actionPolicy) : g
    })
    const batch = activationBatch({ safe } as LiveAccount, grants, [], { trust: false, ...(d ? { policiesFor: v4PoliciesFor(grants, d, generation, v4BudgetCaps(policy, CAP_USDC), admitByPool), attest } : {}) })
    return { keys, grants, permissionIds: batch.permissionIds, calls: [...revocationCalls(revokes), ...batch.calls] }
  }

  /**
   * One approval of `policy` as the operator sends it today: v5/v6 split by SIMULATED gas under V4_TX_GAS_TARGET
   * (fitV4), the static model seeding the search; v7 (`session.oneTransaction`) in ONE transaction, refused when over
   * the target (oneTxV4). Every transaction is sent; returns them, with the operator's limit and the receipt's gas.
   */
  /**
   * `fallback` (otto/mamoru#225, review P1-2): a one-transaction approval over the operator's budget is not sent; the
   * operator offers this policy's approval instead (planRenewOrFallBack), which is then sent as today and must land.
   */
  async function approveAll(label: string, policy: PolicyVersion, generation: bigint, sessionKey: Address, admitByPool: Partial<Record<string, bigint[]>>, attest: Address[], revokes: Hex[], fallback?: { policy: PolicyVersion; attest: Address[] }): Promise<Built[]> {
    let remaining = orderV4Keys(policy, policy.session.grants.map(grantKey))
    const out: Built[] = []
    for (let i = 0; remaining.length; i++) {
      const first = i === 0
      const now = await engineNow()
      const make = (keys: string[]) => build(policy, keys, generation, sessionKey, first ? admitByPool : {}, first ? attest : [], first ? revokes : [], now)
      let n = remaining.length
      if (!policy.session.oneTransaction) {
        const guess = splitV4Keys(policy, remaining, { overheadGas: (first ? BigInt(revokes.length) * 190_000n : 0n) + 150_000n, ceiling: V4_TX_GAS_TARGET })[0]?.length ?? 1
        const fit = await fitPrefixBySimulation(remaining, guess, async (keys) => operatorLimit(make(keys).calls))
        if (fit.n === 0) throw new Error(`${label}: not even one session fits ${V4_TX_GAS_TARGET}`)
        n = fit.n
      }
      const b = make(remaining.slice(0, n))
      const limit = await operatorLimit(b.calls)
      const est = await estimated(b.calls)
      // oneTxV4's bound: RENEW_GAS_BUDGET for a renewal or move, ACTIVATION_GAS_BUDGET for a Start (operator.ts).
      const budget = revokes.length ? 16_200_000n : 15_000_000n
      if (policy.session.oneTransaction && (limit === null || limit > budget)) {
        if (fallback) {
          note(`${label}: over the budget, the operator falls back to ${fallback.policy.policyId}`, true, `limit ${limit} > ${budget}, estimateGas+passkey ${est}`)
          gas[`${label} (refused)`] = `${est} estimate+passkey, ${limit} operator limit`
          return approveAll(`${label}: fallback ${fallback.policy.policyId}`, fallback.policy, generation, sessionKey, admitByPool, fallback.attest, revokes)
        }
        note(`${label}: the operator would refuse it (RENEWAL_TOO_LARGE)`, false, `limit ${limit} > ${budget}`)
      }
      const r = await ownerTx(b.calls)
      const actions = b.grants.reduce((m, g) => m + g.actions.length, 0)
      note(`${label}: owner tx ${i + 1}`, r.ok && r.receipt.gasUsed <= V4_TX_GAS_TARGET && est < BASE_PER_TX_GAS_CAP && (limit ?? 0n) < BASE_PER_TX_GAS_CAP, `${r.receipt.gasUsed} gas used, estimateGas+passkey ${est}, operator limit ${limit} (target ${V4_TX_GAS_TARGET}, 2^24 = ${BASE_PER_TX_GAS_CAP}): ${b.keys.length} sessions / ${actions} actions${first && revokes.length ? `, ${revokes.length} revoked` : ''}${first && attest.length ? `, ${attest.length} attested` : ''}`)
      gas[`${label} tx${i + 1}`] = `${r.receipt.gasUsed} used, ${est} estimate+passkey, ${limit} operator limit`
      if (!r.ok) throw new Error(`${label} tx ${i + 1} reverted`)
      out.push(b)
      remaining = remaining.slice(n)
    }
    note(`${label}: passkey prompts`, policy.session.oneTransaction ? out.length === 1 : null, `${out.length}`)
    const d = v4DeploymentOf(policy)
    if (d) {
      const onChain = await lab.client.readContract({ address: d.actionPolicy, abi: policyAbi, functionName: 'generationOf', args: [safe] })
      note(`${label}: V2 generation`, onChain === generation, `${onChain}`)
    }
    return out
  }

  /** Legacy v2 (no action policy): its 12 sessions enabled four at a time (today's activation dropped pairs to fit). */
  async function enableLegacy(policy: PolicyVersion, sessionKey: Address): Promise<Built[]> {
    const keys = policy.session.grants.filter((g) => !g.perPosition).map(grantKey)
    const out: Built[] = []
    for (let i = 0; i < keys.length; i += 4) {
      const b = build(policy, keys.slice(i, i + 4), 0n, sessionKey, {}, [], [], await engineNow())
      const r = await ownerTx(b.calls)
      if (!r.ok) throw new Error('legacy v2 enable reverted')
      out.push(b)
    }
    return out
  }

  /** Two positions the owner holds before a move: one in WETH/USDC, one in USDC/USDT, minted by the owner's own transactions. */
  async function ownerPositions(): Promise<{ ids: bigint[]; admit: Partial<Record<string, bigint[]>> }> {
    const buy = (tokenOut: string, fee: number, amountIn: bigint) => ({ to: address('SwapRouter02', baseRegistry), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: tokenOf('USDC'), tokenOut: tokenOf(tokenOut), fee, recipient: safe, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] }), value: 0n })
    const r = await ownerTx([{ ...approve('USDC', 'SwapRouter02', 100_000_000n), value: 0n }, buy('WETH', 3000, 50_000_000n), buy('USDT', 100, 50_000_000n)])
    if (!r.ok) throw new Error('owner swaps for the positions reverted')
    const inBalance = await ownerMintOutside(V6_POOLS.balance, (await lab.balanceOf('WETH', safe)) / 2n, 20_000_000n)
    const inStables = await ownerMintOutside(V6_POOLS.stables, 20_000_000n, (await lab.balanceOf('USDT', safe)) / 2n)
    return { ids: [inBalance, inStables], admit: { [BALANCE]: [inBalance], [STABLES]: [inStables] } }
  }

  /** A legacy account's per-position `manage` grant for each of `tokenIds` (v2: one per position, enabled after its mint). */
  async function enableManage(policy: PolicyVersion, sessionKey: Address, tokenIds: bigint[]): Promise<Hex[]> {
    const pools = [BALANCE, STABLES]
    const now = await engineNow()
    const caps = computeCaps(policy, CAP_USDC, prices)
    const grants = tokenIds.map((tokenId, i) => instantiateGrant(policy, `manage:${pools[i]}`, { account: safe, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now - 60, validUntil: now + policy.session.validitySeconds, caps, capUsdc: CAP_USDC, tokenId, admittedTokenIds: [tokenId] }))
    const batch = activationBatch({ safe } as LiveAccount, grants, [], { trust: false })
    const r = await ownerTx(batch.calls)
    if (!r.ok) throw new Error('legacy manage enable reverted')
    return batch.permissionIds
  }

  function session(parts: Built[], key: string): Session {
    for (const p of parts) {
      const i = p.keys.indexOf(key)
      if (i >= 0) {
        acct.ledger.activate(p.permissionIds[i]!, p.grants[i]!)
        return { name: key, grant: p.grants[i]!, permissionId: p.permissionIds[i]! }
      }
    }
    throw new Error(`no session ${key}`)
  }
  /** decide's mapping (allocate / rerange / convertKey): the session key the engine proposes `role` in `pool` under. */
  const engineSession = (policy: PolicyVersion, parts: Built[], role: GrantName, pool: string) => session(parts, grantKeyFor(policy, role, pool))

  async function op(label: string, s: Session, calls: CallLike[], key: PrivateKeyAccount, gasOverride?: Partial<NonNullable<ReturnType<typeof engineGas>>>): Promise<SessionOpOutcome> {
    const eg = engineGas((await lab.client.getBlock()).baseFeePerGas ?? 0n, V4_GAS_CAPS)
    if (!eg) throw new Error('basefee over the gas cap on the fork')
    return sendSessionOp(world, acct, s, label, calls, { gas: { ...eg, ...gasOverride }, sessionKey: key })
  }
  const verdict = (o: SessionOpOutcome) => `${o.verdict}${o.failedOp?.reason ? ` (${o.failedOp.reason})` : ''}${o.validator ? ` validator=${o.validator}` : ''}; precheck ${o.precheck.ok ? 'ok' : o.precheck.code}`
  const included = (label: string, o: SessionOpOutcome) => {
    note(label, o.verdict === 'INCLUDED', `${verdict(o)}${o.receipt ? `, ${o.receipt.gasUsed} gas` : ''}`)
    if (o.receipt) gas[`op: ${label}`] = o.receipt.gasUsed.toString()
    return o
  }
  const refused = (label: string, o: SessionOpOutcome) => note(label, o.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(o))

  const tokenOf = (n: string) => address(n as never, baseRegistry)
  async function swapCalls(pool: V4PoolSpec, tokenIn: string, tokenOut: string, amountIn: bigint, opts: { deadline?: boolean; recipient?: Address; loose?: boolean } = {}): Promise<CallLike[]> {
    const [minOut, limit] = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'swapBounds', args: [safe, address(pool.pool, baseRegistry), tokenOf(tokenIn), amountIn] })
    return [
      ...(opts.deadline === false ? [] : [deadlineCheck(BigInt(await engineNow()) + 300n)]),
      approve(tokenIn as never, 'SwapRouter02', amountIn),
      { to: address('SwapRouter02', baseRegistry), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: tokenOf(tokenIn), tokenOut: tokenOf(tokenOut), fee: pool.fee, recipient: opts.recipient ?? safe, amountIn, amountOutMinimum: opts.loose ? 1n : minOut, sqrtPriceLimitX96: opts.loose ? 0n : limit }] }) },
    ]
  }
  async function mintCalls(pool: V4PoolSpec, a0: bigint, a1: bigint, opts: { recipient?: Address } = {}): Promise<CallLike[]> {
    const [, tick] = await lab.client.readContract({ address: address(pool.pool, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' })
    const sps = await lab.client.readContract({ address: address(pool.pool, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'tickSpacing' })
    const { tickLower, tickUpper } = rangeAround(tick, Math.max(200 * sps, 20), sps)
    const params = { token0: tokenOf(pool.token0), token1: tokenOf(pool.token1), fee: pool.fee, tickLower, tickUpper, amount0Desired: a0, amount1Desired: a1, amount0Min: 1n, amount1Min: 1n, recipient: opts.recipient ?? safe, deadline: BigInt(await engineNow()) + 3_600n }
    return [approveTo(pool.token0 as never, v2, a0), approveTo(pool.token1 as never, v2, a1), { to: v2, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }]
  }
  const mintedId = (o: SessionOpOutcome | TxResult) => {
    const r = 'verdict' in o ? o.receipt : o.receipt
    return r ? parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: r.logs, eventName: 'Transfer' }).find((l) => l.args.to.toLowerCase() === safe.toLowerCase() && l.args.from === '0x0000000000000000000000000000000000000000')?.args.tokenId : undefined
  }
  const liquidityOf = async (tokenId: bigint) => (await lab.client.readContract({ address: address('NonfungiblePositionManager', baseRegistry), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] }))[7]
  async function closeCalls(pool: V4PoolSpec, tokenId: bigint, opts: { mins?: 'policy' | 'zero' } = {}): Promise<CallLike[]> {
    const liquidity = await liquidityOf(tokenId)
    const [m0, m1] = opts.mins === 'zero' ? [0n, 0n] : await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'decreaseMins', args: [safe, address(pool.pool, baseRegistry), tokenId, liquidity] })
    return [decreaseLiquidity({ tokenId, liquidity, amount0Min: m0, amount1Min: m1, deadline: BigInt(await engineNow()) + 600n }), collect({ account: safe, tokenId }), burn(tokenId)]
  }
  const incCalls = async (pool: V4PoolSpec, tokenId: bigint, a0: bigint, a1: bigint) => [
    approveTo(pool.token0 as never, v2, a0),
    approveTo(pool.token1 as never, v2, a1),
    policyIncrease(v2, { tokenId, amount0Desired: a0, amount1Desired: a1, amount0Min: 1n, amount1Min: 1n, deadline: BigInt(await engineNow()) + 600n }),
  ]
  async function ownerMintOutside(pool: V4PoolSpec, a0: bigint, a1: bigint): Promise<bigint> {
    const [, tick] = await lab.client.readContract({ address: address(pool.pool, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' })
    const sps = await lab.client.readContract({ address: address(pool.pool, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'tickSpacing' })
    const { tickLower, tickUpper } = rangeAround(tick, Math.max(200 * sps, 20), sps)
    const r = await ownerTx([
      approve(pool.token0 as never, 'NonfungiblePositionManager', a0),
      approve(pool.token1 as never, 'NonfungiblePositionManager', a1),
      mint({ account: safe, pool: pool.pool, tickLower, tickUpper, amount0Desired: a0, amount1Desired: a1, amount0Min: 1n, amount1Min: 1n, deadline: BigInt(await engineNow()) + 600n }),
    ].map((c) => ({ ...c, value: 0n })))
    const id = mintedId(r)
    if (!r.ok || id === undefined) throw new Error(`owner mint in ${pool.pool} failed`)
    return id
  }

  const key = devAccount(5) // the account's one session key, kept across renewals and moves as the operator does
  const S0 = await lab.snapshot()

  // ---------------------------------------------------------------------------------------------- 2. one-transaction approvals

  {
    await approveAll('v7 activation (fresh account)', p7, 1n, key.address, {}, [v2, gasPolicy, gate], [])
    await lab.revert(S0)
  }
  {
    const S = await lab.snapshot()
    const today = await approveAll('v5 activation, as today', p5, 1n, key.address, {}, [v2, gasPolicy], [])
    await approveAll('move v5 (9 sessions) -> v7', p7, 2n, key.address, {}, [gate], today.flatMap((b) => b.permissionIds))
    await lab.revert(S)
  }
  {
    const S = await lab.snapshot()
    const legacy = await enableLegacy(p2, key.address)
    const ids = legacy.flatMap((b) => b.permissionIds)
    note('legacy v2 account: sessions enabled', ids.length === 12, `${ids.length} in ${legacy.length} owner txs`)
    await approveAll('move legacy v2 (12 sessions) -> v7', p7, 1n, key.address, {}, [v2, gasPolicy, gate], ids)
    await lab.revert(S)
  }
  // otto/mamoru#225 (review P1-2): the same moves from accounts that hold positions, as real ones do. The operator's
  // v4Context admits every position the Safe still owns in the move's Init (the first session of each pool carries it),
  // and a legacy account also revokes the per-position `manage` grant of each one.
  {
    const S = await lab.snapshot()
    const today = await approveAll('v5 activation, as today (then 2 positions)', p5, 1n, key.address, {}, [v2, gasPolicy], [])
    const held = await ownerPositions()
    await approveAll('move v5 (9 sessions, 2 positions admitted) -> v7', p7, 2n, key.address, held.admit, [gate], today.flatMap((b) => b.permissionIds), { policy: p6, attest: [gate] })
    await lab.revert(S)
  }
  {
    const S = await lab.snapshot()
    const legacy = await enableLegacy(p2, key.address)
    const held = await ownerPositions()
    const manage = await enableManage(p2, key.address, held.ids)
    const ids = [...legacy.flatMap((b) => b.permissionIds), ...manage]
    note('legacy v2 account with 2 positions: sessions enabled', ids.length === 14, `${ids.length} (12 + ${manage.length} per-position manage)`)
    await approveAll('move legacy v2 (12 sessions + 2 manage, 2 positions admitted) -> v7', p7, 1n, key.address, held.admit, [v2, gasPolicy, gate], ids, { policy: p6, attest: [v2, gasPolicy, gate] })
    await lab.revert(S)
  }
  {
    const S = await lab.snapshot()
    const legacy = await enableLegacy(p2, key.address)
    const held = await ownerPositions()
    const manage = await enableManage(p2, key.address, held.ids.slice(0, 1))
    await approveAll('move legacy v2 (12 sessions + 1 manage, 1 position admitted) -> v7', p7, 1n, key.address, { [BALANCE]: held.ids.slice(0, 1) }, [v2, gasPolicy, gate], [...legacy.flatMap((b) => b.permissionIds), ...manage], { policy: p6, attest: [v2, gasPolicy, gate] })
    await lab.revert(S)
  }

  // ---------------------------------------------------------------------------------------------- 3. v6 as today, then the move

  const v6Parts = await approveAll('v6 activation, as today', p6, 1n, key.address, {}, [v2, gasPolicy, gate], [])
  const balance = V6_POOLS.balance
  const stables = V6_POOLS.stables
  const btc = V4_POOLS.btc
  const v6Swap = session(v6Parts, `enter-swap:${BALANCE}`)
  included('v6: entry swap 300 USDC -> WETH (enter-swap session)', await op('v6-swap', v6Swap, await swapCalls(balance, 'USDC', 'WETH', 300_000_000n), key))
  const v6Mint = await op('v6-mint', session(v6Parts, `enter-mint:${BALANCE}`), await mintCalls(balance, (await lab.balanceOf('WETH', safe)) / 2n, 150_000_000n), key)
  included('v6: mint WETH/USDC through V2 (enter-mint session)', v6Mint)
  const v6Position = mintedId(v6Mint)!
  // Bought by the owner (cbBTC for the old btc position and WETH for one outside the policy): positions the operator
  // admits at the move (btc, the account's own from an earlier version) and one it never admits.
  await ownerTx([approve('USDC', 'SwapRouter02', 200_000_000n), { to: address('SwapRouter02', baseRegistry), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: tokenOf('USDC'), tokenOut: tokenOf('cbBTC'), fee: 500, recipient: safe, amountIn: 200_000_000n, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] }) }].map((c) => ({ ...c, value: 0n })))
  const cbbtc = await lab.balanceOf('cbBTC', safe)
  const btcPosition = cbbtc > 0n ? await ownerMintOutside(btc, 100_000_000n, cbbtc / 2n) : null
  note('the owner holds a USDC/cbBTC position from an earlier version (exit only in v6/v7)', btcPosition !== null, `tokenId ${btcPosition}`)
  const outside = await ownerMintOutside(balance, (await lab.balanceOf('WETH', safe)) / 4n, 20_000_000n)
  note('the owner mints a WETH/USDC position outside any policy (never admitted)', true, `tokenId ${outside}`)

  const v6Ids = v6Parts.flatMap((b) => b.permissionIds)
  const gen6 = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'generationOf', args: [safe] })
  const moved = await approveAll('move v6 (8 sessions) -> v7', p7, gen6 + 1n, key.address, btcPosition !== null ? { [BTC]: [btcPosition] } : {}, [], v6Ids)
  if (btcPosition !== null) {
    const at = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'admittedPool', args: [safe, btcPosition] })
    note('move: the owner\'s btc position is admitted by the v7 Init', at.toLowerCase() === address(BTC, baseRegistry).toLowerCase(), at)
  }
  refused('a v6 session after the move (removed) is refused', await op('v6-after-move', v6Swap, await swapCalls(balance, 'USDC', 'WETH', 10_000_000n), key))

  // ---------------------------------------------------------------------------------------------- 4. the engine's ops on the merged sessions

  const mergedKeys = [`manage-any:${STABLES}`, `manage-any:${BALANCE}`, `manage-any:${BTC}`]
  note('v7 sessions', JSON.stringify(moved[0]!.keys) === JSON.stringify([...mergedKeys, 'bridge-out']), moved[0]!.keys.join(', '))
  for (const role of ['enter-swap', 'enter-mint', 'manage-any'] as const) {
    note(`decide's ${role} in WETH/USDC names the pool session`, grantKeyFor(p7, role, BALANCE) === `manage-any:${BALANCE}`, grantKeyFor(p7, role, BALANCE))
  }
  // The v6 entry spent most of WETH/USDC's daily window (V2's bucket refills over a day; a new generation does not refill
  // it): the engine would wait, so the next day.
  await lab.warp(86_400)
  const swapS = engineSession(p7, moved, 'enter-swap', BALANCE.toString())
  const mintS = engineSession(p7, moved, 'enter-mint', BALANCE)
  const manageS = engineSession(p7, moved, 'manage-any', BALANCE)
  const pool7 = manageS
  included('v7 (enter-swap role): entry swap 200 USDC -> WETH with the deadline', await op('v7-swap', swapS, await swapCalls(balance, 'USDC', 'WETH', 200_000_000n), key))
  const m7 = included('v7 (enter-mint role): mint WETH/USDC through V2', await op('v7-mint', mintS, await mintCalls(balance, (await lab.balanceOf('WETH', safe)) / 3n, 100_000_000n), key))
  const position = mintedId(m7)!
  {
    const before = await liquidityOf(v6Position)
    included('v7 (manage-any role): increase the v6-minted position (admission carried across the generation)', await op('v7-increase', manageS, await incCalls(balance, v6Position, (await lab.balanceOf('WETH', safe)) / 4n, 30_000_000n), key))
    note('  liquidity added to the same NFT', (await liquidityOf(v6Position)) > before, `${before} -> ${await liquidityOf(v6Position)}`)
  }
  included('v7 (manage-any role): collect fees', await op('v7-collect', manageS, [collect({ account: safe, tokenId: position })], key))
  included('v7 (manage-any role): re-range close: decrease all at V2 minimums + collect + burn', await op('v7-rerange-close', manageS, await closeCalls(balance, v6Position), key))
  included('v7 (manage-any role): re-mint after the re-range', await op('v7-remint', manageS, await mintCalls(balance, (await lab.balanceOf('WETH', safe)) / 3n, 50_000_000n), key))
  await lab.warp(86_400) // the day's window is spent by the entries above; the engine would wait for the refill
  included('v7 (manage-any role): harvest swap WETH -> USDC', await op('v7-harvest', manageS, await swapCalls(balance, 'WETH', 'USDC', (await lab.balanceOf('WETH', safe)) / 4n), key))
  const stS = engineSession(p7, moved, 'enter-swap', STABLES)
  included('v7 stables (enter-swap role): 100 USDC -> USDT', await op('v7-stables-swap', stS, await swapCalls(stables, 'USDC', 'USDT', 100_000_000n), key))
  included('v7 stables (enter-mint role): mint USDC/USDT through V2', await op('v7-stables-mint', engineSession(p7, moved, 'enter-mint', STABLES), await mintCalls(stables, 50_000_000n, (await lab.balanceOf('USDT', safe)) / 2n), key))
  const btcS = engineSession(p7, moved, 'manage-any', BTC)
  if (btcPosition !== null) {
    included('v7 USDC/cbBTC exit: close the admitted position', await op('v7-btc-close', btcS, await closeCalls(btc, btcPosition), key))
    included('v7 USDC/cbBTC exit: sell cbBTC for USDC', await op('v7-btc-sell', btcS, await swapCalls(btc, 'cbBTC', 'USDC', (await lab.balanceOf('cbBTC', safe)) / 2n), key))
  }

  // ---------------------------------------------------------------------------------------------- 5. attacks on the merged sessions

  const attacker = world.attacker.address
  // The rules the merge drops, one by one: V2 must refuse each at validation.
  refused('dropped tokenIn/tokenOut: the WETH/USDC session swaps USDC -> cbBTC at fee 3000', await op('atk-swap-foreign-token', pool7, [approve('USDC', 'SwapRouter02', 10_000_000n), { to: address('SwapRouter02', baseRegistry), data: encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: tokenOf('USDC'), tokenOut: tokenOf('cbBTC'), fee: 3000, recipient: safe, amountIn: 10_000_000n, amountOutMinimum: 1n, sqrtPriceLimitX96: 1n }] }) }], key))
  refused('swap paid to the attacker', await op('atk-swap-recipient', pool7, await swapCalls(balance, 'USDC', 'WETH', 10_000_000n, { recipient: attacker }), key))
  refused('dropped approve spender: USDC approved to the attacker', await op('atk-approve-attacker', pool7, [approveTo('USDC', attacker, 1_000_000n)], key))
  refused('dropped approve spender: USDC approved to the position manager (its increaseLiquidity funds any tokenId)', await op('atk-approve-npm', pool7, [approve('USDC', 'NonfungiblePositionManager', 1_000_000n)], key))
  refused('V2-only collect: collect an admitted position to the attacker', await op('atk-collect-attacker', pool7, [{ to: address('NonfungiblePositionManager', baseRegistry), data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'collect', args: [{ tokenId: position, recipient: attacker, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }] }) }], key))
  refused('V2-only decrease: an admitted position with zero minimums (sandwichable)', await op('atk-decrease-zero-mins', pool7, (await closeCalls(balance, position, { mins: 'zero' })).slice(0, 1), key))
  refused('V2-only decrease (t1 b): a position the policy never admitted', await op('atk-decrease-unadmitted', pool7, [decreaseLiquidity({ tokenId: outside, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: BigInt(await engineNow()) + 600n })], key))
  refused('V2-only burn: a position the policy never admitted', await op('atk-burn-unadmitted', pool7, [burn(outside)], key))
  refused('V2-only deadline: multicall(deadline, [a swap to the attacker])', await op('atk-deadline-payload', pool7, [{ to: address('SwapRouter02', baseRegistry), data: encodeFunctionData({ abi: multicallAbi, functionName: 'multicall', args: [BigInt(await engineNow()) + 300n, [encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: tokenOf('USDC'), tokenOut: tokenOf('WETH'), fee: 3000, recipient: attacker, amountIn: 1_000_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] })]] }) }], key))
  refused('mint through V2 paid to the attacker', await op('atk-mint-recipient', pool7, await mintCalls(balance, 1_000_000n, 1_000_000n, { recipient: attacker }), key))
  refused('increase on a position the policy never admitted', await op('atk-increase-unadmitted', pool7, await incCalls(balance, outside, 1_000n, 1_000_000n), key))
  refused("the position manager's own increaseLiquidity (never granted)", await op('atk-npm-increase', pool7, [{ to: address('NonfungiblePositionManager', baseRegistry), data: encodeFunctionData({ abi: npmIncreaseAbi, functionName: 'increaseLiquidity', args: [{ tokenId: position, amount0Desired: 1n, amount1Desired: 1_000_000n, amount0Min: 0n, amount1Min: 0n, deadline: BigInt(await engineNow()) + 600n }] }) }], key))
  refused('(t1 M-4) the session admits a position itself through initializeWithMultiplexer', await op('atk-self-admit', pool7, [{ to: v2, data: encodeFunctionData({ abi: policyAbi, functionName: 'initializeWithMultiplexer', args: [safe, `0x${'00'.repeat(32)}`, '0x'] }) }], key))
  refused('exit-only USDC/cbBTC session: buy cbBTC (kept tokenIn rule)', await op('atk-btc-enter-swap', btcS, await swapCalls(btc, 'USDC', 'cbBTC', 10_000_000n), key))
  refused('exit-only USDC/cbBTC session: mint (not granted)', await op('atk-btc-mint', btcS, await mintCalls(btc, 1_000_000n, 1n), key))
  refused('gas over MamoruGasPolicy caps (leaked key overpaying)', await op('atk-gas-cap', pool7, await swapCalls(balance, 'USDC', 'WETH', 10_000_000n), key, { maxFeePerGas: V4_GAS_CAPS.maxFeePerGas + 1n }))
  {
    // (t1 c) a batch over the per-window budget: each swap fits UniActionPolicy's merged cap.
    await lab.warp(86_400)
    const perWindow = v4BudgetCaps(p7, CAP_USDC)[balance.caps.budgetWindow]!
    const each = (perWindow * 4n) / 10n
    const one = await swapCalls(balance, 'USDC', 'WETH', each, { deadline: false })
    refused(`(t1 c) three ${each} USDC swaps in one window (budget ${perWindow})`, await op('atk-batch-over-budget', pool7, [...one, ...one, ...one], key))
  }
  {
    // (t1 a) a manipulated price, both directions now that one session swaps both ways.
    const snap = await lab.snapshot()
    try {
      // The attacker sells WETH (token0) down to 300 ticks under the spot, three bands, in one block.
      const before = (await lab.client.readContract({ address: address(BALANCE, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
      await lab.setBalance(attacker, 10n ** 24n)
      await lab.send(world.attacker, tokenOf('WETH'), encodeFunctionData({ abi: parseAbi(['function deposit() payable']), functionName: 'deposit' }), 500_000n * 10n ** 18n)
      await lab.send(world.attacker, tokenOf('WETH'), encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address('SwapRouter02', baseRegistry), maxUint256] }))
      await lab.send(world.attacker, address('SwapRouter02', baseRegistry), encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: tokenOf('WETH'), tokenOut: tokenOf('USDC'), fee: 3000, recipient: attacker, amountIn: 500_000n * 10n ** 18n, amountOutMinimum: 0n, sqrtPriceLimitX96: sqrtRatioAtTick(before - 300) }] }))
      const after = (await lab.client.readContract({ address: address(BALANCE, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
      note('(t1 a) the attacker moves WETH/USDC in one block (TWAP unchanged)', null, `tick ${before} -> ${after}`)
      refused('(t1 a.1) USDC -> WETH at a loose minimum (1) and no price limit', await op('atk-manip-loose-in', pool7, await swapCalls(balance, 'USDC', 'WETH', 100_000_000n, { loose: true }), key))
      refused('(t1 a.1) WETH -> USDC at a loose minimum (1) and no price limit', await op('atk-manip-loose-out', pool7, await swapCalls(balance, 'WETH', 'USDC', (await lab.balanceOf('WETH', safe)) / 2n, { loose: true }), key))
      const tight = await op('atk-manip-policy-bounds', pool7, await swapCalls(balance, 'USDC', 'WETH', 100_000_000n), key)
      note('(t1 a.2) at V2 bounds: never filled at the manipulated price (spot outside the band)', tight.verdict !== 'INCLUDED' && after <= before - 200, verdict(tight))
    } finally {
      await lab.revert(snap)
    }
  }

  // ---------------------------------------------------------------------------------------------- 6. v7 renewal

  const gen7 = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'generationOf', args: [safe] })
  const renewed = await approveAll('v7 renewal', p7, gen7 + 1n, key.address, { [BALANCE]: [position] }, [], moved.flatMap((b) => b.permissionIds))
  refused('the previous v7 session after the renewal is refused', await op('v7-old-after-renewal', pool7, await swapCalls(balance, 'USDC', 'WETH', 10_000_000n), key))
  included('the renewed pool session swaps', await op('v7-renewed-swap', engineSession(p7, renewed, 'enter-swap', BALANCE), await swapCalls(balance, 'USDC', 'WETH', 10_000_000n), key))

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, v2, gasPolicy, gate, safe, gas, lines: reportLines })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t11', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
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
