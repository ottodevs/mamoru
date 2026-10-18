import { describe, expect, test } from 'bun:test'
import { ACROSS_SPOKE_POOL, checkQuote, MAX_FEE_BPS, type AcrossQuote } from '../src/bridge-out.ts'
import { HttpError } from '../src/operator.ts'

const NOW = 1_800_000_000
const AMOUNT = 150_000_000n
const good = (over: Partial<AcrossQuote> = {}): AcrossQuote => ({
  outputAmount: '149980866',
  totalRelayFee: { total: '19134' },
  timestamp: String(NOW - 30),
  fillDeadline: String(NOW + 4 * 3600),
  exclusiveRelayer: '0x0000000000000000000000000000000000000000',
  exclusivityDeadline: 0,
  spokePoolAddress: ACROSS_SPOKE_POOL,
  estimatedFillTimeSec: 2,
  isAmountTooLow: false,
  ...over,
})
const refused = (q: AcrossQuote) => {
  try {
    checkQuote(q, AMOUNT, NOW)
    return 'accepted'
  } catch (e) {
    return e instanceof HttpError ? `${e.code}: ${e.message}` : 'unexpected'
  }
}

describe('bridge-out quote check (#133)', () => {
  test('a normal Across quote becomes the deposit as quoted', () => {
    const d = checkQuote(good(), AMOUNT, NOW)
    expect(d).toEqual({ amount: AMOUNT, outputAmount: 149_980_866n, exclusiveRelayer: '0x0000000000000000000000000000000000000000', quoteTimestamp: NOW - 30, fillDeadline: NOW + 4 * 3600, exclusivityDeadline: 0, fillSec: 2 })
  })

  test('refuses another contract, a fee that does not match, a fee above the bound, and an output above the input', () => {
    expect(refused(good({ spokePoolAddress: '0x000000000000000000000000000000000000dEaD' }))).toContain('unexpected contract')
    expect(refused(good({ totalRelayFee: { total: '1' } }))).toContain('fee does not match')
    const over = (AMOUNT * (MAX_FEE_BPS + 1n)) / 10_000n
    expect(refused(good({ outputAmount: String(AMOUNT - over), totalRelayFee: { total: String(over) } }))).toContain('fee too high')
    expect(refused(good({ outputAmount: String(AMOUNT + 1n), totalRelayFee: { total: '-1' } }))).toContain('out of range')
  })

  test('refuses a stale quote, a close fill deadline, malformed fields, and an amount Across calls too low', () => {
    expect(refused(good({ timestamp: String(NOW - 3600) }))).toContain('stale')
    expect(refused(good({ fillDeadline: String(NOW + 60) }))).toContain('fill deadline too close')
    expect(refused(good({ exclusiveRelayer: 'nope' }))).toContain('malformed')
    expect(refused(good({ outputAmount: 'x' }))).toContain('malformed')
    expect(refused(good({ isAmountTooLow: true }))).toStartWith('BRIDGE_AMOUNT_TOO_LOW')
  })
})
