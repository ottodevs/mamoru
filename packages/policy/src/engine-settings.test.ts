import { describe, expect, test } from 'bun:test'
import {
  canonicalSettingsJson,
  capBaseUnits,
  DEFAULT_ENGINE_SETTINGS,
  ENGINE_SETTINGS_BOUNDS,
  ENGINE_SETTINGS_TEMPLATES,
  lazyOf,
  parseEngineSettings,
  riskyChanges,
  validateEngineSettings,
  withEngineSettings,
  type EngineSettings,
} from './engine-settings.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { policyHash } from './instantiate.ts'
import { conservadorLiveV2, POLICIES } from './policies.ts'

const depthOn: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 }, capUsdc: 1000 }

describe('engine settings (spec 006)', () => {
  test('every seeded template is valid', () => {
    for (const [name, s] of Object.entries(ENGINE_SETTINGS_TEMPLATES)) expect({ name, errors: validateEngineSettings(s) }).toEqual({ name, errors: [] })
  })

  test('out-of-bounds values, unknown keys and wrong types are refused', () => {
    expect(validateEngineSettings({ ...depthOn, depth: { impactBps: 0, shareBps: 500 } })).toContain('depth.impactBps must be a whole number from 1 to 500')
    expect(validateEngineSettings({ ...depthOn, depth: { impactBps: 30, shareBps: 9000 } })).toContain('depth.shareBps must be a whole number from 1 to 5000')
    expect(validateEngineSettings({ ...depthOn, capUsdc: 1.5 })).toContain('capUsdc must be a whole number from 1 to 1000000')
    expect(validateEngineSettings({ ...depthOn, extra: 1 })).toContain('unknown setting extra')
    expect(validateEngineSettings({ ...depthOn, guard: { ...depthOn.guard, enabled: 'yes' } })).toContain('guard.enabled must be true or false')
    expect(validateEngineSettings({ ...depthOn, guard: { ...depthOn.guard, btc: { fallBps: 50, volBps: 8000 } } })).toContain('guard.btc.fallBps must be a whole number from 100 to 3000')
    expect(validateEngineSettings(null)).toEqual(['settings must be an object'])
    expect(() => parseEngineSettings({})).toThrow('invalid engine settings')
  })

  test('a cap above the default needs depth sizing', () => {
    expect(validateEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, capUsdc: 1000 })).toContain('capUsdc above 100 needs depth sizing')
    expect(validateEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, capUsdc: 100 })).toEqual([])
  })

  test('risky changes are named; safe ones are not', () => {
    expect(riskyChanges(DEFAULT_ENGINE_SETTINGS, depthOn)).toEqual(['cap per account rises from 100 to 1000 USDC'])
    const guardOn = ENGINE_SETTINGS_TEMPLATES['lab guards (fall freeze 7%/9%)']!
    expect(riskyChanges(guardOn, DEFAULT_ENGINE_SETTINGS)).toEqual(['the fall guard turns off'])
    expect(riskyChanges(depthOn, { ...depthOn, depth: null, capUsdc: 100 })).toEqual(['depth sizing turns off'])
    expect(riskyChanges(depthOn, { ...depthOn, depth: { impactBps: 50, shareBps: 500, stablesImpactBps: 5 } })).toEqual(['entries may move the pool price more'])
    expect(riskyChanges(depthOn, { ...depthOn, capUsdc: 500 })).toEqual([])
    // Dropping the stables value loosens it to the general impact limit (30 > 5): risky. Adding one below it: not.
    expect(riskyChanges(depthOn, { ...depthOn, depth: { impactBps: 30, shareBps: 500 } })).toEqual(['stables entries may move the pool price more'])
    expect(riskyChanges({ ...depthOn, depth: { impactBps: 30, shareBps: 500 } }, depthOn)).toEqual([])
    expect(riskyChanges(DEFAULT_ENGINE_SETTINGS, guardOn)).toEqual([])
  })

  test('canonical JSON ignores key order', () => {
    const a = { capUsdc: 1000, guard: depthOn.guard, depth: depthOn.depth } as EngineSettings
    expect(canonicalSettingsJson(a)).toBe(canonicalSettingsJson(depthOn))
  })

  test('the engine policy gets depth and guards; the grants stay exactly the same', () => {
    const p = withEngineSettings(conservadorLiveV2, { ...depthOn, guard: { ...depthOn.guard, enabled: true } })
    expect(p.depth).toEqual({ maxImpactBps: 30, maxShareBps: 500, maxImpactBpsByPool: { 'pool:USDC/USDT/100': 5 } })
    expect(p.guards?.byBucket['btc-usdc']?.fallFreeze).toEqual({ fallBps: 700, volBps: 8000 })
    expect(p.guards?.byBucket.risk?.fallFreeze).toEqual({ fallBps: 900, volBps: 10_000 })
    expect(p.session).toBe(conservadorLiveV2.session)
    expect(p.policyId).toBe(conservadorLiveV2.policyId)
    expect(withEngineSettings(conservadorLiveV2, DEFAULT_ENGINE_SETTINGS)).toBe(conservadorLiveV2)
    expect(capBaseUnits(depthOn)).toBe(1_000_000_000n)
    expect(capBaseUnits(DEFAULT_ENGINE_SETTINGS)).toBeNull()
    // Off means off even when a base policy carries its own depth or guards.
    const carried = { ...conservadorLiveV2, depth: { maxImpactBps: 1, maxShareBps: 1 }, guards: { byBucket: {} } }
    const off = withEngineSettings(carried, DEFAULT_ENGINE_SETTINGS)
    expect(off.depth).toBeUndefined()
    expect(off.guards).toBeUndefined()
  })
})

const LAZY_TEMPLATE = 'conservador-live-v2 + lazy-h24h-b100-d30'
const lazyOn = ENGINE_SETTINGS_TEMPLATES[LAZY_TEMPLATE]!
const lazyParams = { edgeBufferTicks: 100, minDwellSeconds: 1800, horizonSeconds: 86_400, lvrWeightBps: 10_000 }

/** Policy hashes on origin/main before otto/mamoru#172: no setting may move one (nobody re-signs). */
const PINNED_HASHES: Record<string, string> = {
  'conservador-v1': '0xb98c8b55215256eb21ba107ed84e8ee54cfe4658422528cebcdb91e5c9345d18',
  'conservador-lab-v1': '0xcceafbb24a2e9ef40e496a756f97d338eec76a08f4a2e4a3eb9185240339b3c2',
  'conservador-live-v1': '0xa8973212b542a232f25e09b73ef39c8496c5b5f599667f2a9236109fc6660376',
  'conservador-live-v2': '0x3b4759978007f38513d67d64d09b65957e90f9ab4d0c75afa22a1d016d939cf0',
  'lab-weth-usdc-v1': '0x7eb02363bcc36716f3558bded564e9a84ea7ee1866ed7c06ecb408f8eba5405b',
  'conservador-lab-guards-v1': '0x5a1e148c145901727b6848f9188c5a2c7bc362e4ea36fb5bf2a93e7ad9331ed2',
  'conservador-lab-geometry-v1': '0x80523980a91354ff4593b109e62d2168d2a9525ae6e1d37d9fdc7299b4d83162',
}

describe('re-range setting (otto/mamoru#172)', () => {
  test('the lazy template is the Lab candidate lazy-h24h-b100-d30, byte for byte', () => {
    const file = join(import.meta.dir, '../../../specs/004-loss-control/results/variants/test-candidates.json')
    const variant = (JSON.parse(readFileSync(file, 'utf8')) as { name: string; policy: string; overrides?: { range?: { lazy?: unknown } } }[]).find((v) => v.name === 'lazy-h24h-b100-d30')!
    expect(variant.policy).toBe('conservador-live-v2')
    expect(lazyOf(lazyOn)).toEqual(variant.overrides!.range!.lazy as never)
    // Everything else is today's settings.
    expect({ ...lazyOn, rerange: undefined }).toEqual({ ...DEFAULT_ENGINE_SETTINGS, rerange: undefined })
  })

  test('absent means eager, and the settings written before the knob keep their canonical JSON', () => {
    expect(DEFAULT_ENGINE_SETTINGS.rerange).toBeUndefined()
    expect(lazyOf(DEFAULT_ENGINE_SETTINGS)).toBeNull()
    expect(lazyOf({ ...DEFAULT_ENGINE_SETTINGS, rerange: { mode: 'eager', ...lazyParams } })).toBeNull()
    expect(canonicalSettingsJson(DEFAULT_ENGINE_SETTINGS)).toBe(
      '{"capUsdc":null,"depth":null,"guard":{"btc":{"fallBps":700,"volBps":8000},"enabled":false,"eth":{"fallBps":900,"volBps":10000}}}',
    )
  })

  test('bounds: every number of lazy is required and in range; eager may carry them, in range', () => {
    const at = (r: unknown) => validateEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, rerange: r })
    expect(at({ mode: 'lazy', ...lazyParams })).toEqual([])
    expect(at({ mode: 'eager' })).toEqual([])
    expect(at({ mode: 'eager', ...lazyParams })).toEqual([])
    const B = ENGINE_SETTINGS_BOUNDS
    for (const k of ['edgeBufferTicks', 'minDwellSeconds', 'horizonSeconds', 'lvrWeightBps'] as const) {
      const msg = `rerange.${k} must be a whole number from ${B[k].min} to ${B[k].max}`
      expect(at({ mode: 'lazy', ...lazyParams, [k]: B[k].min })).toEqual([])
      expect(at({ mode: 'lazy', ...lazyParams, [k]: B[k].max })).toEqual([])
      expect(at({ mode: 'lazy', ...lazyParams, [k]: B[k].max + 1 })).toContain(msg)
      expect(at({ mode: 'lazy', ...lazyParams, [k]: B[k].min - 1 })).toContain(msg)
      expect(at({ mode: 'lazy', ...lazyParams, [k]: 1.5 })).toContain(msg)
      expect(at({ mode: 'lazy', ...lazyParams, [k]: undefined })).toContain(msg)
      expect(at({ mode: 'eager', [k]: B[k].max + 1 })).toContain(msg)
    }
    expect(at({ mode: 'sometimes' })).toContain("rerange.mode must be 'eager' or 'lazy'")
    expect(at({ mode: 'lazy', ...lazyParams, cooldownSeconds: 1 })).toContain('unknown rerange setting cooldownSeconds')
    expect(at(null)).toContain('rerange must be an object')
    expect(at([])).toContain('rerange must be an object')
    expect(() => parseEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, rerange: { mode: 'lazy' } })).toThrow('rerange.edgeBufferTicks')
  })

  test('confirm step: turning lazy on, or making it lazier, is risky; back to eager or less lazy is not', () => {
    expect(riskyChanges(DEFAULT_ENGINE_SETTINGS, lazyOn)).toEqual(['re-ranges become lazy: an out-of-range position waits for the buffer, the dwell and the cost test, and may stay out of range'])
    expect(riskyChanges(lazyOn, DEFAULT_ENGINE_SETTINGS)).toEqual([])
    expect(riskyChanges(lazyOn, { ...lazyOn, rerange: { mode: 'eager', ...lazyParams } })).toEqual([])
    const lazier = { ...lazyOn, rerange: { mode: 'lazy' as const, edgeBufferTicks: 200, minDwellSeconds: 7200, horizonSeconds: 21_600, lvrWeightBps: 15_000 } }
    expect(riskyChanges(lazyOn, lazier)).toEqual([
      'a position must be further out of range before it is re-ranged',
      'a position waits longer out of range before it is re-ranged',
      'the cost test counts fewer hours of fees, so it lets fewer re-ranges through',
      'the cost test weighs LVR more, so it lets fewer re-ranges through',
    ])
    expect(riskyChanges(lazier, lazyOn)).toEqual([])
  })

  test('overlay: lazy sets range.lazy on a new object; session, buckets, cooldown and widths are the same', () => {
    const p = withEngineSettings(conservadorLiveV2, lazyOn)
    expect(p).not.toBe(conservadorLiveV2)
    expect(p.range.lazy).toEqual(lazyParams)
    expect({ ...p.range, lazy: undefined }).toEqual({ ...conservadorLiveV2.range, lazy: undefined })
    expect(p.session).toBe(conservadorLiveV2.session)
    expect(p.buckets).toBe(conservadorLiveV2.buckets)
    expect(conservadorLiveV2.range.lazy).toBeUndefined()
    // Eager, or absent, hands the account's policy back untouched; a base policy's own lazy is dropped (off means off).
    expect(withEngineSettings(conservadorLiveV2, { ...DEFAULT_ENGINE_SETTINGS, rerange: { mode: 'eager', ...lazyParams } })).toBe(conservadorLiveV2)
    const carried = withEngineSettings(conservadorLiveV2, lazyOn)
    const off = withEngineSettings(carried, DEFAULT_ENGINE_SETTINGS)
    expect('lazy' in off.range).toBe(false)
    expect(off.range).toEqual(conservadorLiveV2.range)
  })

  test('no setting changes a policy hash: every policy, every template, before and after the overlay', () => {
    expect(Object.keys(POLICIES).sort()).toEqual(Object.keys(PINNED_HASHES).sort())
    const before = Object.fromEntries(Object.entries(POLICIES).map(([k, p]) => [k, JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))]))
    for (const s of Object.values(ENGINE_SETTINGS_TEMPLATES)) for (const p of Object.values(POLICIES)) withEngineSettings(p, s)
    for (const [k, p] of Object.entries(POLICIES)) {
      expect({ k, hash: policyHash(p) as string }).toEqual({ k, hash: PINNED_HASHES[k]! })
      // Not mutated either (policyHash memoizes per object, so compare the content as well).
      expect(JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))).toBe(before[k]!)
    }
  })
})
