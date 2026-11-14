import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { MigrateV4Input } from '@mamoru/domain'
import { buildMigrateV4 } from '@mamoru/account/one-auth'
import { baseRegistry, ethereumRegistry, monadRegistry, registryFor } from '@mamoru/registry'
import { pinTestA1 } from '../../../../packages/account/one-auth/pin-fixture.ts'
import type { RemoteSpec } from '@mamoru/domain'
import { liveWmonUsdcMonadV6 } from '@mamoru/policy'
import { remoteInput, remoteSafe } from '@mamoru/account/remote'
import { withPinnedV3 } from '../../../../packages/account/remote/fixture.ts'
import { accountContext } from '../../src/api/accounts/operator.ts'
import { upsertRemoteSleeve } from '../../src/api/remote.ts'
import type { AccountRow } from '../../src/api/accounts/store.ts'
import { harness, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#311 (#295, #333): the Worker rebuilds every one-authorization Safe tx with buildMigrateV4 before the
// owner is asked to sign it, and forwards the Ethereum sibling's routes.

const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const ZERO = '0x0000000000000000000000000000000000000000' as const
const KEY = '0x000000000000000000000000000000000000dEaD' as const

// #356: step 0 pins the one remote its session may register; a remote's step names none.
const homeOf = (b: AccountRow): MigrateV4Input => ({ chainId: 8453, safe: b.address as `0x${string}`, safeNonce: '0', step: 0, capUsdc: '1000000000', sessionKey: KEY, generation: '1', admit: [], oldPermissionIds: [], removeIds: [], noncesBefore: [], home: ZERO, homeDomain: 0 })
const home = (b: AccountRow): MigrateV4Input => ({ ...homeOf(b), remote: { domain: 15, sessionKey: '0x000000000000000000000000000000000000f00d' } })
const sibling = (b: AccountRow): MigrateV4Input => ({ ...homeOf(b), chainId: 1, step: 1, home: b.address as `0x${string}`, homeDomain: 6 })
const offer = (input: MigrateV4Input, tamper: Partial<{ safeTxHash: string }> = {}) => {
  const built = buildMigrateV4(input, registryFor(input.chainId))
  return { safe: input.safe, chainId: input.chainId, safeTxHash: tamper.safeTxHash ?? built.safeTxHash, summary: [], expiresAt: 'x', prepareId: 'p1', input }
}

const SPEC: RemoteSpec = { chainId: 143, policyId: liveWmonUsdcMonadV6.policyId, sessionKey: KEY, validAfter: 1_790_000_000, validUntil: 1_821_536_000, capUsdc: '1000000000' }

async function world(prepare: (b: AccountRow) => unknown, opts: { sleeve?: boolean } = {}) {
  let base!: AccountRow
  const seen: string[] = []
  const operatorFetch = async (url: string, init: RequestInit) => {
    seen.push(`${init.method} ${new URL(url).pathname}`)
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (init.method === 'POST' && url.endsWith('/prepare')) {
      const out = prepare(base)
      return out instanceof Response ? out : json(out)
    }
    return json({ state: 'none' })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET }, operatorFetch, remoteRegistry: () => withPinnedV3() })
  const res = await register(h, PASSKEY_A)
  const cookie = sessionCookie(res)
  const { accountKey } = (await res.json()) as { accountKey: string }
  base = h.db.raw.query('SELECT * FROM accounts WHERE account_key = ?').get(accountKey) as AccountRow
  if (opts.sleeve) await upsertRemoteSleeve(h.db, base, { chainId: 143, address: remoteSafe(remoteInput(accountContext(base), SPEC, withPinnedV3())).address as `0x${string}`, spec: SPEC }, new Date())
  const sleeveAddress = () => (h.db.raw.query('SELECT address FROM accounts WHERE chain_id = 143').get() as { address: `0x${string}` } | null)?.address
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('cookie', cookie)
    if (init.method === 'POST') {
      headers.set('origin', 'https://app.mamoru.lol')
      headers.set('content-type', 'application/json')
    }
    return h.app.request(`https://app.mamoru.lol/api/accounts/${accountKey}${path}`, { ...init, headers }, h.env)
  }
  return { call, seen, base: () => base, sleeveAddress }
}

describe('#348: an operator without V4 pinned on Ethereum', () => {
  test("ethereum-sibling: the operator's 404 SIBLING_NOT_OFFERED reaches the app as is (#243: the UI falls back to plain Start)", async () => {
    const t = await world(() => new Response(JSON.stringify({ error: 'Mamoru on Ethereum is not available for this account yet', code: 'SIBLING_NOT_OFFERED' }), { status: 404, headers: { 'content-type': 'application/json' } }))
    const res = await t.call('/ethereum-sibling/prepare', { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('SIBLING_NOT_OFFERED')
  })

  test('a one-authorization prepare cannot be rebuilt, so it is refused (BUILD_MISMATCH), nothing to sign', async () => {
    const input = (b: AccountRow) => ({ safe: b.address, chainId: 8453, safeTxHash: `0x${'12'.repeat(32)}`, summary: [], expiresAt: 'x', prepareId: 'p1', input: home(b) })
    const t = await world(input)
    const res = await t.call('/migrate-v4/prepare', { method: 'POST', body: '{}' })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('BUILD_MISMATCH')
  })
})

describe('one-authorization prepares are rebuilt by the Worker (#311)', () => {
  // #348: a test A1 stack pinned in memory on the three chains, over T8's pins in the registry files.
  const unpin: (() => void)[] = []
  beforeAll(() => unpin.push(...[baseRegistry, monadRegistry, ethereumRegistry].map(pinTestA1)))
  afterAll(() => unpin.splice(0).forEach((u) => u()))
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
    const t = await world((b) => offer({ ...homeOf(b), chainId: 143, step: 1, safe: '0x00000000000000000000000000000000000b0b00', home: b.address as `0x${string}`, homeDomain: 6 }))
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

  test('review r1 of #239: migrate-v4/prepare without the builder input is refused', async () => {
    const t = await world(() => ({ safe: '0x1', chainId: 8453, safeTxHash: '0x2', summary: [], expiresAt: 'x', prepareId: 'p1' }))
    expect((await t.call('/migrate-v4/prepare', { method: 'POST', body: '{}' })).status).toBe(502)
  })

  test("review r1 of #239: step 1 through the Base account on its stored Monad Safe passes; funds moved to an unverified address do not", async () => {
    let moveTo: `0x${string}` | undefined
    let sleeve: () => `0x${string}` | undefined = () => undefined
    const step1 = (b: AccountRow): MigrateV4Input => ({ ...homeOf(b), chainId: 143, step: 1, safe: sleeve()!, home: b.address as `0x${string}`, homeDomain: 6, ...(moveTo ? { moveTo, transfers: [{ token: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', amount: '1' }] } : {}) })
    const t = await world((b) => offer(step1(b)), { sleeve: true })
    sleeve = t.sleeveAddress
    expect(sleeve()).toBeDefined()
    expect((await t.call('/migrate-v4/prepare', { method: 'POST', body: '{"step":1}' })).status).toBe(200)
    moveTo = '0x00000000000000000000000000000000000b0b00'
    expect((await t.call('/migrate-v4/prepare', { method: 'POST', body: '{"step":1}' })).status).toBe(502)
  })
})

