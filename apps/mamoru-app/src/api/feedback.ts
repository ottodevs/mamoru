import { Hono, type Context } from 'hono'
import type { FeedbackRequest, FeedbackResponse } from '@mamoru/domain'
import type { AppEnv } from './context.ts'
import type { Env, RateLimiter } from './env.ts'
import { apiError } from './errors.ts'
import { accountOfUser } from './accounts/store.ts'
import { allow, ipKey as ipBucket } from './auth/rate-limit.ts'

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

// What a sender types ends up in a channel that staff trust. Three things keep it from passing as anything but
// a quote: every kind of line break becomes one '\n' and invisible or direction-changing characters are
// dropped (plain); Markdown punctuation is escaped, so there is no link, image, heading, table or code fence
// (inert); and each line is quoted. The lines Mamoru writes itself (id, route, account) come first and are
// never built from free text: the route is checked against a strict pattern before it gets here.

const LINE_BREAKS = /\r\n|[\r\u000b\u000c\u0085\u2028\u2029]/g
const INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

/** One kind of line break, no control, zero-width or bidi characters, and no run of more than one blank line. */
export function plain(text: string): string {
  return text.replace(LINE_BREAKS, '\n').replace(INVISIBLE, '').replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n')
}

/** Markdown and mentions made inert: a backslash before every character Mattermost gives a meaning to, and a zero-width space after '@'. */
export function inert(text: string): string {
  return text.replace(/[\\`*_~\[\]()<>#|!]/g, '\\$&').replace(/@/g, '@\u200b')
}

/** The sender's text as a quote: every line carries its own '>', so nothing in it can end the quote. */
function quote(text: string): string {
  return inert(plain(text))
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

type Note = { id: string; kind: FeedbackRequest['kind']; body: string; contact: string | null; route: string; accountKey: string | null }

/** Mamoru's own lines first, then what the sender typed, each part under a label Mamoru wrote and inside a quote. */
function message(title: string, n: Note): string {
  const lines = [title]
  if (n.accountKey) lines.push(`Account attached by the sender: \`${n.accountKey}\``)
  lines.push('Message:', quote(n.body))
  if (n.contact) lines.push('Contact, as typed by the sender:', quote(n.contact.replace(/\s+/g, ' ')))
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

// Anyone can reach this route without signing in, and each accepted note writes a row and posts to a channel.
// So the limit that decides is the D1 counter (auth/rate-limit.ts): it is shared by every isolate and it is
// always there. Per sender, and one for everybody together, so many senders cannot flood the table or the
// channel either. The Workers binding is only a cheaper first refusal; without it, or if it does not answer,
// the D1 limit still holds.
export const FEEDBACK_LIMITS = { perSender: 5, total: 120 } as const // per 10-minute window (SIGNIN_LIMITS.windowSeconds)

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
    const declared = Number(c.req.header('content-length') ?? '0')
    if (declared > MAX_BODY_BYTES) return apiError(c, 413, 'Request body too large.', 'BODY_TOO_LARGE')
    const text = await c.req.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return apiError(c, 413, 'Request body too large.', 'BODY_TOO_LARGE')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return apiError(c, 400, 'Send a JSON body.')
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return apiError(c, 400, 'Send a JSON body.')
    const body = raw as Record<string, unknown>

    // Honeypot: a field no person sees or fills. Answer as if it worked; nothing else about the request is checked or stored.
    const website = typeof body.website === 'string' ? body.website.trim() : ''
    if (website !== '') {
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
    if (!(await allow(c.env.DB, `fb:${sender}`, FEEDBACK_LIMITS.perSender, now))) return slowDown()
    if (!(await allow(c.env.DB, 'fb:all', FEEDBACK_LIMITS.total, now))) return slowDown()

    const id = crypto.randomUUID()
    const createdAt = now.toISOString()
    await c.env.DB.prepare(
      `INSERT INTO feedback (id, created_at, kind, body, contact, route, app_version, account_key, status)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'new')`,
    )
      .bind(id, createdAt, kind, bodyText, contact || null, route, accountKey)
      .run()

    const note: Note = { id, kind: kind as FeedbackRequest['kind'], body: bodyText, contact: contact || null, route, accountKey }
    const postId = await postToMattermost(mattermostFetch, c.env, note)
    if (postId) await c.env.DB.prepare('UPDATE feedback SET mm_post_id = ? WHERE id = ?').bind(postId, id).run()

    const sent: FeedbackResponse = { id, received: true }
    return c.json(sent)
  })

  return routes
}
