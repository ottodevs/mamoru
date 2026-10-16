/**
 * Which environment an account belongs to, from the hostname that served the onboarding request
 * (otto/mamoru#130). app.mamoru.lol and beta.mamoru.lol run the same Worker code against the same D1
 * (apps/mamoru-app/wrangler.jsonc's `env.beta`); MODE is "production" on both, so the hostname is the
 * only signal. Fail-closed: ONLY the exact prod hostname is ever 'prod'. ONLY the exact beta hostname is
 * ever 'beta'. Anything else — a Cloudflare preview (*.workers.dev), a staging/mirror domain, local dev,
 * a trailing-dot FQDN, or a spoofed Host header — is refused outright (null): there is no default, and a
 * wrong default must never mislabel a stray host as prod (or as beta).
 *
 * This column records only WHERE an account was created (the onboarding host), nothing more. It is not,
 * and is never meant to be, a record of where that account is later *used*: app.mamoru.lol and
 * beta.mamoru.lol share this D1 and chain_id, so a beta-created account that later signs in from
 * app.mamoru.lol keeps env = 'beta' forever, and vice versa. Attributing *activity* (sign-ins, LP actions)
 * to the host it happened on, rather than to the account's origin host, is explicitly out of scope for
 * otto/mamoru#130 — accounts.env answers "where was this born", not "where is this active now".
 */

export const PROD_HOSTNAME = 'app.mamoru.lol'
export const BETA_HOSTNAME = 'beta.mamoru.lol'

export type AccountEnv = 'prod' | 'beta'

/** Lowercase, trailing-dot-stripped: `APP.MAMORU.LOL.` and `app.mamoru.lol` must compare equal. */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

/** null means refused: the caller must not onboard against an unrecognized host. */
export function envOfHostname(hostname: string): AccountEnv | null {
  const normalized = normalizeHostname(hostname)
  if (normalized === PROD_HOSTNAME) return 'prod'
  if (normalized === BETA_HOSTNAME) return 'beta'
  return null
}
