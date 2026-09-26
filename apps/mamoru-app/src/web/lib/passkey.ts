import type { Hex0x, PasskeyOwner } from '@mamoru/domain'

const ES256 = -7

function toHex(bytes: Uint8Array): Hex0x {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of view) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** P-256 x and y from an SPKI public key. WebCrypto checks the curve; raw export is 0x04 || x || y. */
export async function p256FromSpki(spki: ArrayBuffer | Uint8Array): Promise<{ x: Hex0x; y: Hex0x }> {
  const data = spki instanceof Uint8Array ? spki : new Uint8Array(spki)
  const key = await crypto.subtle.importKey('spki', data as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('Unexpected P-256 public key encoding')
  return { x: toHex(raw.slice(1, 33)), y: toHex(raw.slice(33, 65)) }
}

export class PasskeyError extends Error {}

/**
 * Creates the account owner passkey (FR-ONB-003): ES256 only, resident key preferred, user verification required.
 * Registration only. Nothing is signed here.
 */
export async function createOwnerPasskey(): Promise<PasskeyOwner> {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) {
    throw new PasskeyError('This browser does not support passkeys. Open Mamoru in a browser with passkey support and try again.')
  }
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Mamoru' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Mamoru account owner', displayName: 'Mamoru account owner' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new PasskeyError('No passkey was created. Try again.')
  const response = credential.response as AuthenticatorAttestationResponse
  if (response.getPublicKeyAlgorithm() !== ES256) {
    throw new PasskeyError('Your authenticator did not create a P-256 passkey. Use another authenticator and try again.')
  }
  const spki = response.getPublicKey()
  if (!spki) throw new PasskeyError('Your browser did not return the passkey public key. Try another browser.')
  const { x, y } = await p256FromSpki(spki)
  return { credentialId: base64url(credential.rawId), x, y }
}
