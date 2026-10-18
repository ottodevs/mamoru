// Spec 007 (otto/mamoru#151) T7 (c)/(d): the operator itself moves a running conservador-live-v2 account to the
// on-chain action policy, on an anvil fork of Base (chain id 8453), through its HTTP routes and owner-op machinery:
//   activate (v2) -> the engine invests -> the `onchain_action_policy_v4` flag offers the move (approval.upgrade) ->
//   renew/prepare + passkey: transaction 1 of 2 (revokes every v2 grant, self-attests both policies, enables the first
//   part at generation 1 with Init.admit = the account's positions) -> the row offers the rest (approval.missing) ->
//   renew/prepare + passkey: transaction 2 of 2 (the extension, same generation) -> a deposit is invested by the engine
//   under the v4 grants (swap + mint through MamoruActionPolicy) -> stop closes everything.
// The two policies are deployed on the local anvil the way contracts/action-policy/script/Deploy.s.sol does it.
//
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org, the public endpoint, never the operator's provider key),
// through the loopback proxy. Run: PATH="$HOME/.foundry/bin:$PATH" bun apps/mamoru-operator/test/e2e-v4.ts
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAbi, toHex, type Hex } from 'viem'
import type { AccountContext, FundingView, OpView, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startEnginePort, startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab, devAccount } from '../../../packages/scenarios/fixtures/lab.ts'
import { deployGasPolicy, deployMamoruPolicy, loadPolicyArtifact, raiseObservationCardinality } from '../../../packages/scenarios/action-policy/v4-grant.ts'
import { WHALE } from '../../../packages/scenarios/fixtures/world.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { bootOperator } from '../src/boot.ts'
import { readSafe } from '../src/chain.ts'
import { DEFAULT_SPONSOR, SPONSOR_BOUNDS, type SponsorPolicy } from '../src/sponsorship.ts'

process.env.RPC_URL = process.env.BASE_FORK_RPC_URL ?? 'https://mainnet.base.org'
const DEPOSIT = 20_000_000n
const t0 = Date.now()
const log = (m: string) => console.log(`[e2e-v4 +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`E2E FAILED: ${what}`)
  log(`ok  ${what}`)
}
const policyAbi = parseAbi(['function generationOf(address) view returns (uint64)', 'function admittedPool(address, uint256) view returns (address)'])

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
const dir = mkdtempSync(join(tmpdir(), 'mamoru-operator-e2e-v4-'))
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
async function deployPolicies(): Promise<{ policy: string; gasPolicy: string }> {
  const deployer = devAccount(9)
  const policy = await deployMamoruPolicy(lab, await loadPolicyArtifact(), deployer)
  const gasPolicy = await deployGasPolicy(lab, deployer)
  for (const pool of ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'] as const) await raiseObservationCardinality(lab, deployer, address(pool), 1_800)
  return { policy, gasPolicy }
}

try {
  log(`fork of Base at block ${await lab.client.getBlockNumber()}, chain ${await lab.client.getChainId()}`)
  const dep = await deployPolicies()
  log(`deployed MamoruActionPolicy ${dep.policy}, MamoruGasPolicy ${dep.gasPolicy}`)

  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner')]
  const saltNonce = BigInt(Date.now())
  const ctx: AccountContext = {
    accountKey: `e2e-v4-${saltNonce}`,
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
  const secret = randomBytes(32).toString('hex')
  const op = await bootOperator({ rpcUrl: enginePort.url, secret, stateDir: join(dir, 'state'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100, policyId: 'conservador-live-v2' })
  stopOperator = op.stop
  check(op.operator.cfg.v4Policy?.policyId === 'conservador-live-v4', 'operator configured with conservador-live-v4 bound to both deployed policies')
  await lab.setBalance(op.operator.relayer.address, 10n ** 18n)
  // anvil quotes a gas price ~100x Base's: two ~16.5M-gas renewals in a day pass the default 0.01 ETH sponsorship
  // budget there (on Base they cost about 2e-4 ETH each). Raised to the top of SPONSOR_BOUNDS for this run only.
  ;(op.operator.cfg as { sponsor?: SponsorPolicy }).sponsor = { ...DEFAULT_SPONSOR, weiPerDay: SPONSOR_BOUNDS.weiPerDay[1] }
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
  async function ownerAction(kind: 'activate' | 'stop' | 'renew'): Promise<{ op: OpView; summary: string[] }> {
    // Prepared and submitted on the operator object (the same calls the routes make): on a cold fork a prepare's
    // simulations read every slot through the public RPC and can outlast the server's 120 s idle timeout.
    const o = op.operator
    const t = await (kind === 'activate' ? o.prepareActivate(ctx) : kind === 'stop' ? o.prepareStop(ctx) : o.prepareRenew(ctx))
    const prep = { status: 200, json: t }
    log(`${kind} to sign:\n    ${prep.json.summary.join('\n    ')}`)
    const res = await o.submit(ctx, kind, browserSign(prep.json))
    return { op: await waitOp(res.opId, `owner ${kind}`, 600_000), summary: prep.json.summary }
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

  // --- the move to v4 is offered only with the flag on ---------------------------------------------
  check(!(await funding()).approval?.upgrade, 'flag off: no upgrade offered')
  ;(op.operator.cfg as { opsFlags?: () => Record<string, boolean> }).opsFlags = () => ({ onchain_action_policy_v4: true })
  check((await funding()).approval?.upgrade === true, 'flag on: approval.upgrade offered on the renew row')

  const step1 = await ownerAction('renew')
  check(step1.summary.some((l) => l.includes('only near the market price')) && step1.summary.some((l) => l.includes('network fee')) && step1.summary.some((l) => l.includes('2 steps')), 'step 1 summary names bands, budgets, gas caps and the 2 steps')
  const f1 = await funding()
  check(!f1.approval?.upgrade && (f1.approval?.missing ?? 0) > 0, `after step 1: account on v4, ${f1.approval?.missing} grants offered as the next step`)
  const gen = await lab.client.readContract({ address: dep.policy as Hex, abi: policyAbi, functionName: 'generationOf', args: [ctx.address] })
  check(gen === 1n, `generation ${gen} on chain`)
  for (const id of v2Positions) {
    const at = await lab.client.readContract({ address: dep.policy as Hex, abi: policyAbi, functionName: 'admittedPool', args: [ctx.address, id] })
    const pool = r0.positions.find((p) => p.tokenId === id)!.pool
    log(`position ${id} (${pool}) admitted to ${at}`)
  }
  // Step 1 carries the stables sessions and the btc entries (orderV4Keys/splitV4Keys): those pools' positions are
  // admitted now; the risk pool's sessions, and its Init.admit, come with step 2.
  const step1Pools = new Set(['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500'])
  for (const p of r0.positions.filter((x) => step1Pools.has(x.pool))) {
    const at = await lab.client.readContract({ address: dep.policy as Hex, abi: policyAbi, functionName: 'admittedPool', args: [ctx.address, p.tokenId] })
    check(at.toLowerCase() === address(p.pool as never).toLowerCase(), `step 1 admitted ${p.tokenId} to ${p.pool}`)
  }
  await ownerAction('renew')
  const f2 = await funding()
  check(!f2.approval?.missing && !f2.approval?.upgrade, 'after step 2: the full v4 set, nothing missing')
  const admitted2 = await Promise.all(v2Positions.map((id) => lab.client.readContract({ address: dep.policy as Hex, abi: policyAbi, functionName: 'admittedPool', args: [ctx.address, id] })))
  check(admitted2.every((a, i) => a.toLowerCase() === address(r0.positions.find((p) => p.tokenId === v2Positions[i])!.pool as never).toLowerCase()), 'every v2 position admitted to its own pool after both steps')

  // --- the engine works under v4: a new deposit is invested through the policy ---------------------
  const before = (await ops()).filter((o) => o.opId.startsWith('eng-') && o.state === 'confirmed').length
  await lab.whaleTransfer('USDC', WHALE, ctx.address, 10_000_000n)
  await engineSettled('v4 engine op', Date.now() + 300_000, async () => (await ops()).filter((o) => o.opId.startsWith('eng-') && o.state === 'confirmed').length > before)
  const after = (await ops()).filter((o) => o.opId.startsWith('eng-'))
  log(`engine ops after the move: ${after.slice(-6).map((o) => `${o.opId}:${o.kind}:${o.state}:${o.code ?? ''}`).join(', ')}`)
  check(after.filter((o) => o.state === 'confirmed').length > before, 'an engine op under the v4 grants confirmed')

  const stop = await ownerAction('stop')
  const f3 = await funding()
  check(!f3.active && f3.positions.length === 0, `stop after v4: inactive, no positions (${stop.op.txHash})`)
  check(enginePort.stats().rejectedLabMethods === 0, 'operator used no anvil_/evm_ methods')
  log('RESULT PASS')
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await cleanup()
}
process.exit(process.exitCode ?? 0)
