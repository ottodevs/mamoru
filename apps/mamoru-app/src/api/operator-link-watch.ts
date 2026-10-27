// Worker -> operator link watch (otto/mamoru#207). Incident otto/mamoru#205: the operator's quick tunnel died in
// the lady outage and the Worker could not reach it for ~55 h; every watch ran on lady, the host that failed, so
// nothing said so. This one runs in the Worker cron (Cloudflare, not lady): each tick it probes the /health of
// every configured operator (OPERATOR_URL for Base, OPERATOR_URL_143 for Monad) and keeps one row per chain in
// operator_link_watch (migrations/d1/0019_operator_link_watch.sql).
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

type WatchRow = { down_since: string | null; last_alert_at: string | null; alerted: number; alert_inflight: string | null; recovery_pending: string | null }

// A "recovered" waits this long at most for an in-flight "down" (POST_TIMEOUT_MS per channel, two channels) before
// it treats that send's run as dead.
const INFLIGHT_MAX_MS = 60_000

/**
 * One chain, one tick. Exported for tests. Every send is claimed first with a conditional UPDATE on the value just
 * read (so one of two concurrent runs wins) and handed back when no channel delivered it, so the next tick retries:
 * a "down" puts last_alert_at back to what it was, a "recovered" puts recovery_pending back. `alerted` only ever
 * goes to 1 on a delivery, so a failed reminder never hides that the first alert went out.
 */
export async function watchOne(db: Db, chainId: number, probe: { up: true } | { up: false; reason: string }, notify: Notify, now: Date): Promise<void> {
  const name = chainName(chainId)
  const at = now.toISOString()
  await db.prepare(`INSERT INTO operator_link_watch (chain_id, checked_at) VALUES (?, ?) ON CONFLICT(chain_id) DO UPDATE SET checked_at = excluded.checked_at`).bind(chainId, at).run()
  const read = () => db.prepare(`SELECT down_since, last_alert_at, alerted, alert_inflight, recovery_pending FROM operator_link_watch WHERE chain_id = ?`).bind(chainId).first<WatchRow>()

  if (probe.up) {
    let row = await read()
    if (row?.down_since) {
      // The outage ends here. One run clears it; it carries a pending "recovered" if a "down" was delivered or is
      // in flight on a concurrent run (alert_inflight set, alerted not yet): a spare "recovered" beats a lost
      // one. An older pending "recovered" is kept, never replaced, so its message counts from the first outage.
      await db
        .prepare(
          `UPDATE operator_link_watch SET down_since = NULL, last_error = NULL, last_alert_at = NULL, alerted = 0,
             recovery_pending = CASE WHEN alerted = 1 OR alert_inflight IS NOT NULL THEN COALESCE(recovery_pending, down_since) ELSE recovery_pending END
           WHERE chain_id = ? AND down_since = ?`,
        )
        .bind(chainId, row.down_since)
        .run()
      row = await read()
    }
    const pending = row?.recovery_pending
    if (!pending) return
    // Never ahead of an in-flight "down": the "recovered" must be the last word. It waits for the next tick.
    const claimed = await db
      .prepare(`UPDATE operator_link_watch SET recovery_pending = NULL WHERE chain_id = ? AND recovery_pending = ? AND (alert_inflight IS NULL OR alert_inflight <= ?) RETURNING chain_id`)
      .bind(chainId, pending, new Date(now.getTime() - INFLIGHT_MAX_MS).toISOString())
      .first()
    if (!claimed) return
    const sent = await notify(`:white_check_mark: Mamoru: the Worker reaches the ${name} operator again (the outage began ${minutes(now.getTime() - Date.parse(pending))} ago).`)
    if (!sent) await db.prepare(`UPDATE operator_link_watch SET recovery_pending = ? WHERE chain_id = ? AND recovery_pending IS NULL`).bind(pending, chainId).run()
    return
  }

  await db
    .prepare(`UPDATE operator_link_watch SET down_since = COALESCE(down_since, ?), last_error = ? WHERE chain_id = ?`)
    .bind(at, probe.reason, chainId)
    .run()
  const row = await read()
  if (!row?.down_since) return
  if (now.getTime() - Date.parse(row.down_since) < DOWN_AFTER_MS) return
  // Until a "down" of this outage is delivered, a claim older than INFLIGHT_MAX_MS is a dead run's: retry it, do
  // not wait REMIND_EVERY_MS for a warning nobody got.
  const wait = row.alerted === 1 ? REMIND_EVERY_MS : INFLIGHT_MAX_MS
  if (row.last_alert_at && now.getTime() - Date.parse(row.last_alert_at) < wait) return
  // Claim against the value just read (IS matches NULL too).
  const claimed = await db
    .prepare(`UPDATE operator_link_watch SET last_alert_at = ?, alert_inflight = ? WHERE chain_id = ? AND down_since = ? AND last_alert_at IS ? RETURNING chain_id`)
    .bind(at, at, chainId, row.down_since, row.last_alert_at)
    .first()
  if (!claimed) return
  const text =
    `:rotating_light: Mamoru: the Worker cannot reach the ${name} operator for ${minutes(now.getTime() - Date.parse(row.down_since))} ` +
    `(last probe: ${probe.reason}). Users see "Could not load your balance". Check the operator tunnel on lady (otto/mamoru#205).`
  const delivered = await notify(text)
  await db.prepare(`UPDATE operator_link_watch SET alert_inflight = NULL WHERE chain_id = ? AND alert_inflight = ?`).bind(chainId, at).run()
  if (delivered) {
    await db.prepare(`UPDATE operator_link_watch SET alerted = 1 WHERE chain_id = ? AND down_since = ?`).bind(chainId, row.down_since).run()
  } else {
    // Nothing delivered: give the claim back so the next tick tries again; `alerted` keeps any earlier delivery.
    // If a concurrent recovery already turned this outage into a pending "recovered" on the strength of this send,
    // and no earlier "down" of it was delivered, take that back too: no "recovered" for a "down" nobody got.
    if (row.alerted !== 1) {
      await db.prepare(`UPDATE operator_link_watch SET recovery_pending = NULL WHERE chain_id = ? AND recovery_pending = ? AND down_since IS NULL`).bind(chainId, row.down_since).run()
    }
    await db.prepare(`UPDATE operator_link_watch SET last_alert_at = ? WHERE chain_id = ? AND last_alert_at = ?`).bind(row.last_alert_at, chainId, at).run()
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
