import { concat, decodeFunctionData, encodeFunctionData, encodePacked, getContractAddress, keccak256, pad } from 'viem'
import type { Address, Hex } from '@mamoru/domain'
import { address, safeProxyFactoryAbi } from '@mamoru/registry'
import { createProxyCall, safeInitializer, setupDelegate, type SafeSetup, type WebAuthnSigner } from '../safe/index.ts'

/**
 * type(SafeProxy).creationCode of Safe 1.4.1, as embedded in the
 * SafeProxyFactory_141 runtime code whose hash the registry pins.
 */
export const SAFE_PROXY_141_CREATION_CODE: Hex =
  '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564'

/**
 * FR-ONB-005: the given owners, threshold 1, Safe7579, Smart Sessions installed
 * with no sessions. A passkey owner (SafeWebAuthnSharedSigner) is configured in
 * the same setup, so the address commits to its x, y and verifiers.
 */
export function accountSetup(owners: Address[], saltNonce: bigint, webauthn: WebAuthnSigner | null): SafeSetup {
  if (owners.length === 0) throw new Error('at least one owner')
  const setup: SafeSetup = { owners, threshold: 1n, validators: [{ module: address('SmartSession'), initData: '0x' }], saltNonce }
  if (webauthn) setup.webauthn = { ...webauthn }
  setupDelegate(setup)
  return setup
}

/**
 * Address that SafeProxyFactory_141.createProxyWithNonce deploys for this
 * setup, read from the same call createProxyCall builds.
 */
export function counterfactualAddress(setup: SafeSetup): Address {
  const call = createProxyCall(setup)
  const { args } = decodeFunctionData({ abi: safeProxyFactoryAbi, data: call.data })
  const [singleton, initializer, saltNonce] = args
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), saltNonce]))
  const bytecode = concat([SAFE_PROXY_141_CREATION_CODE, pad(singleton)])
  return getContractAddress({ opcode: 'CREATE2', from: call.to, salt, bytecode })
}

export const WALKAWAY_DOC = 'docs/walkaway.md'

/** FR-ONB-006. Public data only; integers as decimal strings so the kit is plain JSON. */
export type RecoveryKit = {
  chainId: number
  address: Address
  setup: {
    factory: Address
    singleton: Address
    owners: Address[]
    threshold: string
    saltNonce: string
    /** The delegatecall inside Safe.setup (MultiSend 1.4.1 with a passkey owner). */
    to: Address
    data: Hex
    initializer: Hex
  }
  /** SafeWebAuthnSharedSigner configuration bound at setup; public key only. */
  webauthn: { signer: Address; x: string; y: string; verifiers: string } | null
  modules: {
    adapter: Address
    launchpad: Address
    validators: { module: Address; initData: Hex }[]
    registry: Address
    attesters: Address[]
    attesterThreshold: number
  }
  owners: Address[]
  permissionIds: Hex[]
  tokenIds: string[]
  walkaway: typeof WALKAWAY_DOC
}

export type RecoveryKitInput = {
  chainId: number
  owners: Address[]
  saltNonce: bigint
  webauthn: WebAuthnSigner | null
  permissionIds: Hex[]
  tokenIds: bigint[]
}

/** Copies only the listed fields: extra fields on the input never reach the kit. */
export function recoveryKit(input: RecoveryKitInput): RecoveryKit {
  const setup = accountSetup([...input.owners], input.saltNonce, input.webauthn)
  const delegate = setupDelegate(setup)
  return {
    chainId: input.chainId,
    address: counterfactualAddress(setup),
    setup: {
      factory: address('SafeProxyFactory_141'),
      singleton: address('SafeL2_141'),
      owners: [...setup.owners],
      threshold: setup.threshold.toString(),
      saltNonce: setup.saltNonce.toString(),
      to: delegate.to,
      data: delegate.data,
      initializer: safeInitializer(setup),
    },
    webauthn: setup.webauthn
      ? {
          signer: address('SafeWebAuthnSharedSigner'),
          x: setup.webauthn.x.toString(),
          y: setup.webauthn.y.toString(),
          verifiers: setup.webauthn.verifiers.toString(),
        }
      : null,
    modules: {
      adapter: address('Safe7579'),
      launchpad: address('Safe7579Launchpad'),
      validators: setup.validators.map((v) => ({ module: v.module, initData: v.initData })),
      registry: address('ModuleRegistry'),
      attesters: [address('RhinestoneAttester')],
      attesterThreshold: 1,
    },
    owners: [...setup.owners],
    permissionIds: [...input.permissionIds],
    tokenIds: input.tokenIds.map((t) => t.toString()),
    walkaway: WALKAWAY_DOC,
  }
}

/** WALK-04: the factory call an owner sends from the kit alone, without Mamoru code. */
export function deployCallFromKit(kit: RecoveryKit): { to: Address; data: Hex } {
  return {
    to: kit.setup.factory,
    data: encodeFunctionData({
      abi: safeProxyFactoryAbi,
      functionName: 'createProxyWithNonce',
      args: [kit.setup.singleton, kit.setup.initializer, BigInt(kit.setup.saltNonce)],
    }),
  }
}
