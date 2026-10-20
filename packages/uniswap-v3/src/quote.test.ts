import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, isAddressEqual, type Hex, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, monadRegistry, nameOf, type Registry } from '@mamoru/registry'
import { minOut, quoteExactInputSingle, quoteMint, quoterV2, quoterV2Abi, rangeAround, sqrtRatioAtTick, token0InToken1, token1InToken0 } from './quote.ts'
import { uniswapV3 } from './index.ts'

/** A client that records the eth_call and answers a fixed quote. */
function fakeClient(amountOut: bigint) {
  const calls: { to?: Address; data?: Hex; blockNumber?: bigint }[] = []
  const client = {
    call: async (args: { to?: Address; data?: Hex; blockNumber?: bigint }) => {
      calls.push(args)
      return { data: encodeFunctionResult({ abi: quoterV2Abi, functionName: 'quoteExactInputSingle', result: [amountOut, 0n, 0, 0n] }) }
    },
  } as unknown as PublicClient
  return { client, calls }
}

describe('quoterV2(registry)', () => {
  const req = (r: Registry) => ({ tokenIn: address('USDC', r), tokenOut: address(r === monadRegistry ? 'WMON' : 'WETH', r), fee: 3000, amountIn: 10n ** 6n, blockNumber: 123n })

  test('with monadRegistry the eth_call goes to the Monad QuoterV2 with Monad tokens', async () => {
    const { client, calls } = fakeClient(777n)
    const out = await quoterV2(monadRegistry).quoteExactInputSingle(client, req(monadRegistry))
    expect(out).toBe(777n)
    expect(calls).toHaveLength(1)
    const [c] = calls
    expect(nameOf(c!.to!, monadRegistry)).toBe('QuoterV2')
    expect(nameOf(c!.to!, baseRegistry)).toBeUndefined()
    expect(c!.blockNumber).toBe(123n)
    const d = decodeFunctionData({ abi: quoterV2Abi, data: c!.data! })
    expect(d.functionName).toBe('quoteExactInputSingle')
    const [p] = d.args as readonly [{ tokenIn: Address; tokenOut: Address; fee: number; sqrtPriceLimitX96: bigint }]
    expect(nameOf(p.tokenIn, monadRegistry)).toBe('USDC')
    expect(nameOf(p.tokenOut, monadRegistry)).toBe('WMON')
    expect(nameOf(p.tokenIn, baseRegistry)).toBeUndefined()
    expect(nameOf(p.tokenOut, baseRegistry)).toBeUndefined()
    expect(p.fee).toBe(3000)
    expect(p.sqrtPriceLimitX96).toBe(0n)
  })

  test('the free form is the Base-bound form', async () => {
    const free = fakeClient(1n)
    const bound = fakeClient(1n)
    await quoteExactInputSingle(free.client, req(baseRegistry))
    await quoterV2(baseRegistry).quoteExactInputSingle(bound.client, req(baseRegistry))
    expect(free.calls).toEqual(bound.calls)
    expect(isAddressEqual(free.calls[0]!.to!, address('QuoterV2', baseRegistry))).toBe(true)
  })

  test('the Monad-bound quoter refuses Base token addresses before any RPC', async () => {
    const { client, calls } = fakeClient(1n)
    const monad = quoterV2(monadRegistry)
    const usdcMonad = address('USDC', monadRegistry)
    const wmon = address('WMON', monadRegistry)
    const cases = [
      { tokenIn: address('USDC', baseRegistry), tokenOut: wmon },
      { tokenIn: usdcMonad, tokenOut: address('WETH', baseRegistry) },
      { tokenIn: address('USDC', baseRegistry), tokenOut: address('cbBTC', baseRegistry) },
    ]
    for (const t of cases) {
      await expect(monad.quoteExactInputSingle(client, { ...t, fee: 3000, amountIn: 10n ** 6n, blockNumber: 1n })).rejects.toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
    }
    // the same goes through uniswapV3(registry), which shares the quoter
    await expect(
      uniswapV3(monadRegistry).quoteExactInputSingle(client, { tokenIn: address('USDC', baseRegistry), tokenOut: wmon, fee: 3000, amountIn: 1n, blockNumber: 1n }),
    ).rejects.toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
    expect(calls).toHaveLength(0)
  })

  test('a registry entry that is not a token (a pool, the router) is refused as a quote token', async () => {
    const { client, calls } = fakeClient(1n)
    const r = monadRegistry
    for (const notToken of ['pool:WMON/USDC/3000', 'SwapRouter02']) {
      await expect(
        quoterV2(r).quoteExactInputSingle(client, { tokenIn: address('USDC', r), tokenOut: address(notToken, r), fee: 3000, amountIn: 1n, blockNumber: 1n }),
      ).rejects.toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
    }
    expect(calls).toHaveLength(0)
  })

  test('a failed or empty eth_call is EHG_QUOTE_UNAVAILABLE', async () => {
    const failing = { call: async () => { throw new Error('execution reverted\nmore') } } as unknown as PublicClient
    await expect(quoterV2(monadRegistry).quoteExactInputSingle(failing, req(monadRegistry))).rejects.toThrow('EHG_QUOTE_UNAVAILABLE')
    const empty = { call: async () => ({}) } as unknown as PublicClient
    await expect(quoterV2(monadRegistry).quoteExactInputSingle(empty, req(monadRegistry))).rejects.toThrow('EHG_QUOTE_UNAVAILABLE')
  })
})

describe('sqrtRatioAtTick', () => {
  test('matches TickMath at the reference ticks', () => {
    expect(sqrtRatioAtTick(0)).toBe(1n << 96n)
    expect(sqrtRatioAtTick(-887272)).toBe(4295128739n)
    expect(sqrtRatioAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n)
  })

  test('is monotonic', () => {
    expect(sqrtRatioAtTick(-10)).toBeLessThan(sqrtRatioAtTick(0))
    expect(sqrtRatioAtTick(10)).toBeGreaterThan(sqrtRatioAtTick(0))
  })
})

describe('minOut', () => {
  test('applies the tolerance', () => {
    expect(minOut(10_000n, 50)).toBe(9_950n)
  })

  test('refuses a zero minimum', () => {
    expect(() => minOut(1n, 50)).toThrow('EHG_QUOTE_UNAVAILABLE')
  })
})

describe('quoteMint', () => {
  test('in range, takes both tokens and keeps positive minimums', () => {
    const q = quoteMint({ sqrtPriceX96: sqrtRatioAtTick(0), tickLower: -100, tickUpper: 100, amount0Desired: 10n ** 12n, amount1Desired: 10n ** 12n, slippageBps: 50 })
    expect(q.liquidity).toBeGreaterThan(0n)
    expect(q.amount0).toBeLessThanOrEqual(10n ** 12n)
    expect(q.amount1).toBeLessThanOrEqual(10n ** 12n)
    expect(q.amount0Min).toBeGreaterThan(0n)
    expect(q.amount0Min).toBeLessThan(q.amount0)
  })

  test('out of range on one side leaves a zero minimum and is refused', () => {
    expect(() =>
      quoteMint({ sqrtPriceX96: sqrtRatioAtTick(-200), tickLower: -100, tickUpper: 100, amount0Desired: 10n ** 12n, amount1Desired: 10n ** 12n, slippageBps: 50 }),
    ).toThrow('EHG_QUOTE_UNAVAILABLE')
  })
})

describe('price conversions', () => {
  test('round trip at tick 0 is the identity', () => {
    const s = sqrtRatioAtTick(0)
    expect(token1InToken0(1_000n, s)).toBe(1_000n)
    expect(token0InToken1(1_000n, s)).toBe(1_000n)
  })
})

describe('rangeAround', () => {
  test('ticks sit on the spacing', () => {
    const r = rangeAround(-67_433, 3000, 60)
    expect(Math.abs(r.tickLower % 60)).toBe(0)
    expect(Math.abs(r.tickUpper % 60)).toBe(0)
    expect(r.tickLower).toBeLessThan(-67_433)
    expect(r.tickUpper).toBeGreaterThan(-67_433)
  })
})
