// otto/mamoru#415 lab: a fast fall of the volatile side against a Monad-shaped growth sleeve (one bucket, 3000-tick range,
// live Monad engine settings v12). Offline: the backtest replays production `decide` on synthetic WETH/USDC/3000 paths,
// a structural twin of WMON/USDC/3000 (token0 volatile 18 dec, USDC token1, fee 3000, spacing 60).
import { conservadorLiveV2, parseEngineSettings, withEngineSettings, type EngineSettings, type PolicyVersion } from '@mamoru/policy'
import { amountsForLiquidity } from '@mamoru/decide'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { runBacktest } from '../src/run.ts'
import { syntheticDataset } from '../src/fixtures.ts'

const STEP = 300
const WARM = (2 * 86_400) / STEP
const AFTER = (3 * 86_400) / STEP
const LN = Math.log(1.0001)
const USDC = 1_000_000n
const V12 = parseEngineSettings({ capUsdc: 10000, depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 }, guard: { btc: { fallBps: 700, volBps: 8000 }, enabled: false, eth: { fallBps: 900, volBps: 10000 } }, rerange: { costTest: 'off', edgeBufferBps: 2500, edgeBufferTicks: 100, horizonSeconds: 86400, lvrWeightBps: 10000, maxPerWeek: 2, maxWaitSeconds: 21600, minDwellSeconds: 1800, mode: 'lazy' } })

function policy(width: number, guard: boolean): PolicyVersion {
  const p: PolicyVersion = { ...conservadorLiveV2, policyId: `lab-unlock-w${width}`, buckets: [{ id: 'risk', preference: 10_000, pools: ['pool:WETH/USDC/3000'] }], range: { ...conservadorLiveV2.range, widthTicks: width, cooldownSeconds: 86_400 } }
  const s: EngineSettings = { ...V12, guard: { ...V12.guard, enabled: guard } }
  return withEngineSettings(p, s)
}

function path(fall: number, hours: number) {
  const n = (hours * 3600) / STEP
  const drop = Math.log(1 - fall) / LN
  return (k: number, i: number) => (k !== 2 || i <= WARM ? 0 : Math.round(drop * Math.min(1, (i - WARM) / n)))
}

type Row = Record<string, string | number>
const rows: Row[] = []
for (const fall of [0.2, 0.4, 0.6]) for (const hours of [1, 12]) {
  const tick = path(fall, hours)
  const samples = WARM + (hours * 3600) / STEP + AFTER
  const ds = syntheticDataset({ samples, step: STEP, tick })
  const startTick = ds.samples[0]!.pools[2]!.tick
  for (const width of [3000, 6000, 12000]) for (const guard of [false, true]) {
    let exitAt: number | null = null
    let share = 0
    const r = runBacktest(ds, policy(width, guard), {
      deposit: 1_000n * USDC,
      sessions: 'report',
      onSample: (i, _t, ps) => {
        const t = startTick + tick(2, i)
        const pos = ps.filter((p) => p.pool === 'pool:WETH/USDC/3000' && p.liquidity > 0n)
        if (exitAt === null && i > WARM && pos.length && pos.every((p) => t < p.tickLower)) exitAt = i
        if (i === WARM + (hours * 3600) / STEP && pos.length) {
          const px = Math.exp(t * LN) * 1e12 // USDC per WETH in whole units (18 vs 6 decimals)
          let v0 = 0
          let v1 = 0
          for (const p of pos) {
            const a = amountsForLiquidity(sqrtRatioAtTick(t), p.tickLower, p.tickUpper, p.liquidity)
            v0 += (Number(a.amount0) / 1e18) * px
            v1 += Number(a.amount1) / 1e6
          }
          share = v0 / (v0 + v1)
        }
      },
    })
    const k = WARM
    const v = (i: number) => Number(r.series.value[i]!) / 1e6
    const h = (i: number) => Number(r.series.hodl[i]!) / 1e6
    const end = r.series.value.length - 1
    const after = r.ops.filter((o) => o.i > k)
    const reranges = after.filter((o) => o.kind === 'rerange' && o.ok).length
    const gas = after.reduce((s, o) => s + Number(o.gasCost), 0) / 1e6
    const fallReviews = Object.entries(r.reasons).filter(([c]) => c === 'DECIDE_ENTRY_PAUSED_FALL').reduce((s, [, n]) => s + n, 0)
    rows.push({
      fall: `-${fall * 100}%`, hours, width, guard: guard ? 'on' : 'off',
      atFall: v(k).toFixed(2), bottom: v(end).toFixed(2),
      lossPct: (((v(end) - v(k)) / v(k)) * 100).toFixed(1),
      hodl5050Pct: (((h(end) - h(k)) / h(k)) * 100).toFixed(1),
      volShareAtBottomPct: (share * 100).toFixed(0),
      exitMin: exitAt === null ? 'never' : ((exitAt - k) * STEP) / 60,
      reranges, gasUsdc: gas.toFixed(3), fallGuardReviews: fallReviews,
    })
  }
}
console.log(JSON.stringify(rows))
