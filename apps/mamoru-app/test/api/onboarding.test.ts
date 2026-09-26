import { describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import type { AppConfig, OwnerResponse, SessionView } from '@mamoru/domain'
import { PRODUCTION_BANNER } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { accountSetup, counterfactualAddress, type RecoveryKit } from '@mamoru/account/recovery'
import { counterfactualAccount, passkeySigner, saltNonceOf } from '../../src/api/onboarding/account.ts'
import { isP256Point } from '../../src/api/onboarding/passkey.ts'
import { harness, PASSKEY_A, PASSKEY_B, sessionCookie } from './helpers.ts'

async function onboard(h: ReturnType<typeof harness>, passkey = PASSKEY_A) {
  const res = await h.post('/api/onboarding/owner', { passkey })
  expect(res.status).toBe(201)
  return { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
}

describe('config', () => {
  test('production on Base, dry run, funds gate closed, fixed banner', async () => {
    const res = await harness().request('/api/config')
    expect(res.status).toBe(200)
    expect((await res.json()) as AppConfig).toEqual({
      mode: 'production', chainId: 8453, banner: { kind: 'simulation', text: PRODUCTION_BANNER }, fundsGate: 'closed', dryRun: true,
    })
  })

  test('refuses to serve without CORE_DRY_RUN=true', async () => {
    const h = harness()
    const res = await h.app.request('https://app.mamoru.lol/api/config', {}, { ...h.env, CORE_DRY_RUN: 'false' })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { code: string }).code).toBe('CONFIG_DRY_RUN_REQUIRED')
  })

  test('refuses another chain or a short session secret', async () => {
    const h = harness()
    for (const env of [{ ...h.env, CHAIN_ID: '84532' }, { ...h.env, MODE: 'lab' }, { ...h.env, SESSION_SECRET: 'short' }]) {
      const res = await h.app.request('https://app.mamoru.lol/api/config', {}, env)
      expect(((await res.json()) as { code: string }).code).toBe('CONFIG_MODE_INVALID')
    }
  })
})

describe('session', () => {
  test('401 before onboarding', async () => {
    const res = await harness().request('/api/session')
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('AUTH_REQUIRED')
  })

  test('the first onboarding call sets a signed HttpOnly, Secure, SameSite=Lax cookie', async () => {
    const h = harness()
    const res = await h.post('/api/onboarding/owner', { passkey: PASSKEY_A })
    const set = res.headers.get('set-cookie') ?? ''
    expect(set).toStartWith('__Host-mamoru_session=')
    expect(set).toContain('HttpOnly')
    expect(set).toContain('Secure')
    expect(set).toContain('SameSite=Lax')
    const owner = (await res.json()) as OwnerResponse
    const session = (await (await h.request('/api/session', { cookie: sessionCookie(res) })).json()) as SessionView
    expect(session.accountKey).toBe(owner.accountKey)
  })

  test('a tampered cookie is no session', async () => {
    const h = harness()
    const { cookie } = await onboard(h)
    const [name, value] = cookie.split('=') as [string, string]
    const [payload, signature] = decodeURIComponent(value).split('.') as [string, string]
    const [userId] = payload.split(':')
    // Same user, later issue time, old signature: the HMAC no longer matches.
    const forged = `${name}=${encodeURIComponent(`${userId}:1790000001.${signature}`)}`
    expect((await h.request('/api/session', { cookie })).status).toBe(200)
    expect((await h.request('/api/session', { cookie: forged })).status).toBe(401)
  })

  test('an expired cookie is no session', async () => {
    let now = new Date('2026-09-26T18:00:00Z')
    const h = harness(() => now)
    const { cookie } = await onboard(h)
    now = new Date('2026-10-27T18:00:00Z')
    expect((await h.request('/api/session', { cookie })).status).toBe(401)
  })
})

describe('owner', () => {
  test('the passkey owns a counterfactual Safe on Base through the shared signer, bound in setup; nothing deployed', async () => {
    const h = harness()
    const { owner } = await onboard(h)
    expect(owner.chainId).toBe(8453)
    expect(owner.deployed).toBe(false)
    expect(owner.owners).toEqual([address('SafeWebAuthnSharedSigner')])
    const expected = counterfactualAddress(accountSetup(owner.owners, saltNonceOf(owner.accountKey), passkeySigner(PASSKEY_A.x, PASSKEY_A.y)))
    expect(owner.address).toBe(expected)
    expect(getAddress(owner.address)).toBe(owner.address)

    const row = h.db.raw.query('SELECT * FROM accounts WHERE account_key = ?').get(owner.accountKey) as Record<string, unknown>
    expect(row).toMatchObject({ chain_id: 8453, address: expected, passkey_x: PASSKEY_A.x, passkey_y: PASSKEY_A.y, preset: 'conservador', recovery_ack_at: null })
    expect(row.salt_nonce).toBe(saltNonceOf(owner.accountKey).toString())
  })

  test('the saltNonce is deterministic per account key and distinct across keys', () => {
    const k = crypto.randomUUID()
    expect(saltNonceOf(k)).toBe(saltNonceOf(k))
    expect(saltNonceOf(k)).not.toBe(saltNonceOf(crypto.randomUUID()))
  })

  test('the address commits to the passkey: same key, other passkey, other address', () => {
    const k = crypto.randomUUID()
    expect(counterfactualAccount(k, PASSKEY_A).address).not.toBe(counterfactualAccount(k, PASSKEY_B).address)
  })

  test('repeating the call with the same passkey returns the same account', async () => {
    const h = harness()
    const { cookie, owner } = await onboard(h)
    const again = await h.post('/api/onboarding/owner', { passkey: PASSKEY_A }, { cookie })
    expect(again.status).toBe(200)
    expect(((await again.json()) as OwnerResponse).accountKey).toBe(owner.accountKey)
    const other = await h.post('/api/onboarding/owner', { passkey: PASSKEY_B }, { cookie })
    expect(other.status).toBe(409)
  })

  test('two sessions get two accounts at two addresses', async () => {
    const h = harness()
    const a = await onboard(h, PASSKEY_A)
    const b = await onboard(h, PASSKEY_B)
    expect(a.owner.address).not.toBe(b.owner.address)
    expect(a.cookie).not.toBe(b.cookie)
  })

  test('rejects a point off P-256, malformed coordinates and a missing credential id', async () => {
    const h = harness()
    const bad = [
      { ...PASSKEY_A, y: PASSKEY_B.y },
      { ...PASSKEY_A, x: '0x1234' },
      { x: PASSKEY_A.x, y: PASSKEY_A.y },
      { ...PASSKEY_A, credentialId: 'not base64url!' },
    ]
    for (const passkey of bad) expect((await h.post('/api/onboarding/owner', { passkey })).status).toBe(400)
    expect(h.db.raw.query('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 })
    expect(isP256Point(BigInt(PASSKEY_A.x), BigInt(PASSKEY_A.y))).toBe(true)
  })

  test('refuses an unproven backup owner (ONB_BACKUP_UNPROVEN)', async () => {
    const res = await harness().post('/api/onboarding/owner', { passkey: PASSKEY_A, backupOwner: '0x000000000000000000000000000000000000dEaD' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('ONB_BACKUP_UNPROVEN')
  })
})

describe('origin', () => {
  test('a POST from another origin or with no origin is refused and creates nothing', async () => {
    const h = harness()
    for (const origin of ['https://evil.example', 'http://app.mamoru.lol', null]) {
      const res = await h.post('/api/onboarding/owner', { passkey: PASSKEY_A }, { origin })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { code: string }).code).toBe('AUTH_ORIGIN_REJECTED')
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    expect(h.db.raw.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 0 })
  })
})

describe('recovery kit', () => {
  test('the kit rebuilds the stored address and carries no secret; ack is recorded once', async () => {
    const h = harness()
    const { cookie, owner } = await onboard(h)
    const res = await h.request(`/api/onboarding/kit?accountKey=${owner.accountKey}`, { cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const kit = (await res.json()) as RecoveryKit
    expect(kit.address).toBe(owner.address)
    expect(kit.chainId).toBe(8453)
    expect(kit.owners).toEqual(owner.owners)
    expect(kit.webauthn).toMatchObject({ x: BigInt(PASSKEY_A.x).toString(), y: BigInt(PASSKEY_A.y).toString() })
    expect(kit.setup.to).toBe(address('MultiSend_141'))
    expect(JSON.stringify(kit)).not.toContain(PASSKEY_A.credentialId)

    expect((await h.post('/api/onboarding/recovery-ack', { accountKey: owner.accountKey }, { cookie })).status).toBe(200)
    const first = h.db.raw.query('SELECT recovery_ack_at AS at FROM accounts').get() as { at: string }
    expect(first.at).toBe('2026-09-26T18:00:00.000Z')
  })

  test('another session gets 404 for the kit and the ack', async () => {
    const h = harness()
    const a = await onboard(h, PASSKEY_A)
    const b = await onboard(h, PASSKEY_B)
    expect((await h.request(`/api/onboarding/kit?accountKey=${a.owner.accountKey}`, { cookie: b.cookie })).status).toBe(404)
    expect((await h.post('/api/onboarding/recovery-ack', { accountKey: a.owner.accountKey }, { cookie: b.cookie })).status).toBe(404)
    expect((await h.request(`/api/onboarding/kit?accountKey=${a.owner.accountKey}`)).status).toBe(401)
  })
})
