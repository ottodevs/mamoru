import { Hono, type Context } from 'hono'
import type { FeedbackRequest, FeedbackResponse } from '@mamoru/domain'
import type { AppEnv } from './context.ts'
import type { Db, Env, RateLimiter } from './env.ts'
import { apiError } from './errors.ts'
import { accountOfUser } from './accounts/store.ts'
import { SIGNIN_LIMITS } from './auth/rate-limit.ts'
import { sha256 } from './auth/webauthn.ts'

// In-app feedback (otto/mamoru#72): one button, two paths. 'support' is answered in Mattermost as a new root
// post, one thread per request; 'bug' and 'idea' land as a short line in the feedback channel and wait in the
// table for weekly triage. The row in D1 is the source of truth: it is written before Mattermost is asked, and
// a failed post never fails the request or loses the row.

export type MattermostFetch = (input: string, init: RequestInit) => Promise<Response>

export const MAX_BODY_BYTES = 8 * 1024
const BODY_MAX = 4000
const CONTACT_MAX = 200
const ROUTE_MAX = 200
const KINDS = new Set<FeedbackRequest['kind']>(['support', 'bug', 'idea'])
/** A path of the SPA, nothing else: it is written into the message outside the quote. */
const ROUTE = /^\/[A-Za-z0-9/_.-]*$/

/** A reason this module wrote itself: fixed text, safe to log. The Mattermost response body never is. */
class MattermostPostError extends Error {}

// What a sender types ends up in a channel that staff trust, so it is never handed to Markdown at all: it
// goes inside a fenced code block, where Mattermost renders nothing (no mention, link, image, heading,
// table or formula) and unfurls nothing. Escaping punctuation instead does not hold: a backslash before a
// bracket is itself formula syntax, and bare URLs and underlined headings need no punctuation.
// A fence is closed only by a line of backticks, so the text carries none (BACKTICK), and every kind of
// line break is one '\n' with invisible and direction-changing characters dropped (plain). The lines Mamoru
// writes itself (id, route, account) come first and are never built from free text: the route is checked
// against a strict pattern before it gets here.

const LINE_BREAKS = /\r\n|[\r\u000b\u000c\u0085\u2028\u2029]/g
const INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g
const BACKTICK = /[`\uff40]/g

/** One kind of line break, no control, zero-width or bidi characters, and no run of more than one blank line. */
export function plain(text: string): string {
  return text.replace(LINE_BREAKS, '\n').replace(INVISIBLE, '').replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n')
}

/**
 * The sender's text as a code block that nothing inside it can close: a backtick becomes an apostrophe.
 * Mattermost does not notify for a mention inside a code block; a zero-width space after every '@' makes sure
 * of it even if the server and the reader ever disagree on where a block ends.
 */
function block(text: string): string {
  return ['```', plain(text).replace(BACKTICK, "'").replace(/@/g, '@\u200b'), '```'].join('\n')
}

type Note = { id: string; kind: FeedbackRequest['kind']; body: string; contact: string | null; route: string; accountKey: string | null }

/** Mamoru's own lines first, then what the sender typed, each part under a label Mamoru wrote and inside a code block. */
function message(title: string, n: Note): string {
  const lines = [title]
  if (n.accountKey) lines.push(`Account attached by the sender: \`${n.accountKey}\``)
  lines.push('Message:', block(n.body))
  if (n.contact) lines.push('Contact, as typed by the sender:', block(n.contact.replace(/\s+/g, ' ')))
  return lines.join('\n')
}

const supportMessage = (n: Note) => message(`Support request · \`${n.id.slice(0, 8)}\` · \`${n.route}\``, n)
const feedbackMessage = (n: Note) => message(`Feedback (${n.kind}) · \`${n.id.slice(0, 8)}\` · \`${n.route}\``, n)

export const MATTERMOST_TIMEOUT_MS = 5_000
/** Notes posted after each accepted one, and by each run of the cron. */
export const DRAIN_PER_REQUEST = 3
export const DRAIN_PER_CRON = 20

/**
 * Posts the note to the channel its kind belongs to. `refused` says Mattermost answered that this post itself is
 * not acceptable (400, 413): the note's own problem, not the bot's, the channel's or the server's. Never throws.
 */
async function postToMattermost(fetcher: MattermostFetch, env: Env, note: Note): Promise<{ postId: string | null; refused: boolean }> {
  const { MATTERMOST_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_SUPPORT_CHANNEL_ID, MATTERMOST_FEEDBACK_CHANNEL_ID } = env
  if (!MATTERMOST_URL || !MATTERMOST_BOT_TOKEN || !MATTERMOST_SUPPORT_CHANNEL_ID || !MATTERMOST_FEEDBACK_CHANNEL_ID) return { postId: null, refused: false }
  const channelId = note.kind === 'support' ? MATTERMOST_SUPPORT_CHANNEL_ID : MATTERMOST_FEEDBACK_CHANNEL_ID
  const message = note.kind === 'support' ? supportMessage(note) : feedbackMessage(note)
  let refused = false
  try {
    const res = await fetcher(`${MATTERMOST_URL.replace(/\/+$/, '')}/api/v4/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${MATTERMOST_BOT_TOKEN}` },
      body: JSON.stringify({ channel_id: channelId, message }),
      signal: AbortSignal.timeout(MATTERMOST_TIMEOUT_MS),
    })
    if (!res.ok) {
      // Only "this post is not valid" (400) and "this post is too large" (413) are about the note. Everything else is
      // about the bot, the channel or the server (401, 403 bot not in the channel, 404 wrong channel id, 429, 5xx):
      // every note would fail the same way, so none of them is blamed and the queue waits.
      refused = res.status === 400 || res.status === 413
      throw new MattermostPostError(`mattermost http ${res.status}`)
    }
    const data = (await res.json().catch(() => null)) as { id?: unknown } | null
    // An answer without an id is kept as posted under a marker: posting it again would be a duplicate.
    return { postId: typeof data?.id === 'string' && data.id !== '' ? data.id : 'posted:no-id', refused: false }
  } catch (e) {
    // The token and the response body never reach the log: only this module's own reason, or a generic one for anything foreign.
    console.error('feedback: mattermost post failed', e instanceof MattermostPostError ? e.message : 'unexpected error')
    return { postId: null, refused }
  }
}

// Anyone can reach this route without signing in, and each accepted note writes a row and is posted to a
// channel. The counters are rows of auth_rate (D1: shared by every isolate, always there), in the same
// ten-minute windows as sign-in. They are arranged so that a sender can only ever spend their own allowance:
// - perSender: notes one sender may store per window. Counted and checked in one statement, so a burst of
//   requests at once cannot pass it. It is the only counter a refusal touches, and it is the sender's own;
// - stored: notes stored per window, all senders together, far above real use. Looked at before the sender is
//   counted, so someone refused by it spends nothing. Only a flood from hundreds of addresses reaches it;
// - posts.support and posts.feedback: posts to Mattermost per window, all senders together, one budget for
//   each channel so feedback cannot use up what support needs. A note over the budget is not refused: it is
//   stored, answered as received, and posted by `drainFeedback` once there is budget again.
// The Workers binding is a cheaper refusal in front; without it, or if it does not answer, these still hold.
export const FEEDBACK_LIMITS = { perSender: 5, stored: 2000, posts: { support: 60, feedback: 30 } } as const

function windowOf(now: Date): number {
  const t = Math.floor(now.getTime() / 1000)
  return t - (t % SIGNIN_LIMITS.windowSeconds)
}

/** How many times `key` was counted in this window, without counting this look. */
async function counted(db: Db, key: string, window: number): Promise<number> {
  const row = await db.prepare('SELECT count FROM auth_rate WHERE key = ? AND window = ?').bind(key, window).first<{ count: number }>()
  return row?.count ?? 0
}

/** Adds one to `key` in this window and returns the new count, in one statement. */
async function bump(db: Db, key: string, window: number): Promise<number> {
  const row = await db
    .prepare('INSERT INTO auth_rate (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(key, window)
    .first<{ count: number }>()
  return row?.count ?? Number.MAX_SAFE_INTEGER
}

/** The sender behind an IP, keyed by the server secret so it cannot be computed outside. Long enough that two senders do not share one. No raw IP is kept. */
async function ipSender(secret: string, ip: string): Promise<string> {
  const h = await sha256(`mamoru:feedback:rate:v1\n${secret}\n${ip}`)
  return `ip:${Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

type FeedbackRow = { id: string; created_at: string; kind: FeedbackRequest['kind']; body: string; contact: string | null; route: string; account_key: string | null; mm_post_id: string | null }

/** A claim on a note while it is being posted. One left behind by a Worker that died is taken over after this long. */
export const CLAIM_SECONDS = 120
/** A note Mattermost keeps refusing is tried this many times, then left in the table for a person: it must not hold the queue for ever. */
export const POST_ATTEMPTS_MAX = 5
const claimOf = (now: Date) => `posting:${Math.floor(now.getTime() / 1000)}`
const staleClaim = (now: Date) => `posting:${Math.floor(now.getTime() / 1000) - CLAIM_SECONDS}`

/**
 * Posts notes that are stored and not yet in Mattermost, at most `max`. It runs after every accepted note
 * (which is then simply one of those waiting) and from the Worker's cron, so a note that could not be posted
 * (Mattermost down, budget of the window spent) is posted later instead of waiting unseen.
 * - Support and feedback are two queues, each oldest first, support served first. Neither can hold the other
 *   back: a spent budget or a failing channel on one side leaves the other side running.
 * - A note is claimed in one statement before it is posted, so two runs never post it twice.
 * - When Mattermost refuses a note itself (400, 413), that is an attempt against the note and the queue goes on to
 *   the next one. After POST_ATTEMPTS_MAX the note is no longer tried, so it cannot block the notes behind it.
 *   An outage, a bot that may not post, a wrong channel or a spent budget is not counted against any note.
 * - The budget of the window is counted and checked in one statement, so runs at the same moment cannot
 *   pass it between them.
 * - A failure that is not plainly the note's own (5xx, timeout, 403, ...) does not stop a queue at once: the
 *   next note is tried. If another note of the queue is posted in the same run, the server was fine, so the
 *   note that failed is charged the attempt and cannot be tried for ever. Two such failures in a row with
 *   nothing posted stop the queue until the next run.
 * Returns how many were posted. Never throws.
 */
export async function drainFeedback(db: Db, fetcher: MattermostFetch, env: Env, now: Date, max: number): Promise<number> {
  const { MATTERMOST_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_SUPPORT_CHANNEL_ID, MATTERMOST_FEEDBACK_CHANNEL_ID } = env
  if (!MATTERMOST_URL || !MATTERMOST_BOT_TOKEN || !MATTERMOST_SUPPORT_CHANNEL_ID || !MATTERMOST_FEEDBACK_CHANNEL_ID) return 0
  let posted = 0
  try {
    const window = windowOf(now)
    for (const queue of ['support', 'feedback'] as const) {
      const waiting = await db
        .prepare(
          `SELECT id, created_at, kind, body, contact, route, account_key, mm_post_id FROM feedback
           WHERE status = 'new' AND post_attempts < ? AND (kind = 'support') = ?
             AND (mm_post_id IS NULL OR (mm_post_id LIKE 'posting:%' AND mm_post_id < ?))
           ORDER BY post_attempts ASC, created_at ASC LIMIT ?`,
        )
        .bind(POST_ATTEMPTS_MAX, queue === 'support' ? 1 : 0, staleClaim(now), max)
        .all<FeedbackRow>()
      // Notes that failed in this run for a reason that looked like the server's. If another note of the same
      // queue is posted in this run, before or after, the server was fine and the failure was theirs: they are
      // charged the attempt.
      const unexplained: string[] = []
      let postedHere = 0
      for (const row of waiting.results) {
        if (posted >= max) return posted
        const claim = claimOf(now)
        const mine = await db
          .prepare('UPDATE feedback SET mm_post_id = ?, post_attempts = post_attempts + 1 WHERE id = ? AND (mm_post_id IS NULL OR mm_post_id = ?) RETURNING id')
          .bind(claim, row.id, row.mm_post_id)
          .first<{ id: string }>()
        if (!mine) continue
        // Gives the claim back. An attempt counts against the note only when the failure was the note's own.
        const giveBack = (keepAttempt: boolean) =>
          db.prepare(`UPDATE feedback SET mm_post_id = NULL, post_attempts = post_attempts - ? WHERE id = ? AND mm_post_id = ?`).bind(keepAttempt ? 0 : 1, row.id, claim).run()
        // Counted, then checked: the count this run got back is its own place in the window.
        if ((await bump(db, `fb:posts:${queue}`, window)) > FEEDBACK_LIMITS.posts[queue]) {
          await giveBack(false)
          break
        }
        const result = await postToMattermost(fetcher, env, { id: row.id, kind: row.kind, body: row.body, contact: row.contact, route: row.route, accountKey: row.account_key })
        if (result.postId) {
          await db.prepare('UPDATE feedback SET mm_post_id = ? WHERE id = ? AND mm_post_id = ?').bind(result.postId, row.id, claim).run()
          posted++
          postedHere++
          for (const id of unexplained.splice(0)) await db.prepare('UPDATE feedback SET post_attempts = post_attempts + 1 WHERE id = ? AND mm_post_id IS NULL').bind(id).run()
        } else if (result.refused) {
          await giveBack(true)
        } else if (postedHere > 0) {
          // The server took another note a moment ago: this failure is the note's.
          await giveBack(true)
        } else {
          await giveBack(false)
          unexplained.push(row.id)
          // One failure may be this note; two in a row is Mattermost not answering, and the queue waits for the next run.
          if (unexplained.length >= 2) break
        }
      }
    }
  } catch {
    console.error('feedback: drain stopped on an unexpected error')
  }
  return posted
}

/** The request body as text, or null once it passes `max` bytes: the rest is not read. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const reader = req.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

/** False only when the binding answered and said no. */
async function bindingAllows(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true
  try {
    return (await limiter.limit({ key })).success
  } catch {
    console.error('feedback: rate limiter did not answer')
    return true
  }
}

function fakeId(): string {
  return crypto.randomUUID()
}

export function feedbackRoutes(mattermostFetch: MattermostFetch) {
  const routes = new Hono<AppEnv>()

  routes.post('/feedback', async (c: Context<AppEnv>) => {
    const tooLarge = () => apiError(c, 413, 'Request body too large.', 'BODY_TOO_LARGE')
    if (Number(c.req.header('content-length') ?? '0') > MAX_BODY_BYTES) return tooLarge()
    // A body without a declared length is read only up to the cap.
    const text = await readCapped(c.req.raw, MAX_BODY_BYTES)
    if (text === null) return tooLarge()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return apiError(c, 400, 'Send a JSON body.')
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return apiError(c, 400, 'Send a JSON body.')
    const body = raw as Record<string, unknown>

    // Honeypot: a field no person sees or fills. Answer as if it worked; nothing else about the request is checked or stored.
    const trap = typeof body.leaveEmpty === 'string' ? body.leaveEmpty.trim() : ''
    if (trap !== '') {
      const faked: FeedbackResponse = { id: fakeId(), received: true }
      return c.json(faked)
    }

    const kind = body.kind
    if (typeof kind !== 'string' || !KINDS.has(kind as FeedbackRequest['kind'])) return apiError(c, 400, 'kind must be support, bug or idea.')
    const bodyText = typeof body.body === 'string' ? plain(body.body).trim() : ''
    if (bodyText.length < 1 || bodyText.length > BODY_MAX) return apiError(c, 400, `Say what happened, up to ${BODY_MAX} characters.`)
    if (body.contact !== undefined && (typeof body.contact !== 'string' || body.contact.length > CONTACT_MAX)) {
      return apiError(c, 400, `Contact must be ${CONTACT_MAX} characters or fewer.`)
    }
    const contact = typeof body.contact === 'string' ? plain(body.contact).replace(/\s+/g, ' ').trim() : ''
    const route = body.route
    if (typeof route !== 'string' || !ROUTE.test(route) || route.length > ROUTE_MAX) return apiError(c, 400, 'route must be a short app path.')
    const attachAccount = body.attachAccount === true

    const session = await c.var.auth.current(c)
    let accountKey: string | null = null
    if (attachAccount && session) {
      const account = await accountOfUser(c.env.DB, session.userId)
      if (account) {
        accountKey = account.account_key
        c.set('accountKey', account.account_key)
      }
    }

    // Keyed by the device session when there is one, by the connecting IP otherwise.
    const secret = c.var.settings.sessionSecret
    const sender = session ? `u:${session.userId}` : await ipSender(secret, c.req.header('cf-connecting-ip') ?? 'unknown')
    const slowDown = () => apiError(c, 429, 'Too many requests. Wait a few minutes and try again.', 'FEEDBACK_RATE_LIMITED')
    if (!(await bindingAllows(c.env.FEEDBACK_LIMIT, sender))) return slowDown()
    const now = c.var.now()
    const window = windowOf(now)
    const db = c.env.DB
    // The shared limit is only looked at, and first: someone it refuses has not spent anything of their own.
    if ((await counted(db, 'fb:stored', window)) >= FEEDBACK_LIMITS.stored) return slowDown()
    await db.prepare('DELETE FROM auth_rate WHERE window < ?').bind(window).run()
    if ((await bump(db, `fb:${sender}`, window)) > FEEDBACK_LIMITS.perSender) return slowDown()
    await bump(db, 'fb:stored', window)

    const id = crypto.randomUUID()
    await db
      .prepare(
        `INSERT INTO feedback (id, created_at, kind, body, contact, route, app_version, account_key, status)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'new')`,
      )
      .bind(id, now.toISOString(), kind, bodyText, contact || null, route, accountKey)
      .run()

    // The row is safe. Post what is waiting: this note, unless older ones or support requests are ahead of it.
    await drainFeedback(db, mattermostFetch, c.env, now, DRAIN_PER_REQUEST)

    const sent: FeedbackResponse = { id, received: true }
    return c.json(sent)
  })

  return routes
}
