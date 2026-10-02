import type { PasskeyOwner } from '@mamoru/domain'
import { checkClaims, constantTimeEqual } from './webauthn.ts'

// Onboarding proof: what navigator.credentials.create() returned, checked before an account row exists.
// With attestation "none" nothing here is signed by the new key, so this is not a cryptographic proof of possession.
// It proves the registration data was produced for a challenge this server issued, on this site, and that the
// credential id and public key being stored are the ones inside that authenticator data.

/** authenticatorData flag: attested credential data included. */
const FLAG_AT = 0x40
/** rpIdHash, flags, signCount, aaguid, credentialIdLength. */
const ATTESTED_HEADER = 32 + 1 + 4 + 16 + 2

export type RegistrationRefusal = 'claims' | 'no_credential_data' | 'credential_id' | 'public_key'

type CborValue = number | Uint8Array

/** The few CBOR shapes a COSE EC2 key uses: a map of small integers to integers or byte strings. Null for anything else. */
export function coseKeyMap(bytes: Uint8Array): Map<number, CborValue> | null {
  let i = 0
  const head = (): { major: number; value: number } | null => {
    const b = bytes[i++]
    if (b === undefined) return null
    const major = b >> 5
    const info = b & 0x1f
    if (info < 24) return { major, value: info }
    if (info === 24 && i < bytes.length) return { major, value: bytes[i++]! }
    if (info === 25 && i + 1 < bytes.length) {
      const value = (bytes[i]! << 8) | bytes[i + 1]!
      i += 2
      return { major, value }
    }
    return null
  }
  const item = (): CborValue | null => {
    const h = head()
    if (!h) return null
    if (h.major === 0) return h.value
    if (h.major === 1) return -1 - h.value
    if (h.major === 2 && i + h.value <= bytes.length) return bytes.subarray(i, (i += h.value))
    return null
  }
  const map = head()
  if (!map || map.major !== 5 || map.value > 16) return null
  const out = new Map<number, CborValue>()
  for (let n = 0; n < map.value; n++) {
    const key = item()
    const value = item()
    if (typeof key !== 'number' || value === null) return null
    out.set(key, value)
  }
  return out
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const hex32 = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`

/** Null when the registration data matches the challenge, this site and the passkey being stored; otherwise why not. */
export async function checkRegistration(
  proof: { clientDataJSON: Uint8Array; authenticatorData: Uint8Array },
  expected: { challenge: string; origin: string; rpId: string },
  passkey: PasskeyOwner,
): Promise<RegistrationRefusal | null> {
  const auth = proof.authenticatorData
  const claims = await checkClaims({ ...proof, signature: new Uint8Array() }, { ...expected, type: 'webauthn.create' })
  if (claims.reason) return 'claims'
  if (!(auth[32]! & FLAG_AT) || auth.length < ATTESTED_HEADER) return 'no_credential_data'
  const idLength = (auth[53]! << 8) | auth[54]!
  if (auth.length < ATTESTED_HEADER + idLength) return 'no_credential_data'
  if (!constantTimeEqual(b64url(auth.subarray(ATTESTED_HEADER, ATTESTED_HEADER + idLength)), passkey.credentialId)) return 'credential_id'
  // COSE_Key: kty 2 (EC2), alg -7 (ES256), crv 1 (P-256), x and y.
  const key = coseKeyMap(auth.subarray(ATTESTED_HEADER + idLength))
  const [x, y] = [key?.get(-2), key?.get(-3)]
  if (!key || key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1) return 'public_key'
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return 'public_key'
  if (hex32(x) !== passkey.x.toLowerCase() || hex32(y) !== passkey.y.toLowerCase()) return 'public_key'
  return null
}
