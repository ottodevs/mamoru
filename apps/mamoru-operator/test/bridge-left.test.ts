// otto/mamoru#376, spec 011 SCN-CAP-07 and SCN-CAP-12: what a V3 bridge-out grant still allows, from the chain's own
// counter plus what the journal knows the chain has not counted yet. Fail closed on anything that does not add up.
import { describe, expect, test } from 'bun:test'
import type { SessionGrant } from '@mamoru/policy'
import { bridgeLeftOf } from '../src/bridge-left.ts'
import type { BridgeBurn } from '../src/bridge-monad.ts'

const USDC = 1_000_000n
const READ_AT = Date.parse('2026-11-06T12:00:00Z')
const AGE = 15 * 60_000
const READ_BLOCK = 150n
const before = '2026-11-06T11:00:00Z'
const after = '2026-11-06T12:30:00Z'

/** A bridge-out grant signed at cap 1,000: per call 200, total 500 (policies-v6 BRIDGE_CAPS). */
const grant = {
  name: 'bridge-out',
  actions: [
    { params: [{ field: 'amount', ref: 200n * USDC, condition: 'LESS_THAN_OR_EQUAL', index: 1 }] },
    { params: [{ field: 'amount', ref: 200n * USDC, cumulativeLimit: 500n * USDC, condition: 'LESS_THAN_OR_EQUAL', index: 0 }, { field: 'maxFee', ref: 0n, condition: 'EQUAL', index: 5 }] },
  ],
} as unknown as SessionGrant

const chain = (used: bigint) => ({ used: 2, spentBps: null, cumulative: [{ limit: 500n * USDC, used }] })
const included = (s: BridgeBurn['state']) => s === 'burned' || s === 'minted'
/** A burn before the read is in block 100, one after it in block 200 (the read is pinned at block 150). */
const burn = (amount: bigint, state: BridgeBurn['state'], at: string): BridgeBurn => ({ id: `0x${amount.toString(16).padStart(64, '0')}`, accountKey: 'a', amount: amount.toString(), state, at, updatedAt: at, ...(included(state) ? { burnedAt: at, burnBlock: at === before ? '100' : '200' } : {}) }) as unknown as BridgeBurn

describe('bridgeLeftOf (spec 011 SCN-CAP-07, SCN-CAP-12)', () => {
  test('two burns the chain counted (150 + 230) under a total of 500 leave 120; per call is the signed 200', () => {
    const left = bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [burn(150n * USDC, 'minted', before), burn(230n * USDC, 'burned', before)] })
    expect(left).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 120n * USDC })
  })

  test('a send with no receipt yet counts as spent (SCN-CAP-12 a), and so does a burn included after the read', () => {
    expect(bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [burn(100n * USDC, 'sending', after)] })).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 20n * USDC })
    expect(bridgeLeftOf({ grant, chain: chain(300n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [burn(100n * USDC, 'burned', after)] })).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 100n * USDC })
    // Total 500, 300 on chain, 100 pending: 100 left (the round-4 example of the spec review).
    expect(bridgeLeftOf({ grant, chain: chain(300n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [burn(100n * USDC, 'sending', after)] })).toMatchObject({ amountLeft: 100n * USDC })
  })

  test('a dropped send, and a revert already behind the read, spent nothing', () => {
    const left = bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [burn(120n * USDC, 'dropped', after), burn(120n * USDC, 'failed', before)] })
    expect(left).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 120n * USDC })
  })

  test('a send that failed after the last read makes it unknown until the chain is read again (SCN-CAP-12 b)', () => {
    const burns = [burn(120n * USDC, 'failed', after)]
    expect(bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns })).toEqual({ kind: 'unknown' })
    // The next read (after the failure) restores it: the revert spent nothing.
    expect(bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: Date.parse(after) + 1, now: Date.parse(after) + 1, maxAgeMs: AGE, burns })).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 120n * USDC })
  })

  test('fail closed: no grant, no chain read, a limit on chain other than the signed one, or more spent than the total', () => {
    expect(bridgeLeftOf({ grant: undefined, chain: chain(0n), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [] })).toEqual({ kind: 'unknown' })
    expect(bridgeLeftOf({ grant, chain: undefined, chainReadBlock: undefined, chainReadAt: undefined, now: READ_AT, maxAgeMs: AGE, burns: [] })).toEqual({ kind: 'unknown' })
    expect(bridgeLeftOf({ grant, chain: { used: 0, spentBps: null, cumulative: [{ limit: 999n, used: 0n }] }, chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [] })).toEqual({ kind: 'unknown' })
    expect(bridgeLeftOf({ grant, chain: chain(450n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [burn(100n * USDC, 'sending', after)] })).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 0n })
  })

  test('a read older than the max age is not used: unknown (a refresh that keeps failing)', () => {
    expect(bridgeLeftOf({ grant, chain: chain(0n), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT + AGE + 1, maxAgeMs: AGE, burns: [] })).toEqual({ kind: 'unknown' })
    expect(bridgeLeftOf({ grant, chain: chain(0n), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT + AGE, maxAgeMs: AGE, burns: [] })).toMatchObject({ kind: 'v3', amountLeft: 500n * USDC })
  })

  test('inclusion is judged by block, not by clock: a burn in a block after the pinned read is still to count', () => {
    // The journal saw the burn (at a time before the read started), but its block is past the block the read is pinned to.
    const lagged = { ...burn(200n * USDC, 'burned', before), burnBlock: '151' } as BridgeBurn
    expect(bridgeLeftOf({ grant, chain: chain(250n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [lagged] })).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 50n * USDC })
    // A burn with no known block counts as not yet read.
    const noBlock = { ...burn(100n * USDC, 'burned', before), burnBlock: undefined } as BridgeBurn
    expect(bridgeLeftOf({ grant, chain: chain(300n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [noBlock] })).toMatchObject({ amountLeft: 100n * USDC })
    // No pinned block: unknown.
    expect(bridgeLeftOf({ grant, chain: chain(0n), chainReadBlock: undefined, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [] })).toEqual({ kind: 'unknown' })
  })

  test('a failure in the same millisecond as the read start is treated as after it', () => {
    const f = { ...burn(10n * USDC, 'failed', before), updatedAt: new Date(READ_AT).toISOString() } as BridgeBurn
    expect(bridgeLeftOf({ grant, chain: chain(0n), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [f] })).toEqual({ kind: 'unknown' })
  })

  test('an included send that reverted was charged at validation: pending until a read at or after its block has it', () => {
    const f = (block: string) => ({ ...burn(100n * USDC, 'failed', before), failedBlock: block }) as BridgeBurn
    // Included after the pinned read (lagging node): still to count.
    expect(bridgeLeftOf({ grant, chain: chain(300n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT, maxAgeMs: AGE, burns: [f('151')] })).toMatchObject({ kind: 'v3', amountLeft: 100n * USDC })
    // Included at or before it: the chain counted it, nothing to add.
    expect(bridgeLeftOf({ grant, chain: chain(300n * USDC), chainReadBlock: READ_BLOCK, chainReadAt: READ_AT, now: READ_AT + 1, maxAgeMs: AGE, burns: [{ ...f('150'), updatedAt: after } as BridgeBurn] })).toMatchObject({ kind: 'v3', amountLeft: 200n * USDC })
  })
})
