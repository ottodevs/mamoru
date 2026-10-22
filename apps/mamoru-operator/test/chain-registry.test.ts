// otto/mamoru#63: the operator reads pools, tokens and the live pool from the registry of the chain it runs on.
import { describe, expect, test } from 'bun:test'
import { baseRegistry, monadRegistry } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { inUsdc, livePool, positionUsdc, priceOf, usdcPools, type PoolPosition } from '../src/chain.ts'
import { assertBaseOnlyFeatures, assertPolicyOnRegistry, operatorRegistry } from '../src/boot.ts'

describe('usdcPools and livePool come from the registry', () => {
  test('Base: the pools and live pool the operator always read', () => {
    expect(livePool(baseRegistry)).toBe('pool:USDC/cbBTC/500')
    expect(usdcPools(baseRegistry)).toContain('pool:USDC/cbBTC/500')
    expect(usdcPools(baseRegistry)).toContain('pool:WETH/USDC/3000')
  })

  test('Monad: only Monad pools, no Base name', () => {
    expect(livePool(monadRegistry)).toBe('pool:WMON/USDC/3000')
    expect(usdcPools(monadRegistry)).toEqual(['pool:WMON/USDC/3000', 'pool:EURW/USDC/100'])
    for (const p of usdcPools(monadRegistry)) expect(usdcPools(baseRegistry)).not.toContain(p)
  })

  test('a registry without a live pool is refused, never answered with another chain', () => {
    const empty = { ...monadRegistry, chainId: 999, entries: monadRegistry.entries.filter((e) => e.kind !== 'pool') }
    expect(() => livePool(empty)).toThrow(/no live USDC pool/)
  })
})

describe('valuation reads token order from the pool of its own registry', () => {
  // WMON is token0 of the Monad pool, USDC token1: raw USDC = amount * P with P = sqrtP^2 / 2^192.
  const price = sqrtRatioAtTick(-276_324) // about 1e-12 USDC raw per WMON raw: 1 WMON ~ 1 USDC at 18 vs 6 decimals
  test('WMON is priced as token0 of pool:WMON/USDC/3000', () => {
    const v = inUsdc('pool:WMON/USDC/3000', 'WMON', 10n ** 18n, price, monadRegistry)
    expect(v > 900_000n && v < 1_100_000n).toBe(true)
    expect(inUsdc('pool:WMON/USDC/3000', 'USDC', 5n, price, monadRegistry)).toBe(5n)
  })

  test('priceOf gives raw WMON per raw USDC', () => {
    const p = priceOf('pool:WMON/USDC/3000', price, monadRegistry)
    expect(p.asset).toBe('WMON')
    const wmonPerUsdc = (1_000_000n * p.num) / p.den
    expect(wmonPerUsdc > 9n * 10n ** 17n && wmonPerUsdc < 11n * 10n ** 17n).toBe(true)
  })

  test('a Monad pool is not resolvable through the Base registry', () => {
    expect(() => inUsdc('pool:WMON/USDC/3000', 'WMON', 1n, price, baseRegistry)).toThrow()
  })

  test('positionUsdc of a Monad position', () => {
    const p: PoolPosition = { tokenId: 1n, pool: 'pool:WMON/USDC/3000', token0: 'WMON', token1: 'USDC', fee: 3000, liquidity: 0n, tickLower: 0, tickUpper: 60, inRange: false, amount0: 10n ** 18n, amount1: 1_000_000n, tokensOwed0: 0n, tokensOwed1: 0n }
    const v = positionUsdc(p, price, monadRegistry)
    expect(v > 1_900_000n && v < 2_100_000n).toBe(true)
  })
})

describe('operatorRegistry (boot): which chain the operator reads', () => {
  test('a supported chain is read with its own registry', () => {
    expect(operatorRegistry(8453, {})).toBe(baseRegistry)
    expect(operatorRegistry(143, {})).toBe(monadRegistry)
  })

  test('a lab fork without MAMORU_SOURCE_CHAIN_ID reads Base, as before', () => {
    expect(operatorRegistry(31337, {})).toBe(baseRegistry)
    expect(operatorRegistry(31337, { MAMORU_SOURCE_CHAIN_ID: '' })).toBe(baseRegistry)
  })

  test('a lab fork of Monad names it', () => {
    expect(operatorRegistry(314143, { MAMORU_SOURCE_CHAIN_ID: '143' })).toBe(monadRegistry)
  })

  test('an unsupported or contradicting source chain is refused', () => {
    expect(() => operatorRegistry(31337, { MAMORU_SOURCE_CHAIN_ID: '1' })).toThrow(/not a supported chain/)
    expect(() => operatorRegistry(31337, { MAMORU_SOURCE_CHAIN_ID: 'base' })).toThrow(/not a supported chain/)
    expect(() => operatorRegistry(8453, { MAMORU_SOURCE_CHAIN_ID: '143' })).toThrow(/RPC is chain 8453/)
  })
})

describe('assertPolicyOnRegistry and assertBaseOnlyFeatures (boot)', () => {
  test('every Base policy resolves on Base', () => {
    for (const p of Object.values(POLICIES)) expect(() => assertPolicyOnRegistry(p, baseRegistry)).not.toThrow()
  })

  test('a Base policy is refused on Monad before any account is read', () => {
    expect(() => assertPolicyOnRegistry(POLICIES['conservador-live-v2']!, monadRegistry)).toThrow()
  })

  test('v4/v5 opt-in and bridge-out are Base only', () => {
    expect(() => assertBaseOnlyFeatures(baseRegistry, { MAMORU_ONCHAIN_POLICY_V4: '1' }, { l1RpcUrl: 'x' })).not.toThrow()
    expect(() => assertBaseOnlyFeatures(monadRegistry, {}, {})).not.toThrow()
    expect(() => assertBaseOnlyFeatures(monadRegistry, { MAMORU_ONCHAIN_POLICY_V4: '1' }, {})).toThrow(/Base only/)
    expect(() => assertBaseOnlyFeatures(monadRegistry, {}, { l1RpcUrl: 'x' })).toThrow(/Base only/)
  })
})
