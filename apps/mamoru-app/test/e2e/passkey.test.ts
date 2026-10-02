import { describe, expect, test } from 'bun:test'
import type { SignInChallenge } from '@mamoru/domain'
import { authDataFromAttestationObject, base64url, createOwnerPasskey, p256FromSpki, PasskeyError } from '../../src/web/lib/passkey.ts'

function b64urlToHex(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return `0x${Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`
}

// attestationObject fixtures. AUTH_DATA is 164 bytes, the size of a real registration with a 32-byte credential id:
// rpIdHash, flags 0x45, counter, aaguid, id length, id, COSE key.
const AUTH_DATA = Uint8Array.from({ length: 164 }, (_, i) => (i * 7 + 3) & 0xff)
const text = (s: string) => [0x60 + s.length, ...new TextEncoder().encode(s)]
// {"fmt": "none", "attStmt": {}, "authData": h'...'} as browsers emit it with attestation "none".
const NONE = Uint8Array.from([0xa3, ...text('fmt'), ...text('none'), ...text('attStmt'), 0xa0, ...text('authData'), 0x58, AUTH_DATA.length, ...AUTH_DATA])
// A packed statement before authData: {"alg": -7, "sig": h'(70 bytes)', "x5c": [h'(300 bytes)']}, and a two-byte length.
const BIG = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff)
const PACKED = Uint8Array.from([
  0xa3, ...text('fmt'), ...text('packed'),
  ...text('attStmt'), 0xa3, ...text('alg'), 0x26, ...text('sig'), 0x58, 70, ...new Uint8Array(70).fill(9), ...text('x5c'), 0x81, 0x59, 0x01, 0x2c, ...BIG,
  ...text('authData'), 0x59, 0x01, 0x2c, ...BIG,
])

describe('authData from an attestationObject', () => {
  test('attestation "none": the byte string under authData', () => {
    expect(authDataFromAttestationObject(NONE)).toEqual(AUTH_DATA)
    expect(authDataFromAttestationObject(NONE.buffer as ArrayBuffer)).toEqual(AUTH_DATA)
  })
  test('authData first, or after a statement with nested maps, arrays and long byte strings', () => {
    const first = Uint8Array.from([0xa3, ...text('authData'), 0x58, AUTH_DATA.length, ...AUTH_DATA, ...text('fmt'), ...text('none'), ...text('attStmt'), 0xa0])
    expect(authDataFromAttestationObject(first)).toEqual(AUTH_DATA)
    expect(authDataFromAttestationObject(PACKED)).toEqual(BIG)
  })
  test('anything else is refused, never read past its end', () => {
    const bad = [
      new Uint8Array(),
      Uint8Array.from([0x80]), // an array, not a map
      Uint8Array.from([0xa1, ...text('fmt'), ...text('none')]), // no authData
      Uint8Array.from([0xa1, ...text('authData'), ...text('text')]), // authData is not a byte string
      NONE.subarray(0, NONE.length - 10), // truncated
      Uint8Array.from([0xa1, 0x01, 0x02]), // integer key
      Uint8Array.from([0xbf, ...text('authData'), 0x41, 0x00, 0xff]), // indefinite-length map
    ]
    for (const b of bad) expect(() => authDataFromAttestationObject(b)).toThrow(PasskeyError)
  })
})

describe('owner passkey public key', () => {
  test('SPKI yields the same x and y as the JWK', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey)
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const { x, y } = await p256FromSpki(spki)
    expect(x).toBe(b64urlToHex(jwk.x as string) as `0x${string}`)
    expect(y).toBe(b64urlToHex(jwk.y as string) as `0x${string}`)
    expect(x).toHaveLength(66)
  })
  test('rejects a key on another curve', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'])
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey)
    expect(p256FromSpki(spki)).rejects.toThrow()
  })
  test('credential id is base64url without padding', () => {
    expect(base64url(new Uint8Array([251, 255, 0]))).toBe('-_8A')
  })
  test('registration uses the server challenge and returns what the browser made for it as the proof', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey)
    const g = globalThis as Record<string, unknown>
    const before = { pkc: g.PublicKeyCredential, credentials: Object.getOwnPropertyDescriptor(navigator, 'credentials') }
    const asked: CredentialCreationOptions[] = []
    const bytes = (...b: number[]) => new Uint8Array(b).buffer
    const response = { getPublicKeyAlgorithm: () => -7, getPublicKey: () => spki, clientDataJSON: bytes(1, 2, 3), getAuthenticatorData: () => bytes(4, 5) as ArrayBuffer | undefined, attestationObject: NONE.buffer as ArrayBuffer }
    g.PublicKeyCredential = class {}
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create: async (o: CredentialCreationOptions) => (asked.push(o), { rawId: bytes(251, 255, 0), response }) } })
    try {
      const challenge: SignInChallenge = { challenge: base64url(new Uint8Array(32).fill(9)), token: 'reg-token', rpId: 'app.mamoru.lol', expiresAt: '2026-10-01T10:05:00Z' }
      const made = await createOwnerPasskey(challenge)
      expect(Array.from(asked[0]!.publicKey!.challenge as Uint8Array)).toEqual(Array(32).fill(9))
      expect(asked[0]!.publicKey!.attestation).toBe('none')
      expect(made.passkey.credentialId).toBe('-_8A')
      expect(made.passkey).toMatchObject(await p256FromSpki(spki))
      expect(made.proof).toEqual({ token: 'reg-token', clientDataJSON: 'AQID', authenticatorData: 'BAU' })
      // A browser without getAuthenticatorData(): the same bytes come out of attestationObject.
      ;(response as { getAuthenticatorData?: unknown }).getAuthenticatorData = undefined
      expect((await createOwnerPasskey(challenge)).proof.authenticatorData).toBe(base64url(AUTH_DATA))
      response.attestationObject = bytes(0xa0)
      expect(createOwnerPasskey(challenge)).rejects.toBeInstanceOf(PasskeyError)
    } finally {
      g.PublicKeyCredential = before.pkc
      if (before.credentials) Object.defineProperty(navigator, 'credentials', before.credentials)
      else delete (navigator as unknown as Record<string, unknown>).credentials
    }
  })
})
