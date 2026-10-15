import { describe, expect, test } from 'bun:test'
import { DEFAULT_SUBSIDY_PER_DAY, SUBSIDY_MIN_USDC, noteExit, subsidyDecision, subsidyMessage, subsidyPerDayFromEnv } from '../src/subsidy.ts'
import type { AccountState } from '../src/state.ts'

const T = 500_000_000_000_000n
const NOW = Date.parse('2026-10-15T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const acct = (key: string, x: string, subsidies: { at: string; wei: string }[] = [], forfeit?: string) =>
  ({ accountKey: key, ctx: { passkey: { credentialId: key, x, y: '0x02' } }, subsidies, subsidyForfeitAt: forfeit }) as unknown as AccountState
const decide = (acc: AccountState, all: AccountState[], over: Partial<{ usdc: bigint; eth: bigint; perDay: number }> = {}) =>
  subsidyDecision({ acc, all, usdc: over.usdc ?? SUBSIDY_MIN_USDC, eth: over.eth ?? 0n, target: T, perDay: over.perDay ?? 10, now: NOW })

describe('subsidy decision', () => {
  test('a Safe holding its reserve needs nothing and is never refused, whatever the limits', () => {
    const a = acct('a', '0x01', [], iso(0))
    expect(decide(a, [a], { usdc: 1n, eth: T, perDay: 0 })).toEqual({ need: 0n, code: null })
  })

  test('the minimum is on value: one unit under it is refused, a partial reserve asks only for what is missing', () => {
    const a = acct('a', '0x01')
    expect(decide(a, [a], { usdc: SUBSIDY_MIN_USDC - 1n })).toEqual({ need: T, code: 'SUBSIDY_BELOW_MINIMUM' })
    expect(decide(a, [a], { eth: T - 7n })).toEqual({ need: 7n, code: null })
  })

  test('limits per account, per passkey across its Safes, and per day across everyone', () => {
    const a = acct('a', '0x01', [{ at: iso(0), wei: T.toString() }, { at: iso(0), wei: T.toString() }])
    expect(decide(a, [a]).code).toBe('SUBSIDY_ACCOUNT_LIMIT')
    const b = acct('b', '0x01', [{ at: iso(0), wei: T.toString() }])
    const c = acct('c', '0x01')
    expect(decide(c, [a, b, c]).code).toBe('SUBSIDY_PASSKEY_LIMIT')
    // Another passkey is not held back by those, only by the day's budget they used.
    const d = acct('d', '0x09')
    expect(decide(d, [a, b, c, d], { perDay: 3 }).code).toBe('SUBSIDY_DAILY_BUDGET')
    expect(decide(d, [a, b, c, d], { perDay: 4 }).code).toBeNull()
    expect(decide(d, [d], { perDay: 0 }).code).toBe('SUBSIDY_DAILY_BUDGET')
  })

  test('an early exit on one Safe ends the subsidy of every Safe of the passkey', () => {
    const a = acct('a', '0x01', [{ at: iso(3_600_000), wei: T.toString() }])
    expect(noteExit(a, NOW)).toBe(true)
    expect(noteExit(a, NOW)).toBe(false)
    const b = acct('b', '0x01')
    expect(decide(b, [a, b]).code).toBe('SUBSIDY_EARLY_EXIT')
    // Outside the window, or with no paid reserve, an exit changes nothing.
    expect(noteExit(acct('c', '0x03', [{ at: iso(73 * 3_600_000), wei: T.toString() }]), NOW)).toBe(false)
    expect(noteExit(acct('d', '0x04'), NOW)).toBe(false)
  })

  test('records without a passkey are not grouped together', () => {
    const bare = (k: string, s: { at: string; wei: string }[] = []) => ({ accountKey: k, subsidies: s }) as unknown as AccountState
    const x = bare('x', [{ at: iso(0), wei: T.toString() }, { at: iso(0), wei: T.toString() }])
    const y = bare('y')
    expect(decide(y, [x, y]).code).toBeNull()
  })

  test('the message names the ETH to send, rounded up, and the account', () => {
    expect(subsidyMessage('SUBSIDY_ACCOUNT_LIMIT', 123_456_789_000_001n, '0xSAFE')).toContain('send 0.000124 ETH on Base to your account 0xSAFE')
  })

  test('MAMORU_SUBSIDY_PER_DAY: integers from 0, anything else is the default', () => {
    expect(subsidyPerDayFromEnv({})).toBe(DEFAULT_SUBSIDY_PER_DAY)
    expect(subsidyPerDayFromEnv({ MAMORU_SUBSIDY_PER_DAY: '0' })).toBe(0)
    expect(subsidyPerDayFromEnv({ MAMORU_SUBSIDY_PER_DAY: '25' })).toBe(25)
    for (const bad of ['-1', '2.5', 'many', ' ']) expect(subsidyPerDayFromEnv({ MAMORU_SUBSIDY_PER_DAY: bad })).toBe(DEFAULT_SUBSIDY_PER_DAY)
  })
})
