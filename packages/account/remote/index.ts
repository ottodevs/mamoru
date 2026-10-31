// otto/mamoru#251: the account's own Safe on the chain its remote bucket runs on (Monad's Growth bucket of v6). One Base
// approval provisions it: its sessions are committed in its Safe setup (SmartSession UNSAFE_ENABLE, MamoruActionPolicyV3
// setup mode), so the address is a function of the owner's keys AND those sessions, and the Base bridge-out grant the owner
// signs names that address as the only mint recipient. The relayer deploys it later with exactly this initializer; no owner
// signature on the remote chain, no intermediate contract. The app, the Worker and the operator all build it here.
import { encodePacked, isAddressEqual, keccak256, zeroAddress } from 'viem'
import { ReasonError, type Address, type Hex } from '@mamoru/domain'
import { address, monadRegistry, type Registry } from '@mamoru/registry'
import { computeCaps, grantKey, instantiateGrant, MONAD_GAS_CAPS, policyHash, policyRegistry, retargetToPolicy, V4_POOLS_MONAD, v4BudgetCaps, withActionPolicy, liveWmonUsdcMonadV6, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '../recovery/index.ts'
import type { SafeSetup, WebAuthnSigner } from '../safe/index.ts'
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
  const draft = policy.session.grants.map((t) => {
    const key = grantKey(t)
    const g = instantiateGrant(policy, key, { account: zeroAddress, sessionKey: input.sessionKey, chainId: registry.chainId, salt: saltOf(policy, key), validAfter: input.validAfter, validUntil: input.validUntil, caps, capUsdc: input.capUsdc })
    return retargetToPolicy(g, d.actionPolicy, registry)
  })
  const policiesFor = v4PoliciesFor(draft, d, REMOTE_FIRST_GENERATION, v4BudgetCaps(policy, input.capUsdc), {}, registry, { atSetup: true })
  const sessions = draft.map((g, i) => toSmartSession(g, policiesFor(g, i), registry))
  const setup = accountSetup(input.owners, input.saltNonce, input.webauthn, registry, sessions)
  const at = counterfactualAddress(setup, registry)
  return { chainId: registry.chainId, address: at, setup, grants: draft.map((g) => ({ ...g, account: at })), sessions, permissionIds: sessions.map(permissionIdOf) }
}

/** The remote Safe of `input` is `expected`: what the app checks against the operator's offer before the owner signs. */
export function assertRemoteSafe(input: RemoteSafeInput, expected: Address): RemoteSafe {
  const r = remoteSafe(input)
  if (!isAddressEqual(r.address, expected)) throw new ReasonError('REMOTE_SAFE_MISMATCH', `remote Safe ${expected} is not the one these keys and sessions give (${r.address})`)
  return r
}
