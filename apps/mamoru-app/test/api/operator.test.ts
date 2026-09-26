import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { AccountContext, AppConfig, OwnerResponse } from '@mamoru/domain'
import { harness, ORIGIN, PASSKEY_A, PASSKEY_B, sessionCookie } from './helpers.ts'

const OPERATOR_URL = 'https://operator.test'
const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const LIVE = { LIVE_FUNDS: '1', OPERATOR_URL, OPERATOR_SECRET }

type Seen = { url: string; method: string; headers: Headers; body: string }

function fakeOperator(reply: (s: Seen) => Response = () => Response.json({ ok: true }, { status: 200 })) {
  const seen: Seen[] = []
  const fetch = async (input: string, init: RequestInit) => {
    const s: Seen = { url: input, method: init.method ?? 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : '' }
    seen.push(s)
    return reply(s)
  }
  return { seen, fetch }
}

async function onboard(h: ReturnType<typeof harness>, passkey = PASSKEY_A) {
  const res = await h.post('/api/onboarding/owner', { passkey })
  return { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
}

const hmac = (method: string, path: string, header: string, body: string) =>
  createHmac('sha256', OPERATOR_SECRET).update(`${method} ${path}\n${header}\n${body}`).digest('hex')

describe('live config', () => {
  test('LIVE_FUNDS=1 with an operator opens the gate with the 25 USDC cap', async () => {
    const h = harness(undefined, { env: LIVE })
    const c = (await (await h.request('/api/config')).json()) as AppConfig
    expect(c).toMatchObject({ fundsGate: 'live', dryRun: false, capUsdc: '25000000' })
  })
  test('without an operator URL the config stays closed', async () => {
    const h = harness(undefined, { env: { LIVE_FUNDS: '1' } })
    const c = (await (await h.request('/api/config')).json()) as AppConfig
    expect(c).toMatchObject({ fundsGate: 'closed', dryRun: true })
    expect(c.capUsdc).toBeUndefined()
  })
})

describe('operator proxy', () => {
  test('unauthenticated -> 401 and nothing forwarded', async () => {
    const op = fakeOperator()
    const h = harness(undefined, { env: LIVE, operatorFetch: op.fetch })
    const { owner } = await onboard(h)
    expect((await h.request(`/api/accounts/${owner.accountKey}/funding`)).status).toBe(401)
    expect((await h.post(`/api/accounts/${owner.accountKey}/activate/prepare`, {})).status).toBe(401)
    expect(op.seen).toHaveLength(0)
  })

  test("another user's account -> 404, nothing forwarded", async () => {
    const op = fakeOperator()
    const h = harness(undefined, { env: LIVE, operatorFetch: op.fetch })
    const a = await onboard(h, PASSKEY_A)
    const b = await onboard(h, PASSKEY_B)
    expect((await h.request(`/api/accounts/${a.owner.accountKey}/funding`, { cookie: b.cookie })).status).toBe(404)
    expect((await h.post(`/api/accounts/${a.owner.accountKey}/stop`, {}, { cookie: b.cookie })).status).toBe(404)
    expect(op.seen).toHaveLength(0)
  })

  test('POST without the app origin -> 403', async () => {
    const op = fakeOperator()
    const h = harness(undefined, { env: LIVE, operatorFetch: op.fetch })
    const { cookie, owner } = await onboard(h)
    const res = await h.post(`/api/accounts/${owner.accountKey}/transfer/prepare`, {}, { cookie, origin: 'https://evil.test' })
    expect(res.status).toBe(403)
    expect(op.seen).toHaveLength(0)
  })

  test('GET forwards path+search with the account context and a correct HMAC; status and JSON pass through', async () => {
    const op = fakeOperator(() => Response.json({ ops: [] }, { status: 202 }))
    const h = harness(undefined, { env: LIVE, operatorFetch: op.fetch })
    const { cookie, owner } = await onboard(h)
    const path = `/api/accounts/${owner.accountKey}/ops?after=op-1`
    const res = await h.request(path, { cookie })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ops: [] })

    const [s] = op.seen
    expect(s!.url).toBe(OPERATOR_URL + path)
    expect(s!.method).toBe('GET')
    const header = s!.headers.get('x-mamoru-account')!
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/)
    const ctx = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as AccountContext
    expect(ctx).toMatchObject({ accountKey: owner.accountKey, chainId: 8453, address: owner.address, owners: owner.owners, passkey: PASSKEY_A })
    expect(ctx.saltNonce).toMatch(/^\d+$/)
    expect(s!.headers.get('x-mamoru-sig')).toBe(hmac('GET', path, header, ''))
  })

  test('POST forwards the raw body and signs it', async () => {
    const op = fakeOperator((s) => Response.json({ echoed: JSON.parse(s.body) }))
    const h = harness(undefined, { env: LIVE, operatorFetch: op.fetch })
    const { cookie, owner } = await onboard(h)
    const path = `/api/accounts/${owner.accountKey}/transfer/prepare`
    const raw = '{"to":"0x0000000000000000000000000000000000000001","amountUsdc":"1000000"}'
    const res = await h.request(path, { method: 'POST', body: raw, cookie, headers: { 'content-type': 'application/json', origin: ORIGIN } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { echoed: unknown }).echoed).toEqual(JSON.parse(raw))
    const s = op.seen[0]!
    expect(s.body).toBe(raw)
    expect(s.headers.get('x-mamoru-sig')).toBe(hmac('POST', path, s.headers.get('x-mamoru-account')!, raw))
  })

  test('every live route is forwarded', async () => {
    const op = fakeOperator()
    const h = harness(undefined, { env: LIVE, operatorFetch: op.fetch })
    const { cookie, owner } = await onboard(h)
    const k = owner.accountKey
    for (const p of ['activate/prepare', 'activate', 'transfer/prepare', 'transfer', 'stop/prepare', 'stop']) {
      expect((await h.post(`/api/accounts/${k}/${p}`, {}, { cookie })).status).toBe(200)
    }
    expect((await h.request(`/api/accounts/${k}/funding`, { cookie })).status).toBe(200)
    expect(op.seen.map((s) => new URL(s.url).pathname.split('/').slice(4).join('/'))).toEqual([
      'activate/prepare', 'activate', 'transfer/prepare', 'transfer', 'stop/prepare', 'stop', 'funding',
    ])
  })

  test('body over 8KB -> 413, nothing forwarded', async () => {
    const op = fakeOperator()
    const h = harness(undefined, { env: LIVE, operatorFetch: op.fetch })
    const { cookie, owner } = await onboard(h)
    const res = await h.post(`/api/accounts/${owner.accountKey}/activate`, { pad: 'x'.repeat(9000) }, { cookie })
    expect(res.status).toBe(413)
    expect(op.seen).toHaveLength(0)
  })

  test('operator down -> 503 OPERATOR_UNAVAILABLE', async () => {
    const h = harness(undefined, { env: LIVE, operatorFetch: async () => { throw new TypeError('connect ECONNREFUSED') } })
    const { cookie, owner } = await onboard(h)
    const res = await h.request(`/api/accounts/${owner.accountKey}/funding`, { cookie })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })
  })

  test('live funds off -> 503, nothing forwarded', async () => {
    const op = fakeOperator()
    const h = harness(undefined, { operatorFetch: op.fetch })
    const { cookie, owner } = await onboard(h)
    expect((await h.request(`/api/accounts/${owner.accountKey}/funding`, { cookie })).status).toBe(503)
    expect(op.seen).toHaveLength(0)
  })
})
