// otto/mamoru#251: the account's own Safe on the chain its remote bucket runs on (Monad's Growth bucket of v6). One Base
// approval provisions it: its sessions are committed in its Safe setup (SmartSession UNSAFE_ENABLE, MamoruActionPolicyV3
// setup mode), so the address is a function of the owner's keys AND those sessions, and the Base bridge-out grant the owner
// signs names that address as the only mint recipient. The relayer deploys it later with exactly this initializer; no owner
// signature on the remote chain, no intermediate contract. The app, the Worker and the operator all build it here.
import { encodePacked, hexToBigInt, isAddressEqual, keccak256, zeroAddress } from 'viem'
import { ReasonError, type AccountContext, type Address, type Hex, type RemoteSpec } from '@mamoru/domain'
import { address, monadRegistry, type Registry } from '@mamoru/registry'
import { computeCaps, grantKey, instantiateGrant, MONAD_GAS_CAPS, ONE_AUTH_V4_REMOTE, oneAuthV4Deployment, policyHash, policyRegistry, retargetToPolicy, V4_CHAIN_BY_DOMAIN, V4_DOMAIN_BY_CHAIN, V4_POOLS_MONAD, v4BudgetCaps, withActionPolicy, liveWmonUsdcMonadV6, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { ownerStateOf, v4Remote, type V4Remote } from '../one-auth/index.ts'
import { accountSetup, counterfactualAddress } from '../recovery/index.ts'
import { webAuthnSigner, type SafeSetup, type WebAuthnSigner } from '../safe/index.ts'
import { permissionIdOf, toSmartSession, v4DeploymentOf, v4PoliciesFor, type SmartSessionStruct } from '../sessions/index.ts'

/** The generation of a remote Safe's first config: its policy state starts empty (MamoruActionPolicyV3 H-1 bounds the first jump). */
export const REMOTE_FIRST_GENERATION = 1n

/**
 * `liveWmonUsdcMonadV6` wired to the contracts the Monad registry pins: MamoruActionPolicyV3 and MamoruGasPolicy, with
 * MONAD_GAS_CAPS. Fails (POLICY_TARGET_NOT_IN_REGISTRY) while V3 is not pinned, so nothing commits to an address whose
 * setup calls a policy that is not on chain.
 */
export function monadV6Deployed(registry: Registry = monadRegistry): PolicyVersion {
  return withActionPolicy(liveWmonUsdcMonadV6, address('MamoruActionPolicyV3', registry), [V4_POOLS_MONAD.growth], {
    gasPolicy: { address: address('MamoruGasPolicy', registry), caps: MONAD_GAS_CAPS },
    contractVersion: 3,
  })
}

export type RemoteSafeInput = {
  /** The Base account's owners, salt nonce and passkey: the remote Safe has the same owner. */
  owners: Address[]
  saltNonce: bigint
  webauthn: WebAuthnSigner | null
  /** A deployed remote policy (`monadV6Deployed`): MamoruActionPolicyV3 the only action policy of every grant. */
  policy: PolicyVersion
  /** The remote operator's session key. */
  sessionKey: Address
  validAfter: number
  validUntil: number
  /** The cap the sessions are sized at, raw USDC: the most the Base approval lets cross (its bridge total). */
  capUsdc: bigint
}

export type RemoteSafe = {
  chainId: number
  address: Address
  setup: SafeSetup
  /** The policy's grant keys (`grantKey`), in the order of `grants`, `sessions` and `permissionIds`. */
  keys: string[]
  grants: SessionGrant[]
  sessions: SmartSessionStruct[]
  permissionIds: Hex[]
}

/** A session's salt: one per grant of the policy, the same for every account (a permission id is per account in SmartSession). */
function saltOf(policy: PolicyVersion, key: string): Hex {
  return keccak256(encodePacked(['bytes32', 'string'], [policyHash(policy), key]))
}

/**
 * The account's Safe on `input.policy`'s chain, with every grant of the policy enabled in its setup. Pure: the same input
 * gives the same address on any machine and any day (setup mode reads no market state at the enable), which is what lets
 * the Base approval commit to it and the app recompute it from the owner's own passkey before the owner signs.
 */
export function remoteSafe(input: RemoteSafeInput): RemoteSafe {
  const { policy } = input
  const registry = policyRegistry(policy)
  const d = v4DeploymentOf(policy)
  if (!d || policy.actionPolicy?.contractVersion !== 3) throw new ReasonError('SESSION_ACTION_POLICY_MISSING', `${policy.policyId}: a remote Safe needs MamoruActionPolicyV3 and MamoruGasPolicy`)
  if (!policy.session.grants.length || policy.session.grants.some((g) => !g.actionPolicyOnly || g.perPosition)) {
    throw new ReasonError('SESSION_ACTION_POLICY_MISMATCH', `${policy.policyId}: every grant of a remote Safe is actionPolicyOnly and not per position`)
  }
  if (input.capUsdc <= 0n) throw new Error('remoteSafe: capUsdc must be positive')
  const caps = computeCaps(policy, input.capUsdc, {})
  // No rule names the account (actionPolicyOnly), so the grants do not depend on the address they are for: built against
  // the zero address, then stamped with the address they produce.
  const keys = policy.session.grants.map(grantKey)
  const draft = policy.session.grants.map((t) => {
    const key = grantKey(t)
    const g = instantiateGrant(policy, key, { account: zeroAddress, sessionKey: input.sessionKey, chainId: registry.chainId, salt: saltOf(policy, key), validAfter: input.validAfter, validUntil: input.validUntil, caps, capUsdc: input.capUsdc })
    return retargetToPolicy(g, d.actionPolicy, registry)
  })
  const policiesFor = v4PoliciesFor(draft, d, REMOTE_FIRST_GENERATION, v4BudgetCaps(policy, input.capUsdc), {}, registry, { atSetup: true })
  const sessions = draft.map((g, i) => toSmartSession(g, policiesFor(g, i), registry))
  const setup = accountSetup(input.owners, input.saltNonce, input.webauthn, registry, sessions)
  const at = counterfactualAddress(setup, registry)
  return { chainId: registry.chainId, address: at, setup, keys, grants: draft.map((g) => ({ ...g, account: at })), sessions, permissionIds: sessions.map(permissionIdOf) }
}

/** The remote Safe of `input` is `expected`: what the app checks against the operator's offer before the owner signs. */
export function assertRemoteSafe(input: RemoteSafeInput, expected: Address): RemoteSafe {
  const r = remoteSafe(input)
  if (!isAddressEqual(r.address, expected)) throw new ReasonError('REMOTE_SAFE_MISMATCH', `remote Safe ${expected} is not the one these keys and sessions give (${r.address})`)
  return r
}

/**
 * The account key of the Base account `baseKey`'s own Safe on `chainId`: one name the Worker's row, the Base operator and
 * the remote operator all use for it, derived, never stored apart.
 */
export function remoteAccountKey(baseKey: string, chainId: number): string {
  if (!baseKey || baseKey.includes('@')) throw new Error(`remoteAccountKey: ${baseKey} is not a Base account key`)
  return `${baseKey}@${chainId}`
}

/**
 * otto/mamoru#293 (review of #202, P0-3): the account key of a Base account's V4 remote Safe on `chainId` when the account
 * still has its design-C Safe there under `remoteAccountKey`: a key of its own, so the remote operator holds both Safes
 * (the old one for step 1 and its positions, the new one provisioned and running) and neither displaces the other.
 */
export function v4RemoteAccountKey(baseKey: string, chainId: number): string {
  return `${remoteAccountKey(baseKey, chainId)}.v4`
}

/** The Base account key of a remote account key (design C or V4), or null when it is not one for `chainId`. */
export function baseKeyOf(remoteKey: string, chainId: number): string | null {
  for (const suffix of [`@${chainId}`, `@${chainId}.v4`]) {
    if (!remoteKey.endsWith(suffix)) continue
    const base = remoteKey.slice(0, -suffix.length)
    return base && !base.includes('@') ? base : null
  }
  return null
}

/** The remote policies a spec may name, wired to the chain's pinned contracts. Any other id is refused. */
export function remotePolicyFor(spec: Pick<RemoteSpec, 'chainId' | 'policyId'>, registry: Registry = monadRegistry): PolicyVersion {
  if (spec.chainId !== registry.chainId) throw new ReasonError('REMOTE_SAFE_MISMATCH', `remote spec for chain ${spec.chainId}, registry of ${registry.chainId}`)
  if (spec.chainId === 143 && spec.policyId === liveWmonUsdcMonadV6.policyId) return monadV6Deployed(registry)
  throw new ReasonError('REMOTE_SAFE_MISMATCH', `no remote policy ${spec.policyId} on chain ${spec.chainId}`)
}

/** `remoteSafe`'s input from an account context (the Base account's keys) and a remote spec. */
export function remoteInput(ctx: Pick<AccountContext, 'owners' | 'saltNonce' | 'passkey'>, spec: RemoteSpec, registry: Registry = monadRegistry): RemoteSafeInput {
  const capUsdc = BigInt(spec.capUsdc)
  return {
    owners: ctx.owners as Address[],
    saltNonce: BigInt(ctx.saltNonce),
    webauthn: webAuthnSigner(hexToBigInt(ctx.passkey.x), hexToBigInt(ctx.passkey.y), registry),
    policy: remotePolicyFor(spec, registry),
    sessionKey: spec.sessionKey as Address,
    validAfter: spec.validAfter,
    validUntil: spec.validUntil,
    capUsdc,
  }
}

/** otto/mamoru#293: a V4 remote Safe's spec (spec 010 I4): its address is MamoruActionPolicyV4's own derivation. */
export function isV4RemoteSpec(spec: Pick<RemoteSpec, 'policyId'> | undefined): boolean {
  return spec?.policyId === ONE_AUTH_V4_REMOTE
}

/**
 * otto/mamoru#293: the V4 remote Safe a spec names, rebuilt from the home account's own keys (the Worker's D1 row, or the
 * operator's verified context): MamoruV4Helper.remote's twin over those owners and passkey, the spec's session key and
 * C, home = the account itself. Refused (REMOTE_SAFE_MISMATCH) when the spec names another home, a domain or validity
 * V4 does not use, or when the remote chain's registry does not pin the V4 stack.
 */
export function v4RemoteFromSpec(base: Pick<AccountContext, 'address' | 'owners' | 'passkey'>, spec: RemoteSpec, registry: Registry, homeChainId = 8453): V4Remote {
  if (!isV4RemoteSpec(spec)) throw new ReasonError('REMOTE_SAFE_MISMATCH', `${spec.policyId} is not a V4 remote`)
  if (!spec.home || spec.home.toLowerCase() !== String(base.address).toLowerCase()) throw new ReasonError('REMOTE_SAFE_MISMATCH', `V4 remote of ${spec.home}, not of this account`)
  const homeDomain = V4_DOMAIN_BY_CHAIN[homeChainId]
  const domain = V4_DOMAIN_BY_CHAIN[spec.chainId]
  if (homeDomain === undefined || domain === undefined || spec.homeDomain !== homeDomain || V4_CHAIN_BY_DOMAIN[domain] !== registry.chainId) throw new ReasonError('REMOTE_SAFE_MISMATCH', `V4 remote on chain ${spec.chainId} from domain ${spec.homeDomain}: not a route V4 pins`)
  if (spec.validAfter !== 0 || spec.validUntil !== 0) throw new ReasonError('REMOTE_SAFE_MISMATCH', 'a V4 remote session has no validity window')
  const deployment = oneAuthV4Deployment(registry)
  if (!deployment) throw new ReasonError('REMOTE_SAFE_MISMATCH', `the V4 stack is not pinned on chain ${registry.chainId}`)
  const shared = address('SafeWebAuthnSharedSigner', registry)
  const withPasskey = base.owners.some((o) => o.toLowerCase() === shared.toLowerCase())
  const webauthn = withPasskey ? webAuthnSigner(hexToBigInt(base.passkey.x), hexToBigInt(base.passkey.y), registry) : null
  return v4Remote({ home: base.address as Address, owners: ownerStateOf(base.owners as Address[], webauthn, registry), domain, homeDomain, sessionKey: spec.sessionKey as Address, capUsd: BigInt(spec.capUsdc), deployment, registry })
}
