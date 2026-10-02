import { describe, expect, test } from 'bun:test'
import type { SignInChallenge } from '@mamoru/domain'
import { base64url, createOwnerPasskey, p256FromSpki, PasskeyError } from '../../src/web/lib/passkey.ts'

function b64urlToHex(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return `0x${Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`
}

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
    const response = { getPublicKeyAlgorithm: () => -7, getPublicKey: () => spki, clientDataJSON: bytes(1, 2, 3), getAuthenticatorData: () => bytes(4, 5) as ArrayBuffer | undefined }
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
      // A browser that cannot hand over the authenticator data cannot register here.
      ;(response as { getAuthenticatorData?: unknown }).getAuthenticatorData = undefined
      expect(createOwnerPasskey(challenge)).rejects.toBeInstanceOf(PasskeyError)
    } finally {
      g.PublicKeyCredential = before.pkc
      if (before.credentials) Object.defineProperty(navigator, 'credentials', before.credentials)
      else delete (navigator as unknown as Record<string, unknown>).credentials
    }
  })
})
