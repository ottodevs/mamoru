import type { SessionView, SignInChallenge } from '@mamoru/domain'
import { ApiRequestError, type ApiClient } from '../api/client.ts'
import { base64url, PasskeyError } from './passkey.ts'
import { base64urlDecode, isPasskeyCancel, knownCredentials, rememberCredential } from './passkey-sign.ts'

export const signInCopy = {
  link: 'I already have an account',
  step: 'Sign in',
  title: 'Open your account',
  body: 'Use the passkey you created it with. This only signs you in. No money moves.',
  act: 'Sign in with passkey',
  waiting: 'Waiting for passkey',
  remembered: 'Try the passkey this browser used before',
  create: 'Create a new account',
  cancelled: 'No passkey was used, so you are not signed in.',
  refused: 'That passkey does not open a Mamoru account on this site. Choose the passkey you created your account with.',
  refusedFunds: 'Your funds are not affected. They are in your account on Base, and your passkey with your recovery kit can withdraw them without Mamoru.',
  refusedLink: 'How to withdraw with the recovery kit',
  limited: 'Too many attempts. Wait a few minutes and try again.',
  unsupported: 'This browser does not support passkeys. Open Mamoru in the browser that holds your passkey.',
  failed: 'Mamoru did not answer. Try again.',
  helpTitle: 'No passkey on this device?',
  help: 'Passkeys sync through your Apple, Google or password manager account. Sign in to that account on this device, or choose another device in the passkey prompt and scan the code with the phone that has it.',
  kit: 'The recovery kit cannot sign you in: it holds no key. With it, your passkey can still take everything out without Mamoru.',
  kitLink: 'How the recovery kit works',
}

export const WALKAWAY_URL = 'https://github.com/ottodevs/mamoru/blob/main/docs/walkaway.md'

export type SignInProblem = { kind: 'cancelled' | 'refused' | 'limited' | 'unsupported' | 'failed'; message: string }

/** What went wrong, in the app's words. A closed prompt and "no passkey here" are the same error to the browser. */
export function signInProblem(e: unknown): SignInProblem {
  if (isPasskeyCancel(e)) return { kind: 'cancelled', message: signInCopy.cancelled }
  if (e instanceof PasskeyError) return { kind: 'unsupported', message: e.message }
  if (e instanceof ApiRequestError && e.status === 429) return { kind: 'limited', message: signInCopy.limited }
  if (e instanceof ApiRequestError && e.status === 401) return { kind: 'refused', message: signInCopy.refused }
  return { kind: 'failed', message: signInCopy.failed }
}

export function challengeUsable(c: SignInChallenge | undefined, now = Date.now()): c is SignInChallenge {
  // Half a minute of margin: the prompt and the round trip take time.
  return c !== undefined && Date.parse(c.expiresAt) - now > 30_000
}

/**
 * Returning owner: the passkey signs a one-time server challenge and the API binds this device to its account.
 * With no `only`, the browser offers every passkey it has for this site (discoverable credentials).
 */
export async function signInWithPasskey(api: ApiClient, challenge: SignInChallenge, only: string[] = []): Promise<SessionView> {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) throw new PasskeyError(signInCopy.unsupported)
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: base64urlDecode(challenge.challenge) as BufferSource,
      allowCredentials: only.map((id) => ({ type: 'public-key' as const, id: base64urlDecode(id) as BufferSource })),
      userVerification: 'required',
      rpId: location.hostname,
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null
  if (!assertion) throw new PasskeyError('No passkey answered. Try again.')
  const r = assertion.response as AuthenticatorAssertionResponse
  const credentialId = base64url(assertion.rawId)
  const session = await api.signIn({
    token: challenge.token,
    credentialId,
    authenticatorData: base64url(r.authenticatorData),
    clientDataJSON: base64url(r.clientDataJSON),
    signature: base64url(r.signature),
  })
  if (session.accountKey) rememberCredential(session.accountKey, credentialId)
  return session
}

export { knownCredentials }
