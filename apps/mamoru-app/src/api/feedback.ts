import { Hono, type Context } from 'hono'
import type { FeedbackRequest, FeedbackResponse } from '@mamoru/domain'
import type { AppEnv } from './context.ts'
import type { Env, RateLimiter } from './env.ts'
import { apiError } from './errors.ts'
import { accountOfUser } from './accounts/store.ts'
import { count, ipKey as ipBucket, SIGNIN_LIMITS } from './auth/rate-limit.ts'

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

/** The sender's text as a code block that nothing inside it can close: a backtick becomes an apostrophe. */
function block(text: string): string {
  return ['```', plain(text).replace(BACKTICK, "'"), '```'].join('\n')
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

/** Posts the note to the channel its kind belongs to. Null when unconfigured, refused or unreachable: nothing here ever throws. */
async function postToMattermost(fetcher: MattermostFetch, env: Env, note: Note): Promise<string | null> {
  const { MATTERMOST_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_SUPPORT_CHANNEL_ID, MATTERMOST_FEEDBACK_CHANNEL_ID } = env
  if (!MATTERMOST_URL || !MATTERMOST_BOT_TOKEN || !MATTERMOST_SUPPORT_CHANNEL_ID || !MATTERMOST_FEEDBACK_CHANNEL_ID) return null
  const channelId = note.kind === 'support' ? MATTERMOST_SUPPORT_CHANNEL_ID : MATTERMOST_FEEDBACK_CHANNEL_ID
  const message = note.kind === 'support' ? supportMessage(note) : feedbackMessage(note)
  try {
    const res = await fetcher(`${MATTERMOST_URL.replace(/\/+$/, '')}/api/v4/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${MATTERMOST_BOT_TOKEN}` },
      body: JSON.stringify({ channel_id: channelId, message }),
      signal: AbortSignal.timeout(MATTERMOST_TIMEOUT_MS),
    })
    if (!res.ok) throw new MattermostPostError(`mattermost http ${res.status}`)
    const data = (await res.json().catch(() => null)) as { id?: unknown } | null
    return typeof data?.id === 'string' ? data.id : null
  } catch (e) {
    // The token and the response body never reach the log: only this module's own reason, or a generic one for anything foreign.
    console.error('feedback: mattermost post failed', e instanceof MattermostPostError ? e.message : 'unexpected error')
    return null
  }
}

// Anyone can reach this route without signing in, and each accepted note writes a row and may post to a
// channel. The counters are the D1 ones of auth/rate-limit.ts (shared by every isolate, always there), used
// so that a sender can spend only their own allowance:
// - a request is counted only when it is accepted. A refusal reads and writes nothing more, so being refused
//   costs the sender nothing and cannot be used to run a counter up;
// - perSender: notes one sender may store per window. The only limit a normal sender can meet;
// - posts: notes posted to Mattermost per window, all senders together. Over it a note is still stored and
//   answered as received, it just waits in the table without a post, so a flood cannot bury the channel and
//   cannot make anyone else's note be refused;
// - stored: notes stored per window, all senders together, far above real use. Only a flood from thousands
//   of addresses reaches it, and then the form answers "try later" until the window ends.
// The Workers binding is a cheaper refusal in front; without it, or if it does not answer, these still hold.
export const FEEDBACK_LIMITS = { perSender: 5, posts: 60, stored: 2000 } as const // per 10-minute window (SIGNIN_LIMITS.windowSeconds)

/** How many times `key` was counted in the current window, without counting this look. */
async function counted(db: Env['DB'], key: string, now: Date): Promise<number> {
  const t = Math.floor(now.getTime() / 1000)
  const window = t - (t % SIGNIN_LIMITS.windowSeconds)
  const row = await db.prepare('SELECT count FROM auth_rate WHERE key = ? AND window = ?').bind(key, window).first<{ count: number }>()
  return row?.count ?? 0
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

    // Keyed by the device session when there is one; the bucket of the connecting IP otherwise. No raw IP is kept.
    const secret = c.var.settings.sessionSecret
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
    const sender = session ? `u:${session.userId}` : await ipBucket(secret, ip)
    const slowDown = () => apiError(c, 429, 'Too many requests. Wait a few minutes and try again.', 'FEEDBACK_RATE_LIMITED')
    if (!(await bindingAllows(c.env.FEEDBACK_LIMIT, sender))) return slowDown()
    const now = c.var.now()
    // Looked at first, counted only on acceptance (see FEEDBACK_LIMITS).
    if ((await counted(c.env.DB, `fb:${sender}`, now)) >= FEEDBACK_LIMITS.perSender) return slowDown()
    if ((await counted(c.env.DB, 'fb:stored', now)) >= FEEDBACK_LIMITS.stored) return slowDown()
    await count(c.env.DB, `fb:${sender}`, now)
    await count(c.env.DB, 'fb:stored', now)

    const id = crypto.randomUUID()
    const createdAt = now.toISOString()
    await c.env.DB.prepare(
      `INSERT INTO feedback (id, created_at, kind, body, contact, route, app_version, account_key, status)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'new')`,
    )
      .bind(id, createdAt, kind, bodyText, contact || null, route, accountKey)
      .run()

    const note: Note = { id, kind: kind as FeedbackRequest['kind'], body: bodyText, contact: contact || null, route, accountKey }
    // The post budget is counted here, after the row is safe. Over it the note waits in the table without a post.
    const withinPostBudget = (await count(c.env.DB, 'fb:posts', now)) <= FEEDBACK_LIMITS.posts
    if (!withinPostBudget) console.error('feedback: post budget of the window is spent; the note is stored without a post')
    const postId = withinPostBudget ? await postToMattermost(mattermostFetch, c.env, note) : null
    if (postId) await c.env.DB.prepare('UPDATE feedback SET mm_post_id = ? WHERE id = ?').bind(postId, id).run()

    const sent: FeedbackResponse = { id, received: true }
    return c.json(sent)
  })

  return routes
}
