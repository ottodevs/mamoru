import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import type { AccountContext } from '@mamoru/domain'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import { beforeSign, homeOf, releaseObs, ReleaseRefused, releaseView, requestRelease, unsigned } from '../src/release.ts'
import type { AccountState, StoredOp } from '../src/state.ts'

const HOME = '0x00000000000000000000000000000000000000a1'
const SAFE = '0x00000000000000000000000000000000000000b2'
const UOP = `0x${'ab'.repeat(32)}` as Hex
const T = '2026-11-02T18:00:00.000Z'

function remote(over: { home?: string | null; homeDomain?: number } = {}): AccountState {
  const spec = { chainId: 143, policyId: 'one-auth-v4-remote', sessionKey: '0x01', validAfter: 0, validUntil: 0, capUsdc: '1000', ...(over.home === null ? {} : { home: over.home ?? HOME, homeDomain: over.homeDomain ?? 6 }) }
  return { accountKey: 'r-1', ctx: { accountKey: 'r-1', chainId: 143, address: SAFE, remote: spec } as unknown as AccountContext, ops: [] as StoredOp[] } as unknown as AccountState
}

const signing = (over: Partial<BridgeSigning> = {}): BridgeSigning => ({
  opId: 'op-1', account: SAFE, recipient: HOME, depositor: '0x00000000000000000000000000000000000000f4', chainId: 8453, pool: 'pool:WMON/USDC/3000', bucket: 'growth', amount: 4_000_000n, destinationDomain: 6,
  userOpHash: UOP, nonceKey: 0n, nonce: 1n, prepareBlock: 10n, ...over,
})

const refused = (f: () => unknown) => {
  try {
    f()
  } catch (e) {
    return e instanceof ReleaseRefused ? `${e.status} ${e.code}` : String(e)
  }
  return 'no error'
}

describe('release (otto/mamoru#278): one request, one burn', () => {
  test('the home comes from the spec: home address and its chain; none for a design-C or a Base account', () => {
    expect(homeOf(remote())).toEqual({ home: '0x00000000000000000000000000000000000000A1' as never, chainId: 8453 })
    expect(homeOf(remote({ home: null }))).toBeNull()
    expect(homeOf(remote({ homeDomain: 3 }))).toBeNull()
  })

  test('a request opens; the engine reads it; the same request again is the same; another is refused while open', () => {
    const acc = remote()
    expect(releaseView(acc, T)).toEqual({ state: 'none' })
    expect(requestRelease(acc, { id: 'r1', amount: '4000000' }, T)).toMatchObject({ id: 'r1', state: 'open', chainId: 8453 })
    expect(releaseObs(acc, T)).toEqual({ amount: 4_000_000n, chainId: 8453 as never })
    expect(requestRelease(acc, { id: 'r1', amount: '4000000' }, T)).toMatchObject({ id: 'r1', state: 'open' })
    expect(refused(() => requestRelease(acc, { id: 'r2', amount: '1' }, T))).toBe('409 RELEASE_OPEN')
    expect(refused(() => requestRelease(acc, { id: 'r1', amount: '5' }, T))).toBe('409 RELEASE_OPEN')
  })

  test('bad bodies and non-remote Safes are refused', () => {
    expect(refused(() => requestRelease(remote({ home: null }), { id: 'r1', amount: '1' }, T))).toBe('400 NOT_A_REMOTE')
    for (const body of [null, {}, { id: 'r 1', amount: '1' }, { id: 'r1', amount: '0' }, { id: 'r1', amount: '-1' }, { id: 'r1', amount: 1 }, { id: 'r1', amount: '01' }, { id: 'r1', amount: (1n << 128n).toString() }])
      expect(refused(() => requestRelease(remote(), body, T))).toBe('400 BAD_REQUEST')
  })

  test('the burn goes on disk as sending; its confirmed op row makes it burned with tx and block; then a new request may open', () => {
    const acc = remote()
    requestRelease(acc, { id: 'r1', amount: '4000000' }, T)
    beforeSign(acc, signing(), T)
    expect(acc.release).toMatchObject({ state: 'sending', burn: { userOpHash: UOP, amount: '4000000' } })
    // Signing again the same burn (a retry) is the same burn.
    beforeSign(acc, signing(), T)
    // Still read by the engine while sending: nothing else is placed meanwhile.
    expect(releaseObs(acc, T)).toEqual({ amount: 4_000_000n, chainId: 8453 as never })
    acc.ops.push({ opId: 'eng-1', kind: 'bridge_out', state: 'confirmed', userOpHash: UOP, txHash: `0x${'cd'.repeat(32)}`, block: 777, updatedAt: T } as unknown as StoredOp)
    expect(releaseView(acc, T)).toEqual({ id: 'r1', amount: '4000000', chainId: 8453, state: 'burned', burn: { amount: '4000000', txHash: `0x${'cd'.repeat(32)}`, block: 777 } })
    expect(releaseObs(acc, T)).toBeUndefined()
    expect(requestRelease(acc, { id: 'r2', amount: '1000' }, T)).toMatchObject({ id: 'r2', state: 'open' })
  })

  test('a failed burn op or an unsigned burn opens the request again', () => {
    const acc = remote()
    requestRelease(acc, { id: 'r1', amount: '4000000' }, T)
    beforeSign(acc, signing(), T)
    acc.ops.push({ opId: 'eng-1', kind: 'bridge_out', state: 'failed', userOpHash: UOP, updatedAt: T } as unknown as StoredOp)
    expect(releaseView(acc, T)).toMatchObject({ state: 'open' })
    const other = `0x${'ef'.repeat(32)}` as Hex
    beforeSign(acc, signing({ userOpHash: other }), T)
    expect(unsigned(acc, `0x${'00'.repeat(32)}`, T)).toBe(false)
    expect(unsigned(acc, other, T)).toBe(true)
    expect(acc.release).toMatchObject({ state: 'open' })
    expect(acc.release?.burn).toBeUndefined()
  })

  test('a burn that is not the request is never signed: no request, another burn out, wrong chain or recipient, more than asked', () => {
    const none = remote()
    expect(() => beforeSign(none, signing(), T)).toThrow('without an open release')
    const acc = remote()
    requestRelease(acc, { id: 'r1', amount: '4000000' }, T)
    expect(() => beforeSign(acc, signing({ chainId: 143 }), T)).toThrow("not this Safe's home")
    expect(() => beforeSign(acc, signing({ recipient: SAFE }), T)).toThrow("not this Safe's home")
    expect(() => beforeSign(acc, signing({ amount: 4_000_001n }), T)).toThrow('more than')
    expect(() => beforeSign(acc, signing({ amount: 0n }), T)).toThrow('more than')
    beforeSign(acc, signing({ amount: 3_000_000n }), T)
    expect(() => beforeSign(acc, signing({ userOpHash: `0x${'ef'.repeat(32)}` }), T)).toThrow('one burn per request')
  })
})
