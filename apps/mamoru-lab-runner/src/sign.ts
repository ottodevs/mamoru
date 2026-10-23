/**
 * Request signing, lab runner -> landing Worker (spec 008 Architecture, B-05). Web Crypto only (`crypto.subtle`, no
 * `node:crypto` import), the same discipline `packages/operator-auth/src/index.ts` uses for the operator's HMAC
 * schemes, so the Worker side can port this byte for byte instead of drifting a second implementation:
 *
 *   x-lab-ts    = unix seconds
 *   x-lab-nonce = 32 hex chars (16 random bytes)
 *   x-lab-sig   = hex HMAC-SHA256(secret, `${method}\n${path}\n${ts}\n${nonce}\n${hex sha256(body)}`)
 *
 * The Worker refuses a timestamp older than 60s, a nonce it has seen in the last 10 min (`lab_nonces`), and a body
 * whose hash does not match — a captured request cannot be replayed or carry another body. This file only signs;
 * verifying is the landing Worker's job, out of scope here.
 */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body) as Uint8Array<ArrayBuffer>)
  return toHex(new Uint8Array(digest))
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(message) as Uint8Array<ArrayBuffer>)
  return toHex(new Uint8Array(mac))
}

/** 32 hex chars from 16 random bytes. */
export function randomNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)))
}

/** The pure signature, given every input explicit — what a fixed test vector checks, and what a verifier recomputes. */
export async function signatureFor(secret: string, method: string, path: string, ts: number, nonce: string, body: string): Promise<string> {
  const bodyHash = await sha256Hex(body)
  return hmacHex(secret, `${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`)
}

export type SignedHeaders = { 'x-lab-ts': string; 'x-lab-nonce': string; 'x-lab-sig': string; 'content-type': string }

/** `path` as the request line reads it: no origin, e.g. `/ops/lab/runner/claim`. Generates `ts` and the nonce. */
export async function signRequest(secret: string, method: string, path: string, body: string): Promise<SignedHeaders> {
  const ts = Math.floor(Date.now() / 1000)
  const nonce = randomNonce()
  const sig = await signatureFor(secret, method, path, ts, nonce, body)
  return { 'x-lab-ts': String(ts), 'x-lab-nonce': nonce, 'x-lab-sig': sig, 'content-type': 'application/json' }
}
