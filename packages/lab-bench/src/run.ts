// Agent Lab bench (spec 008, B-02): runs one BenchSpec through the production backtest and shapes the result the
// bench screen renders. Same tick->price math as the proven visual PoC (otto/mamoru#175). otto/mamoru#199.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeDataset, runBacktest, type Dataset, type DatasetJson } from '@mamoru/backtest'
import { ReasonError } from '@mamoru/domain'
import type { PolicyVersion } from '@mamoru/policy'
import { baseRegistry, entry, type RegistryName } from '@mamoru/registry'
import { BASES, basePolicyOf, defaultDatasetsDir, manifestWindow, policyOf, specKey, type Base, type BenchSpec, validateSpec, variantLabel } from './spec.ts'

/** The bench never charts more than this many points per run (B-02, AL-52). */
export const MAX_SERIES_POINTS = 400

export type RunResult = {
  specKey: string
  spec: BenchSpec
  variantLabel: string
  policyId: string
  resultHash: string
  simVersion: string
  /** otto/mamoru#200 review (AL-20c): the decoded dataset's own `id`, not the manifest window id — two windows
   * can share a window id's *bounds* by coincidence, but AL-20c's "same dataset" means the same underlying data. */
  datasetId: string
  window: { id: string; label: string; regime: string; split: 'train' | 'test'; from: string; to: string; market: unknown }
  deposit: number
  pools: string[]
  metrics: {
    days: number
    end: number
    net: number
    hodl: number
    vsHodl: number
    fees: number
    gas: number
    timeInRangeBps: number
    maxDrawdownBps: number
    returnBps: number
    operations: Record<string, number>
  }
  reasons: Record<string, number>
  ops: { t: number; kind: string; pool: string; gas: number; fees: number; code: string; reason: string }[]
  series: { t: number; v: number; h: number; price: Record<string, number>; band: Record<string, [number, number] | null> }[]
}

/** Decimals of the price token, from the registry: USDC/USDT 6, WETH 18, cbBTC 8 — never a hardcoded table. */
function decimalsOf(name: RegistryName): number {
  return entry(name, baseRegistry).decimals ?? 6
}

/** Price of a pool's non-savings token in the savings asset, from its tick — identical math to the PoC's `priceOf`. */
function priceOfTick(pool: RegistryName, savingsAsset: RegistryName, tick: number): number {
  const e = entry(pool, baseRegistry)
  const raw = 1.0001 ** tick * 10 ** (decimalsOf(e.token0!) - decimalsOf(e.token1!)) // token1 per token0
  return e.token0 === savingsAsset ? 1 / raw : raw
}

/** Bucket pools of `policy` no sample of `ds` ever read — a pool the dataset's schema names but never has data for. */
function missingPools(ds: Dataset, policy: PolicyVersion): RegistryName[] {
  const pools = [...new Set(policy.buckets.flatMap((b) => b.pools))]
  return pools.filter((p) => !ds.samples.some((s) => s.pools[ds.pools.indexOf(p)]))
}

function loadDataset(datasetsDir: string, file: string): Dataset {
  return decodeDataset(JSON.parse(readFileSync(join(datasetsDir, file), 'utf8')) as DatasetJson)
}

/**
 * At most `max` strictly increasing indices into `0..n-1`, evenly spaced, always starting at `0` and ending at
 * `n - 1` (review of #117 P3: the previous step-based scheme could return `max + 1` — e.g. 401 for `n = 800`, since
 * appending the forced last point was never accounted for in the loop bound). This is correct by construction
 * instead: the loop itself runs at most `max` times, so the output can never exceed `max` regardless of `n`;
 * `Math.round` can only ever collide adjacent picks into fewer, never more, and any collision is deduped.
 */
export function downsampleIndices(n: number, max: number): number[] {
  if (n <= 0) return []
  if (max <= 1) return [0]
  if (n <= max) return Array.from({ length: n }, (_, i) => i)
  const idx = new Set<number>()
  for (let k = 0; k < max; k++) idx.add(Math.round((k * (n - 1)) / (max - 1)))
  return [...idx]
}

/**
 * Which bases have real data to run on this window (B-03): a base whose policy needs a pool the window's dataset
 * never read (e.g. `aug2024`, before cbBTC was on Base) is left out. Pure data-availability, not a holdout check:
 * callers that must stay off TEST windows apply `validateSpec`/the manifest split themselves.
 */
export function basesForWindow(windowId: string, datasetsDir: string = defaultDatasetsDir()): Base[] {
  const w = manifestWindow(windowId, datasetsDir)
  const ds = loadDataset(datasetsDir, w.file)
  return BASES.filter((base) => missingPools(ds, basePolicyOf(base)).length === 0)
}

/**
 * Runs one bench spec through the production `decide` and shapes the B-02 result. Throws `LAB_SPEC_INVALID` /
 * `LAB_HOLDOUT_DENIED` from `validateSpec`, or `LAB_DATASET_MISSING` when the window's dataset lacks a pool the
 * resolved base needs (B-03).
 */
export function runBench(spec: BenchSpec, datasetsDir: string = defaultDatasetsDir()): RunResult {
  validateSpec(spec, datasetsDir)
  const w = manifestWindow(spec.windowId, datasetsDir)
  const policy = policyOf(spec)
  const ds = loadDataset(datasetsDir, w.file)
  const missing = missingPools(ds, policy)
  if (missing.length > 0) throw new ReasonError('LAB_DATASET_MISSING', `${spec.windowId}: no data for ${missing.join(', ')} (base ${spec.base})`)

  const decimals = decimalsOf(policy.savingsAsset)
  const unit = 10 ** decimals
  const deposit = BigInt(spec.deposit) * 10n ** BigInt(decimals)
  const pools = [...new Set(policy.buckets.flatMap((b) => b.pools))].filter((p) => ds.pools.includes(p))

  type Snap = { i: number; time: number; pos: { pool: string; lo: number; hi: number }[] }
  const snaps: Snap[] = []
  const r = runBacktest(ds, policy, {
    deposit,
    onSample: (i, time, positions) => {
      snaps.push({
        i,
        time,
        pos: positions
          .filter((p) => p.liquidity > 0n)
          .map((p) => {
            const a = priceOfTick(p.pool, policy.savingsAsset, p.tickLower)
            const b = priceOfTick(p.pool, policy.savingsAsset, p.tickUpper)
            return { pool: p.pool, lo: Math.min(a, b), hi: Math.max(a, b) }
          }),
      })
    },
  })

  const idx = downsampleIndices(snaps.length, MAX_SERIES_POINTS)

  const usd = (v: bigint): number => Number(v) / unit
  const round4 = (v: number): number => +v.toFixed(4)

  const series = idx.map((k) => {
    const sn = snaps[k]!
    const sample = ds.samples[sn.i]!
    const price: Record<string, number> = {}
    const band: Record<string, [number, number] | null> = {}
    for (const p of pools) {
      const ps = sample.pools[ds.pools.indexOf(p)]
      price[p] = ps ? +priceOfTick(p, policy.savingsAsset, ps.tick).toPrecision(6) : Number.NaN
      const b = sn.pos.find((x) => x.pool === p)
      band[p] = b ? [+b.lo.toPrecision(6), +b.hi.toPrecision(6)] : null
    }
    return { t: r.series.time[k]!, v: round4(usd(r.series.value[k]!)), h: round4(usd(r.series.hodl[k]!)), price, band }
  })

  const m = r.metrics
  return {
    specKey: specKey(spec),
    spec,
    variantLabel: variantLabel(spec),
    policyId: r.policyId,
    resultHash: r.resultHash,
    simVersion: r.simVersion,
    datasetId: ds.id,
    window: { id: w.id, label: w.label, regime: w.regime, split: w.split, from: w.from, to: w.to, market: w.market },
    deposit: spec.deposit,
    pools,
    metrics: {
      days: m.days,
      end: round4(usd(m.end)),
      net: round4(usd(m.net)),
      hodl: round4(usd(m.hodl)),
      vsHodl: round4(usd(m.vsHodl)),
      fees: round4(usd(m.fees)),
      gas: round4(usd(m.gas)),
      timeInRangeBps: m.timeInRangeBps,
      maxDrawdownBps: m.maxDrawdownBps,
      returnBps: m.returnBps,
      operations: m.operations,
    },
    reasons: r.reasons,
    ops: r.ops
      .filter((o) => o.ok)
      .map((o) => ({ t: o.time, kind: o.kind, pool: o.pool, gas: round4(usd(o.gasCost)), fees: round4(usd(o.feesValue)), code: o.code, reason: o.reason })),
    series,
  }
}
