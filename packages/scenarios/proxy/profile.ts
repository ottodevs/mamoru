// otto/mamoru#273: the recorded provider profiles and the guard that keeps them honest.
import monad from './profiles/monad.json' with { type: 'json' }
import { assertProfileFresh, type ChainProfile, type Emulation, type EndpointProfile } from './emulate.ts'

const PROFILES: Record<string, ChainProfile> = { monad: monad as ChainProfile }

export function loadProfile(chain: string): ChainProfile {
  const p = PROFILES[chain]
  if (!p) throw new Error(`no recorded RPC profile for ${chain} (have: ${Object.keys(PROFILES).join(', ')})`)
  return p
}

/**
 * The emulation for one endpoint of a chain's profile. Throws PROFILE_STALE past 7 days: the profile-backed e2e uses this.
 * otto/mamoru#365: `MAMORU_PROFILE_AGE=warn` (CI on every PR) only says so, so a calendar date never blocks a merge; the
 * nightly run keeps the refusal (#366).
 */
export function freshEmulation(chain: string, endpoint: string, chaos: Emulation['chaos'] = {}, now = new Date()): Emulation {
  const p = loadProfile(chain)
  try {
    assertProfileFresh(p, now)
  } catch (e) {
    if (process.env.MAMORU_PROFILE_AGE !== 'warn') throw e
    console.warn(`[profile] ${(e as Error).message} (MAMORU_PROFILE_AGE=warn: going on)`)
  }
  const ep: EndpointProfile | undefined = p.endpoints[endpoint]
  if (!ep) throw new Error(`profile ${chain} has no endpoint ${endpoint} (have: ${Object.keys(p.endpoints).join(', ')})`)
  return { endpoint: ep, chaos }
}
