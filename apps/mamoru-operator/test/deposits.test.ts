import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { address, baseRegistry } from '@mamoru/registry'
import { balanceMoves, DEPOSIT_BACKFILL_BLOCKS, DEPOSIT_MIN_USDC, DEPOSIT_PAGE_BLOCKS, depositOpView, depositRange, depositsOf, mergeDeposits, type DepositRow } from '../src/deposits.ts'

// otto/mamoru#340: which USDC transfers to the Safe are deposits, how far each look reads, and their history rows.
const SAFE = `0x${'5a'.repeat(20)}` as const
const WALLET = `0x${'ab'.repeat(20)}` as const
const AT = '2026-11-02T18:00:00.000Z'
const log = (from: string, value: bigint, block = 10n, logIndex = 0, extra: Record<string, unknown> = {}) => ({ args: { from: from as Hex, to: SAFE as Hex, value }, transactionHash: `0x${block.toString(16).padStart(64, '0')}` as Hex, logIndex, blockNumber: block, ...extra })
const row = (block: number, logIndex = 0): DepositRow => ({ txHash: `0x${block.toString(16).padStart(64, '0')}`, logIndex, block: String(block), amountUsdc: '1000000', from: WALLET, at: AT })

describe('depositsOf', () => {
  test('a wallet or exchange sending USDC is a deposit, with its block time when the node gives one', () => {
    expect(depositsOf([log(WALLET, 25_000_000n, 10n, 2, { blockTimestamp: 1_790_000_000n })], SAFE, baseRegistry, AT)).toEqual([
      { txHash: `0x${'0'.repeat(63)}a`, logIndex: 2, block: '10', amountUsdc: '25000000', from: WALLET, at: new Date(1_790_000_000_000).toISOString() },
    ])
    expect(depositsOf([log(WALLET, 1_000_000n)], SAFE, baseRegistry, AT)[0]!.at).toBe(AT)
  })

  test("Mamoru's own contracts, a mint, a zero transfer and a log without its fields are not", () => {
    const own = ['pool:USDC/cbBTC/500', 'NonfungiblePositionManager', 'vault:gtUSDCp', 'TokenMessengerV2'].map((n) => log(address(n, baseRegistry), 5_000_000n))
    expect(depositsOf([...own, log(`0x${'0'.repeat(40)}`, 5_000_000n), log(WALLET, DEPOSIT_MIN_USDC - 1n), { transactionHash: null }], SAFE, baseRegistry, AT)).toEqual([])
    // They move the balance all the same, dust excepted.
    expect(balanceMoves([...own, log(WALLET, DEPOSIT_MIN_USDC - 1n, 11n)], SAFE)).toHaveLength(4)
  })
})

describe('depositRange', () => {
  test('a Safe with no cursor is read from a day back; a cursor is read on from', () => {
    expect(depositRange(undefined, 100_000n, 50)).toEqual({ from: 100_000n - DEPOSIT_BACKFILL_BLOCKS + 1n, to: 100_000n })
    expect(depositRange(99_990n, 100_000n, 5)).toEqual({ from: 99_991n, to: 100_000n })
    expect(depositRange(100_000n, 100_000n, 5)).toBeNull()
    expect(depositRange(undefined, 10n, 5)).toEqual({ from: 0n, to: 10n })
  })

  test('a look reads at most its pages; a gap past the backfill starts at the backfill', () => {
    expect(depositRange(0n, 1_000_000n, 2)).toEqual({ from: 1_000_000n - DEPOSIT_BACKFILL_BLOCKS + 1n, to: 1_000_000n - DEPOSIT_BACKFILL_BLOCKS + 2n * DEPOSIT_PAGE_BLOCKS })
  })
})

describe('mergeDeposits', () => {
  test('a row read twice is kept once; rows stay in chain order, the newest kept', () => {
    const { rows, added } = mergeDeposits([row(5), row(9)], [row(9), row(7), row(7)])
    expect(added).toEqual([row(7)])
    expect(rows.map((r) => r.block)).toEqual(['5', '7', '9'])
    expect(mergeDeposits([row(1), row(2)], [row(3)], 2).rows.map((r) => r.block)).toEqual(['2', '3'])
    expect(mergeDeposits([row(1)], [row(1)]).added).toEqual([])
  })

  // Security review: a run of small transfers can never push a real deposit out of the history.
  test('over the bound, the smallest rows go first', () => {
    const big = { ...row(1), amountUsdc: '25000000' }
    const dust = Array.from({ length: 10 }, (_, i) => ({ ...row(i + 2), amountUsdc: '10000' }))
    const { rows, added } = mergeDeposits([big], dust, 3)
    expect(rows[0]).toEqual(big)
    expect(rows).toHaveLength(3)
    expect(added).toHaveLength(2)
  })
})

test('depositOpView: a confirmed deposit row with its amount, sender and transaction', () => {
  expect(depositOpView(row(9, 4))).toEqual({ opId: `dep-0x${'0'.repeat(63)}9-4`, kind: 'deposit', state: 'confirmed', txHash: `0x${'0'.repeat(63)}9`, block: 9, updatedAt: AT, amountUsdc: '1000000', asset: 'USDC', from: WALLET })
  expect(depositOpView(row(9, 4), true).state).toBe('submitted')
})
