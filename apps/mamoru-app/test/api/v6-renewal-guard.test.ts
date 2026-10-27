import { describe, expect, test } from 'bun:test'
import type { SleeveView } from '@mamoru/domain'
import { resetOperatorHealth } from '../../src/api/sleeves.ts'
import { harness, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#214: a renewal that moves a Base account to conservador-live-v6 (growth on the Monad sleeve) is refused
// until the owner's Monad sleeve exists and its operator reports it active.

const BETA = 'https://beta.mamoru.lol'
const BASE_OP = 'https://operator.test'
const MONAD_OP = 'https://operator-monad.test'
const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'

type Plan = { baseApproval: unknown; sleeveActive: boolean | 'down' | 'bad-status' }

/** Both operators: health, the Base account's funding view (with the approval the test sets) and the sleeve's. */
async function world(plan: Plan, flags: { v6: boolean } = { v6: true }) {
  resetOperatorHealth()
  const calls: string[] = []
  const operatorFetch = async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/health')) return json({ ok: true, chainId: url.startsWith(MONAD_OP) ? 143 : 8453 })
    if (url.startsWith(MONAD_OP) && url.endsWith('/funding')) {
      if (plan.sleeveActive === 'down') throw new Error('connect refused')
      if (plan.sleeveActive === 'bad-status') return json({ error: 'x' }, 500)
      return json({ active: plan.sleeveActive })
    }
    if (url.startsWith(BASE_OP) && url.endsWith('/funding')) return json({ active: true, approval: plan.baseApproval })
    return json({ ok: true, forwarded: true })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: BASE_OP, OPERATOR_URL_143: `${MONAD_OP}/`, OPERATOR_SECRET }, operatorFetch })
  const flag = (name: string, on: 0 | 1) => h.db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES (?, ?, 'ot', 'test', '2026-10-27T00:00:00Z')`).run(name, on)
  flag('monad_sleeves', 1)
  if (flags.v6) flag('multichain_v6', 1)
  const res = await register(h, PASSKEY_A)
  const cookie = sessionCookie(res)
  const base = (await res.json()) as { accountKey: string }
  const post = (path: string, body: unknown = {}) => h.app.request(`${BETA}${path}`, { method: 'POST', headers: { cookie, origin: BETA, 'content-type': 'application/json' }, body: JSON.stringify(body) }, h.env)
  const openSleeve = async () => ((await (await post('/api/sleeves', { chainId: 143 })).json()) as SleeveView)
  const forwarded = (suffix: string) => calls.filter((c) => c.startsWith('POST') && c.endsWith(suffix))
  return { h, post, base, openSleeve, calls, forwarded }
}

const V6_MOVE = { validUntil: 2_000_000_000, renewDue: false, expired: false, upgrade: true, upgradePolicy: 'conservador-live-v6', policyId: 'conservador-live-v5' }
const ROUTES = ['renew/prepare', 'renew'] as const

describe('v6 renewal needs a running Monad sleeve', () => {
  for (const route of ROUTES) {
    test(`${route}: no Monad sleeve -> 409 SLEEVE_NOT_ACTIVE, nothing forwarded`, async () => {
      const t = await world({ baseApproval: V6_MOVE, sleeveActive: true })
      const res = await t.post(`/api/accounts/${t.base.accountKey}/${route}`)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('SLEEVE_NOT_ACTIVE')
      expect(t.forwarded(`/${route}`)).toEqual([])
    })

    test(`${route}: the sleeve exists but its operator says it is not active -> 409`, async () => {
      const t = await world({ baseApproval: V6_MOVE, sleeveActive: false })
      await t.openSleeve()
      const res = await t.post(`/api/accounts/${t.base.accountKey}/${route}`)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('SLEEVE_NOT_ACTIVE')
      expect(t.forwarded(`/${route}`)).toEqual([])
    })

    test(`${route}: the sleeve is active -> forwarded to the Base operator`, async () => {
      const t = await world({ baseApproval: V6_MOVE, sleeveActive: true })
      await t.openSleeve()
      const res = await t.post(`/api/accounts/${t.base.accountKey}/${route}`)
      expect(res.status).toBe(200)
      expect(t.forwarded(`/${route}`)).toHaveLength(1)
    })
  }

  test('an account already on v6 (no upgrade offered) is guarded the same way', async () => {
    const t = await world({ baseApproval: { ...V6_MOVE, upgrade: undefined, upgradePolicy: undefined, policyId: 'conservador-live-v6' }, sleeveActive: false })
    await t.openSleeve()
    expect((await t.post(`/api/accounts/${t.base.accountKey}/renew/prepare`)).status).toBe(409)
  })

  test('the sleeve operator unreachable or failing is 503 OPERATOR_UNAVAILABLE, not "not active"; nothing forwarded', async () => {
    for (const sleeveActive of ['down', 'bad-status'] as const) {
      const t = await world({ baseApproval: V6_MOVE, sleeveActive })
      await t.openSleeve()
      const res = await t.post(`/api/accounts/${t.base.accountKey}/renew/prepare`)
      expect(res.status).toBe(503)
      expect(((await res.json()) as { code: string }).code).toBe('OPERATOR_UNAVAILABLE')
      expect(t.forwarded('/renew/prepare')).toEqual([])
    }
  })

  test('a renewal that does not move to v6 is not touched: no sleeve needed', async () => {
    for (const baseApproval of [{ ...V6_MOVE, upgradePolicy: 'conservador-live-v5' }, { validUntil: 1, renewDue: true, expired: false, policyId: 'conservador-live-v5' }, null]) {
      const t = await world({ baseApproval, sleeveActive: false })
      expect((await t.post(`/api/accounts/${t.base.accountKey}/renew/prepare`)).status).toBe(200)
    }
  })

  test('review of PR #141 (P1 1): multichain_v6 off in D1 but the operator still offers v6 (stale pull) -> still 409', async () => {
    const t = await world({ baseApproval: V6_MOVE, sleeveActive: false }, { v6: false })
    const res = await t.post(`/api/accounts/${t.base.accountKey}/renew/prepare`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('SLEEVE_NOT_ACTIVE')
    expect(t.forwarded('/renew/prepare')).toEqual([])
  })

  test('review of PR #141 (P1 1): an account already on v6 with the flag off is still guarded', async () => {
    const t = await world({ baseApproval: { ...V6_MOVE, upgrade: undefined, upgradePolicy: undefined, policyId: 'conservador-live-v6' }, sleeveActive: false }, { v6: false })
    expect((await t.post(`/api/accounts/${t.base.accountKey}/renew`)).status).toBe(409)
    expect(t.forwarded('/renew')).toEqual([])
  })

  test('multichain_v6 off and a v5 renewal: one funding read, then forwarded as before', async () => {
    const t = await world({ baseApproval: { validUntil: 1, renewDue: true, expired: false, policyId: 'conservador-live-v5' }, sleeveActive: false }, { v6: false })
    expect((await t.post(`/api/accounts/${t.base.accountKey}/renew/prepare`)).status).toBe(200)
    expect(t.calls.filter((c) => c.endsWith('/funding'))).toHaveLength(1)
  })

  test('review of PR #141: the fork twin conservador-lab-v6 is guarded too', async () => {
    const t = await world({ baseApproval: { ...V6_MOVE, upgradePolicy: 'conservador-lab-v6' }, sleeveActive: false })
    expect((await t.post(`/api/accounts/${t.base.accountKey}/renew/prepare`)).status).toBe(409)
  })

  test('review of PR #141: a Monad sleeve at another address than the Base Safe (where bridge-out mints) -> 409', async () => {
    const t = await world({ baseApproval: V6_MOVE, sleeveActive: true })
    await t.openSleeve()
    t.h.db.raw.query(`UPDATE accounts SET address = ? WHERE chain_id = 143`).run(`0x${'99'.repeat(20)}`)
    const res = await t.post(`/api/accounts/${t.base.accountKey}/renew/prepare`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('SLEEVE_NOT_ACTIVE')
    expect(t.forwarded('/renew/prepare')).toEqual([])
  })

  test('other owner routes (stop, transfer) never ask', async () => {
    const t = await world({ baseApproval: V6_MOVE, sleeveActive: false })
    expect((await t.post(`/api/accounts/${t.base.accountKey}/stop/prepare`)).status).toBe(200)
    expect(t.calls.filter((c) => c.endsWith('/funding'))).toEqual([])
  })
})
