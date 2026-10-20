// otto/mamoru#151 (spec 007), Lab only: "option C" budgets. Are MamoruActionPolicy's W_p/T_p sized so that one
// approval-year needs no extra owner tap, and what do lazy re-range (#172) and increase-instead-of-mint (#171) change?
//   bun packages/backtest/cli/budgets-c.ts [--out ~/.local/share/mamoru-lab/budgets-c.json] [--deposits 1000,100000]
// Engine: conservadorLiveV4's `decide` config (= conservador-live-v2's: same range, allocation, execution), four
// variants: (a) as deployed, (b) + range.lazy `lazy-h24h-b100-d30` (#172's template), (c) + a per-pool `increase`
// grant (#171), (d) both. Sessions `report`: the engine's own turnover, with no UniActionPolicy cap in the way (those
// follow T_p in v4, so the budget below is the one that binds).
// 1. Approval-years: a fresh account activated on every month start with 365 days of hourly data after it (13 years,
//    2024-10-01 .. 2025-10-01 starts), one run each. Every executed swap/mint/increase is charged as the contract
//    charges it (`_value`): one value in the pool's stable token (USDC for all three), the other token at the range
//    edge that values it highest (spot moved by the band). The charges are replayed against a token bucket of
//    W_p x C_p refilled over one day and a per-approval total T_p x C_p (`_charge`), for each budget set: owner taps
//    (T_p exhausted: the owner renews, a new generation, the total restarts), and the charges W_p refuses (the engine
//    waits until the bucket has room; later charges queue behind it).
// 2. Lab windows at native resolution (5/10-minute): return, drawdown and gas of (b)-(d) against (a).
// 3. Cadence: Sep 2026 is in both the 5-minute window and the hourly series; turnover at both review rates.
// 4. Spec 007 loss bound for each budget set, revoked within minutes / 1 day / never.
// Reads datasets only; no chain calls.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { conservadorLiveV2, conservadorLiveV4, increaseGrants, V4_POOLS, type PolicyVersion } from '@mamoru/policy'
import { entry, type RegistryName } from '@mamoru/registry'
import { decodeDataset, makeDataset, type DatasetJson } from '../src/dataset.ts'
import { pricer, runBacktest } from '../src/run.ts'
import type { Dataset, OpEntry, RunResult } from '../src/types.ts'
import { datasetsDir, LAB_WINDOWS, windowBlocks } from '../src/windows.ts'

const argv = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const OUT = argv('out', join(homedir(), '.local/share/mamoru-lab/budgets-c.json'))
const YEAR_FILES = argv('year', 'base-2024-10-2026-02-1h.json,base-2026-cdp-case-1h.json').split(',')
const DEPOSITS = argv('deposits', '1000,100000').split(',').map(Number)
const SKIP_LAB = process.argv.includes('--skip-lab')

const DAY = 86_400
const YEAR = 365 * DAY

// ---- variants ---------------------------------------------------------------------------------------------------
// conservadorLiveV4's own grants cannot drive `decide` here: v4 merges convert-any into manage-any, and `decide`
// still names `convert-any` for every harvest and idle convert (`anyKey` -> `grantKeyFor` throws "no convert-any grant").
// The engine config is otherwise conservador-live-v2's field for field (asserted below), and the budget charges do not
// depend on grant names, so the runs use conservador-live-v2's grant shape with v4's decide config.
const DECIDE_FIELDS = ['buckets', 'savingsAsset', 'gasReserveWei', 'harvest', 'range', 'allocation', 'minEntry', 'rebalanceBandBps', 'execution'] as const
for (const f of DECIDE_FIELDS) {
  const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  if (j(conservadorLiveV4[f]) !== j(conservadorLiveV2[f])) throw new Error(`conservador-live-v4 and -v2 differ in ${f}: the v2-shaped replay would not be v4's engine`)
}
const base: PolicyVersion = { ...conservadorLiveV2, policyId: 'conservador-live-v4(decide)', version: conservadorLiveV4.version }
/** #172's engine template `lazy-h24h-b100-d30` (spec 004 TRAIN/TEST candidate). Lab: abstains without fee history. */
const LAZY = { edgeBufferTicks: 100, minDwellSeconds: 1_800, horizonSeconds: 86_400, lvrWeightBps: 10_000 }
const increaseOf = (p: (typeof V4_POOLS)[keyof typeof V4_POOLS]) =>
  increaseGrants(
    { stable: p.stable, volatile: p.volatile, token0: p.token0, token1: p.token1, fee: p.fee, pool: p.pool, caps: { stableSwapPerCall: p.caps.stableSwapPerCall, stableSwapTotal: p.caps.stableSwapTotal, mint0: p.caps.mint0, mint1: p.caps.mint1, volatileConvertPerCall: p.caps.volatileConvertPerCall, volatileConvertTotal: p.caps.volatileConvertTotal } },
    { increase: 1_000 },
  )
const withLazy = (p: PolicyVersion): PolicyVersion => ({ ...p, policyId: `${p.policyId}+lazy`, range: { ...p.range, lazy: LAZY } })
const withIncrease = (p: PolicyVersion): PolicyVersion => ({ ...p, policyId: `${p.policyId}+increase`, session: { ...p.session, grants: [...p.session.grants, ...Object.values(V4_POOLS).flatMap(increaseOf)] } })
const VARIANTS: Record<string, PolicyVersion> = { a: base, b: withLazy(base), c: withIncrease(base), d: withLazy(withIncrease(base)) }

// ---- pools and budget sets --------------------------------------------------------------------------------------
type Pool = { label: 'stables' | 'btc' | 'risk'; pool: RegistryName; stable: RegistryName; share: number; feeBps: number }
const POOLS: Pool[] = (['stables', 'btc', 'risk'] as const).map((label) => {
  const p = V4_POOLS[label]
  return { label, pool: p.pool as RegistryName, stable: p.stable as RegistryName, share: p.capShareBps / 10_000, feeBps: p.fee / 100 }
})
type Budget = { id: string; band: Record<Pool['label'], number>; w: Record<Pool['label'], number>; t: Record<Pool['label'], number> }
const BUDGETS: Budget[] = [
  { id: 'prod', band: { stables: 10, btc: 100, risk: 100 }, w: { stables: 5, btc: 2, risk: 3 }, t: { stables: 10, btc: 10, risk: 10 } },
  { id: 'C', band: { stables: 20, btc: 125, risk: 125 }, w: { stables: 8, btc: 3, risk: 5 }, t: { stables: 60, btc: 42, risk: 110 } },
]
for (const p of POOLS) if (V4_POOLS[p.label].bandTicks !== BUDGETS[0]!.band[p.label] || V4_POOLS[p.label].windowMultiple !== BUDGETS[0]!.w[p.label] || V4_POOLS[p.label].totalMultiple !== BUDGETS[0]!.t[p.label]) throw new Error(`prod budget table does not match V4_POOLS (${p.label})`)

// ---- helpers ----------------------------------------------------------------------------------------------------
const load = (file: string): Dataset => decodeDataset(JSON.parse(readFileSync(join(datasetsDir(), file), 'utf8')) as DatasetJson)
const slice = (ds: Dataset, from: number, to: number): Dataset => makeDataset(ds.chainId, ds.pools, ds.samples.filter((s) => s.block >= from && s.block <= to))
const sliceTime = (ds: Dataset, from: number, to: number): Dataset => makeDataset(ds.chainId, ds.pools, ds.samples.filter((s) => s.time >= from && s.time < to))
const usd = (deposit: number): bigint => BigInt(Math.round(deposit * 1e6))
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
const quant = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}
const r2 = (x: number) => Math.round(x * 100) / 100
const run = (ds: Dataset, policy: PolicyVersion, deposit: number): RunResult => runBacktest(ds, policy, { deposit: usd(deposit), sessions: 'report' })

/** A charge against a pool's budget: time and value in USDC (float, whole units), as `_value` charges it. */
type Charge = { time: number; usdc: number; kind: OpEntry['kind'] }
function chargesOf(ds: Dataset, policy: PolicyVersion, r: RunResult, p: Pool, bandTicks: number): Charge[] {
  const price = pricer(ds, policy)
  const edge = Math.pow(1.0001, bandTicks)
  const out: Charge[] = []
  for (const o of r.ops) {
    if (!o.ok || o.pool !== p.pool || !o.spend) continue
    const s = ds.samples[o.i]!
    let v = 0
    for (const x of o.spend) {
      if (x.amount === 0n) continue
      const inUsdc = Number(price(s, x.token, x.amount)) / 1e6
      v += x.token === p.stable ? inUsdc : inUsdc * edge
    }
    if (v > 0) out.push({ time: o.time, usdc: v, kind: o.kind })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** Owner taps: each time the approval total would pass T, the owner renews (new generation) and the total restarts. */
function taps(charges: Charge[], cap: number, from: number): number[] {
  const days: number[] = []
  let spent = 0
  for (const c of charges) {
    if (spent + c.usdc > cap) {
      days.push(Math.floor((c.time - from) / DAY) + 1)
      spent = 0
    }
    spent += c.usdc
  }
  return days
}

/** The token bucket of `_charge`: refused charges wait for room (later ones queue behind); a charge over the capacity never fits. */
function bucket(charges: Charge[], cap: number, from: number) {
  const rate = cap / DAY
  let debt = 0
  let at = from
  let refused = 0
  let neverFits = 0
  let maxWait = 0
  const days = new Set<number>()
  for (const c of charges) {
    let t = Math.max(c.time, at)
    debt = Math.max(0, debt - rate * (t - at))
    if (c.usdc > cap) {
      neverFits++
      days.add(Math.floor((c.time - from) / DAY))
      at = t
      continue
    }
    if (debt + c.usdc > cap) {
      const wait = (debt + c.usdc - cap) / rate
      t += wait
      debt = cap - c.usdc
    }
    if (t > c.time) {
      refused++
      days.add(Math.floor((c.time - from) / DAY))
      maxWait = Math.max(maxWait, t - c.time)
    }
    debt += c.usdc
    at = t
  }
  return { refused, refusedDays: days.size, neverFits, maxWaitHours: r2(maxWait / 3600) }
}

/** Smallest bucket capacity (multiple of C_p) that never refuses: bisection on `bucket`. */
function minW(charges: Charge[], cp: number, from: number): number {
  if (charges.length === 0) return 0
  let lo = 0
  let hi = 2 * charges.reduce((a, c) => a + c.usdc, 0) / cp + 1
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2
    const b = bucket(charges, mid * cp, from)
    if (b.refused === 0 && b.neverFits === 0) hi = mid
    else lo = mid
  }
  return r2(hi)
}

/** Busiest fixed day from activation, multiple of C_p. */
function worstDay(charges: Charge[], cp: number, from: number): { mult: number; day: number } {
  const per = new Map<number, number>()
  for (const c of charges) {
    const d = Math.floor((c.time - from) / DAY)
    per.set(d, (per.get(d) ?? 0) + c.usdc)
  }
  let best = { mult: 0, day: 0 }
  for (const [d, v] of per) if (v / cp > best.mult) best = { mult: r2(v / cp), day: d + 1 }
  return best
}

const tickFraction = (ticks: number): number => Math.pow(1.0001, ticks) - 1
/** Spec 007: L <= sum_p (band_p + fee_p) x (V_p + 2 x min(T_p, W_p x (1 + tau / 1 day))), as a share of the cap. */
const lossBound = (b: Budget, tauDays: number | null): number =>
  POOLS.reduce((a, p) => {
    const spend = tauDays === null ? b.t[p.label] : Math.min(b.t[p.label], b.w[p.label] * (1 + tauDays))
    return a + (tickFraction(b.band[p.label]) + p.feeBps / 10_000) * p.share * (1 + 2 * spend)
  }, 0)

const out: Record<string, unknown> = { policy: `${base.policyId}@${base.version}`, lazy: LAZY, budgets: BUDGETS }

// ---- 1. approval-years ------------------------------------------------------------------------------------------
const parts = YEAR_FILES.map(load)
for (const d of parts) if (d.pools.join() !== parts[0]!.pools.join()) throw new Error('year datasets list different pools')
const year = makeDataset(parts[0]!.chainId, parts[0]!.pools, parts.flatMap((d) => d.samples))
const starts: number[] = []
{
  const t0 = new Date(year.samples[0]!.time * 1000)
  for (let m = 0; ; m++) {
    const t = Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() + m + (t0.getUTCDate() > 1 || t0.getUTCHours() > 0 ? 1 : 0), 1) / 1000
    if (t + YEAR > year.samples.at(-1)!.time) break
    starts.push(t)
  }
}
out.year = { from: iso(year.samples[0]!.time), to: iso(year.samples.at(-1)!.time), samples: year.samples.length, starts: starts.map(iso) }
console.error(`year ${iso(year.samples[0]!.time)} .. ${iso(year.samples.at(-1)!.time)}: ${starts.length} approval-years`)

const yearRows: Record<string, unknown>[] = []
for (const deposit of DEPOSITS) for (const [vid, policy] of Object.entries(VARIANTS)) for (const start of starts) {
  const ds = sliceTime(year, start, start + YEAR)
  const t = performance.now()
  const r = run(ds, policy, deposit)
  const m = r.metrics
  const row: Record<string, unknown> = {
    deposit, variant: vid, start: iso(start),
    returnBps: m.returnBps, maxDrawdownBps: m.maxDrawdownBps, worstWeekBps: m.worstWeekBps, gasUsdc: Number(m.gas) / 1e6, feesUsdc: Number(m.fees) / 1e6, vsHodlUsdc: Number(m.vsHodl) / 1e6, timeInRangeBps: m.timeInRangeBps, operations: m.operations,
    pools: {} as Record<string, unknown>,
  }
  for (const p of POOLS) {
    const cp = deposit * p.share
    const byBudget: Record<string, unknown> = {}
    let turnover = 0
    let byKind: Record<string, number> = {}
    let wd = { mult: 0, day: 0 }
    let wMin = 0
    for (const b of BUDGETS) {
      const ch = chargesOf(ds, policy, r, p, b.band[p.label])
      if (b.id === 'prod') {
        turnover = r2(ch.reduce((a, c) => a + c.usdc, 0) / cp)
        byKind = {}
        for (const c of ch) byKind[c.kind] = r2((byKind[c.kind] ?? 0) + c.usdc / cp)
        wd = worstDay(ch, cp, start)
        wMin = minW(ch, cp, start)
      }
      byBudget[b.id] = { taps: taps(ch, b.t[p.label] * cp, start), w: bucket(ch, b.w[p.label] * cp, start) }
    }
    ;(row.pools as Record<string, unknown>)[p.label] = { turnover, byKind, worstDay: wd, minW: wMin, ...byBudget }
  }
  yearRows.push(row)
  console.error(`year ${deposit} ${vid} ${iso(start)}: ${Math.round(performance.now() - t)} ms`)
}
out.years = yearRows

// ---- 2. Lab windows, native resolution --------------------------------------------------------------------------
let sep5m: Dataset | null = null
if (!SKIP_LAB) {
  const labRows: Record<string, unknown>[] = []
  for (const lw of LAB_WINDOWS) {
    const { fromBlock, toBlock } = windowBlocks(lw)
    const ds = slice(load(lw.file), fromBlock, toBlock)
    if (lw.id === 'sep2026') sep5m = ds
    if (POOLS.some((p) => ds.samples.every((s) => !s.pools[ds.pools.indexOf(p.pool)]))) {
      labRows.push({ window: lw.id, skipped: 'a bucket pool has no data' })
      continue
    }
    for (const deposit of DEPOSITS) for (const [vid, policy] of Object.entries(VARIANTS)) {
      const r = run(ds, policy, deposit)
      const m = r.metrics
      const turnover: Record<string, number> = {}
      for (const p of POOLS) turnover[p.label] = r2(chargesOf(ds, policy, r, p, BUDGETS[0]!.band[p.label]).reduce((a, c) => a + c.usdc, 0) / (deposit * p.share))
      labRows.push({ window: lw.id, split: lw.split, regime: lw.regime, deposit, variant: vid, days: r2(m.days), returnBps: m.returnBps, maxDrawdownBps: m.maxDrawdownBps, worstWeekBps: m.worstWeekBps, gasUsdc: Number(m.gas) / 1e6, timeInRangeBps: m.timeInRangeBps, operations: m.operations, turnover })
    }
    console.error(`lab ${lw.id} done`)
  }
  out.lab = labRows
}

// ---- 3. cadence -------------------------------------------------------------------------------------------------
if (sep5m) {
  const hourly = slice(year, sep5m.samples[0]!.block, sep5m.samples.at(-1)!.block)
  const rows: Record<string, unknown>[] = []
  for (const deposit of DEPOSITS) for (const [vid, policy] of Object.entries(VARIANTS)) {
    const a = run(sep5m, policy, deposit)
    const h = run(hourly, policy, deposit)
    for (const p of POOLS) {
      const cp = deposit * p.share
      const t = (ds: Dataset, r: RunResult) => r2(chargesOf(ds, policy, r, p, BUDGETS[0]!.band[p.label]).reduce((x, c) => x + c.usdc, 0) / cp)
      rows.push({ deposit, variant: vid, pool: p.label, fiveMin: t(sep5m, a), hourly: t(hourly, h) })
    }
  }
  out.cadence = rows
}

// ---- 4. loss bounds ---------------------------------------------------------------------------------------------
out.loss = BUDGETS.map((b) => ({ id: b.id, minutes: lossBound(b, 5 / 1440), hour: lossBound(b, 1 / 24), day: lossBound(b, 1), never: lossBound(b, null) }))

// ---- summary ----------------------------------------------------------------------------------------------------
const summary: Record<string, unknown>[] = []
for (const deposit of DEPOSITS) for (const vid of Object.keys(VARIANTS)) for (const p of POOLS) {
  const rows = yearRows.filter((r) => r.deposit === deposit && r.variant === vid).map((r) => (r.pools as Record<string, any>)[p.label])
  const tv = rows.map((x) => x.turnover as number)
  summary.push({
    deposit, variant: vid, pool: p.label,
    turnoverMedian: quant(tv, 0.5), turnoverMax: Math.max(...tv),
    worstDay: Math.max(...rows.map((x) => x.worstDay.mult)), minWmax: Math.max(...rows.map((x) => x.minW)),
    ...Object.fromEntries(BUDGETS.map((b) => [b.id, {
      yearsWithTap: rows.filter((x) => x[b.id].taps.length > 0).length,
      tapsTotal: rows.reduce((a, x) => a + x[b.id].taps.length, 0),
      tapsMax: Math.max(...rows.map((x) => x[b.id].taps.length)),
      firstTapDays: rows.filter((x) => x[b.id].taps.length > 0).map((x) => x[b.id].taps[0]),
      wRefusedDaysTotal: rows.reduce((a, x) => a + x[b.id].w.refusedDays, 0),
      wRefusedDaysMax: Math.max(...rows.map((x) => x[b.id].w.refusedDays)),
      wNeverFits: rows.reduce((a, x) => a + x[b.id].w.neverFits, 0),
      wMaxWaitHours: Math.max(...rows.map((x) => x[b.id].w.maxWaitHours)),
    }])),
  })
}
out.summary = summary

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1))
console.error(`wrote ${OUT}`)
