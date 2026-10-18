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
import { address, entry, entryPointV07Abi, moduleRegistryAbi, safe7579Abi, smartSessionAbi } from '@mamoru/registry'
import { PARAM_CONDITIONS, decodeGasCaps, decodeMamoruInit, encodeGasCaps, encodeMamoruInit, mamoruInitFor, v4PoolOf, validGasCaps, type GasCaps, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
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

const MINT_SIG = 'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))'
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
 *   was retargeted to (`grant.actionPolicy`); every mint targets it and no approval still names the position manager;
 * - MamoruGasPolicy is present, nonzero, equals the configured gas policy, and its caps are ones it accepts;
 * - the Init's pool is the grant's pool, and every token/fee the grant's rules pin (and every approved token) belongs
 *   to that pool.
 */
export function assertV4Policies(grant: SessionGrant, second: SecondActionPolicy | undefined): asserts second is SecondActionPolicy & { gas: NonNullable<SecondActionPolicy['gas']>; expected: NonNullable<SecondActionPolicy['expected']> } {
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
  const npm = address('NonfungiblePositionManager')
  for (const a of grant.actions) {
    if (a.signature === MINT_SIG && !isAddressEqual(a.targetAddress, second.policy)) mismatch(grant, `mint targets ${a.targetAddress}, not the policy`)
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
  const pool = entry(grant.pool)
  let init
  try {
    init = decodeMamoruInit(second.initData)
  } catch {
    mismatch(grant, 'action policy init data is not MamoruActionPolicy.Init')
  }
  if (!isAddressEqual(init.pool, getAddress(pool.address))) mismatch(grant, `Init pool ${init.pool} is not the grant's pool ${pool.address}`)
  const tokens = [pool.token0, pool.token1].map((t) => address(t as never))
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
export function toSmartSession(grant: SessionGrant, secondPolicy?: SecondActionPolicy): SmartSessionStruct {
  if (grant.requiresActionPolicy) assertV4Policies(grant, secondPolicy)
  return {
    sessionValidator: address('OwnableValidator'),
    sessionValidatorInitData: ownableValidatorInitData(grant.sessionKey),
    salt: grant.salt,
    userOpPolicies: [
      {
        policy: address('TimeFramePolicy'),
        initData: encodePacked(['uint128', 'uint128'], [BigInt(grant.userOp.validUntil), BigInt(grant.userOp.validAfter)]),
      },
      { policy: address('UsageLimitPolicy'), initData: encodePacked(['uint128'], [BigInt(grant.userOp.usageLimit)]) },
      ...(secondPolicy?.gas ? [{ policy: secondPolicy.gas.policy, initData: secondPolicy.gas.initData }] : []),
    ],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: grant.actions.map((a) => ({
      actionTargetSelector: a.selector,
      actionTarget: a.targetAddress,
      actionPolicies: secondPolicy
        ? [{ policy: address('UniActionPolicy'), initData: uniActionInitData(a) }, { policy: secondPolicy.policy, initData: secondPolicy.initData }]
        : [{ policy: address('UniActionPolicy'), initData: uniActionInitData(a) }],
    })),
    permitERC4337Paymaster: grant.permitERC4337Paymaster,
  }
}

/** Spec 007 T7: the two deployed policies and the gas caps a v4 approval enables its sessions with. */
export type V4Deployment = { actionPolicy: Address; gasPolicy: Address; gasCaps: GasCaps }

/** The deployment a v4 PolicyVersion names (`withActionPolicy(..., { gasPolicy })`), or null (v2/v3, or no gas policy). */
export function v4DeploymentOf(policy: PolicyVersion): V4Deployment | null {
  const ap = policy.actionPolicy
  if (!ap?.gasPolicy) return null
  return { actionPolicy: ap.address, gasPolicy: ap.gasPolicy.address, gasCaps: ap.gasPolicy.caps }
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
): (grant: SessionGrant, index: number) => SecondActionPolicy | undefined {
  const firstOfPool = new Map<string, number>()
  grants.forEach((g, i) => {
    if (g.pool && !firstOfPool.has(g.pool)) firstOfPool.set(g.pool, i)
  })
  const gas = { policy: d.gasPolicy, initData: encodeGasCaps(d.gasCaps) }
  return (g, i) => {
    if (!g.requiresActionPolicy) return undefined
    const spec = v4PoolOf(g.pool)
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
  policiesFor?: (grant: SessionGrant, index: number) => SecondActionPolicy | undefined,
): { to: Address; data: Hex; permissionIds: Hex[] } {
  // T7 (GPT-6 review of #97, P1 1): a v4 grant is encoded with its policies; without `policiesFor` it is refused
  // by the guard in toSmartSession, as before. v2/v3 grants get `undefined` and encode byte for byte as always.
  const sessions = grants.map((g, i) => toSmartSession(g, policiesFor?.(g, i)))
  const permissionIds = sessions.map(permissionIdOf)
  const revoked = new Set(revokedPermissionIds.map((p) => p.toLowerCase()))
  for (const id of permissionIds) {
    if (revoked.has(id.toLowerCase())) throw new ReasonError('SESSION_PERMISSION_ID_REUSED', id)
  }
  return {
    to: address('SmartSession'),
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
export function registryTrustCalls(account: Address): { to: Address; value: bigint; data: Hex }[] {
  const attesters = [address('RhinestoneAttester'), account].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  return [
    {
      to: address('ModuleRegistry'),
      value: 0n,
      data: encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'trustAttesters', args: [1, attesters] }),
    },
    {
      to: address('ModuleRegistry'),
      value: 0n,
      data: encodeFunctionData({
        abi: moduleRegistryAbi,
        functionName: 'attest',
        args: [
          ATTESTATION_SCHEMA_UID,
          SELF_ATTESTED_POLICIES.map((p) => ({ moduleAddress: address(p), expirationTime: 0, data: '0x' as Hex, moduleTypes: [] })),
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
export function selfAttestCall(modules: readonly Address[]): { to: Address; value: bigint; data: Hex } {
  return {
    to: address('ModuleRegistry'),
    value: 0n,
    data: encodeFunctionData({
      abi: moduleRegistryAbi,
      functionName: 'attest',
      args: [ATTESTATION_SCHEMA_UID, modules.map((m) => ({ moduleAddress: m, expirationTime: 0, data: '0x' as Hex, moduleTypes: [] }))],
    }),
  }
}

export function revocationCalls(permissionIds: Hex[]): { to: Address; value: bigint; data: Hex }[] {
  return permissionIds.map((id) => ({
    to: address('SmartSession'),
    value: 0n,
    data: encodeFunctionData({ abi: smartSessionAbi, functionName: 'removeSession', args: [id] }),
  }))
}

// userOps signed by the session key

export const SMART_SESSION_MODE_USE = '0x00'
export const SMART_SESSION_MODE_ENABLE = '0x01'

/** 2D nonce key: validator address in the top 160 bits, then a 32-bit lane. */
export function sessionNonceKey(lane: number, validator: Address = address('SmartSession')): bigint {
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

export function userOpHash(userOp: UserOperation<'0.7'>, chainId: number): Hex {
  return getUserOperationHash({ userOperation: userOp, entryPointAddress: address('EntryPointV07'), entryPointVersion: '0.7', chainId })
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
): Promise<UserOperation<'0.7'>> {
  const hash = userOpHash({ ...userOp, signature: '0x' }, chainId)
  return { ...userOp, signature: useModeSignature(permissionId, await sessionKeySignature(sessionKey, hash)) }
}

export function handleOpsData(userOps: UserOperation<'0.7'>[], beneficiary: Address): Hex {
  return encodeFunctionData({
    abi: entryPointV07Abi,
    functionName: 'handleOps',
    args: [userOps.map((u) => toPackedUserOperation(u)), beneficiary],
  })
}