import type { Db } from '../env.ts'
import { sha256 } from './webauthn.ts'

// Fixed-window counters in D1 (Workers share no memory across isolates).
// - Attempts per client IP: 20 per 10 minutes. This is the only limiter that refuses a request (429).
// - Failures per credential: counted for monitoring only, and only for credential ids that belong to an account.
//   It never refuses anything: a limiter on the credential would let anyone who knows the id lock its owner out, and a
//   429 that only known ids can produce would tell which ids exist. A correct assertion always signs in.
// The table is bounded: IPs hash into IP_BUCKETS buckets, credential rows exist only for real accounts, and rows of
// past windows are deleted on every write.
export const SIGNIN_LIMITS = { windowSeconds: 10 * 60, perIp: 20, ipBuckets: 4096, credentialFailuresLogged: 10 } as const
/** Anonymous onboarding: accounts one IP bucket may try to create per window. Same bounded buckets, its own counters. */
export const ONBOARDING_PER_IP = 10

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** The bucket an IP falls in, keyed by the server secret so buckets cannot be targeted. Two IPs may share one. */
export async function ipKey(secret: string, ip: string, scope: 'ip' | 'onb' = 'ip'): Promise<string> {
  const h = await sha256(`mamoru:signin:rate:v1\n${secret}\n${ip}`)
  return `${scope}:${(((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0) % SIGNIN_LIMITS.ipBuckets}`
}

export async function credentialKey(credentialId: string): Promise<string> {
  return `cred:${hex(await sha256(`mamoru:signin:cred:v1\n${credentialId}`)).slice(0, 32)}`
}

function windowOf(now: Date): number {
  const t = Math.floor(now.getTime() / 1000)
  return t - (t % SIGNIN_LIMITS.windowSeconds)
}

/** Adds one to `key` in the current window and returns the count. Rows of earlier windows are dropped on the way. */
export async function count(db: Db, key: string, now: Date): Promise<number> {
  const window = windowOf(now)
  await db.prepare('DELETE FROM auth_rate WHERE window < ?').bind(window).run()
  const row = await db
    .prepare('INSERT INTO auth_rate (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(key, window)
    .first<{ count: number }>()
  return row?.count ?? Number.MAX_SAFE_INTEGER
}

/** Counts one attempt for `key` and says whether it is still within `limit`. */
export async function allow(db: Db, key: string, limit: number, now: Date): Promise<boolean> {
  return (await count(db, key, now)) <= limit
}

/** The same two statements as `count`, but it never creates a row: what a failure for an unknown credential costs. */
export async function countNothing(db: Db, key: string, now: Date): Promise<void> {
  const window = windowOf(now)
  await db.prepare('DELETE FROM auth_rate WHERE window < ?').bind(window).run()
  await db.prepare('UPDATE auth_rate SET count = count + 1 WHERE key = ? AND window = ? RETURNING count').bind(key, window).first<{ count: number }>()
}
