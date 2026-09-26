import { describe, expect, test } from 'bun:test'
import { ReasonError } from '@mamoru/domain'
import { anvilArgv, assertAnvilVersion, assertForkBlock, assertLabChainId, assertNoKeyInArgv } from './anvil.ts'

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof ReasonError) return e.code
    throw e
  }
  return 'NONE'
}

const base = { forkUrl: 'http://127.0.0.1:40000', forkBlock: 51811000, chainId: 31337, slotsInAnEpoch: 2, logPath: '/dev/null' }

describe('lab guards', () => {
  test('Base and Base Sepolia chain ids are refused', () => {
    expect(code(() => assertLabChainId(8453))).toBe('LAB_CHAIN_ID_FORBIDDEN')
    expect(code(() => assertLabChainId(84532))).toBe('LAB_CHAIN_ID_FORBIDDEN')
    expect(code(() => assertLabChainId(31337))).toBe('NONE')
    expect(code(() => anvilArgv({ ...base, chainId: 8453 }, 1))).toBe('LAB_CHAIN_ID_FORBIDDEN')
  })

  test('a fork without a block is refused', () => {
    expect(code(() => assertForkBlock(undefined))).toBe('LAB_BLOCK_REQUIRED')
    expect(code(() => anvilArgv({ ...base, forkBlock: undefined as never }, 1))).toBe('LAB_BLOCK_REQUIRED')
  })

  test('keyed or remote URLs never reach argv', () => {
    for (const url of [
      'https://base-mainnet.g.alchemy.com/v2/abcdef',
      'https://mainnet.base.org',
      'http://user:pass@127.0.0.1:8545',
      'http://127.0.0.1:8545/?key=abc',
      'http://127.0.0.1:8545/v2/abc',
    ]) {
      expect(code(() => assertNoKeyInArgv(['--fork-url', url]))).toBe('LAB_KEY_IN_ARGV')
    }
    expect(code(() => assertNoKeyInArgv(['--fork-url', 'http://127.0.0.1:40000']))).toBe('NONE')
  })

  test('the value of RPC_URL is refused wherever it appears', () => {
    const prev = process.env.MAMORU_TEST_SECRET
    process.env.MAMORU_TEST_SECRET = 'not-a-url-but-secret'
    try {
      expect(code(() => assertNoKeyInArgv(['--x', 'prefix-not-a-url-but-secret'], ['MAMORU_TEST_SECRET']))).toBe('LAB_KEY_IN_ARGV')
    } finally {
      if (prev === undefined) delete process.env.MAMORU_TEST_SECRET
      else process.env.MAMORU_TEST_SECRET = prev
    }
  })

  test('anvil version must match the pin exactly', () => {
    const pin = { version: '1.7.1', commit: 'abc', slotsInAnEpoch: 2 }
    expect(code(() => assertAnvilVersion(pin, { version: '1.7.1', commit: 'abc' }))).toBe('NONE')
    expect(code(() => assertAnvilVersion(pin, { version: '1.7.0', commit: 'abc' }))).toBe('LAB_ANVIL_VERSION_MISMATCH')
    expect(code(() => assertAnvilVersion(pin, { version: '1.7.1', commit: 'def' }))).toBe('LAB_ANVIL_VERSION_MISMATCH')
  })
})
