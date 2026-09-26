import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  pad,
  toHex,
  type LocalAccount,
} from 'viem'
import { getUserOperationHash, toPackedUserOperation, type UserOperation } from 'viem/account-abstraction'
import { ReasonError, type Address, type Hex } from '@mamoru/domain'
import { address, entryPointV07Abi, moduleRegistryAbi, safe7579Abi, smartSessionAbi } from '@mamoru/registry'
import { PARAM_CONDITIONS, type SessionGrant } from '@mamoru/policy'
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

/** Maps a policy grant onto the Smart Sessions Session struct, with the published policies only. */
export function toSmartSession(grant: SessionGrant): SmartSessionStruct {
  return {
    sessionValidator: address('OwnableValidator'),
    sessionValidatorInitData: ownableValidatorInitData(grant.sessionKey),
    salt: grant.salt,
    userOpPolicies: [
      {
        policy: address('TimeFramePolicy'),
        initData: encodePacked(['uint48', 'uint48'], [grant.userOp.validUntil, grant.userOp.validAfter]),
      },
      { policy: address('UsageLimitPolicy'), initData: encodePacked(['uint128'], [BigInt(grant.userOp.usageLimit)]) },
    ],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: grant.actions.map((a) => ({
      actionTargetSelector: a.selector,
      actionTarget: a.targetAddress,
      actionPolicies: [
        { policy: address('UniActionPolicy'), initData: uniActionInitData(a) },
        { policy: address('ValueLimitPolicy'), initData: encodeAbiParameters([{ type: 'uint256' }], [0n]) },
      ],
    })),
    permitERC4337Paymaster: grant.permitERC4337Paymaster,
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
): { to: Address; data: Hex; permissionIds: Hex[] } {
  const sessions = grants.map(toSmartSession)
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
export const SELF_ATTESTED_POLICIES = ['TimeFramePolicy', 'UsageLimitPolicy', 'ValueLimitPolicy'] as const

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