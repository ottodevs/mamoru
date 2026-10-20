import { describe, expect, test } from 'bun:test'
import { TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem'
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
  const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  type Hex = `0x${string}`
  const K1 = `0x${'01'.repeat(32)}` as Hex
  const K2 = `0x${'02'.repeat(32)}` as Hex
  const T1 = `0x${'a1'.repeat(32)}` as Hex
  const route = (id: string, userOpHash: Hex) => ({ id, safe: '0x0000000000000000000000000000000000000aaa', safeNonce: '0', fromBlock: '0', state: 'sending', amountUsdc: '1', outputUsdc: '1', userOpHash, at: new Date().toISOString() })
  const make = (o: { now?: () => number; dir?: string; chain?: Partial<Record<string, unknown>> } = {}) => {
    const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'mamoru-guard-'))
    if (!o.dir) writeFileSync(join(dir, 'bridge-out.json'), JSON.stringify({ routes: { a: route('r1', K1), b: route('r2', K2) }, spent: { day: '', wei: '0' }, moves: {} }))
    const notFound = async ({ hash }: { hash: Hex }) => {
      throw new TransactionReceiptNotFoundError({ hash })
    }
    const l1 = { getGasPrice: async () => 1_000_000_000n, getBalance: async () => 10n ** 18n, getTransactionReceipt: notFound, getTransaction: async ({ hash }: { hash: Hex }) => Promise.reject(new TransactionNotFoundError({ hash })), getTransactionCount: async () => 0, ...o.chain } as unknown as import('viem').PublicClient
    const relayer = { address: '0x0000000000000000000000000000000000000001' as const, send: async () => Promise.reject(new Error('unused')) }
    const bo = new BridgeOut(l1, relayer, dir, fetch, o.now ?? Date.now, undefined, () => true)
    const j = () => JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8'))
    return { bo, dir, spent: () => BigInt(j().spent.wei), reserved: () => j().reservations ?? {} }
  }

  test('fronts gas only for a userOp of a move under way, one bundle at a time', async () => {
    const { bo } = make()
    const g = bo.bundlerGuard()
    await expect(g.before(`0x${'09'.repeat(32)}`, 1_400_000n)).rejects.toThrow('no move under way')
    await g.before(K1, 1_400_000n)
    await expect(g.before(K2, 1_400_000n)).rejects.toThrow('another bundle is in flight')
  })

  test('reservations are per userOp: a failed signed send of one never clears another; unsigned ones go back', async () => {
    const { bo, reserved } = make()
    const g = bo.bundlerGuard()
    await g.before(K1, 1_400_000n)
    g.sending(K1, 3_000_000_000_000_000n, 1_400_000n)
    g.sent(K1, T1, 7)
    g.failed(K1, true)
    await g.before(K2, 1_000_000n)
    g.failed(K2, false)
    expect(Object.keys(reserved())).toEqual([K1])
    expect(reserved()[K1]).toMatchObject({ wei: '3000000000000000', tx: T1, nonce: 7 })
    // The held 0.003 ETH counts against the budget: a second bundle bound of 0.0028 ETH is refused before any send.
    await expect(g.before(K2, 1_400_000n)).rejects.toThrow('paused for today')
  })

  test('a held reservation is released only on proof: a node error changes nothing; a taken nonce with no receipt and no transaction, seen twice 30 min apart, settles 0', async () => {
    let receiptMode: 'error' | 'none' = 'error'
    let count = 5
    let clock = Date.parse('2026-10-20T10:00:00Z')
    const { bo, dir, reserved, spent } = make({
      now: () => clock,
      chain: {
        getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
          if (receiptMode === 'error') throw new Error('node down')
          throw new TransactionReceiptNotFoundError({ hash })
        },
        getTransactionCount: async () => count,
      },
    })
    const g = bo.bundlerGuard()
    await g.before(K1, 1_000_000n)
    g.sending(K1, 2_000_000_000_000_000n, 1_000_000n)
    g.sent(K1, T1, 7)
    g.failed(K1, true)
    count = 8
    await bo.tick()
    expect(Object.keys(reserved())).toEqual([K1])
    receiptMode = 'none'
    await bo.tick()
    expect(reserved()[K1]?.goneAt).toBeDefined()
    clock += 10 * 60_000
    await bo.tick()
    expect(Object.keys(reserved())).toEqual([K1])
    clock += 25 * 60_000
    await bo.tick()
    expect(reserved()).toEqual({})
    expect(spent()).toBe(0n)
    // A restart keeps a signed reservation and drops one that was never signed.
    const { bo: b2, reserved: r2 } = make({ dir, now: () => clock })
    const g2 = b2.bundlerGuard()
    await g2.before(K2, 1_000_000n)
    expect(Object.keys(r2())).toEqual([K2])
    expect(Object.keys(make({ dir }).reserved())).toEqual([])
  })

  test('after(): cost minus refund, never below zero; across midnight the reservation still counts until settled', async () => {
    let clock = Date.parse('2026-10-18T23:59:50Z')
    const { bo, spent, reserved } = make({ now: () => clock })
    const g = bo.bundlerGuard()
    await g.before(K1, 1_000_000n)
    g.sending(K1, 4_000_000_000_000_000n, 1_000_000n)
    clock = Date.parse('2026-10-19T00:00:10Z')
    await expect(g.before(K2, 1_000_000n)).rejects.toThrow()
    g.after(K1, 1_000n, 900n)
    expect(spent()).toBe(100n)
    expect(reserved()).toEqual({})
    expect(() => g.sending(K2, DAILY_BUDGET_WEI + 1n, 1_000_000n)).toThrow('budget')
  })
})
