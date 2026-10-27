import {
  concat,
  encodeAbiParameters,
  getAddress,
  encodeFunctionData,
  encodePacked,
  isAddressEqual,
  keccak256,
  pad,
  toHex,
  zeroAddress,
  type LocalAccount,
} from 'viem'
import { getUserOperationHash, toPackedUserOperation, type UserOperation } from 'viem/account-abstraction'
import { ReasonError, type Address, type Hex } from '@mamoru/domain'
import { baseRegistry, address, entry, isDeployed, entryPointV07Abi, moduleRegistryAbi, safe7579Abi, smartSessionAbi, type Registry } from '@mamoru/registry'
import { PARAM_CONDITIONS, POLICY_INCREASE_SIG, decodeGasCaps, decodeMamoruInit, encodeGasCaps, encodeMamoruInit, mamoruInitFor, v4PoolOf, validGasCaps, type GasCaps, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import {
  CALLTYPE_BATCH,
  CALLTYPE_SINGLE,
  EXECTYPE_DEFAULT,
  encodeBatchExecution,
  encodeMode,
  encodeSingleExecution,
  type Execution,
} from '../safe/index.ts'

const MAX_PARAM_RULES = 16

export type PolicyData = { policy: Address; initData: Hex }
export type ActionData = { actionTargetSelector: Hex; actionTarget: Address; actionPolicies: PolicyData[] }
export type SmartSessionStruct = {
  sessionValidator: Address
  sessionValidatorInitData: Hex
  salt: Hex
  userOpPolicies: PolicyData[]
  erc7739Policies: { allowedERC7739Content: { appDomainSeparator: Hex; contentName: string[] }[]; erc1271Policies: PolicyData[] }
  actions: ActionData[]
  permitERC4337Paymaster: boolean
}

const PARAM_RULE_COMPONENTS = [
  { name: 'condition', type: 'uint8' },
  { name: 'offset', type: 'uint64' },
  { name: 'isLimited', type: 'bool' },
  { name: 'ref', type: 'bytes32' },
  {
    name: 'usage',
    type: 'tuple',
    components: [
      { name: 'limit', type: 'uint256' },
      { name: 'used', type: 'uint256' },
    ],
  },
] as const

const ACTION_CONFIG = [
  {
    name: 'ActionConfig',
    type: 'tuple',
    components: [
      { name: 'valueLimitPerUse', type: 'uint256' },
      {
        name: 'paramRules',
        type: 'tuple',
        components: [
          { name: 'length', type: 'uint256' },
          { name: 'rules', type: 'tuple[16]', components: PARAM_RULE_COMPONENTS },
        ],
      },
    ],
  },
] as const

type EncodedRule = {
  condition: number
  offset: bigint
  isLimited: boolean
  ref: Hex
  usage: { limit: bigint; used: bigint }
}

const EMPTY_RULE: EncodedRule = { condition: 0, offset: 0n, isLimited: false, ref: pad('0x00'), usage: { limit: 0n, used: 0n } }

/** UniActionPolicy init data: value limit per use 0 and one ParamRule per rule of the grant. */
export function uniActionInitData(action: SessionGrant['actions'][number]): Hex {
  if (action.params.length > MAX_PARAM_RULES) throw new Error(`${action.signature} has more than ${MAX_PARAM_RULES} rules`)
  const rules: EncodedRule[] = action.params.map((p) => ({
    condition: PARAM_CONDITIONS.indexOf(p.condition),
    offset: BigInt(p.index * 32),
    isLimited: p.cumulativeLimit !== undefined,
    ref: pad(toHex(p.ref), { size: 32 }),
    usage: { limit: p.cumulativeLimit ?? 0n, used: 0n },
  }))
  const padded = [...rules, ...Array.from({ length: MAX_PARAM_RULES - rules.length }, () => EMPTY_RULE)]
  return encodeAbiParameters(ACTION_CONFIG, [
    { valueLimitPerUse: 0n, paramRules: { length: BigInt(rules.length), rules: padded as never } },
  ])
}

export function ownableValidatorInitData(sessionKey: Address): Hex {
  return encodeAbiParameters([{ type: 'uint256' }, { type: 'address[]' }], [1n, [sessionKey]])
}

/**
 * Spec 007 (otto/mamoru#151): a second action policy next to UniActionPolicy, same `initData` on every action of
 * the grant it is passed to (`MamoruActionPolicy.Init` is per-pool, not per-action — see `@mamoru/policy`'s v4
 * grant builders, which carry the policy's deployed address: it is a runtime parameter, never hardcoded here).
 *
 * T7 (GPT-6 review of #97, P1 2 and 3): a v4 grant also carries `gas`, MamoruGasPolicy as a third userOp policy with
 * its owner-signed caps, and `expected`, the two deployed addresses the policy config names
 * (`PolicyVersion.actionPolicy.address` / `.gasPolicy.address`). The guard below refuses any mismatch.
 */
export type SecondActionPolicy = {
  policy: Address
  initData: Hex
  gas?: { policy: Address; initData: Hex }
  expected?: { actionPolicy: Address; gasPolicy: Address }
}

/**
 * otto/mamoru#213: the policies of a grant outside MamoruActionPolicy (`requiresPauseGate`, bridge-out): MamoruPauseGate
 * after UniActionPolicy on every action (the guardian's pause stops it), MamoruGasPolicy as a userOp policy.
 */
export type GatedPolicies = { gate: { policy: Address; initData: Hex }; gas: { policy: Address; initData: Hex }; expected: { pauseGate: Address; gasPolicy: Address } }

/** What `policiesFor` gives a grant: MamoruActionPolicy and MamoruGasPolicy (v4/v5), the pause gate and gas policy, or nothing. */
export type SessionPolicies = SecondActionPolicy | GatedPolicies

function isActionPolicy(p: SessionPolicies | undefined): p is SecondActionPolicy {
  return !!p && 'policy' in p
}

/**
 * otto/mamoru#213: an action that moves funds off the chain through CCTP: any `depositForBurn*` entry point (V2's
 * `WithHook`, V1's `WithCaller`) or any call to the registry's TokenMessengerV2.
 */
function isBridgeAction(a: SessionGrant['actions'][number], registry: Registry): boolean {
  if (a.signature.startsWith('depositForBurn')) return true
  return isDeployed('TokenMessengerV2', registry) && isAddressEqual(a.targetAddress, address('TokenMessengerV2', registry))
}

/** otto/mamoru#213: a `requiresPauseGate` grant carries the configured MamoruPauseGate and MamoruGasPolicy, and no action policy. */
export function assertGated(grant: SessionGrant, p: SessionPolicies | undefined): asserts p is GatedPolicies {
  if (grant.requiresActionPolicy || grant.actionPolicy || isActionPolicy(p)) mismatch(grant, 'a gated grant never takes MamoruActionPolicy')
  if (!p || !p.gate || isAddressEqual(p.gate.policy, zeroAddress)) throw new ReasonError('SESSION_ACTION_POLICY_MISSING', `${grant.name}: needs MamoruPauseGate as its second action policy`)
  if (!p.gas || isAddressEqual(p.gas.policy, zeroAddress)) throw new ReasonError('SESSION_ACTION_POLICY_MISSING', `${grant.name}: needs MamoruGasPolicy as a userOp policy`)
  const { pauseGate, gasPolicy } = p.expected
  if (isAddressEqual(pauseGate, zeroAddress) || !isAddressEqual(p.gate.policy, pauseGate)) mismatch(grant, `pause gate ${p.gate.policy} is not the configured MamoruPauseGate ${pauseGate}`)
  if (p.gate.initData !== '0x') mismatch(grant, 'MamoruPauseGate takes no init data')
  if (isAddressEqual(gasPolicy, zeroAddress) || !isAddressEqual(p.gas.policy, gasPolicy)) mismatch(grant, `gas policy ${p.gas.policy} is not the configured MamoruGasPolicy ${gasPolicy}`)
  if (isAddressEqual(pauseGate, gasPolicy)) mismatch(grant, 'pause gate and gas policy are the same address')
  let caps
  try {
    caps = decodeGasCaps(p.gas.initData)
  } catch {
    mismatch(grant, 'gas policy init data is not MamoruGasPolicy.Caps')
  }
  if (!validGasCaps(caps)) mismatch(grant, 'gas caps MamoruGasPolicy would refuse (a zero cap, or maxFeePerGas under the priority cap)')
}

const MINT_SIG = 'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))'
/** The position manager's own increaseLiquidity: never a session action of a v4 grant (otto/mamoru#171). */
const NPM_INCREASE_SIG = 'increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))'
const APPROVE_SIG = 'approve(address,uint256)'
const TOKEN_FIELDS = new Set(['token0', 'token1', 'tokenIn', 'tokenOut'])

function mismatch(grant: SessionGrant, why: string): never {
  throw new ReasonError('SESSION_ACTION_POLICY_MISMATCH', `${grant.name}${grant.pool ? `:${grant.pool}` : ''}: ${why}`)
}

const same = (a: Address | bigint, b: Address) => BigInt(a) === BigInt(b)

/**
 * T6 audit H-2 + T7 P1 2/3: what a v4 grant (`requiresActionPolicy`) must be encoded with. Throws
 * SESSION_ACTION_POLICY_MISSING when a policy is absent and SESSION_ACTION_POLICY_MISMATCH when one is present but
 * not the expected one:
 * - the second action policy is nonzero, equals the configured MamoruActionPolicy, and equals the address the grant
 *   was retargeted to (`grant.actionPolicy`); every mint and increase targets it, no approval still names the position
 *   manager, and no action is the manager's increaseLiquidity (otto/mamoru#171);
 * - MamoruGasPolicy is present, nonzero, equals the configured gas policy, and its caps are ones it accepts;
 * - the Init's pool is the grant's pool, and every token/fee the grant's rules pin (and every approved token) belongs
 *   to that pool.
 */
export function assertV4Policies(grant: SessionGrant, second: SecondActionPolicy | undefined, registry: Registry = baseRegistry): asserts second is SecondActionPolicy & { gas: NonNullable<SecondActionPolicy['gas']>; expected: NonNullable<SecondActionPolicy['expected']> } {
  const label = `${grant.name}${grant.pool ? `:${grant.pool}` : ''}`
  if (!second || isAddressEqual(second.policy, zeroAddress)) throw new ReasonError('SESSION_ACTION_POLICY_MISSING', `${label}: a v4 grant needs MamoruActionPolicy as its second action policy`)
  if (!second.gas || isAddressEqual(second.gas.policy, zeroAddress)) throw new ReasonError('SESSION_ACTION_POLICY_MISSING', `${label}: a v4 grant needs MamoruGasPolicy as a userOp policy`)
  if (!second.expected) mismatch(grant, 'no configured policy addresses to check against')
  const { actionPolicy, gasPolicy } = second.expected
  if (isAddressEqual(actionPolicy, zeroAddress) || isAddressEqual(gasPolicy, zeroAddress)) mismatch(grant, 'configured policy address is zero')
  if (!isAddressEqual(second.policy, actionPolicy)) mismatch(grant, `second policy ${second.policy} is not the configured MamoruActionPolicy ${actionPolicy}`)
  if (!isAddressEqual(second.gas.policy, gasPolicy)) mismatch(grant, `gas policy ${second.gas.policy} is not the configured MamoruGasPolicy ${gasPolicy}`)
  if (isAddressEqual(actionPolicy, gasPolicy)) mismatch(grant, 'action and gas policy are the same address')
  if (!grant.actionPolicy || !isAddressEqual(grant.actionPolicy, second.policy)) mismatch(grant, `grant retargeted to ${grant.actionPolicy ?? 'nothing'}, not ${second.policy}`)
  const npm = address('NonfungiblePositionManager', registry)
  for (const a of grant.actions) {
    if (a.signature === MINT_SIG && !isAddressEqual(a.targetAddress, second.policy)) mismatch(grant, `mint targets ${a.targetAddress}, not the policy`)
    // otto/mamoru#171: the policy's increase only at the policy; the manager's increaseLiquidity never (it funds any tokenId).
    if (a.signature === POLICY_INCREASE_SIG && !isAddressEqual(a.targetAddress, second.policy)) mismatch(grant, `increase targets ${a.targetAddress}, not the policy`)
    if (a.signature === NPM_INCREASE_SIG) mismatch(grant, "the position manager's increaseLiquidity is never a session action")
    if (a.signature === APPROVE_SIG && a.params.some((p) => p.field === 'spender' && same(p.ref, npm))) mismatch(grant, 'an approval still names the position manager')
  }
  let caps
  try {
    caps = decodeGasCaps(second.gas.initData)
  } catch {
    mismatch(grant, 'gas policy init data is not MamoruGasPolicy.Caps')
  }
  if (!validGasCaps(caps)) mismatch(grant, 'gas caps MamoruGasPolicy would refuse (a zero cap, or maxFeePerGas under the priority cap)')
  if (!grant.pool) mismatch(grant, 'a v4 grant names its pool')
  const pool = entry(grant.pool, registry)
  let init
  try {
    init = decodeMamoruInit(second.initData)
  } catch {
    mismatch(grant, 'action policy init data is not MamoruActionPolicy.Init')
  }
  if (!isAddressEqual(init.pool, getAddress(pool.address))) mismatch(grant, `Init pool ${init.pool} is not the grant's pool ${pool.address}`)
  const tokens = [pool.token0, pool.token1].map((t) => address(t as never, registry))
  for (const a of grant.actions) {
    if (a.signature === APPROVE_SIG && !tokens.some((t) => isAddressEqual(t, a.targetAddress))) mismatch(grant, `approves ${a.targetAddress}, not a token of the pool`)
    for (const p of a.params) {
      if (p.condition !== 'EQUAL') continue
      if (TOKEN_FIELDS.has(p.field) && !tokens.some((t) => same(p.ref, t))) mismatch(grant, `${a.signature} ${p.field} is not a token of the pool`)
      if (p.field === 'fee' && BigInt(p.ref) !== BigInt(pool.fee ?? -1)) mismatch(grant, `${a.signature} fee ${p.ref} is not the pool's fee ${pool.fee}`)
    }
  }
}

/**
 * Maps a policy grant onto the Smart Sessions Session struct, with the published policies only. `secondPolicy`
 * (spec 007, T2) adds one more `PolicyData` after UniActionPolicy's on every action, and (T7) its `gas` a third userOp
 * policy; omitted, this is byte-for-byte what every live grant (v2/v3) has always produced.
 *
 * Authorization-parity guard (T6 H-2, T7 P1 2/3): a grant the v4 builders marked `requiresActionPolicy` is only as
 * strict as v2/v3 WITH MamoruActionPolicy (and MamoruGasPolicy) in the same session — see `assertV4Policies`, run
 * here, the one place every grant goes through on its way to an owner op (`activationCall` below included).
 */
export function toSmartSession(grant: SessionGrant, policies?: SessionPolicies, registry: Registry = baseRegistry): SmartSessionStruct {
  // otto/mamoru#213 (review r3): the gate's protection rests on the flag; a grant that moves funds off the chain without
  // it (a stale or hand-built grant, the old `requiresGasPolicy` name) is refused rather than encoded ungated.
  if ('requiresGasPolicy' in grant) mismatch(grant, 'requiresGasPolicy is retired: rebuild the grant (requiresPauseGate)')
  if (!grant.requiresPauseGate && grant.actions.some((a) => isBridgeAction(a, registry))) mismatch(grant, 'a bridge action needs requiresPauseGate')
  if (grant.requiresPauseGate) assertGated(grant, policies)
  else if (grant.requiresActionPolicy) assertV4Policies(grant, isActionPolicy(policies) ? policies : undefined, registry)
  const second = isActionPolicy(policies) ? { policy: policies.policy, initData: policies.initData } : policies && 'gate' in policies ? policies.gate : undefined
  // otto/mamoru#225: an action without UniActionPolicy is checked by MamoruActionPolicy alone: only on a grant that has
  // it (assertV4Policies above), never with a rule left over (it would not be enforced), never on a gated grant.
  for (const a of grant.actions) {
    if (!a.actionPolicyOnly) continue
    if (!grant.requiresActionPolicy || !isActionPolicy(policies)) mismatch(grant, `${a.signature} without UniActionPolicy needs MamoruActionPolicy`)
    if (a.params.length) mismatch(grant, `${a.signature} without UniActionPolicy carries rules nothing would check`)
  }
  const uni = (a: SessionGrant['actions'][number]) => ({ policy: address('UniActionPolicy', registry), initData: uniActionInitData(a) })
  return {
    sessionValidator: address('OwnableValidator', registry),
    sessionValidatorInitData: ownableValidatorInitData(grant.sessionKey),
    salt: grant.salt,
    userOpPolicies: [
      {
        policy: address('TimeFramePolicy', registry),
        initData: encodePacked(['uint128', 'uint128'], [BigInt(grant.userOp.validUntil), BigInt(grant.userOp.validAfter)]),
      },
      { policy: address('UsageLimitPolicy', registry), initData: encodePacked(['uint128'], [BigInt(grant.userOp.usageLimit)]) },
      ...(policies?.gas ? [{ policy: policies.gas.policy, initData: policies.gas.initData }] : []),
    ],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: grant.actions.map((a) => ({
      actionTargetSelector: a.selector,
      actionTarget: a.targetAddress,
      actionPolicies: a.actionPolicyOnly && second ? [{ policy: second.policy, initData: second.initData }] : second ? [uni(a), { policy: second.policy, initData: second.initData }] : [uni(a)],
    })),
    permitERC4337Paymaster: grant.permitERC4337Paymaster,
  }
}

/** Spec 007 T7: the two deployed policies and the gas caps a v4 approval enables its sessions with. */
export type V4Deployment = { actionPolicy: Address; gasPolicy: Address; gasCaps: GasCaps; pauseGate?: Address }

/** The deployment a v4 PolicyVersion names (`withActionPolicy(..., { gasPolicy })`), or null (v2/v3, or no gas policy). */
export function v4DeploymentOf(policy: PolicyVersion): V4Deployment | null {
  const ap = policy.actionPolicy
  if (!ap?.gasPolicy) return null
  return { actionPolicy: ap.address, gasPolicy: ap.gasPolicy.address, gasCaps: ap.gasPolicy.caps, ...(ap.pauseGate && ap.contractVersion === 2 ? { pauseGate: ap.pauseGate } : {}) }
}

/**
 * Spec 007 T7 (c): the `policiesFor` of `activationCall`/`activationBatch` for the grants of ONE owner transaction of
 * a v4 approval: MamoruActionPolicy with its pool's Init at `generation` (budgets from `budgetCaps`, see
 * `v4BudgetCaps`), MamoruGasPolicy with `d.gasCaps`, both bound to `d` (the guard in toSmartSession checks them).
 * `admitByPool` (T6 M-4): positions of each pool the owner admits, carried only by the first grant of that pool in
 * this transaction (every Init of a pool and generation must match except `admit`, and each admitted id costs an
 * `ownerOf` + `positions` read per action). Grants without `requiresActionPolicy` get nothing (byte-identical).
 */
export function v4PoliciesFor(
  grants: readonly SessionGrant[],
  d: V4Deployment,
  generation: bigint,
  budgetCaps: Record<string, bigint>,
  admitByPool: Partial<Record<string, readonly bigint[]>> = {},
  registry: Registry = baseRegistry,
): (grant: SessionGrant, index: number) => SessionPolicies | undefined {
  const firstOfPool = new Map<string, number>()
  grants.forEach((g, i) => {
    if (g.pool && !firstOfPool.has(g.pool)) firstOfPool.set(g.pool, i)
  })
  const gas = { policy: d.gasPolicy, initData: encodeGasCaps(d.gasCaps) }
  return (g, i) => {
    if (g.requiresPauseGate) {
      if (!d.pauseGate) mismatch(g, 'no MamoruPauseGate configured for this deployment')
      return { gate: { policy: d.pauseGate, initData: '0x' }, gas, expected: { pauseGate: d.pauseGate, gasPolicy: d.gasPolicy } }
    }
    if (!g.requiresActionPolicy) return undefined
    const spec = v4PoolOf(g.pool, registry.chainId)
    if (!spec) mismatch(g, 'no v4 pool parameters for this pool')
    const admit = firstOfPool.get(g.pool!) === i ? [...(admitByPool[g.pool!] ?? [])] : []
    return { policy: d.actionPolicy, initData: encodeMamoruInit(mamoruInitFor(spec, generation, budgetCaps, { admit })), gas, expected: { actionPolicy: d.actionPolicy, gasPolicy: d.gasPolicy } }
  }
}

export function permissionIdOf(session: SmartSessionStruct): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes32' }],
      [session.sessionValidator, session.sessionValidatorInitData, session.salt],
    ),
  )
}

/**
 * Calldata for SmartSession.enableSessions, sent by the owner (Safe
 * execTransaction or an owner userOp). Refuses any permissionId that was
 * revoked before (FR-ACC-006).
 */
export function activationCall(
  grants: SessionGrant[],
  revokedPermissionIds: readonly Hex[],
  policiesFor?: (grant: SessionGrant, index: number) => SessionPolicies | undefined,
  registry: Registry = baseRegistry,
): { to: Address; data: Hex; permissionIds: Hex[] } {
  // T7 (GPT-6 review of #97, P1 1): a v4 grant is encoded with its policies; without `policiesFor` it is refused
  // by the guard in toSmartSession, as before. v2/v3 grants get `undefined` and encode byte for byte as always.
  const sessions = grants.map((g, i) => toSmartSession(g, policiesFor?.(g, i), registry))
  const permissionIds = sessions.map(permissionIdOf)
  const revoked = new Set(revokedPermissionIds.map((p) => p.toLowerCase()))
  for (const id of permissionIds) {
    if (revoked.has(id.toLowerCase())) throw new ReasonError('SESSION_PERMISSION_ID_REUSED', id)
  }
  return {
    to: address('SmartSession', registry),
    data: encodeFunctionData({ abi: smartSessionAbi, functionName: 'enableSessions', args: [sessions] }),
    permissionIds,
  }
}

/** Schema of the Rhinestone attester's records in the ERC-7484 registry. */
export const ATTESTATION_SCHEMA_UID: Hex = '0x93d46fcca4ef7d66a413c7bde08bb1ff14bacbd04c4069bb24cd7c21729d7bf1'

/** Published policies that the Rhinestone attester has not attested; the account attests them itself. */
export const SELF_ATTESTED_POLICIES = ['TimeFramePolicy', 'UsageLimitPolicy'] as const

/**
 * SmartSession checks every policy against the account's trusted attesters.
 * Owner calls, run once before the first activation: the account trusts the
 * Rhinestone attester and itself (threshold 1) and attests the published
 * policies above, with empty data and no module types.
 */
export function registryTrustCalls(account: Address, registry: Registry = baseRegistry): { to: Address; value: bigint; data: Hex }[] {
  const attesters = [address('RhinestoneAttester', registry), account].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  return [
    {
      to: address('ModuleRegistry', registry),
      value: 0n,
      data: encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'trustAttesters', args: [1, attesters] }),
    },
    {
      to: address('ModuleRegistry', registry),
      value: 0n,
      data: encodeFunctionData({
        abi: moduleRegistryAbi,
        functionName: 'attest',
        args: [
          ATTESTATION_SCHEMA_UID,
          SELF_ATTESTED_POLICIES.map((p) => ({ moduleAddress: address(p, registry), expirationTime: 0, data: '0x' as Hex, moduleTypes: [] })),
        ],
      }),
    },
  ]
}

/**
 * Spec 007 T7: the owner call that self-attests modules the Rhinestone attester has not attested (MamoruActionPolicy,
 * MamoruGasPolicy), once per account, like `registryTrustCalls` does for TimeFramePolicy/UsageLimitPolicy. The
 * registry refuses to attest a module without a ModuleRecord (Deploy.s.sol's `deployModule` writes it).
 */
/**
 * `data`: what the registry stores for this attestation. It must differ from any earlier attestation of the same
 * module by this account: the registry writes it with CREATE2, so attesting again the same bytes after a revoke
 * reverts with DeploymentFailed (verified on a Base fork, review round 4). Callers pass something unique per prepare.
 */
export function selfAttestCall(modules: readonly Address[], data: Hex = '0x'): { to: Address; value: bigint; data: Hex } {
  return {
    to: address('ModuleRegistry', baseRegistry),
    value: 0n,
    data: encodeFunctionData({
      abi: moduleRegistryAbi,
      functionName: 'attest',
      args: [ATTESTATION_SCHEMA_UID, modules.map((m) => ({ moduleAddress: m, expirationTime: 0, data, moduleTypes: [] }))],
    }),
  }
}

/**
 * Revokes this account's own attestations of `modules` (spec 007 T7, review round 4): the Rhinestone registry refuses
 * to attest again over an unrevoked record (`AlreadyAttested`), expired or not, so one that lapses before the new
 * approval ends is revoked first, in the same owner transaction, then attested again.
 */
export function selfRevokeAttestationCall(modules: readonly Address[]): { to: Address; value: bigint; data: Hex } {
  return {
    to: address('ModuleRegistry', baseRegistry),
    value: 0n,
    data: encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'revoke', args: [modules.map((m) => ({ moduleAddress: m }))] }),
  }
}

export function revocationCalls(permissionIds: Hex[], registry: Registry = baseRegistry): { to: Address; value: bigint; data: Hex }[] {
  return permissionIds.map((id) => ({
    to: address('SmartSession', registry),
    value: 0n,
    data: encodeFunctionData({ abi: smartSessionAbi, functionName: 'removeSession', args: [id] }),
  }))
}

// userOps signed by the session key

export const SMART_SESSION_MODE_USE = '0x00'
export const SMART_SESSION_MODE_ENABLE = '0x01'

/** 2D nonce key: validator address in the top 160 bits, then a 32-bit lane. */
export function sessionNonceKey(lane: number, validator: Address = address('SmartSession', baseRegistry)): bigint {
  return (BigInt(validator) << 32n) | BigInt(lane)
}

export function executeCallData(calls: Execution[]): Hex {
  if (calls.length === 1) {
    return encodeFunctionData({
      abi: safe7579Abi,
      functionName: 'execute',
      args: [encodeMode(CALLTYPE_SINGLE, EXECTYPE_DEFAULT), encodeSingleExecution(calls[0]!)],
    })
  }
  return encodeFunctionData({
    abi: safe7579Abi,
    functionName: 'execute',
    args: [encodeMode(CALLTYPE_BATCH, EXECTYPE_DEFAULT), encodeBatchExecution(calls)],
  })
}

export type GasSettings = {
  verificationGasLimit: bigint
  callGasLimit: bigint
  preVerificationGas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export function draftUserOp(sender: Address, nonce: bigint, callData: Hex, gas: GasSettings): UserOperation<'0.7'> {
  return {
    sender,
    nonce,
    callData,
    callGasLimit: gas.callGasLimit,
    verificationGasLimit: gas.verificationGasLimit,
    preVerificationGas: gas.preVerificationGas,
    maxFeePerGas: gas.maxFeePerGas,
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    signature: '0x',
  }
}

export function userOpHash(userOp: UserOperation<'0.7'>, chainId: number, registry: Registry = baseRegistry): Hex {
  return getUserOperationHash({ userOperation: userOp, entryPointAddress: address('EntryPointV07', registry), entryPointVersion: '0.7', chainId })
}

/** OwnableValidator checks an EIP-191 signature of the userOp hash by the session key. */
export async function sessionKeySignature(sessionKey: LocalAccount, hash: Hex): Promise<Hex> {
  return sessionKey.signMessage({ message: { raw: hash } })
}

export function useModeSignature(permissionId: Hex, signature: Hex): Hex {
  return concat([SMART_SESSION_MODE_USE, permissionId, signature])
}

export async function signSessionUserOp(
  userOp: UserOperation<'0.7'>,
  chainId: number,
  permissionId: Hex,
  sessionKey: LocalAccount,
  registry: Registry = baseRegistry,
): Promise<UserOperation<'0.7'>> {
  const hash = userOpHash({ ...userOp, signature: '0x' }, chainId, registry)
  return { ...userOp, signature: useModeSignature(permissionId, await sessionKeySignature(sessionKey, hash)) }
}

export function handleOpsData(userOps: UserOperation<'0.7'>[], beneficiary: Address): Hex {
  return encodeFunctionData({
    abi: entryPointV07Abi,
    functionName: 'handleOps',
    args: [userOps.map((u) => toPackedUserOperation(u)), beneficiary],
  })
}