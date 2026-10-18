// otto/mamoru#151 T5 (spec 007), Lab only: MamoruActionPolicy bands and budgets against 2024-2026 data, replaying
// the production `decide` (conservador-live-v2).
//   bun packages/backtest/cli/t5-bands-budgets.ts [--out ~/.local/share/mamoru-lab/t5-bands-budgets.json]
// 1. Liveness at native resolution (Lab windows, 5/10-minute samples, exact 30-minute TWAP): for each executed op
//    and candidate band, refused at proposal or not, and how long until the band accepts it.
// 2. The same on the continuous hourly series (2024-10 .. 2026-10). Hourly samples cannot see the 30-minute TWAP:
//    the dataset keeps one tickCumulative per sample, so its TWAP is the trailing 60 minutes. Section 3 calibrates.
// 3. Calibration: |spot - TWAP30| against |spot - TWAP60| on the native windows, and against the hourly series on
//    the blocks both datasets share (Sep 2026).
// 4. Turnover per approval-year (activation on every month start that leaves a full 365 days of data): the
//    token0/token1 the engine spends on swaps (amountIn) and mints (amountDesired) per pool, as a multiple of C_p
//    (the pool's share of the account cap, in the token at the activation price), and its busiest day.
// Reads datasets only; no chain calls.
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { conservadorLiveV2 } from '@mamoru/policy'
import { entry, type RegistryName } from '@mamoru/registry'
import { approvalSpend, bandScan, sideOf, spendOf, spotTwapDeviation, waitFor, type Wait } from '../src/action-policy.ts'
import { decodeDataset, makeDataset, type DatasetJson } from '../src/dataset.ts'
import { pricer, runBacktest } from '../src/run.ts'
import type { Dataset, OpEntry, RunResult } from '../src/types.ts'
import { datasetsDir, LAB_WINDOWS, windowBlocks } from '../src/windows.ts'

const argv = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const OUT = argv('out', join(homedir(), '.local/share/mamoru-lab/t5-bands-budgets.json'))
const YEAR_FILES = argv('year', 'base-2024-10-2026-02-1h.json,base-2026-cdp-case-1h.json').split(',')
const DEPOSITS = argv('deposits', '1000,100000').split(',').map(Number)

const policy = conservadorLiveV2
const TWAP = policy.execution.twapWindowSeconds // 1,800 s
const MAX_TWAP_DEV = policy.execution.maxTwapDeviationTicks // #46: decide already waits past this
const DAY = 86_400
const YEAR = 365 * DAY
type PoolSpec = { pool: RegistryName; label: string; feeBps: number; share: number; bands: number[]; fastTicks: number }
const POOLS: PoolSpec[] = [
  { pool: 'pool:USDC/USDT/100', label: 'stables', feeBps: 1, share: 0.5, bands: [5, 10, 20], fastTicks: 5 },
  { pool: 'pool:USDC/cbBTC/500', label: 'btc', feeBps: 5, share: 0.4, bands: [50, 100, 150, 200], fastTicks: 100 },
  { pool: 'pool:WETH/USDC/3000', label: 'risk', feeBps: 30, share: 0.1, bands: [50, 100, 150, 200], fastTicks: 100 },
]
for (const b of policy.buckets) {
  const p = POOLS.find((x) => b.pools.includes(x.pool))
  if (!p || Math.abs(p.share - b.preference / 10_000) > 1e-9) throw new Error(`bucket ${b.id} does not match the T5 pool table`)
}
// 1 = the band itself (the on-chain refusal); 0.8 = the narrower band the engine computes its bounds at (spec 007 T3),
// the threshold an engine-side precheck would wait on.
const FACTORS = [1, 0.8]
const EXITS = new Set<OpEntry['kind']>(['rerange', 'reduce'])

const load = (file: string): Dataset => decodeDataset(JSON.parse(readFileSync(join(datasetsDir(), file), 'utf8')) as DatasetJson)
const slice = (ds: Dataset, from: number, to: number): Dataset => makeDataset(ds.chainId, ds.pools, ds.samples.filter((s) => s.block >= from && s.block <= to))
const usd = (deposit: number): bigint => BigInt(Math.round(deposit * 1e6))
const run = (ds: Dataset, deposit: number, sessions: 'enforce' | 'report'): RunResult => runBacktest(ds, policy, { deposit: usd(deposit), sessions })
const quant = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16)

/** Every executed op of `pool` in a run, its wait at `band`, and whether it came in a fast hour. */
function waits(ds: Dataset, r: RunResult, p: PoolSpec, band: number, windowSeconds: number) {
  const k = ds.pools.indexOf(p.pool)
  return r.ops.filter((o) => o.ok && o.pool === p.pool).map((o) => {
    const w = waitFor(ds, k, windowSeconds, band, sideOf(o), o)
    let j = o.i
    while (j > 0 && ds.samples[o.i]!.time - ds.samples[j]!.time < 3_600) j--
    const before = ds.samples[j]!.pools[k]
    const fast = before ? Math.abs(ds.samples[o.i]!.pools[k]!.tick - before.tick) >= p.fastTicks : false
    return { ...w, fast, exit: EXITS.has(o.kind) }
  })
}
type W = Wait & { fast: boolean; exit: boolean }
const summary = (ws: W[]) => {
  const ref = ws.filter((w) => w.refused)
  const secs = ref.map((w) => w.waitSeconds)
  return { ops: ws.length, refused: ref.length, median: quant(secs, 0.5), p95: quant(secs, 0.95), max: Math.max(0, ...secs), censored: ref.filter((w) => !w.cleared).length, worstMoveTicks: ref.reduce((a, w) => (Math.abs(w.moveTicks) > Math.abs(a) ? w.moveTicks : a), 0) }
}

const out: Record<string, unknown> = { policy: `${policy.policyId}@${policy.version}`, twapWindowSeconds: TWAP, maxTwapDeviationTicks: MAX_TWAP_DEV }

// ---- 1. Lab windows, native resolution -------------------------------------------------------------------------
const labRows: Record<string, unknown>[] = []
const calib: Record<string, { d30: number[]; d60: number[] }> = Object.fromEntries(POOLS.map((p) => [p.label, { d30: [], d60: [] }]))
const nativeWaits: Record<string, W[]> = {}
const bandMarket: Record<string, { samples: number; refused: number; longest: number; episodes: number }> = {}
let sep5m: Dataset | null = null
for (const lw of LAB_WINDOWS) {
  const { fromBlock, toBlock } = windowBlocks(lw)
  const ds = slice(load(lw.file), fromBlock, toBlock)
  if (lw.id === 'sep2026') sep5m = ds
  const missing = POOLS.filter((p) => ds.samples.every((s) => !s.pools[ds.pools.indexOf(p.pool)])).map((p) => p.label)
  for (const p of POOLS) {
    const k = ds.pools.indexOf(p.pool)
    if (missing.includes(p.label)) continue
    for (let i = 0; i < ds.samples.length; i++) {
      const a = spotTwapDeviation(ds, k, i, TWAP)
      const b = spotTwapDeviation(ds, k, i, 2 * TWAP)
      if (a !== null && b !== null) {
        calib[p.label]!.d30.push(Math.abs(a))
        calib[p.label]!.d60.push(Math.abs(b))
      }
    }
    for (const band of p.bands) for (const f of FACTORS) {
      const m = bandScan(ds, k, TWAP, Math.floor(band * f))
      const key = `${p.label}|${band}|${f}`
      const acc = (bandMarket[key] ??= { samples: 0, refused: 0, longest: 0, episodes: 0 })
      acc.samples += m.samples
      acc.refused += m.refused
      acc.episodes += m.episodes
      acc.longest = Math.max(acc.longest, m.longestSeconds)
    }
  }
  if (missing.length) {
    labRows.push({ window: lw.id, skipped: `no data for ${missing.join(', ')}: engine not run` })
    continue
  }
  for (const deposit of DEPOSITS) {
    const r = run(ds, deposit, 'enforce')
    // Busiest day at native review cadence, as a multiple of C_p (in the token, at the window's first price).
    const lp = pricer(ds, policy)
    const maxDay: Record<string, number> = {}
    for (const p of POOLS) for (const token of [entry(p.pool).token0!, entry(p.pool).token1!]) {
      const unit = 10n ** BigInt(entry(token).decimals ?? 18)
      const cTok = (usd(deposit * p.share) * unit) / lp(ds.samples[0]!, token, unit)
      const span = ds.samples.at(-1)!.time - ds.samples[0]!.time + 1
      const { perWindow } = approvalSpend(spendOf(r.ops, p.pool), token, ds.samples[0]!.time, span, DAY)
      maxDay[`${p.label}|${token}`] = Math.max(...perWindow.map((x) => Number((x * 10_000n) / cTok) / 10_000))
    }
    labRows.push({ window: lw.id, deposit, samples: ds.samples.length, ops: r.ops.filter((o) => o.ok).length, maxDay })
    for (const p of POOLS) for (const band of p.bands) for (const f of FACTORS) (nativeWaits[`${p.label}|${band}|${f}`] ??= []).push(...waits(ds, r, p, Math.floor(band * f), TWAP))
  }
  console.error(`lab ${lw.id} done`)
}
out.lab = { windows: labRows, market: bandMarket, waits: Object.fromEntries(Object.entries(nativeWaits).map(([k, ws]) => [k, { all: summary(ws), exits: summary(ws.filter((w) => w.exit)), fastExits: summary(ws.filter((w) => w.exit && w.fast)), detail: ws.filter((w) => w.refused) }])) }

// ---- 2./3. Hourly year series and calibration -------------------------------------------------------------------
const parts = YEAR_FILES.map(load)
for (const d of parts) if (d.pools.join() !== parts[0]!.pools.join()) throw new Error('year datasets list different pools')
const year = makeDataset(parts[0]!.chainId, parts[0]!.pools, parts.flatMap((d) => d.samples))
const span = { from: iso(year.samples[0]!.time), to: iso(year.samples.at(-1)!.time), samples: year.samples.length, id: year.id }
const holes: { at: string; hours: number }[] = []
for (let i = 1; i < year.samples.length; i++) {
  const dt = year.samples[i]!.time - year.samples[i - 1]!.time
  if (dt > 3_700) holes.push({ at: iso(year.samples[i - 1]!.time), hours: dt / 3_600 })
}
const nullsByPool = Object.fromEntries(POOLS.map((p) => [p.label, year.samples.filter((s) => !s.pools[year.pools.indexOf(p.pool)]).length]))
out.year = { ...span, holes, nullsByPool }
console.error(`year ${span.from} .. ${span.to}, ${span.samples} samples, ${holes.length} holes`)

const calibration: Record<string, unknown> = {}
for (const p of POOLS) {
  const c = calib[p.label]!
  const qs = [0.5, 0.9, 0.99, 0.999]
  const row: Record<string, unknown> = { samples: c.d30.length, ...Object.fromEntries(qs.map((q) => [`q${q}`, { twap30: quant(c.d30, q), twap60: quant(c.d60, q) }])) }
  // The hourly series against the 5-minute one, same blocks: what an hourly reading of TWAP60 says vs the real TWAP30.
  if (sep5m) {
    const k = year.pools.indexOf(p.pool)
    const byBlock = new Map(sep5m.samples.map((s, i) => [s.block, i]))
    const pairs: [number, number][] = []
    for (let i = 0; i < year.samples.length; i++) {
      const j = byBlock.get(year.samples[i]!.block)
      if (j === undefined) continue
      const h = spotTwapDeviation(year, k, i, TWAP)
      const f = spotTwapDeviation(sep5m, k, j, TWAP)
      if (h !== null && f !== null) pairs.push([Math.abs(h), Math.abs(f)])
    }
    row.sep2026 = {
      sharedBlocks: pairs.length,
      byBand: Object.fromEntries(p.bands.map((b) => [b, { hourlyTwap60: pairs.filter(([h]) => h > b).length, native30: pairs.filter(([, f]) => f > b).length }])),
      ...Object.fromEntries(qs.map((q) => [`q${q}`, { hourlyTwap60: quant(pairs.map((x) => x[0]), q), native30: quant(pairs.map((x) => x[1]), q) }])),
    }
  }
  calibration[p.label] = row
}
out.calibration = calibration

// Review cadence: the hourly series reviews once an hour, the live operator far more often. Sep 2026 is in both, so
// the same month's turnover at 5-minute and at hourly reviews says how much the hourly figures miss.
const price = pricer(year, policy)
const totalMultiple = (ds: Dataset, r: RunResult, p: PoolSpec, token: RegistryName, deposit: number): number => {
  const unit = 10n ** BigInt(entry(token).decimals ?? 18)
  const cTok = (usd(deposit * p.share) * unit) / pricer(ds, policy)(ds.samples[0]!, token, unit)
  const total = spendOf(r.ops, p.pool).filter((s) => s.token === token).reduce((a, s) => a + s.amount, 0n)
  return Number((total * 10_000n) / cTok) / 10_000
}
if (sep5m) {
  const hourly = slice(year, sep5m.samples[0]!.block, sep5m.samples.at(-1)!.block)
  const cadence: Record<string, unknown>[] = []
  for (const deposit of DEPOSITS) {
    const a = run(sep5m, deposit, 'enforce')
    const b = run(hourly, deposit, 'enforce')
    for (const p of POOLS) for (const token of [entry(p.pool).token0!, entry(p.pool).token1!]) cadence.push({ deposit, pool: p.label, token, fiveMin: totalMultiple(sep5m, a, p, token, deposit), hourly: totalMultiple(hourly, b, p, token, deposit) })
  }
  out.cadence = cadence
}

// ---- 4. Turnover per approval-year ------------------------------------------------------------------------------
const starts: number[] = []
const t0 = new Date(year.samples[0]!.time * 1000)
for (let m = 0; ; m++) {
  const t = Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() + m + (t0.getUTCDate() > 1 || t0.getUTCHours() > 0 ? 1 : 0), 1) / 1000
  if (t + YEAR > year.samples.at(-1)!.time) break
  starts.push(t)
}
const yearRuns: Record<string, unknown>[] = []
const turnover: Record<string, unknown>[] = []
const yearWaits: Record<string, W[]> = {}
for (const deposit of DEPOSITS) {
  for (const sessions of ['report', 'enforce'] as const) {
    const started = performance.now()
    const r = run(year, deposit, sessions)
    const exhausted = r.sessions.filter((s) => s.exhausted).map((s) => s.grant)
    yearRuns.push({ deposit, sessions, ms: Math.round(performance.now() - started), ops: r.metrics.operations, refused: r.metrics.refused, reasons: r.reasons, exhausted, returnBps: r.metrics.returnBps })
    console.error(`year run ${deposit} ${sessions}: ${Math.round(performance.now() - started)} ms`)
    if (sessions === 'enforce') for (const p of POOLS) for (const band of p.bands) for (const f of FACTORS) (yearWaits[`${deposit}|${p.label}|${band}|${f}`] ??= []).push(...waits(year, r, p, Math.floor(band * f), TWAP))
    for (const p of POOLS) {
      const e = entry(p.pool)
      const spend = spendOf(r.ops, p.pool)
      const cUsdc = usd(deposit * p.share)
      for (const start of starts) {
        const a = year.samples.findIndex((s) => s.time >= start)
        const s = year.samples[a]!
        for (const token of [e.token0!, e.token1!]) {
          const unit = 10n ** BigInt(entry(token).decimals ?? 18)
          const cTok = (cUsdc * unit) / price(s, token, unit)
          const { total, perWindow } = approvalSpend(spend, token, start, YEAR, DAY)
          const mult = (x: bigint) => Number((x * 10_000n) / cTok) / 10_000
          const days = perWindow.map(mult)
          turnover.push({ deposit, sessions, pool: p.label, token, start: iso(start), cTok: cTok.toString(), total: mult(total), maxDay: Math.max(...days), daysOver: Object.fromEntries([1, 2, 3, 5].map((x) => [x, days.filter((d) => d > x).length])) })
        }
      }
    }
  }
}
out.yearRuns = yearRuns
out.turnover = turnover
out.yearWaits = Object.fromEntries(Object.entries(yearWaits).map(([k, ws]) => [k, { all: summary(ws), exits: summary(ws.filter((w) => w.exit)), fastExits: summary(ws.filter((w) => w.exit && w.fast)) }]))

writeFileSync(OUT, JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1))
console.error(`wrote ${OUT}`)
