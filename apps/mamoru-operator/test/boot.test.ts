import { describe, expect, test } from 'bun:test'
import { syncYieldLedgerFlag } from '../src/boot.ts'

function fakeLoop() {
  const calls: string[] = []
  return { calls, start: () => calls.push('start'), stop: () => calls.push('stop') }
}

describe('syncYieldLedgerFlag (otto/mamoru#129): boot.ts starts/stops the snapshot loop on the D1 flag', () => {
  test('off to on: starts the loop, logs the transition once', () => {
    const loop = fakeLoop()
    const lines: string[] = []
    const now = syncYieldLedgerFlag(loop, true, false, (l) => lines.push(l))
    expect(now).toBe(true)
    expect(loop.calls).toEqual(['start'])
    expect(lines).toEqual(['[flags] yield_ledger on'])
  })

  test('on to off: stops the loop, logs the transition once', () => {
    const loop = fakeLoop()
    const lines: string[] = []
    const now = syncYieldLedgerFlag(loop, false, true, (l) => lines.push(l))
    expect(now).toBe(false)
    expect(loop.calls).toEqual(['stop'])
    expect(lines).toEqual(['[flags] yield_ledger off'])
  })

  test('no change: neither started nor stopped, nothing logged, across repeated calls', () => {
    const loop = fakeLoop()
    const lines: string[] = []
    let on = false
    on = syncYieldLedgerFlag(loop, false, on, (l) => lines.push(l))
    on = syncYieldLedgerFlag(loop, false, on, (l) => lines.push(l))
    expect(loop.calls).toEqual([])
    expect(lines).toEqual([])
    expect(on).toBe(false)
  })

  test('a flap (on, off, on) calls start/stop every real transition, in order', () => {
    const loop = fakeLoop()
    let on = false
    on = syncYieldLedgerFlag(loop, true, on, () => {})
    on = syncYieldLedgerFlag(loop, false, on, () => {})
    on = syncYieldLedgerFlag(loop, true, on, () => {})
    expect(loop.calls).toEqual(['start', 'stop', 'start'])
    expect(on).toBe(true)
  })
})
