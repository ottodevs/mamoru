import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { POLICIES } from '@mamoru/policy'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { Engine } from './engine.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const policy = POLICIES['conservador-live-v2']!
const POOL = 'pool:USDC/USDT/100'
const WINDOW = BigInt(policy.execution.twapWindowSeconds)

/** An engine whose pool reads answer `spotTick` for slot0 and `twapTick` for the policy window, or fail observe. */
function engineAt(spotTick: number, twapTick: number | null) {
  const e = new Engine(
    { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: 'http://127.0.0.1:9/', bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey: privateKeyToAccount(generatePrivateKey()), nonceLane: 0, depositsAfter: 0n, historyFromBlock: 0n, sessions: [] },
    { waitBlock: async () => {} },
  )
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'slot0') return [sqrtRatioAtTick(spotTick), spotTick, 0, 0, 0, 0, true]
      if (functionName === 'observe') {
        if (twapTick === null) throw new Error('execution reverted: OLD')
        return [[0n, BigInt(twapTick) * WINDOW], [0n, 0n]]
      }
      throw new Error(`unexpected read ${functionName}`)
    },
  } as unknown as PublicClient
  ;(e as unknown as { client: PublicClient }).client = client
  return e as unknown as {
    priceGuard(pool: string, block: bigint): Promise<number>
    swapMin(pool: string, tokenIn: string, amountIn: bigint, amountOut: bigint, block: bigint): Promise<bigint>
  }
}

describe('engine prices at the prepare block against the TWAP (otto/mamoru#140)', () => {
  test('a spot within the policy deviation passes and returns the TWAP tick', async () => {
    expect(await engineAt(40, 0).priceGuard(POOL, 1n)).toBe(0)
  })

  test('a spot moved past the deviation at the prepare block is refused', async () => {
    await expect(engineAt(101, 0).priceGuard(POOL, 1n)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
    await expect(engineAt(-101, 0).priceGuard(POOL, 1n)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
  })

  test('a pool that cannot answer for the window refuses the operation', async () => {
    await expect(engineAt(0, null).priceGuard(POOL, 1n)).rejects.toMatchObject({ code: 'EHG_TWAP_UNAVAILABLE' })
  })

  test('the swap minimum is never under the TWAP floor, and a quote under it is refused', async () => {
    const e = engineAt(0, 0)
    // USDC -> USDT at tick 0: one raw unit for one, 0.01% fee.
    expect(await e.swapMin(POOL, 'USDC', 1_000_000n, 999_900n, 1n)).toBe(994_900n)
    const held = await e.swapMin(POOL, 'USDC', 1_000_000n, 989_000n, 1n)
    expect(held).toBeGreaterThan(985_000n)
    expect(held).toBeGreaterThan((989_000n * 9_950n) / 10_000n)
    await expect(e.swapMin(POOL, 'USDC', 1_000_000n, 950_000n, 1n)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
  })
})
