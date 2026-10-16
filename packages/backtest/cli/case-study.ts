// Case study (mamoru#143): the CDP experiment position, Uniswap v3 USDC/cbBTC 0.05% #4585548 on Base, minted
// 2026-02-07 and never touched until it was closed on 2026-10-16. Replays the real position first, checks the fees
// against what the chain paid, then replays strategy variants over the same price path.
//   bun packages/backtest/cli/case-study.ts --dataset ~/.local/share/mamoru-lab/datasets/base-2026-cdp-case-1h.json
//   bun packages/backtest/cli/case-study.ts --cache <file>.cache.jsonl   (a backfill still running)
// Static ranges never pay gas after the mint. Every rebuild (re-range, compound) pays a remove, a swap and a mint at
// the gas of `DEFAULT_GAS` and the base fee of its sample, priced in USDC through WETH/USDC/500.
import { readFileSync, writeFileSync } from 'node:fs'
import { amountsOf } from '@mamoru/decide'
import { baseRegistry, entry, type RegistryEntry, type RegistryName } from '@mamoru/registry'
import { quoteMint, rangeAround, token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { decodeDataset, makeDataset, type DatasetJson } from '../src/dataset.ts'
import { DEFAULT_GAS } from '../src/run.ts'
import type { Dataset, PoolSample, Sample } from '../src/types.ts'
import { accrue, inRange, swapOut, valueIn, type SimPosition } from '../src/world.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const unbig = (_k: string, v: unknown) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)
function load(): Dataset {
  const d = arg('dataset')
  if (d) return decodeDataset(JSON.parse(readFileSync(d, 'utf8')) as DatasetJson)
  const c = arg('cache')
  if (!c) throw new Error('--dataset or --cache')
  const samples = readFileSync(c, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l, unbig) as Sample)
  return makeDataset(8453, baseRegistry.entries.filter((e) => e.kind === 'pool').map((e) => e.name), samples)
}

const ds = load()
const SAV: RegistryName = 'USDC'
const CASE_POOL: RegistryName = 'pool:USDC/cbBTC/500'
const ETH_POOL: RegistryName = 'pool:WETH/USDC/500'
// The real position, read from the chain on 2026-10-16.
const REAL = { mintBlock: 41_853_004, tickLower: -66_220, tickUpper: -64_620, liquidity: 25_083_573n, amount0: 25_721_742n, amount1: 37_603n, fees0: 3_787_652n, fees1: 5_508n }
const H = 3600

const at = (name: RegistryName, s: Sample): PoolSample | null => s.pools[ds.pools.indexOf(name)] ?? null
const first = ds.samples.findIndex((s) => s.block >= REAL.mintBlock - 1800)
const S = ds.samples.slice(first).filter((s) => at(CASE_POOL, s) && at(ETH_POOL, s))
if (S.length < 2) throw new Error('not enough samples after the mint')
const days = (S[S.length - 1]!.time - S[0]!.time) / 86_400

function usd(e: RegistryEntry, s: PoolSample, token: RegistryName, amount: bigint): bigint {
  return valueIn(e, s, token, amount, SAV)
}

/** Raw USDC of `units` gas at the sample's base fee, plus the L1 data fee. */
function gasUsd(s: Sample, units: bigint): bigint {
  const wei = units * (s.baseFeeWei + DEFAULT_GAS.priorityFeeWei) + DEFAULT_GAS.l1FeeWei
  return usd(entry(ETH_POOL), at(ETH_POOL, s)!, 'WETH', wei)
}
const REBUILD = DEFAULT_GAS.unitsByKind.rerange + DEFAULT_GAS.unitsByKind.enter_swap + DEFAULT_GAS.unitsByKind.enter_mint
const HARVEST = DEFAULT_GAS.unitsByKind.harvest + DEFAULT_GAS.unitsByKind.enter_swap

export type Strategy = {
  name: string
  pool: RegistryName
  /** Total width in ticks; 'real' is the CDP position, 'full' the whole curve. */
  width: number | 'real' | 'full'
  /** Re-range when the price has been out of range this long. Undefined: never. */
  rerangeAfterH?: number
  /** Least time between two re-ranges. */
  cooldownH?: number
  /** Fees: left in the position (none), folded back every `everyH` (compound), or sold to USDC every `everyH` (harvest). */
  fees?: { mode: 'compound' | 'harvest'; everyH: number }
  /** While out of range, the position's value earns this lending APR (%), as if parked in Aave and brought back. */
  idleLendApr?: number
  /** Share of the starting capital, for portfolios. Default 1. */
  weight?: number
}

type Book = { b0: bigint; b1: bigint; pos: SimPosition | null; gas: bigint; swapFees: bigint; feesUsd: bigint; ops: number; reranges: number; inRangeH: number }

const MIN_TICK = -887_272
const MAX_TICK = 887_272

/** Swaps the book to the ratio of [tl, tu) at the sample price and mints. Leaves it idle if the mint is impossible. */
function mint(e: RegistryEntry, s: PoolSample, book: Book, tl: number, tu: number): void {
  const u = amountsOf(s.sqrtPriceX96, tl, tu, 10n ** 18n)
  const v1 = token0InToken1(book.b0, s.sqrtPriceX96) + book.b1
  const u1v = token0InToken1(u.amount0, s.sqrtPriceX96) + u.amount1
  const target1 = u1v === 0n ? 0n : (v1 * u.amount1) / u1v
  const fee = BigInt(e.fee ?? 0)
  if (book.b1 > target1) {
    const x = book.b1 - target1
    book.swapFees += usd(e, s, e.token1!, (x * fee) / 1_000_000n)
    book.b1 -= x
    book.b0 += swapOut(e, s, e.token1!, x)
  } else if (target1 > book.b1) {
    const x = token1InToken0(target1 - book.b1, s.sqrtPriceX96)
    const y = x > book.b0 ? book.b0 : x
    book.swapFees += usd(e, s, e.token0!, (y * fee) / 1_000_000n)
    book.b0 -= y
    book.b1 += swapOut(e, s, e.token0!, y)
  }
  try {
    const q = quoteMint({ sqrtPriceX96: s.sqrtPriceX96, tickLower: tl, tickUpper: tu, amount0Desired: book.b0, amount1Desired: book.b1, slippageBps: 0 })
    book.b0 -= q.amount0
    book.b1 -= q.amount1
    book.pos = { tokenId: 1n, pool: e.name, tickLower: tl, tickUpper: tu, liquidity: q.liquidity, owed0: 0n, owed1: 0n }
  } catch {
    book.pos = null
  }
}

function unwind(_e: RegistryEntry, s: PoolSample, book: Book): void {
  if (!book.pos) return
  const a = amountsOf(s.sqrtPriceX96, book.pos.tickLower, book.pos.tickUpper, book.pos.liquidity)
  book.b0 += a.amount0 + book.pos.owed0
  book.b1 += a.amount1 + book.pos.owed1
  book.pos = null
}

function rangeFor(e: RegistryEntry, tick: number, width: number | 'full'): [number, number] {
  const sp = e.tickSpacing ?? 10
  if (width === 'full') return [Math.ceil(MIN_TICK / sp) * sp, Math.floor(MAX_TICK / sp) * sp]
  const r = rangeAround(tick, width, sp)
  return [r.tickLower, r.tickUpper]
}

export type Result = { name: string; start: number; end: number; maxDdPct?: number; feesUsd: number; gasUsd: number; swapFeesUsd: number; ops: number; reranges: number; inRangePct: number; fees0?: bigint; fees1?: bigint }

const toUsd = (raw: bigint) => Number(raw) / 1e6

/** Starting capital: what the real mint put in, valued at the first sample. */
function startUsd(): bigint {
  const s = at(CASE_POOL, S[0]!)!
  return REAL.amount0 + usd(entry(CASE_POOL), s, 'cbBTC', REAL.amount1)
}

export function simulate(st: Strategy, capital = startUsd()): Result {
  const e = entry(st.pool)
  const s0 = at(st.pool, S[0]!)
  if (!s0) throw new Error(`${st.pool} has no first sample`)
  const book: Book = { b0: 0n, b1: 0n, pos: null, gas: 0n, swapFees: 0n, feesUsd: 0n, ops: 0, reranges: 0, inRangeH: 0 }
  const cap = (capital * BigInt(Math.round((st.weight ?? 1) * 10_000))) / 10_000n
  let f0 = 0n
  let f1 = 0n
  if (st.width === 'real') {
    book.pos = { tokenId: 1n, pool: st.pool, tickLower: REAL.tickLower, tickUpper: REAL.tickUpper, liquidity: REAL.liquidity, owed0: 0n, owed1: 0n }
  } else {
    if (e.token0 === SAV) book.b0 = cap
    else book.b1 = cap
    const [tl, tu] = rangeFor(e, s0.tick, st.width)
    mint(e, s0, book, tl, tu)
    book.gas += gasUsd(S[0]!, DEFAULT_GAS.unitsByKind.enter_swap + DEFAULT_GAS.unitsByKind.enter_mint)
    book.ops++
  }
  let peak = 0
  let lent = 0
  let maxDd = 0
  let outSince: number | null = null
  let lastRerange = -Infinity
  let lastFees = S[0]!.time
  for (let i = 1; i < S.length; i++) {
    const a = at(st.pool, S[i - 1]!)
    const b = at(st.pool, S[i]!)
    if (!a || !b) continue
    const t = S[i]!.time
    if (book.pos) {
      const got = accrue(book.pos, a, b)
      f0 += got.fees0
      f1 += got.fees1
      book.feesUsd += usd(e, b, e.token0!, got.fees0) + usd(e, b, e.token1!, got.fees1)
      if (inRange(b.tick, book.pos)) book.inRangeH += (t - S[i - 1]!.time) / H
    }
    if (i % 24 === 0) {
      let v = usd(e, b, e.token0!, book.b0) + usd(e, b, e.token1!, book.b1) - book.gas
      if (book.pos) {
        const x = amountsOf(b.sqrtPriceX96, book.pos.tickLower, book.pos.tickUpper, book.pos.liquidity)
        v += usd(e, b, e.token0!, x.amount0 + book.pos.owed0) + usd(e, b, e.token1!, x.amount1 + book.pos.owed1)
      }
      const vn = toUsd(v)
      peak = Math.max(peak, vn)
      maxDd = Math.max(maxDd, peak > 0 ? (100 * (peak - vn)) / peak : 0)
    }
    const out = !book.pos || !inRange(b.tick, book.pos)
    if (st.idleLendApr && out && book.pos) {
      const x = amountsOf(b.sqrtPriceX96, book.pos.tickLower, book.pos.tickUpper, book.pos.liquidity)
      const v = usd(e, b, e.token0!, x.amount0) + usd(e, b, e.token1!, x.amount1)
      lent += (Number(v) * st.idleLendApr * (t - S[i - 1]!.time)) / (100 * 365 * 86_400)
    }
    outSince = out ? (outSince ?? t) : null
    if (st.width !== 'real' && st.rerangeAfterH !== undefined && out && outSince !== null && t - outSince >= st.rerangeAfterH * H && t - lastRerange >= (st.cooldownH ?? 0) * H) {
      unwind(e, b, book)
      const [tl, tu] = rangeFor(e, b.tick, st.width as number | 'full')
      mint(e, b, book, tl, tu)
      book.gas += gasUsd(S[i]!, REBUILD)
      book.ops++
      book.reranges++
      lastRerange = t
      outSince = null
      lastFees = t
      continue
    }
    if (st.fees && book.pos && t - lastFees >= st.fees.everyH * H) {
      lastFees = t
      if (st.fees.mode === 'compound' && !inRange(b.tick, book.pos)) {
        // Out of range a rebuild of the same ticks is one-sided; fold the fees in at the next in-range sample.
        lastFees = t - st.fees.everyH * H
        continue
      } else if (st.fees.mode === 'compound') {
        const { tickLower, tickUpper } = book.pos
        unwind(e, b, book)
        mint(e, b, book, tickLower, tickUpper)
        book.gas += gasUsd(S[i]!, REBUILD)
      } else {
        const vol = e.token0 === SAV ? 'token1' : 'token0'
        const owed = vol === 'token1' ? book.pos.owed1 : book.pos.owed0
        if (e.token0 === SAV) book.b0 += book.pos.owed0
        else book.b1 += book.pos.owed1
        book.pos.owed0 = 0n
        book.pos.owed1 = 0n
        if (owed > 0n) {
          const tin = vol === 'token1' ? e.token1! : e.token0!
          const got = swapOut(e, b, tin, owed)
          if (e.token0 === SAV) book.b0 += got
          else book.b1 += got
        }
        book.gas += gasUsd(S[i]!, HARVEST)
      }
      book.ops++
    }
  }
  const last = at(st.pool, S[S.length - 1]!)!
  let end = usd(e, last, e.token0!, book.b0) + usd(e, last, e.token1!, book.b1)
  if (book.pos) {
    const x = amountsOf(last.sqrtPriceX96, book.pos.tickLower, book.pos.tickUpper, book.pos.liquidity)
    end += usd(e, last, e.token0!, x.amount0 + book.pos.owed0) + usd(e, last, e.token1!, x.amount1 + book.pos.owed1)
  }
  end -= book.gas
  end += BigInt(Math.round(lent))
  const hours = (S[S.length - 1]!.time - S[0]!.time) / H
  return { name: st.name, start: toUsd(st.width === 'real' ? capital : cap), end: toUsd(end), feesUsd: toUsd(book.feesUsd), gasUsd: toUsd(book.gas), swapFeesUsd: toUsd(book.swapFees), ops: book.ops, reranges: book.reranges, inRangePct: (100 * book.inRangeH) / hours, maxDdPct: maxDd, fees0: f0, fees1: f1 }
}

function hold(name: string, share1: number): Result {
  const e = entry(CASE_POOL)
  const a = at(CASE_POOL, S[0]!)!
  const z = at(CASE_POOL, S[S.length - 1]!)!
  const cap = startUsd()
  const usdc = (cap * BigInt(Math.round((1 - share1) * 10_000))) / 10_000n
  const btc = token0InToken1(cap - usdc, a.sqrtPriceX96)
  const end = usdc + usd(e, z, 'cbBTC', btc)
  return { name, start: toUsd(cap), end: toUsd(end), feesUsd: 0, gasUsd: 0, swapFeesUsd: 0, ops: 0, reranges: 0, inRangePct: 0 }
}

function portfolio(name: string, legs: Strategy[]): Result {
  const rs = legs.map((l) => simulate(l))
  const sum = (k: keyof Result) => rs.reduce((x, r) => x + (r[k] as number), 0)
  return { name, start: sum('start'), end: sum('end'), feesUsd: sum('feesUsd'), gasUsd: sum('gasUsd'), swapFeesUsd: sum('swapFeesUsd'), ops: sum('ops'), reranges: sum('reranges'), inRangePct: rs.reduce((x, r, i) => x + r.inRangePct * (legs[i]!.weight ?? 1), 0) }
}

// ── Runs ─────────────────────────────────────────────────────────────────────

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16)
console.log(`dataset ${ds.id.slice(0, 10)}…  ${iso(S[0]!.time)} .. ${iso(S[S.length - 1]!.time)}  ${days.toFixed(1)} days, ${S.length} samples`)
const btc = (s: Sample) => Number(token1InToken0(10n ** 8n, at(CASE_POOL, s)!.sqrtPriceX96)) / 1e6
console.log(`BTC  start ${btc(S[0]!).toFixed(0)}  end ${btc(S[S.length - 1]!).toFixed(0)} USDC`)

const real = simulate({ name: 'real: w1600 (±8%) fixed, never collected', pool: CASE_POOL, width: 'real' })
const realLend = simulate({ name: 'real range + lending while out of range', pool: CASE_POOL, width: 'real', idleLendApr: 4.3 })
console.log(`calibration  sim fees ${Number(real.fees0) / 1e6} USDC + ${Number(real.fees1) / 1e8} cbBTC  |  chain ${Number(REAL.fees0) / 1e6} USDC + ${Number(REAL.fees1) / 1e8} cbBTC`)

const lend = (apr: number): Result => ({ name: `USDC lending ${apr}% APR`, start: toUsd(startUsd()), end: toUsd(startUsd()) * (1 + apr / 100) ** (days / 365), feesUsd: 0, gasUsd: 0, swapFeesUsd: 0, ops: 0, reranges: 0, inRangePct: 0 })
const rows: Result[] = [real, realLend, hold('hold 50/50 at mint', 0.5), hold('hold 100% USDC', 0), hold('hold 100% cbBTC', 1), lend(4.3)]
const WIDTHS = [100, 200, 400, 800, 1600, 3200, 6400, 12_800] as const
for (const w of WIDTHS) rows.push(simulate({ name: `fixed w${w}`, pool: CASE_POOL, width: w }))
rows.push(simulate({ name: 'fixed full range', pool: CASE_POOL, width: 'full' }))
for (const w of WIDTHS) for (const d of [0, 6, 24, 72]) rows.push(simulate({ name: `rerange w${w} after ${d}h`, pool: CASE_POOL, width: w, rerangeAfterH: d, cooldownH: 1 }))
for (const f of [24, 168, 720]) {
  rows.push(simulate({ name: `real width compound /${f}h`, pool: CASE_POOL, width: 1600, fees: { mode: 'compound', everyH: f } }))
  rows.push(simulate({ name: `real width harvest /${f}h`, pool: CASE_POOL, width: 1600, fees: { mode: 'harvest', everyH: f } }))
  rows.push(simulate({ name: `rerange w1600 24h + compound /${f}h`, pool: CASE_POOL, width: 1600, rerangeAfterH: 24, fees: { mode: 'compound', everyH: f } }))
}

// Other pools on their own, then splits of the same capital.
const OTHER: RegistryName[] = ['pool:WETH/USDC/500', 'pool:WETH/USDC/3000', 'pool:USDC/USDT/100', 'pool:EURC/USDC/500', 'pool:USDC/JPYT/3000']
for (const p of OTHER) {
  if (!at(p, S[0]!)) continue
  for (const w of [400, 1600, 6400]) {
    rows.push(simulate({ name: `${p.slice(5)} fixed w${w}`, pool: p, width: w }))
    rows.push(simulate({ name: `${p.slice(5)} rerange w${w} 24h`, pool: p, width: w, rerangeAfterH: 24, cooldownH: 1 }))
  }
}
const leg = (pool: RegistryName, weight: number, width: number, rerangeAfterH?: number): Strategy => ({ name: pool, pool, weight, width, rerangeAfterH, cooldownH: 1 })
rows.push(simulate({ name: 'USDC/USDT/100 fixed w20', pool: 'pool:USDC/USDT/100', width: 20 }), simulate({ name: 'USDC/USDT/100 fixed w40', pool: 'pool:USDC/USDT/100', width: 40 }))
rows.push(portfolio('split 50 stable / 40 btc / 10 eth, fixed', [leg('pool:USDC/USDT/100', 0.5, 20), leg(CASE_POOL, 0.4, 1600), leg('pool:WETH/USDC/500', 0.1, 1600)]))
rows.push(portfolio('split 50 stable / 40 btc / 10 eth, rerange 24h', [leg('pool:USDC/USDT/100', 0.5, 20, 24), leg(CASE_POOL, 0.4, 1600, 24), leg('pool:WETH/USDC/500', 0.1, 1600, 24)]))
rows.push(portfolio('split 50 btc / 50 eth, rerange 24h', [leg(CASE_POOL, 0.5, 1600, 24), leg('pool:WETH/USDC/500', 0.5, 1600, 24)]))
rows.push(portfolio('split btc w400 + w6400, rerange 24h', [leg(CASE_POOL, 0.5, 400, 24), leg(CASE_POOL, 0.5, 6400, 24)]))

const pad = (x: string, n: number) => x.padEnd(n)
const n = (x: number, d = 2) => x.toFixed(d).padStart(9)
console.log(`\n${pad('strategy', 44)}${'start'.padStart(9)}${'end'.padStart(9)}${'pnl'.padStart(9)}${'apr%'.padStart(9)}${'fees'.padStart(9)}${'gas'.padStart(9)}${'swapfee'.padStart(9)}${'ops'.padStart(6)}${'rr'.padStart(5)}${'inR%'.padStart(7)}${'maxDD%'.padStart(8)}`)
for (const r of rows) {
  const pnl = r.end - r.start
  console.log(`${pad(r.name, 44)}${n(r.start)}${n(r.end)}${n(pnl)}${n((100 * pnl * 365) / r.start / days, 1)}${n(r.feesUsd)}${n(r.gasUsd, 3)}${n(r.swapFeesUsd, 3)}${String(r.ops).padStart(6)}${String(r.reranges).padStart(5)}${r.inRangePct.toFixed(0).padStart(7)}${(r.maxDdPct ?? 0).toFixed(1).padStart(8)}`)
}
const json = arg('json')
if (json) {
  writeFileSync(json, JSON.stringify({ dataset: ds.id, from: S[0]!.time, to: S[S.length - 1]!.time, rows }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  console.log(`wrote ${json}`)
}
