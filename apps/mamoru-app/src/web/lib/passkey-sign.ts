import type { Hex0x, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { base64url, PasskeyError } from './passkey.ts'

const STORE_PREFIX = 'mamoru.owner.credentialId.'

/** Remembers which passkey owns the account, so the browser offers that one when signing. */
export function rememberCredential(accountKey: string, credentialId: string): void {
  try {
    localStorage.setItem(STORE_PREFIX + accountKey, credentialId)
  } catch {
    // Storage blocked: signing still works, the browser lets the owner pick the passkey.
  }
}

export function storedCredential(accountKey: string): string | undefined {
  try {
    return localStorage.getItem(STORE_PREFIX + accountKey) ?? undefined
  } catch {
    return undefined
  }
}

/** Credential ids this browser used for an account here: a returning owner whose session is gone. */
export function knownCredentials(): string[] {
  try {
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      const v = k?.startsWith(STORE_PREFIX) ? localStorage.getItem(k) : null
      if (v && !out.includes(v)) out.push(v)
    }
    return out
  } catch {
    return []
  }
}

export function hexToBytes(hex: Hex0x | string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`not hex: ${hex}`)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The owner closed the passkey prompt or it timed out. Not an error worth alarming about. */
export function isPasskeyCancel(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')
}

/**
 * Signs a prepared Safe transaction with the owner passkey (SafeWebAuthnSharedSigner).
 * The WebAuthn challenge is the raw bytes of safeTxHash. Every field returns as base64url.
 */
export async function signOwnerTx(tx: OwnerTxToSign, credentialId: string | undefined): Promise<OwnerSignature> {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) {
    throw new PasskeyError('This browser does not support passkeys. Open Mamoru in the browser that holds your owner passkey.')
  }
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(tx.safeTxHash) as BufferSource,
      allowCredentials: credentialId ? [{ type: 'public-key', id: base64urlDecode(credentialId) as BufferSource }] : [],
      userVerification: 'required',
      rpId: location.hostname,
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null
  if (!assertion) throw new PasskeyError('No passkey signature was returned. Try again.')
  const r = assertion.response as AuthenticatorAssertionResponse
  return {
    prepareId: tx.prepareId,
    authenticatorData: base64url(r.authenticatorData),
    clientDataJSON: base64url(r.clientDataJSON),
    signature: base64url(r.signature),
  }
}
