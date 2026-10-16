// Case study (mamoru#143): the CDP experiment position, Uniswap v3 USDC/cbBTC 0.05% #4585548 on Base, minted
// 2026-02-07 and never touched until it was closed on 2026-10-16. Replays the real position first, checks the fees
// against what the chain paid, then replays strategy variants over the same price path.
//   bun packages/backtest/cli/case-study.ts --dataset ~/.local/share/mamoru-lab/datasets/base-2026-cdp-case-1h.json
//   bun packages/backtest/cli/case-study.ts --cache <file>.cache.jsonl   (a backfill still running)
// Static ranges never pay gas after the mint. A re-range pays a remove, a swap and a mint; a compound a collect, a swap
// and an increase; a harvest a collect and, with volatile fees, a swap. Gas is `DEFAULT_GAS` at the base fee of its
// sample, priced in USDC through WETH/USDC/500, and leaves the free balances when it is spent. Gas the free balances cannot
// cover is carried as debt; an account worth nothing stops operating.
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
const first = ds.samples.findIndex((s) => s.block >= REAL.mintBlock)
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

type Book = { b0: bigint; b1: bigint; pos: SimPosition | null; gas: bigint; debt: bigint; swapFees: bigint; feesUsd: bigint; ops: number; reranges: number; inRangeH: number }

const MIN_TICK = -887_272
const MAX_TICK = 887_272
/** One Aave supply or withdraw, for the idle-lending variant. */
const LEND_MOVE = 300_000n

/**
 * Swaps the free balances to the ratio of [tl, tu) at the sample price and mints. With a position already on those
 * ticks the liquidity is added to it (increaseLiquidity). Leaves the book idle if the mint is impossible.
 */
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
    if (book.pos && book.pos.tickLower === tl && book.pos.tickUpper === tu) book.pos.liquidity += q.liquidity
    else book.pos = { tokenId: 1n, pool: e.name, tickLower: tl, tickUpper: tu, liquidity: q.liquidity, owed0: 0n, owed1: 0n }
  } catch {
    if (!(book.pos && book.pos.tickLower === tl && book.pos.tickUpper === tu)) book.pos = null
  }
}

function unwind(s: PoolSample, book: Book): void {
  if (!book.pos) return
  const a = amountsOf(s.sqrtPriceX96, book.pos.tickLower, book.pos.tickUpper, book.pos.liquidity)
  book.b0 += a.amount0 + book.pos.owed0
  book.b1 += a.amount1 + book.pos.owed1
  book.pos = null
}

/** Collects the fees into the free balances. */
function collect(book: Book): void {
  if (!book.pos) return
  book.b0 += book.pos.owed0
  book.b1 += book.pos.owed1
  book.pos.owed0 = 0n
  book.pos.owed1 = 0n
}

/**
 * Pays gas out of the free balances, savings asset first, together with any debt left from before. What they cannot
 * cover is carried as debt, paid at the next operation and counted against the account value.
 */
function payGas(e: RegistryEntry, s: PoolSample, sample: Sample, book: Book, units: bigint): void {
  const fresh = gasUsd(sample, units)
  book.gas += fresh
  let cost = fresh + book.debt
  book.debt = 0n
  const savIs0 = e.token0 === SAV
  const sav = savIs0 ? book.b0 : book.b1
  const fromSav = sav < cost ? sav : cost
  if (savIs0) book.b0 -= fromSav
  else book.b1 -= fromSav
  cost -= fromSav
  if (cost > 0n) {
    const vol = savIs0 ? book.b1 : book.b0
    const volValue = usd(e, s, savIs0 ? e.token1! : e.token0!, vol)
    const take = volValue <= cost ? vol : (vol * cost) / (volValue === 0n ? 1n : volValue)
    if (savIs0) book.b1 -= take
    else book.b0 -= take
    cost -= volValue <= cost ? volValue : cost
  }
  book.debt += cost
}

function bookValue(e: RegistryEntry, s: PoolSample, book: Book): bigint {
  let v = usd(e, s, e.token0!, book.b0) + usd(e, s, e.token1!, book.b1) - book.debt
  if (book.pos) {
    const x = amountsOf(s.sqrtPriceX96, book.pos.tickLower, book.pos.tickUpper, book.pos.liquidity)
    v += usd(e, s, e.token0!, x.amount0 + book.pos.owed0) + usd(e, s, e.token1!, x.amount1 + book.pos.owed1)
  }
  return v
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

class Drawdown {
  peak: number
  max = 0
  constructor(start: number) {
    this.peak = start
  }
  see(v: number): void {
    this.peak = Math.max(this.peak, v)
    this.max = Math.max(this.max, this.peak > 0 ? (100 * (this.peak - v)) / this.peak : 0)
  }
}

export function simulate(st: Strategy, capital = startUsd()): Result {
  const e = entry(st.pool)
  const s0 = at(st.pool, S[0]!)
  if (!s0) throw new Error(`${st.pool} has no first sample`)
  const book: Book = { b0: 0n, b1: 0n, pos: null, gas: 0n, debt: 0n, swapFees: 0n, feesUsd: 0n, ops: 0, reranges: 0, inRangeH: 0 }
  const cap = (capital * BigInt(Math.round((st.weight ?? 1) * 10_000))) / 10_000n
  let f0 = 0n
  let f1 = 0n
  if (st.width === 'real') {
    book.pos = { tokenId: 1n, pool: st.pool, tickLower: REAL.tickLower, tickUpper: REAL.tickUpper, liquidity: REAL.liquidity, owed0: 0n, owed1: 0n }
  } else {
    if (e.token0 === SAV) book.b0 = cap
    else book.b1 = cap
    payGas(e, s0, S[0]!, book, DEFAULT_GAS.unitsByKind.enter_swap + DEFAULT_GAS.unitsByKind.enter_mint)
    const [tl, tu] = rangeFor(e, s0.tick, st.width)
    mint(e, s0, book, tl, tu)
    book.ops++
  }
  const dd = new Drawdown(toUsd(st.width === 'real' ? capital : cap))
  let lent = 0
  let lending = false
  let outSince: number | null = null
  let lastRerange = -Infinity
  let lastFees = S[0]!.time
  for (let i = 1; i < S.length; i++) {
    const a = at(st.pool, S[i - 1]!)
    const b = at(st.pool, S[i]!)
    if (!a || !b) continue
    const t = S[i]!.time
    const dt = t - S[i - 1]!.time
    if (book.pos) {
      const got = accrue(book.pos, a, b)
      f0 += got.fees0
      f1 += got.fees1
      book.feesUsd += usd(e, b, e.token0!, got.fees0) + usd(e, b, e.token1!, got.fees1)
      if (inRange(b.tick, book.pos)) book.inRangeH += dt / H
    }
    const out = !book.pos || !inRange(b.tick, book.pos)
    if (st.idleLendApr && book.pos) {
      // Only the savings side can be lent at the USDC rate; a position below its range is all volatile token.
      const x = amountsOf(b.sqrtPriceX96, book.pos.tickLower, book.pos.tickUpper, book.pos.liquidity)
      const savSide = e.token0 === SAV ? x.amount0 : x.amount1
      const lend = out && savSide > 0n
      if (lend !== lending) payGas(e, b, S[i]!, book, LEND_MOVE)
      lending = lend
      if (lend) lent += (Number(savSide) * st.idleLendApr * dt) / (100 * 365 * 86_400)
    }
    // The exit happened somewhere inside the last interval: count from its middle.
    outSince = out ? (outSince ?? t - dt / 2) : null
    if (bookValue(e, b, book) > 0n && st.width !== 'real' && st.rerangeAfterH !== undefined && out && outSince !== null && t - outSince >= st.rerangeAfterH * H && t - lastRerange >= (st.cooldownH ?? 0) * H) {
      unwind(b, book)
      payGas(e, b, S[i]!, book, REBUILD)
      const [tl, tu] = rangeFor(e, b.tick, st.width as number | 'full')
      mint(e, b, book, tl, tu)
      book.ops++
      book.reranges++
      lastRerange = t
      outSince = null
      lastFees = t
    } else if (bookValue(e, b, book) > 0n && st.fees && book.pos && t - lastFees >= st.fees.everyH * H && book.pos.owed0 + book.pos.owed1 > 0n) {
      if (st.fees.mode === 'compound' && out) {
        // Out of range an increase is one-sided on the wrong token; fold the fees in once back in range.
      } else if (st.fees.mode === 'compound') {
        lastFees = t
        collect(book)
        payGas(e, b, S[i]!, book, DEFAULT_GAS.unitsByKind.harvest + DEFAULT_GAS.unitsByKind.enter_swap + DEFAULT_GAS.unitsByKind.enter_mint)
        mint(e, b, book, book.pos.tickLower, book.pos.tickUpper)
        book.ops++
      } else {
        lastFees = t
        const savIs0 = e.token0 === SAV
        const owedVol = savIs0 ? book.pos.owed1 : book.pos.owed0
        collect(book)
        if (owedVol > 0n) {
          const tin = savIs0 ? e.token1! : e.token0!
          book.swapFees += usd(e, b, tin, (owedVol * BigInt(e.fee ?? 0)) / 1_000_000n)
          if (savIs0) {
            book.b1 -= owedVol
            book.b0 += swapOut(e, b, tin, owedVol)
          } else {
            book.b0 -= owedVol
            book.b1 += swapOut(e, b, tin, owedVol)
          }
        }
        payGas(e, b, S[i]!, book, DEFAULT_GAS.unitsByKind.harvest + (owedVol > 0n ? DEFAULT_GAS.unitsByKind.enter_swap : 0n))
        book.ops++
      }
    }
    dd.see(toUsd(bookValue(e, b, book)) + lent / 1e6)
  }
  const last = at(st.pool, S[S.length - 1]!)!
  // Still lent at the end: the withdraw is paid too.
  if (lending) payGas(e, last, S[S.length - 1]!, book, LEND_MOVE)
  const end = bookValue(e, last, book) + BigInt(Math.round(lent))
  const hours = (S[S.length - 1]!.time - S[0]!.time) / H
  return { name: st.name, start: toUsd(st.width === 'real' ? capital : cap), end: toUsd(end), feesUsd: toUsd(book.feesUsd), gasUsd: toUsd(book.gas), swapFeesUsd: toUsd(book.swapFees), ops: book.ops, reranges: book.reranges, inRangePct: (100 * book.inRangeH) / hours, maxDdPct: dd.max, fees0: f0, fees1: f1 }
}

function hold(name: string, share1: number): Result {
  const e = entry(CASE_POOL)
  const a = at(CASE_POOL, S[0]!)!
  const cap = startUsd()
  const usdc = (cap * BigInt(Math.round((1 - share1) * 10_000))) / 10_000n
  const btc = token0InToken1(cap - usdc, a.sqrtPriceX96)
  const dd = new Drawdown(toUsd(cap))
  let end = cap
  for (const s of S) {
    end = usdc + usd(e, at(CASE_POOL, s)!, 'cbBTC', btc)
    dd.see(toUsd(end))
  }
  return { name, start: toUsd(cap), end: toUsd(end), maxDdPct: dd.max, feesUsd: 0, gasUsd: 0, swapFeesUsd: 0, ops: 0, reranges: 0, inRangePct: 0 }
}

/** Legs run on their own and are summed at the end; no combined drawdown. */
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

const lend = (apr: number): Result => ({ name: `USDC lending ${apr}% APR`, start: toUsd(startUsd()), end: toUsd(startUsd()) * (1 + apr / 100) ** (days / 365), feesUsd: 0, gasUsd: 0, swapFeesUsd: 0, ops: 0, reranges: 0, inRangePct: 0, maxDdPct: 0 })
const rows: Result[] = [real, realLend, hold('hold 50/50 at mint', 0.5), hold('hold 100% USDC', 0), hold('hold 100% cbBTC', 1), lend(4.3)]
const WIDTHS = [100, 200, 400, 800, 1600, 3200, 6400, 12_800] as const
for (const w of WIDTHS) rows.push(simulate({ name: `fixed w${w}`, pool: CASE_POOL, width: w }))
rows.push(simulate({ name: 'fixed full range', pool: CASE_POOL, width: 'full' }))
for (const w of WIDTHS) for (const d of [0, 6, 24, 72]) rows.push(simulate({ name: `rerange w${w} after ${d}h`, pool: CASE_POOL, width: w, rerangeAfterH: d, cooldownH: 1 }))
for (const f of [24, 168, 720]) {
  rows.push(simulate({ name: `real + compound /${f}h`, pool: CASE_POOL, width: 'real', fees: { mode: 'compound', everyH: f } }))
  rows.push(simulate({ name: `real + harvest /${f}h`, pool: CASE_POOL, width: 'real', fees: { mode: 'harvest', everyH: f } }))
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
  console.log(`${pad(r.name, 44)}${n(r.start)}${n(r.end)}${n(pnl)}${n((100 * pnl * 365) / r.start / days, 1)}${n(r.feesUsd)}${n(r.gasUsd, 3)}${n(r.swapFeesUsd, 3)}${String(r.ops).padStart(6)}${String(r.reranges).padStart(5)}${r.inRangePct.toFixed(0).padStart(7)}${(r.maxDdPct === undefined ? '–' : r.maxDdPct.toFixed(1)).padStart(8)}`)
}
const json = arg('json')
if (json) {
  writeFileSync(json, JSON.stringify({ dataset: ds.id, from: S[0]!.time, to: S[S.length - 1]!.time, rows }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  console.log(`wrote ${json}`)
}
