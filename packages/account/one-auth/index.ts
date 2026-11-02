// otto/mamoru#293, spec 010 (one authorization): the TypeScript side of MamoruActionPolicyV4.
//  - `v4Session`: the account's ONE session per chain (a fallback action, V4 its only action policy, MamoruGasPolicyV2
//    its only userOp policy), owner-signed once.
//  - `v4CreateSetup`: a new account whose Safe setup enables that session (SmartSession UNSAFE_ENABLE, as design C's
//    remote Safes do): the create IS the authorization, one owner act.
//  - `v4Remote`: the TS twin of MamoruV4Helper.remote, the canonical remote Safe V4 computes for an account on a domain
//    (contracts/action-policy/test/V4RemoteInitParity.t.sol checks it byte for byte).
//  - `migrationCalls`: the owner's one migration transaction (results/t2-t4-contracts-2026-11-02.md section 7).
//  - `inventoryOf`: the permission ids that transaction removes and revokes, from SmartSession's own events, its
//    enumeration and the operator's records; any disagreement fails closed.
// Owner signatures stay Safe transaction hashes only (SECURITY.md: Mamoru never asks the passkey to sign a SmartSession
// ENABLE payload; packages/account/sessions/no-enable-mode.test.ts).
import { concat, encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, getContractAddress, hashTypedData, isAddressEqual, keccak256, pad, parseAbi, parseAbiItem, size, toHex, zeroAddress, type Hex, type PublicClient } from 'viem'
import type { Address, MigrateV4Input } from '@mamoru/domain'
import { address, moduleRegistryAbi, multiSendCallOnlyAbi, safeAbi, safeProxyFactoryAbi, safeWebAuthnSharedSignerAbi, smartSessionAbi, type Registry } from '@mamoru/registry'
import { encodeGasCapsV2, encodeInitV4, GAS_CAPS_V2_BY_CHAIN, oneAuthV4Deployment, V4_CHAIN_BY_DOMAIN, type GasCapsV2, type InitV4, type OneAuthV4Deployment } from '@mamoru/policy'
import { accountSetup, counterfactualAddress, SAFE_PROXY_141_CREATION_CODE } from '../recovery/index.ts'
import { multiSendCallOnly, OPERATION_DELEGATECALL, safeTxTypedData, type MultiSendCall, type SafeSetup, type WebAuthnSigner } from '../safe/index.ts'
import { ATTESTATION_SCHEMA_UID, ownableValidatorInitData, permissionIdOf, type SmartSessionStruct } from '../sessions/index.ts'

/** SmartSession FALLBACK_TARGET_FLAG / FALLBACK_TARGET_SELECTOR_FLAG (MamoruV4Helper.FALLBACK_TARGET/_SELECTOR). */
export const FALLBACK_TARGET: Address = '0x0000000000000000000000000000000000000001'
export const FALLBACK_SELECTOR: Hex = '0x00000001'
/** MamoruV4Helper.REMOTE_SESSION_SALT = keccak256("mamoru.v4.remote-session"). */
export const V4_REMOTE_SESSION_SALT: Hex = keccak256(toHex('mamoru.v4.remote-session'))
/** The home session's salt per generation (one generation per account in practice: V4 accounts never renew). */
export function v4HomeSessionSalt(generation: bigint): Hex {
  return keccak256(encodePacked(['string', 'uint64'], ['mamoru.v4.home-session', generation]))
}

/** SmartSession's own views and calls the migration uses (deployed 0x00000000002B0eCf..., used by the contracts' fork tests). */
export const smartSessionV4Abi = parseAbi([
  'function getPermissionIDs(address account) view returns (bytes32[])',
  'function getNonce(bytes32 permissionId, address account) view returns (uint256)',
  'function revokeEnableSignature(bytes32 permissionId)',
  'function isPermissionEnabled(bytes32 permissionId, address account) view returns (bool)',
])
/** ISmartSession: `event SessionCreated(PermissionId permissionId, address account)`, neither indexed. */
export const SESSION_CREATED_EVENT = parseAbiItem('event SessionCreated(bytes32 permissionId, address account)')

export const migrationCheckAbi = parseAbi([
  'function assertMigrated(address account, bytes32[] keep, bytes32[] old, uint256[] noncesBefore) view',
  'function assertNone(address account, bytes32[] ids) view',
  'function assertOnly(address account, bytes32[] keep) view',
])

export const mamoruActionPolicyV4Abi = parseAbi([
  'struct SwapParams { address pool; address tokenIn; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; uint256 deadline; }',
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct Remote { address remote; uint96 capUsd; bytes32 ownersHash; address sessionKey; }',
  'struct Ready { address remote; bytes32 ownersHash; }',
  'struct Config { uint128 capUsd; uint64 generation; uint32 homeDomain; bool set; address home; bytes32 initHash; }',
  'function swap(SwapParams s) returns (uint256 amountOut)',
  'function mint(MintParams m) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increase(IncreaseLiquidityParams n) returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function deposit(address vault, uint256 assets) returns (uint256 shares)',
  'function redeem(address vault, uint256 shares) returns (uint256 assets)',
  'function bridge(uint32 domain, address token, uint256 amount)',
  'function registerRemote(uint32 domain, address sessionKey) returns (address remote)',
  'function setReady(address account, uint32 domain, address remote)',
  'function remoteOf(address account, uint32 domain) view returns (Remote)',
  'function readyOf(address account, uint32 domain) view returns (Ready)',
  'function isReady(address account, uint32 domain) view returns (bool)',
  'function isPaused(address account) view returns (bool)',
  'function configOf(address account) view returns (Config)',
  'function generationOf(address account) view returns (uint64)',
  'function admittedPool(address account, uint256 tokenId) view returns (address)',
  'function HELPER() view returns (address)',
  'function REMOTE_INIT() view returns (address)',
  'function GUARDIAN() view returns (address)',
  'function REGISTRY() view returns (address)',
  'event RemoteRegistered(address indexed account, uint32 indexed domain, address remote, bytes32 ownersHash, address sessionKey)',
  'event RemoteReady(address indexed account, uint32 indexed domain, address remote, bytes32 ownersHash)',
  'event Bridged(address indexed account, uint32 indexed domain, address indexed recipient, address token, uint256 amount)',
  'event Paused(address indexed account, uint8 reasons, uint64 generation)',
])

export const mamoruV4HelperAbi = parseAbi([
  'function remote(address account, uint32 domain, address sessionKey, uint128 capUsd, uint32 homeDomain) view returns (address at, bytes32 ownersHash, bytes createCall)',
  'function remoteDeployment(address account, uint32 domain) view returns (address at, bytes createCall)',
  'function ownersHashOf(address account) view returns (bytes32)',
])

export const mamoruRegistryAbi = parseAbi([
  'struct PoolEntry { uint32 twapWindow; uint32 twapShortWindow; uint24 bandTicks; int24 anchorTick; uint24 anchorBand; uint16 ratioBps; bool active; }',
  'struct VaultEntry { uint16 ratioBps; bool active; }',
  'function activePools() view returns (address[])',
  'function activeVaults() view returns (address[])',
  'function poolOf(address pool) view returns (PoolEntry)',
  'function vaultOf(address vault) view returns (VaultEntry)',
  'function routeOn(uint32 domain) view returns (bool)',
  'function queue(uint8 kind, bytes32 key, bytes params) returns (bytes32 id)',
  'function execute(uint8 kind, bytes32 key, bytes params, uint256 n)',
  'function cancel(bytes32 id)',
  'function DELAY() view returns (uint256)',
  'event Queued(bytes32 indexed id, uint8 indexed kind, bytes32 indexed key, bytes params, uint256 nonce, uint256 eta)',
  'event Executed(bytes32 indexed id, uint8 indexed kind, bytes32 indexed key, bytes params)',
  'event Cancelled(bytes32 indexed id, address indexed by)',
])

const SESSIONS_PARAM = smartSessionAbi.find((f) => f.type === 'function' && f.name === 'enableSessions')!.inputs
const remoteInitAbi = parseAbi(['function init(bytes sessions)'])
const erc20TransferAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

// ---- the session ------------------------------------------------------------------------------------------------

export type V4SessionInput = {
  sessionKey: Address
  deployment: Pick<OneAuthV4Deployment, 'policy' | 'gasPolicy'>
  init: InitV4
  /** MamoruGasPolicyV2.Caps; default the chain's (GAS_CAPS_V2_BY_CHAIN). */
  gasCaps?: GasCapsV2
  salt: Hex
  registry: Registry
}

/** The one V4 session: fallback action, V4 the only action policy (InitV4), MamoruGasPolicyV2 the only userOp policy. */
export function v4Session(input: V4SessionInput): SmartSessionStruct {
  const caps = input.gasCaps ?? GAS_CAPS_V2_BY_CHAIN[input.registry.chainId]
  if (!caps) throw new Error(`v4Session: no MamoruGasPolicyV2 caps for chain ${input.registry.chainId}`)
  return {
    sessionValidator: address('OwnableValidator', input.registry),
    sessionValidatorInitData: ownableValidatorInitData(input.sessionKey),
    salt: input.salt,
    userOpPolicies: [{ policy: input.deployment.gasPolicy, initData: encodeGasCapsV2(caps) }],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: [{ actionTargetSelector: FALLBACK_SELECTOR, actionTarget: FALLBACK_TARGET, actionPolicies: [{ policy: input.deployment.policy, initData: encodeInitV4(input.init) }] }],
    permitERC4337Paymaster: false,
  }
}

/** The home account's session at `generation` (home = 0: this IS the home). */
export function v4HomeSession(p: { sessionKey: Address; deployment: Pick<OneAuthV4Deployment, 'policy' | 'gasPolicy'>; capUsd: bigint; generation: bigint; admit: readonly bigint[]; registry: Registry }): SmartSessionStruct {
  return v4Session({ sessionKey: p.sessionKey, deployment: p.deployment, init: { capUsd: p.capUsd, generation: p.generation, home: zeroAddress, homeDomain: 0, admit: p.admit }, salt: v4HomeSessionSalt(p.generation), registry: p.registry })
}

/**
 * A new account on V4 (setup mode): the Safe's setup installs SmartSession with the V4 session enabled (UNSAFE_ENABLE),
 * so the address commits to it and creating the account is the owner's only authorization. V4's Init reads no market
 * state (only code hashes; no admitted positions at creation), so the same setup deploys on any later day.
 */
export function v4CreateSetup(owners: Address[], saltNonce: bigint, webauthn: WebAuthnSigner | null, session: SmartSessionStruct, registry: Registry): { setup: SafeSetup; address: Address; permissionId: Hex } {
  const setup = accountSetup(owners, saltNonce, webauthn, registry, [session])
  return { setup, address: counterfactualAddress(setup, registry), permissionId: permissionIdOf(session) }
}

// ---- the remote Safe (MamoruV4Helper.remote) -------------------------------------------------------------------

/** V4's constructor creates MamoruRemoteInit (nonce 1) then MamoruV4Helper (nonce 2): their addresses follow from V4's. */
export function v4Children(policy: Address): { remoteInit: Address; helper: Address } {
  return { remoteInit: getContractAddress({ from: policy, nonce: 1n }), helper: getContractAddress({ from: policy, nonce: 2n }) }
}

/** The home account's owner state as V4 reads it on chain (MamoruRemoteSafe.OwnerState): owners in Safe order, threshold, passkey. */
export type V4OwnerState = { owners: readonly Address[]; threshold: bigint; x: bigint; y: bigint; verifiers: bigint }

/** MamoruRemoteSafe.ownersHash. */
export function v4OwnersHash(o: V4OwnerState): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint176' }], [[...o.owners], o.threshold, o.x, o.y, o.verifiers]))
}

/** The owner state of an account context: its owners, threshold 1 and its passkey when the shared signer is an owner. */
export function ownerStateOf(owners: readonly Address[], webauthn: WebAuthnSigner | null, registry: Registry, threshold = 1n): V4OwnerState {
  const shared = address('SafeWebAuthnSharedSigner', registry)
  const withPasskey = owners.some((o) => isAddressEqual(o, shared))
  if (withPasskey && !webauthn) throw new Error('ownerStateOf: the shared signer is an owner but no passkey was given')
  return { owners: owners.map((o) => getAddress(o)), threshold, x: withPasskey ? webauthn!.x : 0n, y: withPasskey ? webauthn!.y : 0n, verifiers: withPasskey ? webauthn!.verifiers : 0n }
}

export type V4RemoteInput = {
  /** The home account (its Init's `home`). */
  home: Address
  /** The home account's owner state NOW (V4 reads it at registerRemote). */
  owners: V4OwnerState
  /** CCTP domain of the remote chain, and of the home chain. */
  domain: number
  homeDomain: number
  sessionKey: Address
  /** The home's C at registration (InitV4.capUsd of the home session). */
  capUsd: bigint
  deployment: Pick<OneAuthV4Deployment, 'policy' | 'gasPolicy'>
  /** The remote chain's registry (Safe stack, SmartSession, OwnableValidator: canonical addresses). */
  registry: Registry
}

export type V4Remote = {
  chainId: number
  address: Address
  ownersHash: Hex
  saltNonce: bigint
  initializer: Hex
  /** The relayer's permissionless call: SafeProxyFactory 1.4.1 createProxyWithNonce. */
  createCall: { to: Address; data: Hex }
  session: SmartSessionStruct
  permissionId: Hex
  /** `abi.encode(Session[1])`, MamoruRemoteInit.init's argument. */
  sessions: Hex
}

/** MamoruV4Helper.sessions: the remote's one session (generation 1, home = the account, admit none), the destination's pinned gas caps. */
export function v4RemoteSession(input: Pick<V4RemoteInput, 'home' | 'homeDomain' | 'sessionKey' | 'capUsd' | 'deployment' | 'registry'> & { chainId: number }): SmartSessionStruct {
  const caps = GAS_CAPS_V2_BY_CHAIN[input.chainId]
  if (!caps) throw new Error(`v4RemoteSession: chain ${input.chainId} is not in V4's table`)
  return v4Session({ sessionKey: input.sessionKey, deployment: input.deployment, init: { capUsd: input.capUsd, generation: 1n, home: input.home, homeDomain: input.homeDomain, admit: [] }, gasCaps: caps, salt: V4_REMOTE_SESSION_SALT, registry: input.registry })
}

/** One MultiSend 1.4.1 entry, a delegatecall with no value (MamoruRemoteSafe.entry). */
function delegateEntry(to: Address, data: Hex): Hex {
  return encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [OPERATION_DELEGATECALL, to, 0n, BigInt(size(data)), data])
}

/** MamoruRemoteSafe.initializer: Safe.setup with MamoruRemoteInit.init as the setup delegatecall (through MultiSend with the passkey's configure). */
export function v4RemoteInitializer(o: V4OwnerState, remoteInit: Address, sessions: Hex, registry: Registry): Hex {
  const init = encodeFunctionData({ abi: remoteInitAbi, functionName: 'init', args: [sessions] })
  const shared = address('SafeWebAuthnSharedSigner', registry)
  let to = remoteInit
  let data = init
  if (o.owners.some((x) => isAddressEqual(x, shared))) {
    if (o.x === 0n && o.y === 0n) throw new Error('v4RemoteInitializer: passkey owner without a configured passkey (V4 PasskeyNotConfigured)')
    const cfg = encodeFunctionData({ abi: safeWebAuthnSharedSignerAbi, functionName: 'configure', args: [{ x: o.x, y: o.y, verifiers: o.verifiers }] })
    to = address('MultiSend_141', registry)
    data = encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName: 'multiSend', args: [concat([delegateEntry(remoteInit, init), delegateEntry(shared, cfg)])] })
  }
  return encodeFunctionData({ abi: safeAbi, functionName: 'setup', args: [[...o.owners], o.threshold, to, data, address('Safe7579', registry), zeroAddress, 0n, zeroAddress] })
}

/** The canonical remote Safe V4 computes (MamoruV4Helper.remote): address, owners hash and the relayer's factory call. */
export function v4Remote(input: V4RemoteInput): V4Remote {
  const chainId = V4_CHAIN_BY_DOMAIN[input.domain]
  if (!chainId) throw new Error(`v4Remote: domain ${input.domain} is not in V4's table`)
  if (input.registry.chainId !== chainId) throw new Error(`v4Remote: registry of chain ${input.registry.chainId}, domain ${input.domain} is chain ${chainId}`)
  const { remoteInit } = v4Children(input.deployment.policy)
  const ownersHash = v4OwnersHash(input.owners)
  const session = v4RemoteSession({ ...input, chainId })
  const sessions = encodeAbiParameters(SESSIONS_PARAM, [[session] as never])
  const initializer = v4RemoteInitializer(input.owners, remoteInit, sessions, input.registry)
  const saltNonce = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint32' }, { type: 'bytes32' }], [getAddress(input.home), input.domain, ownersHash])))
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), saltNonce]))
  const at = getContractAddress({ opcode: 'CREATE2', from: address('SafeProxyFactory_141', input.registry), salt, bytecode: concat([SAFE_PROXY_141_CREATION_CODE, pad(address('SafeL2_141', input.registry))]) })
  return {
    chainId,
    address: at,
    ownersHash,
    saltNonce,
    initializer,
    createCall: { to: address('SafeProxyFactory_141', input.registry), data: encodeFunctionData({ abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', args: [address('SafeL2_141', input.registry), initializer, saltNonce] }) },
    session,
    permissionId: permissionIdOf(session),
    sessions,
  }
}

// ---- the migration (v2-v6 -> V4) -------------------------------------------------------------------------------

export type MigrationInput = {
  account: Address
  /** Old permission ids still enabled: each one is removed. */
  remove: readonly Hex[]
  /** Every old permission id known (superset, enabled or not): each one's ENABLE signature is revoked. */
  revoke: readonly Hex[]
  /** SmartSession.getNonce(id, account) for each `revoke` id, read when the transaction is built. */
  noncesBefore: readonly bigint[]
  session: SmartSessionStruct
  deployment: OneAuthV4Deployment
  /** What the registry stores for the self-attestation: unique per prepare (a re-attestation of the same bytes reverts). */
  attestData: Hex
  /** Calls placed after the V4 enable and before the check (a design-C remote's transfer of its funds). */
  extra?: readonly MultiSendCall[]
  registry: Registry
}

/**
 * The owner's ONE migration transaction, in the order the contracts' fork test runs it (results file, section 7):
 * removeSession for every enabled old id; revokeEnableSignature for every old id; trust the Rhinestone attester and the
 * Safe itself and self-attest V4 and MamoruGasPolicyV2; enableSessions([the V4 session]); then
 * MamoruMigrationCheck.assertMigrated(account, [V4 id], old ids, nonces before), which reverts the whole Safe tx unless V4
 * is the only session enabled and every old ENABLE nonce moved.
 */
export function migrationCalls(m: MigrationInput): MultiSendCall[] {
  if (m.revoke.length !== m.noncesBefore.length) throw new Error('migrationCalls: one nonce per revoked id')
  const revokeSet = new Set(m.revoke.map((x) => x.toLowerCase()))
  for (const id of m.remove) if (!revokeSet.has(id.toLowerCase())) throw new Error(`migrationCalls: ${id} is removed but not revoked`)
  const smart = address('SmartSession', m.registry)
  const reg = address('ModuleRegistry', m.registry)
  const v4Id = permissionIdOf(m.session)
  if (revokeSet.has(v4Id.toLowerCase())) throw new Error('migrationCalls: the V4 session id is among the old ids')
  const attesters = [address('RhinestoneAttester', m.registry), m.account].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  return [
    ...m.remove.map((id) => ({ to: smart, value: 0n, data: encodeFunctionData({ abi: smartSessionAbi, functionName: 'removeSession', args: [id] }) })),
    ...m.revoke.map((id) => ({ to: smart, value: 0n, data: encodeFunctionData({ abi: smartSessionV4Abi, functionName: 'revokeEnableSignature', args: [id] }) })),
    { to: reg, value: 0n, data: encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'trustAttesters', args: [1, attesters] }) },
    {
      to: reg,
      value: 0n,
      data: encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'attest', args: [ATTESTATION_SCHEMA_UID, [m.deployment.policy, m.deployment.gasPolicy].map((x) => ({ moduleAddress: x, expirationTime: 0, data: m.attestData, moduleTypes: [] }))] }),
    },
    { to: smart, value: 0n, data: encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableSessions', args: [[m.session as never]] }) },
    ...(m.extra ?? []),
    { to: m.deployment.migrationCheck, value: 0n, data: encodeFunctionData({ abi: migrationCheckAbi, functionName: 'assertMigrated', args: [m.account, [v4Id], [...m.revoke], [...m.noncesBefore]] }) },
  ]
}

/** `migrationCalls` as one Safe transaction (MultiSendCallOnly 1.4.1, delegatecall: every entry is a CALL from the Safe). */
export function migrationTx(m: MigrationInput): { to: Address; data: Hex; operation: 1; calls: MultiSendCall[]; permissionId: Hex } {
  const calls = migrationCalls(m)
  return { ...multiSendCallOnly(calls, m.registry), calls, permissionId: permissionIdOf(m.session) }
}

// ---- the inventory ---------------------------------------------------------------------------------------------

export type Inventory =
  | { ok: true; remove: Hex[]; revoke: Hex[] }
  | { ok: false; code: 'INVENTORY_MISMATCH'; detail: string; unknown: Hex[] }

/**
 * The ids the migration removes and revokes, or a refusal (no offer, an ops alert):
 * - `events`: every permission id SmartSession's SessionCreated named for the Safe;
 * - `enabled`: SmartSession.getPermissionIDs(account) now;
 * - `stored`: every id the operator's state has for the account (grants, revoked, superseded, owner ops).
 * Refused when an enabled id is missing from the events (the event read is incomplete) or from the operator's records
 * (a session Mamoru did not make: nothing tells what it is), or when the V4 id is already among them.
 * `remove` = enabled; `revoke` = events ∪ stored ∪ enabled (a superset: revoking an id that never had a payload only bumps a nonce).
 */
export function inventoryOf(p: { events: readonly Hex[]; enabled: readonly Hex[]; stored: readonly Hex[]; v4Id?: Hex }): Inventory {
  const norm = (xs: readonly Hex[]) => [...new Set(xs.map((x) => x.toLowerCase() as Hex))]
  const events = new Set(norm(p.events))
  const stored = new Set(norm(p.stored))
  const enabled = norm(p.enabled)
  if (p.v4Id && enabled.includes(p.v4Id.toLowerCase() as Hex)) return { ok: false, code: 'INVENTORY_MISMATCH', detail: 'the V4 session is already enabled', unknown: [p.v4Id] }
  const noEvent = enabled.filter((id) => !events.has(id))
  if (noEvent.length) return { ok: false, code: 'INVENTORY_MISMATCH', detail: `${noEvent.length} enabled session(s) with no SessionCreated event read`, unknown: noEvent }
  const notOurs = enabled.filter((id) => !stored.has(id))
  if (notOurs.length) return { ok: false, code: 'INVENTORY_MISMATCH', detail: `${notOurs.length} enabled session(s) Mamoru has no record of`, unknown: notOurs }
  const revoke = norm([...p.events, ...p.stored, ...p.enabled]).sort()
  return { ok: true, remove: enabled.sort(), revoke }
}

/**
 * Every permission id SmartSession's SessionCreated events name for `account` in [fromBlock, toBlock], in pages of
 * `pageBlocks` (the event has no indexed field: each page reads every SessionCreated of the chain and keeps the account's).
 */
export async function sessionCreatedIds(client: PublicClient, registry: Registry, account: Address, fromBlock: bigint, toBlock: bigint, pageBlocks = 2_000n, onPage?: (to: bigint) => void): Promise<Hex[]> {
  const out = new Set<Hex>()
  const smart = address('SmartSession', registry)
  for (let from = fromBlock; from <= toBlock; from += pageBlocks) {
    const to = from + pageBlocks - 1n > toBlock ? toBlock : from + pageBlocks - 1n
    const logs = await client.getLogs({ address: smart, event: SESSION_CREATED_EVENT, fromBlock: from, toBlock: to })
    for (const l of logs) if (l.args.account && isAddressEqual(l.args.account, account) && l.args.permissionId) out.add(l.args.permissionId.toLowerCase() as Hex)
    onPage?.(to)
  }
  return [...out]
}

/** SmartSession's enumeration and each id's ENABLE nonce, at `blockNumber`. */
export async function readSessionState(client: PublicClient, registry: Registry, account: Address, ids: readonly Hex[], blockNumber: bigint): Promise<{ enabled: Hex[]; nonces: bigint[] }> {
  const smart = address('SmartSession', registry)
  const enabled = (await client.readContract({ address: smart, abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [account], blockNumber })) as Hex[]
  const nonces = await Promise.all(ids.map((id) => client.readContract({ address: smart, abi: smartSessionV4Abi, functionName: 'getNonce', args: [id, account], blockNumber }) as Promise<bigint>))
  return { enabled: enabled.map((x) => x.toLowerCase() as Hex), nonces }
}

// ---- the one builder the operator prepares with and the Worker rebuilds with (#293 x #295) -----------------------

/**
 * Everything a migrate-v4 Safe transaction depends on, explicit and JSON-safe (integers as decimal strings). The operator
 * returns it with its prepare; the Worker rebuilds the transaction from it (`buildMigrateV4`) and compares hashes.
 * - `removeIds`: the old ids still enabled (removeSession each); `oldPermissionIds`: every old id known (revokeEnableSignature
 *   each, and assertMigrated's `old`), with `noncesBefore[i]` = SmartSession.getNonce(oldPermissionIds[i], safe) read when built.
 * - step 0 (home): `home` the zero address, `homeDomain` 0. Step 1 (a design-C Safe on Monad): `home` the Base account,
 *   `homeDomain` 6, and the funds it moves: `transfers` (ERC-20 `transfer` of `amount` of `token`) to `moveTo`.
 */
export type { MigrateV4Input } from '@mamoru/domain'

/** The Safe tx on the wire (OwnerTxToSign.safeTx): refund fields zero, gas token the zero address. */
export type WireSafeTx = { to: Address; value: string; data: Hex; operation: 0 | 1; safeTxGas: string; baseGas: string; gasPrice: string; gasToken: Address; refundReceiver: Address; nonce: string }

const ZERO: Address = '0x0000000000000000000000000000000000000000'
const dec = (s: string, what: string): bigint => {
  if (!/^[0-9]+$/.test(s)) throw new Error(`buildMigrateV4: ${what} is not a decimal integer`)
  return BigInt(s)
}

/**
 * The migrate-v4 Safe transaction of `input`, deterministic: the same input gives the same bytes and hash on any machine.
 * Every contract comes from `registry` (by default the chain's pinned registry json): MamoruActionPolicyV4,
 * MamoruGasPolicyV2, MamoruMigrationCheck, MultiSendCallOnly_141, SmartSession, ModuleRegistry, RhinestoneAttester,
 * OwnableValidator. The self-attestation's data is derived from (safe, safeNonce), so it is unique per Safe nonce.
 * Throws on any inconsistent input (it never builds something the operator would not prepare).
 */
export function buildMigrateV4(input: MigrateV4Input, registry: Registry): { safeTx: WireSafeTx; safeTxHash: Hex; calls: MultiSendCall[]; permissionId: Hex } {
  if (registry.chainId !== input.chainId) throw new Error(`buildMigrateV4: registry of chain ${registry.chainId}, input on ${input.chainId}`)
  const deployment = oneAuthV4Deployment(registry)
  if (!deployment) throw new Error(`buildMigrateV4: the V4 stack is not pinned on chain ${input.chainId}`)
  const remote = BigInt(input.home) !== 0n
  if (input.step === 0 && (remote || input.homeDomain !== 0 || input.moveTo || input.transfers?.length)) throw new Error('buildMigrateV4: step 0 is the home account: no home, no funds moved')
  if (input.step === 1 && (!remote || !V4_CHAIN_BY_DOMAIN[input.homeDomain] || V4_CHAIN_BY_DOMAIN[input.homeDomain] === input.chainId)) throw new Error('buildMigrateV4: step 1 names its home on another chain')
  if (!!input.transfers?.length !== !!input.moveTo) throw new Error('buildMigrateV4: transfers and moveTo go together')
  if (input.oldPermissionIds.length !== input.noncesBefore.length) throw new Error('buildMigrateV4: one nonce per old id')
  const safe = getAddress(input.safe)
  const init = { capUsd: dec(input.capUsdc, 'capUsdc'), generation: dec(input.generation, 'generation'), home: getAddress(input.home), homeDomain: input.homeDomain, admit: input.admit.map((a) => dec(a, 'admit')) }
  const session = v4Session({ sessionKey: getAddress(input.sessionKey), deployment, init, salt: remote ? V4_REMOTE_SESSION_SALT : v4HomeSessionSalt(init.generation), registry })
  const extra = (input.transfers ?? []).map((t) => {
    if (!registry.entries.some((e) => e.kind === 'token' && isAddressEqual(e.address, t.token))) throw new Error(`buildMigrateV4: ${t.token} is not a token of the ${registry.chain} registry`)
    return { to: getAddress(t.token), value: 0n, data: encodeFunctionData({ abi: erc20TransferAbi, functionName: 'transfer', args: [getAddress(input.moveTo!), dec(t.amount, 'amount')] }) }
  })
  const nonce = dec(input.safeNonce, 'safeNonce')
  const attestData = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }, { type: 'uint256' }], ['mamoru.v4.attest', safe, nonce]))
  const tx = migrationTx({ account: safe, remove: input.removeIds, revoke: input.oldPermissionIds, noncesBefore: input.noncesBefore.map((n) => dec(n, 'noncesBefore')), session, deployment, attestData, extra, registry })
  const safeTx: WireSafeTx = { to: tx.to, value: '0', data: tx.data, operation: tx.operation, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: nonce.toString() }
  const safeTxHash = hashTypedData(safeTxTypedData(safe, input.chainId, { to: tx.to, value: 0n, data: tx.data, operation: tx.operation, nonce }))
  return { safeTx, safeTxHash, calls: tx.calls, permissionId: tx.permissionId }
}
