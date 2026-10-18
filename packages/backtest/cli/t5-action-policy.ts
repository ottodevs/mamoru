// Spec 007 (otto/mamoru#151), task T5: bands and budgets per pool against the Lab's 2024-2026 windows, and how
// often the engine's exit-type ops (rerange, reduce) would wait on the band.
//   bun packages/backtest/cli/t5-action-policy.ts
//   bun packages/backtest/cli/t5-action-policy.ts --out specs/007-onchain-action-policy/results/raw
// Replays every window of `LAB_WINDOWS` (src/windows.ts) at deposit 1,000 and 100,000 USDC through the production
// `decide` (conservador-live-v2: the deployed grants, no engine change — MamoruActionPolicy is not wired into
// `decide` or session enforcement anywhere yet, spec 007 Tasks T3/T4). Three independent measurements, all against
// the same dataset and ops:
//   (1) band refusals: a pure market-data scan (`scanBand`/`bandGrid`), per pool, over a grid of bands x factors.
//   (2) exit waits: of the engine's real rerange/reduce ops (this run's `ops`), how many land while the band would
//       have refused them (spot more than band x factor from the 30-min TWAP), and for how long until it clears.
//   (3) budgets: W_p/T_p (spec 007 "Parameters": 1xCp per day, 3xCp per approval), resolved the same way the v4
//       grants resolve them (`v4CapFormulas`, `computeCaps`), against the real token spend of the run's swaps and
//       mints (`OpEntry.spend`, T5's own addition to `run.ts`).
// aug2024 has no USDC/cbBTC data at all (windows.ts: "no cbBTC on Base yet") — band scan still runs for the other
// two pools; the engine run (which needs all three bucket pools to decide for a 3-bucket account) is skipped for
// that window, reported as a gap, not invented.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { conservadorLiveV2, conservadorLiveV4, V4_POOLS, type V4PoolSpec } from '@mamoru/policy'
import type { RegistryName } from '@mamoru/registry'
import { bandGrid, capsAt, exitWaits, pricer, scanBudget, spendOf, waitStats, type BandGridRow, type BudgetScan, type ExitWait } from '../src/index.ts'
import { decodeDataset, makeDataset, type DatasetJson } from '../src/dataset.ts'
import { runBacktest } from '../src/run.ts'
import type { Dataset } from '../src/types.ts'
import { datasetsDir, LAB_WINDOWS, windowBlocks, type LabWindow } from '../src/windows.ts'

const WINDOW_SECONDS = 1_800 // conservador-live-v2's execution.twapWindowSeconds = spec 007 twapWindow
const BUDGET_WINDOW_SECONDS = 86_400 // spec 007 budgetWindow
const BANDS = [5, 10, 20, 50, 100, 200]
const FACTORS = [0.7, 0.8, 0.9, 1.0] // 1.0: the deployed, un-narrowed band (the on-chain refusal threshold itself)
const DEPOSITS = [1_000, 100_000]

const POOLS: { prefix: 'stables' | 'btc' | 'risk'; pool: RegistryName; spec: V4PoolSpec }[] = [
  { prefix: 'stables', pool: 'pool:USDC/USDT/100', spec: V4_POOLS.stables },
  { prefix: 'btc', pool: 'pool:USDC/cbBTC/500', spec: V4_POOLS.btc },
  { prefix: 'risk', pool: 'pool:WETH/USDC/3000', spec: V4_POOLS.risk },
]

function argv(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

/** The window's own dataset slice, exactly as `cli/sweep.ts`'s job runner cuts it. */
function windowDataset(w: LabWindow): Dataset {
  const ds = decodeDataset(JSON.parse(readFileSync(join(datasetsDir(), w.file), 'utf8')) as DatasetJson)
  const { fromBlock, toBlock } = windowBlocks(w)
  const from = ds.samples.findIndex((s) => s.block >= fromBlock)
  const to = ds.samples.findLastIndex((s) => s.block <= toBlock)
  if (from < 0 || to < from) throw new Error(`${w.file} has no sample in blocks ${fromBlock}..${toBlock}`)
  return from === 0 && to === ds.samples.length - 1 ? ds : makeDataset(ds.chainId, ds.pools, ds.samples.slice(from, to + 1))
}

type BandRow = { window: string; split: string; pool: string } & BandGridRow
type ExitRow = { window: string; split: string; deposit: number; pool: string; band: number; factor: number } & ExitWait

/**
 * Exit-wait bands to test per pool, beyond the spec-proposed one (always included at factor 0.8 and 1.0): the
 * stables pool's exits turned out to be the sensitive case (see the report), so a few wider stables bands are
 * probed at factor 1.0 (the deployed, un-narrowed threshold) to ground the recommendation in a measured number
 * rather than a guess.
 */
const EXIT_WAIT_EXTRA_BANDS: Partial<Record<'stables' | 'btc' | 'risk', number[]>> = { stables: [20, 30, 40] }
type BudgetRow = { window: string; split: string; deposit: number; pool: string } & BudgetScan
type SkipRow = { window: string; split: string; reason: string }

const bandRows: BandRow[] = []
const exitRows: ExitRow[] = []
const budgetRows: BudgetRow[] = []
const engineSkips: SkipRow[] = []

for (const w of LAB_WINDOWS) {
  const ds = windowDataset(w)

  // (1) Band refusals: a pure dataset scan, independent of the engine or any run.
  for (const { pool } of POOLS) {
    const poolIndex = ds.pools.indexOf(pool)
    const hasData = poolIndex >= 0 && ds.samples.some((s) => s.pools[poolIndex])
    if (!hasData) {
      engineSkips.push({ window: w.id, split: w.split, reason: `no ${pool} data (bands)` })
      continue
    }
    for (const row of bandGrid(ds, poolIndex, WINDOW_SECONDS, BANDS, FACTORS)) bandRows.push({ window: w.id, split: w.split, pool, ...row })
  }

  // (2) + (3): need the engine's real ops, which need all three bucket pools read somewhere in the window.
  const needAll = POOLS.every(({ pool }) => {
    const k = ds.pools.indexOf(pool)
    return k >= 0 && ds.samples.some((s) => s.pools[k])
  })
  if (!needAll) {
    engineSkips.push({ window: w.id, split: w.split, reason: 'missing a bucket pool: cannot run the 3-bucket engine' })
    continue
  }

  for (const deposit of DEPOSITS) {
    const unit = 1_000_000n // USDC, 6 decimals
    const depositRaw = BigInt(deposit) * unit
    let r: ReturnType<typeof runBacktest>
    try {
      r = runBacktest(ds, conservadorLiveV2, { deposit: depositRaw, reviewEvery: 1, sessions: 'enforce', sessionRenewal: 'renewed' })
    } catch (err) {
      engineSkips.push({ window: w.id, split: w.split, reason: `engine run failed at deposit ${deposit}: ${(err as Error).message}` })
      continue
    }

    // (2) Exit waits, at each pool's spec-proposed band, factor 0.8 (the engine's own narrowing, DEFAULT_BAND_FACTOR_BPS)
    // and factor 1.0 (the deployed band itself, no narrowing).
    for (const { prefix, pool, spec } of POOLS) {
      const poolIndex = ds.pools.indexOf(pool)
      const ops = r.ops.filter((o) => o.pool === pool && o.ok && (o.kind === 'rerange' || o.kind === 'reduce')).map((o) => ({ i: o.i, kind: o.kind as 'rerange' | 'reduce' }))
      if (ops.length === 0) continue
      const bandsToTest: { band: number; factor: number }[] = [
        { band: spec.bandTicks, factor: 0.8 },
        { band: spec.bandTicks, factor: 1.0 },
        ...(EXIT_WAIT_EXTRA_BANDS[prefix] ?? []).map((band) => ({ band, factor: 1.0 })),
      ]
      for (const { band, factor } of bandsToTest) {
        const threshold = Math.floor(band * factor)
        for (const w2 of exitWaits(ds, poolIndex, WINDOW_SECONDS, threshold, ops)) exitRows.push({ window: w.id, split: w.split, deposit, pool: prefix, band, factor, ...w2 })
      }
    }

    // (3) Budgets: W_p = windowMultiple x Cp/day, T_p = totalMultiple x Cp/approval, resolved at this run's
    // activation prices. T6 M-2 unified MamoruActionPolicy's budget to one value per pool, in the pool's stable
    // token (both tokens summed at the policy's range edge) — no more separate per-token caps. The per-token spend
    // scan below stays (it is the Lab's own diagnostic, not a replay of the contract's check): each token's raw
    // spend is measured against the SAME single cap, a looser bound than the real one (which sums both tokens'
    // value), never a tighter one — so a breach reported here is real, a clean scan is not proof the combined
    // check would also pass.
    const price = pricer(ds, conservadorLiveV4)
    const first = ds.samples.find((s) => POOLS.every(({ pool }) => s.pools[ds.pools.indexOf(pool)]))
    if (!first) continue
    const caps = capsAt(conservadorLiveV4, first, price, depositRaw)
    const lastTime = r.window.toTime
    for (const { prefix, pool, spec } of POOLS) {
      const windowCap = caps[spec.caps.budgetWindow] ?? 0n
      const totalCap = caps[spec.caps.budgetTotal] ?? 0n
      for (const token of [spec.token0, spec.token1] as const) {
        const spend = spendOf(r.ops, pool)
        const scan = scanBudget(spend, token, r.window.fromTime, lastTime, BUDGET_WINDOW_SECONDS, windowCap, totalCap)
        budgetRows.push({ window: w.id, split: w.split, deposit, pool: prefix, ...scan })
      }
    }
  }
  console.error(`${w.id} done`)
}

const outDir = argv('out', join(import.meta.dir, '..', '..', '..', 'specs', '007-onchain-action-policy', 'results', 'raw'))
mkdirSync(outDir, { recursive: true })
// Episodes are summarized (count, longest, total) for the committed file: the full per-episode start/end/peak list
// of the widest grid cells (the btc/risk pools at a narrow band breach most of the time) runs into the thousands
// and is not needed to reproduce the report's tables; rerun the command below for the full per-episode detail.
const bandRowsSlim = bandRows.map(({ episodes, ...rest }) => ({ ...rest, episodeCount: episodes.length }))
const json = JSON.stringify({ format: 'mamoru-lab-t5-action-policy-v1', windowSeconds: WINDOW_SECONDS, budgetWindowSeconds: BUDGET_WINDOW_SECONDS, bands: BANDS, factors: FACTORS, deposits: DEPOSITS, bandRows: bandRowsSlim, exitRows, budgetRows, engineSkips }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1)
writeFileSync(join(outDir, 't5-raw.json'), `${json}\n`)
console.error(`wrote ${join(outDir, 't5-raw.json')}: ${bandRows.length} band rows, ${exitRows.length} exit rows, ${budgetRows.length} budget rows, ${engineSkips.length} skips`)

// ---------------------------------------------------------------- summary tables (printed + written as .md)

function f2(x: number): string {
  return x.toFixed(2)
}

const lines: string[] = []
lines.push('## Band refusals: aggregate across all windows', '')
for (const { prefix, pool } of POOLS) {
  const rows = bandRows.filter((r) => r.pool === pool)
  if (rows.length === 0) continue
  lines.push(`### ${pool} (${prefix})`, '', '| Band | Factor | Threshold | Samples | Breach samples | Breach % | Episodes | Max episode | Total breach time |', '|---|---|---|---|---|---|---|---|---|')
  const groups = new Map<string, BandRow[]>()
  for (const r of rows) {
    const k = `${r.band}|${r.factor}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  for (const band of BANDS) for (const factor of FACTORS) {
    const g = groups.get(`${band}|${factor}`) ?? []
    if (g.length === 0) continue
    const samples = g.reduce((a, r) => a + r.samples, 0)
    const breachSamples = g.reduce((a, r) => a + r.breachSamples, 0)
    const episodes = g.reduce((a, r) => a + r.episodes.length, 0)
    const maxEp = Math.max(...g.map((r) => r.maxEpisodeSeconds))
    const totalEp = g.reduce((a, r) => a + r.totalBreachSeconds, 0)
    lines.push(`| ${band} | ${factor} | ${Math.floor(band * factor)} | ${samples} | ${breachSamples} | ${f2((breachSamples / samples) * 100)} | ${episodes} | ${(maxEp / 60).toFixed(0)} min | ${(totalEp / 3600).toFixed(1)} h |`)
  }
  lines.push('')
}

// token0's price move over the wait, signed (see tickMoveBps): token0 is USDC for stables/btc, WETH for risk (spec
// 007 V4_POOLS). Which sign is "adverse" for an exit therefore differs by pool; the report's narrative says which.
lines.push("## Exit waits (rerange/reduce)", '')
lines.push('| Pool | Band | Factor | Deposit | Exits | Breached | Censored | Median wait | p95 wait | Max wait | token0 move, min | median | max |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|')
const exitBandFactor = new Set(exitRows.map((r) => `${r.pool}|${r.band}|${r.factor}`))
for (const key of exitBandFactor) {
  const [prefix, bandStr, factorStr] = key.split('|') as [string, string, string]
  const band = Number(bandStr)
  const factor = Number(factorStr)
  for (const deposit of DEPOSITS) {
    const atFactor = exitRows.filter((r) => r.pool === prefix && r.band === band && r.factor === factor && r.deposit === deposit)
    if (atFactor.length === 0) continue
    const stats = waitStats(atFactor)
    const costs = atFactor.filter((r) => r.breached).map((r) => r.priceMoveBps).sort((a, b) => a - b)
    const min = costs.length === 0 ? 0 : costs[0]!
    const max = costs.length === 0 ? 0 : costs.at(-1)!
    const median = costs.length === 0 ? 0 : costs.length % 2 === 1 ? costs[(costs.length - 1) / 2]! : (costs[costs.length / 2 - 1]! + costs[costs.length / 2]!) / 2
    lines.push(`| ${prefix} | ${band} | ${factor} | ${deposit} | ${stats.of} | ${stats.breached} | ${stats.censored} | ${(stats.medianSeconds / 60).toFixed(0)} min | ${(stats.p95Seconds / 60).toFixed(0)} min | ${(stats.maxSeconds / 3600).toFixed(1)} h | ${f2(min)} bp | ${f2(median)} bp | ${f2(max)} bp |`)
  }
}

// Each `BudgetRow` is one window's own run, treated as one approval activated at that window's start (the Lab's
// windows are disjoint periods, not one continuous timeline — see the report's protocol note). So a day-window
// count sums across runs (every day of every window is an independent W_p period), but T_p is per *run*: report the
// worst run's % of T_p and how many of the runs breached their own total, never a sum of disjoint totals.
lines.push('', '## Budgets: W_p (1xCp/day) and T_p (3xCp/approval) against real turnover', '')
lines.push('| Pool | Token | Deposit | W_p (raw units) | peak day spend | peak % of W_p | days over W_p (of N) | T_p (raw units) | worst run % of T_p | runs over T_p (of N) |', '|---|---|---|---|---|---|---|---|---|---|')
for (const { prefix } of POOLS) {
  for (const deposit of DEPOSITS) {
    const rows = budgetRows.filter((r) => r.pool === prefix && r.deposit === deposit)
    const byToken = new Map<string, BudgetRow[]>()
    for (const r of rows) byToken.set(r.token, [...(byToken.get(r.token) ?? []), r])
    for (const [token, g] of byToken) {
      const windowCap = g[0]!.windowCap
      const totalCap = g[0]!.totalCap
      const peakWindowSpend = g.reduce((a, r) => (r.peakWindowSpend > a ? r.peakWindowSpend : a), 0n)
      const peakPct = windowCap === 0n ? 0 : Number((peakWindowSpend * 10_000n) / windowCap) / 100
      const windowsScanned = g.reduce((a, r) => a + r.windowsScanned, 0)
      const windowBreaches = g.reduce((a, r) => a + r.windowBreaches, 0)
      const worstTotalPct = Math.max(0, ...g.map((r) => r.totalSpendPct))
      const runsOverTotal = g.filter((r) => r.totalBreached).length
      lines.push(`| ${prefix} | ${token} | ${deposit} | ${windowCap} | ${peakWindowSpend} | ${f2(peakPct)}% | ${windowBreaches} of ${windowsScanned} | ${totalCap} | ${f2(worstTotalPct)}% | ${runsOverTotal} of ${g.length} |`)
    }
  }
}

lines.push('', '## Data gaps', '')
if (engineSkips.length === 0) lines.push('none')
else {
  lines.push('| Window | Split | Reason |', '|---|---|---|')
  for (const s of engineSkips) lines.push(`| ${s.window} | ${s.split} | ${s.reason} |`)
}

writeFileSync(join(outDir, 't5-tables.md'), `${lines.join('\n')}\n`)
console.log(lines.join('\n'))
