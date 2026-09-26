import { expect, test } from 'bun:test'
import { chunks } from '../src/sync/logs.ts'
import { feeOn, pricePerWhole, rateFromSqrtPrice, twapTick } from '../src/sync/math.ts'

test('twapTick rounds toward negative infinity like OracleLibrary', () => {
  expect(twapTick(0n, 1800n * 10n, 1800)).toBe(10)
  expect(twapTick(0n, -1800n * 10n, 1800)).toBe(-10)
  expect(twapTick(0n, -1800n * 10n - 1n, 1800)).toBe(-11)
  expect(twapTick(0n, 1800n * 10n + 1n, 1800)).toBe(10)
})

test('prices from sqrtPriceX96 in quote base units per whole token', () => {
  // token1 priced in token0: raw1/raw0 = 1/1024
  expect(pricePerWhole(rateFromSqrtPrice(2n ** 91n, false), 8)).toBe(102_400_000_000n)
  // token0 priced in token1: raw1/raw0 = 2^-18
  expect(pricePerWhole(rateFromSqrtPrice(2n ** 87n, true), 18)).toBe(3_814_697_265_625n)
})

test('fees and chunking', () => {
  expect(feeOn(2_000_000n, 500)).toBe(1_000n)
  expect(chunks(1, 1200, 500)).toEqual([[1, 500], [501, 1000], [1001, 1200]])
  expect(chunks(5, 5, 500)).toEqual([[5, 5]])
})
