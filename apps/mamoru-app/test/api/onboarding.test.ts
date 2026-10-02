import { describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import type { AppConfig, OwnerResponse, SessionView, SignInChallenge } from '@mamoru/domain'
import { PRODUCTION_BANNER } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { accountSetup, counterfactualAddress, type RecoveryKit } from '@mamoru/account/recovery'
import { counterfactualAccount, passkeySigner, saltNonceOf } from '../../src/api/onboarding/account.ts'
import { isP256Point } from '../../src/api/onboarding/passkey.ts'
import { harness, register, registrationProof, PASSKEY_A, PASSKEY_B, sessionCookie, type RegistrationShape } from './helpers.ts'
import { ONBOARDING_PER_IP } from '../../src/api/auth/rate-limit.ts'
import { coseKeyMap } from '../../src/api/auth/registration.ts'

async function onboard(h: ReturnType<typeof harness>, passkey = PASSKEY_A) {
  const res = await register(h, passkey)
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
    const res = await register(h, PASSKEY_A)
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

// The account row is created only for registration data produced for a challenge from this server, on this site,
// whose credential id and public key are the ones being stored. One credential id, one account.
describe('registration proof', () => {
  const challengeOf = async (h: ReturnType<typeof harness>, path = '/api/onboarding/challenge') => (await (await h.post(path, {})).json()) as SignInChallenge
  const REFUSED = { error: 'This passkey could not be registered. If you already have an account, sign in with it.', code: 'ONB_PASSKEY_REFUSED' }
  const nothingWritten = (h: ReturnType<typeof harness>) => {
    expect(h.db.raw.query('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 })
    expect(h.db.raw.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 0 })
  }
  async function expectRefused(res: Response) {
    expect(res.status).toBe(400)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect((await res.json()) as unknown).toEqual(REFUSED)
  }

  test('the challenge is for registration only, on this host, and stores nothing', async () => {
    const h = harness()
    const c = await challengeOf(h)
    expect(Buffer.from(c.challenge, 'base64url')).toHaveLength(32)
    expect(c.rpId).toBe('app.mamoru.lol')
    expect(h.db.raw.query('SELECT count(*) AS n FROM auth_challenge_used').get()).toEqual({ n: 0 })
    // A sign-in challenge does not register, and a registration challenge does not sign in.
    const signin = await challengeOf(h, '/api/auth/challenge')
    await expectRefused(await h.post('/api/onboarding/owner', { passkey: PASSKEY_A, proof: registrationProof(PASSKEY_A, signin) }))
    const res = await h.post('/api/auth/signin', { token: c.token, credentialId: PASSKEY_A.credentialId, authenticatorData: 'AA', clientDataJSON: 'AA', signature: 'AA' })
    expect(res.status).toBe(401)
    nothingWritten(h)
  })

  test('onboarding without a proof, or with an incomplete one, creates nothing', async () => {
    const h = harness()
    const proof = registrationProof(PASSKEY_A, await challengeOf(h))
    for (const body of [{ passkey: PASSKEY_A }, { passkey: PASSKEY_A, proof: null }, { passkey: PASSKEY_A, proof: 'x' }, { passkey: PASSKEY_A, proof: { ...proof, token: undefined } }, { passkey: PASSKEY_A, proof: { ...proof, authenticatorData: '***' } }, { passkey: PASSKEY_A, proof: { token: proof.token } }]) {
      await expectRefused(await h.post('/api/onboarding/owner', body))
    }
    nothingWritten(h)
  })

  test('each part of the proof is checked', async () => {
    const h = harness()
    const shapes: RegistrationShape[] = [
      { type: 'webauthn.get' },
      { challenge: 'A'.repeat(43) },
      { origin: 'https://mamoru-app.example' },
      { origin: 'https://beta.mamoru.lol' },
      { rpId: 'beta.mamoru.lol' },
      { crossOrigin: true },
      { flags: 0x05 }, // no attested credential data
      { flags: 0x44 }, // user not present
      { flags: 0x41 }, // user not verified
      { flags: 0x55 }, // backed up but not backup eligible
      { credentialId: PASSKEY_B.credentialId }, // another credential id inside the authenticator data
      { x: PASSKEY_B.x, y: PASSKEY_B.y }, // another key inside the authenticator data
      { y: PASSKEY_B.y },
      { alg: -8 }, // not ES256
    ]
    for (const [i, shape] of shapes.entries()) await expectRefused(await register(h, PASSKEY_A, { shape, ip: `198.51.100.${i}` }))
    nothingWritten(h)
    // The same passkey with honest data registers.
    expect((await register(h, PASSKEY_A)).status).toBe(201)
  })

  test('a proof is single use and tied to the passkey it was made for', async () => {
    const h = harness()
    const c = await challengeOf(h)
    const proof = registrationProof(PASSKEY_A, c)
    // Sent with another passkey: refused, and the challenge is spent.
    await expectRefused(await h.post('/api/onboarding/owner', { passkey: PASSKEY_B, proof }))
    await expectRefused(await h.post('/api/onboarding/owner', { passkey: PASSKEY_A, proof }))
    nothingWritten(h)
    const [ch, exp, tag] = c.token.split('.') as [string, string, string]
    await expectRefused(await h.post('/api/onboarding/owner', { passkey: PASSKEY_A, proof: { ...registrationProof(PASSKEY_A, await challengeOf(h)), token: `${ch}.${Number(exp) + 1}.${tag}` } }))
  })

  test('an expired challenge is refused', async () => {
    let now = new Date('2026-10-01T10:00:00Z')
    const h = harness(() => now)
    const proof = registrationProof(PASSKEY_A, await challengeOf(h))
    now = new Date(now.getTime() + 5 * 60_000)
    await expectRefused(await h.post('/api/onboarding/owner', { passkey: PASSKEY_A, proof }))
  })

  test('a credential id that already owns an account is refused with the same answer as any bad proof', async () => {
    const h = harness()
    const first = await onboard(h, PASSKEY_A)
    // Another session, same credential id: with the same key or with another one.
    await expectRefused(await register(h, PASSKEY_A))
    await expectRefused(await register(h, { ...PASSKEY_B, credentialId: PASSKEY_A.credentialId }))
    expect(h.db.raw.query('SELECT account_key FROM accounts').all()).toEqual([{ account_key: first.owner.accountKey }])
    // No user row is left behind by a refused registration.
    expect(h.db.raw.query('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 })
    // The database itself refuses a second row, whatever the code above it does.
    expect(() => h.db.raw.exec(`INSERT INTO accounts SELECT '${crypto.randomUUID()}', user_id, chain_id, '0x00000000000000000000000000000000000000bb', owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, recovery_ack_at, created_at, 0 FROM accounts`)).toThrow(/UNIQUE/)
  })

  test('the session that owns the account is answered again without a new proof', async () => {
    const h = harness()
    const { cookie, owner } = await onboard(h)
    const again = await h.post('/api/onboarding/owner', { passkey: PASSKEY_A }, { cookie })
    expect(again.status).toBe(200)
    expect(((await again.json()) as OwnerResponse).accountKey).toBe(owner.accountKey)
  })

  test('anonymous onboarding is limited per client IP, in bounded buckets', async () => {
    const h = harness(() => new Date('2026-10-01T10:00:00Z'))
    for (let i = 0; i < ONBOARDING_PER_IP; i++) await expectRefused(await register(h, PASSKEY_A, { ip: '203.0.113.9', shape: { flags: 0x05 } }))
    const limited = await register(h, PASSKEY_A, { ip: '203.0.113.9' })
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { code: string }).code).toBe('AUTH_RATE_LIMITED')
    nothingWritten(h)
    // Another address is not held back, and sign-in attempts are counted apart.
    expect((await register(h, PASSKEY_A, { ip: '203.0.113.10' })).status).toBe(201)
    const keys = (h.db.raw.query('SELECT key FROM auth_rate').all() as { key: string }[]).map((r) => r.key)
    expect(keys.every((k) => /^onb:\d{1,4}$/.test(k))).toBe(true)
  })

  test('the COSE key reader takes an EC2 key in any field order and nothing else', () => {
    const x = new Uint8Array(32).fill(1)
    const y = new Uint8Array(32).fill(2)
    const key = coseKeyMap(Uint8Array.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y]))!
    expect([key.get(1), key.get(3), key.get(-1)]).toEqual([2, -7, 1])
    expect(key.get(-2)).toEqual(x)
    expect(key.get(-3)).toEqual(y)
    const reordered = coseKeyMap(Uint8Array.from([0xa5, 0x22, 0x58, 0x20, ...y, 0x20, 0x01, 0x03, 0x26, 0x01, 0x02, 0x21, 0x58, 0x20, ...x]))!
    expect(reordered.get(-3)).toEqual(y)
    expect(coseKeyMap(new Uint8Array())).toBeNull()
    expect(coseKeyMap(Uint8Array.from([0x80]))).toBeNull() // an array
    expect(coseKeyMap(Uint8Array.from([0xa1, 0x01]))).toBeNull() // truncated
    expect(coseKeyMap(Uint8Array.from([0xa1, 0x61, 0x61, 0x01]))).toBeNull() // text key
    expect(coseKeyMap(Uint8Array.from([0xa1, 0x21, 0x58, 0x20, 1, 2]))).toBeNull() // byte string past the end
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
