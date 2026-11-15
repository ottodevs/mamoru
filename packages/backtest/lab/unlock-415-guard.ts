// otto/mamoru#415: first review where the fall guard pauses entries, against the range exit (3000 ticks, guard on).
import { conservadorLiveV2, parseEngineSettings, withEngineSettings, type PolicyVersion } from '@mamoru/policy'
import { runBacktest } from '../src/run.ts'
import { syntheticDataset } from '../src/fixtures.ts'
const STEP = 300, WARM = (2 * 86_400) / STEP, LN = Math.log(1.0001)
const s = parseEngineSettings({ capUsdc: 10000, depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 }, guard: { btc: { fallBps: 700, volBps: 8000 }, enabled: true, eth: { fallBps: 900, volBps: 10000 } }, rerange: { costTest: 'off', edgeBufferBps: 2500, edgeBufferTicks: 100, horizonSeconds: 86400, lvrWeightBps: 10000, maxPerWeek: 2, maxWaitSeconds: 21600, minDwellSeconds: 1800, mode: 'lazy' } })
const p: PolicyVersion = withEngineSettings({ ...conservadorLiveV2, policyId: 'lab-unlock-guard', buckets: [{ id: 'risk', preference: 10_000, pools: ['pool:WETH/USDC/3000'] }], range: { ...conservadorLiveV2.range, widthTicks: 3000, cooldownSeconds: 86_400 } }, s)
const out: string[] = []
for (const fall of [0.2, 0.4, 0.6]) for (const hours of [1, 12]) {
  const n = (hours * 3600) / STEP, drop = Math.log(1 - fall) / LN
  const ds = syntheticDataset({ samples: WARM + n + 864, step: STEP, tick: (k, i) => (k !== 2 || i <= WARM ? 0 : Math.round(drop * Math.min(1, (i - WARM) / n))) })
  let first: number | null = null
  for (let to = WARM + 1; to < WARM + n + 864; to += hours === 1 ? 1 : 6) {
    const r = runBacktest(ds, p, { deposit: 1_000_000_000n, sessions: 'report', to })
    if ((r.reasons.DECIDE_ENTRY_PAUSED_FALL ?? 0) > 0) { first = to; break }
  }
  // Range ±1500 ticks around the entry: the price leaves it after a fall of 1 - 1.0001^-1500.
  const exitFrac = Math.log(1.0001 ** -1500) / Math.log(1 - fall)
  out.push(`-${fall * 100}% over ${hours}h: guard first at ${first === null ? 'never' : `${((first - WARM) * STEP) / 60} min`}, range exit at ~${Math.round(exitFrac * hours * 60)} min`)
}
console.log(out.join('\n'))
