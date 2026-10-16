/**
 * Which environment an account belongs to, from the hostname that served the onboarding request
 * (otto/mamoru#130). app.mamoru.lol and beta.mamoru.lol run the same Worker code against the same D1
 * (apps/mamoru-app/wrangler.jsonc's `env.beta`); MODE is "production" on both, so the hostname is the
 * only signal. Anything else (a preview, a test harness origin) is treated as prod: there is no third
 * value to fall back to, and a wrong default must never mislabel beta.
 */

export const BETA_HOSTNAME = 'beta.mamoru.lol'

export type AccountEnv = 'prod' | 'beta'

export function envOfHostname(hostname: string): AccountEnv {
  return hostname === BETA_HOSTNAME ? 'beta' : 'prod'
}
