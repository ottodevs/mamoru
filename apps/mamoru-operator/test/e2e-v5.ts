// otto/mamoru#151, #171: the operator itself moves a running account to conservador-live-v5 on MamoruActionPolicyV2,
// on an anvil fork of Base (chain id 8453), through its owner-op machinery, and the split of every v4/v5 approval is
// fitted by SIMULATED gas under V4_TX_GAS_TARGET (fitV4 + fitPrefixBySimulation), not by the static per-action model:
//   activate (v2) -> the engine invests -> `onchain_action_policy_v4`: the move to v4 on V1, every step taken ->
//   `onchain_action_policy_v5`: the move to v5 on V2 (a new key, V1 generation + 1, every v4 grant revoked, V2
//   self-attested, the Safe's positions admitted), every step taken -> a v5 renewal, every step taken -> a deposit is
//   invested under v5 (an increase of a held, admitted position, or a mint) -> the guardian pauses: the engine waits
//   (POLICY_PAUSED) -> unpaused -> stop closes everything. Each owner transaction's receipt gas is reported.
// The policies are deployed on the local anvil the way script/Deploy.s.sol and script/DeployV2.s.sol do it.
//
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org, the public endpoint, never the operator's provider key),
// through the loopback proxy. Run: PATH="$HOME/.foundry/bin:$PATH" bun apps/mamoru-operator/test/e2e-v5.ts
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData, parseAbi, toHex, type Hex } from 'viem'
import type { AccountContext, FundingView, OpView, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, baseRegistry, mamoruActionPolicyV2Abi } from '@mamoru/registry'
import { V4_TX_GAS_TARGET } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startEnginePort, startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab, devAccount } from '../../../packages/scenarios/fixtures/lab.ts'
import { deployGasPolicy, deployMamoruPolicy, deployMamoruPolicyV2, loadPolicyArtifact, raiseObservationCardinality } from '../../../packages/scenarios/action-policy/v4-grant.ts'
import { WHALE } from '../../../packages/scenarios/fixtures/world.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { bootOperator } from '../src/boot.ts'
import { readSafe } from '../src/chain.ts'
import { DEFAULT_SPONSOR, SPONSOR_BOUNDS, type SponsorPolicy } from '../src/sponsorship.ts'

process.env.RPC_URL = process.env.BASE_FORK_RPC_URL ?? 'https://mainnet.base.org'
const DEPOSIT = 20_000_000n
const t0 = Date.now()
const log = (m: string) => console.log(`[e2e-v5 +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
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
const dir = mkdtempSync(join(tmpdir(), 'mamoru-operator-e2e-v5-'))
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
async function deployPolicies(): Promise<{ policy: string; gasPolicy: string; v2: string }> {
  const deployer = devAccount(9)
  const policy = await deployMamoruPolicy(lab, await loadPolicyArtifact(), deployer)
  const gasPolicy = await deployGasPolicy(lab, deployer)
  const v2 = await deployMamoruPolicyV2(lab, deployer, GUARDIAN.address)
  for (const pool of ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'] as const) await raiseObservationCardinality(lab, deployer, address(pool, baseRegistry), 1_800)
  return { policy, gasPolicy, v2 }
}

const GUARDIAN = devAccount(8)
/** Receipt gas of every owner transaction, by label. */
const gasReport: string[] = []

try {
  log(`fork of Base at block ${await lab.client.getBlockNumber()}, chain ${await lab.client.getChainId()}`)
  const dep = await deployPolicies()
  log(`deployed MamoruActionPolicy ${dep.policy}, MamoruGasPolicy ${dep.gasPolicy}, MamoruActionPolicyV2 ${dep.v2} (guardian ${GUARDIAN.address})`)

  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner')]
  const saltNonce = BigInt(Date.now())
  const ctx: AccountContext = {
    accountKey: `e2e-v5-${saltNonce}`,
    chainId: 8453,
    address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))),
    owners,
    saltNonce: saltNonce.toString(),
    passkey: { credentialId: 'e2e', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
  }
  await lab.whaleTransfer('USDC', WHALE, ctx.address, DEPOSIT)

  process.env.MAMORU_LIVE = '1'
  process.env.MAMORU_HEAD_LAG = '0'
  process.env.MAMORU_ONCHAIN_POLICY_V4 = '1'
  process.env.MAMORU_ACTION_POLICY_ADDRESS = dep.policy
  process.env.MAMORU_GAS_POLICY_ADDRESS = dep.gasPolicy
  process.env.MAMORU_ACTION_POLICY_V2_ADDRESS = dep.v2
  const secret = randomBytes(32).toString('hex')
  const op = await bootOperator({ rpcUrl: enginePort.url, secret, stateDir: join(dir, 'state'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100, policyId: 'conservador-live-v2' })
  stopOperator = op.stop
  check(op.operator.cfg.v4Policy?.policyId === 'conservador-live-v4', 'operator configured with conservador-live-v4 bound to both deployed policies')
  check(op.operator.cfg.v5Policy?.policyId === 'conservador-live-v5' && op.operator.cfg.v5Policy.actionPolicy?.address.toLowerCase() === dep.v2.toLowerCase() && op.operator.cfg.v5Policy.actionPolicy?.contractVersion === 2, 'operator configured with conservador-live-v5 on MamoruActionPolicyV2')
  await lab.setBalance(op.operator.relayer.address, 10n ** 18n)
  // anvil quotes ~1 gwei (Base: ~0.005), so the sponsorship budget would stop this run's ten owner transactions after a
  // few; renewAllSteps clears the account's sponsorship record before each step (this run measures the split, not
  // sponsorship), and the limits sit at the top of SPONSOR_BOUNDS.
  ;(op.operator.cfg as { sponsor?: SponsorPolicy }).sponsor = { ...DEFAULT_SPONSOR, weiPerDay: SPONSOR_BOUNDS.weiPerDay[1], perAccount: SPONSOR_BOUNDS.perAccount[1] }
  log(`anvil gas price ${await lab.client.getGasPrice()} wei`)

  const header = Buffer.from(JSON.stringify(ctx)).toString('base64url')
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const sig = createHmac('sha256', secret).update(`${method} ${path}\n${header}\n${raw}`).digest('hex')
    const res = await fetch(op.url + path, { method, headers: { 'x-mamoru-account': header, 'x-mamoru-sig': sig, 'content-type': 'application/json' }, body: method === 'POST' ? raw : undefined })
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

  // --- v2 activation, the engine invests --------------------------------------------------------
  await ownerAction('activate')
  await engineSettled('v2 allocation', Date.now() + 480_000, async () => (await readSafe(lab.client, ctx.address)).positions.length >= 2)
  const r0 = await readSafe(lab.client, ctx.address)
  const v2Positions = r0.positions.map((p) => p.tokenId)
  log(`v2 positions: ${r0.positions.map((p) => `${p.tokenId} ${p.pool}`).join(', ')}`)

  // --- the move to v4 on V1, as in production today ------------------------------------------------
  const flags: Record<string, boolean> = {}
  ;(op.operator.cfg as { opsFlags?: () => Record<string, boolean> }).opsFlags = () => flags
  flags.onchain_action_policy_v4 = true
  check((await funding()).approval?.upgradePolicy === 'conservador-live-v4', 'v4 flag: the row offers conservador-live-v4')
  const v4Gas = await renewAllSteps('move v2 -> v4 (V1)')
  const genV1 = await lab.client.readContract({ address: dep.policy as Hex, abi: policyAbi, functionName: 'generationOf', args: [ctx.address] })
  check(genV1 === 1n, `V1 generation ${genV1}`)

  // --- the move to v5 on V2 ---------------------------------------------------------------------------
  flags.onchain_action_policy_v5 = true
  check((await funding()).approval?.upgradePolicy === 'conservador-live-v5', 'v5 flag: the row offers conservador-live-v5 to the v4 account')
  const v5Gas = await renewAllSteps('move v4 -> v5 (V2)')
  log(`the move to v5 took ${v5Gas.length} owner transaction(s): ${v5Gas.join(' + ')}`)
  const genV2 = await lab.client.readContract({ address: dep.v2 as Hex, abi: policyAbi, functionName: 'generationOf', args: [ctx.address] })
  check(genV2 === genV1 + 1n, `V2 generation ${genV2} = V1 + 1`)
  const r1 = await readSafe(lab.client, ctx.address)
  for (const p of r1.positions) {
    const at = await lab.client.readContract({ address: dep.v2 as Hex, abi: policyAbi, functionName: 'admittedPool', args: [ctx.address, p.tokenId] })
    check(at.toLowerCase() === address(p.pool as never, baseRegistry).toLowerCase(), `position ${p.tokenId} admitted to ${p.pool} at V2`)
  }

  // --- a v5 renewal (nothing missing, no target: a full renewal at generation + 1) -------------------
  const renewGas = await renewAllSteps('v5 renewal (V2)')
  log(`the v5 renewal took ${renewGas.length} owner transaction(s): ${renewGas.join(' + ')}`)
  const genV2b = await lab.client.readContract({ address: dep.v2 as Hex, abi: policyAbi, functionName: 'generationOf', args: [ctx.address] })
  check(genV2b === genV2 + 1n, `V2 generation ${genV2b} after the renewal`)

  // --- the engine works under v5 -----------------------------------------------------------------------
  const engineOps = async () => (await ops()).filter((o) => o.opId.startsWith('eng-'))
  const before = (await engineOps()).filter((o) => o.state === 'confirmed').length
  await lab.whaleTransfer('USDC', WHALE, ctx.address, 10_000_000n)
  await engineSettled('v5 engine op', Date.now() + 300_000, async () => (await engineOps()).filter((o) => o.state === 'confirmed').length > before)
  const after = await engineOps()
  log(`engine ops under v5: ${after.slice(-6).map((o) => `${o.opId}:${o.kind}:${o.state}:${o.code ?? ''}`).join(', ')}`)
  check(after.filter((o) => o.state === 'confirmed').length > before, 'an engine op under the v5 grants confirmed')
  const increased = after.some((o) => o.opId.endsWith('increase_liquidity') && o.state === 'confirmed')
  log(`increase_liquidity under v5: ${increased ? 'confirmed' : 'not proposed in this run (the entry minted or swapped)'}`)

  // --- the guardian pauses: the engine waits ----------------------------------------------------------
  const runner = (op.operator as unknown as { runners: Map<string, { engine: { journal: { live?: unknown; ops: { kind: string; state: string; stateCode: string }[] } } }> }).runners.get(ctx.accountKey)
  for (const until = Date.now() + 300_000; runner?.engine.journal.live && Date.now() < until; ) await Bun.sleep(3_000)
  check(!runner?.engine.journal.live, 'the engine slot is free before the pause')
  const pause = await lab.send(GUARDIAN, dep.v2 as Hex, encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: 'pause', args: [ctx.address] }), 0n, 200_000n)
  check(pause.ok, `guardian paused the Safe (${pause.receipt.gasUsed} gas)`)
  const confirmedBefore = (await engineOps()).filter((o) => o.state === 'confirmed').length
  await lab.whaleTransfer('USDC', WHALE, ctx.address, 10_000_000n)
  // While paused nothing the engine does reaches the chain: an op it prepares is discarded with POLICY_PAUSED, and one
  // it had already signed when the pause landed is refused at validation (the bundler's handleOps check) and settles
  // as unincludable. Either way no engine op confirms.
  const seen = runner?.engine.journal.ops.length ?? 0
  const until = Date.now() + 900_000
  let refused: string[] = []
  while (Date.now() < until) {
    refused = (runner?.engine.journal.ops ?? []).slice(seen).map((o) => o.stateCode).filter((c) => c === 'POLICY_PAUSED' || c === 'BUNDLER_REJECTED' || c === 'RECON_UNINCLUDABLE')
    if (refused.includes('POLICY_PAUSED')) break
    await Bun.sleep(5_000)
  }
  log(`ops refused while paused: ${refused.join(', ') || 'none'}`)
  check(refused.includes('POLICY_PAUSED'), 'paused: the engine discards its op with POLICY_PAUSED instead of sending it')
  check((await engineOps()).filter((o) => o.state === 'confirmed').length === confirmedBefore, 'paused: no engine op confirmed')
  const unpause = await lab.send(GUARDIAN, dep.v2 as Hex, encodeFunctionData({ abi: mamoruActionPolicyV2Abi, functionName: 'unpause', args: [ctx.address] }), 0n, 200_000n)
  check(unpause.ok, 'guardian unpaused')
  // An op the bundler refused during the pause holds its kind and pool back for UNINCLUDABLE_BACKOFF_SECONDS (600 s).
  await engineSettled('engine after unpause', Date.now() + 900_000, async () => (await engineOps()).filter((o) => o.state === 'confirmed').length > confirmedBefore)
  check(true, 'unpaused: the engine invests again')

  const stop = await ownerAction('stop')
  const f3 = await funding()
  check(!f3.active && f3.positions.length === 0, `stop after v5: inactive, no positions (${stop.op.txHash})`)
  check(enginePort.stats().rejectedLabMethods === 0, 'operator used no anvil_/evm_ methods')
  log(`gas:\n    ${gasReport.join('\n    ')}`)
  log(`splits: v4 move ${v4Gas.length} tx, v5 move ${v5Gas.length} tx, v5 renewal ${renewGas.length} tx`)
  log('RESULT PASS')
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await cleanup()
}
process.exit(process.exitCode ?? 0)
