import { describe, expect, test } from 'bun:test'
import type { FeedbackResponse, OwnerResponse } from '@mamoru/domain'
import { harness, register, sessionCookie, PASSKEY_A } from './helpers.ts'

const T0 = new Date('2026-10-11T12:00:00Z')

type Row = {
  id: string
  created_at: string
  kind: string
  body: string
  contact: string | null
  route: string
  app_version: string | null
  account_key: string | null
  status: string
  mm_post_id: string | null
  ticket_url: string | null
}

function rows(h: ReturnType<typeof harness>): Row[] {
  return h.db.raw.query('SELECT * FROM feedback').all() as Row[]
}

async function send(h: ReturnType<typeof harness>, body: unknown, opts: { cookie?: string; ip?: string } = {}) {
  return h.request('/api/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: 'https://app.mamoru.lol', ...(opts.ip ? { 'cf-connecting-ip': opts.ip } : {}) },
    cookie: opts.cookie,
  })
}

const valid = { kind: 'bug' as const, body: 'The deposit screen is blank on Safari.', route: '/' }

describe('feedback: one button, two paths (#72)', () => {
  test('stores a row with exactly the allowed columns, and the connecting IP never appears in it', async () => {
    const h = harness(() => T0)
    const res = await send(h, valid, { ip: '203.0.113.9' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as FeedbackResponse
    expect(body.received).toBe(true)

    const found = rows(h)
    expect(found.length).toBe(1)
    const row = found[0]!
    expect(row.id).toBe(body.id)
    expect(row.created_at).toBe(T0.toISOString())
    expect(row.kind).toBe('bug')
    expect(row.body).toBe(valid.body)
    expect(row.contact).toBeNull()
    expect(row.route).toBe('/')
    expect(row.app_version).toBeNull()
    expect(row.account_key).toBeNull()
    expect(row.status).toBe('new')
    expect(row.mm_post_id).toBeNull()
    expect(row.ticket_url).toBeNull()
    expect(JSON.stringify(found)).not.toContain('203.0.113.9')

    const cols = (h.db.raw.query('PRAGMA table_info(feedback)').all() as { name: string }[]).map((c) => c.name).sort()
    expect(cols).toEqual(['account_key', 'app_version', 'body', 'contact', 'created_at', 'id', 'kind', 'mm_post_id', 'route', 'status', 'ticket_url'].sort())
  })

  test('contact is stored when sent', async () => {
    const h = harness(() => T0)
    await send(h, { ...valid, contact: 'ot@example.com' })
    expect(rows(h)[0]!.contact).toBe('ot@example.com')
  })

  test('account_key is set only when attachAccount is ticked and the session owns an account', async () => {
    const h = harness(() => T0)
    const res = await register(h, PASSKEY_A)
    const cookie = sessionCookie(res)
    const owner = (await res.json()) as OwnerResponse

    await send(h, { ...valid, attachAccount: false }, { cookie })
    expect(rows(h)[0]!.account_key).toBeNull()

    await send(h, { ...valid, attachAccount: true }, { cookie })
    expect(rows(h)[1]!.account_key).toBe(owner.accountKey)

    // Ticked but no session at all: still a no-op, never an error.
    const noSession = await send(h, { ...valid, attachAccount: true })
    expect(noSession.status).toBe(200)
    expect(rows(h)[2]!.account_key).toBeNull()
  })

  test('honeypot: a filled website field answers success and stores nothing, whatever else is wrong with the request', async () => {
    const h = harness(() => T0)
    const res = await send(h, { kind: 'not-a-kind', body: '', route: 'not-a-route', website: 'http://spam.example' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as FeedbackResponse
    expect(body.received).toBe(true)
    expect(typeof body.id).toBe('string')
    expect(rows(h)).toEqual([])
  })

  test('validation: kind, body length, contact length and route shape are all checked', async () => {
    const h = harness(() => T0)
    const cases: unknown[] = [
      { ...valid, kind: 'question' },
      { ...valid, body: '' },
      { ...valid, body: '  ' },
      { ...valid, body: 'x'.repeat(4001) },
      { ...valid, contact: 'x'.repeat(201) },
      { ...valid, route: 'home' },
      { ...valid, route: '/' + 'x'.repeat(200) },
      { kind: 'bug', route: '/' },
      'not an object',
      ['array'],
    ]
    for (const body of cases) {
      const res = await send(h, body)
      expect(res.status).toBe(400)
    }
    expect(rows(h)).toEqual([])
  })

  test('a body over the size cap is refused before it is parsed', async () => {
    const h = harness(() => T0)
    const res = await h.request('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ ...valid, body: 'x'.repeat(9000) }),
      headers: { 'content-type': 'application/json', origin: 'https://app.mamoru.lol' },
    })
    expect(res.status).toBe(413)
    expect(rows(h)).toEqual([])
  })

  test('rate limiter: refused over the limit, not blocking when absent, failing open when it throws', async () => {
    const refusing = { limit: async () => ({ success: false }) }
    const h1 = harness(() => T0, { env: { FEEDBACK_LIMIT: refusing } })
    const res1 = await send(h1, valid)
    expect(res1.status).toBe(429)
    expect(((await res1.json()) as { code?: string }).code).toBe('FEEDBACK_RATE_LIMITED')
    expect(rows(h1)).toEqual([])

    const h2 = harness(() => T0)
    expect((await send(h2, valid)).status).toBe(200)

    const original = console.error
    console.error = () => {}
    try {
      const throwing = { limit: async () => Promise.reject(new Error('binding down')) }
      const h3 = harness(() => T0, { env: { FEEDBACK_LIMIT: throwing } })
      expect((await send(h3, valid)).status).toBe(200)
    } finally {
      console.error = original
    }
  })

  test('rate limiter: keyed by device session when there is one, else by a hashed IP, and the key never carries the raw IP', async () => {
    const keys: string[] = []
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) }
    const h = harness(() => T0, { env: { FEEDBACK_LIMIT: limiter } })
    const res = await register(h, PASSKEY_A)
    const cookie = sessionCookie(res)
    const { userId } = (await (await h.request('/api/session', { cookie })).json()) as { userId: string }

    await send(h, valid, { cookie })
    await send(h, valid, { ip: '198.51.100.7' })
    await send(h, valid, { ip: '198.51.100.7' })

    expect(keys[0]).toBe(`u:${userId}`)
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[1]).toBe(keys[2])
    expect(keys.join(' ')).not.toContain('198.51.100.7')
  })

  test('Mattermost: a support request posts a new root post in the support channel and keeps the returned id', async () => {
    const posts: { url: string; channel_id: string; message: string; auth: string | null }[] = []
    const mattermostFetch = async (input: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { channel_id: string; message: string }
      posts.push({ url: input, channel_id: payload.channel_id, message: payload.message, auth: (init.headers as Record<string, string>).authorization ?? null })
      return Response.json({ id: 'mm-post-1' })
    }
    const h = harness(() => T0, {
      env: { MATTERMOST_URL: 'https://chat.example', MATTERMOST_BOT_TOKEN: 'bot-secret-token', MATTERMOST_SUPPORT_CHANNEL_ID: 'support-chan', MATTERMOST_FEEDBACK_CHANNEL_ID: 'feedback-chan' },
      mattermostFetch,
    })
    const res = await send(h, { kind: 'support', body: 'My deposit never arrived.', contact: 'ot@example.com', route: '/add' })
    const resBody = (await res.json()) as FeedbackResponse
    expect(posts.length).toBe(1)
    expect(posts[0]!.url).toBe('https://chat.example/api/v4/posts')
    expect(posts[0]!.channel_id).toBe('support-chan')
    expect(posts[0]!.auth).toBe('Bearer bot-secret-token')
    expect(posts[0]!.message).toContain(`Support request · ${resBody.id.slice(0, 8)} · /add`)
    expect(posts[0]!.message).toContain('> My deposit never arrived.')
    // The contact line is mention-neutralised too (an email's local part can read as '@word'), so compare with the joiner stripped.
    expect(posts[0]!.message.replace(/​/g, '')).toContain('Contact: ot@example.com')
    expect(rows(h)[0]!.mm_post_id).toBe('mm-post-1')
  })

  test('Mattermost: a bug or idea posts one compact post in the feedback channel', async () => {
    const posts: { channel_id: string; message: string }[] = []
    const mattermostFetch = async (_input: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)) as { channel_id: string; message: string })
      return Response.json({ id: 'mm-post-2' })
    }
    const h = harness(() => T0, {
      env: { MATTERMOST_URL: 'https://chat.example', MATTERMOST_BOT_TOKEN: 'bot-secret-token', MATTERMOST_SUPPORT_CHANNEL_ID: 'support-chan', MATTERMOST_FEEDBACK_CHANNEL_ID: 'feedback-chan' },
      mattermostFetch,
    })
    await send(h, { kind: 'idea', body: 'Dark mode would be nice.', route: '/' })
    expect(posts.length).toBe(1)
    expect(posts[0]!.channel_id).toBe('feedback-chan')
    expect(posts[0]!.message).toContain('Feedback (idea) · /')
    expect(posts[0]!.message).toContain('> Dark mode would be nice.')
  })

  test('Mattermost down, refusing or throwing: the request still answers 200, the row is kept, and the token never reaches the log or the response', async () => {
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    try {
      const failures: Array<() => Promise<Response>> = [
        async () => {
          throw new Error('connect failed to https://chat.example with bot-secret-token')
        },
        async () => new Response('bot-secret-token leaked in body', { status: 500 }),
        async () => new Response('nope', { status: 401 }),
      ]
      for (const fail of failures) {
        const h = harness(() => T0, {
          env: { MATTERMOST_URL: 'https://chat.example', MATTERMOST_BOT_TOKEN: 'bot-secret-token', MATTERMOST_SUPPORT_CHANNEL_ID: 's', MATTERMOST_FEEDBACK_CHANNEL_ID: 'f' },
          mattermostFetch: fail,
        })
        const res = await send(h, valid)
        const text = await res.text()
        expect(res.status).toBe(200)
        expect(text).not.toContain('bot-secret-token')
        expect(rows(h).length).toBe(1)
        expect(rows(h)[0]!.mm_post_id).toBeNull()
      }
    } finally {
      console.error = original
    }
    expect(logged.length).toBeGreaterThan(0)
    expect(logged.join('\n')).not.toContain('bot-secret-token')
  })

  test('mentions are neutralised: @channel, @all, @here and an arbitrary @name never reach Mattermost as a live mention', async () => {
    const posts: string[] = []
    const mattermostFetch = async (_input: string, init: RequestInit) => {
      posts.push((JSON.parse(String(init.body)) as { message: string }).message)
      return Response.json({ id: 'mm-post-3' })
    }
    const h = harness(() => T0, {
      env: { MATTERMOST_URL: 'https://chat.example', MATTERMOST_BOT_TOKEN: 'secret', MATTERMOST_SUPPORT_CHANNEL_ID: 's', MATTERMOST_FEEDBACK_CHANNEL_ID: 'f' },
      mattermostFetch,
    })
    await send(h, { kind: 'bug', body: 'ping @channel and @all and @here, also @someone look at this', contact: 'reach me @handle', route: '/' })
    const message = posts[0]!
    // The zero-width joiner breaks up the literal mention text, so the contiguous sequence is gone...
    for (const mention of ['@channel', '@all', '@here', '@someone', '@handle']) expect(message).not.toContain(mention)
    // ...while the words themselves are still readable.
    expect(message).toContain('channel')
    expect(message).toContain('handle')
  })

  test('every line of a quoted body carries its own >, so a blank line or a code fence cannot break out of the quote', async () => {
    const posts: string[] = []
    const mattermostFetch = async (_input: string, init: RequestInit) => {
      posts.push((JSON.parse(String(init.body)) as { message: string }).message)
      return Response.json({ id: 'mm-post-4' })
    }
    const h = harness(() => T0, {
      env: { MATTERMOST_URL: 'https://chat.example', MATTERMOST_BOT_TOKEN: 'secret', MATTERMOST_SUPPORT_CHANNEL_ID: 's', MATTERMOST_FEEDBACK_CHANNEL_ID: 'f' },
      mattermostFetch,
    })
    await send(h, { kind: 'bug', body: 'line one\n\n```\nline three\n```', route: '/' })
    for (const line of posts[0]!.split('\n').slice(1)) expect(line.startsWith('> ')).toBe(true)
  })

  test('missing Mattermost env: nothing is fetched, the row is still kept', async () => {
    let called = false
    const mattermostFetch = async () => {
      called = true
      return Response.json({ id: 'should not be called' })
    }
    const h = harness(() => T0, { mattermostFetch })
    const res = await send(h, valid)
    expect(res.status).toBe(200)
    expect(called).toBe(false)
    expect(rows(h).length).toBe(1)
    expect(rows(h)[0]!.mm_post_id).toBeNull()
  })

  test('a cross-origin POST is refused like every other state-changing route', async () => {
    const h = harness(() => T0)
    const res = await h.request('/api/feedback', { method: 'POST', body: JSON.stringify(valid), headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect(rows(h)).toEqual([])
  })
})
