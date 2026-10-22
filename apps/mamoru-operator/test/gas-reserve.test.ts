import { describe, expect, test } from 'bun:test'
import { conservadorLiveV1 } from '@mamoru/policy'
import { ALERT_RUNWAY_ACTIONS, ONE_ACTION_WEI, defaultGasReserveAlertWei, gasReserveAlertOverrideFromEnv, gasReserveAlertWei } from '../src/gas-reserve.ts'

// Real live-policy numbers, not invented ones (operator#8 review, finding #4): the hard floor the engine
// freezes at (ehgPreliminary's ACCT_GAS_RESERVE_LOW) and the target the relayer actually funds a Safe to at
// activation (gasReserveWei + TOP_UP_MARGIN_WEI, operator.ts activation top-up). TOP_UP_MARGIN_WEI itself is not
// exported from operator.ts; its value (200_000_000_000_000n) is pinned here so a change to either constant
// breaks this test loudly instead of silently drifting the "freshly activated is not low" guarantee.
const GAS_RESERVE_WEI = conservadorLiveV1.gasReserveWei
const TOP_UP_MARGIN_WEI = 200_000_000_000_000n
const ACTIVATION_TARGET_WEI = GAS_RESERVE_WEI + TOP_UP_MARGIN_WEI

describe('defaultGasReserveAlertWei (otto/mamoru#8 review, finding #4)', () => {
  test('is the hard floor plus a small number of actions of runway, not the Safe\'s entire funded margin', () => {
    expect(GAS_RESERVE_WEI).toBe(300_000_000_000_000n)
    expect(ALERT_RUNWAY_ACTIONS).toBe(3n)
    expect(ONE_ACTION_WEI).toBe(15_300_000_000_000n)
    expect(defaultGasReserveAlertWei(GAS_RESERVE_WEI)).toBe(345_900_000_000_000n)
  })

  test('sits strictly between the hard floor and the full activation target, on the real live policy', () => {
    const threshold = defaultGasReserveAlertWei(GAS_RESERVE_WEI)
    expect(threshold).toBeGreaterThan(GAS_RESERVE_WEI)
    expect(threshold).toBeLessThan(ACTIVATION_TARGET_WEI)
  })

  test('a freshly activated account (native == the full funded target) is not low, nor one that ran a handful of ordinary actions', () => {
    // Linear decrease model at ONE_ACTION_WEI per action, from the full funded target.
    const nativeAfter = (actions: bigint) => ACTIVATION_TARGET_WEI - actions * ONE_ACTION_WEI
    const threshold = defaultGasReserveAlertWei(GAS_RESERVE_WEI)
    expect(nativeAfter(0n) < threshold).toBe(false) // freshly activated
    for (const actions of [1n, 2n, 3n, 4n, 5n]) expect(nativeAfter(actions) < threshold).toBe(false) // a normal handful
    // It does eventually cross, well before the account could ever reach the hard floor.
    expect(nativeAfter(11n) < threshold).toBe(true)
  })

  test('exactly ALERT_RUNWAY_ACTIONS actions above the hard floor, by construction', () => {
    const threshold = defaultGasReserveAlertWei(GAS_RESERVE_WEI)
    expect(threshold - ALERT_RUNWAY_ACTIONS * ONE_ACTION_WEI).toBe(GAS_RESERVE_WEI)
  })
})

describe('gasReserveAlertOverrideFromEnv', () => {
  test('an unset or empty value is no override', () => {
    expect(gasReserveAlertOverrideFromEnv({})).toBeNull()
    expect(gasReserveAlertOverrideFromEnv({ MAMORU_GAS_RESERVE_ALERT_WEI: '' })).toBeNull()
    expect(gasReserveAlertOverrideFromEnv({ MAMORU_GAS_RESERVE_ALERT_WEI: '   ' })).toBeNull()
  })

  test('a non-negative integer string overrides', () => {
    expect(gasReserveAlertOverrideFromEnv({ MAMORU_GAS_RESERVE_ALERT_WEI: '1000000000000000' })).toBe(1_000_000_000_000_000n)
    expect(gasReserveAlertOverrideFromEnv({ MAMORU_GAS_RESERVE_ALERT_WEI: '0' })).toBe(0n)
  })

  test('anything not a plain non-negative integer is ignored, never throws', () => {
    for (const bad of ['-1', '1.5', '1e18', 'many', '0x10']) expect(gasReserveAlertOverrideFromEnv({ MAMORU_GAS_RESERVE_ALERT_WEI: bad })).toBeNull()
  })

  test('surrounding whitespace is trimmed before the plain-integer check', () => {
    expect(gasReserveAlertOverrideFromEnv({ MAMORU_GAS_RESERVE_ALERT_WEI: ' 10 ' })).toBe(10n)
  })
})

describe('gasReserveAlertWei', () => {
  test('uses the override when present, whatever the policy value', () => {
    expect(gasReserveAlertWei(GAS_RESERVE_WEI, 1n)).toBe(1n)
    expect(gasReserveAlertWei(GAS_RESERVE_WEI, 0n)).toBe(0n)
  })

  test('falls back to the default (floor + runway) with no override', () => {
    expect(gasReserveAlertWei(GAS_RESERVE_WEI, null)).toBe(defaultGasReserveAlertWei(GAS_RESERVE_WEI))
  })
})
