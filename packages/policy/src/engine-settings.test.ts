import { describe, expect, test } from 'bun:test'
import {
  canonicalSettingsJson,
  capBaseUnits,
  DEFAULT_ENGINE_SETTINGS,
  ENGINE_SETTINGS_TEMPLATES,
  parseEngineSettings,
  riskyChanges,
  validateEngineSettings,
  withEngineSettings,
  type EngineSettings,
} from './engine-settings.ts'
import { conservadorLiveV2 } from './policies.ts'

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
