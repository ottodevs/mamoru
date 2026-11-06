// otto/mamoru#376, spec 011 SCN-CAP-07 and SCN-CAP-12: what a V3 bridge-out grant still allows, from the chain's own
// counter plus what the journal knows the chain has not counted yet. Fail closed on anything that does not add up.
import { describe, expect, test } from 'bun:test'
import type { SessionGrant } from '@mamoru/policy'
import { bridgeLeftOf } from '../src/bridge-left.ts'
import type { BridgeBurn } from '../src/bridge-monad.ts'

const USDC = 1_000_000n
const READ_AT = Date.parse('2026-11-06T12:00:00Z')
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
const burn = (amount: bigint, state: BridgeBurn['state'], at: string): BridgeBurn => ({ id: `0x${amount.toString(16).padStart(64, '0')}`, accountKey: 'a', amount: amount.toString(), state, at, updatedAt: at, burnedAt: state === 'burned' || state === 'minted' ? at : undefined }) as unknown as BridgeBurn

describe('bridgeLeftOf (spec 011 SCN-CAP-07, SCN-CAP-12)', () => {
  test('two burns the chain counted (150 + 230) under a total of 500 leave 120; per call is the signed 200', () => {
    const left = bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadAt: READ_AT, burns: [burn(150n * USDC, 'minted', before), burn(230n * USDC, 'burned', before)] })
    expect(left).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 120n * USDC })
  })

  test('a send with no receipt yet counts as spent (SCN-CAP-12 a), and so does a burn included after the read', () => {
    expect(bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadAt: READ_AT, burns: [burn(100n * USDC, 'sending', after)] })).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 20n * USDC })
    expect(bridgeLeftOf({ grant, chain: chain(300n * USDC), chainReadAt: READ_AT, burns: [burn(100n * USDC, 'burned', after)] })).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 100n * USDC })
    // Total 500, 300 on chain, 100 pending: 100 left (the round-4 example of the spec review).
    expect(bridgeLeftOf({ grant, chain: chain(300n * USDC), chainReadAt: READ_AT, burns: [burn(100n * USDC, 'sending', after)] })).toMatchObject({ amountLeft: 100n * USDC })
  })

  test('a dropped send, and a revert already behind the read, spent nothing', () => {
    const left = bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadAt: READ_AT, burns: [burn(120n * USDC, 'dropped', after), burn(120n * USDC, 'failed', before)] })
    expect(left).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 120n * USDC })
  })

  test('a send that failed after the last read makes it unknown until the chain is read again (SCN-CAP-12 b)', () => {
    const burns = [burn(120n * USDC, 'failed', after)]
    expect(bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadAt: READ_AT, burns })).toEqual({ kind: 'unknown' })
    // The next read (after the failure) restores it: the revert spent nothing.
    expect(bridgeLeftOf({ grant, chain: chain(380n * USDC), chainReadAt: Date.parse(after) + 1, burns })).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 120n * USDC })
  })

  test('fail closed: no grant, no chain read, a limit on chain other than the signed one, or more spent than the total', () => {
    expect(bridgeLeftOf({ grant: undefined, chain: chain(0n), chainReadAt: READ_AT, burns: [] })).toEqual({ kind: 'unknown' })
    expect(bridgeLeftOf({ grant, chain: undefined, chainReadAt: undefined, burns: [] })).toEqual({ kind: 'unknown' })
    expect(bridgeLeftOf({ grant, chain: { used: 0, spentBps: null, cumulative: [{ limit: 999n, used: 0n }] }, chainReadAt: READ_AT, burns: [] })).toEqual({ kind: 'unknown' })
    expect(bridgeLeftOf({ grant, chain: chain(450n * USDC), chainReadAt: READ_AT, burns: [burn(100n * USDC, 'sending', after)] })).toEqual({ kind: 'v3', perCall: 200n * USDC, amountLeft: 0n })
  })
})
