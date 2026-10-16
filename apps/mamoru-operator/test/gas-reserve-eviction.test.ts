import { describe, expect, test } from 'bun:test'
import { Operator } from '../src/operator.ts'
import { GasReserveTracker } from '../src/metrics.ts'
import type { StateStore } from '../src/state.ts'

/**
 * otto/mamoru#8 independent review (findings #2/#3): `Operator.gasReserveLowCount()` must never disagree with
 * `Operator.gasReserveSnapshot()` (both scoped to accounts with a running loop), and stopping — or restarting,
 * which stops first — an account must not leave its gas-reserve state behind for the next loop to read back.
 *
 * `Operator`'s constructor does no eager validation (same lightweight-construction pattern as
 * `reconcile.test.ts`), so a trivial fake `cfg`/`client`/`relayer` is enough to exercise its own bookkeeping
 * methods without standing up a real engine loop. `runners` and `gasReserve` are reached the same way this
 * suite already reaches other private fields (e.g. `over-cap.test.ts`'s `(op as unknown as {...}).retryMs`).
 */
type OperatorInternals = {
  runners: Map<string, { stopped: boolean; timer: ReturnType<typeof setTimeout> | null }>
  gasReserve: GasReserveTracker
  stopLoop: (key: string) => void
}

function fakeOperator() {
  const store = { state: { accounts: {} }, save: () => {} } as unknown as StateStore
  const op = new Operator({} as never, {} as never, {} as never, store)
  return { op, internals: op as unknown as OperatorInternals }
}

describe('Operator gas-reserve bookkeeping (otto/mamoru#8 review)', () => {
  test('gasReserveLowCount matches gasReserveSnapshot: only accounts with a running loop count', () => {
    const { op, internals } = fakeOperator()
    internals.runners.set('acc-1', { stopped: false, timer: null })
    internals.runners.set('acc-2', { stopped: false, timer: null })
    internals.gasReserve.record('acc-1', 100n, 500n) // low
    internals.gasReserve.record('acc-2', 900n, 500n) // healthy
    // A third account recorded directly on the tracker (e.g. a stale entry) but never added to runners: not
    // an active loop, so it must not be counted even though GasReserveTracker.lowCount() alone would see it.
    internals.gasReserve.record('acc-3', 1n, 500n)

    expect(internals.gasReserve.lowCount()).toBe(2) // the tracker alone, unscoped, would say 2
    expect(op.gasReserveLowCount()).toBe(1) // the operator's count, scoped to runners, says 1
    expect(op.gasReserveSnapshot().filter((s) => s.low).length).toBe(op.gasReserveLowCount())
    expect(op.gasReserveSnapshot().map((s) => s.account).sort()).toEqual(['acc-1', 'acc-2'])
  })

  test('stopLoop evicts the gas-reserve entry: the account drops out of both the snapshot and the low count', () => {
    const { op, internals } = fakeOperator()
    internals.runners.set('acc-1', { stopped: false, timer: null })
    internals.gasReserve.record('acc-1', 100n, 500n)
    expect(op.gasReserveLowCount()).toBe(1)

    internals.stopLoop('acc-1')

    expect(op.gasReserveSnapshot()).toEqual([])
    expect(op.gasReserveLowCount()).toBe(0)
    // Gone from the tracker entirely, not just hidden: a direct, unscoped read confirms eviction, not merely
    // that it fell out of `runners` (which alone would already make gasReserveSnapshot skip it).
    expect(internals.gasReserve.lowCount()).toBe(0)
  })

  test('a restarted account (startLoop calls stopLoop first) never reads back its stale pre-stop state', () => {
    const { op, internals } = fakeOperator()
    internals.runners.set('acc-1', { stopped: false, timer: null })
    internals.gasReserve.record('acc-1', 100n, 500n) // low, before the restart
    internals.stopLoop('acc-1')

    // startLoop would now re-add the runner before the engine's first review has run.
    internals.runners.set('acc-1', { stopped: false, timer: null })
    const s = op.gasReserveSnapshot().find((x) => x.account === 'acc-1')
    expect(s).toBeDefined()
    expect(s!.low).toBe(false) // not the stale "low: true" from before the stop
    expect(s!.nativeWei).toBeNull()
    expect(s!.lowSince).toBeNull()
    expect(op.gasReserveLowCount()).toBe(0)
  })
})
