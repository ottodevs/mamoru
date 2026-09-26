import { hexToBigInt, keccak256, stringToBytes } from 'viem'
import type { Address } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'

export const ACCOUNT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Deterministic saltNonce of an account: keccak256 of its key, as uint256. */
export function saltNonceOf(accountKey: string): bigint {
  return hexToBigInt(keccak256(stringToBytes(`mamoru:account:${accountKey}`)))
}

/**
 * Same owner layout as T002 (fixtures/world.ts): the passkey owns the Safe
 * through SafeWebAuthnSharedSigner, whose x/y the first owner transaction
 * stores with configureSharedSigner. Nothing is signed or sent here.
 */
export function accountOwners(): Address[] {
  return [address('SafeWebAuthnSharedSigner')]
}

export function counterfactualAccount(accountKey: string): { owners: Address[]; saltNonce: bigint; address: Address } {
  const owners = accountOwners()
  const saltNonce = saltNonceOf(accountKey)
  return { owners, saltNonce, address: counterfactualAddress(accountSetup(owners, saltNonce)) }
}
