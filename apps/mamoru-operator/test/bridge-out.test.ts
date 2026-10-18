import { describe, expect, test } from 'bun:test'
import { ACROSS_SPOKE_POOL, BridgeOut, checkQuote, DAILY_BUDGET_WEI, MAX_FEE_BPS, type AcrossQuote } from '../src/bridge-out.ts'
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

  test('an exclusive relayer may hold the fill for minutes, not until the deadline', () => {
    const relayer = '0xFD03AbCAdaF3F930fA4E37Eb2f6ea3A44a41b7F0'
    expect(refused(good({ exclusiveRelayer: relayer, exclusivityDeadline: NOW + 208 }))).toBe('accepted')
    expect(refused(good({ exclusiveRelayer: relayer, exclusivityDeadline: 120 }))).toBe('accepted')
    expect(refused(good({ exclusiveRelayer: relayer, exclusivityDeadline: NOW + 4 * 3600 }))).toContain('exclusivity too long')
    expect(refused(good({ exclusiveRelayer: relayer, exclusivityDeadline: 3600 }))).toContain('exclusivity too long')
    expect(refused(good({ exclusivityDeadline: 60 }))).toContain('exclusivity without a relayer')
    expect(refused(good({ fillDeadline: String(NOW + 3 * 86_400) }))).toContain('fill deadline too far')
  })

  test('refuses a stale quote, a close fill deadline, malformed fields, and an amount Across calls too low', () => {
    expect(refused(good({ timestamp: String(NOW - 3600) }))).toContain('stale')
    expect(refused(good({ fillDeadline: String(NOW + 60) }))).toContain('fill deadline too close')
    expect(refused(good({ exclusiveRelayer: 'nope' }))).toContain('malformed')
    expect(refused(good({ outputAmount: 'x' }))).toContain('malformed')
    expect(refused(good({ isAmountTooLow: true }))).toStartWith('BRIDGE_AMOUNT_TOO_LOW')
  })
})

describe('the operator bundler guard (#180)', () => {
  const { mkdtempSync, readFileSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-guard-'))
    const l1 = { getGasPrice: async () => 1_000_000_000n, getBalance: async () => 10n ** 18n } as unknown as import('viem').PublicClient
    const relayer = { address: '0x0000000000000000000000000000000000000001' as const, send: async () => Promise.reject(new Error('unused')) }
    const bo = new BridgeOut(l1, relayer, dir, fetch, Date.now, undefined, () => true)
    const spent = () => BigInt(JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8')).spent.wei)
    return { bo, spent }
  }

  test('fronts gas only for the move under way', async () => {
    const { bo } = make()
    await expect(bo.bundlerGuard().before(1_400_000n)).rejects.toThrow('no move under way')
  })

  test('the signed bound replaces the estimate; over the budget the send stops and the reservation goes back', async () => {
    const { bo, spent } = make()
    ;(bo as unknown as { sending: unknown }).sending = { accountKey: 'a', route: { id: 'r' } }
    const g = bo.bundlerGuard()
    await g.before(1_400_000n)
    expect(spent()).toBe(1_400_000n * 1_000_000_000n * 2n)
    g.sending(1_400_000n * 1_500_000_000n, 1_400_000n)
    expect(spent()).toBe(1_400_000n * 1_500_000_000n)
    expect(() => g.sending(DAILY_BUDGET_WEI + 1n, 1_400_000n)).toThrow("budget")
    g.failed(false)
    expect(spent()).toBe(0n)
  })

  test('a refund larger than the cost leaves nothing charged; a smaller one leaves the difference', async () => {
    const { bo, spent } = make()
    ;(bo as unknown as { sending: unknown }).sending = { accountKey: 'a', route: { id: 'r' } }
    const g = bo.bundlerGuard()
    await g.before(1_000_000n)
    g.after(900n, 1_000n)
    expect(spent()).toBe(0n)
    await g.before(1_000_000n)
    g.after(1_000n, 900n)
    expect(spent()).toBe(100n)
  })
})
