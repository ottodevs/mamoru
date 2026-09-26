import { hexToBigInt, keccak256, stringToBytes } from 'viem'
import type { Address, Hex0x } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { webAuthnSigner, type WebAuthnSigner } from '@mamoru/account/safe'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'

export const ACCOUNT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Deterministic saltNonce of an account: keccak256 of its key, as uint256. */
export function saltNonceOf(accountKey: string): bigint {
  return hexToBigInt(keccak256(stringToBytes(`mamoru:account:${accountKey}`)))
}

/** The passkey owner: SafeWebAuthnSharedSigner configured with x, y and the pinned verifiers inside Safe.setup. */
export function passkeySigner(x: Hex0x, y: Hex0x): WebAuthnSigner {
  return webAuthnSigner(hexToBigInt(x), hexToBigInt(y))
}

export function accountOwners(): Address[] {
  return [address('SafeWebAuthnSharedSigner')]
}

/** Counterfactual Safe on Base whose address commits to the passkey. Nothing is signed or sent. */
export function counterfactualAccount(accountKey: string, passkey: { x: Hex0x; y: Hex0x }) {
  const owners = accountOwners()
  const saltNonce = saltNonceOf(accountKey)
  const webauthn = passkeySigner(passkey.x, passkey.y)
  return { owners, saltNonce, webauthn, address: counterfactualAddress(accountSetup(owners, saltNonce, webauthn)) }
}
