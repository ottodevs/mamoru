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
  validateAccountCapOverride,
  validateAccountCaps,
  validateEngineSettings,
  withEngineSettings,
  type EngineSettings,
} from './engine-settings.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { policyHash } from './instantiate.ts'
import { conservadorLiveV2, POLICIES } from './policies.ts'
import { conservadorLabV4, conservadorLiveV4 } from './policies-v4.ts'
import { V4_GAS_CAPS, V4_POOLS, withActionPolicy } from './v4-grants.ts'
import type { PolicyVersion } from './types.ts'

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

  test('bridgeOut (#133): optional, strict, absent keeps the hash, turning it on is a risky change', () => {
    expect(validateEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, bridgeOut: { enabled: true } })).toEqual([])
    expect(validateEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, bridgeOut: { enabled: 'yes' } })).toContain('bridgeOut must be { enabled: true | false }')
    expect(validateEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, bridgeOut: { enabled: true, extra: 1 } })).toContain('bridgeOut must be { enabled: true | false }')
    expect(validateEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, bridgeOut: null })).toContain('bridgeOut must be { enabled: true | false }')
    expect(canonicalSettingsJson(DEFAULT_ENGINE_SETTINGS)).not.toContain('bridgeOut')
    expect(riskyChanges(DEFAULT_ENGINE_SETTINGS, { ...DEFAULT_ENGINE_SETTINGS, bridgeOut: { enabled: true } })).toEqual(['owners can move USDC from Ethereum to Base, and the relayer pays the Ethereum gas'])
    expect(riskyChanges({ ...DEFAULT_ENGINE_SETTINGS, bridgeOut: { enabled: true } }, DEFAULT_ENGINE_SETTINGS)).toEqual([])
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
    // The Lab numbers, plus the live fail-closed flag (GPT-6 review): a missing estimate holds.
    expect(lazyOf(lazyOn)).toEqual({ ...(variant.overrides!.range!.lazy as object), requireCostEstimate: true } as never)
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
    expect(p.range.lazy).toEqual({ ...lazyParams, requireCostEstimate: true })
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

  // Spec 007 (merged after this knob was written): the v4 policies are kept out of POLICIES and reach the operator as
  // `withActionPolicy(conservadorLiveV4, …)` (boot.ts deployedV4). The overlay must leave them, and what their grants
  // bind to (actionPolicy, gas policy), exactly as unchanged as the v2 family.
  test('v4 policies: no setting changes their hash, mutates them, or touches session, buckets or actionPolicy', () => {
    const deployed = withActionPolicy(conservadorLiveV4, '0x00000000000000000000000000000000000000a1', Object.values(V4_POOLS), {
      gasPolicy: { address: '0x00000000000000000000000000000000000000a2', caps: V4_GAS_CAPS },
    })
    // Hashes on origin/main 3cd720a, before this knob.
    const pinned: [PolicyVersion, string][] = [
      [conservadorLiveV4, '0xdabdedb0d116c1135a085c3f295e8d3297c37e9ae11165c172fde776e0121955'],
      [conservadorLabV4, '0x732bd7b8afa2d27805941c8f6aae0facdf57ebe2895b2e136828599f3875d429'],
      [deployed, '0x5d5041adb7a9bec244c3188c5d59776d24862d0d07735af5dc3143c9d12fcc01'],
    ]
    const json = (p: PolicyVersion) => JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))
    for (const [p, hash] of pinned) {
      const before = json(p)
      for (const s of Object.values(ENGINE_SETTINGS_TEMPLATES)) withEngineSettings(p, s)
      expect({ id: p.policyId, hash: policyHash(p) as string }).toEqual({ id: p.policyId, hash })
      expect(json(p)).toBe(before)
      const lazy = withEngineSettings(p, lazyOn)
      expect(lazy.range.lazy).toEqual({ ...lazyParams, requireCostEstimate: true })
      expect(lazy.session).toBe(p.session)
      expect(lazy.buckets).toBe(p.buckets)
      expect(lazy.actionPolicy).toBe(p.actionPolicy)
      expect(withEngineSettings(lazy, DEFAULT_ENGINE_SETTINGS).range).toEqual(p.range)
    }
  })
})

describe('per-account cap overrides (otto/mamoru#26)', () => {
  const key = '00a7a1df-0000-4000-8000-000000000001'
  test('whole USDC within the cap bounds, or null to remove; a sane account key', () => {
    expect(validateAccountCapOverride({ accountKey: key, capUsdc: 2000 })).toEqual([])
    expect(validateAccountCapOverride({ accountKey: key, capUsdc: null })).toEqual([])
    expect(validateAccountCapOverride({ accountKey: key, capUsdc: ENGINE_SETTINGS_BOUNDS.capUsdc.min })).toEqual([])
    expect(validateAccountCapOverride({ accountKey: key, capUsdc: ENGINE_SETTINGS_BOUNDS.capUsdc.max })).toEqual([])
    for (const bad of [0, -1, 1_000_001, 1.5, '2000', Number.NaN, undefined]) expect(validateAccountCapOverride({ accountKey: key, capUsdc: bad })).not.toEqual([])
    for (const bad of ['', 'a b', 'x'.repeat(129), 7, null, "k'; DROP"]) expect(validateAccountCapOverride({ accountKey: bad, capUsdc: 2000 })).not.toEqual([])
  })

  test('the payload map: lowercase keys to in-bounds numbers, nothing else', () => {
    expect(validateAccountCaps({})).toEqual([])
    expect(validateAccountCaps({ [key]: 2000, other: 5000 })).toEqual([])
    for (const bad of [null, [], 'x', { [key]: null }, { [key]: 0 }, { [key.toUpperCase()]: 2000 }, { 'a b': 5 }]) expect(validateAccountCaps(bad)).not.toEqual([])
  })
})

// otto/mamoru#195: the gas multiple of the smallest entry.
describe('minEntry.gasMultiple', () => {
  const on = { ...DEFAULT_ENGINE_SETTINGS, minEntry: { gasMultiple: 5 } }

  test('is validated: a whole number from 1 to 50, nothing else in the object', () => {
    expect(validateEngineSettings(on)).toEqual([])
    expect(validateEngineSettings({ ...on, minEntry: { gasMultiple: 0 } })).toEqual(['minEntry.gasMultiple must be a whole number from 1 to 50'])
    expect(validateEngineSettings({ ...on, minEntry: { gasMultiple: 2.5 } })).toHaveLength(1)
    expect(validateEngineSettings({ ...on, minEntry: { gasMultiple: 5, extra: 1 } })).toEqual(['minEntry must be { gasMultiple }'])
    expect(validateEngineSettings({ ...on, minEntry: null })).toEqual(['minEntry must be { gasMultiple }'])
  })

  test('reaches the policy the engine decides with; the policy grants are built from is untouched', () => {
    const p = withEngineSettings(conservadorLiveV2, on)
    expect(p.minEntryGasMultiple).toBe(5)
    expect(conservadorLiveV2.minEntryGasMultiple).toBeUndefined()
    expect(p.session).toBe(conservadorLiveV2.session)
    expect(withEngineSettings({ ...conservadorLiveV2, minEntryGasMultiple: 3 }, DEFAULT_ENGINE_SETTINGS).minEntryGasMultiple).toBeUndefined()
  })

  test('absent keeps the stored hash of every older version', () => {
    expect(canonicalSettingsJson(DEFAULT_ENGINE_SETTINGS)).not.toContain('minEntry')
  })

  test('lowering it or turning it off asks for a confirm; raising it does not', () => {
    expect(riskyChanges(on, DEFAULT_ENGINE_SETTINGS)).toContain('smaller entries go through, where gas is a larger share of what they place')
    expect(riskyChanges(on, { ...on, minEntry: { gasMultiple: 2 } })).toHaveLength(1)
    expect(riskyChanges(DEFAULT_ENGINE_SETTINGS, on)).toEqual([])
  })
})
