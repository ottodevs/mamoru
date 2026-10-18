import { describe, expect, test } from 'bun:test'
import { POLICIES } from '@mamoru/policy'
import { resolveNamedPolicy, syncYieldLedgerFlag } from '../src/boot.ts'

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

describe('resolveNamedPolicy (otto/mamoru#151 T7): conservadorLiveV4 is only reachable behind an explicit, env-read opt-in', () => {
  const ADDR = '0x00000000000000000000000000000000000000Fe'

  test('a v2/v3 policyId resolves exactly as POLICIES[id] always has, whatever the env says', () => {
    expect(resolveNamedPolicy('conservador-live-v2', {})).toBe(POLICIES['conservador-live-v2'])
    expect(resolveNamedPolicy('conservador-live-v2', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR })).toBe(POLICIES['conservador-live-v2'])
  })

  test('an unknown policyId with the flag off (default): undefined, same as POLICIES[id] on any unknown name — nothing changes while off', () => {
    expect(resolveNamedPolicy('conservador-live-v4', {})).toBeUndefined()
    expect(resolveNamedPolicy('nonsense', {})).toBeUndefined()
  })

  test('conservador-live-v4 with the flag off: still undefined (not reachable without the opt-in)', () => {
    expect(resolveNamedPolicy('conservador-live-v4', { MAMORU_ACTION_POLICY_ADDRESS: ADDR })).toBeUndefined()
  })

  test('conservador-live-v4 with the flag on but no deployed address: throws (never silently unset)', () => {
    expect(() => resolveNamedPolicy('conservador-live-v4', { MAMORU_ONCHAIN_POLICY_V4: '1' })).toThrow('MAMORU_ACTION_POLICY_ADDRESS')
  })

  test('conservador-live-v4 with the flag on and a deployed address: resolves with actionPolicy wired to that address, bands only (no per-account budgets yet)', () => {
    const policy = resolveNamedPolicy('conservador-live-v4', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR })
    expect(policy?.policyId).toBe('conservador-live-v4')
    expect(policy?.actionPolicy?.address.toLowerCase()).toBe(ADDR.toLowerCase())
    expect(Object.keys(policy?.actionPolicy?.bandTicksByPool ?? {}).length).toBeGreaterThan(0)
    expect(policy?.actionPolicy?.budgetsByPool).toBeUndefined()
  })

  test('conservador-lab-v4 behind the same gate', () => {
    expect(resolveNamedPolicy('conservador-lab-v4', {})).toBeUndefined()
    const policy = resolveNamedPolicy('conservador-lab-v4', { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: ADDR })
    expect(policy?.policyId).toBe('conservador-lab-v4')
  })
})
