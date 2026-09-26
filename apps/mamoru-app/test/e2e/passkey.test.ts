import { describe, expect, test } from 'bun:test'
import { base64url, p256FromSpki } from '../../src/web/lib/passkey.ts'

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
})
