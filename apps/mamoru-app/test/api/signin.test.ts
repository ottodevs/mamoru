import { describe, expect, test } from 'bun:test'
import type { OwnerResponse, PasskeyOwner, SessionView, SignInChallenge, SignInRequest } from '@mamoru/domain'
import { CHALLENGE_TTL_SECONDS, issueChallenge, openChallenge, spendChallenge } from '../../src/api/auth/challenge.ts'
import { SIGNIN_LIMITS, allow, count, countNothing, credentialKey, ipKey } from '../../src/api/auth/rate-limit.ts'
import { checkClaims, constantTimeEqual, signCountOf, verifyP256 } from '../../src/api/auth/webauthn.ts'
import { harness, register, registrationProof, ORIGIN, SECRET, sessionCookie } from './helpers.ts'

// Real P-256 keys made here with WebCrypto: a software authenticator that answers like navigator.credentials.get.

const RP_ID = 'app.mamoru.lol'
const BETA = 'https://beta.mamoru.lol'
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const enc = new TextEncoder()

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}` as const
const sha256 = async (d: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? enc.encode(d) : (d as Uint8Array<ArrayBuffer>)))

function der(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    let b = Buffer.from(v.toString(16).padStart(64, '0'), 'hex')
    while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1)
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b])
    return Buffer.concat([Buffer.from([0x02, b.length]), b])
  }
  const body = Buffer.concat([int(r), int(s)])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

type Authenticator = { owner: PasskeyOwner; key: CryptoKey }

async function authenticator(credentialId = b64url(crypto.getRandomValues(new Uint8Array(20)))): Promise<Authenticator> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const coord = (v: string) => hex(Buffer.from(v, 'base64url'))
  return { owner: { credentialId, x: coord(jwk.x!), y: coord(jwk.y!) }, key: pair.privateKey }
}

type Shape = { rpId?: string; origin?: string; type?: string; flags?: number; challenge?: string; extra?: Record<string, unknown>; highS?: boolean; credentialId?: string; signCount?: number }

/** The assertion a platform authenticator returns for `challenge`: UP and UV set unless `flags` says otherwise; counter 0 like a synced passkey. */
async function assertion(a: Authenticator, c: SignInChallenge, shape: Shape = {}): Promise<SignInRequest> {
  const authenticatorData = new Uint8Array(37)
  authenticatorData.set(await sha256(shape.rpId ?? RP_ID))
  authenticatorData[32] = shape.flags ?? 0x05
  new DataView(authenticatorData.buffer).setUint32(33, shape.signCount ?? 0)
  const clientDataJSON = enc.encode(JSON.stringify({ type: shape.type ?? 'webauthn.get', challenge: shape.challenge ?? c.challenge, origin: shape.origin ?? ORIGIN, crossOrigin: false, ...shape.extra }))
  const signed = Buffer.concat([authenticatorData, await sha256(clientDataJSON)])
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, a.key, signed))
  const r = BigInt(hex(raw.subarray(0, 32)))
  let s = BigInt(hex(raw.subarray(32)))
  const low = s <= P256_N / 2n
  if (shape.highS !== undefined && shape.highS === low) s = P256_N - s
  return { token: c.token, credentialId: shape.credentialId ?? a.owner.credentialId, authenticatorData: b64url(authenticatorData), clientDataJSON: b64url(clientDataJSON), signature: b64url(der(r, s)) }
}

type H = ReturnType<typeof harness>
const FAILED = { error: 'Sign-in failed.', code: 'AUTH_SIGNIN_FAILED' }

async function onboard(h: H, a: Authenticator) {
  const res = await register(h, a.owner)
  expect(res.status).toBe(201)
  return { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
}
async function challenge(h: H): Promise<SignInChallenge> {
  const res = await h.post('/api/auth/challenge', {})
  expect(res.status).toBe(200)
  return (await res.json()) as SignInChallenge
}
const ipHeaders = (ip: string) => ({ 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': ip })
const signIn = (h: H, body: unknown, ip = '203.0.113.7', cookie?: string) => h.request('/api/auth/signin', { method: 'POST', body: JSON.stringify(body), headers: ipHeaders(ip), cookie })
/** A fresh challenge, an assertion shaped by `shape`, and the answer. */
async function attempt(h: H, a: Authenticator, shape: Shape = {}, ip?: string) {
  return signIn(h, await assertion(a, await challenge(h), shape), ip)
}
async function expectRefused(res: Response) {
  expect(res.status).toBe(401)
  expect(res.headers.get('set-cookie')).toBeNull()
  expect((await res.json()) as unknown).toEqual(FAILED)
}

describe('sign-in challenge', () => {
  const now = new Date('2026-10-01T10:00:00Z')

  test('32 random bytes, five minutes, bound to the host; issuing stores nothing', async () => {
    const h = harness(() => now)
    const c = await challenge(h)
    expect(Buffer.from(c.challenge, 'base64url')).toHaveLength(32)
    expect(c.rpId).toBe(RP_ID)
    expect(Date.parse(c.expiresAt) - now.getTime()).toBe(CHALLENGE_TTL_SECONDS * 1000)
    expect((await challenge(h)).challenge).not.toBe(c.challenge)
    expect(h.db.raw.query('SELECT COUNT(*) AS n FROM auth_challenge_used').get()).toEqual({ n: 0 })
    expect(h.db.raw.query('SELECT COUNT(*) AS n FROM auth_rate').get()).toEqual({ n: 0 })
  })

  test('opens only an untouched token, for the same host and secret, before it expires', async () => {
    const c = await issueChallenge(SECRET, RP_ID, now)
    const [ch, exp, tag] = c.token.split('.') as [string, string, string]
    expect(await openChallenge(SECRET, RP_ID, c.token, now)).toEqual({ challenge: c.challenge, exp: Number(exp) })
    expect(await openChallenge(SECRET, 'beta.mamoru.lol', c.token, now)).toBeNull()
    expect(await openChallenge(`${SECRET}x`, RP_ID, c.token, now)).toBeNull()
    expect(await openChallenge(SECRET, RP_ID, `${ch}.${Number(exp) + 600}.${tag}`, now)).toBeNull()
    expect(await openChallenge(SECRET, RP_ID, `${'A'.repeat(43)}.${exp}.${tag}`, now)).toBeNull()
    expect(await openChallenge(SECRET, RP_ID, `${ch}.${exp}`, now)).toBeNull()
    expect(await openChallenge(SECRET, RP_ID, 42, now)).toBeNull()
    const last = new Date(now.getTime() + (CHALLENGE_TTL_SECONDS - 1) * 1000)
    expect(await openChallenge(SECRET, RP_ID, c.token, last)).not.toBeNull()
    expect(await openChallenge(SECRET, RP_ID, c.token, new Date(last.getTime() + 1000))).toBeNull()
  })

  test('is spent once; spent rows are dropped after their expiry', async () => {
    const h = harness(() => now)
    const exp = Math.floor(now.getTime() / 1000) + CHALLENGE_TTL_SECONDS
    expect(await spendChallenge(h.db, 'c1', exp, now)).toBe(true)
    expect(await spendChallenge(h.db, 'c1', exp, now)).toBe(false)
    expect(await spendChallenge(h.db, 'c2', exp + 600, new Date((exp + 1) * 1000))).toBe(true)
    expect(h.db.raw.query('SELECT challenge FROM auth_challenge_used').all()).toEqual([{ challenge: 'c2' }])
  })

  test('a challenge token is not a session cookie signature', async () => {
    const h = harness(() => now)
    const c = await challenge(h)
    expect((await h.request('/api/session', { cookie: `__Host-mamoru_session=${encodeURIComponent(c.token)}` })).status).toBe(401)
  })
})

describe('assertion verification', () => {
  test('constant-time comparison is exact', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
  })

  test('a real P-256 signature verifies against its key only, low or high s, and not over other bytes', async () => {
    const a = await authenticator()
    const b = await authenticator()
    const c: SignInChallenge = { challenge: 'x'.repeat(43), token: '', rpId: RP_ID, expiresAt: '' }
    for (const highS of [false, true]) {
      const req = await assertion(a, c, { highS })
      const parts = { authenticatorData: Buffer.from(req.authenticatorData, 'base64url'), clientDataJSON: Buffer.from(req.clientDataJSON, 'base64url'), signature: Buffer.from(req.signature, 'base64url') }
      const claims = await checkClaims(parts, { challenge: c.challenge, origin: ORIGIN, rpId: RP_ID })
      expect(claims.reason).toBeNull()
      expect(await verifyP256(a.owner, claims.signed, parts.signature)).toBe(true)
      expect(await verifyP256(b.owner, claims.signed, parts.signature)).toBe(false)
      const other = Uint8Array.from(claims.signed)
      other[36] = other[36]! ^ 1
      expect(await verifyP256(a.owner, other, parts.signature)).toBe(false)
      expect(await verifyP256(a.owner, claims.signed, parts.signature.subarray(0, 20))).toBe(false)
    }
  })

  test('each claim is checked: type, challenge, origin, cross-origin, rpIdHash, user present, user verified, backup flags', async () => {
    const a = await authenticator()
    const c: SignInChallenge = { challenge: 'y'.repeat(43), token: '', rpId: RP_ID, expiresAt: '' }
    const reason = async (shape: Shape, expected = { challenge: c.challenge, origin: ORIGIN, rpId: RP_ID }) => {
      const req = await assertion(a, c, shape)
      const r = await checkClaims({ authenticatorData: Buffer.from(req.authenticatorData, 'base64url'), clientDataJSON: Buffer.from(req.clientDataJSON, 'base64url'), signature: Buffer.from(req.signature, 'base64url') }, expected)
      return r.reason ?? 'ok'
    }
    expect(await reason({})).toBe('ok')
    expect(await reason({ type: 'webauthn.create' })).toBe('type')
    expect(await reason({ challenge: 'z'.repeat(43) })).toBe('challenge')
    expect(await reason({ origin: 'https://app.mamoru.lol.evil.example' })).toBe('origin')
    expect(await reason({ origin: BETA })).toBe('origin')
    expect(await reason({ origin: 'http://app.mamoru.lol' })).toBe('origin')
    expect(await reason({ extra: { crossOrigin: true } })).toBe('cross_origin')
    expect(await reason({ extra: { topOrigin: 'https://evil.example' } })).toBe('cross_origin')
    expect(await reason({ rpId: 'beta.mamoru.lol' })).toBe('rp_id')
    expect(await reason({ rpId: 'mamoru.lol' })).toBe('rp_id')
    expect(await reason({ flags: 0x04 })).toBe('user_present')
    expect(await reason({ flags: 0x01 })).toBe('user_verified')
    // Backup state without backup eligibility is not a state an authenticator can be in (WebAuthn L3).
    expect(await reason({ flags: 0x15 })).toBe('backup_flags')
    expect(await reason({ flags: 0x0d })).toBe('ok')
    expect(await reason({ flags: 0x1d })).toBe('ok')
    const junk = { authenticatorData: new Uint8Array(37), signature: new Uint8Array(8) }
    expect((await checkClaims({ ...junk, clientDataJSON: enc.encode('not json') }, { challenge: '', origin: ORIGIN, rpId: RP_ID })).reason).toBe('client_data')
    const list = await checkClaims({ ...junk, clientDataJSON: enc.encode('[]') }, { challenge: '', origin: ORIGIN, rpId: RP_ID })
    expect(list.reason).toBe('client_data')
    // A refused claim still yields the bytes to verify, so the caller does the same work either way.
    expect(list.signed).toHaveLength(37 + 32)
    const short = await assertion(a, c)
    expect((await checkClaims({ authenticatorData: new Uint8Array(36), clientDataJSON: Buffer.from(short.clientDataJSON, 'base64url'), signature: new Uint8Array(8) }, { challenge: c.challenge, origin: ORIGIN, rpId: RP_ID })).reason).toBe('auth_data')
    expect(signCountOf(Buffer.from((await assertion(a, c, { signCount: 0x01020304 })).authenticatorData, 'base64url'))).toBe(0x01020304)
  })
})

describe('POST /api/auth/signin', () => {
  test('a device with no session signs in with the owner passkey and is bound to that account', async () => {
    const h = harness()
    const a = await authenticator()
    const first = await onboard(h, a)
    const res = await attempt(h, a)
    expect(res.status).toBe(200)
    const view = (await res.json()) as SessionView
    expect(view.accountKey).toBe(first.owner.accountKey)
    const set = res.headers.get('set-cookie') ?? ''
    expect(set).toStartWith('__Host-mamoru_session=')
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(set).toContain(attr)
    // The new cookie is the same user as the one onboarding created, and reaches the same account.
    const cookie = sessionCookie(res)
    const original = (await (await h.request('/api/session', { cookie: first.cookie })).json()) as SessionView
    const session = (await (await h.request('/api/session', { cookie })).json()) as SessionView
    expect(session).toEqual(original)
    expect(view).toEqual(original)
    expect((await h.request(`/api/accounts/${first.owner.accountKey}/dashboard`, { cookie })).status).toBe(200)
    expect((await h.request(`/api/onboarding/kit?accountKey=${first.owner.accountKey}`, { cookie })).status).toBe(200)
  })

  test('grants a session and nothing else: no key, no signature, no account data in the answer', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const view = (await (await attempt(h, a)).json()) as Record<string, unknown>
    expect(Object.keys(view).sort()).toEqual(['accountKey', 'userId'])
  })

  test('browsers return high-s signatures half the time: both are accepted', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    expect((await attempt(h, a, { highS: true })).status).toBe(200)
    expect((await attempt(h, a, { highS: false })).status).toBe(200)
  })

  test('replay: the same assertion is refused the second time', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const body = await assertion(a, await challenge(h))
    expect((await signIn(h, body)).status).toBe(200)
    await expectRefused(await signIn(h, body))
    await expectRefused(await signIn(h, body, '198.51.100.9'))
  })

  test('a challenge is one attempt: after a failed assertion it cannot be used for a good one', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const c = await challenge(h)
    await expectRefused(await signIn(h, await assertion(a, c, { flags: 0x01 })))
    await expectRefused(await signIn(h, await assertion(a, c)))
  })

  test('an expired challenge is refused', async () => {
    let now = new Date('2026-10-01T10:00:00Z')
    const h = harness(() => now)
    const a = await authenticator()
    await onboard(h, a)
    const body = await assertion(a, await challenge(h))
    now = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000)
    await expectRefused(await signIn(h, body))
  })

  test('a forged or altered challenge token is refused', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const c = await challenge(h)
    const [ch, exp, tag] = c.token.split('.') as [string, string, string]
    await expectRefused(await signIn(h, await assertion(a, { ...c, token: `${ch}.${Number(exp) + 1}.${tag}` })))
    // A challenge the attacker made up, with a real token for another challenge.
    const own = b64url(crypto.getRandomValues(new Uint8Array(32)))
    await expectRefused(await signIn(h, await assertion(a, c, { challenge: own })))
    await expectRefused(await signIn(h, await assertion(a, { ...c, token: `${own}.${exp}.${tag}` }, { challenge: own })))
  })

  test('wrong origin, wrong RP ID, wrong type, no user presence or verification: all refused alike', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const shapes: Shape[] = [
      { origin: 'https://mamoru-app.example' },
      { origin: BETA },
      { rpId: 'beta.mamoru.lol' },
      { rpId: 'mamoru-app.example', origin: 'https://mamoru-app.example' },
      { type: 'webauthn.create' },
      { flags: 0x04 },
      { flags: 0x01 },
      { flags: 0x15 },
      { extra: { crossOrigin: true } },
    ]
    for (const shape of shapes) await expectRefused(await attempt(h, a, shape))
  })

  test('wrong passkey and unknown credential get the same answer', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const stranger = await authenticator()
    await expectRefused(await attempt(h, stranger))
    // The right credential id with another key: the signature does not match the stored public key.
    await expectRefused(await attempt(h, stranger, { credentialId: a.owner.credentialId }))
  })

  test('malformed bodies are refused with the same answer', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const good = await assertion(a, await challenge(h))
    for (const body of [null, [], 'x', {}, { ...good, signature: '***' }, { ...good, credentialId: 'short' }, { ...good, authenticatorData: '' }, { ...good, token: undefined }]) {
      await expectRefused(await signIn(h, body))
    }
    await expectRefused(await h.request('/api/auth/signin', { method: 'POST', body: '{', headers: ipHeaders('203.0.113.7') }))
    await expectRefused(await signIn(h, { ...good, clientDataJSON: 'A'.repeat(9000) }))
  })

  test('app and beta stay separate identities: an app passkey does not sign in on beta', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const beta = (path: string, body: unknown) => h.app.request(`${BETA}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: BETA } }, h.env)
    const betaChallenge = (await (await beta('/api/auth/challenge', {})).json()) as SignInChallenge
    expect(betaChallenge.rpId).toBe('beta.mamoru.lol')
    // The passkey can only assert for app.mamoru.lol; beta refuses that RP ID hash and that origin.
    await expectRefused(await beta('/api/auth/signin', await assertion(a, betaChallenge)))
    // An app challenge token does not open on beta either.
    await expectRefused(await beta('/api/auth/signin', await assertion(a, await challenge(h), { rpId: 'beta.mamoru.lol', origin: BETA })))
    // A beta-scoped passkey with its own account does sign in on beta.
    const b = await authenticator()
    const regChallenge = (await (await beta('/api/onboarding/challenge', {})).json()) as SignInChallenge
    const made = await beta('/api/onboarding/owner', { passkey: b.owner, proof: registrationProof(b.owner, regChallenge, { rpId: 'beta.mamoru.lol', origin: BETA }) })
    expect(made.status).toBe(201)
    const fresh = (await (await beta('/api/auth/challenge', {})).json()) as SignInChallenge
    const ok = await beta('/api/auth/signin', await assertion(b, fresh, { rpId: 'beta.mamoru.lol', origin: BETA }))
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as SessionView).accountKey).toBe(((await made.json()) as OwnerResponse).accountKey)
  })

  test('a credential id cannot be registered twice, so nobody else can sit on it; its owner keeps signing in', async () => {
    const h = harness()
    const victim = await authenticator()
    const v = await onboard(h, victim)
    const squatter = await authenticator(victim.owner.credentialId)
    const refused = await register(h, squatter.owner)
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as { code: string }).code).toBe('ONB_PASSKEY_REFUSED')
    expect(h.db.raw.query('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 })
    expect(((await (await attempt(h, victim)).json()) as SessionView).accountKey).toBe(v.owner.accountKey)
    await expectRefused(await attempt(h, squatter))
  })

  test('an account created before this change (no proof, no counter) signs in like any other', async () => {
    const h = harness()
    const a = await authenticator()
    h.db.raw.exec("INSERT INTO users (user_id, email, created_at) VALUES ('5b0c7a52-7f0e-4d1a-9c3e-2f6a1b9d8e70', NULL, '2026-09-27T10:00:00.000Z')")
    h.db.raw
      .query(
        `INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, recovery_ack_at, created_at)
         VALUES ('1081e868-0000-4000-8000-000000000001', '5b0c7a52-7f0e-4d1a-9c3e-2f6a1b9d8e70', 8453, '0x00000000000000000000000000000000000000aa', '[]', ?, ?, ?, '1', 'conservador', '1.0.0', NULL, '2026-09-27T10:00:00.000Z')`,
      )
      .run(a.owner.credentialId, a.owner.x, a.owner.y)
    const res = await attempt(h, a)
    expect(res.status).toBe(200)
    expect((await res.json()) as SessionView).toEqual({ userId: '5b0c7a52-7f0e-4d1a-9c3e-2f6a1b9d8e70', accountKey: '1081e868-0000-4000-8000-000000000001' })
  })

  test('signing in from a device that holds another session switches it to the proven account', async () => {
    const h = harness()
    const a = await authenticator()
    const b = await authenticator()
    const first = await onboard(h, a)
    const other = await onboard(h, b)
    const res = await signIn(h, await assertion(a, await challenge(h)), undefined, other.cookie)
    expect(res.status).toBe(200)
    expect(((await (await h.request('/api/session', { cookie: sessionCookie(res) })).json()) as SessionView).accountKey).toBe(first.owner.accountKey)
    // The other session is untouched and still cannot reach this account.
    expect((await h.request(`/api/accounts/${first.owner.accountKey}/dashboard`, { cookie: other.cookie })).status).toBe(404)
  })

  test('requests from another origin are refused before anything runs', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const body = await assertion(a, await challenge(h))
    expect((await h.post('/api/auth/signin', body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await h.post('/api/auth/challenge', {}, { origin: null })).status).toBe(403)
    // Refused by the origin check, so the challenge was not spent.
    expect((await signIn(h, body)).status).toBe(200)
  })
})

describe('signature counter', () => {
  test('a synced passkey always reports 0 and keeps signing in', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    for (let i = 0; i < 3; i++) expect((await attempt(h, a, { signCount: 0 })).status).toBe(200)
    expect(h.db.raw.query('SELECT passkey_sign_count AS n FROM accounts').get()).toEqual({ n: 0 })
  })

  test('a counter that increases is stored; one that repeats, goes back or resets to 0 is refused', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const stored = () => (h.db.raw.query('SELECT passkey_sign_count AS n FROM accounts').get() as { n: number }).n
    expect((await attempt(h, a, { signCount: 5 })).status).toBe(200)
    expect(stored()).toBe(5)
    expect((await attempt(h, a, { signCount: 9 })).status).toBe(200)
    expect(stored()).toBe(9)
    for (const signCount of [9, 3, 0]) await expectRefused(await attempt(h, a, { signCount }))
    expect(stored()).toBe(9)
    expect((await attempt(h, a, { signCount: 10 })).status).toBe(200)
  })

  test('a refused assertion never moves the counter', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    await expectRefused(await attempt(h, a, { signCount: 50, flags: 0x01 }))
    await expectRefused(await attempt(h, await authenticator(a.owner.credentialId), { signCount: 50 }))
    expect(h.db.raw.query('SELECT passkey_sign_count AS n FROM accounts').get()).toEqual({ n: 0 })
    expect((await attempt(h, a, { signCount: 1 })).status).toBe(200)
  })
})

describe('refusal log', () => {
  test('a refused assertion is logged with its non-secret shape, so a real device can be diagnosed', async () => {
    const h = harness()
    const a = await authenticator()
    await onboard(h, a)
    const lines: string[] = []
    const log = console.log
    console.log = (...args: unknown[]) => void lines.push(String(args[0]))
    let body: SignInRequest
    try {
      body = await assertion(await authenticator(a.owner.credentialId), await challenge(h), { highS: true })
      await expectRefused(await signIn(h, body))
    } finally {
      console.log = log
    }
    const line = lines.find((l) => l.startsWith('signin refused: signature'))!
    const shape = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>
    expect(shape).toMatchObject({ authenticatorDataLength: 37, flags: '0x05', signCountZero: true, clientDataKeys: ['type', 'challenge', 'origin', 'crossOrigin'], signatureDer: 'ok', highS: true })
    // No credential id, no key, no challenge, no signature bytes.
    for (const secret of [a.owner.credentialId, body.signature, body.clientDataJSON, a.owner.x.slice(2)]) expect(line).not.toContain(secret)
  })
})

describe('sign-in rate limit', () => {
  test('knowing a credential id does not lock its owner out: failures on it never block a correct assertion', async () => {
    const h = harness(() => new Date('2026-10-01T10:00:00Z'))
    const a = await authenticator()
    await onboard(h, a)
    const attacker = await authenticator(a.owner.credentialId)
    for (let i = 0; i < 3 * SIGNIN_LIMITS.credentialFailuresLogged; i++) {
      // Always the generic 401, never a 429 that would also tell the id exists.
      await expectRefused(await signIn(h, await assertion(attacker, await challenge(h)), `198.51.100.${i}`))
    }
    const owner = await attempt(h, a, {}, '192.0.2.1')
    expect(owner.status).toBe(200)
    expect(owner.headers.get('set-cookie')).toStartWith('__Host-mamoru_session=')
  })

  test('per IP: after 20 attempts one address is refused whatever it sends, another address is not', async () => {
    const h = harness(() => new Date('2026-10-01T10:00:00Z'))
    const a = await authenticator()
    await onboard(h, a)
    for (let i = 0; i < SIGNIN_LIMITS.perIp; i++) await expectRefused(await attempt(h, await authenticator(), {}, '203.0.113.50'))
    const limited = await attempt(h, a, {}, '203.0.113.50')
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { code: string }).code).toBe('AUTH_RATE_LIMITED')
    expect(limited.headers.get('set-cookie')).toBeNull()
    expect((await signIn(h, {}, '203.0.113.50')).status).toBe(429)
    expect((await attempt(h, a, {}, '203.0.113.51')).status).toBe(200)
  })

  test('failures are counted per credential only for credentials that exist, and only after a valid challenge', async () => {
    const h = harness(() => new Date('2026-10-01T10:00:00Z'))
    const a = await authenticator()
    await onboard(h, a)
    const credRows = () => h.db.raw.query("SELECT key, count FROM auth_rate WHERE key LIKE 'cred:%'").all() as { key: string; count: number }[]
    // Unknown credential ids, malformed bodies, bad or replayed challenge tokens: no per-credential row.
    for (let i = 0; i < 5; i++) await expectRefused(await attempt(h, await authenticator(), {}, `198.51.100.${i}`))
    await expectRefused(await signIn(h, { ...(await assertion(a, await challenge(h))), signature: '***' }))
    await expectRefused(await signIn(h, { ...(await assertion(a, await challenge(h))), token: 'x.1.y' }))
    const once = await assertion(await authenticator(a.owner.credentialId), await challenge(h))
    await expectRefused(await signIn(h, once))
    expect(credRows()).toEqual([{ key: await credentialKey(a.owner.credentialId), count: 1 }])
    await expectRefused(await signIn(h, once))
    expect(credRows()[0]!.count).toBe(1)
    // A success is not a failure.
    expect((await attempt(h, a)).status).toBe(200)
    expect(credRows()[0]!.count).toBe(1)
  })

  test('the table is bounded: IPs fall into a fixed set of buckets and past windows are dropped on write', async () => {
    const t0 = new Date('2026-10-01T10:00:00Z')
    const h = harness(() => t0)
    const keys = new Set<string>()
    // More addresses than buckets: the rows an attacker can create per window stop at the bucket count.
    for (let i = 0; i < 6_000; i++) keys.add(await ipKey(SECRET, `10.${(i >> 8) & 255}.${i & 255}.${i % 7}`))
    expect(keys.size).toBeLessThanOrEqual(SIGNIN_LIMITS.ipBuckets)
    expect(keys.size).toBeGreaterThan(2_800)
    for (const k of keys) expect(Number(k.slice(3))).toBeLessThan(SIGNIN_LIMITS.ipBuckets)
    expect(await ipKey(`${SECRET}x`, '203.0.113.50')).not.toBe(await ipKey(SECRET, '203.0.113.50'))
    expect(await credentialKey('abc')).toMatch(/^cred:[0-9a-f]{32}$/)

    const key = await ipKey(SECRET, '203.0.113.50')
    expect(await allow(h.db, key, 2, t0)).toBe(true)
    expect(await allow(h.db, key, 2, t0)).toBe(true)
    expect(await allow(h.db, key, 2, t0)).toBe(false)
    expect(await count(h.db, 'cred:x', t0)).toBe(1)
    await countNothing(h.db, 'cred:never', t0)
    expect(h.db.raw.query('SELECT COUNT(*) AS n FROM auth_rate').get()).toEqual({ n: 2 })
    // The next window: one write removes every row of the old one.
    expect(await allow(h.db, key, 2, new Date(t0.getTime() + SIGNIN_LIMITS.windowSeconds * 1000))).toBe(true)
    expect(h.db.raw.query('SELECT key, count FROM auth_rate').all()).toEqual([{ key, count: 1 }])
  }, 30_000)
})

// Nothing in the answer, or in the work done to produce it, says whether a credential id belongs to an account.
describe('sign-in does not reveal whether a credential exists', () => {
  test('unknown credential, wrong key, refused flags and a stale counter: same status, same body, same work', async () => {
    const h = harness(() => new Date('2026-10-01T10:00:00Z'))
    const a = await authenticator()
    await onboard(h, a)
    expect((await attempt(h, a, { signCount: 7 })).status).toBe(200)
    const subtle = crypto.subtle
    const verify = subtle.verify.bind(subtle)
    const prepare = h.db.prepare.bind(h.db)
    let verifies = 0
    let statements: string[] = []
    subtle.verify = ((...args: Parameters<typeof verify>) => (verifies++, verify(...args))) as typeof subtle.verify
    // The failure count is an upsert for a known credential and an update of no row for an unknown one: one write either way.
    h.db.prepare = (sql: string) => (statements.push(sql.split(' ')[0]!.replace(/^(INSERT|UPDATE)$/, 'WRITE')), prepare(sql))
    const cases: [string, () => Promise<SignInRequest>][] = [
      ['unknown credential', async () => assertion(await authenticator(), await challenge(h))],
      ['wrong key', async () => assertion(await authenticator(a.owner.credentialId), await challenge(h))],
      ['refused flags, right key', async () => assertion(a, await challenge(h), { flags: 0x01, signCount: 8 })],
      ['wrong origin, unknown credential', async () => assertion(await authenticator(), await challenge(h), { origin: BETA })],
    ]
    const seen: { what: string; status: number; body: string; headers: string; verifies: number; statements: string }[] = []
    try {
      for (const [what, make] of cases) {
        const body = await make()
        verifies = 0
        statements = []
        const res = await signIn(h, body, `198.51.100.${seen.length}`)
        seen.push({ what, status: res.status, body: await res.text(), headers: [...res.headers.keys()].sort().join(','), verifies, statements: statements.join(' | ') })
      }
    } finally {
      subtle.verify = verify
      h.db.prepare = prepare
    }
    const { what: _, ...first } = seen[0]!
    expect(first).toMatchObject({ status: 401, body: JSON.stringify(FAILED), verifies: 1 })
    for (const s of seen) {
      const { what, ...rest } = s
      expect(rest, what).toEqual(first)
    }
    // The stale counter is refused after the key verified: same answer; it costs one statement more (the counter update), which only the holder of the key can reach.
    const stale = await signIn(h, await assertion(a, await challenge(h), { signCount: 7 }), '198.51.100.99')
    expect({ status: stale.status, body: await stale.text() }).toEqual({ status: 401, body: JSON.stringify(FAILED) })
  })
})
