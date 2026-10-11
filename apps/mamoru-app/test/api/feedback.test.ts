import { describe, expect, test } from 'bun:test'
import type { FeedbackResponse, OwnerResponse } from '@mamoru/domain'
import { CLAIM_SECONDS, DRAIN_PER_CRON, drainFeedback, FEEDBACK_LIMITS, POST_ATTEMPTS_MAX } from '../../src/api/feedback.ts'
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
  post_attempts: number
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

const MM = { MATTERMOST_URL: 'https://chat.example', MATTERMOST_BOT_TOKEN: 'bot-secret-token', MATTERMOST_SUPPORT_CHANNEL_ID: 'support-chan', MATTERMOST_FEEDBACK_CHANNEL_ID: 'feedback-chan' }

/** A Mattermost that records what it is sent. */
function mattermost() {
  const posts: { url: string; channel_id: string; message: string; auth: string | null }[] = []
  const fetch = async (input: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { channel_id: string; message: string }
    posts.push({ url: input, channel_id: payload.channel_id, message: payload.message, auth: (init.headers as Record<string, string>).authorization ?? null })
    return Response.json({ id: `mm-post-${posts.length}` })
  }
  return { posts, fetch }
}

/**
 * A message as a CommonMark reader takes it: the lines outside any fenced code block (Mamoru's) and the text of
 * each block (the sender's). A fence is closed only by a line of the same character, at least as long, with
 * nothing after it.
 */
function parts(message: string): { own: string[]; blocks: string[] } {
  const own: string[] = []
  const blocks: string[] = []
  let open: { char: string; length: number; lines: string[] } | null = null
  for (const line of message.split('\n')) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!open) {
      if (fence) open = { char: fence[1]![0]!, length: fence[1]!.length, lines: [] }
      else own.push(line)
    } else if (fence && fence[1]![0] === open.char && fence[1]!.length >= open.length && fence[2]!.trim() === '') {
      blocks.push(open.lines.join('\n'))
      open = null
    } else open.lines.push(line)
  }
  if (open) throw new Error('a code block was left open')
  return { own, blocks }
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
    expect(cols).toEqual(['account_key', 'app_version', 'body', 'contact', 'created_at', 'id', 'kind', 'mm_post_id', 'post_attempts', 'route', 'status', 'ticket_url'].sort())
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

  test('honeypot: a filled trap field answers success and stores nothing, whatever else is wrong with the request', async () => {
    const h = harness(() => T0)
    const res = await send(h, { kind: 'not-a-kind', body: '', route: 'not-a-route', leaveEmpty: 'http://spam.example' })
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
        const mm = mattermost()
        const h = harness(() => now, { env: { ...env, ...MM }, mattermostFetch: mm.fetch })
        for (let i = 0; i < 5; i++) expect((await send(h, valid, { ip: '203.0.113.7' })).status).toBe(200)
        expect((await send(h, valid, { ip: '203.0.113.7' })).status).toBe(429)
        // Refused means nothing written and nothing posted.
        expect(rows(h).length).toBe(5)
        expect(mm.posts.length).toBe(5)
        // The next window starts clean.
        now = new Date(T0.getTime() + 10 * 60_000)
        expect((await send(h, valid, { ip: '203.0.113.7' })).status).toBe(200)
      }
    } finally {
      console.error = original
    }
  })

  test("a refused sender runs up only their own counter: the shared ones do not move, and failed validation counts nothing", async () => {
    const h = harness(() => T0)
    const counters = () => Object.fromEntries((h.db.raw.query("SELECT key, count FROM auth_rate WHERE key LIKE 'fb:%'").all() as { key: string; count: number }[]).map((r) => [r.key.replace(/^fb:ip:[0-9a-f]{32}$/, 'fb:sender'), r.count]))
    for (let i = 0; i < 5; i++) await send(h, valid, { ip: '203.0.113.7' })
    expect(counters()).toEqual({ 'fb:sender': 5, 'fb:stored': 5 })
    for (let i = 0; i < 40; i++) expect((await send(h, valid, { ip: '203.0.113.7' })).status).toBe(429)
    expect(counters()).toEqual({ 'fb:sender': 45, 'fb:stored': 5 })
    expect(rows(h).length).toBe(5)
    for (let i = 0; i < 10; i++) expect((await send(h, { ...valid, body: '' }, { ip: '203.0.113.8' })).status).toBe(400)
    expect(counters()).toEqual({ 'fb:sender': 45, 'fb:stored': 5 })
  })

  test('a burst from one sender at the same moment stores five and no more', async () => {
    const mm = mattermost()
    const h = harness(() => T0, { env: MM, mattermostFetch: mm.fetch })
    const statuses = await Promise.all(Array.from({ length: 40 }, () => send(h, valid, { ip: '203.0.113.9' }).then((r) => r.status)))
    expect(statuses.filter((s) => s === 200).length).toBe(5)
    expect(statuses.filter((s) => s === 429).length).toBe(35)
    expect(rows(h).length).toBe(5)
    expect(mm.posts.length).toBe(5)
  })

  test('two senders never share an allowance: the key of an IP is long, and says nothing of the IP', async () => {
    const h = harness(() => T0)
    for (let i = 0; i < 5; i++) await send(h, valid, { ip: '203.0.113.7' })
    expect((await send(h, valid, { ip: '203.0.113.7' })).status).toBe(429)
    for (let i = 0; i < 200; i++) expect((await send(h, valid, { ip: `198.51.${i % 250}.${(i * 7) % 250}` })).status).toBe(200)
    const keys = (h.db.raw.query("SELECT key FROM auth_rate WHERE key LIKE 'fb:ip:%'").all() as { key: string }[]).map((r) => r.key)
    expect(keys.length).toBe(201)
    for (const k of keys) expect(k).toMatch(/^fb:ip:[0-9a-f]{32}$/)
    expect(JSON.stringify(h.db.raw.query('SELECT * FROM auth_rate').all())).not.toContain('203.0.113')
  })

  test('feedback cannot use up what support needs, and nobody is refused for it: over a budget a note is stored and waits', async () => {
    let now = T0
    const mm = mattermost()
    const h = harness(() => now, { env: MM, mattermostFetch: mm.fetch })
    // 40 senders, one idea each: more than the 30 feedback posts of a window. Every one is accepted.
    for (let i = 0; i < 40; i++) expect((await send(h, { ...valid, kind: 'idea' }, { ip: `198.51.100.${i}` })).status).toBe(200)
    expect(mm.posts.length).toBe(30)
    expect(rows(h).filter((r) => r.mm_post_id === null).length).toBe(10)
    // A support request now is posted at once, in its own channel, ahead of the feedback that waits.
    const res = await send(h, { kind: 'support', body: 'My deposit never arrived.', route: '/add' }, { ip: '192.0.2.99' })
    expect(res.status).toBe(200)
    const id = ((await res.json()) as FeedbackResponse).id
    expect(mm.posts.length).toBe(31)
    expect(mm.posts[30]!.channel_id).toBe('support-chan')
    expect(rows(h).find((r) => r.id === id)!.mm_post_id).toBe('mm-post-31')
    // Next window: the cron posts the ten that waited, oldest first.
    now = new Date(T0.getTime() + 10 * 60_000)
    expect(await drainFeedback(h.db, mm.fetch, h.env, now, DRAIN_PER_CRON)).toBe(10)
    expect(mm.posts.length).toBe(41)
    expect(rows(h).filter((r) => r.mm_post_id === null)).toEqual([])
  })

  test('the stored limit is far above real use, and the sender it refuses spends nothing', async () => {
    expect(FEEDBACK_LIMITS.stored).toBeGreaterThanOrEqual(1000)
    const h = harness(() => T0)
    const window = Math.floor(T0.getTime() / 1000) - (Math.floor(T0.getTime() / 1000) % 600)
    h.db.raw.query('INSERT INTO auth_rate (key, window, count) VALUES (?, ?, ?)').run('fb:stored', window, FEEDBACK_LIMITS.stored - 1)
    expect((await send(h, valid, { ip: '203.0.113.1' })).status).toBe(200)
    expect((await send(h, valid, { ip: '203.0.113.2' })).status).toBe(429)
    expect(h.db.raw.query("SELECT COUNT(*) AS n FROM auth_rate WHERE key LIKE 'fb:ip:%'").get()).toEqual({ n: 1 })
  })

  test('Mattermost was down: the notes are posted later, support first and oldest first, each exactly once', async () => {
    let now = T0
    let up = false
    const mm = mattermost()
    const fetch = async (input: string, init: RequestInit) => (up ? mm.fetch(input, init) : new Response('down', { status: 503 }))
    const original = console.error
    console.error = () => {}
    try {
      const h = harness(() => now, { env: MM, mattermostFetch: fetch })
      const ids: string[] = []
      for (const [i, kind] of (['bug', 'support', 'idea', 'support'] as const).entries()) {
        now = new Date(T0.getTime() + i * 1000)
        const res = await send(h, { kind, body: `note ${i}`, route: '/' }, { ip: `203.0.113.${30 + i}` })
        expect(res.status).toBe(200)
        ids.push(((await res.json()) as FeedbackResponse).id)
      }
      // Nothing was posted, nothing is lost, and no claim is left behind.
      expect(mm.posts).toEqual([])
      expect(rows(h).map((r) => r.mm_post_id)).toEqual([null, null, null, null])

      up = true
      now = new Date(T0.getTime() + 60_000)
      // Two runs at the same moment (the cron of two Workers, or a request and the cron).
      const [a, b] = await Promise.all([drainFeedback(h.db, fetch, h.env, now, DRAIN_PER_CRON), drainFeedback(h.db, fetch, h.env, now, DRAIN_PER_CRON)])
      expect(a + b).toBe(4)
      expect(mm.posts.length).toBe(4)
      const short = (i: number) => ids[i]!.slice(0, 8)
      expect(mm.posts.map((p) => p.message.split('\n')[0])).toEqual([
        `Support request · \`${short(1)}\` · \`/\``,
        `Support request · \`${short(3)}\` · \`/\``,
        `Feedback (bug) · \`${short(0)}\` · \`/\``,
        `Feedback (idea) · \`${short(2)}\` · \`/\``,
      ])
      expect(rows(h).every((r) => r.mm_post_id?.startsWith('mm-post-'))).toBe(true)
      // A later run finds nothing to do.
      expect(await drainFeedback(h.db, fetch, h.env, new Date(now.getTime() + 60_000), DRAIN_PER_CRON)).toBe(0)
      expect(mm.posts.length).toBe(4)
    } finally {
      console.error = original
    }
  })

  test('a claim left by a Worker that died is taken over after two minutes, not before; a note already ticketed or closed is left alone', async () => {
    const mm = mattermost()
    const h = harness(() => T0, { mattermostFetch: mm.fetch })
    for (let i = 0; i < 3; i++) await send(h, { ...valid, body: `note ${i}` }, { ip: `203.0.113.${40 + i}` })
    const [a, b, c] = rows(h)
    const at = (d: Date) => `posting:${Math.floor(d.getTime() / 1000)}`
    h.db.raw.query('UPDATE feedback SET mm_post_id = ? WHERE id = ?').run(at(T0), a!.id)
    h.db.raw.query("UPDATE feedback SET status = 'closed' WHERE id = ?").run(c!.id)
    const env = { ...h.env, ...MM }
    expect(await drainFeedback(h.db, mm.fetch, env, new Date(T0.getTime() + (CLAIM_SECONDS - 1) * 1000), DRAIN_PER_CRON)).toBe(1)
    expect(rows(h).find((r) => r.id === b!.id)!.mm_post_id).toBe('mm-post-1')
    expect(rows(h).find((r) => r.id === a!.id)!.mm_post_id).toBe(at(T0))
    expect(await drainFeedback(h.db, mm.fetch, env, new Date(T0.getTime() + (CLAIM_SECONDS + 1) * 1000), DRAIN_PER_CRON)).toBe(1)
    expect(rows(h).find((r) => r.id === a!.id)!.mm_post_id).toBe('mm-post-2')
    expect(rows(h).find((r) => r.id === c!.id)!.mm_post_id).toBeNull()
    expect(mm.posts.length).toBe(2)
  })

  test('a note Mattermost refuses does not hold the queue: the ones behind it are posted, and after five tries it is left for a person', async () => {
    const original = console.error
    console.error = () => {}
    try {
      const mm = mattermost()
      // Mattermost takes everything except the note whose text says "poison": that one is always a 400.
      const fetch = async (input: string, init: RequestInit) => (String(init.body).includes('poison') ? new Response('bad post', { status: String(init.body).includes('poison-large') ? 413 : 400 }) : mm.fetch(input, init))
      const h = harness(() => T0)
      const env = { ...h.env, ...MM }
      for (const [i, body] of ['poison', 'second', 'poison-large', 'third'].entries()) {
        h.db.raw.query("INSERT INTO feedback (id, created_at, kind, body, route, status) VALUES (?, ?, 'support', ?, '/', 'new')").run(`id-${i}`, new Date(T0.getTime() + i * 1000).toISOString(), body)
      }
      expect(await drainFeedback(h.db, fetch, env, T0, DRAIN_PER_CRON)).toBe(2)
      expect(mm.posts.map((p) => parts(p.message).blocks[0])).toEqual(['second', 'third'])
      const poison = () => rows(h).find((r) => r.id === 'id-0')!
      expect(poison()).toMatchObject({ mm_post_id: null, post_attempts: 1 })
      // A post that is too large (413) is the note's own problem as well.
      expect(rows(h).find((r) => r.id === 'id-2')).toMatchObject({ mm_post_id: null, post_attempts: 1 })
      // It is tried again on later runs, up to the limit, and then no more.
      for (let i = 2; i <= POST_ATTEMPTS_MAX + 3; i++) await drainFeedback(h.db, fetch, env, new Date(T0.getTime() + i * 600_000), DRAIN_PER_CRON)
      expect(poison()).toMatchObject({ mm_post_id: null, post_attempts: POST_ATTEMPTS_MAX, status: 'new' })
      expect(mm.posts.length).toBe(2)
    } finally {
      console.error = original
    }
  })

  test('an outage, a bad token, a bot that is not in the channel, a wrong channel id and a throttled server count against no note, however long they last', async () => {
    const original = console.error
    console.error = () => {}
    try {
      const mm = mattermost()
      let status = 503
      const fetch = async (input: string, init: RequestInit) => (status === 200 ? mm.fetch(input, init) : new Response('no', { status }))
      const h = harness(() => T0)
      const env = { ...h.env, ...MM }
      h.db.raw.query("INSERT INTO feedback (id, created_at, kind, body, route, status) VALUES ('s', ?, 'support', 'help', '/', 'new'), ('f', ?, 'bug', 'bug', '/', 'new')").run(T0.toISOString(), T0.toISOString())
      for (const code of [503, 500, 502, 401, 403, 404, 429]) {
        status = code
        for (let i = 0; i < 4; i++) expect(await drainFeedback(h.db, fetch, env, new Date(T0.getTime() + i * 600_000), DRAIN_PER_CRON)).toBe(0)
      }
      expect(rows(h).map((r) => [r.mm_post_id, r.post_attempts])).toEqual([[null, 0], [null, 0]])
      // 28 runs of failures later, with the channel fixed, both are posted: nothing was given up on.
      status = 200
      expect(await drainFeedback(h.db, fetch, env, new Date(T0.getTime() + 3_600_000), DRAIN_PER_CRON)).toBe(2)
    } finally {
      console.error = original
    }
  })

  test('one channel failing or out of budget does not stop the other', async () => {
    const original = console.error
    console.error = () => {}
    try {
      const mm = mattermost()
      // The support channel is down; the feedback channel works.
      const fetch = async (input: string, init: RequestInit) => (String(init.body).includes('support-chan') ? new Response('down', { status: 503 }) : mm.fetch(input, init))
      const h = harness(() => T0)
      const env = { ...h.env, ...MM }
      h.db.raw.query("INSERT INTO feedback (id, created_at, kind, body, route, status) VALUES ('s', ?, 'support', 'help', '/', 'new'), ('f', ?, 'idea', 'idea', '/', 'new')").run(T0.toISOString(), T0.toISOString())
      expect(await drainFeedback(h.db, fetch, env, T0, DRAIN_PER_CRON)).toBe(1)
      expect(mm.posts[0]!.channel_id).toBe('feedback-chan')

      // The support budget of the window is spent and many support notes wait: feedback is still posted.
      const h2 = harness(() => T0)
      const window = Math.floor(T0.getTime() / 1000) - (Math.floor(T0.getTime() / 1000) % 600)
      h2.db.raw.query('INSERT INTO auth_rate (key, window, count) VALUES (?, ?, ?)').run('fb:posts:support', window, FEEDBACK_LIMITS.posts.support)
      for (let i = 0; i < 100; i++) h2.db.raw.query("INSERT INTO feedback (id, created_at, kind, body, route, status) VALUES (?, ?, 'support', 'help', '/', 'new')").run(`s-${i}`, T0.toISOString())
      h2.db.raw.query("INSERT INTO feedback (id, created_at, kind, body, route, status) VALUES ('f', ?, 'bug', 'bug', '/', 'new')").run(T0.toISOString())
      const mm2 = mattermost()
      expect(await drainFeedback(h2.db, mm2.fetch, { ...h2.env, ...MM }, T0, DRAIN_PER_CRON)).toBe(1)
      expect(mm2.posts[0]!.channel_id).toBe('feedback-chan')
      // The support notes wait untouched: no claim, no attempt.
      expect(h2.db.raw.query("SELECT COUNT(*) AS n FROM feedback WHERE kind = 'support' AND mm_post_id IS NULL AND post_attempts = 0").get()).toEqual({ n: 100 })
    } finally {
      console.error = original
    }
  })

  test('runs at the same moment cannot pass the budget of the window between them', async () => {
    const h = harness(() => T0)
    const env = { ...h.env, ...MM }
    const window = Math.floor(T0.getTime() / 1000) - (Math.floor(T0.getTime() / 1000) % 600)
    h.db.raw.query('INSERT INTO auth_rate (key, window, count) VALUES (?, ?, ?)').run('fb:posts:support', window, FEEDBACK_LIMITS.posts.support - 2)
    for (let i = 0; i < 12; i++) h.db.raw.query("INSERT INTO feedback (id, created_at, kind, body, route, status) VALUES (?, ?, 'support', 'help', '/', 'new')").run(`s-${i}`, new Date(T0.getTime() + i).toISOString())
    const mm = mattermost()
    // A slow Mattermost, so the four runs overlap.
    const fetch = async (input: string, init: RequestInit) => (await new Promise((r) => setTimeout(r, 5)), mm.fetch(input, init))
    const posted = await Promise.all(Array.from({ length: 4 }, () => drainFeedback(h.db, fetch, env, T0, DRAIN_PER_CRON)))
    expect(posted.reduce((a, b) => a + b, 0)).toBe(2)
    expect(mm.posts.length).toBe(2)
    // The ten that did not fit wait with no claim and no attempt.
    expect(h.db.raw.query('SELECT COUNT(*) AS n FROM feedback WHERE mm_post_id IS NULL AND post_attempts = 0').get()).toEqual({ n: 10 })
  })

  test('an answer without a post id is kept as posted, not posted again', async () => {
    const h = harness(() => T0)
    h.db.raw.query("INSERT INTO feedback (id, created_at, kind, body, route, status) VALUES ('s', ?, 'support', 'help', '/', 'new')").run(T0.toISOString())
    let calls = 0
    const fetch = async () => (calls++, Response.json({}))
    expect(await drainFeedback(h.db, fetch, { ...h.env, ...MM }, T0, DRAIN_PER_CRON)).toBe(1)
    expect(await drainFeedback(h.db, fetch, { ...h.env, ...MM }, new Date(T0.getTime() + 600_000), DRAIN_PER_CRON)).toBe(0)
    expect(calls).toBe(1)
    expect(rows(h)[0]!.mm_post_id).toBe('posted:no-id')
  })

  test('without Mattermost configured the drain does nothing and claims nothing', async () => {
    const mm = mattermost()
    const h = harness(() => T0, { mattermostFetch: mm.fetch })
    await send(h, valid)
    expect(await drainFeedback(h.db, mm.fetch, h.env, T0, DRAIN_PER_CRON)).toBe(0)
    expect(mm.posts).toEqual([])
    expect(rows(h)[0]!.mm_post_id).toBeNull()
  })

  test('the Worker has a scheduled handler that drains, next to fetch', async () => {
    const worker = (await import('../../src/worker.ts')).default
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.scheduled).toBe('function')
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

  test("Mattermost: a support request is a new root post in the support channel, Mamoru's lines first, the sender's text in code blocks", async () => {
    const mm = mattermost()
    const h = harness(() => T0, { env: MM, mattermostFetch: mm.fetch })
    const res = await send(h, { kind: 'support', body: 'My deposit never arrived.\nSent 20 USDC.', contact: 'ot@example.com', route: '/add' })
    const id = ((await res.json()) as FeedbackResponse).id
    expect(mm.posts.length).toBe(1)
    expect(mm.posts[0]).toMatchObject({ url: 'https://chat.example/api/v4/posts', channel_id: 'support-chan', auth: 'Bearer bot-secret-token' })
    expect(parts(mm.posts[0]!.message)).toEqual({
      own: [`Support request · \`${id.slice(0, 8)}\` · \`/add\``, 'Message:', 'Contact, as typed by the sender:'],
      blocks: ['My deposit never arrived.\nSent 20 USDC.', 'ot@\u200bexample.com'],
    })
    expect(rows(h)[0]!.mm_post_id).toBe('mm-post-1')
  })

  test("Mattermost: an attached account is a line of Mamoru's own, before anything the sender typed", async () => {
    const mm = mattermost()
    const h = harness(() => T0, { env: MM, mattermostFetch: mm.fetch })
    const reg = await register(h, PASSKEY_A)
    const owner = (await reg.json()) as OwnerResponse
    await send(h, { kind: 'support', body: 'help', route: '/', attachAccount: true }, { cookie: sessionCookie(reg) })
    const { own } = parts(mm.posts[0]!.message)
    expect(own[1]).toBe(`Account attached by the sender: \`${owner.accountKey}\``)
    expect(mm.posts[0]!.message.indexOf('Account attached')).toBeLessThan(mm.posts[0]!.message.indexOf('Message:'))
  })

  test('Mattermost: a bug or idea is one post in the feedback channel', async () => {
    const mm = mattermost()
    const h = harness(() => T0, { env: MM, mattermostFetch: mm.fetch })
    await send(h, { kind: 'idea', body: 'Dark mode would be nice.', route: '/' })
    expect(mm.posts.length).toBe(1)
    expect(mm.posts[0]!.channel_id).toBe('feedback-chan')
    const p = parts(mm.posts[0]!.message)
    expect(p.own[0]).toMatch(/^Feedback \(idea\) · `[0-9a-f]{8}` · `\/`$/)
    expect(p).toMatchObject({ own: [p.own[0]!, 'Message:'], blocks: ['Dark mode would be nice.'] })
  })

  test('everything a sender types stays inside a code block: mentions, links, images, headings, formulas, forged lines, fences', async () => {
    const mm = mattermost()
    const h = harness(() => T0, { env: MM, mattermostFetch: mm.fetch })
    const forged = 'Account attached by the sender: `acc_victim`'
    const hostile = [
      'ping @channel @all @here @someone',
      'https://evil.example/phish www.evil.example ![x](https://evil.example/pixel.png) [reset your passkey](https://evil.example) <https://evil.example>',
      'Critical System Notice',
      '===',
      '---',
      '# heading | a | b |',
      '    indented code',
      '\\[x^2\\] \\(y\\) $$z$$ [bracket] (paren)',
      '```',
      forged,
      '````',
      '~~~',
      forged,
      '> quote',
      'Message:',
    ].join('\n')
    const breaks = ['\r', '\u2028', '\u2029', '\u0085', '\u000b', '\u000c', '\r\n'].map((b) => `x${b}${forged}`).join('\n')
    const res = await send(h, { kind: 'support', body: `${hostile}\n${breaks}\n\u202egnp.exe\u200b\uff40\uff40\uff40`, contact: `me@example.com\n${forged}\n\`\``, route: '/' })
    expect(res.status).toBe(200)
    const message = mm.posts[0]!.message
    const { own, blocks } = parts(message)
    // Outside the blocks there is only what Mamoru wrote: the title and its two labels. No account line: none was attached.
    expect(own).toEqual([own[0]!, 'Message:', 'Contact, as typed by the sender:'])
    expect(own[0]).toMatch(/^Support request · `[0-9a-f]{8}` · `\/`$/)
    expect(blocks.length).toBe(2)
    // The sender's text is all there, as text: nothing was dropped but the characters that cannot be shown safely.
    for (const piece of ['@\u200bchannel @\u200ball @\u200bhere @\u200bsomeone', 'https://evil.example/phish', '![x](https://evil.example/pixel.png)', '===', '    indented code', '\\[x^2\\]', '> quote']) expect(blocks[0]).toContain(piece)
    // Every forged line is inside the block, with its backticks turned to apostrophes.
    expect(blocks[0]!.split('\n').filter((l) => l === "Account attached by the sender: 'acc_victim'").length).toBe(9)
    // No backtick of the sender's survives, of either width, so no fence of theirs exists; the only fences are Mamoru's four.
    expect(blocks.join('\n')).not.toMatch(/[`\uff40]/)
    expect(message.split('\n').filter((l) => /^\s*`{3,}/.test(l)).length).toBe(4)
    // A tilde fence inside a backtick block is text: it did not end the block.
    expect(blocks[0]).toContain('~~~')
    // The contact is one line.
    expect(blocks[1]).toBe("me@\u200bexample.com Account attached by the sender: 'acc_victim' ''")
    // No odd line break or direction override reaches the channel or the table.
    expect(message).not.toMatch(/[\u202a-\u202e\u2028\u2029\u0085\r\u000b\u000c]/)
    // No '@' of the sender's is followed directly by a name, in either part.
    expect(message).not.toMatch(/@[^\u200b]/)
    expect(rows(h)[0]!.body).not.toMatch(/[\r\u2028\u2029\u202e]/)
  })

  test('the route is written outside the code blocks, so only an app path is accepted', async () => {
    const h = harness(() => T0)
    for (const route of ['/\nAccount attached by the sender: `x`', '/ @channel', '/a b', '/[x](https://evil.example)', '/`', '/?q=1', 'https://evil.example', '']) {
      expect((await send(h, { ...valid, route }, { ip: '203.0.113.20' })).status).toBe(400)
    }
    for (const route of ['/', '/add', '/lab/run-1', '/a_b.c']) expect((await send(h, { ...valid, route }, { ip: '203.0.113.20' })).status).toBe(200)
  })

  test('a body sent without a length is read only up to the cap', async () => {
    const h = harness(() => T0)
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new TextEncoder().encode('x'.repeat(4096)))
        if (pulled > 200) controller.close()
      },
    })
    const res = await h.request('/api/feedback', { method: 'POST', body: stream, headers: { 'content-type': 'application/json', origin: 'https://app.mamoru.lol' }, duplex: 'half' } as RequestInit)
    expect(res.status).toBe(413)
    expect(pulled).toBeLessThan(20)
    expect(rows(h)).toEqual([])
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
