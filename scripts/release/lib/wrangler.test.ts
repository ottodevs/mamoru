// CLOUDFLARE_ENV must never leak into a wrangler child process: wrangler falls back to it when
// `--env` is not explicit, which could silently redirect a prod deploy at a named environment.
import { describe, expect, it } from 'bun:test'
import { childEnv, rollbackCommand } from './wrangler.ts'

describe('childEnv', () => {
  it('drops CLOUDFLARE_ENV', () => {
    const env = childEnv({ CLOUDFLARE_ENV: 'beta', PATH: '/usr/bin' })
    expect(env.CLOUDFLARE_ENV).toBeUndefined()
    expect('CLOUDFLARE_ENV' in env).toBe(false)
  })
  it('keeps every other variable untouched', () => {
    const env = childEnv({ CLOUDFLARE_ENV: 'beta', PATH: '/usr/bin', HOME: '/home/otto' })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/otto')
  })
  it('is a no-op when CLOUDFLARE_ENV was never set', () => {
    const env = childEnv({ PATH: '/usr/bin' })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})

describe('rollbackCommand', () => {
  it('quotes the empty top-level environment so a pasted shell does not shift v1 into --env', () => {
    expect(rollbackCommand('/repo/apps/mamoru-app', '', 'v1')).toBe('(cd /repo/apps/mamoru-app && bunx wrangler rollback --env "" v1)')
  })
  it('names the environment for beta', () => {
    expect(rollbackCommand('/repo/apps/mamoru-app', 'beta', 'v1')).toBe('(cd /repo/apps/mamoru-app && bunx wrangler rollback --env beta v1)')
  })
})
