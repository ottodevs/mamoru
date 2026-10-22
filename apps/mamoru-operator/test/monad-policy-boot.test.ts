// otto/mamoru#65: the operator resolves the Monad lab policy by name, and only boots it on the Monad registry.
import { describe, expect, test } from 'bun:test'
import { baseRegistry, monadRegistry } from '@mamoru/registry'
import { labWmonUsdcMonadV1 } from '@mamoru/policy'
import { assertPolicyOnRegistry, resolveNamedPolicy } from '../src/boot.ts'

describe('Monad lab policy at boot', () => {
  test('MAMORU_POLICY=lab-wmon-usdc-monad-v1 resolves', () => {
    expect(resolveNamedPolicy('lab-wmon-usdc-monad-v1', {})).toBe(labWmonUsdcMonadV1)
  })

  test('on the Monad registry it boots; on Base it is refused before any account is read', () => {
    expect(() => assertPolicyOnRegistry(labWmonUsdcMonadV1, monadRegistry)).not.toThrow()
    expect(() => assertPolicyOnRegistry(labWmonUsdcMonadV1, baseRegistry)).toThrow()
  })
})
