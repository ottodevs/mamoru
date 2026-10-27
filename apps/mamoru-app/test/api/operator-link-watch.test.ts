import { describe, expect, test } from 'bun:test'
import { memoryD1 } from './d1.ts'
import { DOWN_AFTER_MS, REMIND_EVERY_MS, probeOperator, runOperatorLinkWatch, watchOne } from '../../src/api/operator-link-watch.ts'
import type { Env } from '../../src/api/env.ts'
import type { OperatorFetch } from '../../src/api/yield-ledger.ts'

const T0 = new Date('2026-10-26T08:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const DOWN = { up: false as const, reason: 'timeout' }
const UP = { up: true as const }

function recorder(deliver = true) {
  const sent: string[] = []
  return { sent, notify: async (t: string) => (sent.push(t), deliver) }
}

describe('probeOperator (otto/mamoru#207)', () => {
  const answer = (status: number, body: unknown): OperatorFetch => async () => new Response(JSON.stringify(body), { status })

  test('up on 200 ok with the expected chain', async () => {
    expect(await probeOperator('https://op.example', 8453, answer(200, { ok: true, chainId: 8453 }))).toEqual({ up: true })
  })
  test('down on another chain, a non-200, a not-ok body and a thrown fetch; the reason never carries the URL', async () => {
    expect(await probeOperator('https://op.example', 8453, answer(200, { ok: true, chainId: 143 }))).toEqual({ up: false, reason: 'wrong chain 143' })
    expect(await probeOperator('https://op.example', 8453, answer(530, {}))).toEqual({ up: false, reason: 'http 530' })
    expect(await probeOperator('https://op.example', 8453, answer(200, { ok: false }))).toEqual({ up: false, reason: 'health not ok' })
    const r = await probeOperator('https://secret-tunnel.example', 8453, async () => { throw new Error('connect https://secret-tunnel.example') })
    expect(r).toEqual({ up: false, reason: 'unreachable' })
  })
})

describe('watchOne (otto/mamoru#207)', () => {
  test('a blip shorter than DOWN_AFTER_MS says nothing, down or up', async () => {
    const db = memoryD1()
    const r = recorder()
    await watchOne(db, 8453, DOWN, r.notify, at(0))
    await watchOne(db, 8453, DOWN, r.notify, at(DOWN_AFTER_MS - 1))
    await watchOne(db, 8453, UP, r.notify, at(DOWN_AFTER_MS))
    expect(r.sent).toEqual([])
  })

  test('one alert past DOWN_AFTER_MS, a reminder after REMIND_EVERY_MS, one recovery', async () => {
    const db = memoryD1()
    const r = recorder()
    await watchOne(db, 8453, DOWN, r.notify, at(0))
    await watchOne(db, 8453, DOWN, r.notify, at(DOWN_AFTER_MS))
    await watchOne(db, 8453, DOWN, r.notify, at(DOWN_AFTER_MS + 10 * 60_000))
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toContain('Base operator for 15 min')
    await watchOne(db, 8453, DOWN, r.notify, at(DOWN_AFTER_MS + REMIND_EVERY_MS))
    expect(r.sent).toHaveLength(2)
    await watchOne(db, 8453, UP, r.notify, at(DOWN_AFTER_MS + REMIND_EVERY_MS + 60_000))
    await watchOne(db, 8453, UP, r.notify, at(DOWN_AFTER_MS + REMIND_EVERY_MS + 120_000))
    expect(r.sent).toHaveLength(3)
    expect(r.sent[2]).toContain('reaches the Base operator again')
  })

  test('two runs on the same tick (prod and beta) post each transition once', async () => {
    const db = memoryD1()
    const r = recorder()
    await watchOne(db, 143, DOWN, r.notify, at(0))
    await Promise.all([watchOne(db, 143, DOWN, r.notify, at(DOWN_AFTER_MS)), watchOne(db, 143, DOWN, r.notify, at(DOWN_AFTER_MS))])
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toContain('Monad operator')
    await Promise.all([watchOne(db, 143, UP, r.notify, at(DOWN_AFTER_MS + 60_000)), watchOne(db, 143, UP, r.notify, at(DOWN_AFTER_MS + 60_000))])
    expect(r.sent).toHaveLength(2)
  })

  test('an alert no channel took is retried on the next tick', async () => {
    const db = memoryD1()
    const failing = recorder(false)
    await watchOne(db, 8453, DOWN, failing.notify, at(0))
    await watchOne(db, 8453, DOWN, failing.notify, at(DOWN_AFTER_MS))
    const ok = recorder()
    await watchOne(db, 8453, DOWN, ok.notify, at(DOWN_AFTER_MS + 10 * 60_000))
    expect(failing.sent).toHaveLength(1)
    expect(ok.sent).toHaveLength(1)
  })
})

describe('runOperatorLinkWatch (otto/mamoru#207)', () => {
  test('probes each configured chain and posts to Mattermost and Telegram without leaking the operator URL', async () => {
    const db = memoryD1()
    const posts: { url: string; body: string }[] = []
    const fetcher: OperatorFetch = async (url, init) => {
      if (url.endsWith('/health')) return url.startsWith('https://base-op') ? new Response('', { status: 530 }) : new Response(JSON.stringify({ ok: true, chainId: 143 }))
      posts.push({ url, body: String(init.body) })
      return new Response('{"id":"p1","ok":true}', { status: 200 })
    }
    const env = {
      DB: db,
      OPERATOR_URL: 'https://base-op.trycloudflare.com',
      OPERATOR_URL_143: 'https://monad-op.trycloudflare.com',
      MATTERMOST_URL: 'https://mm.example',
      MATTERMOST_BOT_TOKEN: 'bot',
      MATTERMOST_OPS_CHANNEL_ID: 'ch',
      TELEGRAM_BOT_TOKEN: 'tg',
      TELEGRAM_ALERT_CHAT_ID: '42',
    } as Env
    await runOperatorLinkWatch(env, fetcher, at(0))
    await runOperatorLinkWatch(env, fetcher, at(DOWN_AFTER_MS))
    expect(posts.map((p) => p.url)).toEqual(['https://mm.example/api/v4/posts', 'https://api.telegram.org/bottg/sendMessage'])
    for (const p of posts) {
      expect(p.body).toContain('Base operator')
      expect(p.body).not.toContain('trycloudflare')
    }
    const rows = db.raw.query('SELECT chain_id, down_since FROM operator_link_watch ORDER BY chain_id').all()
    expect(rows).toEqual([{ chain_id: 143, down_since: null }, { chain_id: 8453, down_since: T0.toISOString() }])
  })
})
