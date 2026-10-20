// otto/mamoru#151, #171: conservador-live-v5 on MamoruActionPolicyV2 end to end on a Base fork, through the real
// SmartSession + Safe7579 stack and the same builders the operator's activation, renewal and move use (`splitV4Keys`,
// `retargetToPolicy`, `v4PoliciesFor`, `activationBatch`, `v4BudgetCaps`, `engineGas`, `policyIncrease`,
// `deadlineCheck`), never hand-built sessions. Like t7-fork.ts:
//   1. deploy on the local fork only: Deploy.s.sol (V1 + MamoruGasPolicy, as on Base today) and DeployV2.s.sol (V2,
//      GUARDIAN a dev account), each in one `deployModule` call; the operator's `findModule` check on V2;
//   2. a v4 account as in production: v4 activation on V1 (generation 1), and an engine mint through V1's `mint`;
//      the owner also mints a position outside any policy;
//   3. the move to v5 (the operator's renew row): a new key, consecutive owner transactions on V2 at the V1
//      generation + 1, every v4 session revoked in the first, V2 self-attested, the V1-minted position named in
//      Init.admit; each transaction under Base's 2^24; a v4 session is refused afterwards;
//   4. increase through V2 (approve V2 + V2.increase) on the admitted position is included and adds liquidity to the
//      same NFT; the same on the owner's unadmitted position is refused at validation;
//   5. a swap batch with the swap deadline under the policy (multicall(deadline, []) + approve + swap) is included;
//   6. the guardian pauses the account: a swap, the deadline alone and an increase are each refused at validation;
//      unpaused, the same swap batch is included; paused again, the owner's renewal (generation + 1, new key, again in
//      consecutive transactions) ends the pause and the new key's swap is included.
//
// Run (builds the contracts, then the scenario):
//   nix shell nixpkgs#foundry --command bash -c '
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun packages/scenarios/action-policy/t8-fork.ts'
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org), through the loopback proxy, same as t1..t7.
import { join } from 'node:path'
import { encodeFunctionData, parseAbi, parseEventLogs, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { address, assertCodeHashes, erc20Abi, mamoruActionPolicyV2Abi, moduleRegistryAbi, nonfungiblePositionManagerAbi, safeAbi, swapRouter02Abi, uniswapV3PoolAbi, baseRegistry } from '@mamoru/registry'
import {
  V4_GAS_CAPS,
  V4_POOLS,
  computeCaps,
  conservadorLabV4,
  conservadorLabV5,
  grantKey,
  instantiateGrant,
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
import { OPERATION_CALL, execTransactionData, multiSendCallOnly, signSafeTx, type MultiSendCall, type SafeTx } from '@mamoru/account/safe'
import { approve, approveTo, deadlineCheck, mint, policyIncrease } from '@mamoru/uniswap-v3'
import { ANVIL_DEV_KEYS, Lab, devAccount, type TxResult } from '../fixtures/lab.ts'
import { buildBasicWorld, rangeAround, WHALE, type AccountFixture, type World } from '../fixtures/world.ts'
import { sendSessionOp, type SessionOpOutcome } from '../fixtures/session-op.ts'
import { engineGas } from '../driver/engine.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { startForkProxy } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, writeJson } from '../report/index.ts'
import { loadManifest, REPO_ROOT } from '../runner/manifest.ts'

const CAP_USDC = 1_000_000_000n // 1,000 USDC, as t7
const BASE_PER_TX_GAS_CAP = 16_777_216n
const BTC = V4_POOLS.btc.pool
const policyAbi = parseAbi([
  'function swapBounds(address account, address pool, address tokenIn, uint256 amountIn) view returns (uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)',
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
  console.error(`t8-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(`t8-fork failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})

async function ownerCalls(lab: Lab, relayer: PrivateKeyAccount, acct: AccountFixture, calls: MultiSendCall[], gasLimit = 20_000_000n): Promise<TxResult> {
  const nonce = await lab.client.readContract({ address: acct.safe, abi: safeAbi, functionName: 'nonce' })
  const op = (calls.length === 1 ? { to: calls[0]!.to, data: calls[0]!.data, operation: OPERATION_CALL } : multiSendCallOnly(calls)) as { to: Address; data: Hex; operation: 0 | 1 }
  const tx: SafeTx = { to: op.to, value: 0n, data: op.data, operation: op.operation, nonce }
  const signature = await signSafeTx(acct.backupOwner, acct.safe, lab.chainId, tx)
  return lab.send(relayer, acct.safe, execTransactionData(tx, signature), 0n, gasLimit)
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

type Built = { keys: string[]; grants: SessionGrant[]; permissionIds: Hex[]; calls: MultiSendCall[] }
type Session = { name: string; grant: SessionGrant; permissionId: Hex }

// ------------------------------------------------------------------------------------------------ setup

const manifest = await loadManifest()
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
const proxy = startForkProxy('BASE_FORK_RPC_URL')
const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/action-policy-t8`)
const { handle } = await startLabFork({ manifest, forkUrl: proxy.url, logPath: `${dir}/anvil.log` })
const lab = new Lab(handle.url, manifest.fork.chainId)

try {
  await assertCodeHashes(lab.client, baseRegistry)
  note('fork', true, `Base block ${manifest.fork.block} on anvil, chain id ${lab.chainId}`)
  const relayer = devAccount(0)
  const engineNow = async () => Number((await lab.client.getBlock()).timestamp)
  const world: World = await buildBasicWorld(lab, conservadorLabV4, engineNow)
  const safe = world.a1.safe
  note('fx-safe', true, `Safe7579 account ${safe}`)

  // ---------------------------------------------------------------------------------------------- 1. deploy V1 + gas, then V2

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
  const reference = await lab.client.readContract({ address: address('ModuleRegistry', baseRegistry), abi: moduleRegistryAbi, functionName: 'findModule', args: [address('TimeFramePolicy', baseRegistry)] })
  const rec = await lab.client.readContract({ address: address('ModuleRegistry', baseRegistry), abi: moduleRegistryAbi, functionName: 'findModule', args: [v2] })
  note("findModule(MamoruActionPolicyV2): the deployer's record under Mamoru's resolver", rec.sender.toLowerCase() === deployer.address.toLowerCase() && rec.resolverUID === reference.resolverUID, `sender ${rec.sender}`)
  const g = await lab.client.readContract({ address: v2, abi: mamoruActionPolicyV2Abi, functionName: 'GUARDIAN' })
  note('V2.GUARDIAN is the key the deploy named', g.toLowerCase() === guardian.address.toLowerCase(), g)
  const v2Code = await lab.client.getCode({ address: v2 })
  note('V2 runtime under EIP-170', ((v2Code?.length ?? 2) - 2) / 2 <= 24_576, `${((v2Code?.length ?? 2) - 2) / 2} bytes`)

  // The operator's policy objects (boot.ts deployedV4 / deployedV5).
  const gasCfg = { address: gasPolicy, caps: V4_GAS_CAPS }
  const p4 = withActionPolicy(conservadorLabV4, v1, Object.values(V4_POOLS), { caps: v4BudgetCaps(conservadorLabV4, CAP_USDC), gasPolicy: gasCfg })
  const p5 = withActionPolicy(conservadorLabV5, v2, Object.values(V4_POOLS), { caps: v4BudgetCaps(conservadorLabV5, CAP_USDC), gasPolicy: gasCfg, contractVersion: 2 })
  const prices: Record<string, Price> = {
    USDT: await usdcPrice(lab, 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDT'),
    cbBTC: await usdcPrice(lab, BTC, 'USDC', 'cbBTC', 'cbBTC'),
    WETH: await usdcPrice(lab, 'pool:WETH/USDC/3000', 'WETH', 'USDC', 'WETH'),
  }
  let salt = 0
  const nextSalt = (): Hex => `0x${(++salt).toString(16).padStart(64, '0')}` as Hex

  /** One approval of `policy` at `generation`, split like the operator, every part sent. */
  async function approveAll(label: string, policy: PolicyVersion, generation: bigint, sessionKey: Address, admitByPool: Partial<Record<string, bigint[]>>, attest: Address[], revokes: Hex[]): Promise<Built[]> {
    const d: V4Deployment = v4DeploymentOf(policy)!
    const caps = computeCaps(policy, CAP_USDC, prices)
    const budgets = v4BudgetCaps(policy, CAP_USDC)
    const allKeys = policy.session.grants.map(grantKey)
    const parts = splitV4Keys(policy, allKeys, { overheadGas: BigInt(revokes.length) * 190_000n + 150_000n })
    note(`${label}: split`, null, `${parts.length} owner transactions: ${parts.map((p) => p.length).join(' + ')} sessions, ${parts.map((p) => p.reduce((n, k) => n + policy.session.grants.find((x) => grantKey(x) === k)!.actions.length, 0)).join(' + ')} actions`)
    const out: Built[] = []
    for (const [i, keys] of parts.entries()) {
      const now = await engineNow()
      const grants = keys.map((k) => retargetToPolicy(instantiateGrant(policy, k, { account: safe, sessionKey, chainId: lab.chainId, salt: nextSalt(), validAfter: now - 60, validUntil: now + policy.session.validitySeconds, caps, capUsdc: CAP_USDC }), d.actionPolicy))
      const batch = activationBatch({ safe } as LiveAccount, grants, [], { trust: false, policiesFor: v4PoliciesFor(grants, d, generation, budgets, admitByPool), attest: i === 0 ? attest : [] })
      const calls = [...revocationCalls(i === 0 ? revokes : []), ...batch.calls]
      const r = await ownerCalls(lab, relayer, world.a1, calls)
      note(`${label}: tx ${i + 1}/${parts.length}`, r.ok && r.receipt.gasUsed < BASE_PER_TX_GAS_CAP, `${r.receipt.gasUsed} gas (< 2^24 = ${BASE_PER_TX_GAS_CAP}), ${keys.length} sessions`)
      gas[`${label}-tx${i + 1}`] = r.receipt.gasUsed.toString()
      if (!r.ok) throw new Error(`${label} tx ${i + 1} reverted`)
      out.push({ keys, grants, permissionIds: batch.permissionIds, calls })
    }
    const onChain = await lab.client.readContract({ address: d.actionPolicy, abi: policyAbi, functionName: 'generationOf', args: [safe] })
    note(`${label}: generation on chain`, onChain === generation, `${onChain}`)
    return out
  }

  function session(parts: Built[], key: string): Session {
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

  const liquidityOf = async (tokenId: bigint) => (await lab.client.readContract({ address: address('NonfungiblePositionManager', baseRegistry), abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [tokenId] }))[7]
  const verdict = (o: SessionOpOutcome) => `${o.verdict}${o.failedOp?.reason ? ` (${o.failedOp.reason})` : ''}${o.validator ? ` validator=${o.validator}` : ''}`

  // ---------------------------------------------------------------------------------------------- 2. a v4 account on V1

  await lab.setBalance(safe, 10n ** 18n)
  await lab.whaleTransfer('USDC', WHALE, safe, 2_000_000_000n)
  const key1 = devAccount(5)
  const gen1 = await approveAll('v4 activation on V1 (generation 1)', p4, 1n, key1.address, {}, [v1, gasPolicy], [])
  const v4Swap = session(gen1, `enter-swap:${BTC}`)
  {
    const out = await op('t8-v4-swap', v4Swap, await swapBatch(v1, BTC, 'USDC', 'cbBTC', 500, 300_000_000n, false), key1)
    note('v4: 300 USDC -> cbBTC at V1 bounds', out.verdict === 'INCLUDED', verdict(out))
  }
  const tick = (await lab.client.readContract({ address: address(BTC, baseRegistry), abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
  const { tickLower, tickUpper } = rangeAround(tick, 2_000, 10)
  const cbbtc = await lab.balanceOf('cbBTC', safe)
  const deadline = BigInt(await engineNow()) + 3_600n
  let admitted: bigint
  {
    const v4Mint = session(gen1, `enter-mint:${BTC}`)
    const e = V4_POOLS.btc
    const params = { token0: address(e.token0, baseRegistry), token1: address(e.token1, baseRegistry), fee: e.fee, tickLower, tickUpper, amount0Desired: 300_000_000n, amount1Desired: cbbtc / 2n, amount0Min: 1n, amount1Min: 1n, recipient: safe, deadline }
    const out = await op('t8-v4-mint', v4Mint, [approveTo('USDC', v1, params.amount0Desired), approveTo('cbBTC', v1, params.amount1Desired), { to: v1, data: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [params] }) }], key1)
    const id = out.receipt ? parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: out.receipt.logs, eventName: 'Transfer' }).find((l) => l.args.to.toLowerCase() === safe.toLowerCase())?.args.tokenId : undefined
    note('v4: the engine mints a btc position through V1.mint (admitted at V1)', out.verdict === 'INCLUDED' && id !== undefined, `${verdict(out)} tokenId ${id}`)
    admitted = id!
  }
  let outside: bigint
  {
    const r = await ownerCalls(lab, relayer, world.a1, [
      approve('USDC', 'NonfungiblePositionManager', 100_000_000n),
      approve('cbBTC', 'NonfungiblePositionManager', cbbtc / 4n),
      mint({ account: safe, pool: BTC, tickLower, tickUpper, amount0Desired: 100_000_000n, amount1Desired: cbbtc / 4n, amount0Min: 1n, amount1Min: 1n, deadline }),
    ].map((c) => ({ ...c, value: 0n })))
    outside = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: r.receipt.logs, eventName: 'Transfer' }).find((l) => l.args.to.toLowerCase() === safe.toLowerCase())!.args.tokenId
    note('the owner mints a btc position outside any policy', r.ok, `tokenId ${outside}`)
  }

  // ---------------------------------------------------------------------------------------------- 3. the move to v5 on V2

  const v1Gen = await lab.client.readContract({ address: v1, abi: policyAbi, functionName: 'generationOf', args: [safe] })
  const v2Gen = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'generationOf', args: [safe] })
  const moveGen = (v1Gen > v2Gen ? v1Gen : v2Gen) + 1n // the operator's v4Context + priorGeneration
  const key2 = devAccount(6)
  const moved = await approveAll('move v4 -> v5 (V2 first enable, revokes v4)', p5, moveGen, key2.address, { [BTC]: [admitted] }, [v2], gen1.flatMap((b) => b.permissionIds))
  note('move: V2 generation carries V1 + 1', moveGen === 2n, `${moveGen}`)
  const at = await lab.client.readContract({ address: v2, abi: policyAbi, functionName: 'admittedPool', args: [safe, admitted] })
  note('Init.admit: the V1-minted position is admitted at V2', at.toLowerCase() === address(BTC, baseRegistry).toLowerCase(), at)
  const a = await lab.client.readContract({ address: address('ModuleRegistry', baseRegistry), abi: moduleRegistryAbi, functionName: 'findAttestation', args: [v2, safe] })
  note('the Safe self-attested V2 in the first move transaction', Number(a.time) > 0 && Number(a.revocationTime) === 0, `time ${a.time}`)
  {
    const out = await op('t8-v4-after-move', v4Swap, await swapBatch(v1, BTC, 'USDC', 'cbBTC', 500, 10_000_000n, false), key1)
    note('a v4 session after the move (revoked) is refused', out.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(out))
  }

  // ---------------------------------------------------------------------------------------------- 4. increase through V2

  const manage = session(moved, `manage-any:${BTC}`)
  const incCalls = async (tokenId: bigint, usdc: bigint, btc: bigint) => [
    approveTo('USDC', v2, usdc),
    approveTo('cbBTC', v2, btc),
    policyIncrease(v2, { tokenId, amount0Desired: usdc, amount1Desired: btc, amount0Min: 1n, amount1Min: 1n, deadline: BigInt(await engineNow()) + 600n }),
  ]
  {
    const before = await liquidityOf(admitted)
    const u0 = await lab.balanceOf('USDC', safe)
    const out = await op('t8-increase', manage, await incCalls(admitted, 50_000_000n, cbbtc / 8n), key2)
    const after = await liquidityOf(admitted)
    note('increase through V2 on the admitted position: included, liquidity on the same NFT', out.verdict === 'INCLUDED' && after > before, `${verdict(out)}, liquidity ${before} -> ${after}`)
    if (out.receipt) gas['increase-userop-tx'] = out.receipt.gasUsed.toString()
    const left = await lab.client.readContract({ address: address('USDC', baseRegistry), abi: erc20Abi, functionName: 'balanceOf', args: [v2] })
    note('nothing stays in V2; the Safe paid at most the desired USDC', left === 0n && u0 - (await lab.balanceOf('USDC', safe)) <= 50_000_000n, `V2 USDC ${left}`)
  }
  {
    const out = await op('t8-increase-outside', manage, await incCalls(outside, 10_000_000n, 1n), key2)
    note('increase on the owner\'s unadmitted position: refused at validation', out.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(out))
  }

  // ---------------------------------------------------------------------------------------------- 5. the swap deadline under V2

  const swap5 = session(moved, `enter-swap:${BTC}`)
  {
    const out = await op('t8-swap-deadline', swap5, await swapBatch(v2, BTC, 'USDC', 'cbBTC', 500, 50_000_000n, true), key2)
    note('swap batch with multicall(deadline, []) under V2: included', out.verdict === 'INCLUDED', verdict(out))
  }

  // ---------------------------------------------------------------------------------------------- 6. guardian pause

  const pause = (fn: 'pause' | 'unpause') => lab.send(guardian, v2, encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: fn, args: [safe] }), 0n, 200_000n)
  {
    const nobody = await lab.send(devAccount(7), v2, encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: 'pause', args: [safe] }), 0n, 200_000n).catch(() => null)
    note('anyone but the guardian cannot pause', !nobody || !nobody.ok, nobody ? `status ${nobody.receipt.status}` : 'refused')
    const p = await pause('pause')
    note('the guardian pauses the Safe', p.ok && (await lab.client.readContract({ address: v2, abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', args: [safe] })), `gas ${p.receipt.gasUsed}`)
    gas['guardian-pause-tx'] = p.receipt.gasUsed.toString()
    const s = await op('t8-paused-swap', swap5, await swapBatch(v2, BTC, 'USDC', 'cbBTC', 500, 10_000_000n, true), key2)
    note('paused: a session swap userOp is refused at validation', s.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(s))
    const dl = await op('t8-paused-deadline', swap5, [deadlineCheck(BigInt(await engineNow()) + 300n)], key2)
    note('paused: the deadline action alone is refused at validation', dl.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(dl))
    const inc = await op('t8-paused-increase', manage, await incCalls(admitted, 10_000_000n, 1n), key2)
    note('paused: an increase is refused at validation', inc.verdict === 'CHAIN_REJECTED_VALIDATION', verdict(inc))
    const u = await pause('unpause')
    const again = await op('t8-unpaused-swap', swap5, await swapBatch(v2, BTC, 'USDC', 'cbBTC', 500, 10_000_000n, true), key2)
    note('unpaused: the same swap batch is included', u.ok && again.verdict === 'INCLUDED', verdict(again))
  }
  {
    await pause('pause')
    const key3 = devAccount(4)
    const renewed = await approveAll('v5 renewal on V2 while paused', p5, moveGen + 1n, key3.address, { [BTC]: [admitted] }, [], moved.flatMap((b) => b.permissionIds))
    const paused = await lab.client.readContract({ address: v2, abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', args: [safe] })
    note("the owner's renewal ends the pause", !paused, `isPaused ${paused}`)
    const s3 = session(renewed, `enter-swap:${BTC}`)
    const out = await op('t8-after-renewal', s3, await swapBatch(v2, BTC, 'USDC', 'cbBTC', 500, 10_000_000n, true), key3)
    note('the renewed key\'s swap batch (with the deadline) is included', out.verdict === 'INCLUDED', verdict(out))
  }

  await writeJson(`${dir}/report.json`, { manifestBlock: manifest.fork.block, v1, v2, gasPolicy, guardian: guardian.address, safe, gas, lines: reportLines })
  note('report written', true, `${dir}/report.json`)
} catch (e) {
  note('t8-fork', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
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
