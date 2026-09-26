import { describe, expect, test } from 'bun:test'
import { formatAmount, formatBps, formatFraction, formatUnits } from '../../src/web/lib/format.ts'

describe('amounts use registry decimals', () => {
  test('USDC 6, cbBTC 8, ETH 18', () => {
    expect(formatUnits('16800000000', 'USDC')).toBe('16,800')
    expect(formatUnits('38190331', 'cbBTC')).toBe('0.38190331')
    expect(formatUnits('2400000000000000000', 'ETH')).toBe('2.4')
    expect(formatAmount('0', 'USDC')).toBe('0 USDC')
  })
  test('truncates and keeps sign', () => {
    expect(formatUnits('1234567', 'USDC')).toBe('1.23')
    expect(formatUnits('-12480221003', 'USDC')).toBe('-12,480.22')
  })
  test('rejects non-integer amounts', () => {
    expect(() => formatUnits('1.5', 'USDC')).toThrow()
  })
  test('percentages', () => {
    expect(formatBps(5000)).toBe('50%')
    expect(formatFraction('0.834')).toBe('83.4%')
  })
})
