import { fromB64url, parseDerSignature } from '@mamoru/account/live'

// Server-side check of a WebAuthn assertion (navigator.credentials.get) with WebCrypto only.
// The claims are checked once; the signature is then verified against each candidate P-256 key.

const FLAG_UP = 0x01
const FLAG_UV = 0x04
/** rpIdHash (32) + flags (1) + signCount (4). */
const AUTH_DATA_MIN = 37

export type Assertion = { authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array }
export type Expected = { challenge: string; origin: string; rpId: string }
export type AssertionRefusal = 'client_data' | 'type' | 'challenge' | 'origin' | 'cross_origin' | 'auth_data' | 'rp_id' | 'user_present' | 'user_verified' | 'signature'

const enc = new TextEncoder()
/** WebCrypto wants a view over a plain ArrayBuffer; every array here is one. */
export const plain = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>

/** Compares every byte whatever the first difference is, so timing does not tell where two values diverge. */
export function constantTimeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const x = typeof a === 'string' ? enc.encode(a) : a
  const y = typeof b === 'string' ? enc.encode(b) : b
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', plain(typeof data === 'string' ? enc.encode(data) : data)))
}

/** base64url text to bytes; null when it is not base64url. */
export function decodeB64url(s: unknown, maxLength: number): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(s)) return null
  try {
    return fromB64url(s)
  } catch {
    return null
  }
}

/**
 * WebAuthn §7.2 steps that do not need the key: type, challenge, origin, rpIdHash, user present and verified.
 * Returns the bytes the authenticator signed (authenticatorData || SHA-256(clientDataJSON)).
 */
export async function checkClaims(a: Assertion, expected: Expected): Promise<{ ok: true; signed: Uint8Array } | { ok: false; reason: AssertionRefusal }> {
  const no = (reason: AssertionRefusal) => ({ ok: false as const, reason })
  let client: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(a.clientDataJSON))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return no('client_data')
    client = parsed as Record<string, unknown>
  } catch {
    return no('client_data')
  }
  if (client.type !== 'webauthn.get') return no('type')
  if (typeof client.challenge !== 'string' || !constantTimeEqual(client.challenge, expected.challenge)) return no('challenge')
  if (typeof client.origin !== 'string' || !constantTimeEqual(client.origin, expected.origin)) return no('origin')
  // An assertion made inside a cross-origin iframe is not the owner at this site.
  if (client.crossOrigin === true || client.topOrigin !== undefined) return no('cross_origin')

  const auth = a.authenticatorData
  if (auth.length < AUTH_DATA_MIN) return no('auth_data')
  if (!constantTimeEqual(auth.subarray(0, 32), await sha256(expected.rpId))) return no('rp_id')
  const flags = auth[32]!
  if (!(flags & FLAG_UP)) return no('user_present')
  if (!(flags & FLAG_UV)) return no('user_verified')

  const hash = await sha256(a.clientDataJSON)
  const signed = new Uint8Array(auth.length + hash.length)
  signed.set(auth)
  signed.set(hash, auth.length)
  return { ok: true, signed }
}

function bytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** ES256 over `signed` with the stored public key (accounts.passkey_x / passkey_y). The signature is ASN.1 DER, as browsers return it. */
export async function verifyP256(key: { x: string; y: string }, signed: Uint8Array, derSignature: Uint8Array): Promise<boolean> {
  try {
    const raw = new Uint8Array(65)
    raw[0] = 0x04
    raw.set(bytes32(BigInt(key.x)), 1)
    raw.set(bytes32(BigInt(key.y)), 33)
    const pub = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const { r, s } = parseDerSignature(derSignature)
    const sig = new Uint8Array(64)
    sig.set(bytes32(r))
    sig.set(bytes32(s), 32)
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, plain(signed))
  } catch {
    return false
  }
}

/** The P-256 base point: a valid key nobody holds, verified against when no account matches so both paths cost the same. */
export const DECOY_KEY = {
  x: '0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',
  y: '0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
}
