import { describe, expect, test } from 'bun:test'
import type { OwnerResponse, SessionView } from '@mamoru/domain'
import type { Db, DbStatement, DbValue } from '../../src/api/env.ts'
import { harness, PASSKEY_A, sessionCookie } from './helpers.ts'

async function onboard(h: ReturnType<typeof harness>) {
  const res = await h.post('/api/onboarding/owner', { passkey: PASSKEY_A })
  expect(res.status).toBe(201)
  return { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
}

type ActivityRow = { account_key: string; day: string; hits: number; first_at: string; last_at: string }

function activityRow(h: ReturnType<typeof harness>, accountKey: string): ActivityRow | null {
  return (h.db.raw.query('SELECT * FROM account_activity WHERE account_key = ?').get(accountKey) as ActivityRow | null) ?? null
}

/** Wraps a Db so every statement touching account_activity throws; everything else passes through. */
function failingActivityDb(inner: Db): Db {
  const boom: DbStatement = {
    bind(...values: DbValue[]): DbStatement {
      void values
      return boom
    },
    first<T>(): Promise<T | null> {
      return Promise.reject(new Error('activity db unavailable'))
    },
    all<T>(): Promise<{ results: T[] }> {
      return Promise.reject(new Error('activity db unavailable'))
    },
    run(): Promise<unknown> {
      return Promise.reject(new Error('activity db unavailable'))
    },
  }
  return { prepare: (sql: string) => (sql.includes('account_activity') ? boom : inner.prepare(sql)) }
}

describe('account activity tracking', () => {
  test('an authenticated call that resolves an account upserts account_activity', async () => {
    const h = harness()
    const { cookie, owner } = await onboard(h)

    const res = await h.request('/api/session', { cookie })
    expect(res.status).toBe(200)
    expect(((await res.json()) as SessionView).accountKey).toBe(owner.accountKey)

    const row = activityRow(h, owner.accountKey)
    expect(row).toMatchObject({ account_key: owner.accountKey, day: '2026-09-26', hits: 1 })
    expect(row?.first_at).toBe(row?.last_at)
  })

  test('a later call outside the throttle window increments hits; within it, it does not', async () => {
    let now = new Date('2026-09-26T18:00:00Z')
    const h = harness(() => now)
    const { cookie, owner } = await onboard(h)
    await h.request('/api/session', { cookie })
    expect(activityRow(h, owner.accountKey)?.hits).toBe(1)

    // Still inside the ~60s throttle window: no second write.
    now = new Date('2026-09-26T18:00:30Z')
    await h.request('/api/session', { cookie })
    expect(activityRow(h, owner.accountKey)?.hits).toBe(1)

    // Past the throttle window: hits increments and last_at moves.
    now = new Date('2026-09-26T18:05:00Z')
    await h.request('/api/session', { cookie })
    const row = activityRow(h, owner.accountKey)
    expect(row?.hits).toBe(2)
    expect(row?.last_at).toBe(now.toISOString())
  })

  test('creating the account counts as activity that day', async () => {
    const h = harness()
    const { owner } = await onboard(h)
    expect(activityRow(h, owner.accountKey)).toMatchObject({ day: '2026-09-26', hits: 1 })
  })

  test('the first call after UTC midnight writes the new day inside the throttle window', async () => {
    let now = new Date('2026-09-26T23:59:40Z')
    const h = harness(() => now)
    const { cookie, owner } = await onboard(h)
    now = new Date('2026-09-27T00:00:10Z')
    await h.request('/api/session', { cookie })
    const days = (h.db.raw.query('SELECT day FROM account_activity WHERE account_key = ? ORDER BY day').all(owner.accountKey) as { day: string }[]).map((r) => r.day)
    expect(days).toEqual(['2026-09-26', '2026-09-27'])
  })

  test('an activity write failure does not break the response', async () => {
    const h = harness()
    const { cookie, owner } = await onboard(h)
    h.env.DB = failingActivityDb(h.db)

    const res = await h.request('/api/session', { cookie })
    expect(res.status).toBe(200)
    expect(((await res.json()) as SessionView).accountKey).toBe(owner.accountKey)
  })
})
