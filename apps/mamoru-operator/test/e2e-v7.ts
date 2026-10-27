// otto/mamoru#225: the operator itself moves a running LEGACY account (conservador-live-v2) straight to
// conservador-live-v7 (v6 with one session per pool) in ONE owner transaction, on an anvil fork of Base (chain id 8453),
// through its owner-op machinery (planRenew -> fitV4 -> oneTxV4, simulated gas under V4_TX_GAS_TARGET), and the real
// engine then runs on the merged sessions (decide's enter-swap / enter-mint / manage-any of a pool all name its one
// session): activate (v2) -> the engine invests -> `merged_grants_v7`: the move, ONE transaction (every v2 grant revoked,
// V2 + MamoruGasPolicy + MamoruPauseGate self-attested, the Safe's positions admitted) -> the engine works under v7 (the
// USDC/cbBTC position, at 0 % in v7, is wound down through its exit-only session) -> a v7 renewal, ONE transaction ->
// stop closes everything. Each owner transaction's receipt gas is reported.
// MamoruPauseGate is `undeployed` in the registry, so a signing operator refuses MAMORU_PAUSE_GATE_ADDRESS at boot
// (assertBootPolicies): this run boots without it and hands the operator the v7 target boot would resolve with it
// (resolveV7Policy), the gate deployed here.
//
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org, the public endpoint, never the operator's provider key),
// through the loopback proxy. Run: PATH="$HOME/.foundry/bin:$PATH" bun apps/mamoru-operator/test/e2e-v7.ts
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeDeployData, encodeFunctionData, encodePacked, parseAbi, toHex, type Hex } from 'viem'
import type { AccountContext, FundingView, OpView, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, baseRegistry, mamoruActionPolicyV2Abi } from '@mamoru/registry'
import { V4_TX_GAS_TARGET, type PolicyVersion } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startEnginePort, startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab, devAccount } from '../../../packages/scenarios/fixtures/lab.ts'
import { deployGasPolicy, deployMamoruPolicy, deployMamoruPolicyV2, loadPolicyArtifact, raiseObservationCardinality, resolverUidOf } from '../../../packages/scenarios/action-policy/v4-grant.ts'
import { REPO_ROOT } from '../../../packages/scenarios/runner/manifest.ts'
import { WHALE } from '../../../packages/scenarios/fixtures/world.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { bootOperator, resolveV7Policy } from '../src/boot.ts'
import { readSafe } from '../src/chain.ts'
import { DEFAULT_SPONSOR, SPONSOR_BOUNDS, type SponsorPolicy } from '../src/sponsorship.ts'

process.env.RPC_URL = process.env.BASE_FORK_RPC_URL ?? 'https://mainnet.base.org'
const DEPOSIT = 20_000_000n
const t0 = Date.now()
const log = (m: string) => console.log(`[e2e-v7 +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`E2E FAILED: ${what}`)
  log(`ok  ${what}`)
}
const policyAbi = parseAbi(['function generationOf(address) view returns (uint64)', 'function admittedPool(address, uint256) view returns (address)'])
const BASE_TX_GAS_CAP = 16_777_216n

// --- fork -----------------------------------------------------------------
const proxy = startForkProxy('RPC_URL')
const anvilBin = Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = portProbe.port as number
portProbe.stop(true)
// Pinned to the Lab manifest's block (E2E_FORK_BLOCK to change it): anvil keeps that block's state cached, so the
// deploy's ring raise does not read thousands of cold slots through the public RPC. No compute-unit throttle (the
// public endpoint needs none at this volume; FORK_CUPS sets one) and a 120 s upstream timeout: the ring raise's gas
// estimate reads hundreds of cold slots in one request.
const forkBlock = process.env.E2E_FORK_BLOCK ?? '51811000'
const argv = ['--fork-url', proxy.url, '--fork-block-number', forkBlock, ...(process.env.FORK_CUPS ? ['--compute-units-per-second', process.env.FORK_CUPS] : ['--no-rate-limit']), '--timeout', '120000', '--fork-retry-backoff', '2000', '--retries', '10', '--chain-id', '8453', '--host', '127.0.0.1', '--port', String(port), '--slots-in-an-epoch', '1', '--block-time', '1', '--no-request-size-limit']
assertNoKeyInArgv(argv, ['RPC_URL', 'BASE_RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-operator-e2e-v7-'))
const anvil = Bun.spawn([anvilBin, ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const anvilUrl = `http://127.0.0.1:${port}/`
const lab = new Lab(anvilUrl, 8453)
for (let i = 0; ; i++) {
  try {
    await lab.client.getBlockNumber()
    break
  } catch {
    if (i > 300) throw new Error('anvil did not start')
    await Bun.sleep(200)
  }
}
const enginePort = startEnginePort(anvilUrl)
let stopOperator = () => {}
const cleanup = async () => {
  stopOperator()
  enginePort.stop()
  anvil.kill()
  await anvil.exited
  proxy.stop()
}

/**
 * The two policies, deployed and registered the way Deploy.s.sol does (one `deployModule` each, deployer-prefixed salt)
 * and the rings raised, with explicit gas limits: on a fork at an older block the script's gas estimates read
 * hundreds of cold slots through the public RPC and time out. t7-fork.ts runs Deploy.s.sol itself.
 */
async function deployPolicies(): Promise<{ policy: string; gasPolicy: string; v2: string; gate: string }> {
  const deployer = devAccount(9)
  const policy = await deployMamoruPolicy(lab, await loadPolicyArtifact(), deployer)
  const gasPolicy = await deployGasPolicy(lab, deployer)
  const v2 = await deployMamoruPolicyV2(lab, deployer, GUARDIAN.address)
  // MamoruPauseGate bound to that V2 (DeployPauseGate.s.sol's steps; the script pins Base's V2).
  const artifact = await loadPolicyArtifact(join(REPO_ROOT, 'contracts/action-policy/out/MamoruPauseGate.sol/MamoruPauseGate.json'))
  const initCode = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [address('SmartSession', baseRegistry), v2] })
  const args = [encodePacked(['address', 'uint96'], [deployer.address, 4n]), await resolverUidOf(lab, address('TimeFramePolicy', baseRegistry)), initCode, '0x', '0x'] as const
  const deployAbi = parseAbi(['function deployModule(bytes32 salt, bytes32 resolverUID, bytes initCode, bytes metadata, bytes resolverContext) payable returns (address)'])
  const { result: gate } = await lab.client.simulateContract({ account: deployer.address, address: address('ModuleRegistry', baseRegistry), abi: deployAbi, functionName: 'deployModule', args })
  const tx = await lab.send(deployer, address('ModuleRegistry', baseRegistry), encodeFunctionData({ abi: deployAbi, functionName: 'deployModule', args }), 0n, 4_000_000n)
  if (!tx.ok) throw new Error('deployModule(MamoruPauseGate) reverted')
  for (const pool of ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'] as const) await raiseObservationCardinality(lab, deployer, address(pool, baseRegistry), 1_800)
  return { policy, gasPolicy, v2, gate }
}

const GUARDIAN = devAccount(8)
/** Receipt gas of every owner transaction, by label. */
const gasReport: string[] = []

try {
  log(`fork of Base at block ${await lab.client.getBlockNumber()}, chain ${await lab.client.getChainId()}`)
  const dep = await deployPolicies()
  log(`deployed MamoruActionPolicy ${dep.policy}, MamoruGasPolicy ${dep.gasPolicy}, MamoruActionPolicyV2 ${dep.v2} (guardian ${GUARDIAN.address}), MamoruPauseGate ${dep.gate}`)

  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner', baseRegistry)]
  const saltNonce = BigInt(Date.now())
  const ctx: AccountContext = {
    accountKey: `e2e-v7-${saltNonce}`,
    chainId: 8453,
    address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))),
    owners,
    saltNonce: saltNonce.toString(),
    passkey: { credentialId: 'e2e', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
  }
  await lab.whaleTransfer('USDC', WHALE, ctx.address, DEPOSIT)
  // ETH for the gas reserve up front: a cold fork's prepare can outlast the in-batch reserve swap's deadline.
  await lab.setBalance(ctx.address, 10n ** 16n)

  process.env.MAMORU_LIVE = '1'
  process.env.MAMORU_HEAD_LAG = '0'
  process.env.MAMORU_ONCHAIN_POLICY_V4 = '1'
  process.env.MAMORU_ACTION_POLICY_ADDRESS = dep.policy
  process.env.MAMORU_GAS_POLICY_ADDRESS = dep.gasPolicy
  process.env.MAMORU_ACTION_POLICY_V2_ADDRESS = dep.v2
  const secret = randomBytes(32).toString('hex')
  const op = await bootOperator({ rpcUrl: enginePort.url, secret, stateDir: join(dir, 'state'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100, policyId: 'conservador-live-v2' })
  stopOperator = op.stop
  check(op.operator.cfg.v7Policy === undefined, 'booted without a pause gate: v7 is not offered (fail closed)')
  const v7: PolicyVersion = resolveV7Policy('base', { ...process.env, MAMORU_PAUSE_GATE_ADDRESS: dep.gate })!
  check(v7.policyId === 'conservador-live-v7' && v7.actionPolicy?.address.toLowerCase() === dep.v2.toLowerCase() && v7.actionPolicy?.pauseGate?.toLowerCase() === dep.gate.toLowerCase(), 'v7 target wired to V2, the gas policy and the gate')
  ;(op.operator.cfg as { v7Policy?: PolicyVersion }).v7Policy = v7
  await lab.setBalance(op.operator.relayer.address, 10n ** 18n)
  // anvil quotes ~1 gwei (Base: ~0.005), so the sponsorship budget would stop this run's ten owner transactions after a
  // few; renewAllSteps clears the account's sponsorship record before each step (this run measures the split, not
  // sponsorship), and the limits sit at the top of SPONSOR_BOUNDS.
  ;(op.operator.cfg as { sponsor?: SponsorPolicy }).sponsor = { ...DEFAULT_SPONSOR, weiPerDay: SPONSOR_BOUNDS.weiPerDay[1], perAccount: SPONSOR_BOUNDS.perAccount[1] }
  log(`anvil gas price ${await lab.client.getGasPrice()} wei`)

  const header = Buffer.from(JSON.stringify(ctx)).toString('base64url')
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const raw = body === undefined ? '' : JSON.stringify(body)
    // The ts-signed scheme (server.ts): the legacy one without x-mamoru-ts is refused since 2026-10-23.
    const ts = Math.floor(Date.now() / 1000).toString()
    const key = createHmac('sha256', secret).update('x-mamoru-ts-v1').digest()
    const sig = createHmac('sha256', key).update(`${method} ${path}\n${header}\n${ts}\n${raw}`).digest('hex')
    const res = await fetch(op.url + path, { method, headers: { 'x-mamoru-account': header, 'x-mamoru-sig': sig, 'x-mamoru-ts': ts, 'content-type': 'application/json' }, body: method === 'POST' ? raw : undefined })
    return { status: res.status, json: (await res.json()) as T }
  }
  const base = `/api/accounts/${ctx.accountKey}`
  const funding = async () => (await call<FundingView>('GET', `${base}/funding`)).json
  const ops = async () => (await call<{ ops: OpView[] }>('GET', `${base}/ops`)).json.ops
  function der(r: bigint, s: bigint): Uint8Array {
    const int = (v: bigint) => {
      let b = Buffer.from(v.toString(16).padStart(64, '0'), 'hex')
      while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1)
      if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b])
      return Buffer.concat([Buffer.from([0x02, b.length]), b])
    }
    const body = Buffer.concat([int(r), int(s)])
    return Buffer.concat([Buffer.from([0x30, body.length]), body])
  }
  function browserSign(t: OwnerTxToSign): OwnerSignature {
    const a = passkey.assert(t.safeTxHash)
    const s = randomBytes(1)[0]! & 1 ? P256_N - a.s : a.s
    return { prepareId: t.prepareId, authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'), clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'), signature: Buffer.from(der(a.r, s)).toString('base64url') }
  }
  async function waitOp(opId: string, what: string, timeoutMs = 180_000): Promise<OpView> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const o = (await ops()).find((x) => x.opId === opId)
      if (o && (o.state === 'confirmed' || o.state === 'failed')) {
        check(o.state === 'confirmed', `${what} confirmed (${o.txHash} block ${o.block}${o.code ? ` ${o.code}` : ''})`)
        return o
      }
      if (Date.now() > until) throw new Error(`E2E FAILED: ${what} still ${o?.state}`)
      await Bun.sleep(1_000)
    }
  }
  async function ownerAction(kind: 'activate' | 'stop' | 'renew'): Promise<{ op: OpView; summary: string[]; gasUsed: bigint }> {
    // Prepared and submitted on the operator object (the same calls the routes make): on a cold fork a prepare's
    // simulations read every slot through the public RPC and can outlast the server's 120 s idle timeout.
    const o = op.operator
    const t = await (kind === 'activate' ? o.prepareActivate(ctx) : kind === 'stop' ? o.prepareStop(ctx) : o.prepareRenew(ctx))
    const prep = { status: 200, json: t }
    log(`${kind} to sign:\n    ${prep.json.summary.join('\n    ')}`)
    const res = await o.submit(ctx, kind, browserSign(prep.json))
    const done = await waitOp(res.opId, `owner ${kind}`, 600_000)
    const receipt = await lab.client.getTransactionReceipt({ hash: done.txHash as Hex })
    return { op: done, summary: prep.json.summary, gasUsed: receipt.gasUsed }
  }

  /** Every renew step of one approval until nothing is missing: the receipt gas of each owner transaction. */
  async function renewAllSteps(label: string): Promise<bigint[]> {
    const gas: bigint[] = []
    for (let i = 0; i < 6; i++) {
      const acc = (op.operator as unknown as { store: { state: { accounts: Record<string, { sponsored?: unknown[] }> } } }).store.state.accounts[ctx.accountKey]
      if (acc) acc.sponsored = []
      const s = await ownerAction('renew')
      gas.push(s.gasUsed)
      gasReport.push(`${label} tx ${i + 1}: ${s.gasUsed}`)
      check(s.gasUsed <= V4_TX_GAS_TARGET && s.gasUsed < BASE_TX_GAS_CAP, `${label} tx ${i + 1}: ${s.gasUsed} gas <= ${V4_TX_GAS_TARGET} (cap 2^24)`)
      const f = await funding()
      if (!f.approval?.missing && !f.approval?.upgrade) return gas
    }
    throw new Error(`E2E FAILED: ${label} still missing grants after 6 steps`)
  }
  async function engineSettled(label: string, until: number, done: () => Promise<boolean>): Promise<void> {
    for (;;) {
      const all = await ops()
      const busy = all.some((o) => o.opId.startsWith('eng-') && (o.state === 'submitted' || o.state === 'proposed'))
      if (!busy && (await done())) return
      if (Date.now() > until) throw new Error(`E2E FAILED: ${label}: ${JSON.stringify(all.filter((o) => o.opId.startsWith('eng-')).map((o) => `${o.opId}:${o.state}:${o.code}`))}`)
      await Bun.sleep(3_000)
    }
  }

  // --- v2 activation, the engine invests (a legacy account as in production) ------------------------
  const act = await ownerAction('activate')
  gasReport.push(`v2 activation: ${act.gasUsed}`)
  await engineSettled('v2 allocation', Date.now() + 480_000, async () => (await readSafe(lab.client, ctx.address, baseRegistry)).positions.length >= 2)
  const r0 = await readSafe(lab.client, ctx.address, baseRegistry)
  log(`v2 positions: ${r0.positions.map((p) => `${p.tokenId} ${p.pool}`).join(', ')}`)
  const v2Grants = (op.operator as unknown as { store: { state: { accounts: Record<string, { grants: unknown[] }> } } }).store.state.accounts[ctx.accountKey]!.grants.length

  // --- merged_grants_v7: the move v2 -> v7, ONE owner transaction ------------------------------------
  const flags: Record<string, boolean> = {}
  ;(op.operator.cfg as { opsFlags?: () => Record<string, boolean> }).opsFlags = () => flags
  check((await funding()).approval?.upgradePolicy === undefined, 'flag off: no move offered')
  flags.merged_grants_v7 = true
  check((await funding()).approval?.upgradePolicy === 'conservador-live-v7', 'merged_grants_v7: the row offers conservador-live-v7 to the v2 account')
  const moveGas = await renewAllSteps(`move v2 (${v2Grants} sessions) -> v7`)
  check(moveGas.length === 1, `the move took ONE owner transaction (${moveGas.join(' + ')} gas)`)
  const f1 = await funding()
  check(f1.approval?.policyId === 'conservador-live-v7' && !f1.approval?.missing && !f1.approval?.upgrade, 'the account runs v7 with nothing missing')
  const genV2 = await lab.client.readContract({ address: dep.v2 as Hex, abi: policyAbi, functionName: 'generationOf', args: [ctx.address] })
  check(genV2 === 1n, `V2 generation ${genV2}`)
  const r1 = await readSafe(lab.client, ctx.address, baseRegistry)
  for (const p of r1.positions) {
    const at = await lab.client.readContract({ address: dep.v2 as Hex, abi: policyAbi, functionName: 'admittedPool', args: [ctx.address, p.tokenId] })
    check(at.toLowerCase() === address(p.pool as never, baseRegistry).toLowerCase(), `position ${p.tokenId} admitted to ${p.pool} at V2`)
  }
  const grantsNow = (op.operator as unknown as { store: { state: { accounts: Record<string, { grants: { name: string }[] }> } } }).store.state.accounts[ctx.accountKey]!.grants.map((g) => g.name)
  check(grantsNow.length === 4 && grantsNow.filter((n) => n.startsWith('manage-any:pool:')).length === 3 && grantsNow.includes('bridge-out'), `v7 grants: ${grantsNow.join(', ')}`)

  // --- the engine works under the merged sessions -----------------------------------------------------
  const engineOps = async () => (await ops()).filter((o) => o.opId.startsWith('eng-'))
  const seenBefore = new Set((await engineOps()).map((o) => o.opId))
  const v7Ops = async () => (await engineOps()).filter((o) => !seenBefore.has(o.opId))
  await lab.whaleTransfer('USDC', WHALE, ctx.address, 10_000_000n)
  // v7 holds USDC/cbBTC at 0 % and WETH/USDC at 35 %: the engine winds the btc position down and enters another pool.
  await engineSettled('v7 engine ops', Date.now() + 1_200_000, async () => {
    const mine = (await v7Ops()).filter((o) => o.state === 'confirmed')
    const btcLeft = (await readSafe(lab.client, ctx.address, baseRegistry)).positions.some((p) => p.pool === 'pool:USDC/cbBTC/500' && p.liquidity > 0n)
    return !btcLeft && mine.some((o) => o.pool !== 'pool:USDC/cbBTC/500')
  })
  const after = await v7Ops()
  log(`engine ops under v7: ${after.map((o) => `${o.opId}:${o.kind}:${o.pool ?? ''}:${o.tokenIn ?? ''}->${o.tokenOut ?? ''}:${o.state}:${o.code ?? ''}`).join(', ')}`)
  check(after.some((o) => o.state === 'confirmed' && o.pool === 'pool:USDC/cbBTC/500'), 'v7: the engine acted on USDC/cbBTC through its exit-only session')
  check(after.some((o) => o.state === 'confirmed' && o.pool !== 'pool:USDC/cbBTC/500'), 'v7: the engine entered or managed a pool through its merged session')
  check(!after.some((o) => o.code === 'SESSION_MISSING'), 'v7: no op found its session missing (decide names the pool session)')

  // --- a v7 renewal: ONE owner transaction --------------------------------------------------------------
  const renewGas = await renewAllSteps('v7 renewal')
  check(renewGas.length === 1, `the v7 renewal took ONE owner transaction (${renewGas.join(' + ')} gas)`)
  const genV2b = await lab.client.readContract({ address: dep.v2 as Hex, abi: policyAbi, functionName: 'generationOf', args: [ctx.address] })
  check(genV2b === genV2 + 1n, `V2 generation ${genV2b} after the renewal`)

  const stop = await ownerAction('stop')
  gasReport.push(`stop: ${stop.gasUsed}`)
  const f3 = await funding()
  log(`positions after stop: ${JSON.stringify(f3.positions.map((p) => ({ tokenId: p.tokenId, pool: p.pool, liquidity: p.liquidity })))}`)
  check(!f3.active && f3.positions.every((p) => p.liquidity === '0'), `stop after v7: inactive, no liquidity left (${stop.op.txHash})`)
  check(enginePort.stats().rejectedLabMethods === 0, 'operator used no anvil_/evm_ methods')
  log(`gas:\n    ${gasReport.join('\n    ')}`)
  log('RESULT PASS')
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await cleanup()
}
process.exit(process.exitCode ?? 0)
