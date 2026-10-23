import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ReasonError } from '@mamoru/domain'
import { basePolicyOf, defaultDatasetsDir, manifestWindowByDatasetId, parseSpecKey, policyOf, specKey, validateSpec, variantLabel, type BenchSpec } from './spec.ts'

/**
 * Committed, synthetic, tiny (review of #117 round 2: CI has no `~/.local/share/mamoru-lab/datasets` — the real
 * manifest and dataset files never ship, so a test that reaches the filesystem through the default `datasetsDir`
 * throws ENOENT on a fresh box). `fix-full` has all three pools; `fix-nobtc` is aug2024-shaped (no cbBTC data);
 * `fix-test` is a TEST-split window. See `__fixtures__/manifest.json` and run.test.ts for the generator's intent.
 */
const FIXTURE_DIR = `${import.meta.dir}/__fixtures__`

// windowId here is never resolved against a manifest — specKey/policyOf/variantLabel are pure string/catalog
// functions — so an arbitrary id is fine for them; validateSpec's own describe block below overrides it.
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
  // Every call below passes FIXTURE_DIR: validateSpec resolves windowId against a manifest, so this must never
  // reach the default (the real ~/.local/share/mamoru-lab/datasets), which CI does not have.
  test('a well-formed TRAIN spec passes', () => {
    expect(() => validateSpec(spec({ windowId: 'fix-full' }), FIXTURE_DIR)).not.toThrow()
    expect(() => validateSpec(spec({ windowId: 'fix-full', widthTicks: 8000, deposit: 10_000 }), FIXTURE_DIR)).not.toThrow()
    expect(() => validateSpec(spec({ windowId: 'fix-full', widthTicks: 500, deposit: 100 }), FIXTURE_DIR)).not.toThrow()
  })

  test('widthTicks out of 500..8000 or off the 500 step is LAB_SPEC_INVALID', () => {
    for (const widthTicks of [0, 400, 8500, 2001, -2000]) {
      expect(() => validateSpec(spec({ windowId: 'fix-full', widthTicks }), FIXTURE_DIR)).toThrow(ReasonError)
      try {
        validateSpec(spec({ windowId: 'fix-full', widthTicks }), FIXTURE_DIR)
      } catch (e) {
        expect((e as ReasonError).code).toBe('LAB_SPEC_INVALID')
      }
    }
  })

  test('deposit out of 100..10000 or not a whole number is LAB_SPEC_INVALID', () => {
    for (const deposit of [0, 99, 10_001, 500.5]) {
      try {
        validateSpec(spec({ windowId: 'fix-full', deposit }), FIXTURE_DIR)
        throw new Error('expected validateSpec to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ReasonError)
        expect((e as ReasonError).code).toBe('LAB_SPEC_INVALID')
      }
    }
  })

  test('an unknown windowId is LAB_SPEC_INVALID', () => {
    try {
      validateSpec(spec({ windowId: 'not-a-window' }), FIXTURE_DIR)
      throw new Error('expected validateSpec to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ReasonError)
      expect((e as ReasonError).code).toBe('LAB_SPEC_INVALID')
    }
  })

  test('a TEST window is LAB_HOLDOUT_DENIED, never LAB_SPEC_INVALID (AL-12a)', () => {
    try {
      validateSpec(spec({ windowId: 'fix-test' }), FIXTURE_DIR)
      throw new Error('expected validateSpec(fix-test) to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ReasonError)
      expect((e as ReasonError).code).toBe('LAB_HOLDOUT_DENIED')
    }
  })

  test('every TRAIN window of the manifest passes', () => {
    for (const windowId of ['fix-full', 'fix-nobtc']) {
      expect(() => validateSpec(spec({ windowId }), FIXTURE_DIR)).not.toThrow()
    }
  })
})

describe('manifestWindowByDatasetId (otto/mamoru#200 review, AL-10: run_backtest may name a window by dataset id)', () => {
  test('resolves a TRAIN dataset id to its window, without loading the dataset file', () => {
    const w = manifestWindowByDatasetId('0x852bf32acfea20911aaa2572caf1fe3d759b94ff543593b6a9ee49673e29f828', FIXTURE_DIR)
    expect(w.id).toBe('fix-full')
    expect(w.split).toBe('train')
  })

  test('resolves a TEST dataset id too — the caller decides what that means (AL-12a), this is manifest-only', () => {
    const w = manifestWindowByDatasetId('0x6669782d746573742d686f6c646f75742d666978747572652d6f6e6c792d3030', FIXTURE_DIR)
    expect(w.id).toBe('fix-test')
    expect(w.split).toBe('test')
  })

  test('an unknown dataset id is LAB_SPEC_INVALID', () => {
    try {
      manifestWindowByDatasetId('0xnot-a-real-dataset', FIXTURE_DIR)
      throw new Error('expected manifestWindowByDatasetId to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ReasonError)
      expect((e as ReasonError).code).toBe('LAB_SPEC_INVALID')
    }
  })
})

describe('validateSpec against the real Lab datasets', () => {
  test.skipIf(!existsSync(join(defaultDatasetsDir(), 'manifest.json')))('needs local Lab datasets: every real TRAIN window passes, every real TEST window is denied', () => {
    for (const windowId of ['sep2026', 'oct2025', 'feb2025', 'mar2025', 'dec2024', 'aug2024', 'calm-2025-09', 'calm-2026-04']) expect(() => validateSpec(spec({ windowId }))).not.toThrow()
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
})
