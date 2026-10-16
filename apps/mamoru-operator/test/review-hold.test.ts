// otto/mamoru#140 (part2 #9): an owner tx prepared (not yet signed) on the current positions held engine review
// for as long as the account kept at least one unexpired prepare outstanding, with no bound — prepare needs no
// passkey, so a compromised app Worker (or a scripted retry loop) could keep the engine starved indefinitely.
// reviewHold is the pure decision startLoop calls; this tests it directly.
import { describe, expect, test } from 'bun:test'
import { reviewHold } from '../src/operator.ts'

describe('reviewHold bounds how long a pending prepare can hold engine review', () => {
  test('nothing pending: never held, and the clock resets', () => {
    expect(reviewHold(false, 1_000, 2_000, 60_000)).toEqual({ hold: false, since: undefined })
  })

  test('first tick with something pending: held, clock starts now', () => {
    expect(reviewHold(true, undefined, 1_000, 60_000)).toEqual({ hold: true, since: 1_000 })
  })

  test('still pending, well inside the bound: held, clock unchanged', () => {
    expect(reviewHold(true, 1_000, 30_000, 60_000)).toEqual({ hold: true, since: 1_000 })
  })

  test('still pending, exactly at the bound or past it: no longer held, but the clock is still reported', () => {
    expect(reviewHold(true, 1_000, 61_000, 60_000)).toEqual({ hold: false, since: 1_000 })
    expect(reviewHold(true, 1_000, 500_000, 60_000)).toEqual({ hold: false, since: 1_000 })
  })

  test('a fresh pending prepare right after the bound expired starts a new window', () => {
    // startLoop clears `since` once `hold` is false and nothing is pending; a later call with pending=true and
    // since=undefined (as it would pass after clearing) starts counting from that tick, not from the old one.
    expect(reviewHold(true, undefined, 1_000_000, 60_000)).toEqual({ hold: true, since: 1_000_000 })
  })
})
