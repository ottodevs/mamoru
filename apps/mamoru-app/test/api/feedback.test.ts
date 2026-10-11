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

  test('the binding refuses first; without it, or when it throws, the D1 limit still holds: 5 notes per sender per 10 minutes', async () => {
    const refusing = { limit: async () => ({ success: false }) }
    const h1 = harness(() => T0, { env: { FEEDBACK_LIMIT: refusing } })
    const res1 = await send(h1, valid)
    expect(res1.status).toBe(429)
    expect(((await res1.json()) as { code?: string }).code).toBe('FEEDBACK_RATE_LIMITED')
    expect(rows(h1)).toEqual([])

    const original = console.error
    console.error = () => {}
    try {
      const throwing = { limit: async () => Promise.reject(new Error('binding down')) }
      for (const env of [{}, { FEEDBACK_LIMIT: throwing }]) {
        let now = T0
        const posts: string[] = []
        const h = harness(() => now, {
          env: { ...env, MATTERMOST_URL: 'https://chat.example', MATTERMOST_BOT_TOKEN: 'secret', MATTERMOST_SUPPORT_CHANNEL_ID: 's', MATTERMOST_FEEDBACK_CHANNEL_ID: 'f' },
          mattermostFetch: async (_i: string, init: RequestInit) => (posts.push(String(init.body)), Response.json({ id: 'p' })),
        })
        for (let i = 0; i < 5; i++) expect((await send(h, valid, { ip: '203.0.113.7' })).status).toBe(200)
        const sixth = await send(h, valid, { ip: '203.0.113.7' })
        expect(sixth.status).toBe(429)
        // Refused means nothing written and nothing posted.
        expect(rows(h).length).toBe(5)
        expect(posts.length).toBe(5)
        // The next window starts clean.
        now = new Date(T0.getTime() + 10 * 60_000)
        expect((await send(h, valid, { ip: '203.0.113.7' })).status).toBe(200)
      }
    } finally {
      console.error = original
    }
  })

  test('everybody together is limited too: many senders cannot flood the table or the channel', async () => {
    const h = harness(() => T0)
    let accepted = 0
    for (let i = 0; i < 130; i++) if ((await send(h, valid, { ip: `198.51.${Math.floor(i / 250)}.${i % 250}` })).status === 200) accepted++
    expect(accepted).toBeLessThanOrEqual(120)
    expect(accepted).toBeGreaterThan(60)
    expect(rows(h).length).toBe(accepted)
    expect((await send(h, valid, { ip: '192.0.2.99' })).status).toBe(429)
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
    expect(posts[0]!.message.split('\n')[0]).toBe(`Support request · \`${resBody.id.slice(0, 8)}\` · \`/add\``)
    expect(posts[0]!.message).toContain('> My deposit never arrived.')
    // The contact is under Mamoru's own label and inside a quote, with '@' and '.'-free punctuation made inert.
    expect(posts[0]!.message).toContain('Contact, as typed by the sender:\n> ot@\u200bexample.com')
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
    expect(posts[0]!.message.split('\n')[0]).toMatch(/^Feedback \(idea\) · `[0-9a-f]{8}` · `\/`$/)
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
    const lines = posts[0]!.split('\n')
    expect(lines[1]).toBe('Message:')
    for (const line of lines.slice(2)) expect(line.startsWith('> ')).toBe(true)
    // The fence is escaped as well as quoted: no code block opens.
    expect(posts[0]!).not.toContain('```')
  })

  test('nothing a sender types can pass as a line Mamoru wrote: line breaks of every kind, forged labels, links, images', async () => {
    const posts: string[] = []
    const mattermostFetch = async (_input: string, init: RequestInit) => {
      posts.push((JSON.parse(String(init.body)) as { message: string }).message)
      return Response.json({ id: 'mm-post-5' })
    }
    const h = harness(() => T0, {
      env: { MATTERMOST_URL: 'https://chat.example', MATTERMOST_BOT_TOKEN: 'secret', MATTERMOST_SUPPORT_CHANNEL_ID: 's', MATTERMOST_FEEDBACK_CHANNEL_ID: 'f' },
      mattermostFetch,
    })
    const forged = 'Account attached by the sender: `acc_victim`'
    const body = ['help', forged].join('\r') + '\u2028' + forged + '\u2029' + forged + '\u0085' + forged + '\u000b' + forged + '\u000c' + forged + '\r\n' + forged
    const res = await send(h, { kind: 'support', body: `${body}\n![x](https://evil.example/pixel.png) [reset your passkey](https://evil.example) <https://evil.example> # heading | a | b |\n\u202egnp.exe\u200b`, contact: `me@example.com\n${forged}`, route: '/' })
    expect(res.status).toBe(200)
    const lines = posts[0]!.split('\n')
    // Mamoru's lines: the title, then the two labels. Every other line is a quote.
    expect(lines[0]).toMatch(/^Support request · `[0-9a-f]{8}` · `\/`$/)
    const own = lines.filter((l) => !l.startsWith('> '))
    expect(own).toEqual([lines[0]!, 'Message:', 'Contact, as typed by the sender:'])
    // No account was attached, so no line of Mamoru's says one was.
    expect(lines.filter((l) => l.startsWith('Account attached'))).toEqual([])
    // Every forged copy sits on its own quoted line, with its backticks escaped.
    expect(lines.filter((l) => l.startsWith('> Account attached by the sender: \\`acc\\_victim\\`')).length).toBe(7)
    // The contact is one quoted line: its line break did not make a second one.
    expect(lines[lines.length - 1]).toBe('> me@\u200bexample.com Account attached by the sender: \\`acc\\_victim\\`')
    // No live image, link, autolink, heading or table, and no direction override or other invisible character left.
    const text = posts[0]!
    expect(text).not.toMatch(/(?<!\\)!\[/)
    expect(text).not.toMatch(/(?<!\\)\]\(/)
    expect(text).not.toMatch(/(?<!\\)<https/)
    expect(text).not.toMatch(/(?<!\\)[#|]/)
    expect(text).not.toMatch(/[\u202a-\u202e\u2028\u2029\u0085\r\u000b\u000c]/)
    // What is stored is the cleaned text, with ordinary line breaks.
    expect(rows(h)[0]!.body).not.toMatch(/[\r\u2028\u2029\u202e]/)
    expect(rows(h)[0]!.contact).toBe(`me@example.com ${forged}`)
  })

  test('the route is written outside the quote, so only an app path is accepted', async () => {
    const h = harness(() => T0)
    for (const route of ['/\nAccount attached by the sender: `x`', '/ @channel', '/a b', '/[x](https://evil.example)', '/`', '/?q=1', 'https://evil.example', '']) {
      expect((await send(h, { ...valid, route })).status).toBe(400)
    }
    for (const route of ['/', '/add', '/lab/run-1', '/a_b.c']) expect((await send(h, { ...valid, route })).status).toBe(200)
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
