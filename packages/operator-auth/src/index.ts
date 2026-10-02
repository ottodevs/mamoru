/**
 * Operator-level metrics auth (GET /metrics). Distinct from the per-account HMAC scheme in
 * apps/mamoru-operator/src/server.ts, which signs over an account context header and a body.
 * GET /metrics carries neither, so it is signed over the method, path and a one-minute time
 * window instead:
 *
 *   x-mamoru-sig = hex HMAC-SHA256(OPERATOR_SECRET, `${method} ${path} ${unixMinute}`)
 *
 * `unixMinute` is `Math.floor(Date.now() / 60_000)`. A verifier accepts the current minute and
 * the previous one, so a request signed just before a minute boundary still verifies.
 *
 * Web Crypto only (crypto.subtle, no node:crypto import): this runs unchanged in Bun (the
 * operator, which serves the route) and in a Cloudflare Worker (the landing app, the intended
 * caller that reads /metrics for an ops dashboard), so both sides compute the exact same signature
 * from one implementation instead of drifting copies.
 */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function hmacBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  // The cast works around a TS lib nuance (Uint8Array<ArrayBufferLike> vs <ArrayBuffer>) with no
  // DOM lib loaded here; `data` is always a plain, non-shared Uint8Array at every call site.
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as Uint8Array<ArrayBuffer>))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Decodes a lowercase/uppercase hex string, or null if it is not valid hex (odd length, non-hex char) — never throws. */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    out[i] = byte
  }
  return out
}

/** The signature a caller sends: `x-mamoru-sig` on `GET /metrics`. */
export async function metricsSignature(secret: string, method: string, path: string, unixMinute: number): Promise<string> {
  const mac = await hmacBytes(await hmacKey(secret), new TextEncoder().encode(`${method} ${path} ${unixMinute}`))
  return toHex(mac)
}

type BareCryptoWithTSE = { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean }
type SubtleWithTSE = { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean }

/**
 * A real constant-time comparison of two hex-encoded signatures, in whichever form the runtime
 * actually offers one:
 *   1. Bun (and Node): the global `crypto.timingSafeEqual` — the same primitive as
 *      `node:crypto`'s, but reachable without importing `node:crypto` (which does not exist in a
 *      Cloudflare Worker, so this file never imports it).
 *   2. Cloudflare Workers: `crypto.subtle.timingSafeEqual`, a Workers-runtime extension to
 *      SubtleCrypto with the same contract.
 *   3. Anywhere else (a plain standards-only Web Crypto environment): double-HMAC — both values
 *      are re-MACed under one fresh random per-call key and the (high-entropy, avalanched) MAC
 *      outputs are compared instead of the originals. A non-constant-time compare of those outputs
 *      leaks nothing about the inputs: changing a single input bit flips roughly half the output
 *      bits, so "how many leading bytes happened to match" carries no information about the secret.
 * Different lengths (or invalid hex) are rejected immediately in every path — that alone only ever
 * leaks "wrong shape", never which byte differed.
 */
export async function timingSafeEqualHex(a: string, b: string): Promise<boolean> {
  const bytesA = hexToBytes(a)
  const bytesB = hexToBytes(b)
  if (!bytesA || !bytesB || bytesA.length !== bytesB.length) return false

  // Called as `crypto.timingSafeEqual(...)` / `crypto.subtle.timingSafeEqual(...)`, not extracted
  // into a local first: both Bun's and the Workers runtime's native implementations require their
  // real `this` (the crypto/subtle object itself), and throw "Expected this to be instanceof
  // Crypto/SubtleCrypto" if called detached from it.
  const bareCrypto = crypto as unknown as BareCryptoWithTSE
  if (typeof bareCrypto.timingSafeEqual === 'function') return bareCrypto.timingSafeEqual(bytesA, bytesB)

  const subtle = crypto.subtle as SubtleWithTSE
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(bytesA, bytesB)

  const key = await hmacKey(toHex(crypto.getRandomValues(new Uint8Array(32))))
  const [macA, macB] = await Promise.all([hmacBytes(key, bytesA), hmacBytes(key, bytesB)])
  if (macA.length !== macB.length) return false
  let diff = 0
  for (let i = 0; i < macA.length; i++) diff |= macA[i]! ^ macB[i]!
  return diff === 0
}

/** Verifies `sig` against the current and previous unix-minute. Never throws; a bad input is just `false`. */
export async function verifyMetricsSignature(secret: string, method: string, path: string, sig: string | null | undefined, now: number = Date.now()): Promise<boolean> {
  if (!sig) return false
  const minute = Math.floor(now / 60_000)
  const [current, previous] = await Promise.all([metricsSignature(secret, method, path, minute), metricsSignature(secret, method, path, minute - 1)])
  return (await timingSafeEqualHex(current, sig)) || (await timingSafeEqualHex(previous, sig))
}
