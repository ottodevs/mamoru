import { describe, expect, test } from 'bun:test'
import { canonicalSettingsJson, chainExitOf, conservadorLiveV6, conservadorLiveV7, DEFAULT_ENGINE_SETTINGS, liveWmonUsdcMonadV6, riskyChanges, sleeveEnginePolicy, validateEngineSettings, withEngineSettings, type EngineSettings } from './index.ts'

// otto/mamoru#427: the engine settings' exit from a chain's pools.

const s = (chainExit: unknown, over: Partial<EngineSettings> = {}): EngineSettings => ({ ...DEFAULT_ENGINE_SETTINGS, ...over, chainExit } as EngineSettings)
const SLEEVE = sleeveEnginePolicy(liveWmonUsdcMonadV6)

describe('chainExit settings (otto/mamoru#427)', () => {
  test('valid: one entry per chain Mamoru runs on, beside a pause', () => {
    expect(validateEngineSettings(s([{ chainId: 143 }]))).toEqual([])
    expect(validateEngineSettings(s([{ chainId: 143 }], { entryPause: [{ chainId: 143, until: 1_795_651_200 }] }))).toEqual([])
  })

  test('refused: a chain twice, a chain Mamoru does not run, extra keys, an empty list, not a list', () => {
    expect(validateEngineSettings(s([{ chainId: 143 }, { chainId: 143 }])).join()).toContain('chain 143 twice')
    expect(validateEngineSettings(s([{ chainId: 144 }])).join()).toContain('chainExit[0].chainId must be a chain Mamoru runs on')
    expect(validateEngineSettings(s([{ chainId: 143, bucket: 'risk' }])).join()).toContain('chainExit[0] must be')
    expect(validateEngineSettings(s([])).join()).toContain('chainExit must be a list')
    expect(validateEngineSettings(s({ chainId: 143 })).join()).toContain('chainExit must be a list')
  })

  test('absent keeps every older version byte for byte', () => {
    expect(canonicalSettingsJson(DEFAULT_ENGINE_SETTINGS)).not.toContain('chainExit')
    expect(withEngineSettings(SLEEVE, DEFAULT_ENGINE_SETTINGS).chainExit).toBeUndefined()
  })

  test('Monad exited: the sleeve leaves and takes no entry; v6/v7 on Base keep running and bridge nothing to Monad', () => {
    const st = s([{ chainId: 143 }])
    expect(chainExitOf(SLEEVE, st)).toBe(true)
    const sleeve = withEngineSettings(SLEEVE, st)
    expect(sleeve.chainExit).toBe(true)
    expect(sleeve.entryPauseUntil).toEqual({ risk: 4_102_444_800 })
    for (const p of [conservadorLiveV6, conservadorLiveV7]) {
      const b = withEngineSettings(p, st)
      expect(b.chainExit).toBeUndefined()
      expect(b.entryPauseUntil).toEqual({ growth: 4_102_444_800 })
    }
    // A shorter pause on the same chain cannot let money in while the exit stands.
    expect(withEngineSettings(SLEEVE, s([{ chainId: 143 }], { entryPause: [{ chainId: 143, until: 1_795_651_200 }] })).entryPauseUntil).toEqual({ risk: 4_102_444_800 })
    // The signed policy is untouched; buckets stay the same reference (Engine.retune).
    expect(liveWmonUsdcMonadV6.chainExit).toBeUndefined()
    expect(sleeve.buckets).toBe(SLEEVE.buckets)
    expect(sleeve.session).toBe(SLEEVE.session)
  })

  test('adding an exit and lifting one both need a confirm on /ops', () => {
    const on = s([{ chainId: 143 }])
    expect(riskyChanges(DEFAULT_ENGINE_SETTINGS, on)).toContain('every pool position on chain 143 is closed and its volatile token sold for USDC')
    expect(riskyChanges(on, DEFAULT_ENGINE_SETTINGS)).toContain('new money goes into the pools on chain 143 again')
    expect(riskyChanges(on, on)).toEqual([])
  })
})
