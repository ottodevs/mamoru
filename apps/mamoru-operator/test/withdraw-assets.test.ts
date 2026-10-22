// otto/mamoru#140 (part1 #7): withdrawAssets() caught the quote error and interpolated its raw `.message` into the
// client-facing `reason`. viem's HttpRequestError carries the full RPC URL (API key included) in that message —
// exactly the class of leak operator.ts's own SAFE_ERROR_MESSAGE comment says must never reach a client. Confirms
// the reason is now a fixed string and the real error only goes to the (redacted) journal.
import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { POLICIES } from '@mamoru/policy'
import { Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'
import { baseRegistry } from '@mamoru/registry'

const SECRET_URL = 'https://base-mainnet.g.alchemy.com/v2/SUPER_SECRET_KEY_123'

function world() {
  const client = { getBlockNumber: async () => 1n } as unknown as PublicClient
  const relayer = { address: `0x${'7'.repeat(40)}` } as unknown as Relayer
  const store = { state: { accounts: {} as Record<string, AccountState> }, save: () => {} } as unknown as StateStore
  const cfg = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 } satisfies OperatorConfig
  return new Operator(cfg, client, relayer, store)
}

describe('withdrawAssets() never forwards a raw exception message to the client', () => {
  test('a quote failure carrying an RPC URL and key is reduced to a fixed reason', async () => {
    const op = world()
    // Stands in for receiveQuote hitting a real viem HttpRequestError, whose .message embeds the RPC URL.
    ;(op as unknown as { receiveQuote: () => Promise<never> }).receiveQuote = async () => {
      throw new Error(`HTTP request failed.\nURL: ${SECRET_URL}\nStatus: 401`)
    }
    const { assets } = await op.withdrawAssets()
    const unavailable = assets.filter((a) => !a.available)
    expect(unavailable.length).toBeGreaterThan(0)
    for (const a of unavailable) {
      expect(a.reason).toBeDefined()
      expect(a.reason).not.toContain('SUPER_SECRET_KEY_123')
      expect(a.reason).not.toContain('alchemy.com')
      expect(a.reason).not.toContain('URL:')
    }
    expect(JSON.stringify(assets)).not.toContain('SUPER_SECRET_KEY_123')
  })

  test('USDC is never quoted (always available, no reason) regardless of the failure', async () => {
    const op = world()
    ;(op as unknown as { receiveQuote: () => Promise<never> }).receiveQuote = async () => {
      throw new Error(SECRET_URL)
    }
    const { assets } = await op.withdrawAssets()
    expect(assets.find((a) => a.asset === 'USDC')).toEqual({ asset: 'USDC', available: true })
  })
})
