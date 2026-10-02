import { Hono, type Context } from 'hono'
import type { OwnerResponse, SignInChallenge } from '@mamoru/domain'
import { conservadorV1 } from '@mamoru/policy'
import { recoveryKit } from '@mamoru/account/recovery'
import type { AppEnv } from '../context.ts'
import { accountNotFound, apiError } from '../errors.ts'
import { deleteCookie } from 'hono/cookie'
import { SESSION_COOKIE } from '../auth/device-session.ts'
import { acknowledgeRecovery, accountByCredential, accountOfUser, insertAccount, ownedAccount, ownersOf, type AccountRow } from '../accounts/store.ts'
import { ACCOUNT_KEY, counterfactualAccount, passkeySigner } from './account.ts'
import { parsePasskey } from './passkey.ts'
import { issueChallenge, openChallenge, spendChallenge } from '../auth/challenge.ts'
import { ONBOARDING_PER_IP, allow, ipKey } from '../auth/rate-limit.ts'
import { checkRegistration } from '../auth/registration.ts'
import { decodeB64url } from '../auth/webauthn.ts'

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return null
  const body: unknown = await c.req.json().catch(() => null)
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

function ownerResponse(row: AccountRow): OwnerResponse {
  return { accountKey: row.account_key, chainId: row.chain_id, address: row.address, owners: ownersOf(row), deployed: false }
}

export const onboarding = new Hono<AppEnv>()

/** One answer when the passkey cannot be registered, whatever the reason: bad proof, spent challenge, or a credential id that already owns an account. */
const notRegistered = (c: Context, why: string) => {
  console.log(`onboarding refused: ${why}`)
  return apiError(c, 400, 'This passkey could not be registered. If you already have an account, sign in with it.', 'ONB_PASSKEY_REFUSED')
}

// The challenge navigator.credentials.create() must carry: single use, 5 minutes, bound to this host. Stores nothing.
onboarding.post('/challenge', async (c) => {
  const rpId = new URL(c.req.url).hostname
  const body: SignInChallenge = { ...(await issueChallenge(c.var.settings.sessionSecret, rpId, c.var.now(), 'register')), rpId }
  return c.json(body)
})

// FR-ONB-003/005: the passkey becomes the owner of a counterfactual Safe on Base. Nothing is signed or sent.
// The request carries the registration data the browser produced for a challenge from this server (see auth/registration.ts);
// a credential id owns at most one account per chain, so sign-in finds exactly one row.
onboarding.post('/owner', async (c) => {
  const body = await jsonBody(c)
  if (!body) return apiError(c, 400, 'Send a JSON body with the passkey.')
  const passkey = parsePasskey(body.passkey)
  if (!passkey) return apiError(c, 400, 'The passkey is not a valid P-256 public key with a credential id.')
  // FR-ONB-004: a backup owner needs a signature over an API challenge, which this contract does not carry yet.
  if (body.backupOwner !== undefined) return apiError(c, 400, 'A backup owner needs a signed challenge first.', 'ONB_BACKUP_UNPROVEN')

  const db = c.env.DB
  const now = c.var.now()
  // A session that already has an account: the same passkey is answered again, another one is refused. No proof needed to see your own account.
  const current = await c.var.auth.current(c)
  const existing = current ? await accountOfUser(db, current.userId) : null
  if (existing) {
    c.set('accountKey', existing.account_key)
    if (existing.passkey_credential_id === passkey.credentialId) return c.json(ownerResponse(existing))
    return apiError(c, 409, 'This session already has an account with another passkey.', 'INTENT_REJECTED_STATE')
  }

  // Anonymous from here: bounded per client IP, and nothing is written before the registration data checks out.
  const secret = c.var.settings.sessionSecret
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  if (!(await allow(db, await ipKey(secret, ip, 'onb'), ONBOARDING_PER_IP, now))) {
    return apiError(c, 429, 'Too many accounts from this network. Wait a few minutes and try again.', 'AUTH_RATE_LIMITED')
  }
  const url = new URL(c.req.url)
  const proof = typeof body.proof === 'object' && body.proof !== null ? (body.proof as Record<string, unknown>) : null
  const clientDataJSON = decodeB64url(proof?.clientDataJSON, 4096)
  const authenticatorData = decodeB64url(proof?.authenticatorData, 4096)
  if (!proof || !clientDataJSON || !authenticatorData) return notRegistered(c, 'no proof')
  const opened = await openChallenge(secret, url.hostname, proof.token, now, 'register')
  if (!opened) return notRegistered(c, 'challenge token')
  if (!(await spendChallenge(db, opened.challenge, opened.exp, now))) return notRegistered(c, 'challenge replayed')
  const refusal = await checkRegistration({ clientDataJSON, authenticatorData }, { challenge: opened.challenge, origin: url.origin, rpId: url.hostname }, passkey)
  if (refusal) return notRegistered(c, refusal)
  // One credential id, one account. Checked before a user row or a cookie exists; the unique index settles a race.
  if (await accountByCredential(db, c.var.settings.chainId, passkey.credentialId)) return notRegistered(c, 'credential id already registered')

  const session = await c.var.auth.ensure(c)
  const accountKey = crypto.randomUUID()
  const account = counterfactualAccount(accountKey, passkey)
  const row: AccountRow = {
    account_key: accountKey,
    user_id: session.userId,
    chain_id: c.var.settings.chainId,
    address: account.address,
    owners_json: JSON.stringify(account.owners),
    passkey_credential_id: passkey.credentialId,
    passkey_x: passkey.x,
    passkey_y: passkey.y,
    salt_nonce: account.saltNonce.toString(),
    preset: conservadorV1.preset,
    policy_version: conservadorV1.version,
    recovery_ack_at: null,
    created_at: now.toISOString(),
  }
  if (!(await insertAccount(db, row))) {
    // Lost a race for the same credential id: take back the user row and the cookie this request just made.
    if (!current) {
      await db.prepare('DELETE FROM users WHERE user_id = ?').bind(session.userId).run()
      deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true })
    }
    return notRegistered(c, 'credential id already registered (race)')
  }
  c.set('accountKey', row.account_key)
  return c.json(ownerResponse(row), 201)
})

onboarding.post('/recovery-ack', async (c) => {
  const session = await c.var.auth.current(c)
  if (!session) return apiError(c, 401, 'Sign in first.', 'AUTH_REQUIRED')
  const body = await jsonBody(c)
  const accountKey = body?.accountKey
  if (typeof accountKey !== 'string' || !ACCOUNT_KEY.test(accountKey)) return accountNotFound(c)
  const row = await ownedAccount(c.env.DB, session.userId, accountKey)
  if (!row) return accountNotFound(c)
  c.set('accountKey', row.account_key)
  await acknowledgeRecovery(c.env.DB, accountKey, c.var.now().toISOString())
  return c.json({ ok: true as const })
})

// FR-ONB-006: public data only, rebuilt from the stored owners, saltNonce and passkey, and checked against the stored address.
onboarding.get('/kit', async (c) => {
  const session = await c.var.auth.current(c)
  if (!session) return apiError(c, 401, 'Sign in first.', 'AUTH_REQUIRED')
  const accountKey = c.req.query('accountKey')
  if (!accountKey || !ACCOUNT_KEY.test(accountKey)) return accountNotFound(c)
  const row = await ownedAccount(c.env.DB, session.userId, accountKey)
  if (!row) return accountNotFound(c)
  c.set('accountKey', row.account_key)
  const kit = recoveryKit({ chainId: row.chain_id, owners: ownersOf(row), saltNonce: BigInt(row.salt_nonce), webauthn: passkeySigner(row.passkey_x, row.passkey_y), permissionIds: [], tokenIds: [] })
  if (kit.address.toLowerCase() !== row.address.toLowerCase()) return apiError(c, 500, 'The recovery kit does not match the stored account address.')
  c.header('content-disposition', `attachment; filename="mamoru-recovery-kit-${row.address}.json"`)
  c.header('cache-control', 'no-store')
  return c.json(kit)
})
