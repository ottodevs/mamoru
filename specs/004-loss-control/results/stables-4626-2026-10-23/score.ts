// Lab #186 scorer: the Conservador stables bucket as today (USDC/USDT 0.01% LP, from the sweep) against supplying the
// same USDC to an ERC-4626 vault, on the Lab windows, net of gas, against holding USDC.
//   bun score.ts [--sweep lp.sweep.json] [--data ../raw/stables-4626-data.json] [--json out.json]
// Prints markdown: shortlist, per-window cells, totals per split, the whole mix at 1,000, break-even, APY-model check.
// The vault arm: deposit at the window's first sample, redeem at its last. Growth is the observed share-price ratio
// (Morpho API) where the vault has one, else the daily DefiLlama base rate, each reading applied forward, in the
// source's convention (MetaMorpho: effective APY net of fee; Aave reserve: liquidityRate, an APR). A window before
// the vault contract existed, or one its series does not cover (gap > 2 days), is unavailable. Each operation is
// priced with the simulator's gas formula on that sample's base fee and ETH price (`opGasRaw`).
// Terminal convention (review of #186, finding 3): every arm ends in USDC. The LP pays its exit (a reduce and a swap
// of the USDT half back: gas at the last sample + 1 bp on that half), as every vault pays its redeem.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeDataset, type DatasetJson } from '../../../../packages/backtest/src/dataset.ts'
import { DEFAULT_GAS } from '../../../../packages/backtest/src/run.ts'
import { breakEvenDays, breakEvenDeposit, effectiveApyPct, opGasRaw, vaultGrowth, vaultRun, type PricePoint, type RateConvention, type RatePoint, type VaultGas } from '../../../../packages/backtest/src/vault4626.ts'
import { datasetsDir, LAB_WINDOWS, windowBlocks } from '../../../../packages/backtest/src/windows.ts'

const argv = process.argv.slice(2)
const opt = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1]! : d)
const here = import.meta.dir
const sweep = JSON.parse(readFileSync(opt('sweep', join(here, 'lp.sweep.json')), 'utf8')) as { cells: Cell[] }
const data = JSON.parse(readFileSync(opt('data', join(here, '..', 'raw', 'stables-4626-data.json')), 'utf8')) as Data

type Cell = { window: string; split: string; regime: string; variant: string; deposit: number; status: string; metrics?: { returnPct: number; vsHoldPct: number; end: number; hold: number; ops: number; gas: number; fees: number } }
type VaultData = { id: string; name: string; address: string; created: number; convention: RateConvention; llamaIs: 'vault' | 'reserve'; apy: [number, number | null, number | null][]; morpho: null | { created: number; now: Record<string, unknown>; sharePrice: [number, number][]; totalAssetsUsdM: [number, number][] } }
type Data = { fetchedAt: string; vaults: VaultData[]; markets: { id: string; created: number; badDebtUsd: number | null; realizedBadDebtUsd: number | null; now: Record<string, number>; utilization: [number, number][] }[]; aaveUsdcNow: Record<string, number> }

/**
 * Gas units per operation, each one userOp of the account: the median direct receipt on Basescan (5 deposits and
 * 5 redeems per Morpho vault, 3 redeem/withdraw for waBasUSDC, read 23 Oct 2026; Aave deposit taken equal to its
 * redeem) + 350k for the account's userOp (the live median swap receipt, 470k, less ~120k for the swap itself) + 30k
 * for the approve batched with the deposit.
 */
export const GAS_UNITS: Record<string, VaultGas> = {
  gtUSDCp: { deposit: 417_384n + 350_000n + 30_000n, redeem: 433_349n + 350_000n },
  sparkUSDC: { deposit: 237_852n + 350_000n + 30_000n, redeem: 250_980n + 350_000n },
  steakUSDC: { deposit: 417_384n + 350_000n + 30_000n, redeem: 433_349n + 350_000n },
  waBasUSDC: { deposit: 246_825n + 350_000n + 30_000n, redeem: 246_825n + 350_000n },
}
/** Live relayer cost per op the ticket reports (0.00092 ETH over ~30 ops, 14-19 Oct 2026). */
const LIVE_OP_USD = 0.07
const LAB_VAULTS = ['gtUSDCp', 'sparkUSDC', 'waBasUSDC'] as const
/** A vault this small at the window's start was not seasoned: its rate is still what a depositor got, so it counts, marked with *. */
const MIN_TVL_M = 10
const DEPOSITS = [50, 1000] as const
const DAY = 86_400

const vault = (id: string) => data.vaults.find((v) => v.id === id)!
const rates = (id: string): RatePoint[] => vault(id).apy.map(([time, ratePct]) => ({ time, ratePct }))
const prices = (id: string): PricePoint[] => (vault(id).morpho?.sharePrice ?? []).map(([time, price]) => ({ time, price }))
/** The vault's own assets (Morpho); null for the Aave wrapper, whose own assets no free series has (the reserve's is not it). */
const tvlAt = (id: string, t: number): number | null => {
  const pts = vault(id).morpho?.totalAssetsUsdM
  if (!pts) return null
  const before = pts.filter(([x]) => x <= t)
  return before.length ? before.at(-1)![1] : null
}
/** Mean base rate over the last `days` (null readings skipped), in the source's convention. */
const meanRate = (id: string, days: number, end: number) => {
  const pts = vault(id).apy.filter(([t, y]) => t > end - days * DAY && t <= end && y !== null).map(([, y]) => y!)
  return pts.reduce((a, y) => a + y, 0) / pts.length
}
const meanApy = (id: string, days: number, end: number) => effectiveApyPct(meanRate(id, days, end), vault(id).convention)
const lp = (w: string, variant: string, deposit: number) => sweep.cells.find((c) => c.window === w && c.variant === variant && c.deposit === deposit && c.status === 'ok')?.metrics
const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '–' : x.toFixed(d))
const sgn = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`)
const usdc = (raw: bigint) => Number(raw) / 1e6
const avail = (s: string) => s === 'ok' || s === 'young'

type WRow = {
  window: string
  split: string
  regime: string
  days: number
  from: number
  to: number
  gasPerOp: number
  /** LP exit the sweep does not charge: a reduce and a swap of the USDT half back, gas + 1 bp on that half. */
  lpExit: Record<number, number>
  /** `net`: in USDC at the end, exit paid; `beforeExit`: as the sweep reports it. */
  lp: Record<number, { net: number; beforeExit: number; vsHold: number; ops: number; gas: number; fees: number } | null>
  vault: Record<string, { status: 'ok' | 'young' | 'predates' | 'gap'; source: 'price' | 'rates' | null; tvlM: number | null; growth: number | null; model: number | null; gasIn: number; gasOut: number; byDeposit: Record<number, ReturnType<typeof vaultRun>> }>
  mix: { live: number | null; additive: number | null; byVault: Record<string, number | null> }
}

const rows: WRow[] = []
for (const w of LAB_WINDOWS) {
  const ds = decodeDataset(JSON.parse(readFileSync(join(datasetsDir(), w.file), 'utf8')) as DatasetJson)
  const { fromBlock, toBlock } = windowBlocks(w)
  const first = ds.samples.find((s) => s.block >= fromBlock)!
  const last = ds.samples.findLast((s) => s.block <= toBlock)!
  const op = (units: bigint) => usdc(opGasRaw(ds, last, units))
  const row: WRow = {
    window: w.id,
    split: w.split,
    regime: w.regime,
    days: (last.time - first.time) / DAY,
    from: first.time,
    to: last.time,
    gasPerOp: usdc(opGasRaw(ds, first, DEFAULT_GAS.unitsByKind.harvest)),
    lpExit: Object.fromEntries([50, 500, 1000].map((d) => [d, op(DEFAULT_GAS.unitsByKind.reduce) + op(DEFAULT_GAS.unitsByKind.enter_swap) + d * 0.5 * 0.0001])),
    lp: {},
    vault: {},
    mix: { live: null, additive: null, byVault: {} },
  }
  for (const d of [50, 500, 1000]) {
    const m = lp(w.id, 'stables-only', d)
    row.lp[d] = m ? { net: m.end - d - row.lpExit[d]!, beforeExit: m.end - d, vsHold: m.end - m.hold, ops: m.ops, gas: m.gas, fees: m.fees } : null
  }
  for (const id of [...LAB_VAULTS, 'steakUSDC']) {
    const units = GAS_UNITS[id]!
    const gasIn = usdc(opGasRaw(ds, first, units.deposit))
    const gasOut = usdc(opGasRaw(ds, last, units.redeem))
    const v = vault(id)
    const g = vaultGrowth({ created: v.created, rates: rates(id), convention: v.convention, ...(v.morpho ? { prices: prices(id) } : {}) }, first.time, last.time)
    const tvlM = tvlAt(id, first.time)
    const status = g.status !== 'ok' ? g.status : tvlM !== null && tvlM < MIN_TVL_M ? 'young' : 'ok'
    const byDeposit = Object.fromEntries([50, 500, 1000].map((d) => [d, vaultRun(d, g.growth ?? 1, gasIn, gasOut)]))
    row.vault[id] = { status, source: g.source, tvlM, growth: g.growth, model: g.model, gasIn, gasOut, byDeposit }
  }
  const live = lp(w.id, 'live-mix', 1000)
  const vol = lp(w.id, 'volatile-only', 500)
  const st = lp(w.id, 'stables-only', 500)
  // The stables leg ends in USDC in every arm: the LP legs pay the exit of a 500 USDC stables position (for the live
  // mix, whose stables bucket is near 500, an approximation). The volatile half is left as it is in every arm.
  row.mix.live = live ? live.end - 1000 - row.lpExit[500]! : null
  row.mix.additive = vol && st ? vol.end - 500 + (st.end - 500) - row.lpExit[500]! : null
  for (const id of LAB_VAULTS) row.mix.byVault[id] = vol && avail(row.vault[id]!.status) ? vol.end - 500 + row.vault[id]!.byDeposit[500]!.net : null
  rows.push(row)
  console.error(`${w.id} done`)
}

const out: string[] = []
const p = (s = '') => out.push(s)

// Shortlist
const now = Math.floor(Date.parse(data.fetchedAt) / 1000)
p(`## Shortlist (data fetched ${data.fetchedAt.slice(0, 16)}Z)`)
p()
p('| Vault | Address | Kind | Vault created | TVL now, M USD | Withdrawable now, M USD | Base rate 30 d / 90 d, % (convention) | 90 d min / max | Fee | Timelock |')
p('|---|---|---|---|---|---|---|---|---|---|')
for (const v of data.vaults) {
  const pts90 = v.apy.filter(([t, y]) => t > now - 90 * DAY && y !== null).map(([, y]) => y!)
  const m = v.morpho
  const created = new Date(v.created * 1000).toISOString().slice(0, 10)
  const tvl = m ? f(m.now.totalAssetsUsdM as number, 1) : `${f(data.aaveUsdcNow.supplyUsdM, 1)} (reserve supply)`
  const liq = m ? f(m.now.liquidityUsdM as number, 1) : `${f(data.aaveUsdcNow.liquidityUsdM, 1)} (reserve available)`
  p(`| ${v.id} | \`${v.address}\` | ${m ? 'native 4626 (MetaMorpho)' : 'wrapper (static aToken)'} | ${created} | ${tvl} | ${liq} | ${f(meanRate(v.id, 30, now))} / ${f(meanRate(v.id, 90, now))} (${v.convention}${v.llamaIs === 'reserve' ? ', reserve' : ''}) | ${f(Math.min(...pts90))} / ${f(Math.max(...pts90))} | ${m ? `${Number(m.now.fee) * 100}%` : '0'} | ${m ? `${Number(m.now.timelockSeconds) / DAY} d` : 'gov.'} |`)
}
p()
p('Morpho markets behind the MetaMorpho vaults (daily utilization since the market was created):')
p()
p('| Market | Created | Utilization now | Days ≥ 95% | Days ≥ 99% | Dates ≥ 99% | Bad debt (unrealized / realized), USD |')
p('|---|---|---|---|---|---|---|')
for (const m of data.markets) {
  const hi = m.utilization.filter(([, u]) => u >= 0.99).map(([t]) => new Date(t * 1000).toISOString().slice(0, 10))
  p(`| ${m.id} | ${new Date(m.created * 1000).toISOString().slice(0, 10)} | ${f(m.now.utilization! * 100, 1)}% | ${m.utilization.filter(([, u]) => u >= 0.95).length} | ${hi.length} | ${hi.slice(0, 6).join(', ')}${hi.length > 6 ? ', …' : ''} | ${f(m.badDebtUsd, 0)} / ${f(m.realizedBadDebtUsd, 0)} |`)
}
const aaveLiq = vault('waBasUSDC').apy.filter(([t, , l]) => t > now - 365 * DAY && l !== null).map(([, , l]) => l!)
const aaveThin = vault('waBasUSDC').apy.filter(([t, , l]) => t > now - 730 * DAY && l !== null && l < 5).map(([t, , l]) => `${new Date(t * 1000).toISOString().slice(0, 10)} (${f(l, 2)}M)`)
p()
p(`Aave v3 Base USDC **reserve** (under the waBasUSDC wrapper; reserve figures, not the wrapper's) now: supply ${f(data.aaveUsdcNow.supplyUsdM, 1)}M, utilization ${f(data.aaveUsdcNow.utilization! * 100, 1)}%, available ${f(data.aaveUsdcNow.liquidityUsdM, 1)}M; available liquidity over the last 365 d (DefiLlama TVL = supply − borrow): min ${f(Math.min(...aaveLiq), 2)}M, median ${f(aaveLiq.sort((a, b) => a - b)[Math.floor(aaveLiq.length / 2)], 1)}M. Days under 5M in the last 2 years: ${aaveThin.join(', ') || 'none'}.`)
p()

// Gas
p('## Gas per operation (simulator formula, window means, USDC)')
p()
p('| Window | Split | Days | collect-like op (650k) | gtUSDCp in + out | sparkUSDC in + out | waBasUSDC in + out | LP exit at 1,000 (charged below) |')
p('|---|---|---|---|---|---|---|---|')
for (const r of rows) p(`| ${r.window} | ${r.split} | ${f(r.days, 1)} | ${f(r.gasPerOp, 4)} | ${f(r.vault.gtUSDCp!.gasIn + r.vault.gtUSDCp!.gasOut, 4)} | ${f(r.vault.sparkUSDC!.gasIn + r.vault.sparkUSDC!.gasOut, 4)} | ${f(r.vault.waBasUSDC!.gasIn + r.vault.waBasUSDC!.gasOut, 4)} | ${f(r.lpExit[1000], 4)} |`)
p()

// Per window
for (const d of DEPOSITS) {
  p(`## Stables bucket at ${d.toLocaleString('en-US')} USDC, per window (net USDC vs holding USDC; every arm ends in USDC: LP exit and vault redeem paid)`)
  p()
  p('| Window | Split | Regime | Days | LP net | LP before exit | LP vs hold 50/50 | LP ops | LP gas | gtUSDCp | sparkUSDC | waBasUSDC | best vault − LP |')
  p('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const l = r.lp[d]
    const vs = LAB_VAULTS.map((id) => {
      const v = r.vault[id]!
      const m = v.source === 'rates' ? '†' : ''
      return v.status === 'predates' ? 'n/a (predates)' : v.status === 'gap' ? 'n/a (data gap)' : v.status === 'young' ? `${sgn(v.byDeposit[d]!.net, 3)}*${m}` : `${sgn(v.byDeposit[d]!.net, 3)}${m}`
    })
    const ok = LAB_VAULTS.filter((id) => avail(r.vault[id]!.status)).map((id) => r.vault[id]!.byDeposit[d]!.net)
    p(`| ${r.window} | ${r.split} | ${r.regime} | ${f(r.days, 1)} | ${l ? sgn(l.net, 3) : 'skipped (no cbBTC yet)'} | ${l ? sgn(l.beforeExit, 3) : '–'} | ${l ? sgn(l.vsHold, 3) : '–'} | ${l?.ops ?? '–'} | ${l ? f(l.gas, 3) : '–'} | ${vs.join(' | ')} | ${l && ok.length ? sgn(Math.max(...ok) - l.net, 3) : '–'} |`)
  }
  p()
  p(`* the vault held under ${MIN_TVL_M}M USD at the window's start (not seasoned then). † growth from the rate model (no share-price series); otherwise the observed share price.`)
  p()
}

// Totals per split, on the windows every arm has
p('## Totals per split (sum over the windows where the LP and every listed vault ran; net USDC, every arm ends in USDC)')
p()
p('| Split | Deposit | Windows | Days | LP net | LP before exit | gtUSDCp | sparkUSDC | waBasUSDC | gtUSDCp / sparkUSDC by APY model | LP ann. % | gtUSDCp ann. % | sparkUSDC ann. % | waBasUSDC ann. % |')
p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
const totals: Record<string, unknown> = {}
for (const split of ['train', 'test', 'all']) {
  for (const d of DEPOSITS) {
    const ws = rows.filter((r) => (split === 'all' || r.split === split) && r.lp[d] && LAB_VAULTS.every((id) => avail(r.vault[id]!.status)))
    const days = ws.reduce((a, r) => a + r.days, 0)
    const lpNet = ws.reduce((a, r) => a + r.lp[d]!.net, 0)
    const lpBefore = ws.reduce((a, r) => a + r.lp[d]!.beforeExit, 0)
    const v = Object.fromEntries(LAB_VAULTS.map((id) => [id, ws.reduce((a, r) => a + r.vault[id]!.byDeposit[d]!.net, 0)]))
    const byModel = (id: string) => ws.reduce((a, r) => { const x = r.vault[id]!; return a + d * (x.model ?? Number.NaN) - d - x.gasIn - x.gasOut }, 0)
    const ann = (x: number) => (x / d / days) * 365 * 100
    const wins = LAB_VAULTS.map((id) => ws.filter((r) => r.vault[id]!.byDeposit[d]!.net > r.lp[d]!.net).length)
    totals[`${split}-${d}`] = { windows: ws.map((r) => r.window), days, lpNet, lpBefore, ...v, gtUSDCpByModel: byModel('gtUSDCp'), sparkUSDCByModel: byModel('sparkUSDC'), vaultWins: Object.fromEntries(LAB_VAULTS.map((id, k) => [id, wins[k]])) }
    p(`| ${split} | ${d} | ${ws.length} | ${f(days, 0)} | ${sgn(lpNet)} | ${sgn(lpBefore)} | ${LAB_VAULTS.map((id, k) => `${sgn(v[id]!)} (${wins[k]}/${ws.length})`).join(' | ')} | ${sgn(byModel('gtUSDCp'))} / ${sgn(byModel('sparkUSDC'))} | ${f(ann(lpNet))} | ${LAB_VAULTS.map((id) => f(ann(v[id]!))).join(' | ')} |`)
  }
}
p()
p('(n/m): windows where the vault ended above the LP. Windows left out above: a vault predates them or its data has a gap, or the LP did not run (aug2024):')
p()
p('| Window | Deposit | LP net | gtUSDCp | waBasUSDC |')
p('|---|---|---|---|---|')
const cellOf = (r: WRow, id: string, d: number) => (avail(r.vault[id]!.status) ? `${r.vault[id]!.status} ${sgn(r.vault[id]!.byDeposit[d]!.net, 3)}` : r.vault[id]!.status)
for (const r of rows.filter((r) => !r.lp[1000] || !LAB_VAULTS.every((id) => avail(r.vault[id]!.status))))
  for (const d of DEPOSITS) p(`| ${r.window} | ${d} | ${r.lp[d] ? sgn(r.lp[d]!.net, 3) : '–'} | ${cellOf(r, 'gtUSDCp', d)} | ${cellOf(r, 'waBasUSDC', d)} |`)
p()

// Whole mix
p('## Whole Conservador mix at 1,000 USDC (net USDC vs the deposit)')
p()
p('Live mix: `conservador-live-v2` as it runs. Additive: volatile buckets alone at 500 (cbBTC 80 / WETH 20 of them) + stables bucket alone at 500; its gap to the live mix is the error of splitting the mix. Vault mixes: the same volatile run + 500 in the vault. The stables leg ends in USDC in every arm (LP legs pay the exit of a 500 USDC stables position; the vault its redeem); the volatile half is left open in every arm.')
p()
p('| Window | Split | Live mix | Additive (LP) | Additive − live | + gtUSDCp | + sparkUSDC | + waBasUSDC | best vault mix − additive |')
p('|---|---|---|---|---|---|---|---|---|')
const mixTot: Record<string, Record<string, number>> = {}
for (const r of rows) {
  if (r.mix.live === null) continue
  const vs = LAB_VAULTS.map((id) => r.mix.byVault[id] ?? null)
  const okv = vs.filter((x): x is number => x !== null)
  p(`| ${r.window} | ${r.split} | ${sgn(r.mix.live)} | ${sgn(r.mix.additive)} | ${sgn(r.mix.additive! - r.mix.live)} | ${vs.map((x) => (x === null ? 'n/a' : sgn(x))).join(' | ')} | ${okv.length ? sgn(Math.max(...okv) - r.mix.additive!) : '–'} |`)
  if (vs.every((x) => x !== null))
    for (const s of [r.split, 'all']) {
      const t = (mixTot[s] ??= { n: 0, live: 0, additive: 0, gtUSDCp: 0, sparkUSDC: 0, waBasUSDC: 0 })
      t.n! += 1
      t.live! += r.mix.live
      t.additive! += r.mix.additive!
      LAB_VAULTS.forEach((id, k) => (t[id]! += vs[k]!))
    }
}
p()
p('| Split | Windows | Live mix | Additive (LP) | + gtUSDCp | + sparkUSDC | + waBasUSDC |')
p('|---|---|---|---|---|---|---|')
for (const [s, t] of Object.entries(mixTot)) p(`| ${s} | ${t.n} | ${sgn(t.live)} | ${sgn(t.additive)} | ${sgn(t.gtUSDCp)} | ${sgn(t.sparkUSDC)} | ${sgn(t.waBasUSDC)} |`)
p()

// Break-even
const meanGas = (id: string) => rows.reduce((a, r) => a + r.vault[id]!.gasIn + r.vault[id]!.gasOut, 0) / rows.length
const maxGas = (id: string) => Math.max(...rows.map((r) => r.vault[id]!.gasIn + r.vault[id]!.gasOut))
p('## Break-even (90-day mean base rate now, as effective APY)')
p()
p('| Vault | APY 90 d % | in + out gas, Lab mean / Lab max / live 2 × 0.07 $ | Days to pay gas at 50 USDC (mean / max / live) | at 1,000 | Smallest deposit that pays the gas in 7 d (mean / live) | in 30 d (mean / live) |')
p('|---|---|---|---|---|---|---|')
for (const id of LAB_VAULTS) {
  const apy = meanApy(id, 90, now)
  const g = [meanGas(id), maxGas(id), 2 * LIVE_OP_USD]
  p(`| ${id} | ${f(apy)} | ${g.map((x) => f(x, 3)).join(' / ')} | ${g.map((x) => f(breakEvenDays(50, apy, x), 1)).join(' / ')} | ${g.map((x) => f(breakEvenDays(1000, apy, x), 2)).join(' / ')} | ${f(breakEvenDeposit(7, apy, g[0]!), 1)} / ${f(breakEvenDeposit(7, apy, g[2]!), 1)} | ${f(breakEvenDeposit(30, apy, g[0]!), 1)} / ${f(breakEvenDeposit(30, apy, g[2]!), 1)} |`)
}
p()

// APY model check
p('## Observed share price (scored) vs the DefiLlama APY model (growth over each window, bps)')
p()
p('| Window | gtUSDCp share price | gtUSDCp model | model − price | sparkUSDC share price | sparkUSDC model | model − price | waBasUSDC model (APR, reserve rate) |')
p('|---|---|---|---|---|---|---|---|')
const bps = (g: number | null) => (g === null ? '–' : f((g - 1) * 1e4, 2))
const diff = (a: number | null, b: number | null) => (a === null || b === null ? '–' : sgn((a - b) * 1e4, 2))
for (const r of rows) {
  const [g, s, a] = [r.vault.gtUSDCp!, r.vault.sparkUSDC!, r.vault.waBasUSDC!]
  p(`| ${r.window} | ${bps(g.growth)} | ${bps(g.model)} | ${diff(g.model, g.growth)} | ${bps(s.growth)} | ${bps(s.model)} | ${diff(s.model, s.growth)} | ${a.status === 'predates' ? 'predates' : bps(a.model)} |`)
}
p()

console.log(out.join('\n'))
if (argv.includes('--json')) writeFileSync(opt('json', ''), `${JSON.stringify({ fetchedAt: data.fetchedAt, gasUnits: Object.fromEntries(Object.entries(GAS_UNITS).map(([k, v]) => [k, { deposit: Number(v.deposit), redeem: Number(v.redeem) }])), rows, totals, mix: mixTot }, null, 1)}\n`)
