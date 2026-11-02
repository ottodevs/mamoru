// otto/mamoru#293 (spec 010, T6), acceptance on forks (Base 8453 and Monad 143, chain ids kept), with the real operators
// booted in their production env shape and the V4 stack deployed as T7 will (CREATE2 through the canonical deterministic
// deployer: the same addresses on both chains), pinned in the registries in memory (what the base.json/monad.json pin PR
// does), the `one_auth_v4` flag scoped to the accounts under test:
//   A. create an account ON V4 (setup mode: its Safe's setup enables the V4 session; the owner signs nothing) -> deposit
//      -> the engine enters the registry's stable pool through V4 -> the registry lists WETH/USDC AFTER the account was
//      created (72 h, here 48 h, in public) -> the engine enters it with no owner signature;
//   B. (with Monad) the operator registers the remote on Monad, the Monad operator deploys it (permissionless), the
//      guardian watcher reads it back and sends setReady; then the engine bridges to it with no owner signature, and
//      Circle (played on the forks) mints there;
//   C. withdraw: one owner signature;
//   D. a running v2 account (12 sessions, more than v6's 4) moves to V4 in ONE owner Safe transaction (migrate-v4 step 0
//      through the operator's prepare/submit): gas measured, every old ENABLE nonce moved, only the V4 session left, the
//      engine on V4 after it; an owner-signed SmartSession ENABLE payload made before the move is refused after it.
// Phases: E2E_PHASES=A,B,C,D (default all). Run (builds the contracts first):
//   nix shell nixpkgs#foundry --command bash -c 'export PATH=$HOME/.foundry/bin:$PATH;
//     cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
//     bun apps/mamoru-operator/test/e2e-one-auth.ts'
// Upstreams: BASE_FORK_RPC_URL (default https://mainnet.base.org), MONAD_RPC_URL (default https://rpc.monad.xyz), public.
// Nothing is broadcast anywhere but the local anvils. Test keys only, generated here.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, parseEventLogs, pad, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, Address, FundingView, OpView, OwnerSignature, OwnerTxToSign, TransferPlan } from '@mamoru/domain'
import { address, baseRegistry, entry, erc20Abi, monadRegistry, readCodeHash, smartSessionAbi, tokenMessengerV2Abi, type Registry } from '@mamoru/registry'
import { oneAuthV4Deployment, ONE_AUTH_V4_CONTRACTS, V4_DOMAIN_BY_CHAIN } from '@mamoru/policy'
import { P256_N } from '@mamoru/account/live'
import { webAuthnSigner } from '@mamoru/account/safe'
import { mamoruActionPolicyV4Abi, mamoruRegistryAbi, smartSessionV4Abi, v4CreateSetup, v4HomeSession } from '@mamoru/account/one-auth'
import { draftUserOp, executeCallData, handleOpsData, permissionIdOf, sessionKeySignature, sessionNonceKey, toSmartSession, userOpHash, type SmartSessionStruct } from '@mamoru/account/sessions'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startEnginePort, startForkProxy, type EnginePort, type ForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { WHALE } from '../../../packages/scenarios/fixtures/world.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { bootOperator } from '../src/boot.ts'
import { DEFAULT_SPONSOR, SPONSOR_BOUNDS, type SponsorPolicy } from '../src/sponsorship.ts'
import { runPass } from '../../mamoru-guardian/src/watcher.ts'
import { StateStore as GuardianState } from '../../mamoru-guardian/src/state.ts'
import { ConsoleAlerter } from '../../mamoru-guardian/src/alerts.ts'

const REPO = join(import.meta.dir, '../../..')
const OUT = join(REPO, 'contracts/action-policy/out')
const DETERMINISTIC_DEPLOYER: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const SALT = keccak256(toHex('mamoru.e2e-one-auth.v4'))
const PHASES = new Set((process.env.E2E_PHASES ?? 'A,B,C,D').split(','))
const DAY = 86_400

const t0 = Date.now()
const log = (m: string) => console.log(`[e2e-one-auth +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const steps: { step: string; ok: boolean; detail: string }[] = []
const gasReport: string[] = []
function check(ok: boolean, step: string, detail = ''): void {
  steps.push({ step, ok, detail })
  if (!ok) throw new Error(`E2E FAILED: ${step}${detail ? `: ${detail}` : ''}`)
  log(`ok  ${step}${detail ? ` (${detail})` : ''}`)
}

// --- forks ---------------------------------------------------------------------------------------------------------
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://mainnet.base.org'
if (!process.env.MONAD_RPC_URL) process.env.MONAD_RPC_URL = 'https://rpc.monad.xyz'
const anvilBin = Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const dir = mkdtempSync(join(tmpdir(), 'mamoru-e2e-one-auth-'))
type Fork = { lab: Lab; proxy: ForkProxy; anvil: ReturnType<typeof Bun.spawn>; port: EnginePort; url: string }
async function startFork(envVar: string, chainId: number, name: string): Promise<Fork> {
  const proxy = startForkProxy(envVar)
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const p = probe.port as number
  probe.stop(true)
  const argv = ['--fork-url', proxy.url, '--no-rate-limit', '--timeout', '120000', '--fork-retry-backoff', '2000', '--retries', '10', '--chain-id', String(chainId), '--host', '127.0.0.1', '--port', String(p), '--slots-in-an-epoch', '1', '--block-time', '1', '--no-request-size-limit', '--gas-limit', '60000000']
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

const artifact = (file: string, name = file): Hex => JSON.parse(readFileSync(join(OUT, `${file}.sol`, `${name}.json`), 'utf8')).bytecode.object as Hex
const create2 = (initCode: Hex): Address => getAddress(`0x${keccak256(concat(['0xff', DETERMINISTIC_DEPLOYER, SALT, keccak256(initCode)])).slice(26)}`)

/** The V4 stack on `lab`, through the deterministic deployer (same salt and init code: the same address on every chain). */
async function deployStack(lab: Lab, deployer: Address, admin: Address, guardian: Address): Promise<Record<(typeof ONE_AUTH_V4_CONTRACTS)[number], Address>> {
  const gasInit = concat([artifact('MamoruGasPolicyV2'), encodeAbiParameters([{ type: 'address' }], [guardian])])
  const regInit = concat([artifact('MamoruRegistry'), encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [admin, guardian, 48n * 3600n])])
  const gasPolicy = create2(gasInit)
  const registry = create2(regInit)
  const v4Init = concat([artifact('MamoruActionPolicyV4'), encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [registry, gasPolicy, guardian])])
  const checkInit = artifact('MamoruMigrationCheck')
  const out = { MamoruGasPolicyV2: gasPolicy, MamoruRegistry: registry, MamoruActionPolicyV4: create2(v4Init), MamoruMigrationCheck: create2(checkInit) }
  for (const init of [gasInit, regInit, v4Init, checkInit]) {
    const r = await lab.sendAs(deployer, DETERMINISTIC_DEPLOYER, concat([SALT, init]))
    if (!r.ok) throw new Error(`deterministic deploy failed on ${lab.chainId}`)
    gasReport.push(`deploy on ${lab.chainId} (${init === v4Init ? 'V4 + helper + MamoruRemoteInit' : init === gasInit ? 'MamoruGasPolicyV2' : init === regInit ? 'MamoruRegistry' : 'MamoruMigrationCheck'}): ${r.receipt.gasUsed}`)
  }
  // The home enable flow self-attests V4 and the gas policy: ModuleRegistry needs a record of each (results section 6, T7).
  const mr = address('ModuleRegistry', lab.registry)
  const uid = (await lab.client.readContract({ address: mr, abi: parseAbi(['struct ModuleRecord { bytes32 resolverUID; address sender; bytes metadata; }', 'function findModule(address) view returns (ModuleRecord)']), functionName: 'findModule', args: [address('TimeFramePolicy', lab.registry)] })).resolverUID
  for (const m of [out.MamoruActionPolicyV4, out.MamoruGasPolicyV2]) {
    const r = await lab.sendAs(deployer, mr, encodeFunctionData({ abi: parseAbi(['function registerModule(bytes32 resolverUID, address moduleAddress, bytes metadata, bytes resolverContext)']), functionName: 'registerModule', args: [uid, m, '0x', '0x'] }))
    check(r.ok, `chain ${lab.chainId}: ModuleRegistry.registerModule of ${m}`)
  }
  return out
}

/** What the pin PR does: the four names move from `undeployed` to `entries`, with the code hash read on the fork. */
async function pin(lab: Lab, registry: Registry, stack: Record<string, Address>): Promise<void> {
  const entries = registry.entries as unknown as { name: string }[]
  for (const [name, a] of Object.entries(stack)) {
    const i = registry.undeployed.indexOf(name)
    if (i >= 0) registry.undeployed.splice(i, 1)
    entries.push({ name, kind: 'smart-sessions-policy', role: 'e2e-one-auth pin', address: a, codeHash: await readCodeHash(lab.client, a) } as never)
  }
}

const POOL_PARAMS = (band: number, anchorBand: number) => encodeAbiParameters(['uint32', 'uint32', 'uint24', 'int24', 'uint24', 'uint16'].map((type) => ({ type })), [600, 60, band, 0, anchorBand, 10_000])
/** The registry admin lists `pools` and `routes` (queue, wait the delay in public, execute). */
async function list(lab: Lab, registryAt: Address, admin: Address, pools: { name: string; band: number; anchor: number }[], routes: number[]): Promise<void> {
  const queued: { kind: number; key: Hex; params: Hex; n: bigint }[] = []
  for (const p of pools) {
    const pool = entry(p.name, lab.registry).address
    // V4 needs an observation ring as long as the window (T6 L-4): raised the way the V3 deploy raised it.
    const [, , , , next] = await lab.client.readContract({ address: pool, abi: parseAbi(['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)']), functionName: 'slot0' })
    for (let c = Number(next); c < 600; c = Math.min(600, c + 150)) await lab.sendAs(admin, pool, encodeFunctionData({ abi: parseAbi(['function increaseObservationCardinalityNext(uint16)']), functionName: 'increaseObservationCardinalityNext', args: [Math.min(600, c + 150)] }))
    queued.push({ kind: 0, key: pad(pool, { size: 32 }), params: POOL_PARAMS(p.band, p.anchor), n: 0n })
  }
  for (const d of routes) queued.push({ kind: 2, key: pad(toHex(d), { size: 32 }), params: encodeAbiParameters([{ type: 'bool' }], [true]), n: 0n })
  for (const q of queued) {
    const r = await lab.sendAs(admin, registryAt, encodeFunctionData({ abi: mamoruRegistryAbi, functionName: 'queue', args: [q.kind, q.key, q.params] }))
    const ev = parseEventLogs({ abi: mamoruRegistryAbi, eventName: 'Queued', logs: r.receipt.logs })[0]!
    q.n = ev.args.nonce
  }
  await lab.warp(48 * 3600 + 60)
  for (const q of queued) {
    const r = await lab.sendAs(admin, registryAt, encodeFunctionData({ abi: mamoruRegistryAbi, functionName: 'execute', args: [q.kind, q.key, q.params, q.n] }))
    if (!r.ok) throw new Error(`registry execute failed on ${lab.chainId}`)
  }
}

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

// ---- the ENABLE-payload replay (contracts/action-policy/test/V4UserOpFork.t.sol `_ownerSignedEnable`, in TypeScript) --------

type Replay = { op: Parameters<typeof handleOpsData>[0][number] }
const CHAIN_SESSION_TYPEHASH: Hex = '0x1ea7e4bc398fa0ccd68d92b5d8931a3fd93eebe1cf0391b4ba28935801af7c80'
const MULTICHAIN_SESSION_TYPEHASH: Hex = '0x0c9d02fb89a1da34d66ea2088dc9ee6a58efee71cef6f1bb849ed74fc6003d98'
const MULTICHAIN_DOMAIN_SEPARATOR: Hex = '0x057501e891776d1482927e5f094ae44049a4d893ba2d7b334dd7db8d38d3a0e1'
const SAFE_MSG_TYPEHASH: Hex = '0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca'
const SESSION_TUPLE = (smartSessionAbi.find((f) => f.type === 'function' && f.name === 'enableSessions')!.inputs[0] as unknown as { components: readonly { name: string; type: string }[] }).components
const digestAbi = parseAbi(['struct PolicyData { address policy; bytes initData; }', 'struct ERC7739Context { bytes32 appDomainSeparator; string[] contentName; }', 'struct ERC7739Data { ERC7739Context[] allowedERC7739Content; PolicyData[] erc1271Policies; }', 'struct ActionData { bytes4 actionTargetSelector; address actionTarget; PolicyData[] actionPolicies; }', 'struct Session { address sessionValidator; bytes sessionValidatorInitData; bytes32 salt; PolicyData[] userOpPolicies; ERC7739Data erc7739Policies; ActionData[] actions; bool permitERC4337Paymaster; }', 'function getSessionDigest(bytes32 permissionId, address account, Session data, uint8 mode) view returns (bytes32)', 'function domainSeparator() view returns (bytes32)'])

/** SmartSession's FastLZ of literal runs only (V4UserOpFork.t.sol `_flzLiterals`): runs of at most 32 bytes. */
function flzLiterals(data: Hex): Hex {
  const b = Buffer.from(data.slice(2), 'hex')
  const out: Buffer[] = []
  for (let i = 0; i < b.length; i += 32) {
    const n = Math.min(32, b.length - i)
    out.push(Buffer.from([n - 1]), b.subarray(i, i + n))
  }
  return `0x${Buffer.concat(out).toString('hex')}`
}

/**
 * An owner-signed SmartSession ENABLE payload for the old session `session` of `safe`, signed now over its current ENABLE
 * nonce by the backup EOA owner (Safe ERC-1271 via Safe7579 with validator 0), and a userOp of the old session key that
 * carries it: what a v2-v6 renewal could have produced and a holder kept unused (contracts test `_ownerSignedEnable`).
 */
async function enablePayload(lab: Lab, safe: Address, session: SmartSessionStruct, owner: ReturnType<typeof privateKeyToAccount>, sessionKey: ReturnType<typeof privateKeyToAccount>): Promise<Replay> {
  const pid = permissionIdOf(session)
  const smart = address('SmartSession', baseRegistry)
  const digest = await lab.client.readContract({ address: smart, abi: digestAbi, functionName: 'getSessionDigest', args: [pid, safe, session as never, 1] })
  const chainsHash = keccak256(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' }], [CHAIN_SESSION_TYPEHASH, 8453n, digest])))
  const hash = keccak256(concat(['0x1901', MULTICHAIN_DOMAIN_SEPARATOR, keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [MULTICHAIN_SESSION_TYPEHASH, chainsHash]))]))
  const dom = await lab.client.readContract({ address: safe, abi: digestAbi, functionName: 'domainSeparator' })
  const msgHash = keccak256(concat(['0x1901', dom, keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [SAFE_MSG_TYPEHASH, keccak256(encodeAbiParameters([{ type: 'bytes32' }], [hash]))]))]))
  const ownerSig = await owner.sign({ hash: msgHash })
  const a = session.actions[0]!
  const callData = executeCallData([{ target: a.actionTarget, value: 0n, callData: concat([a.actionTargetSelector, pad('0x00', { size: 64 })]) }])
  const nonce = await lab.entryPointNonce(safe, sessionNonceKey(9))
  let op = draftUserOp(safe, nonce, callData, { verificationGasLimit: 3_000_000n, callGasLimit: 2_000_000n, preVerificationGas: 100_000n, maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1_000_000n })
  const keySig = await sessionKeySignature(sessionKey, userOpHash(op, 8453))
  const enable = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'chainDigestIndex', type: 'uint8' }, { name: 'hashesAndChainIds', type: 'tuple[]', components: [{ name: 'chainId', type: 'uint64' }, { name: 'sessionDigest', type: 'bytes32' }] }, { name: 'sessionToEnable', type: 'tuple', components: SESSION_TUPLE }, { name: 'permissionEnableSig', type: 'bytes' }] }, { type: 'bytes' }],
    [{ chainDigestIndex: 0, hashesAndChainIds: [{ chainId: 8453n, sessionDigest: digest }], sessionToEnable: session as never, permissionEnableSig: concat(['0x0000000000000000000000000000000000000000', ownerSig]) }, keySig],
  )
  op = { ...op, signature: concat(['0x01', flzLiterals(enable)]) }
  return { op }
}

/** Whether the EntryPoint would include the payload's userOp (an eth_call of handleOps). */
async function sendEnable(lab: Lab, r: Replay, from: Address): Promise<boolean> {
  try {
    await lab.client.call({ account: from, to: address('EntryPointV07', baseRegistry), data: handleOpsData([r.op], from) })
    return true
  } catch {
    return false
  }
}

const stops: (() => void | Promise<void>)[] = []
let exitCode = 1
try {
  const withMonad = PHASES.has('B')
  const [B, M] = await Promise.all([startFork('BASE_FORK_RPC_URL', 8453, 'base'), withMonad ? startFork('MONAD_RPC_URL', 143, 'monad') : Promise.resolve(null)])
  stops.push(async () => {
    for (const f of [B, M]) {
      if (!f) continue
      f.port.stop()
      f.anvil.kill()
      await f.anvil.exited
      f.proxy.stop()
    }
  })
  const base = B.lab
  const baseFork = await base.client.getBlockNumber()
  const monadFork = M ? await M.lab.client.getBlockNumber() : 0n
  log(`Base fork at ${baseFork}${M ? `, Monad fork at ${monadFork}` : ''}`)

  // --- the V4 stack, as T7 deploys it ------------------------------------------------------------------------------------
  const deployer = privateKeyToAccount(generatePrivateKey()).address
  const admin = privateKeyToAccount(generatePrivateKey()).address
  const guardianKey = generatePrivateKey()
  const guardian = privateKeyToAccount(guardianKey).address
  for (const l of [base, M?.lab]) if (l) for (const a of [deployer, admin, guardian]) await l.setBalance(a, 10n ** 21n)
  const stack = await deployStack(base, deployer, admin, guardian)
  if (M) {
    const again = await deployStack(M.lab, deployer, admin, guardian)
    check(Object.entries(stack).every(([k, v]) => again[k as keyof typeof again] === v), 'the V4 stack has the same addresses on Base and Monad (CREATE2, chain-independent init code)', stack.MamoruActionPolicyV4)
    await pin(M.lab, monadRegistry, again)
  }
  await pin(base, baseRegistry, stack)
  const d = oneAuthV4Deployment(baseRegistry)!
  check(!!d && d.policy === stack.MamoruActionPolicyV4, 'Base registry pins the V4 stack (in memory): oneAuthV4Deployment is set', d.policy)
  // Base: only the stable pool at first (Balance waits until a pool is listed); the route to Monad when B runs.
  await list(base, d.registry, admin, [{ name: 'pool:USDC/USDT/100', band: 10, anchor: 40 }], withMonad ? [V4_DOMAIN_BY_CHAIN[143]!] : [])
  if (M) await list(M.lab, d.registry, admin, [{ name: 'pool:WMON/USDC/3000', band: 100, anchor: 0 }], [])

  // --- operators -------------------------------------------------------------------------------------------------------
  const secret = randomBytes(32).toString('hex')
  let monadOp: Awaited<ReturnType<typeof bootOperator>> | null = null
  if (M) {
    for (const k of ['MAMORU_ONCHAIN_POLICY_V4', 'MAMORU_ACTION_POLICY_ADDRESS', 'MAMORU_GAS_POLICY_ADDRESS', 'MAMORU_ACTION_POLICY_V2_ADDRESS', 'MAMORU_PAUSE_GATE_ADDRESS']) delete process.env[k]
    Object.assign(process.env, { MAMORU_LIVE: '1', MAMORU_CHAIN_WRITES: '143', MAMORU_HEAD_LAG: '0', MAMORU_HOME_RPC_URL: B.port.url })
    monadOp = await bootOperator({ rpcUrl: M.port.url, secret, stateDir: join(dir, 'state-monad'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100, policyId: 'live-wmon-usdc-monad-v6' })
    stops.unshift(() => monadOp!.stop())
    check(!!monadOp.operator.cfg.oneAuth && !!monadOp.operator.cfg.homeClient, 'Monad operator: V4 pinned, the home chain read')
    await M.lab.setBalance(monadOp.operator.relayer.address, 200n * 10n ** 18n)
    delete process.env.MAMORU_CHAIN_WRITES
  }
  Object.assign(process.env, { MAMORU_LIVE: '1', MAMORU_HEAD_LAG: '0' })
  const baseOp = await bootOperator({ rpcUrl: B.port.url, ...(M ? { monadRpcUrl: M.port.url, peerOperators: `143=${monadOp!.url}` } : {}), secret, stateDir: join(dir, 'state-base'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100 })
  stops.unshift(() => baseOp.stop())
  if (M) process.env.MAMORU_CHAIN_WRITES = '143'
  const bo = baseOp.operator
  check(bo.cfg.oneAuth?.policy === d.policy, 'Base operator: V4 pinned at boot (oneAuth)')
  await base.setBalance(bo.relayer.address, 10n ** 19n)
  if (M) await M.lab.setBalance(bo.relayer.address, 50n * 10n ** 18n)
  ;(bo.cfg as { sponsor?: SponsorPolicy }).sponsor = { ...DEFAULT_SPONSOR, weiPerDay: SPONSOR_BOUNDS.weiPerDay[1], perAccount: SPONSOR_BOUNDS.perAccount[1] }
  const scoped: Record<string, string[] | null> = { one_auth_v4: [] }
  const flags: Record<string, boolean> = {}
  for (const op of [bo, monadOp?.operator]) {
    if (!op) continue
    ;(op.cfg as { opsFlags?: () => Record<string, boolean> }).opsFlags = () => flags
    ;(op.cfg as { opsScopedFlags?: () => Record<string, string[] | null> }).opsScopedFlags = () => scoped
  }
  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  let ownerSignatures = 0
  const ownerSign = (t: OwnerTxToSign): OwnerSignature => {
    ownerSignatures++
    const a = passkey.assert(t.safeTxHash)
    const s = randomBytes(1)[0]! & 1 ? P256_N - a.s : a.s
    return { prepareId: t.prepareId, authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'), clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'), signature: Buffer.from(der(a.r, s)).toString('base64url') }
  }
  const opsOf = (c: AccountContext) => (bo.ops(c, null, true) as { ops: OpView[] }).ops
  async function until(label: string, ms: number, done: () => Promise<boolean>, every = 3_000): Promise<void> {
    for (const end = Date.now() + ms; ; ) {
      if (await done()) return
      if (Date.now() > end) throw new Error(`E2E FAILED: ${label}`)
      await Bun.sleep(every)
    }
  }
  async function waitOp(c: AccountContext, opId: string, what: string, timeoutMs = 600_000): Promise<OpView> {
    let o: OpView | undefined
    await until(`${what} settles`, timeoutMs, async () => {
      o = opsOf(c).find((x) => x.opId === opId)
      return !!o && (o.state === 'confirmed' || o.state === 'failed')
    }, 1_000)
    check(o!.state === 'confirmed', `${what} confirmed`, `${o!.txHash} block ${o!.block}${o!.code ? ` ${o!.code}` : ''}`)
    return o!
  }
  const busy = (c: AccountContext) => opsOf(c).some((o) => o.opId.startsWith('eng-') && (o.state === 'submitted' || o.state === 'proposed'))
  const entered = (c: AccountContext, pool: string) => opsOf(c).some((o) => o.state === 'confirmed' && o.opId.includes('enter_mint') && o.pool === pool)

  // --- A. an account created on V4 -----------------------------------------------------------------------------------------
  const owners = [address('SafeWebAuthnSharedSigner', baseRegistry)]
  const saltNonce = BigInt(keccak256(randomBytes(32)))
  const accountKey = `e2e-v4-${randomBytes(4).toString('hex')}`
  scoped.one_auth_v4 = [accountKey]
  let ctx: AccountContext = { accountKey, chainId: 8453, address: '0x0000000000000000000000000000000000000000', owners, saltNonce: saltNonce.toString(), passkey: { credentialId: 'e2e-one-auth', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) } }
  if (PHASES.has('A')) {
    const key = await bo.oneAuthKey(ctx)
    const session = v4HomeSession({ sessionKey: key.sessionKey, deployment: d, capUsd: BigInt(key.capUsdc), generation: 1n, admit: [], registry: baseRegistry })
    const created = v4CreateSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y, baseRegistry), session, baseRegistry)
    ctx = { ...ctx, address: created.address, oneAuth: { sessionKey: key.sessionKey, capUsdc: key.capUsdc } }
    // The account's USDC cap is a third of its V4 C (v4CapUsdOf): 90 % of it.
    const deposit = (BigInt(key.capUsdc) * 3n) / 10n
    await base.whaleTransfer('USDC', WHALE, ctx.address, deposit)
    const sigs0 = ownerSignatures
    const started = await bo.startOneAuth(ctx)
    check(started.state === 'active', 'create on V4: the relayer deploys the Safe, the V4 session reads back enabled, the engine runs', `${ctx.address} cap ${key.capUsdc}`)
    const v4cfg = await base.client.readContract({ address: d.policy, abi: mamoruActionPolicyV4Abi, functionName: 'configOf', args: [ctx.address] })
    const ids = await base.client.readContract({ address: address('SmartSession', baseRegistry), abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [ctx.address] })
    check(v4cfg.set && v4cfg.capUsd === BigInt(key.capUsdc) && ids.length === 1 && ids[0]!.toLowerCase() === created.permissionId.toLowerCase(), 'Base: the Safe holds ONE session, V4 configured with the owner\'s C (setup mode)', `C ${v4cfg.capUsd}`)
    await until('the engine enters the registry\'s stable pool through V4', 900_000, async () => entered(ctx, 'pool:USDC/USDT/100'))
    check(ownerSignatures === sigs0, 'no owner signature to create, deposit and enter')
    // The registry lists WETH/USDC now, after the account exists.
    await until('engine idle', 300_000, async () => !busy(ctx))
    await list(base, d.registry, admin, [{ name: 'pool:WETH/USDC/3000', band: 100, anchor: 0 }], [])
    await until('the engine enters WETH/USDC, listed after the account was created, with no owner signature', 900_000, async () => entered(ctx, 'pool:WETH/USDC/3000'))
    check(ownerSignatures === sigs0, 'a pool added to the registry after creation: entered with no owner signature', `${opsOf(ctx).filter((o) => o.state === 'confirmed').map((o) => o.opId.split('-').pop()).join(', ')}`)
    for (const o of opsOf(ctx).filter((x) => x.state === 'confirmed' && x.txHash)) gasReport.push(`V4 engine ${o.opId}: handleOps ${(await base.client.getTransactionReceipt({ hash: o.txHash as Hex })).gasUsed}`)

    // --- B. the remote on Monad: registered, deployed, read back by the guardian, ready; then the bridge -----------------
    if (M && monadOp) {
      const sigsB = ownerSignatures
      await until('V4 registers the remote on Monad (registerRemote userOp)', 300_000, async () => {
        await bo.tickOneAuth()
        const r = await base.client.readContract({ address: d.policy, abi: mamoruActionPolicyV4Abi, functionName: 'remoteOf', args: [ctx.address, 15] })
        return BigInt(r.remote) !== 0n
      }, 5_000)
      const reg = await base.client.readContract({ address: d.policy, abi: mamoruActionPolicyV4Abi, functionName: 'remoteOf', args: [ctx.address, 15] })
      await until('the Monad operator deploys the V4 remote (permissionless factory call)', 300_000, async () => {
        await bo.tickOneAuth()
        return ((await M.lab.client.getCode({ address: reg.remote })) ?? '0x') !== '0x'
      }, 5_000)
      check(true, 'Monad: the remote Safe exists at the address V4 computed', reg.remote)
      // The guardian: one pass of the watcher (its own process in production), with the guardian key.
      const gState = new GuardianState(join(dir, 'guardian'))
      const wallet = await import('viem').then((v) => v.createWalletClient({ account: privateKeyToAccount(guardianKey), transport: v.http(B.url) }))
      const sent: Hex[] = []
      // From the fork blocks: everything V4 and the registry ever emitted is local to the forks (no upstream log reads).
      const notes = await runPass(
        { homeChainId: 8453, v4: d.policy, gasPolicy: d.gasPolicy, registryAt: { 8453: d.registry, 143: d.registry }, fromBlock: { 8453: baseFork + 1n, 143: monadFork + 1n }, logPage: 500n, maxPagesPerStream: 100, dryRun: false, realertMs: 3_600_000 },
        {
          clients: { 8453: base.client as never, 143: M.lab.client as never },
          send: async (a) => {
            const h = await wallet.writeContract({ chain: null, address: d.policy, abi: mamoruActionPolicyV4Abi, functionName: 'setReady', args: [a.account, a.domain, a.remote] })
            await base.client.waitForTransactionReceipt({ hash: h })
            sent.push(h)
            return h
          },
          alerter: new ConsoleAlerter(),
          store: gState,
          allowlist: () => new Set(),
          now: Date.now,
        },
      )
      log(`guardian pass: ${notes.join(' | ')}`)
      check(notes.length === 0, 'the guardian pass reported no section error', notes.join(' | '))
      const ready = await base.client.readContract({ address: d.policy, abi: mamoruActionPolicyV4Abi, functionName: 'isReady', args: [ctx.address, 15] })
      check(sent.length === 1 && ready, 'the guardian read the remote back on Monad (owners, passkey, modules, the V4 session) and sent setReady', sent[0])
      await bo.tickOneAuth()
      // Circle, played on the forks: the Base operator's bridge leg mints on Monad from the Base fork's burn.
      const isBridge = (o: OpView) => o.opId.includes('bridge_out')
      await until('a bridge_out through V4 confirmed on Base', 1_200_000, async () => {
        await bo.tickOneAuth()
        const f = opsOf(ctx).find((o) => isBridge(o) && o.state === 'failed')
        if (f) throw new Error(`E2E FAILED: bridge_out failed ${f.code}`)
        return opsOf(ctx).some((o) => isBridge(o) && o.state === 'confirmed')
      }, 10_000)
      const bridgeOp = opsOf(ctx).find((o) => isBridge(o) && o.state === 'confirmed')!
      const rc = await base.client.getTransactionReceipt({ hash: bridgeOp.txHash as Hex })
      const burns = parseEventLogs({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', logs: rc.logs })
      check(burns.length === 1 && burns[0]!.args.mintRecipient.toLowerCase() === pad(reg.remote, { size: 32 }).toLowerCase(), 'Base: V4.bridge burns to the ready remote only, no owner signature', `${burns[0]?.args.amount} USDC units`)
      check(ownerSignatures === sigsB, 'no owner signature for the remote, its readiness or the bridge')
      gasReport.push(`V4 bridge_out handleOps: ${rc.gasUsed}`)
    }

    // --- C. withdraw: one owner signature ------------------------------------------------------------------------------------
    if (PHASES.has('C')) {
      await until('engine idle before the withdrawal', 300_000, async () => !busy(ctx))
      const sigsC = ownerSignatures
      const f = (await bo.funding(ctx, true)) as FundingView
      const to = privateKeyToAccount(generatePrivateKey()).address
      const amount = (BigInt(f.usdc) * 9n) / 10n
      const plan = (await bo.prepareTransfer(ctx, { to, amountUsdc: amount.toString() })) as TransferPlan
      const op = await bo.submit(ctx, 'transfer', ownerSign(plan.ownerTx))
      await waitOp(ctx, op.opId, 'the withdrawal from the V4 account')
      const got = await base.client.readContract({ address: address('USDC', baseRegistry), abi: erc20Abi, functionName: 'balanceOf', args: [to] })
      check(got === amount && ownerSignatures - sigsC === 1, 'withdraw: ONE owner signature, the USDC at the recipient', `${got}`)
    }
  }

  // --- D. a running v2 account moves to V4 in one owner transaction ---------------------------------------------------------
  if (PHASES.has('D')) {
    const p2 = new SoftwarePasskey(PASSKEY_SCALARS.a2)
    const backup = privateKeyToAccount(generatePrivateKey())
    const owners2 = [address('SafeWebAuthnSharedSigner', baseRegistry), backup.address]
    const key2 = `e2e-v2-${randomBytes(4).toString('hex')}`
    const { accountSetup, counterfactualAddress } = await import('@mamoru/account/recovery')
    const salt2 = BigInt(keccak256(randomBytes(32)))
    const addr2 = counterfactualAddress(accountSetup(owners2, salt2, webAuthnSigner(p2.x, p2.y, baseRegistry)))
    const ctx2: AccountContext = { accountKey: key2, chainId: 8453, address: addr2, owners: owners2, saltNonce: salt2.toString(), passkey: { credentialId: 'e2e-v2', x: toHex(p2.x, { size: 32 }), y: toHex(p2.y, { size: 32 }) } }
    const sign2 = (t: OwnerTxToSign): OwnerSignature => {
      ownerSignatures++
      const a = p2.assert(t.safeTxHash)
      return { prepareId: t.prepareId, authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'), clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'), signature: Buffer.from(der(a.r, a.s)).toString('base64url') }
    }
    await base.whaleTransfer('USDC', WHALE, addr2, 90_000_000n)
    const act = await bo.prepareActivate(ctx2)
    await waitOp(ctx2, (await bo.submit(ctx2, 'activate', sign2(act))).opId, 'v2 activation of the account to migrate')
    await until('the v2 engine invests', 900_000, async () => !busy(ctx2) && opsOf(ctx2).some((o) => o.state === 'confirmed' && o.opId.includes('enter_mint')))
    const before = await base.client.readContract({ address: address('SmartSession', baseRegistry), abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [addr2] })
    log(`v2 account ${addr2}: ${before.length} sessions enabled`)
    // An owner-signed SmartSession ENABLE payload for one old session, signed now (the backup EOA owner, via the Safe's
    // ERC-1271): the vector review r1 of #200 found. Test-only; production never builds one (no-enable-mode.test.ts).
    const st = (bo as unknown as { store: { state: { accounts: Record<string, { grants: { grant: Parameters<typeof toSmartSession>[0]; permissionId: Hex }[]; sessionKey?: Hex }> } } }).store.state.accounts[key2]!
    const old = st.grants.find((g) => !g.grant.requiresActionPolicy) ?? st.grants[0]!
    const replay = await enablePayload(base, addr2, toSmartSession(old.grant, undefined, baseRegistry), backup, privateKeyToAccount(st.sessionKey!))
    scoped.one_auth_v4 = [...(scoped.one_auth_v4 ?? []), key2]
    await until('the inventory reads back clean and What\'s new is offered', 300_000, async () => {
      const f = (await bo.funding(ctx2, true)) as FundingView
      return f.approval?.whatsNew?.currentStep === 0
    }, 5_000)
    const wn = ((await bo.funding(ctx2)) as FundingView).approval!.whatsNew!
    check(wn.policy === 'one-auth-v4' && wn.signatures === 1 && wn.steps.length === 1 && wn.steps[0]!.chain === 'base', 'approval.whatsNew offered: one signature, the Base step', wn.steps[0]!.summary.join(' | '))
    // No manual wait for an idle engine: the prepare holds the engine (intents) and refuses, typed, only while an engine
    // operation of the account is still out (ONE_AUTH_ENGINE_BUSY); the client tries again, as the app does.
    const sigsD = ownerSignatures
    let prep!: OwnerTxToSign
    let busyRefusals = 0
    await until('the migration prepares', 300_000, async () => {
      try {
        prep = await bo.prepareMigrateV4(ctx2, { step: 0 })
        return true
      } catch (e) {
        if ((e as { code?: string }).code !== 'ONE_AUTH_ENGINE_BUSY') throw e
        busyRefusals++
        return false
      }
    }, 2_000)
    log(`prepare refused ONE_AUTH_ENGINE_BUSY ${busyRefusals} time(s) before it was built`)
    check(prep.step === 0 && prep.chainId === 8453 && !prep.moveTo && !!prep.safeTx && prep.safeTx.operation === 1, 'migrate-v4/prepare step 0: step, chainId 8453, the Safe tx fields, no funds moved')
    const sub = await bo.submitMigrateV4(ctx2, { ...sign2(prep), step: 0 })
    const done = await waitOp(ctx2, sub.opId, 'the migration (one owner Safe transaction)')
    check(done.migrateStep === 0, 'the migrate-v4 op carries migrateStep 0')
    const rc = await base.client.getTransactionReceipt({ hash: done.txHash as Hex })
    gasReport.push(`MIGRATION tx (v2 account, ${before.length} sessions): ${rc.gasUsed}`)
    check(rc.gasUsed < 14_500_000n, 'the migration fits well under 14.5M gas', `${rc.gasUsed}`)
    const after = await base.client.readContract({ address: address('SmartSession', baseRegistry), abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [addr2] })
    check(after.length === 1 && ownerSignatures - sigsD === 1, 'one signature, one Safe tx: only the V4 session is left enabled', `${before.length} -> ${after.length}`)
    for (const id of before) {
      const n = await base.client.readContract({ address: address('SmartSession', baseRegistry), abi: smartSessionV4Abi, functionName: 'getNonce', args: [id, addr2] })
      if (n === 0n) throw new Error(`E2E FAILED: ENABLE nonce of ${id} did not move`)
    }
    check(true, 'every old id\'s ENABLE nonce moved (revokeEnableSignature)')
    check(!(await sendEnable(base, replay, bo.relayer.address)), 'the ENABLE payload signed before the move is refused after it (nonce revoked)')
    const f2 = (await bo.funding(ctx2, true)) as FundingView
    check(f2.approval?.policyId === 'one-auth-v4' && !f2.approval.whatsNew && !f2.approval.renewDue, 'the account runs on V4: no renewals, nothing more offered')
    await until('the engine works on V4 after the move (an operation confirmed)', 900_000, async () => opsOf(ctx2).some((o) => o.opId.startsWith('eng-') && o.state === 'confirmed' && Date.parse(o.updatedAt) > Date.parse(done.updatedAt)), 5_000).catch((e) => log(`note: ${(e as Error).message}`))
  }

  log(`gas:\n    ${gasReport.join('\n    ')}`)
  writeFileSync(join(dir, 'gas.txt'), gasReport.join('\n'))
  console.log(`\nE2E ONE-AUTH PASS: ${steps.length} checks (${[...PHASES].join(',')}). Logs ${dir}`)
  exitCode = 0
} catch (e) {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e)
  console.error(`checks passed before the failure: ${steps.length}; logs ${dir}`)
} finally {
  for (const s of stops) await Promise.resolve(s()).catch(() => {})
}
process.exit(exitCode)

