import { Hono, type Context } from 'hono'
import type { FeedbackRequest, FeedbackResponse } from '@mamoru/domain'
import type { AppEnv } from './context.ts'
import type { Env, RateLimiter } from './env.ts'
import { apiError } from './errors.ts'
import { accountOfUser } from './accounts/store.ts'
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

/** A reason this module wrote itself: fixed text, safe to log. The Mattermost response body never is. */
class MattermostPostError extends Error {}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Zero-width-joins the letter after '@', so '@channel', '@all', '@here' and '@name' stop matching a Mattermost mention but still read the same to a person. */
function neutraliseMentions(text: string): string {
  return text.replace(/@(\w[\w.-]*)/g, '@​$1')
}

/** Every line gets its own '>' so the quote cannot be broken out of by a blank line or a code fence in the user's text. */
function quote(text: string): string {
  return neutraliseMentions(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

type Note = { id: string; kind: FeedbackRequest['kind']; body: string; contact: string | null; route: string; accountKey: string | null }

function supportMessage(n: Note): string {
  const lines = [`Support request · ${n.id.slice(0, 8)} · ${n.route}`, quote(n.body)]
  if (n.contact) lines.push(`Contact: ${neutraliseMentions(n.contact)}`)
  if (n.accountKey) lines.push(`Account: ${n.accountKey}`)
  return lines.join('\n')
}

function feedbackMessage(n: Note): string {
  const lines = [`Feedback (${n.kind}) · ${n.route}`, quote(n.body)]
  if (n.contact) lines.push(`Contact: ${neutraliseMentions(n.contact)}`)
  return lines.join('\n')
}

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

/** True when the caller may still post. Null when there is no limiter or it could not answer: the caller proceeds either way. */
async function allowed(limiter: RateLimiter | undefined, key: string): Promise<boolean | null> {
  if (!limiter) return null
  try {
    return (await limiter.limit({ key })).success
  } catch {
    console.error('feedback: rate limiter did not answer')
    return null
  }
}

/** The bucket an IP falls in, keyed by the server secret so a key leaked elsewhere cannot be used to target it. No raw IP is kept. */
async function ipKey(secret: string, ip: string): Promise<string> {
  return `ip:${hex(await sha256(`mamoru:feedback:rate:v1\n${secret}\n${ip}`)).slice(0, 32)}`
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
    const bodyText = typeof body.body === 'string' ? body.body.trim() : ''
    if (bodyText.length < 1 || bodyText.length > BODY_MAX) return apiError(c, 400, `Say what happened, up to ${BODY_MAX} characters.`)
    if (body.contact !== undefined && (typeof body.contact !== 'string' || body.contact.length > CONTACT_MAX)) {
      return apiError(c, 400, `Contact must be ${CONTACT_MAX} characters or fewer.`)
    }
    const contact = typeof body.contact === 'string' ? body.contact.trim() : ''
    const route = body.route
    if (typeof route !== 'string' || !route.startsWith('/') || route.length > ROUTE_MAX) return apiError(c, 400, 'route must start with / and be short.')
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

    // Keyed by the device session when there is one; a hash of the connecting IP otherwise. No raw IP is kept.
    const secret = c.var.settings.sessionSecret
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
    const limiterKey = session ? `u:${session.userId}` : await ipKey(secret, ip)
    const ok = await allowed(c.env.FEEDBACK_LIMIT, limiterKey)
    if (ok === false) return apiError(c, 429, 'Too many requests. Wait a minute and try again.', 'FEEDBACK_RATE_LIMITED')

    const id = crypto.randomUUID()
    const createdAt = c.var.now().toISOString()
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
