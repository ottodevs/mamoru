// otto/mamoru#251, acceptance: the whole design C path on two forks (Base 8453 and Monad 143, both at their latest block,
// chain ids kept), with the real Worker routes (in memory D1), the real Base operator and the real Monad operator, both
// booted here with their production env shape:
//   1. a Base account shaped like the beta one: v2 activated, the engine invests, then the move to v5 (MamoruActionPolicyV2,
//      the deployed one on Base), every step taken, as it happened on 29 Oct;
//   2. V3 and MamoruPauseGate(V3) deployed on the Base fork exactly as the coordinator will (DeployV3.s.sol `run` and
//      DeployPauseGate.s.sol from the pinned deployer, impersonated), then pinned in the Base registry in memory (what
//      the base.json pin PR does);
//   3. `multichain_v6` scoped to the account: the renew row offers v6. The owner signs ONCE (counted) through the Worker's
//      renew/prepare + renew; the Worker checks the remote Safe of the prepare (verifyRemote). One Base Safe transaction.
//   4. the Base operator got the remote key from the Monad operator (remote-key), fixed the remote Safe, then asked for
//      its provisioning: the Monad operator deploys it with its relayer, no owner signature, checks it and tops up gas;
//   5. the Base engine bridges to that Safe (CCTP depositForBurn, mintRecipient = the remote Safe); a bridge-out userOp
//      to another recipient is refused at validation;
//   6. Circle is played on the fork: Iris answers with the burn's message, signed by a fork attester enabled on Monad;
//      the Base operator's MonadBridge mints on Monad; the USDC lands on the remote Safe;
//   7. the Monad engine swaps and mints WMON/USDC through its V3 sessions; the position is the remote Safe's;
//   8. the Worker's funding read stores the owner's Monad row (upsertRemoteSleeve);
//   9. MON spent on Monad by each relayer (the Monad operator's: deploy + top-up; the Base operator's: mints), gas per step.
//
// Run (builds the contracts first; forge is needed for the deploy scripts):
//   nix shell nixpkgs#foundry --command bash -c 'export PATH=$HOME/.foundry/bin:$PATH;
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun apps/mamoru-operator/test/e2e-two-chain.ts'
// Upstreams: BASE_FORK_RPC_URL (default https://mainnet.base.org), MONAD_RPC_URL (default https://rpc.monad.xyz), public,
// through loopback proxies. Nothing is broadcast anywhere but the two local anvils.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, decodeErrorResult, encodeFunctionData, keccak256, numberToHex, pad, parseAbi, parseEventLogs, sliceHex, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address, FundingView, OpView, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, baseRegistry, entryPointV07Abi, erc20Abi, messageTransmitterV2Abi, monadRegistry, nonfungiblePositionManagerAbi, readCodeHash, safeAbi, tokenMessengerV2Abi } from '@mamoru/registry'
import { V4_GAS_CAPS } from '@mamoru/policy'
import { P256_N } from '@mamoru/account/live'
import { remoteAccountKey } from '@mamoru/account/remote'
import { draftUserOp, executeCallData, handleOpsData, sessionKeySignature, sessionNonceKey, useModeSignature, userOpHash } from '@mamoru/account/sessions'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startEnginePort, startForkProxy, type EnginePort, type ForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { WHALE } from '../../../packages/scenarios/fixtures/world.ts'
import { engineGas } from '../../../packages/scenarios/driver/engine.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { harness, ORIGIN, register, sessionCookie } from '../../mamoru-app/test/api/helpers.ts'
import { accountContext } from '../../mamoru-app/src/api/accounts/operator.ts'
import type { AccountRow } from '../../mamoru-app/src/api/accounts/store.ts'
import { verifyRemote, type RemoteOffer } from '../../mamoru-app/src/api/remote.ts'
import { bootOperator } from '../src/boot.ts'
import { MESSAGE_TRANSMITTER_V2 } from '../src/cctp.ts'
import { operatorSignature } from '../src/server.ts'
import { DEFAULT_SPONSOR, SPONSOR_BOUNDS, type SponsorPolicy } from '../src/sponsorship.ts'

const REPO = join(import.meta.dir, '../../..')
/** The beta account's balance (USDC equivalent) on 31 Oct. */
const DEPOSIT = 13_690_000n
/** DeployV3.s.sol / DeployPauseGate.s.sol pins: deployer (the Base relayer), guardian, and the predicted addresses. */
const PINNED_DEPLOYER: Address = '0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0'
const PINNED_GUARDIAN: Address = '0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD'
const V3_BASE: Address = '0xDD2E387B748420C6501EC96Ec48F87cDEdf16749'
const GATE_V3_BASE: Address = '0xf939c0FF7F095BA2ED7DDaaCD2D75da9A8cdF4e7'
/** Live Base operator env (~/.config/mamoru-operator/env, addresses only). */
const V1_BASE: Address = '0x0083A9ca619f22A4f29704F97981dfFe8CD35215'
const GAS_POLICY_BASE: Address = '0x9EB9a72c5e7231374eD65f5a1fF3e38a39798866'
const V2_BASE: Address = '0x9ef35e544C93A6722a13473AB9EF115f719bbE6B'
/** On-chain balances on 1 Nov 2026 of the two relayers on Monad: the Monad operator's and the Base one's (which mints). */
const MONAD_RELAYER_MON = 104_106_640_345_000_000_000n
const BASE_RELAYER_MON = 2_214_424_764_000_000_000n
const CCTP_DOMAIN_MONAD = 15

const t0 = Date.now()
const log = (m: string) => console.log(`[e2e-two-chain +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
type Step = { step: string; ok: boolean; detail: string }
const steps: Step[] = []
const gasReport: string[] = []
function check(ok: boolean, step: string, detail = ''): void {
  steps.push({ step, ok, detail })
  if (!ok) throw new Error(`E2E FAILED: ${step}${detail ? `: ${detail}` : ''}`)
  log(`ok  ${step}${detail ? ` (${detail})` : ''}`)
}

// --- two forks --------------------------------------------------------------------------------------------------------
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
if (!process.env.MONAD_RPC_URL) process.env.MONAD_RPC_URL = 'https://rpc.monad.xyz'
const anvilBin = Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const dir = mkdtempSync(join(tmpdir(), 'mamoru-e2e-two-chain-'))
type Fork = { lab: Lab; proxy: ForkProxy; anvil: ReturnType<typeof Bun.spawn>; port: EnginePort; url: string }
async function startFork(envVar: string, chainId: number, name: string): Promise<Fork> {
  const proxy = startForkProxy(envVar)
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const p = probe.port as number
  probe.stop(true)
  const argv = ['--fork-url', proxy.url, '--no-rate-limit', '--timeout', '120000', '--fork-retry-backoff', '2000', '--retries', '10', '--chain-id', String(chainId), '--host', '127.0.0.1', '--port', String(p), '--slots-in-an-epoch', '1', '--block-time', '1', '--no-request-size-limit']
  assertNoKeyInArgv(argv, [envVar])
  const anvil = Bun.spawn([anvilBin, ...argv], { stdout: Bun.file(join(dir, `anvil-${name}.log`)), stderr: Bun.file(join(dir, `anvil-${name}.log`)), env: sanitizedEnv() })
  const url = `http://127.0.0.1:${p}/`
  const lab = new Lab(url, chainId, chainId === 143 ? monadRegistry : baseRegistry)
  for (let i = 0; ; i++) {
    try {
      await lab.client.getBlockNumber()
      break
    } catch {
      if (i > 300) throw new Error(`anvil ${name} did not start`)
      await Bun.sleep(200)
    }
  }
  return { lab, proxy, anvil, port: startEnginePort(url), url }
}

const stops: (() => void | Promise<void>)[] = []
let exitCode = 1
const realFetch = globalThis.fetch
try {
  const [B, M] = await Promise.all([startFork('BASE_FORK_RPC_URL', 8453, 'base'), startFork('MONAD_RPC_URL', 143, 'monad')])
  stops.push(async () => {
    for (const f of [B, M]) {
      f.port.stop()
      f.anvil.kill()
      await f.anvil.exited
      f.proxy.stop()
    }
  })
  const base = B.lab
  const monad = M.lab
  const baseStart = await base.client.getBlockNumber()
  const monadStart = await monad.client.getBlockNumber()
  log(`Base fork at ${baseStart} (gas price ${await base.client.getGasPrice()}), Monad fork at ${monadStart} (gas price ${await monad.client.getGasPrice()})`)

  // --- 2a. V3 and its pause gate on the Base fork, as the coordinator deploys them -----------------------------------
  async function forge(script: string, env: Record<string, string>): Promise<string> {
    const forgeBin = Bun.which('forge') ?? join(homedir(), '.foundry/bin/forge')
    const r = Bun.spawn([forgeBin, 'script', script, '--rpc-url', B.url, '--broadcast', '--unlocked', '--sender', PINNED_DEPLOYER, '--slow', '--skip-simulation', '--rpc-timeout', '900', '--timeout', '900'], {
      cwd: join(REPO, 'contracts/action-policy'),
      env: { ...sanitizedEnv(), PATH: process.env.PATH ?? '', HOME: homedir(), ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited])
    if (code !== 0) throw new Error(`forge script ${script} failed (${code}):\n${`${out}\n${err}`.slice(-3000)}`)
    return out
  }
  await base.rpc('anvil_impersonateAccount', [PINNED_DEPLOYER])
  const deployerBefore = await base.client.getBalance({ address: PINNED_DEPLOYER })
  const deployerNonce0 = await base.client.getTransactionCount({ address: PINNED_DEPLOYER })
  const outV3 = await forge('script/DeployV3.s.sol', { GUARDIAN: PINNED_GUARDIAN })
  const outGate = await forge('script/DeployPauseGate.s.sol', {})
  await base.rpc('anvil_stopImpersonatingAccount', [PINNED_DEPLOYER])
  const deployerAfter = await base.client.getBalance({ address: PINNED_DEPLOYER })
  const v3Printed = /MamoruActionPolicyV3:\s*(0x[0-9a-fA-F]{40})/.exec(outV3)?.[1]
  const gatePrinted = /MamoruPauseGate:\s*(0x[0-9a-fA-F]{40})/.exec(outGate)?.[1]
  check(v3Printed?.toLowerCase() === V3_BASE.toLowerCase() && gatePrinted?.toLowerCase() === GATE_V3_BASE.toLowerCase(), 'Base fork: DeployV3.s.sol and DeployPauseGate.s.sol from the pinned deployer give the pinned addresses', `V3 ${v3Printed}, gate ${gatePrinted}`)
  gasReport.push(`Base deploys (V3 + ring raises + gate): ${await base.client.getTransactionCount({ address: PINNED_DEPLOYER }) - deployerNonce0} tx, ${deployerBefore - deployerAfter} wei ETH at the fork's gas price`)
  // What the base.json pin PR does: V3 and the V3-bound gate in the Base registry (the V2-bound gate entry replaced).
  {
    const pins = [
      { name: 'MamoruActionPolicyV3', address: V3_BASE },
      { name: 'MamoruPauseGate', address: GATE_V3_BASE },
    ]
    const entries = baseRegistry.entries as unknown as { name: string }[]
    for (const p of pins) {
      const i = entries.findIndex((e) => e.name === p.name)
      if (i >= 0) entries.splice(i, 1)
      entries.push({ name: p.name, kind: 'smart-sessions-policy', role: 'e2e-two-chain pin', address: p.address, codeHash: await readCodeHash(base.client, p.address) } as never)
    }
  }

  // --- 6a. Circle, played on the forks: an attester enabled on Monad, Iris answering from the Base fork's receipts -----
  const attester = privateKeyToAccount(generatePrivateKey())
  const attestableAbi = parseAbi(['function attesterManager() view returns (address)', 'function enableAttester(address newAttester)', 'function setSignatureThreshold(uint256 newSignatureThreshold)'])
  {
    const manager = await monad.client.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: attestableAbi, functionName: 'attesterManager' })
    await monad.setBalance(manager, 10n ** 18n)
    const en = await monad.sendAs(manager, MESSAGE_TRANSMITTER_V2, encodeFunctionData({ abi: attestableAbi, functionName: 'enableAttester', args: [attester.address] }))
    const th = await monad.sendAs(manager, MESSAGE_TRANSMITTER_V2, encodeFunctionData({ abi: attestableAbi, functionName: 'setSignatureThreshold', args: [1n] }))
    check(en.ok && th.ok, 'Monad fork: a fork attester enabled in MessageTransmitterV2, threshold 1')
  }
  const irisCalls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const m = /^https:\/\/iris-api\.circle\.com\/v2\/messages\/6\?transactionHash=(0x[0-9a-fA-F]{64})$/.exec(url)
    if (!m) return realFetch(input as never, init)
    irisCalls.push(m[1]!)
    const r = await base.client.getTransactionReceipt({ hash: m[1] as Hex }).catch(() => null)
    const sent = r ? parseEventLogs({ abi: messageTransmitterV2Abi, eventName: 'MessageSent', logs: r.logs }) : []
    // Circle's part: the nonce (from the message hash, stable across polls) and the finality it was attested at.
    const messages = await Promise.all(
      sent.map(async (s) => {
        const raw = s.args.message
        const nonce = `0x${createHash('sha256').update(raw.slice(2), 'hex').digest('hex')}` as Hex
        const message = concat([sliceHex(raw, 0, 12), nonce, sliceHex(raw, 44, 144), numberToHex(2000, { size: 4 }), sliceHex(raw, 148)])
        return { status: 'complete', message, attestation: await attester.sign({ hash: keccak256(message) }) }
      }),
    )
    return new Response(JSON.stringify({ messages }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  // --- the Worker (in memory D1) and the owner's account, as onboarding creates it ------------------------------------
  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const secret = randomBytes(32).toString('hex')
  let baseOpUrl = ''
  const OPERATOR_URL = 'https://operator.test'
  const h = harness(() => new Date(), {
    env: { LIVE_FUNDS: '1', OPERATOR_URL, OPERATOR_SECRET: secret },
    operatorFetch: (url: string, init: RequestInit) => realFetch(url.replace(OPERATOR_URL, baseOpUrl), init),
  })
  const reg = await register(h, { credentialId: 'ZTJlLXR3by1jaGFpbg', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) })
  check(reg.status === 200 || reg.status === 201, 'Worker: onboarding registers the passkey owner', String(reg.status))
  const cookie = sessionCookie(reg)
  const { accountKey } = (await reg.json()) as { accountKey: string }
  const row = h.db.raw.query('SELECT * FROM accounts WHERE account_key = ?').get(accountKey) as AccountRow
  const ctx: AccountContext = accountContext(row)
  check(ctx.chainId === 8453, 'Worker: the Base account row', `${ctx.accountKey} Safe ${ctx.address}`)
  async function worker<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const headers: Record<string, string> = { cookie }
    if (method === 'POST') Object.assign(headers, { origin: ORIGIN, 'content-type': 'application/json' })
    const res = await h.app.request(`${ORIGIN}/api/accounts/${accountKey}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, h.env)
    return { status: res.status, json: (await res.json()) as T }
  }
  await base.whaleTransfer('USDC', WHALE, ctx.address, DEPOSIT)

  // --- the Monad operator: live-wmon-usdc-monad-v6, chain writes on 143 (its production env after #251) -------------------
  for (const k of ['MAMORU_ONCHAIN_POLICY_V4', 'MAMORU_ACTION_POLICY_ADDRESS', 'MAMORU_GAS_POLICY_ADDRESS', 'MAMORU_ACTION_POLICY_V2_ADDRESS', 'MAMORU_PAUSE_GATE_ADDRESS', 'MAMORU_SOURCE_CHAIN_ID']) delete process.env[k]
  Object.assign(process.env, { MAMORU_LIVE: '1', MAMORU_CHAIN_WRITES: '143', MAMORU_HEAD_LAG: '0' })
  const monadOp = await bootOperator({ rpcUrl: M.port.url, secret, stateDir: join(dir, 'state-monad'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100, policyId: 'live-wmon-usdc-monad-v6' })
  stops.unshift(() => monadOp.stop())
  check(monadOp.operator.cfg.chainId === 143 && monadOp.operator.cfg.policy.policyId === 'live-wmon-usdc-monad-v6', 'Monad operator: live on 143 with live-wmon-usdc-monad-v6')
  const monadRelayer = monadOp.operator.relayer.address
  await monad.setBalance(monadRelayer, MONAD_RELAYER_MON)

  // --- the Base operator: conservador-live-v2 default, V1/V2/gas from its live env, the bridge leg and the Monad peer ----
  delete process.env.MAMORU_CHAIN_WRITES
  Object.assign(process.env, { MAMORU_LIVE: '1', MAMORU_HEAD_LAG: '0', MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: V1_BASE, MAMORU_GAS_POLICY_ADDRESS: GAS_POLICY_BASE, MAMORU_ACTION_POLICY_V2_ADDRESS: V2_BASE })
  const baseOp = await bootOperator({ rpcUrl: B.port.url, monadRpcUrl: M.port.url, secret, stateDir: join(dir, 'state-base'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100, peerOperators: `143=${monadOp.url}` })
  stops.unshift(() => baseOp.stop())
  baseOpUrl = baseOp.url
  const bo = baseOp.operator
  check(bo.cfg.v6Policy?.policyId === 'conservador-live-v6' && bo.cfg.v6Policy.actionPolicy?.address.toLowerCase() === V3_BASE.toLowerCase() && bo.cfg.v6Policy.actionPolicy?.pauseGate?.toLowerCase() === GATE_V3_BASE.toLowerCase(), 'Base operator: v6 wired to V3 and the V3 gate from the registry', `${bo.cfg.v6Policy?.policyId}`)
  check(!!bo.cfg.remotePeers?.[143] && !!bo.cfg.bridgeMonad, 'Base operator: the Monad peer and the bridge leg are on')
  await base.setBalance(bo.relayer.address, 10n ** 18n)
  await monad.setBalance(bo.relayer.address, BASE_RELAYER_MON)
  ;(bo.cfg as { sponsor?: SponsorPolicy }).sponsor = { ...DEFAULT_SPONSOR, weiPerDay: SPONSOR_BOUNDS.weiPerDay[1], perAccount: SPONSOR_BOUNDS.perAccount[1] }
  const flags: Record<string, boolean> = {}
  const scoped: Record<string, string[] | null> = {}
  ;(bo.cfg as { opsFlags?: () => Record<string, boolean> }).opsFlags = () => flags
  ;(bo.cfg as { opsScopedFlags?: () => Record<string, string[] | null> }).opsScopedFlags = () => scoped

  // --- operator calls (signed like the Worker's) and the owner's passkey -----------------------------------------------
  async function opCall<T>(url: string, c: AccountContext, method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; json: T }> {
    const path = `/api/accounts/${encodeURIComponent(c.accountKey)}${route}`
    const header = Buffer.from(JSON.stringify(c)).toString('base64url')
    const raw = body === undefined ? '' : JSON.stringify(body)
    const ts = Math.floor(Date.now() / 1000).toString()
    const res = await realFetch(url + path, { method, headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts, 'x-mamoru-sig': operatorSignature(secret, method, path, header, raw, ts), 'content-type': 'application/json' }, body: method === 'POST' ? raw : undefined })
    return { status: res.status, json: (await res.json()) as T }
  }
  const funding = async () => (await opCall<FundingView>(baseOp.url, ctx, 'GET', '/funding')).json
  const baseOps = async () => (await opCall<{ ops: OpView[] }>(baseOp.url, ctx, 'GET', '/ops')).json.ops
  let ownerSignatures = 0
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
  function ownerSign(t: OwnerTxToSign): OwnerSignature {
    ownerSignatures++
    const a = passkey.assert(t.safeTxHash)
    const s = randomBytes(1)[0]! & 1 ? P256_N - a.s : a.s
    return { prepareId: t.prepareId, authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'), clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'), signature: Buffer.from(der(a.r, s)).toString('base64url') }
  }
  async function waitOp(opId: string, what: string, timeoutMs = 600_000): Promise<OpView> {
    for (const until = Date.now() + timeoutMs; ; ) {
      const o = (await baseOps()).find((x) => x.opId === opId)
      if (o && (o.state === 'confirmed' || o.state === 'failed')) {
        check(o.state === 'confirmed', `${what} confirmed`, `${o.txHash} block ${o.block}${o.code ? ` ${o.code}` : ''}`)
        return o
      }
      if (Date.now() > until) throw new Error(`E2E FAILED: ${what} still ${o?.state}`)
      await Bun.sleep(1_000)
    }
  }
  /** Setup steps (before the step under test): prepared and submitted on the operator object, as e2e-v5 does. */
  async function ownerDirect(kind: 'activate' | 'renew', label: string): Promise<bigint> {
    const acc = (bo as unknown as { store: { state: { accounts: Record<string, { sponsored?: unknown[] }> } } }).store.state.accounts[ctx.accountKey]
    if (acc) acc.sponsored = []
    const t = await (kind === 'activate' ? bo.prepareActivate(ctx) : bo.prepareRenew(ctx))
    const done = await waitOp((await bo.submit(ctx, kind, ownerSign(t))).opId, `${label}`)
    const gas = (await base.client.getTransactionReceipt({ hash: done.txHash as Hex })).gasUsed
    gasReport.push(`${label}: ${gas}`)
    return gas
  }
  async function until(label: string, ms: number, done: () => Promise<boolean>, every = 3_000): Promise<void> {
    for (const end = Date.now() + ms; ; ) {
      if (await done()) return
      if (Date.now() > end) throw new Error(`E2E FAILED: ${label}`)
      await Bun.sleep(every)
    }
  }
  const engineBusy = async () => (await baseOps()).some((o) => o.opId.startsWith('eng-') && (o.state === 'submitted' || o.state === 'proposed'))

  // --- 1. the account as the beta one: v2, invested, moved to v5 (every step taken) ---------------------------------
  await ownerDirect('activate', 'v2 activation')
  await until('the v2 engine invests', 600_000, async () => !(await engineBusy()) && (await funding()).positions.length >= 1)
  log(`v2 positions: ${(await funding()).positions.map((p) => `${p.tokenId} ${p.pool}`).join(', ')}`)
  flags.onchain_action_policy_v5 = true
  check((await funding()).approval?.upgradePolicy === 'conservador-live-v5', 'the renew row offers v5 (the beta account\'s 29 Oct move)')
  const v5Txs: bigint[] = []
  for (let i = 0; i < 6; i++) {
    v5Txs.push(await ownerDirect('renew', `move v2 -> v5 tx ${i + 1}`))
    const f = await funding()
    if (!f.approval?.missing && !f.approval?.upgrade) break
  }
  const accState = () => (bo as unknown as { store: { state: { accounts: Record<string, { policyId?: string; remote?: { address: Address; ready?: boolean; chainId: number }; sessionKey?: Hex; grants?: { name: string; grant: unknown; permissionId: Hex }[] }> } } }).store.state.accounts[ctx.accountKey]!
  check(accState().policyId === 'conservador-live-v5', 'the account runs conservador-live-v5', `${v5Txs.length} owner tx`)
  await until('engine idle on v5', 300_000, async () => !(await engineBusy()))
  const v5Positions = (await funding()).positions
  log(`v5 positions: ${v5Positions.map((p) => `${p.tokenId} ${p.pool} ${p.valueUsdc}`).join(', ')}; idle USDC ${(await funding()).usdc}`)

  // --- 3. the step under test: v6 in one approval, through the Worker -------------------------------------------------
  scoped.multichain_v6 = [ctx.accountKey.toLowerCase()]
  flags.multichain_v6 = true
  const offered = await funding()
  check(offered.approval?.upgradePolicy === 'conservador-live-v6', 'multichain_v6 scoped to the account: the renew row offers v6', `${offered.approval?.upgradePolicy}`)
  const signaturesBefore = ownerSignatures
  const safeNonce0 = await base.client.readContract({ address: ctx.address, abi: safeAbi, functionName: 'nonce' })
  // Warm the cold fork: the same prepare on the operator object (never signed), so the Worker's 90 s timeout is not the
  // fork's slot reads through the public RPC.
  await bo.prepareRenew(ctx)
  ;((bo as unknown as { store: { state: { accounts: Record<string, { sponsored?: unknown[] }> } } }).store.state.accounts[ctx.accountKey]!).sponsored = []
  const prep = await worker<OwnerTxToSign & { remote?: RemoteOffer }>('POST', '/renew/prepare', {})
  check(prep.status === 200 && !!prep.json.remote, 'Worker renew/prepare: 200 with the remote Safe offer', `${prep.status} ${JSON.stringify(prep.json).slice(0, 160)}`)
  const offer = prep.json.remote!
  log(`v6 approval summary:\n    ${prep.json.summary.join('\n    ')}`)
  verifyRemote(ctx, offer)
  check(offer.chainId === 143 && offer.spec.policyId === 'live-wmon-usdc-monad-v6', 'the offer is the Safe the owner\'s keys give on Monad (verifyRemote)', offer.address)
  const remoteKeyGiven = (monadOp.operator as unknown as { store: { state: { remoteKeys?: Record<string, Hex> } } }).store.state.remoteKeys?.[ctx.accountKey]
  check(!!remoteKeyGiven && privateKeyToAccount(remoteKeyGiven).address.toLowerCase() === offer.spec.sessionKey.toLowerCase(), 'the remote session key came from the Monad operator (POST remote-key)', offer.spec.sessionKey)
  check((await monad.client.getCode({ address: offer.address })) === undefined, 'the remote Safe has no code before the owner signs')
  const sub = await worker<OpView>('POST', '/renew', ownerSign(prep.json))
  check(sub.status === 200, 'Worker renew: submitted', `${sub.status}`)
  const migrated = await waitOp(sub.json.opId, 'the v5 -> v6 owner transaction')
  const migrationGas = (await base.client.getTransactionReceipt({ hash: migrated.txHash as Hex })).gasUsed
  gasReport.push(`move v5 -> v6 (one tx): ${migrationGas}`)
  const after = await funding()
  check(!after.approval?.missing && !after.approval?.upgrade && accState().policyId === 'conservador-live-v6', 'the account runs conservador-live-v6, nothing missing', `gas ${migrationGas}`)
  const safeNonce1 = await base.client.readContract({ address: ctx.address, abi: safeAbi, functionName: 'nonce' })
  check(ownerSignatures - signaturesBefore === 1 && safeNonce1 === safeNonce0 + 1n, 'ONE owner signature and ONE Base Safe transaction for the move', `${ownerSignatures - signaturesBefore} signature(s), Safe nonce ${safeNonce0} -> ${safeNonce1}`)

  // --- 4. the remote Safe: deployed by the Monad operator, checked, funded for gas, running ---------------------------
  const remote = offer.address
  const remoteCtx = (): AccountContext => ({ accountKey: remoteAccountKey(ctx.accountKey, 143), chainId: 143, address: remote, owners: ctx.owners, saltNonce: ctx.saltNonce, passkey: ctx.passkey, remote: offer.spec })
  await until('the remote Safe is provisioned (funding.remote.ready)', 300_000, async () => (await funding()).remote?.ready === true)
  check(accState().remote?.address.toLowerCase() === remote.toLowerCase(), 'the Base account fixed the remote Safe the owner signed for (recordRemote)')
  const remoteCode = await monad.client.getCode({ address: remote })
  const owners = await monad.client.readContract({ address: remote, abi: safeAbi, functionName: 'getOwners' })
  const remoteNonce = await monad.client.readContract({ address: remote, abi: safeAbi, functionName: 'nonce' })
  check(!!remoteCode && owners.length === ctx.owners.length && remoteNonce === 0n, 'Monad: the remote Safe exists, the owner\'s owners, no owner transaction on it', `owners ${owners.join(',')}, Safe nonce ${remoteNonce}`)
  check(ownerSignatures - signaturesBefore === 1, 'still one owner signature after the provisioning')
  const monadAcc = (monadOp.operator as unknown as { store: { state: { accounts: Record<string, { active?: boolean; grants?: { permissionId: Hex }[] }> } } }).store.state.accounts[remoteCtx().accountKey]
  const committed = (accState().remote as { permissionIds?: Hex[] } | undefined)?.permissionIds ?? []
  check(monadAcc?.active === true && committed.length > 0 && (monadAcc.grants ?? []).map((g) => g.permissionId.toLowerCase()).join() === committed.map((x) => x.toLowerCase()).join(), 'Monad operator runs the remote account with every committed session', `${monadAcc?.grants?.length} session(s)`)
  const reserve = await monad.client.getBalance({ address: remote })
  check(reserve >= monadOp.operator.cfg.policy.gasReserveWei, 'the remote Safe holds its MON gas reserve', `${reserve} wei`)

  // --- 8. the Worker stores the owner's Monad row from the funding read ------------------------------------------------
  const wf = await worker<FundingView>('GET', '/funding')
  const sleeve = h.db.raw.query('SELECT * FROM accounts WHERE chain_id = 143').all() as AccountRow[]
  check(wf.status === 200 && sleeve.length === 1 && sleeve[0]!.address.toLowerCase() === remote.toLowerCase() && sleeve[0]!.account_key === remoteAccountKey(ctx.accountKey, 143), 'Worker funding read: the owner\'s Monad row stored (upsertRemoteSleeve)', sleeve[0]?.account_key)

  // --- 5. the Base engine bridges to the remote Safe ---------------------------------------------------------------------
  const isBridge = (o: OpView) => o.opId.includes('bridge_out')
  let lastWait = 0
  await until('a bridge_out confirmed on Base', 1_500_000, async () => {
    const ops = await baseOps()
    if (ops.some((o) => isBridge(o) && o.state === 'confirmed')) return true
    const failed = ops.find((o) => isBridge(o) && o.state === 'failed')
    if (failed) throw new Error(`E2E FAILED: bridge_out failed ${failed.code}`)
    if (Date.now() - lastWait > 60_000) {
      lastWait = Date.now()
      const f = await funding()
      log(`waiting for the bridge: usdc ${f.usdc}, positions ${f.positions.map((p) => p.pool).join(',')}, engine ${JSON.stringify(f.engine).slice(0, 400)}`)
    }
    return false
  }, 10_000)
  const bridgeOp = (await baseOps()).find((o) => isBridge(o) && o.state === 'confirmed')!
  const burnRc = await base.client.getTransactionReceipt({ hash: bridgeOp.txHash as Hex })
  const burns = parseEventLogs({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', logs: burnRc.logs })
  check(burns.length === 1 && burns[0]!.args.mintRecipient.toLowerCase() === pad(remote, { size: 32 }).toLowerCase() && burns[0]!.args.destinationDomain === CCTP_DOMAIN_MONAD, 'Base: the engine\'s bridge_out burns to the remote Safe (domain 15)', `${burns[0]?.args.amount} USDC units, tx ${bridgeOp.txHash}`)
  const burned = burns[0]!.args.amount
  const ue = parseEventLogs({ abi: entryPointV07Abi, eventName: 'UserOperationEvent', logs: burnRc.logs })[0]
  gasReport.push(`bridge_out userOp (Base): handleOps ${burnRc.gasUsed}, userOp actualGasUsed ${ue?.args.actualGasUsed}`)

  // A bridge-out userOp from the same session to another recipient: refused at validation (SmartSession + UniActionPolicy).
  // GPT-6 Sol r1 (P1): any FailedOp is not proof, a bad nonce or prefund fails the same way. So the very same userOp,
  // only the mintRecipient changed, must pass with the remote Safe (control), and fail with the policy's AA24 otherwise.
  {
    const acc = accState()
    const g = acc.grants!.find((x) => x.name === 'bridge-out')!
    const tm = address('TokenMessengerV2', baseRegistry)
    const usdc = address('USDC', baseRegistry)
    const failedOp = parseAbi(['error FailedOp(uint256 opIndex, string reason)', 'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)'])
    const simulate = async (recipient: Address): Promise<string> => {
      const calls = [
        { target: usdc, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [tm, 1_000n] }) },
        { target: tm, value: 0n, callData: encodeFunctionData({ abi: tokenMessengerV2Abi, functionName: 'depositForBurn', args: [1_000n, CCTP_DOMAIN_MONAD, pad(recipient, { size: 32 }), usdc, pad('0x00', { size: 32 }), 0n, 2000] }) },
      ]
      const key = sessionNonceKey(7)
      const nonce = await base.client.readContract({ address: address('EntryPointV07', baseRegistry), abi: entryPointV07Abi, functionName: 'getNonce', args: [ctx.address, key] })
      const gas = engineGas((await base.client.getBlock()).baseFeePerGas ?? 0n, V4_GAS_CAPS)!
      let op = draftUserOp(ctx.address, nonce, executeCallData(calls), gas)
      op = { ...op, signature: useModeSignature(g.permissionId, await sessionKeySignature(privateKeyToAccount(acc.sessionKey!), userOpHash(op, 8453))) }
      return base.client.call({ account: bo.relayer.address, to: address('EntryPointV07', baseRegistry), data: handleOpsData([op], bo.relayer.address) }).then(
        () => 'included',
        (e: Error) => {
          const data = /0x(220266b6|65c8fd4d)[0-9a-fA-F]*/.exec(`${e.message} ${JSON.stringify((e as { cause?: unknown }).cause ?? '')}`)?.[0]
          if (!data) return `reverted: ${e.message.slice(0, 200)}`
          const d = decodeErrorResult({ abi: failedOp, data: data as Hex })
          return `${d.errorName}: ${d.args[1]}`
        },
      )
    }
    const control = await simulate(remote)
    check(control === 'included', 'Base: the same bridge-out userOp to the remote Safe validates and executes (control)', control)
    const other = await simulate(privateKeyToAccount(generatePrivateKey()).address)
    check(other === 'FailedOp: AA24 signature error', 'Base: the same userOp to another recipient is refused by the session policy (AA24)', other)
  }

  // --- 6. Circle attests, the Base operator mints on Monad -----------------------------------------------------------------
  const usdcRemote0 = await monad.balanceOf('USDC', remote)
  await until('the burn is minted on Monad to the remote Safe', 900_000, async () => (await monad.balanceOf('USDC', remote)) - usdcRemote0 >= burned, 10_000)
  check(irisCalls.length > 0, 'the Base operator asked Iris for the burn', `${irisCalls.length} poll(s)`)
  check(true, 'Monad: the USDC landed on the remote Safe (receiveMessage by the Base operator\'s relayer)', `${burned} units`)

  // --- 7. the Monad engine enters WMON/USDC through its V3 sessions --------------------------------------------------------
  const monadOps = async () => (await opCall<{ ops: OpView[] }>(monadOp.url, remoteCtx(), 'GET', '/ops')).json.ops
  await until('the Monad engine mints a WMON/USDC position', 900_000, async () => {
    const ops = await monadOps()
    const f = ops.find((o) => o.state === 'failed')
    if (f) throw new Error(`E2E FAILED: Monad engine op failed ${f.opId} ${f.code}`)
    return ops.some((o) => o.opId.includes('enter_mint') && o.state === 'confirmed')
  }, 5_000)
  const mOps = (await monadOps()).filter((o) => o.state === 'confirmed')
  const rf = (await opCall<FundingView>(monadOp.url, remoteCtx(), 'GET', '/funding?fresh=1')).json
  const pos = rf.positions[0]
  const npm = address('NonfungiblePositionManager', monadRegistry)
  const owner = pos ? await monad.client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', args: [BigInt(pos.tokenId)] }) : undefined
  check(!!pos && owner?.toLowerCase() === remote.toLowerCase() && BigInt(pos.liquidity) > 0n, 'Monad: a WMON/USDC position owned by the remote Safe', `#${pos?.tokenId} ${pos?.pool} worth ${pos?.valueUsdc} USDC units; ops ${mOps.map((o) => o.opId.split('-').pop()).join(', ')}`)
  for (const o of mOps) {
    const r = await monad.client.getTransactionReceipt({ hash: o.txHash as Hex })
    const tx = await monad.client.getTransaction({ hash: o.txHash as Hex })
    gasReport.push(`Monad ${o.opId}: used ${r.gasUsed}, limit ${tx.gas}`)
  }
  check(ownerSignatures - signaturesBefore === 1, 'end to end: one owner signature since v6 was offered')

  // --- 9. MON each relayer spent on Monad, and the Base side's gas ------------------------------------------------------------
  const monadEnd = await monad.client.getBlockNumber()
  const spend: Record<string, { txs: number; used: bigint; limit: bigint; detail: string[] }> = {}
  for (const who of [monadRelayer, bo.relayer.address]) spend[who.toLowerCase()] = { txs: 0, used: 0n, limit: 0n, detail: [] }
  for (let n = monadStart + 1n; n <= monadEnd; n++) {
    const b = await monad.client.getBlock({ blockNumber: n, includeTransactions: true })
    for (const tx of b.transactions) {
      const s = spend[tx.from.toLowerCase()]
      if (!s) continue
      const r = await monad.client.getTransactionReceipt({ hash: tx.hash })
      const price = r.effectiveGasPrice
      s.txs++
      s.used += r.gasUsed * price
      s.limit += tx.gas * price
      s.detail.push(`${tx.to?.slice(0, 10)} used ${r.gasUsed} limit ${tx.gas} value ${tx.value} @${price}`)
    }
  }
  const mon = (w: bigint) => (Number(w) / 1e18).toFixed(4)
  const ms = spend[monadRelayer.toLowerCase()]!
  const bs = spend[bo.relayer.address.toLowerCase()]!
  const monadRelayerDelta = MONAD_RELAYER_MON - (await monad.client.getBalance({ address: monadRelayer }))
  const baseRelayerDelta = BASE_RELAYER_MON - (await monad.client.getBalance({ address: bo.relayer.address }))
  log(`Monad operator relayer: ${ms.txs} tx, balance down ${mon(monadRelayerDelta)} MON (gas at used ${mon(ms.used)}, at limit ${mon(ms.limit)}; the rest is the gas reserve sent to the Safe)\n    ${ms.detail.join('\n    ')}`)
  log(`Base operator relayer on Monad (mints): ${bs.txs} tx, balance down ${mon(baseRelayerDelta)} MON (at used ${mon(bs.used)}, at limit ${mon(bs.limit)})\n    ${bs.detail.join('\n    ')}`)
  log(`gas:\n    ${gasReport.join('\n    ')}`)
  check(B.port.stats().rejectedLabMethods === 0 && M.port.stats().rejectedLabMethods === 0, 'neither operator used an anvil_/evm_ method')
  console.log(`\nE2E TWO-CHAIN PASS: ${steps.length} checks. Base ${ctx.address} on v6 with one signature; Monad ${remote} provisioned, bridged and positioned (#${pos?.tokenId}).`)
  exitCode = 0
} catch (e) {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e)
  console.error(`checks passed before the failure: ${steps.length}`)
} finally {
  globalThis.fetch = realFetch
  for (const s of stops) await Promise.resolve(s()).catch(() => {})
}
process.exit(exitCode)
