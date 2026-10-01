import { describe, expect, test } from 'bun:test'
import { isReasonCode, overCap } from './index.ts'

const CAP = 25_000_000n

describe('overCap', () => {
  test('a balance at or under the cap is not reported', () => {
    expect(overCap(0n, CAP)).toBeNull()
    expect(overCap(24_999_999n, CAP)).toBeNull()
    expect(overCap(CAP, CAP)).toBeNull()
  })
  test('a balance over the cap carries the amounts in base units', () => {
    expect(overCap(26_920_000n, CAP)).toEqual({ code: 'DEPOSIT_OVER_CAP', usdc: '26920000', capUsdc: '25000000', excessUsdc: '1920000' })
    expect(overCap(CAP + 1n, CAP)?.excessUsdc).toBe('1')
  })
  test('the code is in the reason catalog', () => {
    expect(isReasonCode('DEPOSIT_OVER_CAP')).toBe(true)
  })
})
