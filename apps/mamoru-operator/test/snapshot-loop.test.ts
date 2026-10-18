import { describe, expect, test } from 'bun:test'
import { SnapshotLoop, snapshotIntervalMs, type Snapshot } from '../src/snapshot.ts'

const snap = (block: bigint): Snapshot => ({ chainId: 8453, block, readAt: new Date(0).toISOString(), pools: {}, safes: [], calls: 1 })
const settle = () => new Promise((r) => setTimeout(r, 5))

describe('SnapshotLoop (otto/mamoru#136)', () => {
  test('keeps the previous snapshot when a read fails, and says why', async () => {
    let n = 0
    const loop = new SnapshotLoop(async () => {
      n++
      if (n === 2) throw new Error('provider down\nstack')
      return snap(BigInt(n))
    }, 1)
    loop.start()
    await settle()
    loop.stop()
    expect(loop.current).not.toBeNull()
    expect(n).toBeGreaterThanOrEqual(3)
  })

  test('a failed read leaves lastError on one line, and the snapshot it had', async () => {
    let n = 0
    const loop = new SnapshotLoop(async () => {
      n++
      if (n > 1) throw new Error('boom\nsecond line')
      return snap(7n)
    }, 1)
    loop.start()
    await settle()
    loop.stop()
    expect(loop.current?.block).toBe(7n)
    expect(loop.lastError).toBe('boom')
  })

  test('over the RPC budget it waits slowMs between reads', async () => {
    let n = 0
    const loop = new SnapshotLoop(async () => (n++, snap(1n)), 1, () => true, 10_000)
    loop.start()
    await settle()
    loop.stop()
    expect(n).toBe(1)
  })

  test('nothing is read until start, and stop ends the loop', async () => {
    let n = 0
    const loop = new SnapshotLoop(async () => (n++, snap(1n)), 1)
    await settle()
    expect(n).toBe(0)
    loop.start()
    await settle()
    loop.stop()
    const after = n
    await settle()
    expect(n).toBe(after)
  })

  test('isRunning (otto/mamoru#129): off until start, on while running, off again after stop, even though current keeps the last read', async () => {
    const loop = new SnapshotLoop(async () => snap(1n), 1)
    expect(loop.isRunning).toBe(false)
    loop.start()
    expect(loop.isRunning).toBe(true)
    await settle()
    loop.stop()
    expect(loop.isRunning).toBe(false)
    expect(loop.current).not.toBeNull()
  })

  test('MAMORU_SNAPSHOT_MS: 30 s by default, never under 10 s, garbage is the default', () => {
    expect(snapshotIntervalMs(undefined)).toBe(30_000)
    expect(snapshotIntervalMs('')).toBe(30_000)
    expect(snapshotIntervalMs('abc')).toBe(30_000)
    expect(snapshotIntervalMs('-5')).toBe(10_000)
    expect(snapshotIntervalMs('0')).toBe(10_000)
    expect(snapshotIntervalMs('60000')).toBe(60_000)
    expect(snapshotIntervalMs('1e12')).toBe(2_147_483_647)
  })
})
