import { describe, expect, test } from 'bun:test'
import { assertNotKeyed, startForkProxy } from './index.ts'

const KEYED = 'https://example-name.base-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef01234567/'

describe('fork proxy upstream', () => {
  test('a keyed provider is refused unless E2E_ALLOW_KEYED=1, and the URL is not in the message', () => {
    let message = ''
    try {
      assertNotKeyed(KEYED, 'RPC_URL', {})
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('RPC_URL')
    expect(message).not.toContain('0123456789abcdef')
    expect(message).not.toContain('quiknode')
    expect(() => assertNotKeyed(KEYED, 'RPC_URL', { E2E_ALLOW_KEYED: '1' })).not.toThrow()
    expect(() => assertNotKeyed(KEYED, 'RPC_URL', { E2E_ALLOW_KEYED: 'true' })).toThrow()
  })

  test('public and local upstreams are accepted', () => {
    for (const url of ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'http://127.0.0.1:8545/', 'not a url']) expect(() => assertNotKeyed(url, 'RPC_URL', {})).not.toThrow()
  })

  test('startForkProxy refuses a keyed upstream from the environment', () => {
    const before = { url: process.env.E2E_FORK_TEST_URL, allow: process.env.E2E_ALLOW_KEYED }
    delete process.env.E2E_ALLOW_KEYED
    process.env.E2E_FORK_TEST_URL = KEYED
    try {
      expect(() => startForkProxy('E2E_FORK_TEST_URL')).toThrow('keyed provider')
    } finally {
      if (before.url === undefined) delete process.env.E2E_FORK_TEST_URL
      else process.env.E2E_FORK_TEST_URL = before.url
      if (before.allow !== undefined) process.env.E2E_ALLOW_KEYED = before.allow
    }
  })
})
