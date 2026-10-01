import { describe, expect, test } from 'bun:test'
import type { OwnerResponse, PasskeyOwner, SessionView, SignInChallenge, SignInRequest } from '@mamoru/domain'
import { CHALLENGE_TTL_SECONDS, issueChallenge, openChallenge, spendChallenge } from '../../src/api/auth/challenge.ts'
import { SIGNIN_LIMITS, allow, rateKey } from '../../src/api/auth/rate-limit.ts'
import { checkClaims, constantTimeEqual, verifyP256 } from '../../src/api/auth/webauthn.ts'
import { harness, ORIGIN, SECRET, sessionCookie } from './helpers.ts'

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

type Shape = { rpId?: string; origin?: string; type?: string; flags?: number; challenge?: string; extra?: Record<string, unknown>; highS?: boolean; credentialId?: string }

/** The assertion a platform authenticator returns for `challenge`: UP and UV set unless `flags` says otherwise. */
async function assertion(a: Authenticator, c: SignInChallenge, shape: Shape = {}): Promise<SignInRequest> {
  const authenticatorData = new Uint8Array(37)
  authenticatorData.set(await sha256(shape.rpId ?? RP_ID))
  authenticatorData[32] = shape.flags ?? 0x05
  authenticatorData[36] = 1
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
  const res = await h.post('/api/onboarding/owner', { passkey: a.owner })
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
      if (!claims.ok) throw new Error(claims.reason)
      expect(await verifyP256(a.owner, claims.signed, parts.signature)).toBe(true)
      expect(await verifyP256(b.owner, claims.signed, parts.signature)).toBe(false)
      const other = Uint8Array.from(claims.signed)
      other[36] = other[36]! ^ 1
      expect(await verifyP256(a.owner, other, parts.signature)).toBe(false)
      expect(await verifyP256(a.owner, claims.signed, parts.signature.subarray(0, 20))).toBe(false)
    }
  })

  test('each claim is checked: type, challenge, origin, cross-origin, rpIdHash, user present, user verified', async () => {
    const a = await authenticator()
    const c: SignInChallenge = { challenge: 'y'.repeat(43), token: '', rpId: RP_ID, expiresAt: '' }
    const reason = async (shape: Shape, expected = { challenge: c.challenge, origin: ORIGIN, rpId: RP_ID }) => {
      const req = await assertion(a, c, shape)
      const r = await checkClaims({ authenticatorData: Buffer.from(req.authenticatorData, 'base64url'), clientDataJSON: Buffer.from(req.clientDataJSON, 'base64url'), signature: Buffer.from(req.signature, 'base64url') }, expected)
      return r.ok ? 'ok' : r.reason
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
    const junk = { authenticatorData: new Uint8Array(37), signature: new Uint8Array(8) }
    expect(await checkClaims({ ...junk, clientDataJSON: enc.encode('not json') }, { challenge: '', origin: ORIGIN, rpId: RP_ID })).toEqual({ ok: false, reason: 'client_data' })
    expect(await checkClaims({ ...junk, clientDataJSON: enc.encode('[]') }, { challenge: '', origin: ORIGIN, rpId: RP_ID })).toEqual({ ok: false, reason: 'client_data' })
    const short = await assertion(a, c)
    expect(await checkClaims({ authenticatorData: new Uint8Array(36), clientDataJSON: Buffer.from(short.clientDataJSON, 'base64url'), signature: new Uint8Array(8) }, { challenge: c.challenge, origin: ORIGIN, rpId: RP_ID })).toEqual({ ok: false, reason: 'auth_data' })
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
    const made = await beta('/api/onboarding/owner', { passkey: b.owner })
    const fresh = (await (await beta('/api/auth/challenge', {})).json()) as SignInChallenge
    const ok = await beta('/api/auth/signin', await assertion(b, fresh, { rpId: 'beta.mamoru.lol', origin: BETA }))
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as SessionView).accountKey).toBe(((await made.json()) as OwnerResponse).accountKey)
  })

  test('a credential id registered again with another key never opens the first account', async () => {
    const h = harness()
    const victim = await authenticator()
    const v = await onboard(h, victim)
    const squatter = await authenticator(victim.owner.credentialId)
    const s = await onboard(h, squatter)
    expect(s.owner.accountKey).not.toBe(v.owner.accountKey)
    expect(((await (await attempt(h, victim)).json()) as SessionView).accountKey).toBe(v.owner.accountKey)
    expect(((await (await attempt(h, squatter)).json()) as SessionView).accountKey).toBe(s.owner.accountKey)
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

describe('sign-in rate limit', () => {
  test('per credential: after 10 attempts in the window even a good assertion waits', async () => {
    let now = new Date('2026-10-01T10:00:00Z')
    const h = harness(() => now)
    const a = await authenticator()
    await onboard(h, a)
    for (let i = 0; i < SIGNIN_LIMITS.perCredential; i++) await expectRefused(await attempt(h, a, { flags: 0x01 }, `198.51.100.${i}`))
    const limited = await attempt(h, a, {}, '198.51.100.200')
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { code: string }).code).toBe('AUTH_RATE_LIMITED')
    expect(limited.headers.get('set-cookie')).toBeNull()
    // Another credential is not affected; the next window opens the first one again.
    const b = await authenticator()
    await onboard(h, b)
    expect((await attempt(h, b, {}, '198.51.100.201')).status).toBe(200)
    now = new Date(now.getTime() + SIGNIN_LIMITS.windowSeconds * 1000)
    expect((await attempt(h, a, {}, '198.51.100.200')).status).toBe(200)
  })

  test('per IP: after 20 attempts one address is refused whatever it sends, another address is not', async () => {
    const h = harness(() => new Date('2026-10-01T10:00:00Z'))
    const a = await authenticator()
    await onboard(h, a)
    for (let i = 0; i < SIGNIN_LIMITS.perIp; i++) await expectRefused(await attempt(h, await authenticator(), {}, '203.0.113.50'))
    expect((await attempt(h, a, {}, '203.0.113.50')).status).toBe(429)
    expect((await signIn(h, {}, '203.0.113.50')).status).toBe(429)
    expect((await attempt(h, a, {}, '203.0.113.51')).status).toBe(200)
  })

  test('counters hold no raw IP or credential id, and old windows are dropped', async () => {
    const t0 = new Date('2026-10-01T10:00:00Z')
    const h = harness(() => t0)
    const key = await rateKey('ip', '203.0.113.50', SECRET)
    expect(key).toMatch(/^ip:[0-9a-f]{32}$/)
    expect(await rateKey('ip', '203.0.113.50', `${SECRET}x`)).not.toBe(key)
    expect(await rateKey('cred', 'abc')).toMatch(/^cred:[0-9a-f]{32}$/)
    expect(await allow(h.db, key, 2, t0)).toBe(true)
    expect(await allow(h.db, key, 2, t0)).toBe(true)
    expect(await allow(h.db, key, 2, t0)).toBe(false)
    expect(await allow(h.db, key, 2, new Date(t0.getTime() + SIGNIN_LIMITS.windowSeconds * 1000))).toBe(true)
    expect(h.db.raw.query('SELECT key, count FROM auth_rate').all()).toEqual([{ key, count: 1 }])
  })
})
