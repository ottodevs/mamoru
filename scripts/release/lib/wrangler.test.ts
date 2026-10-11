// CLOUDFLARE_ENV must never leak into a wrangler child process: wrangler falls back to it when
// `--env` is not explicit, which could silently redirect a prod deploy at a named environment.
import { describe, expect, it } from 'bun:test'
import { childEnv, rollbackCommand, describeFailure } from './wrangler.ts'

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
    expect(rollbackCommand('/repo/apps/mamoru-app', '', 'v1')).toBe("(cd '/repo/apps/mamoru-app' && bunx wrangler rollback --env '' 'v1')")
  })
  it('names the environment for beta', () => {
    expect(rollbackCommand('/repo/apps/mamoru-app', 'beta', 'v1')).toBe("(cd '/repo/apps/mamoru-app' && bunx wrangler rollback --env 'beta' 'v1')")
  })
  it('quotes shell metacharacters in the path and the version id', () => {
    expect(rollbackCommand("/re po/$(x)/it's", '', 'v1; rm -rf ~')).toBe("(cd '/re po/$(x)/it'\\''s' && bunx wrangler rollback --env '' 'v1; rm -rf ~')")
  })
})

describe('describeFailure', () => {
  it('prints what the failed command said, not only its exit code (otto/mamoru#47)', () => {
    const text = describeFailure({ exitCode: 1, stdout: Buffer.from('Uploading...\n'), stderr: Buffer.from('✘ [ERROR] A request to the Cloudflare API failed.\n') })
    expect(text).toContain('exit code 1')
    expect(text).toContain('Uploading...')
    expect(text).toContain('A request to the Cloudflare API failed.')
  })
  it('falls back to the message of an ordinary error', () => {
    expect(describeFailure(new Error('snapshot failed'))).toBe('snapshot failed')
    expect(describeFailure('boom')).toBe('boom')
  })
})
