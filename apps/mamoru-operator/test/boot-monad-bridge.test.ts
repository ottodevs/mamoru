// otto/mamoru#215: MAMORU_MONAD_RPC_URL is the Base operator's only, and must answer Monad with CCTP domain 15.
import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { baseRegistry, monadRegistry } from '@mamoru/registry'
import { assertBaseOnlyFeatures, checkMonadRpc, monadMintRefusal, MonadRpcUnreachable } from '../src/boot.ts'

const rpc = (chainId: number, domain: number | Error) =>
  ({
    getChainId: async () => chainId,
    readContract: async () => {
      if (domain instanceof Error) throw domain
      return domain
    },
  }) as unknown as Pick<PublicClient, 'getChainId' | 'readContract'>

describe('the Monad bridge leg at boot', () => {
  test('Base only', () => {
    expect(() => assertBaseOnlyFeatures(baseRegistry, {}, { monadRpcUrl: 'https://monad.example' })).not.toThrow()
    expect(() => assertBaseOnlyFeatures(monadRegistry, {}, { monadRpcUrl: 'https://monad.example' })).toThrow('MAMORU_MONAD_RPC_URL')
  })

  test('chain 143 with MessageTransmitterV2 on domain 15, or the boot is refused without quoting the URL', async () => {
    await expect(checkMonadRpc(rpc(143, 15))).resolves.toBeUndefined()
    await expect(checkMonadRpc(rpc(8453, 15))).rejects.toThrow('not a Monad Mainnet RPC (chain 8453')
    await expect(checkMonadRpc(rpc(143, 6))).rejects.toThrow('domain 6')
    await expect(checkMonadRpc(rpc(143, new Error('https://key@monad.example failed')))).rejects.toThrow('(unreachable)')
    await expect(checkMonadRpc(rpc(143, new Error('https://key@monad.example failed')))).rejects.not.toThrow('key@')
  })

  test('review of #144: Monad unreachable is its own error (the boot goes on, the leg waits); a wrong chain still refuses', async () => {
    const e = await checkMonadRpc(rpc(143, new Error('down'))).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(MonadRpcUnreachable)
    const wrong = await checkMonadRpc(rpc(8453, 15)).catch((x: unknown) => x)
    expect(wrong).not.toBeInstanceOf(MonadRpcUnreachable)
  })

  test('review of #144: mints on Monad only from a live Base operator', () => {
    expect(monadMintRefusal({ chainId: 8453, live: true })).toBeNull()
    expect(monadMintRefusal({ chainId: 8453, live: false })).toContain('MAMORU_LIVE')
    expect(monadMintRefusal({ chainId: 143, live: true })).toContain('Base operator only')
  })
})
