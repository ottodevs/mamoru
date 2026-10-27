import { describe, expect, test } from 'bun:test'
import type { OwnerResponse, YieldLedgerView } from '@mamoru/domain'
import { harness, register, PASSKEY_A, PASSKEY_B, sessionCookie } from './helpers.ts'

const EMPTY: YieldLedgerView = { asOf: null, accruedUsd: null, collectedUsd: null, earnedSoFarUsd: null, gasPaidWei: null, valueVsHoldUsd: null, feeAccruedUsd: null, lastBalance: null }

async function onboard(h: ReturnType<typeof harness>, passkey = PASSKEY_A) {
  const res = await register(h, passkey)
  return { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
}

describe('GET /api/accounts/:accountKey/yield (otto/mamoru#129)', () => {
  test('401 without a session', async () => {
    const h = harness()
    const { owner } = await onboard(h)
    expect((await h.request(`/api/accounts/${owner.accountKey}/yield`)).status).toBe(401)
  })

  test('404 for an unknown account key, and for another user\'s account', async () => {
    const h = harness()
    const a = await onboard(h, PASSKEY_A)
    const b = await onboard(h, PASSKEY_B)
    expect((await h.request(`/api/accounts/not-a-key/yield`, { cookie: a.cookie })).status).toBe(404)
    expect((await h.request(`/api/accounts/${a.owner.accountKey}/yield`, { cookie: b.cookie })).status).toBe(404)
  })

  test('every field is null before the cron has pulled anything, and matches the dashboard payload\'s yield field exactly', async () => {
    const h = harness()
    const { cookie, owner } = await onboard(h)
    const res = await h.request(`/api/accounts/${owner.accountKey}/yield`, { cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(EMPTY)

    const dash = await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie })
    const payload = (await dash.json()) as { yield?: YieldLedgerView }
    expect(payload.yield).toEqual(EMPTY)
  })
})
