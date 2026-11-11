import { describe, expect, test } from 'bun:test'
import { DEFAULT_FORK_BLOCK, forkBlockArgs, PUBLIC_BASE_RPC, useBaseForkRpc } from './fork-upstream.ts'

const KEYED = 'https://x.base-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef01234567/'
const NO_FILE = '/nonexistent/mamoru-env'

describe('e2e fork upstream', () => {
  test('by default the public RPC is used, whatever RPC_URL and BASE_RPC_URL hold', () => {
    const env: Record<string, string | undefined> = { RPC_URL: KEYED, BASE_RPC_URL: KEYED }
    useBaseForkRpc(env, NO_FILE)
    expect(env.RPC_URL).toBe(PUBLIC_BASE_RPC)
    const own: Record<string, string | undefined> = { BASE_FORK_RPC_URL: 'https://base-rpc.publicnode.com', BASE_RPC_URL: KEYED }
    useBaseForkRpc(own, NO_FILE)
    expect(own.RPC_URL).toBe('https://base-rpc.publicnode.com')
  })

  test('the keyed URL is used only with E2E_ALLOW_KEYED=1', () => {
    const env: Record<string, string | undefined> = { E2E_ALLOW_KEYED: '1', BASE_RPC_URL: KEYED }
    useBaseForkRpc(env, NO_FILE)
    expect(env.RPC_URL).toBe(KEYED)
    expect(() => useBaseForkRpc({ E2E_ALLOW_KEYED: '1' }, NO_FILE)).toThrow('E2E_ALLOW_KEYED')
    const yes: Record<string, string | undefined> = { E2E_ALLOW_KEYED: 'yes', BASE_RPC_URL: KEYED }
    useBaseForkRpc(yes, NO_FILE)
    expect(yes.RPC_URL).toBe(PUBLIC_BASE_RPC)
  })

  test('the fork is pinned to a block, E2E_FORK_BLOCK changes it', () => {
    expect(forkBlockArgs({})).toEqual(['--fork-block-number', DEFAULT_FORK_BLOCK])
    expect(forkBlockArgs({ E2E_FORK_BLOCK: '123' })).toEqual(['--fork-block-number', '123'])
  })
})
