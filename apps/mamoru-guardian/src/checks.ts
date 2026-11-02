// otto/mamoru#293, spec 010 I4: the readback the guardian does before it writes `readyOf`. Reads are injected, so the
// comparison is unit-testable; every read failure is a failed check (fail closed), and the result names the check.
// No error text is carried out: viem errors embed RPC URLs.
import { isAddressEqual, type Address, type Hex } from 'viem'
import { v4OwnersHash, v4Remote, type V4OwnerState } from '@mamoru/account/one-auth'
import { V4_DOMAIN_BY_CHAIN, type OneAuthV4Deployment } from '@mamoru/policy'
import { address, type Registry } from '@mamoru/registry'

export type Side = 'home' | 'remote'
export type Passkey = { x: bigint; y: bigint; verifiers: bigint }

export type CheckReads = {
  /** Bytecode at the remote address on the remote chain. */
  remoteCode(remote: Address): Promise<Hex | undefined>
  owners(side: Side, safe: Address): Promise<readonly Address[]>
  threshold(side: Side, safe: Address): Promise<bigint>
  /** SafeWebAuthnSharedSigner.getConfiguration(safe) on that side. */
  passkey(side: Side, safe: Address): Promise<Passkey>
  /** V4's HELPER.ownersHashOf(account), home chain, now. */
  homeOwnersHash(account: Address): Promise<Hex>
  /** Safe7579.isModuleInstalled(1, SmartSession, 0x) on the remote. */
  smartSessionInstalled(remote: Address): Promise<boolean>
  /** Every Safe module enabled on the remote (getModulesPaginated from the sentinel, to the end). */
  modules(remote: Address): Promise<readonly Address[]>
  /** The Safe's guard slot on the remote (zero = no guard). */
  guard(remote: Address): Promise<Address>
  /** Safe7579's own module registry on the remote: every validator, every executor (paginated), and the global hook. */
  validators7579(remote: Address): Promise<readonly Address[]>
  executors7579(remote: Address): Promise<readonly Address[]>
  hook7579(remote: Address): Promise<Address>
  /** The Safe's fallback handler slot on the remote. */
  fallbackHandler(remote: Address): Promise<Address>
  permissionEnabled(permissionId: Hex, remote: Address): Promise<boolean>
  permissionIds(remote: Address): Promise<readonly Hex[]>
}

export type CheckInput = {
  account: Address
  domain: number
  homeChainId: number
  /** The RemoteRegistered event. */
  event: { remote: Address; ownersHash: Hex; sessionKey: Address }
  /** V4.remoteOf(account, domain).capUsd. */
  capUsd: bigint
  deployment: Pick<OneAuthV4Deployment, 'policy' | 'gasPolicy'>
  homeRegistry: Registry
  remoteRegistry: Registry
}

export type CheckResult = { ok: true } | { ok: false; failed: string }

const fail = (failed: string): CheckResult => ({ ok: false, failed })
const sameList = (a: readonly Address[], b: readonly Address[]) => a.length === b.length && a.every((x, i) => isAddressEqual(x, b[i]!))
const samePasskey = (a: Passkey, b: Passkey) => a.x === b.x && a.y === b.y && a.verifiers === b.verifiers

/** Runs one read; any throw becomes a failure named `label`. */
async function read<T>(label: string, f: () => Promise<T>): Promise<{ v: T } | { failed: string }> {
  try {
    return { v: await f() }
  } catch {
    return { failed: `${label}: read failed` }
  }
}

export async function checkRemote(i: CheckInput, r: CheckReads): Promise<CheckResult> {
  const { account, event, remoteRegistry } = i
  const remote = event.remote

  const code = await read('code', () => r.remoteCode(remote))
  if ('failed' in code) return fail(code.failed)
  if (!code.v || code.v === '0x') return fail('code: no contract at the remote address')

  const hOwners = await read('owners', () => r.owners('home', account))
  const rOwners = await read('owners', () => r.owners('remote', remote))
  if ('failed' in hOwners) return fail(hOwners.failed)
  if ('failed' in rOwners) return fail(rOwners.failed)
  if (!sameList(hOwners.v, rOwners.v)) return fail('owners: remote owners differ from the home account')

  const hThr = await read('threshold', () => r.threshold('home', account))
  const rThr = await read('threshold', () => r.threshold('remote', remote))
  if ('failed' in hThr) return fail(hThr.failed)
  if ('failed' in rThr) return fail(rThr.failed)
  if (hThr.v !== rThr.v) return fail('threshold: remote threshold differs from the home account')

  // The passkey only exists when the shared signer is an owner (MamoruRemoteSafe.OwnerState: x, y, verifiers are 0 otherwise).
  const shared = address('SafeWebAuthnSharedSigner', i.homeRegistry)
  const withPasskey = hOwners.v.some((o) => isAddressEqual(o, shared))
  let passkey: Passkey = { x: 0n, y: 0n, verifiers: 0n }
  if (withPasskey) {
    const hKey = await read('passkey', () => r.passkey('home', account))
    const rKey = await read('passkey', () => r.passkey('remote', remote))
    if ('failed' in hKey) return fail(hKey.failed)
    if ('failed' in rKey) return fail(rKey.failed)
    if (!samePasskey(hKey.v, rKey.v)) return fail('passkey: remote shared-signer configuration differs from the home account')
    passkey = hKey.v
  }

  const state: V4OwnerState = { owners: hOwners.v, threshold: hThr.v, ...passkey }
  const hash = await read('ownersHash', () => r.homeOwnersHash(account))
  if ('failed' in hash) return fail(hash.failed)
  if (hash.v !== event.ownersHash) return fail('ownersHash: the home owners changed since the registration')
  if (v4OwnersHash(state) !== event.ownersHash) return fail('ownersHash: owners read back do not hash to the registered hash')

  const sessionInstalled = await read('smartSession', () => r.smartSessionInstalled(remote))
  if ('failed' in sessionInstalled) return fail(sessionInstalled.failed)
  if (!sessionInstalled.v) return fail('smartSession: validator not installed on the remote')

  // Review of #202 (P1-6): Safe7579 is the ONLY module (any other module can move the Safe's funds), and there is no guard.
  const modules = await read('safe7579Module', () => r.modules(remote))
  if ('failed' in modules) return fail(modules.failed)
  if (modules.v.length !== 1 || !isAddressEqual(modules.v[0]!, address('Safe7579', remoteRegistry))) return fail('safe7579Module: the remote modules are not exactly Safe7579')
  const guard = await read('guard', () => r.guard(remote))
  if ('failed' in guard) return fail(guard.failed)
  if (BigInt(guard.v) !== 0n) return fail('guard: the remote has a transaction guard')

  // Review of #202 r2 (Opus 5): Safe7579 keeps its own ERC-7579 modules. An executor can act for the Safe
  // (executeFromExecutor) and a validator can authorise any userOp: SmartSession is the only validator, there is no
  // executor and no hook. (7579 fallback handlers are plain CALL targets of unknown selectors, with no authority over the
  // Safe; installing one needs the owner or a validator, both checked here.)
  const validators = await read('validators7579', () => r.validators7579(remote))
  if ('failed' in validators) return fail(validators.failed)
  if (validators.v.length !== 1 || !isAddressEqual(validators.v[0]!, address('SmartSession', remoteRegistry))) return fail('validators7579: SmartSession is not the only validator')
  const executors = await read('executors7579', () => r.executors7579(remote))
  if ('failed' in executors) return fail(executors.failed)
  if (executors.v.length !== 0) return fail('executors7579: the remote has an executor')
  const hook = await read('hook7579', () => r.hook7579(remote))
  if ('failed' in hook) return fail(hook.failed)
  if (BigInt(hook.v) !== 0n) return fail('hook7579: the remote has a hook')

  const handler = await read('fallbackHandler', () => r.fallbackHandler(remote))
  if ('failed' in handler) return fail(handler.failed)
  if (!isAddressEqual(handler.v, address('Safe7579', remoteRegistry))) return fail('fallbackHandler: the remote fallback handler is not Safe7579')

  // The session V4 would bind: recomputed from what we read, never taken from the event.
  const homeDomain = V4_DOMAIN_BY_CHAIN[i.homeChainId]
  let expected: ReturnType<typeof v4Remote>
  try {
    if (homeDomain === undefined) throw new Error('home chain not in V4 table')
    expected = v4Remote({ home: account, owners: state, domain: i.domain, homeDomain, sessionKey: event.sessionKey, capUsd: i.capUsd, deployment: i.deployment, registry: remoteRegistry })
  } catch {
    return fail('expected: could not recompute the canonical remote')
  }
  if (!isAddressEqual(expected.address, remote)) return fail('remoteAddress: recomputed canonical remote differs from the registered one')

  const enabled = await read('permissionEnabled', () => r.permissionEnabled(expected.permissionId, remote))
  if ('failed' in enabled) return fail(enabled.failed)
  if (!enabled.v) return fail('permissionEnabled: the V4 session is not enabled on the remote')

  const ids = await read('permissionIds', () => r.permissionIds(remote))
  if ('failed' in ids) return fail(ids.failed)
  if (ids.v.length !== 1 || ids.v[0]!.toLowerCase() !== expected.permissionId.toLowerCase()) return fail('permissionIds: the remote has a session other than exactly the V4 one')

  return { ok: true }
}

// ---------------------------------------------------------------- #310: a V4 sibling's home, read back

/** A V4 Config, as `configOf` returns it. */
export type V4Config = { set: boolean; home: Address; homeDomain: number; generation: bigint; capUsd: bigint }

/** SafeProxy 1.4.1's runtime code hash (the same proxy on Base, Monad and Ethereum; read on chain 2 Nov). */
export const SAFE_PROXY_CODEHASH: Hex = '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c'
/** SmartSession's FALLBACK_ACTIONID: keccak256(abi.encodePacked(address(1), bytes4(0x00000001))). */
export const FALLBACK_ACTION_ID: Hex = '0xd884b6afa19f8ace90a388daca691e4e28f20cdac5aeefd46ad8bd1c074d28cf'

/** One SmartSession permission of an account, as SmartSession's own views give it. */
export type SessionShape = { actions: readonly Hex[]; fallbackPolicies: readonly Address[]; userOpPolicies: readonly Address[]; erc1271Policies: readonly Address[]; validator: Address }

export type SiblingReads = {
  /** V4.configOf(account) on the sibling's chain (this guardian's chain) and on its home chain (V4 is at the same address). */
  config(side: 'sibling' | 'home', account: Address): Promise<V4Config>
  /** keccak256 of the code at the account's address on that chain (undefined: no code). */
  codeHash(side: 'sibling' | 'home', account: Address): Promise<Hex | undefined>
  /** Storage slot 0 of the account on the home chain: a Safe proxy's singleton. */
  homeSingleton(account: Address): Promise<Address>
  /** MamoruV4Helper.ownersHashOf(account) on each chain (the helper is at the same address). */
  ownersHash(side: 'sibling' | 'home', account: Address): Promise<Hex>
  /** The home Safe's other execution paths: Safe modules, guard, fallback handler, Safe7579's validators, executors, hook. */
  modules(account: Address): Promise<readonly Address[]>
  guard(account: Address): Promise<Address>
  fallbackHandler(account: Address): Promise<Address>
  validators7579(account: Address): Promise<readonly Address[]>
  executors7579(account: Address): Promise<readonly Address[]>
  hook7579(account: Address): Promise<Address>
  /** Every SmartSession permission enabled for the home, and each one's shape. */
  permissionIds(account: Address): Promise<readonly Hex[]>
  session(account: Address, permissionId: Hex): Promise<SessionShape>
  /**
   * Review r2 of #223 (P0-1): the home's persistent grants of authority since its deploy, read from its logs by the
   * watcher (a cursor per sibling; `complete` false until the scan reached the head): every (token, spender) with an
   * allowance granted by the home and still non-zero, every operator still approved for all of its positions, and
   * whether the home ever stored a signed message (SignMsg: an ERC-1271 approval of any hash, forever).
   */
  homeHistory(account: Address): Promise<HomeHistory>
}

export type HomeHistory = { complete: boolean; allowances: readonly { token: Address; spender: Address }[]; approvedForAll: readonly Address[]; signedMessages: number }

const ZERO: Address = '0x0000000000000000000000000000000000000000'

/**
 * Spec 010 #307 + otto/mamoru#310: before `setReady(account, homeDomain, account)` on the sibling's chain, the same address
 * on the home chain must be the user's Mamoru account, with no way for anyone but its owners and V4 to move its funds:
 * - the sibling here and the home there are SafeProxy 1.4.1 (code hash), the home's singleton the pinned SafeL2;
 * - the home is a V4 home there (`configOf`: set, no home of its own), with V4's owners hash equal on both chains;
 * - review r1 of #223 (P1-1): the home's other execution paths are Mamoru's shape only: Safe7579 the one Safe module and
 *   the fallback handler, no guard, SmartSession the one 7579 validator, no 7579 executor or hook, and every SmartSession
 *   permission a V4 session (the fallback action alone, V4 its one action policy, MamoruGasPolicyV2 its one userOp
 *   policy, no ERC-1271 policy, OwnableValidator). A home someone else deployed first and armed with a module, a guard or
 *   a session of their own is refused, whatever its owners became.
 * An undeployed home is not marked ready (fail closed): the app deploys it at Start, in the same approval.
 */
export async function checkSibling(
  i: { account: Address; homeDomain: number; homeRegistry: Registry; deployment: Pick<OneAuthV4Deployment, 'policy' | 'gasPolicy'> },
  r: SiblingReads,
): Promise<CheckResult> {
  const sib = await read('siblingConfig', () => r.config('sibling', i.account))
  if ('failed' in sib) return fail(sib.failed)
  if (!sib.v.set || !isAddressEqual(sib.v.home, i.account) || sib.v.homeDomain !== i.homeDomain) return fail('siblingConfig: not a sibling of this account on this domain')
  for (const side of ['sibling', 'home'] as const) {
    const h = await read('codeHash', () => r.codeHash(side, i.account))
    if ('failed' in h) return fail(h.failed)
    if (!h.v) return fail(side === 'home' ? 'homeCode: the home account is not deployed' : 'codeHash: the sibling has no code')
    if (h.v.toLowerCase() !== SAFE_PROXY_CODEHASH) return fail(`codeHash: the ${side} is not a SafeProxy 1.4.1`)
  }
  const single = await read('homeSingleton', () => r.homeSingleton(i.account))
  if ('failed' in single) return fail(single.failed)
  if (!isAddressEqual(single.v, address('SafeL2_141', i.homeRegistry))) return fail('homeSingleton: not a Safe of the pinned singleton')
  const home = await read('homeConfig', () => r.config('home', i.account))
  if ('failed' in home) return fail(home.failed)
  if (!home.v.set || BigInt(home.v.home) !== 0n) return fail('homeConfig: the address is not a V4 home account there')
  const a = await read('ownersHash', () => r.ownersHash('sibling', i.account))
  if ('failed' in a) return fail(a.failed)
  const b = await read('ownersHash', () => r.ownersHash('home', i.account))
  if ('failed' in b) return fail(b.failed)
  if (a.v.toLowerCase() !== b.v.toLowerCase()) return fail('ownersHash: the keys differ between the sibling and its home')
  // P1-1: nothing but the owners and V4-bounded sessions can execute on the home.
  const safe7579 = address('Safe7579', i.homeRegistry)
  const smart = address('SmartSession', i.homeRegistry)
  const mods = await read('homeModules', () => r.modules(i.account))
  if ('failed' in mods) return fail(mods.failed)
  if (!sameList(mods.v, [safe7579])) return fail('homeModules: Safe7579 must be the only Safe module')
  const guard = await read('homeGuard', () => r.guard(i.account))
  if ('failed' in guard) return fail(guard.failed)
  if (!isAddressEqual(guard.v, ZERO)) return fail('homeGuard: a transaction guard is set')
  const fb = await read('homeFallbackHandler', () => r.fallbackHandler(i.account))
  if ('failed' in fb) return fail(fb.failed)
  if (!isAddressEqual(fb.v, safe7579)) return fail('homeFallbackHandler: not Safe7579')
  const vals = await read('homeValidators7579', () => r.validators7579(i.account))
  if ('failed' in vals) return fail(vals.failed)
  if (!sameList(vals.v, [smart])) return fail('homeValidators7579: SmartSession must be the only validator')
  const execs = await read('homeExecutors7579', () => r.executors7579(i.account))
  if ('failed' in execs) return fail(execs.failed)
  if (execs.v.length !== 0) return fail('homeExecutors7579: an executor is installed')
  const hook = await read('homeHook7579', () => r.hook7579(i.account))
  if ('failed' in hook) return fail(hook.failed)
  if (!isAddressEqual(hook.v, ZERO)) return fail('homeHook7579: a hook is installed')
  const ids = await read('homePermissions', () => r.permissionIds(i.account))
  if ('failed' in ids) return fail(ids.failed)
  if (ids.v.length === 0) return fail('homePermissions: no V4 session on the home')
  const ownable = address('OwnableValidator', i.homeRegistry)
  for (const id of ids.v) {
    const s = await read('homePermissions', () => r.session(i.account, id))
    if ('failed' in s) return fail(s.failed)
    const v4Bound = s.v.actions.length === 1 && s.v.actions[0]!.toLowerCase() === FALLBACK_ACTION_ID
      && sameList(s.v.fallbackPolicies, [i.deployment.policy]) && sameList(s.v.userOpPolicies, [i.deployment.gasPolicy])
      && s.v.erc1271Policies.length === 0 && isAddressEqual(s.v.validator, ownable)
    if (!v4Bound) return fail(`homePermissions: permission ${id} is not a V4 session`)
  }
  // P0-1 (review r2 of #223): an owner the attacker once was can leave authority that survives the owner swap: a token
  // allowance, an operator over the positions, a stored signed message (Safe7579.isValidSignature accepts an empty
  // signature for it). Every spender must be a contract of the pinned registry or V4 itself; nothing approved for all;
  // no stored message. (Safe7579 pre-validation hooks, P1-b: the pinned Safe7579 has no getPrevalidationHook, read on
  // Base 2 Nov: not installable there.)
  const hist = await read('homeHistory', () => r.homeHistory(i.account))
  if ('failed' in hist) return fail(hist.failed)
  if (!hist.v.complete) return fail("homeHistory: the home's history is still being read")
  const allowed = new Set([...i.homeRegistry.entries.map((e) => e.address.toLowerCase()), i.deployment.policy.toLowerCase(), i.deployment.gasPolicy.toLowerCase()])
  const foreign = hist.v.allowances.find((x) => !allowed.has(x.spender.toLowerCase()))
  if (foreign) return fail(`homeAllowance: ${foreign.token} may be spent by ${foreign.spender}`)
  if (hist.v.approvedForAll.length) return fail(`homeApprovedForAll: ${hist.v.approvedForAll[0]} may move the home's positions`)
  if (hist.v.signedMessages) return fail('homeSignedMessages: the home stored a signed message')
  // P1-a, bounded: the home's C is never above the sibling's (the C Mamoru signs for both).
  if (home.v.capUsd > sib.v.capUsd) return fail("homeConfig: the home's C is above the sibling's")
  return { ok: true }
}
