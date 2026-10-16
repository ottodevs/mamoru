import { describe, expect, test } from 'bun:test'
import { envOfHostname } from '../../src/api/accounts/env-of-host.ts'

describe('envOfHostname', () => {
  test('the beta hostname, and only it, is beta', () => {
    expect(envOfHostname('beta.mamoru.lol')).toBe('beta')
  })

  test('everything else, including app.mamoru.lol, previews and local dev, is prod', () => {
    for (const host of ['app.mamoru.lol', 'mamoru.lol', 'localhost', '127.0.0.1', 'BETA.MAMORU.LOL', 'beta.mamoru.lol.evil.example']) {
      expect(envOfHostname(host)).toBe('prod')
    }
  })
})
