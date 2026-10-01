import type { Context } from 'hono'
import type { AppEnv } from '../context.ts'
import type { Db } from '../env.ts'

// Throttle per account and day so a chatty session does not write every request. The map lives in one
// isolate: `hits` is an approximate count (several isolates each write once a minute); DAU only needs the row.
const THROTTLE_MS = 60_000
const lastSeen = new Map<string, number>()

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

async function upsertActivity(db: Db, accountKey: string, now: Date): Promise<void> {
  const day = utcDay(now)
  const iso = now.toISOString()
  await db
    .prepare(
      `INSERT INTO account_activity (account_key, day, hits, first_at, last_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(account_key, day) DO UPDATE SET hits = hits + 1, last_at = MAX(last_at, excluded.last_at), first_at = MIN(first_at, excluded.first_at)`,
    )
    .bind(accountKey, day, iso, iso)
    .run()
}

/**
 * Record that this account was seen, for DAU/history on the ops dashboard. No PII beyond the
 * account key. Fire-and-forget: it must never fail or slow down the response it's attached to.
 */
export function recordActivity(c: Context<AppEnv>, accountKey: string): void {
  const now = c.var.now()
  // Keyed by day: the first request after UTC midnight always writes the new day's row.
  const key = `${accountKey}:${utcDay(now)}`
  const last = lastSeen.get(key)
  if (last !== undefined && now.getTime() - last < THROTTLE_MS) return
  if (lastSeen.size > 5_000) lastSeen.clear()
  lastSeen.set(key, now.getTime())
  const task = upsertActivity(c.env.DB, accountKey, now).catch((e) => {
    console.error('account_activity upsert failed', e instanceof Error ? e.message : String(e))
  })
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    // No ExecutionContext in this runtime (e.g. tests): the write still runs detached.
  }
}
