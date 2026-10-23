import { describe, expect, test } from 'bun:test'
import { ReasonError } from '@mamoru/domain'
import { basePolicyOf, parseSpecKey, policyOf, specKey, validateSpec, variantLabel, type BenchSpec } from './spec.ts'

const spec = (over: Partial<BenchSpec> = {}): BenchSpec => ({ windowId: 'feb2025', base: 'live', widthTicks: 2000, deposit: 1000, ...over })

describe('specKey', () => {
  test('is the four fields, pipe-joined, in order', () => {
    expect(specKey(spec())).toBe('feb2025|live|2000|1000')
    expect(specKey(spec({ base: 'guard', widthTicks: 4000, deposit: 500 }))).toBe('feb2025|guard|4000|500')
  })

  test('parseSpecKey is its inverse', () => {
    expect(parseSpecKey('feb2025|guard|4000|500')).toEqual(spec({ base: 'guard', widthTicks: 4000, deposit: 500 }))
  })

  test('parseSpecKey refuses a key of the wrong shape', () => {
    expect(() => parseSpecKey('feb2025|live|2000')).toThrow(ReasonError)
    expect(() => parseSpecKey('feb2025|neither|2000|1000')).toThrow(ReasonError)
  })
})

describe('policyOf', () => {
  test('widthTicks 2000 (the base default) is the base policy untouched', () => {
    expect(policyOf(spec())).toBe(basePolicyOf('live'))
    expect(policyOf(spec({ base: 'guard' }))).toBe(basePolicyOf('guard'))
  })

  test('another width overrides range.widthTicks only, suffixes policyId, keeps widthTicksByPool', () => {
    const p = policyOf(spec({ widthTicks: 4000 }))
    expect(p.policyId).toBe('conservador-live-v2+w4000')
    expect(p.range.widthTicks).toBe(4000)
    expect(p.range.widthTicksByPool).toEqual(basePolicyOf('live').range.widthTicksByPool)

    const g = policyOf(spec({ base: 'guard', widthTicks: 500 }))
    expect(g.policyId).toBe('conservador-lab-guards-v1+w500')
    expect(g.range.widthTicks).toBe(500)
    expect(g.range.widthTicksByPool).toEqual(basePolicyOf('guard').range.widthTicksByPool)
  })
})

describe('variantLabel', () => {
  test('live at the default width is "Política actual"', () => {
    expect(variantLabel(spec())).toBe('Política actual')
  })

  test('live at another width names the range, es-ES thousands', () => {
    expect(variantLabel(spec({ widthTicks: 4000 }))).toBe('Rango 4.000 ticks')
    expect(variantLabel(spec({ widthTicks: 500 }))).toBe('Rango 500 ticks')
  })

  test('guard at the default width is "Con guarda de caídas"', () => {
    expect(variantLabel(spec({ base: 'guard' }))).toBe('Con guarda de caídas')
  })

  test('guard at another width appends it', () => {
    expect(variantLabel(spec({ base: 'guard', widthTicks: 4000 }))).toBe('Con guarda de caídas + 4.000 ticks')
  })
})

describe('validateSpec (B-01)', () => {
  test('a well-formed TRAIN spec passes', () => {
    expect(() => validateSpec(spec())).not.toThrow()
    expect(() => validateSpec(spec({ widthTicks: 8000, deposit: 10_000 }))).not.toThrow()
    expect(() => validateSpec(spec({ widthTicks: 500, deposit: 100 }))).not.toThrow()
  })

  test('widthTicks out of 500..8000 or off the 500 step is LAB_SPEC_INVALID', () => {
    for (const widthTicks of [0, 400, 8500, 2001, -2000]) {
      expect(() => validateSpec(spec({ widthTicks }))).toThrow(ReasonError)
      try {
        validateSpec(spec({ widthTicks }))
      } catch (e) {
        expect((e as ReasonError).code).toBe('LAB_SPEC_INVALID')
      }
    }
  })

  test('deposit out of 100..10000 or not a whole number is LAB_SPEC_INVALID', () => {
    for (const deposit of [0, 99, 10_001, 500.5]) {
      try {
        validateSpec(spec({ deposit }))
        throw new Error('expected validateSpec to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ReasonError)
        expect((e as ReasonError).code).toBe('LAB_SPEC_INVALID')
      }
    }
  })

  test('an unknown windowId is LAB_SPEC_INVALID', () => {
    try {
      validateSpec(spec({ windowId: 'not-a-window' }))
      throw new Error('expected validateSpec to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ReasonError)
      expect((e as ReasonError).code).toBe('LAB_SPEC_INVALID')
    }
  })

  test('a TEST window is LAB_HOLDOUT_DENIED, never LAB_SPEC_INVALID (AL-12a)', () => {
    for (const windowId of ['apr2025', 'may2025', 'jun2025', 'calm-2026-05', 'feb2026']) {
      try {
        validateSpec(spec({ windowId }))
        throw new Error(`expected validateSpec(${windowId}) to throw`)
      } catch (e) {
        expect(e).toBeInstanceOf(ReasonError)
        expect((e as ReasonError).code).toBe('LAB_HOLDOUT_DENIED')
      }
    }
  })

  test('every TRAIN window of the manifest passes', () => {
    for (const windowId of ['sep2026', 'oct2025', 'feb2025', 'mar2025', 'dec2024', 'aug2024', 'calm-2025-09', 'calm-2026-04']) {
      expect(() => validateSpec(spec({ windowId }))).not.toThrow()
    }
  })
})
