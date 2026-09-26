import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  numberToHex,
  pad,
  size,
  zeroAddress,
  type LocalAccount,
} from 'viem'
import type { Address, Hex } from '@mamoru/domain'
import {
  address,
  multiSendCallOnlyAbi,
  safe7579LaunchpadAbi,
  safeAbi,
  safeProxyFactoryAbi,
  safeWebAuthnSharedSignerAbi,
} from '@mamoru/registry'

export const OPERATION_CALL = 0
export const OPERATION_DELEGATECALL = 1

export type ModuleInit = { module: Address; initData: Hex }

/** Passkey coordinates and packed verifiers stored in SafeWebAuthnSharedSigner for the account. */
export type WebAuthnSigner = { x: bigint; y: bigint; verifiers: bigint }

export type SafeSetup = {
  owners: Address[]
  threshold: bigint
  validators: ModuleInit[]
  saltNonce: bigint
  /** Required when SafeWebAuthnSharedSigner is an owner: configured inside Safe.setup, so the address commits to it. */
  webauthn?: WebAuthnSigner
}

/**
 * The delegatecall Safe.setup makes. The launchpad's addSafe7579 enables
 * Safe7579 as module and installs the given validators. The deployed Safe7579
 * requires at least one ERC-7484 attester; the account trusts only the
 * Rhinestone attester, threshold 1. With a passkey owner, MultiSend 1.4.1
 * also delegatecalls SafeWebAuthnSharedSigner.configure in the same setup.
 */
export function setupDelegate(setup: SafeSetup): { to: Address; data: Hex } {
  const sharedSigner = address('SafeWebAuthnSharedSigner').toLowerCase()
  const ownsWithPasskey = setup.owners.some((o) => o.toLowerCase() === sharedSigner)
  if (ownsWithPasskey !== !!setup.webauthn) throw new Error('SafeWebAuthnSharedSigner is an owner exactly when the setup carries its passkey')
  const safe7579 = address('Safe7579')
  const launch = {
    to: address('Safe7579Launchpad'),
    data: encodeFunctionData({
      abi: safe7579LaunchpadAbi,
      functionName: 'addSafe7579',
      args: [safe7579, setup.validators, [], [], [], [address('RhinestoneAttester')], 1],
    }),
  }
  if (!setup.webauthn) return launch
  const cfg = configureSharedSigner(setup.webauthn.x, setup.webauthn.y, setup.webauthn.verifiers)
  const packed = concat(
    [launch, cfg].map((c) => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [OPERATION_DELEGATECALL, c.to, 0n, BigInt(size(c.data)), c.data])),
  )
  // MultiSend 1.4.1 has the same multiSend(bytes) signature as MultiSendCallOnly, but allows delegatecall entries.
  return { to: address('MultiSend_141'), data: encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName: 'multiSend', args: [packed] }) }
}

/** Safe.setup with Safe7579 as fallback handler and setupDelegate as the setup delegatecall. */
export function safeInitializer(setup: SafeSetup): Hex {
  const delegate = setupDelegate(setup)
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [setup.owners, setup.threshold, delegate.to, delegate.data, address('Safe7579'), zeroAddress, 0n, zeroAddress],
  })
}

export function createProxyCall(setup: SafeSetup): { to: Address; data: Hex } {
  return {
    to: address('SafeProxyFactory_141'),
    data: encodeFunctionData({
      abi: safeProxyFactoryAbi,
      functionName: 'createProxyWithNonce',
      args: [address('SafeL2_141'), safeInitializer(setup), setup.saltNonce],
    }),
  }
}

export type SafeTx = {
  to: Address
  value: bigint
  data: Hex
  operation: 0 | 1
  nonce: bigint
}

export function safeTxTypedData(safe: Address, chainId: number, tx: SafeTx) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'SafeTx' as const,
    message: {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: tx.nonce,
    },
  }
}

/** EIP-712 signature by an EOA owner, bound to the chain id and the Safe address. */
export async function signSafeTx(owner: LocalAccount, safe: Address, chainId: number, tx: SafeTx): Promise<Hex> {
  if (!owner.signTypedData) throw new Error('owner cannot sign typed data')
  return owner.signTypedData(safeTxTypedData(safe, chainId, tx))
}

export function execTransactionData(tx: SafeTx, signatures: Hex): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures],
  })
}

export type MultiSendCall = { to: Address; value: bigint; data: Hex }

/** Batch for MultiSendCallOnly 1.4.1, delegatecalled by the Safe. Only CALL entries. */
export function multiSendCallOnly(calls: MultiSendCall[]): { to: Address; data: Hex; operation: 1 } {
  const packed = concat(
    calls.map((c) =>
      encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [OPERATION_CALL, c.to, c.value, BigInt(size(c.data)), c.data]),
    ),
  )
  return {
    to: address('MultiSendCallOnly_141'),
    data: encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName: 'multiSend', args: [packed] }),
    operation: OPERATION_DELEGATECALL,
  }
}

/** Owner transaction that stores the passkey coordinates in SafeWebAuthnSharedSigner (delegatecall). */
export function configureSharedSigner(x: bigint, y: bigint, verifiers: bigint): { to: Address; data: Hex; operation: 1 } {
  return {
    to: address('SafeWebAuthnSharedSigner'),
    data: encodeFunctionData({ abi: safeWebAuthnSharedSignerAbi, functionName: 'configure', args: [{ x, y, verifiers }] }),
    operation: OPERATION_DELEGATECALL,
  }
}

/**
 * SafeWebAuthnSharedSigner packs the verifier as uint176: the precompile
 * address (uint16) in the high bits and the fallback verifier in the low 160.
 */
export function packVerifiers(precompile: number, fallback: Address): bigint {
  return (BigInt(precompile) << 160n) | BigInt(fallback)
}

/** RIP-7212 P-256 precompile address. */
export const P256_PRECOMPILE_ADDRESS = 0x100

/** A passkey owner verified by the RIP-7212 precompile, with the pinned P256Verifier as fallback. */
export function webAuthnSigner(x: bigint, y: bigint): WebAuthnSigner {
  return { x, y, verifiers: packVerifiers(P256_PRECOMPILE_ADDRESS, address('P256Verifier')) }
}

// ERC-7579 execution modes (Safe7579.execute)

export const CALLTYPE_SINGLE = 0x00
export const CALLTYPE_BATCH = 0x01
export const CALLTYPE_STATIC = 0xfe
export const CALLTYPE_DELEGATECALL = 0xff
export const EXECTYPE_DEFAULT = 0x00
export const EXECTYPE_TRY = 0x01

export function encodeMode(callType: number, execType: number): Hex {
  return pad(concat([numberToHex(callType, { size: 1 }), numberToHex(execType, { size: 1 })]), { dir: 'right', size: 32 })
}

export function decodeMode(mode: Hex): { callType: number; execType: number } {
  return { callType: parseInt(mode.slice(2, 4), 16), execType: parseInt(mode.slice(4, 6), 16) }
}

export type Execution = { target: Address; value: bigint; callData: Hex }

export function encodeSingleExecution(e: Execution): Hex {
  return encodePacked(['address', 'uint256', 'bytes'], [e.target, e.value, e.callData])
}

export function encodeBatchExecution(es: Execution[]): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    [es],
  )
}

export function encodeDelegateExecution(target: Address, callData: Hex): Hex {
  return encodePacked(['address', 'bytes'], [target, callData])
}
