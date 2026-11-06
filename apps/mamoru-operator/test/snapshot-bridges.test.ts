import { describe, expect, test } from 'bun:test'
import { bridgesWire, withBridges, type Snapshot } from '../src/snapshot.ts'

// spec 013 plan §3.5 / STATS-S15: the CCTP journals on the Base snapshot, so the Worker counts USDC in flight once.

const SAFE = '0xAbC0000000000000000000000000000000000001'
const burn = (id: string, state: string, over: Record<string, string> = {}) => ({ id, accountKey: 'acct-1', account: SAFE, amount: '200000000', state, ...over })

describe('bridgesWire', () => {
  test('out: sending, burned and minted go with their blocks and times; failed and dropped moved nothing', () => {
    const w = bridgesWire(
      [
        burn('0x01', 'sending'),
        burn('0x02', 'burned', { burnBlock: '100', burnedAt: '2026-11-06T10:00:00.000Z' }),
        burn('0x03', 'minted', { burnBlock: '90', burnedAt: '2026-11-06T09:00:00.000Z', mintedBlock: '5000', mintAt: '2026-11-06T09:20:00.000Z' }),
        burn('0x04', 'failed'),
        burn('0x05', 'dropped'),
      ],
      [],
    )
    expect(w.map((x) => [x.id, x.state])).toEqual([['0x01', 'sending'], ['0x02', 'burned'], ['0x03', 'minted']])
    expect(w[2]).toEqual({ id: '0x03', direction: 'out', accountKey: 'acct-1', safe: SAFE.toLowerCase(), amountUsdc: '200000000', state: 'minted', burnBlock: '90', burnAt: '2026-11-06T09:00:00.000Z', mintedBlock: '5000', mintedAt: '2026-11-06T09:20:00.000Z' })
  })

  test('home: the amount actually burned, its Monad block, the Base mint block; cancelled left out', () => {
    const w = bridgesWire([], [
      { id: 'ret-1', accountKey: 'acct-1', home: SAFE, amount: '500', state: 'burned', burn: { amount: '480', block: 777 } },
      { id: 'ret-2', accountKey: 'acct-1', home: SAFE, amount: '500', state: 'cancelled' },
    ])
    expect(w).toEqual([{ id: 'ret-1', direction: 'home', accountKey: 'acct-1', safe: SAFE.toLowerCase(), amountUsdc: '480', state: 'burned', burnBlock: '777' }])
  })

  test('a journal that throws leaves bridges out instead of an empty list (the Worker marks partial)', () => {
    const snap: Snapshot = { chainId: 8453, block: 1n, readAt: '2026-11-06T10:00:00.000Z', pools: {}, safes: [], calls: 1 }
    expect(withBridges(snap, () => [], () => []).bridges).toEqual([])
    expect('bridges' in withBridges(snap, () => { throw new Error('journal unreadable') }, () => [])).toBe(false)
  })
})
