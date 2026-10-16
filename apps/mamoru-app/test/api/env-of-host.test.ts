import { describe, expect, test } from 'bun:test'
import { envOfHostname } from '../../src/api/accounts/env-of-host.ts'

describe('envOfHostname', () => {
  test('only the exact prod hostname is prod', () => {
    expect(envOfHostname('app.mamoru.lol')).toBe('prod')
  })

  test('only the exact beta hostname is beta', () => {
    expect(envOfHostname('beta.mamoru.lol')).toBe('beta')
  })

  test('case and a trailing dot never change the answer', () => {
    expect(envOfHostname('APP.MAMORU.LOL')).toBe('prod')
    expect(envOfHostname('app.mamoru.lol.')).toBe('prod')
    expect(envOfHostname('BETA.MAMORU.LOL')).toBe('beta')
    expect(envOfHostname('beta.mamoru.lol.')).toBe('beta')
  })

  test('fail-closed: everything else is refused, never defaulted to prod', () => {
    for (const host of [
      'mamoru.lol',
      'www.mamoru.lol',
      'localhost',
      '127.0.0.1',
      'mamoru-app-beta.workers.dev',
      'beta.mamoru.lol.evil.example',
      'app.mamoru.lol.evil.example',
      'evil.example',
      '',
    ]) {
      expect(envOfHostname(host)).toBeNull()
    }
  })
})
