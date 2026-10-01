import type { Db } from '../env.ts'
import { sha256 } from './webauthn.ts'

// Fixed-window counters in D1 (Workers share no memory across isolates). Every sign-in attempt counts, good or bad.
// Limits per 10 minutes: 20 per client IP, 10 per credential. A person retries a handful of times; a script does not get far.
export const SIGNIN_LIMITS = { windowSeconds: 10 * 60, perIp: 20, perCredential: 10 } as const

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Opaque bucket name: the raw IP or credential id never reaches the table. `secret` keys the hash for IPs. */
export async function rateKey(kind: 'ip' | 'cred', value: string, secret = ''): Promise<string> {
  return `${kind}:${hex(await sha256(`mamoru:signin:rate:v1\n${secret}\n${value}`)).slice(0, 32)}`
}

/** Counts one attempt for `key` in the current window and says whether it is still within `limit`. */
export async function allow(db: Db, key: string, limit: number, now: Date): Promise<boolean> {
  const t = Math.floor(now.getTime() / 1000)
  const window = t - (t % SIGNIN_LIMITS.windowSeconds)
  await db.prepare('DELETE FROM auth_rate WHERE window < ?').bind(window).run()
  const row = await db
    .prepare('INSERT INTO auth_rate (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(key, window)
    .first<{ count: number }>()
  return row !== null && row.count <= limit
}
