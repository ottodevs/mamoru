import type { Db } from '../env.ts'
import { constantTimeEqual, plain } from './webauthn.ts'

// One-time WebAuthn challenge (sign-in, or registration at onboarding): 32 random bytes, an expiry and an HMAC over both and the host. Issuing writes nothing, so an
// anonymous caller cannot fill the database; the challenge is recorded only when it is spent (single use).

export const CHALLENGE_TTL_SECONDS = 5 * 60
const LABEL = 'mamoru:signin:challenge:v1'
/** What the challenge is for. It is part of the MAC, so a sign-in challenge cannot be used to register and the reverse. */
export type ChallengePurpose = 'signin' | 'register'
const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(key: Uint8Array | string, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', plain(typeof key === 'string' ? enc.encode(key) : key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)))
}

/** MAC under a key derived from the session secret, so a challenge token can never pass for a session cookie signature. */
async function mac(secret: string, purpose: ChallengePurpose, host: string, challenge: string, exp: number): Promise<string> {
  return b64url(await hmac(await hmac(secret, LABEL), `${purpose}\n${host}\n${challenge}\n${exp}`))
}

export type IssuedChallenge = { challenge: string; token: string; expiresAt: string }

export async function issueChallenge(secret: string, host: string, now: Date, purpose: ChallengePurpose = 'signin'): Promise<IssuedChallenge> {
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const exp = Math.floor(now.getTime() / 1000) + CHALLENGE_TTL_SECONDS
  return { challenge, token: `${challenge}.${exp}.${await mac(secret, purpose, host, challenge, exp)}`, expiresAt: new Date(exp * 1000).toISOString() }
}

/** The challenge inside a token this server issued for this host and that has not expired; null otherwise. */
export async function openChallenge(secret: string, host: string, token: unknown, now: Date, purpose: ChallengePurpose = 'signin'): Promise<{ challenge: string; exp: number } | null> {
  if (typeof token !== 'string' || token.length > 200) return null
  const [challenge, expText, tag, ...rest] = token.split('.')
  if (!challenge || !expText || !tag || rest.length > 0 || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^\d{1,12}$/.test(expText)) return null
  const exp = Number(expText)
  if (!constantTimeEqual(tag, await mac(secret, purpose, host, challenge, exp))) return null
  if (exp <= Math.floor(now.getTime() / 1000)) return null
  return { challenge, exp }
}

/** Marks the challenge as spent. False when it was spent before: the same assertion is never accepted twice. */
export async function spendChallenge(db: Db, challenge: string, exp: number, now: Date): Promise<boolean> {
  await db.prepare('DELETE FROM auth_challenge_used WHERE expires_at <= ?').bind(Math.floor(now.getTime() / 1000)).run()
  const row = await db
    .prepare('INSERT INTO auth_challenge_used (challenge, expires_at) VALUES (?, ?) ON CONFLICT(challenge) DO NOTHING RETURNING challenge')
    .bind(challenge, exp)
    .first<{ challenge: string }>()
  return row !== null
}
