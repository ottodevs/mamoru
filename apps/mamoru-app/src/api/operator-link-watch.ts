// Worker -> operator link watch (otto/mamoru#207). Incident otto/mamoru#205: the operator's quick tunnel died in
// the lady outage and the Worker could not reach it for ~55 h; every watch ran on lady, the host that failed, so
// nothing said so. This one runs in the Worker cron (Cloudflare, not lady): each tick it probes the /health of
// every configured operator (OPERATOR_URL for Base, OPERATOR_URL_143 for Monad) and keeps one row per chain in
// operator_link_watch (migrations/d1/XXXX_operator_link_watch.sql).
//
// Prod and beta share D1 and both run the cron. Every transition is a conditional UPDATE ... RETURNING, so only
// the run that wins the row posts: one "down" alert after DOWN_AFTER_MS of failed probes, a reminder every
// REMIND_EVERY_MS while it lasts, and one "recovered" message when a probe answers again (only if a "down" was
// delivered; a blip shorter than DOWN_AFTER_MS says nothing). Channels: Mattermost #mamoru-ops and, if set,
// Telegram — Mattermost itself runs on lady, so Telegram is the path that survives a lady outage. Never throws.

import { BASE_CHAIN, MONAD_CHAIN, SUPPORTED_CHAINS } from '@mamoru/domain'
import type { Db, Env } from './env.ts'
import type { OperatorFetch } from './yield-ledger.ts'

export const DOWN_AFTER_MS = 15 * 60_000
export const REMIND_EVERY_MS = 6 * 60 * 60_000
const PROBE_TIMEOUT_MS = 8_000
const POST_TIMEOUT_MS = 8_000

const chainName = (chainId: number) => SUPPORTED_CHAINS.find((c) => c.chainId === chainId)?.name ?? `chain ${chainId}`

/** The operators this Worker is configured to reach, by chain. */
export function watchedOperators(env: Env): { chainId: number; url: string }[] {
  const out: { chainId: number; url: string }[] = []
  if (env.OPERATOR_URL) out.push({ chainId: BASE_CHAIN.chainId, url: env.OPERATOR_URL })
  if (env.OPERATOR_URL_143) out.push({ chainId: MONAD_CHAIN.chainId, url: env.OPERATOR_URL_143 })
  return out
}

/**
 * GET /health (unsigned, the operator's own liveness answer). Up only on a 200 whose JSON says ok and names the
 * expected chain: a tunnel that answers for some other origin is as good as down. The reason never carries the
 * URL, which is a secret.
 */
export async function probeOperator(url: string, chainId: number, fetcher: OperatorFetch): Promise<{ up: true } | { up: false; reason: string }> {
  try {
    const res = await fetcher(url.replace(/\/+$/, '') + '/health', { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (res.status !== 200) return { up: false, reason: `http ${res.status}` }
    const body = (await res.json().catch(() => null)) as { ok?: unknown; chainId?: unknown } | null
    if (body?.ok !== true) return { up: false, reason: 'health not ok' }
    if (body.chainId !== chainId) return { up: false, reason: `wrong chain ${String(body.chainId)}` }
    return { up: true }
  } catch (e) {
    return { up: false, reason: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'unreachable' }
  }
}

type Notify = (text: string) => Promise<boolean>

/** Posts to every configured channel; true when at least one took it. Tokens never reach the log. */
export function notifier(env: Env, fetcher: OperatorFetch): Notify {
  return async (text) => {
    let delivered = false
    if (env.MATTERMOST_URL && env.MATTERMOST_BOT_TOKEN && env.MATTERMOST_OPS_CHANNEL_ID) {
      try {
        const res = await fetcher(`${env.MATTERMOST_URL.replace(/\/+$/, '')}/api/v4/posts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${env.MATTERMOST_BOT_TOKEN}` },
          body: JSON.stringify({ channel_id: env.MATTERMOST_OPS_CHANNEL_ID, message: text }),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        })
        if (res.ok) delivered = true
        else console.error('operator-link-watch: mattermost http', res.status)
      } catch {
        console.error('operator-link-watch: mattermost post failed')
      }
    }
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALERT_CHAT_ID) {
      try {
        const res = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_ALERT_CHAT_ID, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        })
        if (res.ok) delivered = true
        else console.error('operator-link-watch: telegram http', res.status)
      } catch {
        console.error('operator-link-watch: telegram post failed')
      }
    }
    return delivered
  }
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 120 ? `${m} min` : `${(m / 60).toFixed(1)} h`
}

/** One chain, one tick. Exported for tests. */
export async function watchOne(db: Db, chainId: number, probe: { up: true } | { up: false; reason: string }, notify: Notify, now: Date): Promise<void> {
  const name = chainName(chainId)
  const at = now.toISOString()
  if (probe.up) {
    const row = await db.prepare(`SELECT down_since, last_alert_at FROM operator_link_watch WHERE chain_id = ?`).bind(chainId).first<{ down_since: string | null; last_alert_at: string | null }>()
    if (!row?.down_since) {
      await db.prepare(`INSERT INTO operator_link_watch (chain_id, checked_at) VALUES (?, ?) ON CONFLICT(chain_id) DO UPDATE SET checked_at = excluded.checked_at`).bind(chainId, at).run()
      return
    }
    // RETURNING gives the values after the update, so the old ones come from the read above; the WHERE on the old
    // down_since makes exactly one of two concurrent runs (prod and beta) the one that clears it.
    const cleared = await db
      .prepare(`UPDATE operator_link_watch SET down_since = NULL, last_error = NULL, last_alert_at = NULL, checked_at = ? WHERE chain_id = ? AND down_since = ? RETURNING chain_id`)
      .bind(at, chainId, row.down_since)
      .first<{ chain_id: number }>()
    if (cleared && row.last_alert_at) {
      await notify(`:white_check_mark: Mamoru: the Worker reaches the ${name} operator again (down ${minutes(now.getTime() - Date.parse(row.down_since))}).`)
    }
    return
  }
  await db
    .prepare(
      `INSERT INTO operator_link_watch (chain_id, down_since, last_error, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id) DO UPDATE SET down_since = COALESCE(operator_link_watch.down_since, excluded.down_since),
         last_error = excluded.last_error, checked_at = excluded.checked_at`,
    )
    .bind(chainId, at, probe.reason, at)
    .run()
  // Claim the alert: past DOWN_AFTER_MS, and either none sent yet in this outage or the last one is REMIND_EVERY_MS old.
  const claimed = await db
    .prepare(
      `UPDATE operator_link_watch SET last_alert_at = ?
       WHERE chain_id = ? AND down_since IS NOT NULL AND down_since <= ? AND (last_alert_at IS NULL OR last_alert_at <= ?)
       RETURNING down_since, last_alert_at`,
    )
    .bind(at, chainId, new Date(now.getTime() - DOWN_AFTER_MS).toISOString(), new Date(now.getTime() - REMIND_EVERY_MS).toISOString())
    .first<{ down_since: string }>()
  if (!claimed) return
  const text =
    `:rotating_light: Mamoru: the Worker cannot reach the ${name} operator for ${minutes(now.getTime() - Date.parse(claimed.down_since))} ` +
    `(last probe: ${probe.reason}). Users see "Could not load your balance". Check the operator tunnel on lady (otto/mamoru#205).`
  if (!(await notify(text))) {
    // Nothing delivered: give the claim back so the next tick tries again.
    await db.prepare(`UPDATE operator_link_watch SET last_alert_at = NULL WHERE chain_id = ? AND last_alert_at = ?`).bind(chainId, at).run()
  }
}

/** Cron entry: every configured operator, one after another. Never throws. */
export async function runOperatorLinkWatch(env: Env, fetcher: OperatorFetch, now: Date): Promise<void> {
  const notify = notifier(env, fetcher)
  for (const { chainId, url } of watchedOperators(env)) {
    try {
      await watchOne(env.DB, chainId, await probeOperator(url, chainId, fetcher), notify, now)
    } catch (e) {
      console.error('operator-link-watch: tick failed', chainId, e instanceof Error ? e.message : String(e))
    }
  }
}
