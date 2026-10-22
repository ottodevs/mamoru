import { describe, expect, test } from 'bun:test'
import { conservadorLiveV1 } from '@mamoru/policy'
import { ALERT_RUNWAY_PREFUNDS, MIN_ENGINE_MAX_FEE_PER_GAS, ONE_ACTION_GAS_UNITS, defaultGasReserveAlertWei, onePrefundWei, gasReserveAlertOverrideFromEnv, gasReserveAlertWei } from '../src/gas-reserve.ts'

// Real live-policy numbers, not invented ones (operator#8 review, finding #4): the hard floor the engine
// freezes at (ehgPreliminary's ACCT_GAS_RESERVE_LOW) and the target the relayer actually funds a Safe to at
// activation (gasReserveWei + TOP_UP_MARGIN_WEI, operator.ts activation top-up). TOP_UP_MARGIN_WEI itself is not
// exported from operator.ts; its value (200_000_000_000_000n) is pinned here so a change to either constant
// breaks this test loudly instead of silently drifting the "freshly activated is not low" guarantee.
const GAS_RESERVE_WEI = conservadorLiveV1.gasReserveWei
const TOP_UP_MARGIN_WEI = 200_000_000_000_000n
const ACTIVATION_TARGET_WEI = GAS_RESERVE_WEI + TOP_UP_MARGIN_WEI

describe('defaultGasReserveAlertWei (otto/mamoru#53 reviews)', () => {
  // What the engine bids at Base's 5,000,000 wei minimum base fee: 2 x 5e6 + 1e6.
  const MIN_FEE = 11_000_000n

  test('is the hard floor plus two worst-case prefunds at the engine fee, never priced below Base minimum', () => {
    expect(GAS_RESERVE_WEI).toBe(300_000_000_000_000n)
    expect(MIN_ENGINE_MAX_FEE_PER_GAS).toBe(MIN_FEE)
    expect(ONE_ACTION_GAS_UNITS).toBe(5_100_000n)
    expect(ALERT_RUNWAY_PREFUNDS).toBe(2n)
    expect(onePrefundWei(MIN_FEE)).toBe(56_100_000_000_000n)
    // A fee below what Base allows (a test fork, a stale read) is still priced at the minimum.
    expect(onePrefundWei(3_000_000n)).toBe(56_100_000_000_000n)
    expect(defaultGasReserveAlertWei(GAS_RESERVE_WEI, MIN_FEE)).toBe(412_200_000_000_000n)
    expect(defaultGasReserveAlertWei(GAS_RESERVE_WEI, 0n)).toBe(412_200_000_000_000n)
  })

  test('Sol NO-GO scenario: a Safe not low at the threshold survives one full empty-deposit prefund above the floor', () => {
    for (const fee of [MIN_FEE, 15_000_000n, 41_000_000n]) {
      const threshold = defaultGasReserveAlertWei(GAS_RESERVE_WEI, fee)
      const afterOne = threshold - onePrefundWei(fee)
      // ehgPreliminary refuses at native < gasReserveWei: one action later the Safe is still allowed, and already low.
      expect(afterOne < GAS_RESERVE_WEI).toBe(false)
      expect(afterOne < threshold).toBe(true)
    }
  })

  test('rises with the engine fee: the threshold follows the prefund the next action would need', () => {
    const atMin = defaultGasReserveAlertWei(GAS_RESERVE_WEI, MIN_FEE)
    const atHigher = defaultGasReserveAlertWei(GAS_RESERVE_WEI, 2n * MIN_FEE)
    expect(atHigher - GAS_RESERVE_WEI).toBe(2n * (atMin - GAS_RESERVE_WEI))
  })

  test('a freshly activated account is not low at Base minimum fee, nor after its first userOp seeds the EntryPoint deposit', () => {
    const threshold = defaultGasReserveAlertWei(GAS_RESERVE_WEI, MIN_FEE)
    expect(threshold).toBeGreaterThan(GAS_RESERVE_WEI)
    expect(threshold).toBeLessThan(ACTIVATION_TARGET_WEI)
    expect(ACTIVATION_TARGET_WEI < threshold).toBe(false)
    expect(ACTIVATION_TARGET_WEI - onePrefundWei(MIN_FEE) < threshold).toBe(false)
  })

  test('uses the userOp gas units the observation carries', () => {
    expect(defaultGasReserveAlertWei(GAS_RESERVE_WEI, MIN_FEE, 1_000_000n)).toBe(GAS_RESERVE_WEI + 2n * 1_000_000n * MIN_FEE)
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
    expect(gasReserveAlertWei(GAS_RESERVE_WEI, 1n, 11_000_000n)).toBe(1n)
    expect(gasReserveAlertWei(GAS_RESERVE_WEI, 0n, 11_000_000n)).toBe(0n)
  })

  test('falls back to the default (floor + runway) with no override', () => {
    expect(gasReserveAlertWei(GAS_RESERVE_WEI, null, 11_000_000n)).toBe(defaultGasReserveAlertWei(GAS_RESERVE_WEI, 11_000_000n))
  })
})
