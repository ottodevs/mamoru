// otto/mamoru#409: the regime shift moves money only through decide, and a policy without it runs as before.
import { describe, expect, test } from 'bun:test'
import { POLICIES, type PolicyVersion } from '@mamoru/policy'
import { syntheticDataset } from './fixtures.ts'
import { runBacktest } from './run.ts'
import { policyOf, type Variant } from './sweep.ts'

const V7LIKE = [{ id: 'stables', preference: 6500, pools: ['pool:USDC/USDT/100'] }, { id: 'risk', preference: 3500, pools: ['pool:WETH/USDC/3000'] }]
const LAZY = { mode: 'lazy', edgeBufferTicks: 100, minDwellSeconds: 1800, horizonSeconds: 86_400, lvrWeightBps: 10_000, edgeBufferBps: 2500, maxWaitSeconds: 21_600, costTest: 'off', maxPerWeek: 2 } as const
const GUARD = { enabled: true, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10_000 } } as const

/** A day flat, WETH down about 26% over two days, back up over two, a day flat; the other pools flat. */
const crashAndRecovery = syntheticDataset({
  samples: 6 * 288,
  tick: (k, i) => (k !== 2 ? 0 : i < 288 ? 0 : i < 864 ? -(i - 288) * 5 : i < 1440 ? -2880 + (i - 864) * 5 : 0),
  growth: [1n << 100n, 1n << 100n, 1n << 100n],
})

/** Every policy of POLICIES, the v7-like comparators of #406, and the Lab weight rules that share `weightTargets`. */
function goldenPolicies(): Record<string, PolicyVersion> {
  const v = (name: string, extra: Partial<Variant>): [string, PolicyVersion] => [name, policyOf({ name, policy: 'conservador-lab-geometry-v1', overrides: { buckets: V7LIKE }, ...extra })]
  return {
    ...POLICIES,
    ...Object.fromEntries([
      v('prod-baseline', { engine: { rerange: LAZY } as never }),
      v('w2000-mpw2-guardon', { engine: { rerange: LAZY, guard: GUARD } as never }),
      v('staged', { overrides: { buckets: V7LIKE, stagedExit: { step1Bps: 500, step2Bps: 1000, step3Bps: 1500, reentry: 'ema', ladderGapBps: 300 } } }),
      v('cppi', { overrides: { buckets: V7LIKE, cppi: { floorBps: 9500, multiplier: 3 } } }),
      v('voltarget', { overrides: { buckets: V7LIKE, volTarget: { targetVolBps: 5000, bandBps: 2000, stepBps: 2500 } } }),
    ]),
  }
}

function goldenHashes(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, policy] of Object.entries(goldenPolicies())) {
    if (!policy.buckets.some((b) => b.pools.length > 0)) continue
    try {
      out[name] = runBacktest(crashAndRecovery, policy, { deposit: 1_000_000_000n, reviewEvery: 1, sessions: 'enforce', sessionRenewal: 'renewed' }).resultHash
    } catch (e) {
      out[name] = `throws: ${(e as Error).message.slice(0, 60)}`
    }
  }
  return out
}

/** Captured on feat/406-rerange-sweep (a4928035), before `regimeShift` existed. */
const BEFORE: Record<string, string> = {
  'conservador-v1': '0x3659ad188772706111eb2ca410b748b9a961e4a6a3b21ac99763eb237934af95',
  'conservador-lab-v1': '0xd6b2929fcc2699f125970b2674de428ff50a3255ee73fc35825ca1782eaebe2a',
  'conservador-live-v1': '0x8956a5d9a1f8ed82918089c9ef3b94071b9d9018781d86023e215fa0704590bb',
  'conservador-live-v2': '0xb4dfc3eb357ee60f25ab09235d3cc1dccd5dc06cbf29d9151d4e2db9c7988d13',
  'lab-weth-usdc-v1': '0x3e04afc931df9375d6f55e44fcff6a3241d3a4fb571b36829b28c1662c7cdc2b',
  'conservador-lab-guards-v1': '0x9f1c3a2a982acd3f35b373eb99d0910a5c7ee6b6e9df48f6b12de5a5ebee6dd2',
  'conservador-lab-geometry-v1': '0xc1dac853c41060943632eae2f1751cf53ad65e207113e6c91e21b666b6c65016',
  'prod-baseline': '0xa182ce2754b916da4e52ff7521a3adb4fa5f1e38dfb33cf942c8d83dcb9620f1',
  'w2000-mpw2-guardon': '0x23c25fef40a00a98a92447186ec356f340045f2383f101d694fa48a75c156256',
  staged: '0xdad428a87cafe88aa09ed31344e6d677c39cd2cd9257e113a04ac6b2740c7f23',
  cppi: '0xa72d506fadb6138d95717e96fab43613c6802c678fc897e11d557cf18c3c8b49',
  voltarget: '0x6db39d94c3cf0c15f21ab29d63c6a101bbf3df5e88939a0cef0144ed85eb2301',
}

const SLOW = 180_000
const RULE = { fall7dBps: 1000, fall24hBps: 400, belowMeanBps: 0, defensivePreference: 0, exitOnMean: true, exitNoLowSeconds: 3 * 86_400, minDwellSeconds: 86_400 }
const run = (ds: typeof crashAndRecovery, policy: PolicyVersion) => runBacktest(ds, policy, { deposit: 1_000_000_000n, reviewEvery: 1, sessions: 'enforce', sessionRenewal: 'renewed' })
const shift = (rule: object) => policyOf({ name: 'shift', policy: 'conservador-lab-geometry-v1', overrides: { buckets: V7LIKE, regimeShift: rule }, engine: { rerange: LAZY } as never })

describe('regime shift (#409) in the backtest', () => {
  test('without regimeShift every run is the one of before, result hash for result hash', () => expect(goldenHashes()).toEqual(BEFORE), SLOW)

  test(
    'a fall shifts the risk bucket out through reduce and the recovery brings it back, once each',
    () => {
      const r = run(crashAndRecovery, shift(RULE))
      expect(r.regime?.shifts).toBe(1)
      const ok = r.ops.filter((o) => o.ok && o.kind !== 'harvest')
      const out = ok.find((o) => o.kind === 'reduce' && o.pool === 'pool:WETH/USDC/3000')!
      // Out during the fall (day 1 to 3), back in after the recovery started (day 3 to 5).
      expect((out.time - r.window.fromTime) / 86_400).toBeGreaterThan(1)
      expect((out.time - r.window.fromTime) / 86_400).toBeLessThan(3)
      const back = ok.find((o) => o.time > out.time && o.kind === 'reduce' && o.pool === 'pool:USDC/USDT/100')!
      expect((back.time - r.window.fromTime) / 86_400).toBeGreaterThan(3)
      expect(ok.some((o) => o.time > back.time && o.kind === 'enter_mint' && o.pool === 'pool:WETH/USDC/3000')).toBe(true)
      // A rule that never fires is the plain run but for the policy hash.
      const never = run(crashAndRecovery, shift({ ...RULE, fall7dBps: 9000 }))
      expect(never.regime?.shifts).toBe(0)
      expect(never.ops.map(({ trail: _t, ...o }) => o)).toEqual(run(crashAndRecovery, goldenPolicies()['prod-baseline']!).ops.map(({ trail: _t, ...o }) => o))
    },
    SLOW,
  )

  test(
    'a market that swings through the thresholds every 12 hours shifts at most once per minimum time in state',
    () => {
      const swing = syntheticDataset({ samples: 6 * 288, tick: (k, i) => (k === 2 ? Math.round(1500 * Math.sin((2 * Math.PI * i) / 144)) - Math.min(i, 864) : 0), growth: [1n << 100n, 1n << 100n, 1n << 100n] })
      const r = run(swing, shift({ ...RULE, fall7dBps: 500, fall24hBps: 200, minDwellSeconds: 2 * 86_400 }))
      expect(r.regime!.shifts).toBeGreaterThan(0)
      expect(r.regime!.shifts).toBeLessThanOrEqual(2)
    },
    SLOW,
  )

  test('the sweep takes the rule whole and refuses a part of it', () => {
    expect(shift(RULE).regimeShift).toEqual(RULE)
    expect(() => shift({ fall7dBps: 1000 })).toThrow('give')
  })
})
