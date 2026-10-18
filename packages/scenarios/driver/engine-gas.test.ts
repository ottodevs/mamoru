// Spec 007 T7 (P1 4): the engine's userOps stay under a v4 session's MamoruGasPolicy caps, and wait when they cannot.
import { describe, expect, test } from 'bun:test'
import { V4_GAS_CAPS } from '@mamoru/policy'
import { LAB_GAS_LIMITS, MAX_PRIORITY_FEE_PER_GAS, engineGas } from './engine.ts'

describe('engineGas', () => {
  test('no caps (every live policy): exactly the settings as before', () => {
    expect(engineGas(5_000_000n)).toEqual({ ...LAB_GAS_LIMITS, maxFeePerGas: 11_000_000n, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS })
    expect(engineGas(10n ** 12n)?.maxFeePerGas).toBe(2n * 10n ** 12n + MAX_PRIORITY_FEE_PER_GAS)
  })

  test('under the caps at a usual basefee: unchanged', () => {
    expect(engineGas(5_000_000n, V4_GAS_CAPS)).toEqual(engineGas(5_000_000n))
  })

  test('2 x basefee over the maxFeePerGas cap but basefee + priority under it: clamped to the cap', () => {
    const g = engineGas(60_000_000n, V4_GAS_CAPS)!
    expect(g.maxFeePerGas).toBe(V4_GAS_CAPS.maxFeePerGas)
  })

  test('basefee + priority over the cap: wait (null), never an op the policy refuses', () => {
    expect(engineGas(V4_GAS_CAPS.maxFeePerGas, V4_GAS_CAPS)).toBeNull()
  })

  test('caps tighter than the fixed limits: wait', () => {
    expect(engineGas(1n, { ...V4_GAS_CAPS, maxVerificationGasLimit: 1_000_000n })).toBeNull()
  })
})
