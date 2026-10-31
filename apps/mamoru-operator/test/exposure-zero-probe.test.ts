// otto/mamoru#250: the peer check at boot asks each peer for the exposure of the zero address. Reading it reverted
// (ERC-721 balanceOf(0) on the position manager), the peer answered 503 and every boot logged a false [alert].
import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { baseRegistry } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'

function opWith(client: Partial<PublicClient>) {
  const relayer = { address: `0x${'7'.repeat(40)}` } as unknown as Relayer
  const store = { state: { accounts: {} as Record<string, AccountState> }, save: () => {} } as unknown as StateStore
  const cfg = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 } satisfies OperatorConfig
  return new Operator(cfg, client as PublicClient, relayer, store)
}

describe('exposureFor(0x0): the peer probe', () => {
  test('answers an empty exposure at the current block, reading no token', async () => {
    const reads: string[] = []
    const client = {
      getBlockNumber: async () => 123n,
      readContract: (async () => { reads.push('readContract'); throw new Error('balanceOf reverted') }) as never,
      multicall: (async () => { reads.push('multicall'); throw new Error('balanceOf reverted') }) as never,
    }
    const zero = `0x${'0'.repeat(40)}` as const
    expect(await opWith(client).exposureFor(zero)).toEqual({ chainId: 8453, address: zero, block: '123', idleUsdc: '0', placedUsdc: '0', active: false })
    expect(reads).toEqual([])
  })

  test('an RPC that cannot answer still fails the probe', async () => {
    const client = { getBlockNumber: async () => { throw new Error('rpc down') } }
    await expect(opWith(client).exposureFor(`0x${'0'.repeat(40)}`)).rejects.toThrow('rpc down')
  })
})
