import { describe, expect, test } from 'bun:test'
import { defaultGasReserveAlertWei, gasReserveAlertOverrideFromEnv, gasReserveAlertWei } from '../src/gas-reserve.ts'

const GAS_RESERVE_WEI = 300_000_000_000_000n
const TOP_UP_MARGIN_WEI = 200_000_000_000_000n

describe('defaultGasReserveAlertWei', () => {
  test('is the policy floor plus the activation top-up margin, the same target the relayer funds at activation', () => {
    expect(defaultGasReserveAlertWei(GAS_RESERVE_WEI, TOP_UP_MARGIN_WEI)).toBe(500_000_000_000_000n)
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
  test('uses the override when present, whatever the policy values', () => {
    expect(gasReserveAlertWei(GAS_RESERVE_WEI, TOP_UP_MARGIN_WEI, 1n)).toBe(1n)
    expect(gasReserveAlertWei(GAS_RESERVE_WEI, TOP_UP_MARGIN_WEI, 0n)).toBe(0n)
  })

  test('falls back to the default target with no override', () => {
    expect(gasReserveAlertWei(GAS_RESERVE_WEI, TOP_UP_MARGIN_WEI, null)).toBe(500_000_000_000_000n)
  })
})
