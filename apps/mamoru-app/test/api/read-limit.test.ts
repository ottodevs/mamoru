import { describe, expect, test } from 'bun:test'
import type { OwnerResponse } from '@mamoru/domain'
import { harness, register, sessionCookie, PASSKEY_A } from './helpers.ts'

type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> }

async function onboard(h: ReturnType<typeof harness>) {
  const res = await register(h, PASSKEY_A)
  return { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
}

describe('account reads limit (#255)', () => {
  test('a read over the limit is 429 with Retry-After; under it the route answers; the key is the account and a hashed address', async () => {
    const keys: string[] = []
    let left = 1
    const limiter: Limiter = { limit: async ({ key }) => (keys.push(key), { success: left-- > 0 }) }
    const h = harness(undefined, { env: { ACCOUNT_READ_LIMIT: limiter } })
    const { cookie, owner } = await onboard(h)
    const headers = { 'cf-connecting-ip': '203.0.113.7' }

    expect((await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie, headers })).status).toBe(200)
    const res = await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie, headers })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(((await res.json()) as { code: string }).code).toBe('READ_RATE_LIMITED')
    expect(keys).toHaveLength(2)
    expect(keys[0]).toStartWith(`${owner.accountKey}:`)
    expect(keys[0]).not.toContain('203.0.113.7')
    expect(keys[0]).toBe(keys[1]!)
  })

  test('another address has its own count', async () => {
    const keys: string[] = []
    const h = harness(undefined, { env: { ACCOUNT_READ_LIMIT: { limit: async ({ key }) => (keys.push(key), { success: true }) } } })
    const { cookie, owner } = await onboard(h)
    await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie, headers: { 'cf-connecting-ip': '203.0.113.7' } })
    await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie, headers: { 'cf-connecting-ip': '198.51.100.9' } })
    expect(keys[0]).not.toBe(keys[1]!)
  })

  test('owner actions (POST) are never counted or refused', async () => {
    let asked = 0
    const h = harness(undefined, { env: { ACCOUNT_READ_LIMIT: { limit: async () => (asked++, { success: false }) } } })
    const { cookie, owner } = await onboard(h)
    const res = await h.post(`/api/accounts/${owner.accountKey}/stop/prepare`, {}, { cookie })
    expect(res.status).not.toBe(429)
    expect(asked).toBe(0)
  })

  test('a limiter that does not answer lets the read through', async () => {
    const h = harness(undefined, { env: { ACCOUNT_READ_LIMIT: { limit: async () => Promise.reject(new Error('down')) } } })
    const { cookie, owner } = await onboard(h)
    expect((await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie })).status).toBe(200)
  })
})
