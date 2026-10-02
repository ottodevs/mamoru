import { Hono, type Context } from 'hono'
import type { SessionView, SignInChallenge } from '@mamoru/domain'
import type { AppEnv } from '../context.ts'
import { apiError } from '../errors.ts'
import { accountByCredential, advanceSignCount, type AccountRow } from '../accounts/store.ts'
import { issueChallenge, openChallenge, spendChallenge } from './challenge.ts'
import { SIGNIN_LIMITS, allow, count, countNothing, credentialKey, ipKey } from './rate-limit.ts'
import { assertionShape } from '@mamoru/account/live'
import { DECOY_KEY, checkClaims, decodeB64url, signCountOf, verifyP256 } from './webauthn.ts'

// Returning owner (otto/mamoru#6): a device without a session proves it holds the passkey that owns an account, and
// gets the same device session onboarding gives. No new authority: owner transactions still need a passkey signature each.

const MAX_BODY_BYTES = 8 * 1024
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,1023}$/

/** One answer for every refusal: the caller never learns which check failed, or whether the credential exists. */
const refused = (c: Context, why: string) => {
  console.log(`signin refused: ${why}`)
  return apiError(c, 401, 'Sign-in failed.', 'AUTH_SIGNIN_FAILED')
}
const slowDown = (c: Context) => apiError(c, 429, 'Too many sign-in attempts. Wait a few minutes and try again.', 'AUTH_RATE_LIMITED')

/** The site this request was served on. app.mamoru.lol and beta.mamoru.lol are different RP IDs and stay separate identities. */
function site(c: Context): { origin: string; rpId: string } {
  const url = new URL(c.req.url)
  return { origin: url.origin, rpId: url.hostname }
}

export const signIn = new Hono<AppEnv>()

signIn.post('/challenge', async (c) => {
  const { rpId } = site(c)
  const issued = await issueChallenge(c.var.settings.sessionSecret, rpId, c.var.now())
  const body: SignInChallenge = { ...issued, rpId }
  return c.json(body)
})

signIn.post('/signin', async (c) => {
  const now = c.var.now()
  const db = c.env.DB
  const secret = c.var.settings.sessionSecret
  const { origin, rpId } = site(c)

  // Cloudflare sets cf-connecting-ip; without it (tests, local dev) every caller shares one bucket.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  if (!(await allow(db, await ipKey(secret, ip), SIGNIN_LIMITS.perIp, now))) return slowDown(c)

  if (Number(c.req.header('content-length') ?? '0') > MAX_BODY_BYTES) return refused(c, 'body')
  const text = await c.req.text()
  if (text.length > MAX_BODY_BYTES) return refused(c, 'body')
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refused(c, 'body')
    body = parsed as Record<string, unknown>
  } catch {
    return refused(c, 'body')
  }
  const credentialId = body.credentialId
  const authenticatorData = decodeB64url(body.authenticatorData, 2048)
  const clientDataJSON = decodeB64url(body.clientDataJSON, 4096)
  const signature = decodeB64url(body.signature, 256)
  if (typeof credentialId !== 'string' || !CREDENTIAL_ID.test(credentialId) || !authenticatorData || !clientDataJSON || !signature) return refused(c, 'body')

  const opened = await openChallenge(secret, rpId, body.token, now)
  if (!opened) return refused(c, 'challenge token')
  // Spent before anything is verified: one challenge is one attempt, and a captured assertion cannot be sent again.
  if (!(await spendChallenge(db, opened.challenge, opened.exp, now))) return refused(c, 'challenge replayed')

  // From here on every request does the same work whatever is wrong with it: the claims are evaluated, the account
  // row is read, one P-256 verification runs (against the decoy key when no account has this credential), and the
  // outcome is decided at the end. A caller cannot tell an unknown credential from a wrong key or a refused flag by
  // the status, the body, or what the request cost.
  const claims = await checkClaims({ authenticatorData, clientDataJSON, signature }, { challenge: opened.challenge, origin, rpId })
  const row = await accountByCredential(db, c.var.settings.chainId, credentialId)
  const verified = await verifyP256(row ? { x: row.passkey_x, y: row.passkey_y } : DECOY_KEY, claims.signed, signature)
  const account: AccountRow | null = row && verified ? row : null

  let why: string | null = claims.reason ?? (account ? null : row ? 'signature' : 'credential')
  if (!why && account) {
    // Signature counter (WebAuthn 7.2 step 22). Synced passkeys always report 0 and are accepted. Once a counter was
    // seen, it must increase: one that does not is a second copy of the authenticator, and that assertion is refused.
    const seen = signCountOf(authenticatorData)
    const stored = account.passkey_sign_count ?? 0
    if ((seen !== 0 || stored !== 0) && !(seen > stored && (await advanceSignCount(db, account.account_key, seen)))) {
      console.warn(`signin: signature counter did not increase for account ${account.account_key} (stored ${stored}, got ${seen})`)
      why = 'sign count'
    }
  }
  if (why || !account) {
    // Failures are counted per credential only here (complete assertion, valid challenge) and only for credentials that
    // exist; the count is for the log and never refuses anyone. An unknown credential runs the same statements on no row.
    const key = await credentialKey(credentialId)
    if (row) {
      const failures = await count(db, key, now)
      if (failures === SIGNIN_LIMITS.credentialFailuresLogged) console.warn(`signin: ${failures} failed attempts on one credential in ${SIGNIN_LIMITS.windowSeconds / 60} minutes`)
    } else await countNothing(db, key, now)
    // This check has no chain to overrule it, so it stays strict; a false refusal blocks sign-in, never funds. The
    // non-secret shape of the assertion is logged so a real device that is refused can be diagnosed.
    return refused(c, `${why ?? 'credential'} ${JSON.stringify(assertionShape({ authenticatorData, clientDataJSON, signature }))}`)
  }

  const session = await c.var.auth.bind(c, account.user_id)
  c.set('accountKey', account.account_key)
  const view: SessionView = { ...session, accountKey: account.account_key }
  return c.json(view)
})
