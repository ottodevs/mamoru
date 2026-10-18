import { concat, decodeEventLog, getAddress, hashTypedData, numberToHex, toEventSelector, type Log, type TransactionReceipt } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'
import type { Address, Hex } from '@mamoru/domain'
import { address, entryPointV07Abi } from '@mamoru/registry'
import { executeCallData } from '../sessions/index.ts'
import { deployCall, type LiveAccount } from '../live/index.ts'
import type { MultiSendCall } from '../safe/index.ts'

// Owner-signed ERC-4337 v0.7 userOps for a Mamoru Safe (otto/mamoru#180).
//
// The account's Safe7579 adapter validates a userOp whose nonce key names no installed validator with the Safe's own
// checkSignatures over the EIP-712 SafeOp (Safe7579 SafeOp.sol, domain = chain id + the Safe7579 singleton). The
// passkey owner (SafeWebAuthnSharedSigner) is asked about keccak256(operationData), which is that typed-data hash: the
// passkey signs it as the WebAuthn challenge, exactly like a SafeTx hash. The SafeOp covers every userOp field but the
// signature: initCode, callData, gas limits, fees and paymasterAndData, so a bundler or a paymaster cannot change what
// the owner approved.
//
// With no code at the address, initCode is the same SafeProxyFactory call the relayer sends on Base (deployCall): the
// same address, owners, passkey and Safe7579 setup.

/** Nonce key 0: validator address(0), so Safe7579 falls back to the Safe owners (checkSignatures). */
export const OWNER_NONCE_KEY = 0n

export type UserOpGas = {
  verificationGasLimit: bigint
  callGasLimit: bigint
  preVerificationGas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export type PaymasterFields = {
  paymaster: Address
  paymasterVerificationGasLimit: bigint
  paymasterPostOpGasLimit: bigint
  paymasterData: Hex
}

/** The userOp before the owner signs it. `deployed` false adds the account's own deployment as initCode. */
export function ownerUserOp(i: { live: LiveAccount; deployed: boolean; nonce: bigint; calls: MultiSendCall[]; gas: UserOpGas; paymaster?: PaymasterFields }): UserOperation<'0.7'> {
  if (i.calls.length === 0) throw new Error('no calls')
  if (i.nonce >> 64n !== OWNER_NONCE_KEY) throw new Error('owner userOps use nonce key 0')
  const d = i.deployed ? null : deployCall(i.live)
  return {
    sender: i.live.safe,
    nonce: i.nonce,
    ...(d ? { factory: d.to, factoryData: d.data } : {}),
    callData: executeCallData(i.calls.map((c) => ({ target: c.to, value: c.value, callData: c.data }))),
    ...i.gas,
    ...(i.paymaster ?? {}),
    signature: '0x',
  }
}

/** initCode and paymasterAndData as the EntryPoint packs them. */
export function packedInitCode(op: UserOperation<'0.7'>): Hex {
  return op.factory ? concat([op.factory, op.factoryData ?? '0x']) : '0x'
}

export function packedPaymasterAndData(op: UserOperation<'0.7'>): Hex {
  if (!op.paymaster) return '0x'
  return concat([op.paymaster, numberToHex(op.paymasterVerificationGasLimit ?? 0n, { size: 16 }), numberToHex(op.paymasterPostOpGasLimit ?? 0n, { size: 16 }), op.paymasterData ?? '0x'])
}

/** The EIP-712 SafeOp Safe7579 rebuilds in validateUserOp. validAfter/validUntil travel in the signature. */
export function safeOpTypedData(op: UserOperation<'0.7'>, chainId: number, validAfter: number, validUntil: number) {
  return {
    domain: { chainId, verifyingContract: address('Safe7579') },
    types: {
      SafeOp: [
        { name: 'safe', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'initCode', type: 'bytes' },
        { name: 'callData', type: 'bytes' },
        { name: 'verificationGasLimit', type: 'uint128' },
        { name: 'callGasLimit', type: 'uint128' },
        { name: 'preVerificationGas', type: 'uint256' },
        { name: 'maxPriorityFeePerGas', type: 'uint128' },
        { name: 'maxFeePerGas', type: 'uint128' },
        { name: 'paymasterAndData', type: 'bytes' },
        { name: 'validAfter', type: 'uint48' },
        { name: 'validUntil', type: 'uint48' },
        { name: 'entryPoint', type: 'address' },
      ],
    },
    primaryType: 'SafeOp' as const,
    message: {
      safe: op.sender,
      nonce: op.nonce,
      initCode: packedInitCode(op),
      callData: op.callData,
      verificationGasLimit: op.verificationGasLimit,
      callGasLimit: op.callGasLimit,
      preVerificationGas: op.preVerificationGas,
      maxPriorityFeePerGas: op.maxPriorityFeePerGas,
      maxFeePerGas: op.maxFeePerGas,
      paymasterAndData: packedPaymasterAndData(op),
      validAfter,
      validUntil,
      entryPoint: address('EntryPointV07'),
    },
  }
}

/** What the passkey signs (the WebAuthn challenge) for this userOp. */
export function safeOpHash(op: UserOperation<'0.7'>, chainId: number, validAfter: number, validUntil: number): Hex {
  return hashTypedData(safeOpTypedData(op, chainId, validAfter, validUntil))
}

/** userOp.signature: abi.encodePacked(uint48 validAfter, uint48 validUntil, Safe signatures). */
export function ownerUserOpSignature(validAfter: number, validUntil: number, safeSignature: Hex): Hex {
  return concat([numberToHex(validAfter, { size: 6 }), numberToHex(validUntil, { size: 6 }), safeSignature])
}

/** Every gas unit the EntryPoint may charge for, times maxFeePerGas: the prefund, the most the userOp can cost in wei. */
export function maxGasCostWei(op: UserOperation<'0.7'>): bigint {
  const gas = op.verificationGasLimit + op.callGasLimit + op.preVerificationGas + (op.paymasterVerificationGasLimit ?? 0n) + (op.paymasterPostOpGasLimit ?? 0n)
  return gas * op.maxFeePerGas
}

const BEFORE_EXECUTION = toEventSelector('BeforeExecution()')
const USER_OPERATION_EVENT = toEventSelector('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')

/**
 * The logs the userOp emitted, out of the bundle transaction: the EntryPoint emits BeforeExecution once, then for each
 * userOp its execution logs (and any revert-reason events) followed by its UserOperationEvent. Only those two
 * events are boundaries. Null when the receipt has no UserOperationEvent for
 * the hash. Another userOp in the same bundle cannot put logs inside this slice.
 */
export function userOpLogs(receipt: TransactionReceipt, userOpHash: Hex): { logs: Log[]; success: boolean; actualGasCost: bigint; actualGasUsed: bigint; paymaster: Address } | null {
  const ep = address('EntryPointV07').toLowerCase()
  let start = -1
  for (let i = 0; i < receipt.logs.length; i++) {
    const l = receipt.logs[i]!
    if (l.address.toLowerCase() !== ep) continue
    const topic = l.topics[0]?.toLowerCase()
    if (topic === BEFORE_EXECUTION) start = i
    if (topic !== USER_OPERATION_EVENT) continue
    const ev = decodeEventLog({ abi: entryPointV07Abi, eventName: 'UserOperationEvent', data: l.data, topics: l.topics })
    if (ev.args.userOpHash.toLowerCase() === userOpHash.toLowerCase()) {
      if (start < 0) return null
      return { logs: receipt.logs.slice(start + 1, i), success: ev.args.success, actualGasCost: ev.args.actualGasCost, actualGasUsed: ev.args.actualGasUsed, paymaster: getAddress(ev.args.paymaster) }
    }
    start = i
  }
  return null
}
