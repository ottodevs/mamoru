// otto/mamoru#348, the gate of the T8 deploy: spec 010 A1 end to end on local anvil forks of Base and Monad, through the
// code paths production runs, never hand-built sessions:
//   1. DeployV4.s.sol `run()` from the impersonated pinned deployer on both forks, then `verify()` (the post-broadcast audit
//      T8 runs against each chain), whose stack must be the script's EXPECTED_* on both chains;
//   2. accounts the real ways: a Safe (Safe7579 + SmartSession, passkey and recovery key) given its ONE owner-signed
//      one-auth grant (`buildMigrateV4`, the owner's Safe tx), and a one-screen sign-up (`liveAccountFromContext` with
//      `oneAuth`: the Safe's setup enables the V4 session);
//   3. engine batches from the A1 builder (`buildA1CallData`) with each kind's operator limits (`v4EngineGas`,
//      V4_OP_GAS), signed by the session key and run through EntryPoint v0.7 `handleOps` (a local bundler): swap, mint,
//      reduce (checkExit + decrease + collect), re-range exit (checkExit + decrease + collect + burn), bridge with maxFee at
//      the chain's CCTP cap;
//   4. readiness across chains with the operator's own lane-1 sender (`Operator.sendV4SessionOp`, its bundler stood in by
//      the local one): registerRemote on Base for Monad, the remote deployed on Monad from the TypeScript derivation, then
//      the operators' readiness flow (#348): announceReady on Monad (the CCTP message to Base), relayMessage on Base with
//      an attestation by a test attester the transmitter's attester manager enabled (impersonated, as V4Fixture._attest
//      pranks it), then readyOf / isReady;
//   5. the owner's exit with no Mamoru service: the recovery key removes the session and withdraws through the Safe;
//   6. refusals at validation: a claimed time outside T +- 300, an approve without its reset + assertZero, a
//      decreaseLiquidity without checkExit.
//
// #348: step 4's announce and relay are the operators' own readiness flow (readiness.ts): the Base operator's step asks the
// Monad operator to announce from the remote's session, reads Circle's attestation (a fake iris over the fork's
// MessageSent, signed by the test attester) and relays it from the home's session.
//
// Not part of `bun test` by default (it needs anvil, forge and two archive RPCs). Run:
//   nix shell nixpkgs#foundry --command bash -c 'cd contracts/action-policy && ./install.sh && forge build && cd ../.. &&
//     MAMORU_A1_E2E=1 bun test apps/mamoru-operator/test/a1-e2e-fork.test.ts'
// RPC: BASE_FORK_RPC_URL (default https://mainnet.base.org) and MONAD_FORK_RPC_URL (default https://rpc.monad.xyz), through
// the loopback fork proxy (never in argv); A1_E2E_BASE_BLOCK / A1_E2E_MONAD_BLOCK pin the fork blocks (default: latest, the
// state T8 deploys on). The forks run with the real chain ids (V4 reads its table by block.chainid), as DeployV4Fork does.
// Nothing is broadcast anywhere but the two local anvils.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bytesToHex,
  concat,
  createWalletClient,
  decodeAbiParameters,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  isAddressEqual,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroAddress,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { toPackedUserOperation, type UserOperation } from 'viem/account-abstraction'
import type { AccountContext, Address } from '@mamoru/domain'
import { address, baseRegistry, entryPointV07Abi, erc20Abi, monadRegistry, safeAbi, smartSessionErrorsAbi, smartSessionValidateAbi, type Registry } from '@mamoru/registry'
import { GAS_CAPS_V2_BY_CHAIN, ONE_AUTH_V4, ONE_AUTH_V4_REMOTE, ONE_AUTH_V4_CONTRACTS, POLICIES, type OneAuthV4Deployment } from '@mamoru/policy'
import {
  a1Abi,
  a1CallData,
  buildA1CallData,
  buildMigrateV4,
  checkA1Batch,
  mamoruActionPolicyV4Abi,
  ownerStateOf,
  smartSessionV4Abi,
  v4CreateSetup,
  v4HomeSession,
  v4HomeSessionSalt,
  v4Remote,
  V4_REMOTE_SESSION_SALT,
  type A1Intent,
} from '@mamoru/account/one-auth'
import { draftUserOp, handleOpsData, permissionIdOf, sessionNonceKey, signSessionUserOp, userOpHash } from '@mamoru/account/sessions'
import { execTransactionData, webAuthnSigner, type Execution } from '@mamoru/account/safe'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { deployCall, liveAccountFromContext } from '@mamoru/account/live'
import { V4_OP_GAS, v4EngineGas, type V4OpKind } from '@mamoru/scenarios/driver/engine.ts'
import { quoterV2Abi } from '@mamoru/uniswap-v3/quote'
import { Lab, decodeEntryPointError, devAccount } from '../../../packages/scenarios/fixtures/lab.ts'
import { startForkProxy, type ForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { Operator, type OperatorConfig } from '../src/operator.ts'
import { v4StoredGrant } from '../src/one-auth.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'

const RUN = process.env.MAMORU_A1_E2E === '1'
const REPO = join(import.meta.dir, '../../..')
const CONTRACTS = join(REPO, 'contracts/action-policy')
const LONG = 900_000

// ---- constants (DeployV4.s.sol, MamoruV4Chains, V4Fixture) -------------------------------------------------------------

const PINNED_DEPLOYER: Address = '0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0'
const MESSAGE_TRANSMITTER: Address = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'
const TOKEN_MESSENGER: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_CBBTC: Address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'
const POOL_BTC: Address = '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef' // USDC/cbBTC 0.05 %, the cbBTC class's reference pool
const BASE_NPM: Address = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1'
/** FiatTokenV2_2 `balanceAndBlacklistStates` (USDC on Base). */
const USDC_BALANCE_SLOT = 9n
const DOMAIN_BASE = 6
const DOMAIN_MONAD = 15
const C = 10_000_000_000n // the owner-signed cap, 10,000 USD
const CCTP_FEE_CAP_BPS = 10n

const key = (s: string): Hex => keccak256(toHex(`mamoru.a1-e2e.${s}`))
const OWNER_KEY = key('owner') // the account's recovery key (an EOA owner beside the passkey)
const SESSION_KEY = key('session') // the home session's key
const SIGNUP_SESSION_KEY = key('signup-session')
const REMOTE_SESSION_KEY = key('remote-session') // the Monad remote's session key
const ATTESTER_KEY = key('cctp-attester') // stands in for Circle's attesters, never a weaker check
const owner = privateKeyToAccount(OWNER_KEY)
const PASSKEY = { x: 0x1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00n, y: 0x0a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeffn }

const lensAbi = parseAbi([
  'function swapBounds(address pool, address tokenIn, uint256 amountIn) view returns (uint256 minOut, uint160 sqrtPriceLimitX96)',
  'function decreaseMins(address account, uint256 tokenId, uint128 liquidity) view returns (uint256, uint256)',
])
const npmAbi = parseAbi([
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
])
const slot0Abi = parseAbi(['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)'])
const npmDecreaseAbi = parseAbi(['function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) returns (uint256, uint256)'])
const transmitterAbi = parseAbi([
  'function attesterManager() view returns (address)',
  'function enableAttester(address)',
  'function setSignatureThreshold(uint256)',
  'event MessageSent(bytes message)',
])
const smartSessionAdminAbi = parseAbi(['function removeSession(bytes32 permissionId)'])
const v4EventsAbi = parseAbi(['event Bridged(address indexed account, uint32 indexed domain, address indexed recipient, address token, uint256 amount)'])

// ---- forks ------------------------------------------------------------------------------------------------------------

type Fork = { lab: Lab; url: string; proxy: ForkProxy; stop: () => Promise<void> }

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const p = s.port as number
  s.stop(true)
  return p
}

/** anvil forking `envVar`'s RPC through the loopback proxy, at the chain's real id (V4's table is keyed by block.chainid). */
async function startFork(envVar: string, fallback: string, chainId: number, blockEnv: string, registry: Registry): Promise<Fork> {
  if (!process.env[envVar]) process.env[envVar] = fallback
  const proxy = startForkProxy(envVar)
  const port = await freePort()
  const block = process.env[blockEnv]
  const argv = ['--fork-url', proxy.url, ...(block ? ['--fork-block-number', block] : []), '--chain-id', String(chainId), '--host', '127.0.0.1', '--port', String(port), '--no-request-size-limit', '--silent']
  assertNoKeyInArgv(argv, [envVar])
  const bin = Bun.which('anvil')
  if (!bin) throw new Error('anvil is not on PATH (nix shell nixpkgs#foundry)')
  const proc = Bun.spawn([bin, ...argv], { stdout: 'ignore', stderr: 'ignore', env: sanitizedEnv() })
  const url = `http://127.0.0.1:${port}/`
  const lab = new Lab(url, chainId, registry)
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      if ((await lab.client.getChainId()) === chainId) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`anvil for ${chainId} did not start`)
    await Bun.sleep(250)
  }
  return {
    lab,
    url,
    proxy,
    stop: async () => {
      proc.kill()
      await proc.exited
      proxy.stop()
    },
  }
}

/** `forge script` against a local anvil only (refuses any other URL). */
async function forgeScript(url: string, args: string[]): Promise<string> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) throw new Error(`refusing to run a script anywhere but a local fork (${url})`)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.endsWith('_RPC_URL')) env[k] = v
  const forge = Bun.which('forge')
  if (!forge) throw new Error('forge is not on PATH (nix shell nixpkgs#foundry)')
  const r = Bun.spawn([forge, 'script', 'script/DeployV4.s.sol', '--rpc-url', url, ...args], { cwd: CONTRACTS, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited])
  const out = `${stdout}\n${stderr}`
  if (code !== 0) throw new Error(`forge script DeployV4.s.sol ${args.join(' ')} failed (${code}):\n${out.slice(-3000)}`)
  return out
}

type Stack = { table: Address; gasPolicy: Address; policy: Address; check: Address }

/** DeployV4.s.sol's pinned EXPECTED_* (the addresses T8 must land on), read from the script itself. */
function expectedStack(): Stack {
  const src = readFileSync(join(CONTRACTS, 'script/DeployV4.s.sol'), 'utf8')
  const at = (name: string) => getAddress(new RegExp(`${name}\\s*=\\s*(0x[0-9a-fA-F]{40})`).exec(src)?.[1] ?? zeroAddress)
  return { table: at('EXPECTED_TABLE'), gasPolicy: at('EXPECTED_GAS_POLICY'), policy: at('EXPECTED_POLICY'), check: at('EXPECTED_CHECK') }
}

/** The stack `verify()` returned (forge prints the returned struct). */
function parseStack(out: string): Stack {
  const m = /table:\s*(0x[0-9a-fA-F]{40}),\s*gasPolicy:\s*(0x[0-9a-fA-F]{40}),\s*policy:\s*(0x[0-9a-fA-F]{40}),\s*check:\s*(0x[0-9a-fA-F]{40})/.exec(out)
  if (!m) throw new Error(`verify() printed no stack:\n${out.slice(-2000)}`)
  return { table: getAddress(m[1]!), gasPolicy: getAddress(m[2]!), policy: getAddress(m[3]!), check: getAddress(m[4]!) }
}

/** T8's two commands on one fork: run() from the pinned deployer (impersonated), then verify(). */
async function deployV4(f: Fork): Promise<Stack> {
  await f.lab.setBalance(PINNED_DEPLOYER, 10n ** 20n)
  await f.lab.rpc('anvil_impersonateAccount', [PINNED_DEPLOYER])
  try {
    await forgeScript(f.url, ['--broadcast', '--unlocked', '--sender', PINNED_DEPLOYER, '--slow', '--skip-simulation', '--rpc-timeout', '900', '--timeout', '900'])
  } finally {
    await f.lab.rpc('anvil_stopImpersonatingAccount', [PINNED_DEPLOYER])
  }
  return parseStack(await forgeScript(f.url, ['--sig', 'verify()']))
}

/** The registry with the V4 stack pinned at `d` (what the T8 pin PR writes into the registry files), a copy. */
function pinned(r: Registry, d: OneAuthV4Deployment): Registry {
  const at: Record<(typeof ONE_AUTH_V4_CONTRACTS)[number], Address> = { MamoruActionPolicyV4: d.policy, MamoruGasPolicyV2: d.gasPolicy, MamoruMigrationCheck: d.migrationCheck, MamoruV4Table: d.table }
  return {
    ...r,
    undeployed: r.undeployed.filter((n) => !(ONE_AUTH_V4_CONTRACTS as readonly string[]).includes(n)),
    entries: [...r.entries.filter((e) => !(ONE_AUTH_V4_CONTRACTS as readonly string[]).includes(e.name)), ...ONE_AUTH_V4_CONTRACTS.map((name) => ({ name, kind: 'smart-sessions-policy', role: 'A1 E2E pin (#348)', address: at[name], codeHash: null }) as never)],
  }
}

async function deployContract(lab: Lab, bytecode: Hex): Promise<Address> {
  const wallet = createWalletClient({ account: devAccount(2), chain: lab.chain, transport: http(lab.url) })
  const hash = await wallet.sendTransaction({ data: bytecode, gas: 10_000_000n })
  const r = await lab.client.waitForTransactionReceipt({ hash })
  if (r.status !== 'success' || !r.contractAddress) throw new Error('deploy failed')
  return getAddress(r.contractAddress)
}

/** The creation code forge built for `<Contract>.sol/<Contract>.json`. */
function creationCode(contract: string): Hex {
  const j = JSON.parse(readFileSync(join(CONTRACTS, 'out', `${contract}.sol`, `${contract}.json`), 'utf8')) as { bytecode: { object: string } }
  return (j.bytecode.object.startsWith('0x') ? j.bytecode.object : `0x${j.bytecode.object}`) as Hex
}

// ---- the local bundler: handleOps from a funded EOA on the fork ----------------------------------------------------------

type OpResult = { op: UserOperation<'0.7'>; included: boolean; success: boolean; failedOp: { name: string; reason?: string; inner?: Hex } | null; receipt?: TransactionReceipt; actualGasCost?: bigint }

function revertData(e: unknown): Hex | undefined {
  let cur = e as { data?: unknown; cause?: unknown } | undefined
  for (let i = 0; i < 8 && cur; i++) {
    if (typeof cur.data === 'string' && cur.data.startsWith('0x')) return cur.data as Hex
    if (cur.data && typeof (cur.data as { data?: unknown }).data === 'string') return (cur.data as { data: Hex }).data
    cur = cur.cause as typeof cur
  }
  return undefined
}

class LocalBundler {
  readonly beneficiary = devAccount(1)
  last: OpResult | null = null
  /** Ops included (executed or reverted in execution). */
  count = 0
  constructor(readonly lab: Lab) {}

  /** handleOps([op]): an op the EntryPoint refuses at validation is never sent (its FailedOp is returned). */
  async handle(op: UserOperation<'0.7'>): Promise<OpResult> {
    const ep = address('EntryPointV07', this.lab.registry)
    const data = handleOpsData([op], this.beneficiary.address)
    try {
      await this.lab.client.call({ account: this.beneficiary.address, to: ep, data, gas: 15_000_000n })
    } catch (e) {
      return (this.last = { op, included: false, success: false, failedOp: decodeEntryPointError(revertData(e)) ?? { name: 'unknown' } })
    }
    const sent = await this.lab.send(this.beneficiary, ep, data, 0n, 15_000_000n)
    const ev = parseEventLogs({ abi: entryPointV07Abi, logs: sent.receipt.logs, eventName: 'UserOperationEvent' })[0]
    if (sent.ok && ev) this.count++
    return (this.last = { op, included: sent.ok && !!ev, success: !!ev?.args.success, failedOp: null, receipt: sent.receipt, actualGasCost: ev?.args.actualGasCost })
  }

  /** The operator's lane-1 bundler (`Operator.lane1Bundler().sendUserOperation`): the userOp hash, as a bundler answers. */
  async sendUserOperation(op: UserOperation<'0.7'>): Promise<Hex> {
    const r = await this.handle(op)
    if (!r.included || !r.success) throw new Error(`local bundler: op not executed (${r.failedOp?.reason ?? 'execution reverted'})`)
    return userOpHash(op, this.lab.chainId, this.lab.registry)
  }
}

/**
 * Why SmartSession refuses `op`: its validateUserOp called from the account, as Safe7579 calls it (Safe7579 itself only
 * reports ExecutionFailed()). `PolicyViolation(<policy>)` names the policy that refused.
 */
async function sessionVerdict(lab: Lab, op: UserOperation<'0.7'>, registry: Registry): Promise<string> {
  const data = encodeFunctionData({ abi: smartSessionValidateAbi, functionName: 'validateUserOp', args: [toPackedUserOperation(op), userOpHash(op, lab.chainId, registry)] })
  try {
    const r = await lab.client.call({ account: op.sender, to: address('SmartSession', registry), data, gas: 10_000_000n })
    const v = BigInt(r.data ?? '0x0')
    return v === 0n ? 'valid' : (v & ((1n << 160n) - 1n)) === 1n ? 'SIG_VALIDATION_FAILED' : `time range ${v >> 160n}`
  } catch (e) {
    const d = revertData(e)
    if (!d || d === '0x') return 'revert without data'
    try {
      const x = decodeErrorResult({ abi: smartSessionErrorsAbi, data: d })
      return x.errorName === 'PolicyViolation' ? `PolicyViolation(${getAddress(x.args[1] as Address)})` : x.errorName
    } catch {
      return `revert ${d.slice(0, 10)}`
    }
  }
}

// ---- the operator, as production builds it, on a fork ------------------------------------------------------------------

type Lane1 = { sendV4SessionOp(a: AccountState, i: A1Intent[]): Promise<Hex | null>; lane1Bundler: () => Pick<LocalBundler, 'sendUserOperation'> }

function operatorOn(lab: Lab, registry: Registry, d: OneAuthV4Deployment, bundler: LocalBundler): Operator {
  const cfg = { chainId: lab.chainId, registry, live: true, rpcUrl: lab.url, bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1, oneAuth: d } satisfies OperatorConfig
  const store = { state: { accounts: {} as Record<string, AccountState> }, save: () => {} } as unknown as StateStore
  const relayer = { address: devAccount(3).address } as unknown as Relayer
  const op = new Operator(cfg, lab.client, relayer, store)
  ;(op as unknown as Lane1).lane1Bundler = () => bundler
  return op
}

/** The operator's record of an account on its V4 session (what `afterMigration` / sign-up store). */
function v4Account(accountKey: string, account: Address, chainId: number, sessionKey: Hex, permissionId: Hex, salt: Hex, d: OneAuthV4Deployment, registry: Registry): AccountState {
  const grant = v4StoredGrant({ account, chainId, sessionKey: privateKeyToAccount(sessionKey).address, permissionId, salt, deployment: d, registry })
  return { accountKey, ctx: { accountKey, chainId, address: account }, active: true, trusted: true, policyId: ONE_AUTH_V4, sessionKey, grants: [{ name: 'one-auth-v4', grant, permissionId }], ops: [], revoked: [], managedTokenIds: [], depositsAfter: '1', historyFromBlock: '1', epoch: 1, seq: 1 } as unknown as AccountState
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

/** An ECDSA signature of `hash` with v = 27/28 (Safe owner signature over safeTxHash; CCTP attestation over keccak(message)). */
async function ecdsa(hash: Hex, privateKey: Hex): Promise<Hex> {
  const s = await sign({ hash, privateKey })
  return concat([s.r, s.s, numberToHex(s.v ?? (s.yParity === 1 ? 28n : 27n), { size: 1 })])
}

/** A Safe tx the owner sends itself, signed by msg.sender (pre-validated signature): no relayer, no Mamoru service. */
async function ownerExec(lab: Lab, safe: Address, to: Address, data: Hex): Promise<boolean> {
  const nonce = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
  const sig = concat([pad(owner.address), pad('0x00'), '0x01'])
  const r = await lab.send(owner, safe, execTransactionData({ to, value: 0n, data, operation: 0, nonce }, sig), 0n, 2_000_000n)
  return r.ok
}

async function setUsdc(lab: Lab, who: Address, amount: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, USDC_BALANCE_SLOT]))
  await lab.rpc('anvil_setStorageAt', [BASE_USDC, slot, pad(toHex(amount))])
  expect(await lab.client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [who] })).toBe(amount)
}

const bal = (lab: Lab, token: Address, who: Address) => lab.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })

/** What Circle's attestation service does to a V2 message before signing (V4Fixture._attestable): a fresh nonce (bytes
 * 12..44) and the finality the source executed at (bytes 144..148). */
let cctpNonce = 0xa1e2en
function attestable(m: Hex, finality: number): Hex {
  const b = hexToBytes(m)
  b.set(hexToBytes(pad(toHex(++cctpNonce))), 12)
  b.set(hexToBytes(numberToHex(finality, { size: 4 })), 144)
  return bytesToHex(b)
}

/** On `lab`, the transmitter's attester manager (impersonated) enables the test attester at threshold 1; its signature of `m`. */
async function attest(lab: Lab, m: Hex): Promise<Hex> {
  const manager = await lab.client.readContract({ address: MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: 'attesterManager' })
  await lab.setBalance(manager, 10n ** 18n)
  await lab.sendAs(manager, MESSAGE_TRANSMITTER, encodeFunctionData({ abi: transmitterAbi, functionName: 'enableAttester', args: [privateKeyToAccount(ATTESTER_KEY).address] })) // already enabled: reverts, fine
  await lab.sendAs(manager, MESSAGE_TRANSMITTER, encodeFunctionData({ abi: transmitterAbi, functionName: 'setSignatureThreshold', args: [1n] }))
  return ecdsa(keccak256(m), ATTESTER_KEY)
}

// ---- the run ----------------------------------------------------------------------------------------------------------

describe.skipIf(!RUN)('#348 A1 end to end on Base and Monad forks (gate of T8)', () => {
  let base: Fork
  let monad: Fork
  let stack: Stack
  let D: OneAuthV4Deployment
  let baseReg: Registry
  let monadReg: Registry
  let lens: Address
  let baseBundler: LocalBundler
  let monadBundler: LocalBundler
  let baseOp: Operator
  let monadOp: Operator
  // the main account: a Safe given its one-auth grant by the owner's Safe tx
  let home: Address
  let homePid: Hex
  let homeAcc: AccountState
  let tokenId = 0n
  let remote: Address
  const kinds: string[] = []

  /** One engine userOp of `account`'s V4 session (lane 0): the builder's batch (or `callData`), the kind's limits. */
  async function engineOp(lab: Lab, bundler: LocalBundler, account: Address, pid: Hex, sk: Hex, kind: V4OpKind, intents: A1Intent[], o: { t?: bigint; callData?: Hex } = {}): Promise<OpResult> {
    const block = await lab.client.getBlock()
    const t = o.t ?? block.timestamp
    const callData = o.callData ?? buildA1CallData({ chainId: lab.chainId, account, policy: D.policy, t }, intents).callData
    const gas = v4EngineGas(kind, lab.chainId, block.baseFeePerGas ?? 0n, GAS_CAPS_V2_BY_CHAIN[lab.chainId])
    if (!gas) throw new Error(`v4EngineGas(${kind}) waits at basefee ${block.baseFeePerGas}`)
    const limits = V4_OP_GAS[lab.chainId]![kind]
    expect([gas.verificationGasLimit, gas.callGasLimit, gas.preVerificationGas]).toEqual([limits.verificationGasLimit, limits.callGasLimit, limits.preVerificationGas])
    const reg = lab.chainId === 143 ? monadReg : baseReg
    const nonce = await lab.entryPointNonce(account, sessionNonceKey(0, address('SmartSession', reg)))
    const op = await signSessionUserOp(draftUserOp(account, nonce, callData, gas), lab.chainId, pid, privateKeyToAccount(sk), reg)
    return bundler.handle(op)
  }

  async function engineOk(kind: V4OpKind, intents: A1Intent[], what: string): Promise<TransactionReceipt> {
    const r = await engineOp(base.lab, baseBundler, home, homePid, SESSION_KEY, kind, intents)
    if (!r.included || !r.success) throw new Error(`${what}: ${r.failedOp ? `refused at validation (${r.failedOp.reason})` : 'execution reverted'}`)
    kinds.push(`${what}: gas cost ${r.actualGasCost} wei at the ${kind} limits`)
    return r.receipt!
  }

  const deadline = async () => (await base.lab.client.getBlock()).timestamp + 900n

  /**
   * A USDC -> cbBTC swap intent with bounds inside V4's (the engine's own bounds are a narrower band, never the edge): the
   * lens gives the loosest minOut and price limit V4 accepts at the latest block, and the op lands a block later, when the
   * TWAP range has moved by a few seconds of history. So minOut sits halfway between that edge and the quote at the spot,
   * and the limit halfway between the spot and the edge's limit.
   */
  async function swapIntent(amountIn: bigint): Promise<A1Intent> {
    const lab = base.lab
    const [edgeMinOut, edgeLimit] = await lab.client.readContract({ address: lens, abi: lensAbi, functionName: 'swapBounds', args: [POOL_BTC, BASE_USDC, amountIn] })
    const { result } = await lab.client.simulateContract({ address: address('QuoterV2', baseReg), abi: quoterV2Abi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: BASE_USDC, tokenOut: BASE_CBBTC, amountIn, fee: 500, sqrtPriceLimitX96: 0n }] })
    const [sqrtP] = await lab.client.readContract({ address: POOL_BTC, abi: slot0Abi, functionName: 'slot0' })
    expect(result[0]).toBeGreaterThanOrEqual(edgeMinOut)
    return { kind: 'swap', params: { pool: POOL_BTC, tokenIn: BASE_USDC, amountIn, amountOutMinimum: edgeMinOut + (result[0] - edgeMinOut) / 2n, sqrtPriceLimitX96: sqrtP + (edgeLimit - sqrtP) / 2n, deadline: await deadline() } }
  }

  /** Exit minimums halfway between checkExit's edge (the lens) and what the manager pays at the spot now (an eth_call of
   * decreaseLiquidity by the owner of the position), for the same reason. */
  async function exitMins(account: Address, id: bigint, liquidity: bigint): Promise<[bigint, bigint]> {
    const lab = base.lab
    const [e0, e1] = await lab.client.readContract({ address: lens, abi: lensAbi, functionName: 'decreaseMins', args: [account, id, liquidity] })
    const { result } = await lab.client.simulateContract({ account, address: BASE_NPM, abi: npmDecreaseAbi, functionName: 'decreaseLiquidity', args: [{ tokenId: id, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: await deadline() }] })
    expect(result[0]).toBeGreaterThanOrEqual(e0)
    expect(result[1]).toBeGreaterThanOrEqual(e1)
    return [e0 + (result[0] - e0) / 2n, e1 + (result[1] - e1) / 2n]
  }

  beforeAll(async () => {
    ;[base, monad] = await Promise.all([
      startFork('BASE_FORK_RPC_URL', 'https://mainnet.base.org', 8453, 'A1_E2E_BASE_BLOCK', baseRegistry),
      startFork('MONAD_FORK_RPC_URL', 'https://rpc.monad.xyz', 143, 'A1_E2E_MONAD_BLOCK', monadRegistry),
    ])
    baseBundler = new LocalBundler(base.lab)
    monadBundler = new LocalBundler(monad.lab)
  }, LONG)

  afterAll(async () => {
    for (const k of kinds) console.log(`[a1-e2e] ${k}`)
    await Promise.all([base?.stop(), monad?.stop()])
  })

  test('1. DeployV4.s.sol run() + verify() on both forks: the stack is EXPECTED_* on Base and on Monad', async () => {
    const expected = expectedStack()
    const [b, m] = await Promise.all([deployV4(base), deployV4(monad)])
    expect(b).toEqual(expected)
    expect(m).toEqual(expected)
    for (const lab of [base.lab, monad.lab]) for (const a of Object.values(expected)) expect((await lab.client.getCode({ address: a }))?.length ?? 0).toBeGreaterThan(2)
    stack = b
    D = { policy: stack.policy, gasPolicy: stack.gasPolicy, migrationCheck: stack.check, table: stack.table }
    baseReg = pinned(baseRegistry, D)
    monadReg = pinned(monadRegistry, D)
    baseOp = operatorOn(base.lab, baseReg, D, baseBundler)
    monadOp = operatorOn(monad.lab, monadReg, D, monadBundler)
    // the operator's views (never called on chain), deployed like any reader: swap bounds and exit minimums
    lens = await deployContract(base.lab, concat([creationCode('MamoruV4Lens'), encodeAbiParameters([{ type: 'address' }], [D.policy])]))
  }, LONG)

  test('2. a Safe (Safe7579, SmartSession, passkey + recovery key) gets its one-auth grant by ONE owner-signed Safe tx', async () => {
    const lab = base.lab
    const owners = [address('SafeWebAuthnSharedSigner', baseReg), owner.address]
    const passkey = webAuthnSigner(PASSKEY.x, PASSKEY.y, baseReg)
    const setup = accountSetup(owners, 348n, passkey, baseReg)
    home = counterfactualAddress(setup, baseReg)
    const create = deployCall({ safe: home, chainId: 8453, owners, saltNonce: 348n, webauthn: passkey, registry: baseReg, setup })
    expect((await lab.send(devAccount(3), create.to, create.data)).ok).toBe(true)
    await lab.setBalance(home, 10n ** 18n) // the account pays its own prefund
    await setUsdc(lab, home, 20_000_000_000n)
    // the owner's one signature (spec 010: "Create + authorize" for a Safe set up before V4, #309)
    const m = buildMigrateV4({ chainId: 8453, safe: home, safeNonce: '0', step: 0, capUsdc: C.toString(), sessionKey: privateKeyToAccount(SESSION_KEY).address, generation: '1', admit: [], oldPermissionIds: [], removeIds: [], noncesBefore: [], home: zeroAddress, homeDomain: 0 }, baseReg)
    const sig = await ecdsa(m.safeTxHash, OWNER_KEY)
    const tx = execTransactionData({ to: m.safeTx.to, value: 0n, data: m.safeTx.data, operation: m.safeTx.operation, nonce: 0n }, sig)
    expect((await lab.send(devAccount(3), home, tx, 0n, 5_000_000n)).ok).toBe(true) // relayed: anyone may send it
    homePid = m.permissionId
    expect(await lab.client.readContract({ address: address('SmartSession', baseReg), abi: smartSessionV4Abi, functionName: 'isPermissionEnabled', args: [homePid, home] })).toBe(true)
    expect(await lab.client.readContract({ address: address('SmartSession', baseReg), abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [home] })).toEqual([homePid])
    expect(await lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'generationOf', args: [home] })).toBe(1n)
    const cfg = await lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'configOf', args: [home] })
    expect(cfg.capUsd).toBe(C)
    expect(cfg.home).toBe(zeroAddress)
    homeAcc = v4Account('home', home, 8453, SESSION_KEY, homePid, v4HomeSessionSalt(1n), D, baseReg)
  }, LONG)

  test('3. the one-screen sign-up: the Safe setup enables the V4 session (liveAccountFromContext + deployCall), and it trades', async () => {
    const lab = base.lab
    const owners = [address('SafeWebAuthnSharedSigner', baseReg), owner.address]
    const passkey = webAuthnSigner(PASSKEY.x, PASSKEY.y, baseReg)
    const sk = privateKeyToAccount(SIGNUP_SESSION_KEY).address
    const session = v4HomeSession({ sessionKey: sk, deployment: D, capUsd: C, generation: 1n, admit: [], registry: baseReg })
    const created = v4CreateSetup(owners, 349n, passkey, session, baseReg)
    const ctx: AccountContext = { accountKey: 'signup', chainId: 8453, address: created.address, owners, saltNonce: '349', passkey: { credentialId: 'a1-e2e', x: toHex(PASSKEY.x, { size: 32 }), y: toHex(PASSKEY.y, { size: 32 }) }, oneAuth: { sessionKey: sk, capUsdc: C.toString() } }
    const live = liveAccountFromContext(ctx, baseReg)
    expect(live.safe).toBe(created.address)
    const create = deployCall(live)
    expect((await lab.send(devAccount(3), create.to, create.data, 0n, 5_000_000n)).ok).toBe(true)
    const pid = permissionIdOf(session)
    expect(pid).toBe(created.permissionId)
    expect(await lab.client.readContract({ address: address('SmartSession', baseReg), abi: smartSessionV4Abi, functionName: 'isPermissionEnabled', args: [pid, live.safe] })).toBe(true)
    expect(await lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'generationOf', args: [live.safe] })).toBe(1n)
    await lab.setBalance(live.safe, 10n ** 18n)
    await setUsdc(lab, live.safe, 1_000_000_000n)
    const swap = await swapIntent(50_000_000n)
    const r = await engineOp(lab, baseBundler, live.safe, pid, SIGNUP_SESSION_KEY, 'swap', [swap])
    expect(r.included && r.success).toBe(true)
    expect(await bal(lab, BASE_CBBTC, live.safe)).toBeGreaterThanOrEqual(swap.kind === 'swap' ? swap.params.amountOutMinimum : 0n)
  }, LONG)

  test('4. engine swap and mint, each at its V4_OP_GAS limits through the real gas policy', async () => {
    const lab = base.lab
    const swap = await swapIntent(100_000_000n)
    await engineOk('swap', [swap], 'swap 100 USDC -> cbBTC')
    const btc = await bal(lab, BASE_CBBTC, home)
    expect(btc).toBeGreaterThanOrEqual(swap.kind === 'swap' ? swap.params.amountOutMinimum : 0n)
    expect(await lab.client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'allowance', args: [home, D.policy] })).toBe(0n)
    const [, spot] = await lab.client.readContract({ address: POOL_BTC, abi: slot0Abi, functionName: 'slot0' })
    const lo = Math.trunc((spot - 600) / 10) * 10
    const hi = Math.trunc((spot + 600) / 10) * 10
    await engineOk('mint', [{ kind: 'mint', params: { token0: BASE_USDC, token1: BASE_CBBTC, fee: 500, tickLower: lo, tickUpper: hi, amount0Desired: 100_000_000n, amount1Desired: btc, amount0Min: 0n, amount1Min: 0n, recipient: home, deadline: await deadline() } }], 'mint USDC/cbBTC')
    expect(await lab.client.readContract({ address: BASE_NPM, abi: npmAbi, functionName: 'balanceOf', args: [home] })).toBe(1n)
    tokenId = await lab.client.readContract({ address: BASE_NPM, abi: npmAbi, functionName: 'tokenOfOwnerByIndex', args: [home, 0n] })
    expect(await lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'admittedPool', args: [home, tokenId] })).toBe(getAddress(POOL_BTC))
    for (const t of [BASE_USDC, BASE_CBBTC]) expect(await lab.client.readContract({ address: t, abi: erc20Abi, functionName: 'allowance', args: [home, D.policy] })).toBe(0n)
  }, LONG)

  test('5. refused at validation (nothing executes): claimed time outside T +- 300, approve without reset + assertZero, decrease without checkExit', async () => {
    const lab = base.lab
    const now = (await lab.client.getBlock()).timestamp
    const amountIn = 10_000_000n
    const swap = await swapIntent(amountIn)
    if (swap.kind !== 'swap') throw new Error('swap intent')
    const { amountOutMinimum: minOut, sqrtPriceLimitX96: limit } = swap.params
    const usdc0 = await bal(lab, BASE_USDC, home)
    const nonce0 = await lab.entryPointNonce(home, sessionNonceKey(0, address('SmartSession', baseReg)))
    // a claimed time 400 s in the past: validUntil = T + 300 has passed; 400 s ahead: validAfter = T - 300 is still ahead
    for (const t of [now - 400n, now + 400n]) {
      const r = await engineOp(lab, baseBundler, home, homePid, SESSION_KEY, 'swap', [swap], { t })
      expect(r.included).toBe(false)
      expect(r.failedOp?.reason).toContain('AA22')
      kinds.push(`refused, claimed time ${t > now ? '+' : '-'}400 s: ${r.failedOp?.reason}`)
    }
    // approve(V4) and the swap, with the reset but no assertZero after it
    const v4 = getAddress(D.policy)
    const x = (target: Address, data: Hex): Execution => ({ target: getAddress(target), value: 0n, callData: data })
    const clock = x(v4, encodeFunctionData({ abi: a1Abi, functionName: 'clock', args: [now] }))
    const approve = (n: bigint) => x(BASE_USDC, encodeFunctionData({ abi: a1Abi, functionName: 'approve', args: [v4, n] }))
    const v4swap = x(v4, encodeFunctionData({ abi: a1Abi, functionName: 'swap', args: [{ pool: getAddress(POOL_BTC), tokenIn: getAddress(BASE_USDC), amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: limit, deadline: now + 2_000n }] }))
    const noAssert = [clock, approve(amountIn), v4swap, approve(0n)]
    expect(checkA1Batch(noAssert, { chainId: 8453, account: home, policy: D.policy }).ok).toBe(false) // the TypeScript twin refuses it too
    let r = await engineOp(lab, baseBundler, home, homePid, SESSION_KEY, 'swap', [], { callData: a1CallData(noAssert) })
    expect(r.included).toBe(false)
    // MamoruGasPolicyV2's batch shape refuses it: SmartSession reverts with the gas policy named
    let why = await sessionVerdict(lab, r.op, baseReg)
    expect(why).toBe(`PolicyViolation(${getAddress(D.gasPolicy)})`)
    kinds.push(`refused, approve without assertZero: ${r.failedOp?.reason}, SmartSession ${why}`)
    // decreaseLiquidity (and collect) without the checkExit right before it
    const [, , , , , , , liq] = await lab.client.readContract({ address: BASE_NPM, abi: npmAbi, functionName: 'positions', args: [tokenId] })
    const [m0, m1] = await exitMins(home, tokenId, liq / 2n)
    const full = buildA1CallData({ chainId: 8453, account: home, policy: D.policy, t: now }, [{ kind: 'decrease', tokenId, liquidity: liq / 2n, amount0Min: m0, amount1Min: m1, deadline: now + 2_000n }]).calls
    expect(full[1]!.callData.slice(0, 10)).toBe(encodeFunctionData({ abi: a1Abi, functionName: 'checkExit', args: [tokenId, liq / 2n, m0, m1] }).slice(0, 10))
    const noCheckExit = [full[0]!, ...full.slice(2)]
    expect(checkA1Batch(noCheckExit, { chainId: 8453, account: home, policy: D.policy }).ok).toBe(false)
    r = await engineOp(lab, baseBundler, home, homePid, SESSION_KEY, 'exit', [], { callData: a1CallData(noCheckExit) })
    expect(r.included).toBe(false)
    why = await sessionVerdict(lab, r.op, baseReg)
    expect(why).toBe(`PolicyViolation(${getAddress(D.gasPolicy)})`)
    kinds.push(`refused, decreaseLiquidity without checkExit: ${r.failedOp?.reason}, SmartSession ${why}`)
    // nothing ran: no nonce spent, no USDC moved, the position untouched
    expect(await lab.entryPointNonce(home, sessionNonceKey(0, address('SmartSession', baseReg)))).toBe(nonce0)
    expect(await bal(lab, BASE_USDC, home)).toBe(usdc0)
    const [, , , , , , , liqAfter] = await lab.client.readContract({ address: BASE_NPM, abi: npmAbi, functionName: 'positions', args: [tokenId] })
    expect(liqAfter).toBe(liq)
  }, LONG)

  test('6. engine exits: reduce (checkExit + decrease + collect), then re-range exit (checkExit + decrease all + collect + burn)', async () => {
    const lab = base.lab
    const [, , , , , , , liq] = await lab.client.readContract({ address: BASE_NPM, abi: npmAbi, functionName: 'positions', args: [tokenId] })
    const half = liq / 2n
    let [m0, m1] = await exitMins(home, tokenId, half)
    const usdc0 = await bal(lab, BASE_USDC, home)
    await engineOk('exit', [{ kind: 'decrease', tokenId, liquidity: half, amount0Min: m0, amount1Min: m1, deadline: await deadline() }], 'reduce half (checkExit + decrease + collect)')
    expect(await bal(lab, BASE_USDC, home)).toBeGreaterThanOrEqual(usdc0 + m0)
    const [, , , , , , , rest] = await lab.client.readContract({ address: BASE_NPM, abi: npmAbi, functionName: 'positions', args: [tokenId] })
    expect(rest).toBe(liq - half)
    // the builder refuses a burn that does not take the whole position out (the manager would revert it)
    expect(() => buildA1CallData({ chainId: 8453, account: home, policy: D.policy, t: 1_900_000_000n }, [{ kind: 'decrease', tokenId, liquidity: rest - 1n, amount0Min: 0n, amount1Min: 0n, deadline: 1_900_001_000n, burn: true, positionLiquidity: rest }])).toThrow()
    ;[m0, m1] = await exitMins(home, tokenId, rest)
    await engineOk('exit', [{ kind: 'decrease', tokenId, liquidity: rest, amount0Min: m0, amount1Min: m1, deadline: await deadline(), burn: true, positionLiquidity: rest }], 're-range exit (checkExit + decrease all + collect + burn)')
    expect(await lab.client.readContract({ address: BASE_NPM, abi: npmAbi, functionName: 'balanceOf', args: [home] })).toBe(0n)
  }, LONG)

  test('7. readiness across chains: registerRemote (Base, lane 1), then the operators\' flow: announceReady (Monad), iris, relayMessage (Base), isReady', async () => {
    const remoteSk = privateKeyToAccount(REMOTE_SESSION_KEY).address
    // Base: the operator's lane-1 sender registers the Monad remote
    expect(await (baseOp as unknown as Lane1).sendV4SessionOp(homeAcc, [{ kind: 'registerRemote', domain: DOMAIN_MONAD, sessionKey: remoteSk }])).not.toBeNull()
    kinds.push(`registerRemote (lane 1): gas cost ${baseBundler.last?.actualGasCost} wei`)
    const reg = await base.lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'remoteOf', args: [home, DOMAIN_MONAD] })
    // the TypeScript derivation of the remote (what the relayer deploys) is the address V4 computed from the current owners
    const owners = ownerStateOf([address('SafeWebAuthnSharedSigner', baseReg), owner.address], webAuthnSigner(PASSKEY.x, PASSKEY.y, baseReg), baseReg)
    const r = v4Remote({ home, owners, domain: DOMAIN_MONAD, homeDomain: DOMAIN_BASE, sessionKey: remoteSk, capUsd: C, deployment: D, registry: monadReg })
    expect(reg.remote).toBe(r.address)
    expect(reg.ownersHash).toBe(r.ownersHash)
    remote = r.address
    // no burn towards it before it is proven ready: the operator's simulation (eth_call from the EntryPoint) reverts
    const t = (await base.lab.client.getBlock()).timestamp
    const bridge = buildA1CallData({ chainId: 8453, account: home, policy: D.policy, t }, [{ kind: 'bridge', domain: DOMAIN_MONAD, token: BASE_USDC, amount: 100_000_000n, maxFee: 0n }]).callData
    await expect(base.lab.client.call({ account: address('EntryPointV07', baseReg), to: home, data: bridge })).rejects.toThrow()
    expect(await base.lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'isReady', args: [home, DOMAIN_MONAD] })).toBe(false)
    // Monad: anyone deploys the remote with its own initializer; it reads back bound to its home
    expect((await monad.lab.send(devAccount(3), r.createCall.to, r.createCall.data, 0n, 5_000_000n)).ok).toBe(true)
    expect(await monad.lab.client.readContract({ address: remote, abi: safeAbi, functionName: 'getOwners' })).toEqual(owners.owners)
    const rc = await monad.lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'configOf', args: [remote] })
    expect([rc.home, rc.homeDomain, rc.capUsd]).toEqual([home, DOMAIN_BASE, C])
    expect(await monad.lab.client.readContract({ address: address('SmartSession', monadReg), abi: smartSessionV4Abi, functionName: 'isPermissionEnabled', args: [r.permissionId, remote] })).toBe(true)
    await monad.lab.setBalance(remote, 10n ** 19n)
    // Monad's basefee floor is 100 gwei; the operator's ceiling there is 102 (V4_MAX_FEE_BY_CHAIN): mine at the floor first
    await monad.lab.rpc('anvil_setNextBlockBaseFeePerGas', [toHex(100_000_000_000n)])
    await monad.lab.rpc('evm_mine')
    // The operators' own readiness flow (#348), not hand-built intents: the Base operator's step (stepRemoteReady, what
    // oneAuthRemote runs every minute once the remote is provisioned) asks the Monad operator (announceRemote, its
    // `POST remote-announce`, here called in process) to announce from the remote's own session; Circle's iris is stood in
    // by a fake that reads the MessageSent of the transaction it is asked about on the Monad fork and signs it as the test
    // attester; the Base operator checks it (V4's message shape, Base's enabled attesters) and relays it from the home's
    // own session (lane 1).
    const remoteAcc = v4Account('home.v4', remote, 143, REMOTE_SESSION_KEY, r.permissionId, V4_REMOTE_SESSION_SALT, D, monadReg)
    remoteAcc.policyId = ONE_AUTH_V4_REMOTE
    const remoteCtx = { accountKey: 'home.v4', chainId: 143, address: remote, owners: owners.owners, saltNonce: '0', passkey: PASSKEY, remote: { chainId: 143, policyId: ONE_AUTH_V4_REMOTE, sessionKey: remoteSk, validAfter: 0, validUntil: 0, capUsdc: C.toString(), home, homeDomain: DOMAIN_BASE } } as unknown as AccountContext
    remoteAcc.ctx = remoteCtx
    ;(monadOp as unknown as { store: StateStore }).store.state.accounts['home.v4'] = remoteAcc
    ;(monadOp as unknown as { cfg: OperatorConfig }).cfg.homeClient = base.lab.client
    ;(baseOp as unknown as { store: StateStore }).store.state.accounts[homeAcc.accountKey] = homeAcc
    const attested: { message?: Hex; sent?: Hex } = {}
    ;(baseOp as unknown as { cfg: OperatorConfig }).cfg.irisFetch = async (url: string) => {
      const m = /\/v2\/messages\/(\d+)\?transactionHash=(0x[0-9a-fA-F]{64})$/.exec(url)
      expect(m?.[1]).toBe(String(DOMAIN_MONAD))
      const receipt = await monad.lab.client.getTransactionReceipt({ hash: m![2] as Hex })
      const sent = parseEventLogs({ abi: transmitterAbi, logs: receipt.logs, eventName: 'MessageSent' }).filter((l) => isAddressEqual(l.address, MESSAGE_TRANSMITTER))
      expect(sent).toHaveLength(1)
      attested.sent = sent[0]!.args.message
      attested.message ??= attestable(attested.sent, 2000)
      const attestation = await attest(base.lab, attested.message)
      return new Response(JSON.stringify({ messages: [{ status: 'complete', message: attested.message, attestation }] }), { status: 200 })
    }
    const peer = {
      key: async () => remoteSk,
      provision: async () => ({ state: 'active' as const, address: remote }),
      announce: (ctx: AccountContext, again?: Hex) => monadOp.announceRemote(ctx, again ? { again } : {}),
    }
    const monadOps = () => monadBundler.count
    const baseOps = () => baseBundler.count
    const [monad0, base0] = [monadOps(), baseOps()]
    const step = () => (baseOp as unknown as { stepRemoteReady(a: AccountState, c: AccountContext, p: typeof peer): Promise<void> }).stepRemoteReady(homeAcc, remoteCtx, peer)
    const states: string[] = []
    for (let i = 0; i < 8 && !(await base.lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'isReady', args: [home, DOMAIN_MONAD] })); i++) {
      await step()
      states.push(homeAcc.oneAuth?.remoteReady?.state ?? 'none')
      await monad.lab.rpc('evm_mine')
      await base.lab.rpc('evm_mine')
    }
    kinds.push(`readiness flow states on Base: ${states.join(' -> ')}`)
    // one announce on Monad (the remote's own session), one relay on Base (the home's), nothing else
    expect([monadOps() - monad0, baseOps() - base0]).toEqual([1, 1])
    expect(homeAcc.oneAuth?.remoteReady?.state).toBe('relayed')
    expect(remoteAcc.readyAnnounce?.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    kinds.push(`announceReady on Monad (operator flow, lane 1): tx ${remoteAcc.readyAnnounce?.txHash}`)
    const message = attested.sent!
    // the CCTP V2 header: Monad -> Base, sender and recipient the same V4, open destination caller, finality 2000
    const word = (o: number, n: number) => BigInt(`0x${message.slice(2 + 2 * o, 2 + 2 * (o + n))}`)
    expect([word(4, 4), word(8, 4), word(44, 32), word(76, 32), word(108, 32), word(140, 4)]).toEqual([BigInt(DOMAIN_MONAD), BigInt(DOMAIN_BASE), BigInt(D.policy), BigInt(D.policy), 0n, 2000n])
    const [bh, bs, bo] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], `0x${message.slice(2 + 2 * 148)}`)
    expect([bh, bs, bo]).toEqual([home, remote, r.ownersHash])
    // no double announce: once ready, neither side sends anything again (Base reads it ready; Monad answers the same tx)
    await step()
    expect(homeAcc.oneAuth?.remoteReady).toBeUndefined() // the next step reads it ready: the flow ends, nothing sent
    expect(await monadOp.announceRemote(remoteCtx, {})).toEqual({ state: 'announced', txHash: remoteAcc.readyAnnounce!.txHash! })
    expect([monadOps() - monad0, baseOps() - base0]).toEqual([1, 1])
    expect(await base.lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'isReady', args: [home, DOMAIN_MONAD] })).toBe(true)
    const ready = await base.lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'readyOf', args: [home, DOMAIN_MONAD] })
    expect([ready.remote, ready.ownersHash]).toEqual([remote, r.ownersHash])
  }, LONG)

  test('8. engine bridge to the ready remote with maxFee at the CCTP cap (10 bps), charged to the account limits', async () => {
    const lab = base.lab
    const amount = 100_000_000n
    const cap = (amount * CCTP_FEE_CAP_BPS) / 10_000n
    expect(() => buildA1CallData({ chainId: 8453, account: home, policy: D.policy, t: 1_900_000_000n }, [{ kind: 'bridge', domain: DOMAIN_MONAD, token: BASE_USDC, amount, maxFee: cap + 1n }])).toThrow(/cap/)
    const [, , m0, d0] = await lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'budgetLeft', args: [home, TOKEN_MESSENGER, 10_000] })
    const usdc0 = await bal(lab, BASE_USDC, home)
    const receipt = await engineOk('bridge', [{ kind: 'bridge', domain: DOMAIN_MONAD, token: BASE_USDC, amount, maxFee: cap }], 'bridge 100 USDC to the Monad remote, maxFee at the cap')
    expect(await bal(lab, BASE_USDC, home)).toBe(usdc0 - amount)
    const bridged = parseEventLogs({ abi: v4EventsAbi, logs: receipt.logs, eventName: 'Bridged' }).filter((l) => isAddressEqual(l.address, D.policy))
    expect(bridged.map((l) => [l.args.account, l.args.domain, l.args.recipient, l.args.amount])).toEqual([[home, DOMAIN_MONAD, remote, amount]])
    const recipientWord = pad(remote).toLowerCase().slice(2)
    expect(receipt.logs.some((l) => isAddressEqual(l.address, TOKEN_MESSENGER) && l.data.toLowerCase().includes(recipientWord))).toBe(true) // mintRecipient: the remote
    // the 30-day and 24 h caps are charged the fee ceiling exactly; the bucket too, but it refills with time between reads
    const [b1, , m1, d1] = await lab.client.readContract({ address: D.policy, abi: mamoruActionPolicyV4Abi, functionName: 'budgetLeft', args: [home, TOKEN_MESSENGER, 10_000] })
    expect([m0 - m1, d0 - d1]).toEqual([cap, cap])
    expect(b1).toBeLessThan(C)
  }, LONG)

  test('9. the owner exits with no Mamoru service: the recovery key removes the session and withdraws through the Safe', async () => {
    const lab = base.lab
    await lab.setBalance(owner.address, 10n ** 18n)
    expect(await ownerExec(lab, home, address('SmartSession', baseReg), encodeFunctionData({ abi: smartSessionAdminAbi, functionName: 'removeSession', args: [homePid] }))).toBe(true)
    expect(await lab.client.readContract({ address: address('SmartSession', baseReg), abi: smartSessionV4Abi, functionName: 'isPermissionEnabled', args: [homePid, home] })).toBe(false)
    expect(await lab.client.readContract({ address: address('SmartSession', baseReg), abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [home] })).toEqual([])
    for (const token of [BASE_USDC, BASE_CBBTC]) {
      const amount = await bal(lab, token, home)
      if (amount === 0n) continue
      const before = await bal(lab, token, owner.address)
      expect(await ownerExec(lab, home, token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner.address, amount] }))).toBe(true)
      expect(await bal(lab, token, home)).toBe(0n)
      expect(await bal(lab, token, owner.address)).toBe(before + amount)
    }
    // the session key can do nothing more: its next op is refused at validation
    const amountIn = 1_000_000n
    await setUsdc(lab, home, amountIn)
    const r = await engineOp(lab, baseBundler, home, homePid, SESSION_KEY, 'swap', [await swapIntent(amountIn)])
    expect(r.included).toBe(false)
    expect(r.failedOp?.name).toMatch(/FailedOp/)
    kinds.push(`refused, session op after the owner's Stop: ${r.failedOp?.reason}, SmartSession ${await sessionVerdict(lab, r.op, baseReg)}`)
  }, LONG)
})
