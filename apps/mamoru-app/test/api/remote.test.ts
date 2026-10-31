import { describe, expect, spyOn, test } from 'bun:test'
import type { AccountContext, RemoteSpec } from '@mamoru/domain'
import { liveWmonUsdcMonadV6 } from '@mamoru/policy'
import { remoteInput, remoteSafe } from '@mamoru/account/remote'
import { withPinnedV3 } from '../../../../packages/account/remote/fixture.ts'
import { accountContext } from '../../src/api/accounts/operator.ts'
import { ownersOf, type AccountRow } from '../../src/api/accounts/store.ts'
import { upsertRemoteSleeve, type RemoteOffer } from '../../src/api/remote.ts'
import { harness, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#251: the Worker rebuilds the account's remote Safe from its own D1 row before the owner signs a prepare,
// and records it as the owner's Monad row when the Base operator reports it in the funding read.

const BASE_OP = 'https://operator.test'
const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const registry = () => withPinnedV3()
const SPEC: RemoteSpec = { chainId: 143, policyId: liveWmonUsdcMonadV6.policyId, sessionKey: '0x000000000000000000000000000000000000dEaD', validAfter: 1_790_000_000, validUntil: 1_821_536_000, capUsdc: '1500000000' }

function offerFor(row: AccountRow, spec: RemoteSpec = SPEC): RemoteOffer {
  const ctx = accountContext(row)
  return { chainId: spec.chainId, address: remoteSafe(remoteInput(ctx, spec, registry())).address as RemoteOffer['address'], spec }
}

type Plan = { prepare?: (base: AccountRow) => unknown; funding?: (base: AccountRow) => unknown }

async function world(plan: Plan = {}) {
  let base!: AccountRow
  const operatorFetch = async (url: string, init: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/funding')) return json(plan.funding?.(base) ?? { active: true })
    if (init.method === 'POST' && url.endsWith('/prepare')) return json(plan.prepare?.(base) ?? { prepareId: 'p1' })
    return json({ ok: true })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: BASE_OP, OPERATOR_SECRET }, operatorFetch, remoteRegistry: registry })
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
  const sleeves = () => h.db.raw.query('SELECT * FROM accounts WHERE chain_id = 143').all() as AccountRow[]
  return { h, base, call, sleeves }
}

const ownerTx = (remote: unknown) => ({ safe: '0x1', chainId: 8453, safeTxHash: '0x2', summary: [], expiresAt: 'x', prepareId: 'p1', remote })

describe('prepare: the remote Safe is rebuilt from the Base keys before it is passed on', () => {
  for (const route of ['activate', 'renew']) {
    test(`${route}/prepare: the Safe these keys give is passed on untouched`, async () => {
      const t = await world({ prepare: (b) => ownerTx(offerFor(b)) })
      const res = await t.call(`/${route}/prepare`, { method: 'POST', body: '{}' })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { remote: RemoteOffer }).remote.address).toBe(offerFor(t.base).address)
    })

    test(`${route}/prepare: another address is a 502 REMOTE_SAFE_MISMATCH and the body is not returned`, async () => {
      const err = spyOn(console, 'error').mockImplementation(() => {})
      const t = await world({ prepare: (b) => ownerTx({ ...offerFor(b), address: `0x${'11'.repeat(20)}` }) })
      const res = await t.call(`/${route}/prepare`, { method: 'POST', body: '{}' })
      expect(res.status).toBe(502)
      const body = (await res.json()) as { code: string; prepareId?: string }
      expect(body.code).toBe('REMOTE_SAFE_MISMATCH')
      expect(body.prepareId).toBeUndefined()
      expect(err).toHaveBeenCalled()
      err.mockRestore()
    })
  }

  test('a session key or cap other than the one the address was built from is refused', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    const t = await world({ prepare: (b) => ownerTx({ ...offerFor(b), spec: { ...SPEC, capUsdc: '9999999999' } }) })
    expect((await t.call('/renew/prepare', { method: 'POST', body: '{}' })).status).toBe(502)
    err.mockRestore()
  })

  test('a chain the Worker does not know is refused, whatever the address', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    const t = await world({ prepare: (b) => ownerTx({ ...offerFor(b), chainId: 10, spec: { ...SPEC, chainId: 10 } }) })
    const res = await t.call('/activate/prepare', { method: 'POST', body: '{}' })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('REMOTE_SAFE_MISMATCH')
    err.mockRestore()
  })

  test('an offer whose chainId and spec chain disagree, or a malformed one, is refused', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    for (const remote of [(b: AccountRow) => ({ ...offerFor(b), chainId: 8453 }), () => ({ chainId: 143 }), () => 'x']) {
      const t = await world({ prepare: (b) => ownerTx(remote(b)) })
      expect((await t.call('/activate/prepare', { method: 'POST', body: '{}' })).status).toBe(502)
    }
    err.mockRestore()
  })

  test('the owner tx nested under ownerTx (a plan) is checked too', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    const t = await world({ prepare: (b) => ({ reduce: [], ownerTx: ownerTx({ ...offerFor(b), address: `0x${'22'.repeat(20)}` }) }) })
    expect((await t.call('/transfer/prepare', { method: 'POST', body: '{}' })).status).toBe(502)
    err.mockRestore()
  })

  test('a prepare without a remote is passed on as before', async () => {
    const t = await world()
    const res = await t.call('/activate/prepare', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ prepareId: 'p1' })
  })
})

describe('funding: the remote Safe the Base operator reports becomes the owner’s Monad row', () => {
  const funding = (b: AccountRow, ready = true) => ({ active: true, remote: { ...offerFor(b), ready } })

  test('inserted from the Base row, idempotent, and its context carries the remote spec', async () => {
    const t = await world({ funding: (b) => funding(b) })
    expect((await t.call('/funding')).status).toBe(200)
    const [row] = t.sleeves()
    expect(row).toMatchObject({ chain_id: 143, user_id: t.base.user_id, address: offerFor(t.base).address, owners_json: t.base.owners_json, salt_nonce: t.base.salt_nonce, passkey_credential_id: t.base.passkey_credential_id, passkey_x: t.base.passkey_x, passkey_y: t.base.passkey_y, env: t.base.env, is_test: t.base.is_test })
    expect(row!.account_key).not.toBe(t.base.account_key)
    expect(JSON.parse(row!.remote_json!)).toEqual(SPEC)
    const ctx: AccountContext = accountContext(row!)
    expect(ctx).toMatchObject({ chainId: 143, address: offerFor(t.base).address, remote: SPEC, owners: ownersOf(t.base) })
    expect(accountContext(t.base).remote).toBeUndefined()

    await t.call('/funding')
    await t.call('/funding')
    expect(t.sleeves().map((r) => r.account_key)).toEqual([row!.account_key])
  })

  test('a mismatching offer is not written, and the funding read itself still answers', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    const t = await world({ funding: (b) => ({ active: true, remote: { ...offerFor(b), address: `0x${'33'.repeat(20)}`, ready: true } }) })
    expect((await t.call('/funding')).status).toBe(200)
    expect(t.sleeves()).toEqual([])
    err.mockRestore()
  })

  test('a funding read without a remote writes nothing', async () => {
    const t = await world()
    await t.call('/funding')
    expect(t.sleeves()).toEqual([])
  })

  test('an existing remote row is never repointed; an old-style row (no remote_json) is', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    const t = await world()
    const now = new Date('2026-10-31T00:00:00Z')
    const first = offerFor(t.base)
    expect(await upsertRemoteSleeve(t.h.db, t.base, first, now)).toBe('inserted')
    expect(await upsertRemoteSleeve(t.h.db, t.base, first, now)).toBe('unchanged')

    const other = offerFor(t.base, { ...SPEC, validUntil: SPEC.validUntil + 1 })
    expect(other.address).not.toBe(first.address)
    expect(await upsertRemoteSleeve(t.h.db, t.base, other, now)).toBe('kept')
    expect(t.sleeves().map((r) => r.address)).toEqual([first.address])

    t.h.db.raw.query('UPDATE accounts SET remote_json = NULL, address = ? WHERE chain_id = 143').run(t.base.address)
    expect(await upsertRemoteSleeve(t.h.db, t.base, other, now)).toBe('updated')
    const [row] = t.sleeves()
    expect(row).toMatchObject({ address: other.address })
    expect(JSON.parse(row!.remote_json!)).toEqual(other.spec)
    err.mockRestore()
  })
})
