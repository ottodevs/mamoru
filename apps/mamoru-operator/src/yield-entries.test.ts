import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { EntryStore, holdValueUsdc, withHoldValue } from './yield-entries.ts'
import type { PositionSnapshot, Snapshot } from './snapshot.ts'

const position = (over: Partial<PositionSnapshot> = {}): PositionSnapshot => ({
  tokenId: 1n,
  pool: 'test-pool',
  token0: 'USDC',
  token1: 'cbBTC',
  liquidity: 100n,
  tickLower: -100,
  tickUpper: 100,
  inRange: true,
  amount0: 10_000_000n,
  amount1: 0n,
  accrued0: 0n,
  accrued1: 0n,
  owed0: 0n,
  owed1: 0n,
  collectable0: 0n,
  collectable1: 0n,
  valueUsdc: 10_000_000n,
  feesUsdc: 0n,
  owedUsdc: 0n,
  ...over,
})

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  chainId: 8453,
  block: 1n,
  readAt: '2026-10-16T09:00:00.000Z',
  pools: { 'test-pool': { sqrtPriceX96: 1n << 96n, tick: 0, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n } },
  safes: [{ accountKey: 'acc-1', safe: '0xSafe', active: true, armed: false, deployed: true, eth: 0n, tokens: {}, positions: [position()], idleUsdc: 0n, lpUsdc: 10_000_000n, feesUsdc: 0n, owedUsdc: 0n, totalUsdc: 10_000_000n }],
  calls: 1,
  ...over,
})

let dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-yield-entries-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('holdValueUsdc (otto/mamoru#129)', () => {
  test('USDC amount passes through unchanged; a zero amount1 contributes nothing', () => {
    const entry = { pool: 'test-pool', entryBlock: 1, entryDay: '2026-10-16', amount0: '5000000', amount1: '0', capturedAt: '2026-10-16T00:00:00.000Z' }
    expect(holdValueUsdc(entry, 'USDC', 'cbBTC', 1n << 96n)).toBe(5_000_000n)
  })
})

type WithHold = PositionSnapshot & { holdValueUsdc: bigint; entryAmount0: string; entryAmount1: string; entryBlock: number; entryDay: string }

describe('withHoldValue (otto/mamoru#129)', () => {
  test('captures a baseline the first time a token id is seen, and carries it as entryAmount0/1 alongside holdValueUsdc', () => {
    const store = new EntryStore(tmpDir())
    const out = withHoldValue(snap(), store)
    expect(store.get(8453, 1n)?.amount0).toBe('10000000')
    const p = out.safes[0]!.positions[0] as WithHold
    expect(p.holdValueUsdc).toBe(10_000_000n)
    expect(p.entryAmount0).toBe('10000000')
    expect(p.entryAmount1).toBe('0')
    expect(p.entryBlock).toBe(1)
    expect(p.entryDay).toBe('2026-10-16')
  })

  test('a later read with different amounts does not move the stored baseline or what it carries on the wire', () => {
    const store = new EntryStore(tmpDir())
    withHoldValue(snap(), store)
    const later = withHoldValue(snap({ readAt: '2026-10-17T09:00:00.000Z', safes: [{ ...snap().safes[0]!, positions: [position({ amount0: 99_000_000n })] }] }), store)
    expect(store.get(8453, 1n)?.amount0).toBe('10000000')
    const p = later.safes[0]!.positions[0] as WithHold
    // Hold value still prices the original entry amount, not the position's amount at this later read.
    expect(p.holdValueUsdc).toBe(10_000_000n)
    expect(p.entryAmount0).toBe('10000000')
    expect(p.entryDay).toBe('2026-10-16')
  })

  test('two different token ids each get their own baseline', () => {
    const store = new EntryStore(tmpDir())
    const two = snap({ safes: [{ ...snap().safes[0]!, positions: [position({ tokenId: 1n, amount0: 1_000_000n }), position({ tokenId: 2n, amount0: 2_000_000n })] }] })
    withHoldValue(two, store)
    expect(store.get(8453, 1n)?.amount0).toBe('1000000')
    expect(store.get(8453, 2n)?.amount0).toBe('2000000')
  })

  test('a position in a pool missing from the snapshot keeps holdValueUsdc and the entry fields entirely absent, never a fabricated 0', () => {
    const store = new EntryStore(tmpDir())
    const missingPool = snap({ pools: {}, safes: [{ ...snap().safes[0]!, positions: [position()] }] })
    const out = withHoldValue(missingPool, store)
    const p = out.safes[0]!.positions[0] as Partial<WithHold>
    expect(p.holdValueUsdc).toBeUndefined()
    expect(p.entryAmount0).toBeUndefined()
    expect('holdValueUsdc' in p).toBe(false)
    // The baseline is still captured even on a tick that cannot price it, so a later tick that can prices the
    // earliest read, not a later one.
    expect(store.get(8453, 1n)?.amount0).toBe('10000000')
  })

  test('once a pool becomes priceable again, the baseline captured on the unpriceable tick is what is used', () => {
    const store = new EntryStore(tmpDir())
    withHoldValue(snap({ pools: {}, safes: [{ ...snap().safes[0]!, positions: [position({ amount0: 7_000_000n })] }] }), store)
    const out = withHoldValue(snap({ safes: [{ ...snap().safes[0]!, positions: [position({ amount0: 99_000_000n })] }] }), store)
    const p = out.safes[0]!.positions[0] as WithHold
    expect(p.entryAmount0).toBe('7000000')
    expect(p.holdValueUsdc).toBe(7_000_000n)
  })

  test('persists across a new EntryStore pointed at the same directory', () => {
    const dir = tmpDir()
    withHoldValue(snap(), new EntryStore(dir))
    const reloaded = new EntryStore(dir)
    expect(reloaded.get(8453, 1n)?.amount0).toBe('10000000')
  })
})
