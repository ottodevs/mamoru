import { describe, expect, test } from 'bun:test'
import { canonicalSettingsJson, conservadorLiveV6, DEFAULT_ENGINE_SETTINGS, entryPauseFor, liveWmonUsdcMonadV6, riskyChanges, sleeveEnginePolicy, validateEngineSettings, withEngineSettings, type EngineSettings } from './index.ts'

// otto/mamoru#415: the engine settings' pause of new money into a chain's volatile buckets.

const UNTIL = 1_795_600_000
const s = (entryPause: unknown): EngineSettings => ({ ...DEFAULT_ENGINE_SETTINGS, entryPause } as EngineSettings)

describe('entryPause settings (otto/mamoru#415)', () => {
  test('valid: one end per chain, in unix seconds', () => {
    expect(validateEngineSettings(s([{ chainId: 143, until: UNTIL }]))).toEqual([])
    expect(validateEngineSettings(s([{ chainId: 143, until: UNTIL }, { chainId: 8453, until: UNTIL }]))).toEqual([])
  })

  test('refused: an end in milliseconds, a chain twice, extra keys, an empty or long list, not a list', () => {
    expect(validateEngineSettings(s([{ chainId: 143, until: UNTIL * 1000 }])).join()).toContain('entryPause[0].until')
    expect(validateEngineSettings(s([{ chainId: 143, until: UNTIL }, { chainId: 143, until: UNTIL + 1 }])).join()).toContain('chain 143 twice')
    expect(validateEngineSettings(s([{ chainId: 143, until: UNTIL, bucket: 'risk' }])).join()).toContain('entryPause[0] must be')
    expect(validateEngineSettings(s([])).join()).toContain('entryPause must be a list')
    expect(validateEngineSettings(s([1, 2, 3, 4, 5].map((chainId) => ({ chainId, until: UNTIL })))).join()).toContain('entryPause must be a list')
    expect(validateEngineSettings(s({ chainId: 143, until: UNTIL })).join()).toContain('entryPause must be a list')
    expect(validateEngineSettings(s([{ chainId: 0, until: UNTIL }])).join()).toContain('chainId')
  })

  test('absent keeps every older version byte for byte (same canonical JSON, no policy field)', () => {
    expect(canonicalSettingsJson(DEFAULT_ENGINE_SETTINGS)).not.toContain('entryPause')
    expect(withEngineSettings(conservadorLiveV6, DEFAULT_ENGINE_SETTINGS).entryPauseUntil).toBeUndefined()
  })

  test('Monad paused: v6 on Base pauses its remote Growth bucket only; the Monad sleeve pauses its WMON/USDC bucket', () => {
    const st = s([{ chainId: 143, until: UNTIL }])
    expect(entryPauseFor(conservadorLiveV6, st)).toEqual({ growth: UNTIL })
    expect(entryPauseFor(sleeveEnginePolicy(liveWmonUsdcMonadV6), st)).toEqual({ risk: UNTIL })
    const p = withEngineSettings(conservadorLiveV6, st)
    expect(p.entryPauseUntil).toEqual({ growth: UNTIL })
    // The policy the grants and policyHash are built from is untouched; buckets stay the same reference (Engine.retune).
    expect(conservadorLiveV6.entryPauseUntil).toBeUndefined()
    expect(p.buckets).toBe(conservadorLiveV6.buckets)
  })

  test('Base paused: only Base volatile buckets that take money; never stables, vaults or a bucket at preference 0', () => {
    const paused = entryPauseFor(conservadorLiveV6, s([{ chainId: 8453, until: UNTIL }]))
    expect(paused).toEqual({ risk: UNTIL })
  })

  test('removing a pause or ending it sooner needs a confirm on /ops; adding or extending one does not', () => {
    const on = s([{ chainId: 143, until: UNTIL }])
    expect(riskyChanges(on, DEFAULT_ENGINE_SETTINGS)).toContain('new money goes into the volatile pools on chain 143 sooner')
    expect(riskyChanges(on, s([{ chainId: 143, until: UNTIL - 3600 }]))).toContain('new money goes into the volatile pools on chain 143 sooner')
    expect(riskyChanges(DEFAULT_ENGINE_SETTINGS, on)).toEqual([])
    expect(riskyChanges(on, s([{ chainId: 143, until: UNTIL + 3600 }]))).toEqual([])
  })
})
