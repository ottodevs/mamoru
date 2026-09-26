import type { PasskeyOwner } from '@mamoru/domain'

// P-256 (secp256r1) domain parameters.
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
const COORD = /^0x[0-9a-fA-F]{64}$/
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,1023}$/

const mod = (v: bigint) => ((v % P) + P) % P

/** True when (x, y) is an affine point of P-256, the only key SafeWebAuthnSharedSigner verifies. */
export function isP256Point(x: bigint, y: bigint): boolean {
  if (x <= 0n || y <= 0n || x >= P || y >= P) return false
  return mod(y * y) === mod(x * x * x - 3n * x + B)
}

/** Parses the passkey part of OwnerRequest; null when anything is off. */
export function parsePasskey(input: unknown): PasskeyOwner | null {
  if (typeof input !== 'object' || input === null) return null
  const { credentialId, x, y } = input as Record<string, unknown>
  if (typeof credentialId !== 'string' || !CREDENTIAL_ID.test(credentialId)) return null
  if (typeof x !== 'string' || typeof y !== 'string' || !COORD.test(x) || !COORD.test(y)) return null
  if (!isP256Point(BigInt(x), BigInt(y))) return null
  return { credentialId, x: x.toLowerCase() as PasskeyOwner['x'], y: y.toLowerCase() as PasskeyOwner['y'] }
}
