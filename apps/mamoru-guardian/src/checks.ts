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
  /** Safe.isModuleEnabled(Safe7579) on the remote. */
  safe7579Enabled(remote: Address): Promise<boolean>
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

  const moduleEnabled = await read('safe7579Module', () => r.safe7579Enabled(remote))
  if ('failed' in moduleEnabled) return fail(moduleEnabled.failed)
  if (!moduleEnabled.v) return fail('safe7579Module: Safe7579 is not an enabled module of the remote')

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
