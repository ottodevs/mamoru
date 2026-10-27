// otto/mamoru#215: MAMORU_MONAD_RPC_URL is the Base operator's only, and must answer Monad with CCTP domain 15.
import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { baseRegistry, monadRegistry } from '@mamoru/registry'
import { assertBaseOnlyFeatures, checkMonadRpc } from '../src/boot.ts'

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
})
