import { describe, expect, test } from 'bun:test'
import type { MigrateV4Input } from '@mamoru/domain'
import { buildMigrateV4 } from '@mamoru/account/one-auth'
import { registryFor } from '@mamoru/registry'
import type { AccountRow } from '../../src/api/accounts/store.ts'
import { harness, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#311 (#295, #333): the Worker rebuilds every one-authorization Safe tx with buildMigrateV4 before the
// owner is asked to sign it, and forwards the Ethereum sibling's routes.

const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const ZERO = '0x0000000000000000000000000000000000000000' as const
const KEY = '0x000000000000000000000000000000000000dEaD' as const

const home = (b: AccountRow): MigrateV4Input => ({ chainId: 8453, safe: b.address as `0x${string}`, safeNonce: '0', step: 0, capUsdc: '1000000000', sessionKey: KEY, generation: '1', admit: [], oldPermissionIds: [], removeIds: [], noncesBefore: [], home: ZERO, homeDomain: 0 })
const sibling = (b: AccountRow): MigrateV4Input => ({ ...home(b), chainId: 1, step: 1, home: b.address as `0x${string}`, homeDomain: 6 })
const offer = (input: MigrateV4Input, tamper: Partial<{ safeTxHash: string }> = {}) => {
  const built = buildMigrateV4(input, registryFor(input.chainId))
  return { safe: input.safe, chainId: input.chainId, safeTxHash: tamper.safeTxHash ?? built.safeTxHash, summary: [], expiresAt: 'x', prepareId: 'p1', input }
}

async function world(prepare: (b: AccountRow) => unknown) {
  let base!: AccountRow
  const seen: string[] = []
  const operatorFetch = async (url: string, init: RequestInit) => {
    seen.push(`${init.method} ${new URL(url).pathname}`)
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (init.method === 'POST' && url.endsWith('/prepare')) return json(prepare(base))
    return json({ state: 'none' })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET }, operatorFetch })
  const res = await register(h, PASSKEY_A)
  const cookie = sessionCookie(res)
  const { accountKey } = (await res.json()) as { accountKey: string }
  base = h.db.raw.query('SELECT * FROM accounts WHERE account_key = ?').get(accountKey) as AccountRow
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('cookie', cookie)
    if (init.method === 'POST') {
      headers.set('origin', 'https://app.mamoru.lol')
      headers.set('content-type', 'application/json')
    }
    return h.app.request(`https://app.mamoru.lol/api/accounts/${accountKey}${path}`, { ...init, headers }, h.env)
  }
  return { call, seen, base: () => base }
}

describe('one-authorization prepares are rebuilt by the Worker (#311)', () => {
  for (const route of ['activate', 'migrate-v4']) {
    test(`${route}/prepare: the builder's tx for this account passes untouched`, async () => {
      const t = await world((b) => offer(home(b)))
      const res = await t.call(`/${route}/prepare`, { method: 'POST', body: '{}' })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { prepareId: string }).prepareId).toBe('p1')
    })

    test(`${route}/prepare: a hash that is not the builder's is refused, nothing to sign`, async () => {
      const t = await world((b) => offer(home(b), { safeTxHash: `0x${'12'.repeat(32)}` }))
      const res = await t.call(`/${route}/prepare`, { method: 'POST', body: '{}' })
      expect(res.status).toBe(502)
      expect(((await res.json()) as { code: string }).code).toBe('BUILD_MISMATCH')
    })

    test(`${route}/prepare: another Safe than this account is refused`, async () => {
      const t = await world((b) => offer({ ...home(b), safe: '0x00000000000000000000000000000000000b0b00' }))
      expect((await t.call(`/${route}/prepare`, { method: 'POST', body: '{}' })).status).toBe(502)
    })
  }

  test('migrate-v4/prepare step 1 through the Base account: a Safe on Monad its keys do not give is refused', async () => {
    const t = await world((b) => offer({ ...home(b), chainId: 143, step: 1, safe: '0x00000000000000000000000000000000000b0b00', home: b.address as `0x${string}`, homeDomain: 6 }))
    const res = await t.call('/migrate-v4/prepare', { method: 'POST', body: '{"step":1}' })
    expect(res.status).toBe(502)
  })

  test('activate/prepare without input (an old activation) passes as before', async () => {
    const t = await world(() => ({ safe: '0x1', chainId: 8453, safeTxHash: '0x2', summary: [], expiresAt: 'x', prepareId: 'p1' }))
    expect((await t.call('/activate/prepare', { method: 'POST', body: '{}' })).status).toBe(200)
  })

  test('ethereum-sibling: forwarded (prepare, submit, status); its Safe and home must be this account on Ethereum', async () => {
    const good = await world((b) => {
      const o = offer(sibling(b))
      return { ...o, built: { input: o.input, safeTxHash: o.safeTxHash } }
    })
    expect((await good.call('/ethereum-sibling/prepare', { method: 'POST', body: '{}' })).status).toBe(200)
    expect((await good.call('/ethereum-sibling', { method: 'POST', body: '{}' })).status).toBe(200)
    expect((await good.call('/ethereum-sibling')).status).toBe(200)
    expect(good.seen.filter((s) => s.includes('ethereum-sibling')).length).toBe(3)
    const otherHome = await world((b) => {
      const o = offer({ ...sibling(b), home: '0x00000000000000000000000000000000000b0b00' })
      return { ...o, built: { input: o.input, safeTxHash: o.safeTxHash } }
    })
    expect((await otherHome.call('/ethereum-sibling/prepare', { method: 'POST', body: '{}' })).status).toBe(502)
    const noInput = await world(() => ({ safe: '0x1', chainId: 1, safeTxHash: '0x2', prepareId: 'p1' }))
    expect((await noInput.call('/ethereum-sibling/prepare', { method: 'POST', body: '{}' })).status).toBe(502)
  })
})
