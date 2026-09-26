import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, toHex, type Log } from 'viem'
import { address } from '@mamoru/registry'
import { applyPrincipal, harvestRow, ledgerTotal, poolSwapAbi, positionEventsAbi, savingsRowView, splitCollect } from './index.ts'

const POOL = address('pool:USDC/cbBTC/500')
const NPM = address('NonfungiblePositionManager')
const ACCOUNT = '0x00000000000000000000000000000000000000aa'

function log(addr: `0x${string}`, topics: `0x${string}`[], data: `0x${string}`, logIndex: number): Log {
  return { address: addr, topics: topics as never, data, logIndex, blockNumber: 10n, blockHash: `0x${'aa'.repeat(32)}`, transactionHash: `0x${'bb'.repeat(32)}`, transactionIndex: 0, removed: false }
}

const collectLog = (tokenId: bigint, a0: bigint, a1: bigint, i: number) =>
  log(NPM, encodeEventTopics({ abi: positionEventsAbi, eventName: 'Collect', args: { tokenId } }) as `0x${string}`[], encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [ACCOUNT, a0, a1]), i)

const OTHER = '0x00000000000000000000000000000000000000bb'

const swapLog = (a0: bigint, a1: bigint, i: number, recipient: `0x${string}` = ACCOUNT) =>
  log(
    POOL,
    encodeEventTopics({ abi: poolSwapAbi, eventName: 'Swap', args: { sender: address('SwapRouter02'), recipient } }) as `0x${string}`[],
    encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [a0, a1, 1n << 96n, 1n, 69_000]),
    i,
  )

describe('splitCollect', () => {
  test('pays principal first, the rest is fees', () => {
    expect(splitCollect([100n, 0n], [150n, 7n])).toEqual({ principal: [100n, 0n], fees: [50n, 7n], pendingAfter: [0n, 0n] })
  })

  test('a partial collect leaves principal pending and credits no fees', () => {
    expect(splitCollect([100n, 40n], [60n, 10n])).toEqual({ principal: [60n, 10n], fees: [0n, 0n], pendingAfter: [40n, 30n] })
  })
})

describe('applyPrincipal', () => {
  test('decreases add, collects pay back, never below zero', () => {
    const owed = applyPrincipal(new Map(), [
      { kind: 'decrease', tokenId: 1n, amount0: 100n, amount1: 5n, logIndex: 0 },
      { kind: 'collect', tokenId: 1n, amount0: 60n, amount1: 9n, logIndex: 1 },
    ])
    expect(owed.get(1n)).toEqual([40n, 0n])
  })
})

describe('harvestRow', () => {
  const base = { opId: 'op-3', tokenId: 7n, chainId: 31337, block: 10n, blockHash: `0x${'aa'.repeat(32)}` as const, txHash: `0x${'bb'.repeat(32)}` as const, at: '2026-09-26T00:00:00.000Z', account: ACCOUNT, pool: POOL, savingsIsToken0: true } as const

  test('fees from Collect, conversion from Swap, credit only the savings asset', () => {
    const logs = [collectLog(7n, 5_000n, 90n, 3), swapLog(-8_000n, 90n, 6)]
    const row = harvestRow({ ...base, logs, pendingBefore: [0n, 0n], converted: true })
    expect(row.principal).toEqual([0n, 0n])
    expect(row.fees).toEqual([5_000n, 90n])
    expect(row.conversion).toEqual({ amountIn: 90n, amountOut: 8_000n })
    expect(row.credited).toBe(13_000n)
    expect(row.code).toBe('PROJ_CONFIRMED')
    expect(row.provenance.map((p) => p.source)).toEqual(['journal', 'fork_rpc'])
    expect(ledgerTotal([row, row])).toBe(26_000n)
  })

  test('principal owed from an external decrease is not credited', () => {
    const row = harvestRow({ ...base, logs: [collectLog(7n, 5_000n, 0n, 1)], pendingBefore: [4_000n, 0n], converted: false })
    expect(row.principal).toEqual([4_000n, 0n])
    expect(row.credited).toBe(1_000n)
    expect(row.conversion).toBeNull()
  })

  test('volatile principal left by an external decrease is kept as capital: only the fee part converts', () => {
    // 300 cbBTC owed, 390 collected: 90 are fees and convert, 300 stay in the account.
    const row = harvestRow({ ...base, logs: [collectLog(7n, 0n, 390n, 1), swapLog(-8_000n, 90n, 4)], pendingBefore: [0n, 300n], converted: true })
    expect(row.principal).toEqual([0n, 300n])
    expect(row.fees).toEqual([0n, 90n])
    expect(row.credited).toBe(8_000n)
  })

  test('a conversion larger than the volatile fees is refused: it would spend principal', () => {
    expect(() => harvestRow({ ...base, logs: [collectLog(7n, 0n, 390n, 1), swapLog(-9_000n, 100n, 4)], pendingBefore: [0n, 300n], converted: true })).toThrow(/above the volatile fees/)
  })

  test("another account's swap on the same pool is never this harvest's conversion", () => {
    const foreign = [collectLog(7n, 5_000n, 90n, 3), swapLog(-8_000n, 90n, 5, OTHER)]
    expect(() => harvestRow({ ...base, logs: foreign, pendingBefore: [0n, 0n], converted: true })).toThrow(/not volatile to savings for the account/)
  })

  test('a swap in the wrong direction is refused', () => {
    const wrong = [collectLog(7n, 5_000n, 90n, 3), swapLog(8_000n, -90n, 5)]
    expect(() => harvestRow({ ...base, logs: wrong, pendingBefore: [0n, 0n], converted: true })).toThrow(/not volatile to savings/)
  })

  test('a missing or duplicated Collect is refused', () => {
    expect(() => harvestRow({ ...base, logs: [], pendingBefore: [0n, 0n], converted: false })).toThrow(/0 Collect/)
    expect(() => harvestRow({ ...base, logs: [collectLog(7n, 1n, 0n, 1), collectLog(7n, 1n, 0n, 2)], pendingBefore: [0n, 0n], converted: false })).toThrow(/2 Collect/)
  })

  test('the dashboard view carries the credit and both sources', () => {
    const v = savingsRowView(harvestRow({ ...base, logs: [collectLog(7n, 5_000n, 0n, 1)], pendingBefore: [0n, 0n], converted: false }))
    expect(v.amount.value).toBe('5000')
    expect(v.provenance.source).toBe('journal')
    expect(v.amount.provenance.source).toBe('fork_rpc')
    expect(toHex(v.block)).toBe('0xa')
  })
})
