// Lab #186 scorer: the Conservador stables bucket as today (USDC/USDT 0.01% LP, from the sweep) against supplying the
// same USDC to an ERC-4626 vault, on the Lab windows, net of gas, against holding USDC.
//   bun score.ts [--sweep lp.sweep.json] [--data ../raw/stables-4626-data.json] [--json out.json]
// Prints markdown: shortlist, per-window cells, totals per split, the whole mix at 1,000, break-even, APY-model check.
// The vault arm: deposit at the window's first sample, redeem at its last; the share price grows by the vault's daily
// DefiLlama base APY (net of the vault fee), checked against the Morpho share price; each operation is priced with the
// simulator's gas formula on that sample's base fee and ETH price (`opGasRaw`).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeDataset, type DatasetJson } from '../../../../packages/backtest/src/dataset.ts'
import { DEFAULT_GAS } from '../../../../packages/backtest/src/run.ts'
import { breakEvenDays, breakEvenDeposit, growthFromApy, growthFromPrice, opGasRaw, vaultRun, type PricePoint, type RatePoint, type VaultGas } from '../../../../packages/backtest/src/vault4626.ts'
import { datasetsDir, LAB_WINDOWS, windowBlocks } from '../../../../packages/backtest/src/windows.ts'

const argv = process.argv.slice(2)
const opt = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1]! : d)
const here = import.meta.dir
const sweep = JSON.parse(readFileSync(opt('sweep', join(here, 'lp.sweep.json')), 'utf8')) as { cells: Cell[] }
const data = JSON.parse(readFileSync(opt('data', join(here, '..', 'raw', 'stables-4626-data.json')), 'utf8')) as Data

type Cell = { window: string; split: string; regime: string; variant: string; deposit: number; status: string; metrics?: { returnPct: number; vsHoldPct: number; end: number; hold: number; ops: number; gas: number; fees: number } }
type VaultData = { id: string; name: string; address: string; apy: [number, number, number][]; morpho: null | { created: number; now: Record<string, unknown>; sharePrice: [number, number][]; totalAssetsUsdM: [number, number][] } }
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
const rates = (id: string): RatePoint[] => vault(id).apy.map(([time, apyPct]) => ({ time, apyPct }))
const prices = (id: string): PricePoint[] => (vault(id).morpho?.sharePrice ?? []).map(([time, price]) => ({ time, price }))
const tvlAt = (id: string, t: number): number | null => {
  const pts = vault(id).morpho?.totalAssetsUsdM ?? vault(id).apy.map(([x, , tvl]) => [x, tvl] as [number, number])
  const before = pts.filter(([x]) => x <= t)
  return before.length ? before.at(-1)![1] : null
}
const meanApy = (id: string, days: number, end: number) => {
  const pts = vault(id).apy.filter(([t]) => t > end - days * DAY && t <= end)
  return pts.reduce((a, [, y]) => a + y, 0) / pts.length
}
const lp = (w: string, variant: string, deposit: number) => sweep.cells.find((c) => c.window === w && c.variant === variant && c.deposit === deposit && c.status === 'ok')?.metrics
const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '–' : x.toFixed(d))
const sgn = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`)
const usdc = (raw: bigint) => Number(raw) / 1e6

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
  lp: Record<number, { net: number; vsHold: number; ops: number; gas: number; fees: number } | null>
  vault: Record<string, { status: 'ok' | 'young' | 'none'; tvlM: number | null; growthApy: number | null; growthPrice: number | null; gasIn: number; gasOut: number; byDeposit: Record<number, ReturnType<typeof vaultRun>> }>
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
    row.lp[d] = m ? { net: m.end - d, vsHold: m.end - m.hold, ops: m.ops, gas: m.gas, fees: m.fees } : null
  }
  for (const id of [...LAB_VAULTS, 'steakUSDC']) {
    const g = GAS_UNITS[id]!
    const gasIn = usdc(opGasRaw(ds, first, g.deposit))
    const gasOut = usdc(opGasRaw(ds, last, g.redeem))
    const growthApy = growthFromApy(rates(id), first.time, last.time)
    const growthPrice = vault(id).morpho ? growthFromPrice(prices(id), first.time, last.time) : null
    const tvlM = tvlAt(id, first.time)
    const status = growthApy === null ? 'none' : tvlM !== null && tvlM < MIN_TVL_M ? 'young' : 'ok'
    const byDeposit = Object.fromEntries([50, 500, 1000].map((d) => [d, vaultRun(d, growthApy ?? 1, gasIn, gasOut)]))
    row.vault[id] = { status, tvlM, growthApy, growthPrice, gasIn, gasOut, byDeposit }
  }
  const live = lp(w.id, 'live-mix', 1000)
  const vol = lp(w.id, 'volatile-only', 500)
  const st = lp(w.id, 'stables-only', 500)
  row.mix.live = live ? live.end - 1000 : null
  row.mix.additive = vol && st ? vol.end - 500 + (st.end - 500) : null
  for (const id of LAB_VAULTS) row.mix.byVault[id] = vol && row.vault[id]!.status !== 'none' ? vol.end - 500 + row.vault[id]!.byDeposit[500]!.net : null
  rows.push(row)
  console.error(`${w.id} done`)
}

const out: string[] = []
const p = (s = '') => out.push(s)

// Shortlist
const now = Math.floor(Date.parse(data.fetchedAt) / 1000)
p(`## Shortlist (data fetched ${data.fetchedAt.slice(0, 16)}Z)`)
p()
p('| Vault | Address | Kind | Created | TVL now, M USD | Withdrawable now, M USD | APY 30 d / 90 d, % (net of fee) | APY 90 d min / max | Fee | Timelock |')
p('|---|---|---|---|---|---|---|---|---|---|')
for (const v of data.vaults) {
  const pts90 = v.apy.filter(([t]) => t > now - 90 * DAY).map(([, y]) => y)
  const m = v.morpho
  const created = m ? new Date(m.created * 1000).toISOString().slice(0, 10) : 'see doc'
  const tvl = m ? (m.now.totalAssetsUsdM as number) : data.aaveUsdcNow.supplyUsdM!
  const liq = m ? (m.now.liquidityUsdM as number) : data.aaveUsdcNow.liquidityUsdM!
  p(`| ${v.id} | \`${v.address}\` | ${m ? 'native 4626 (MetaMorpho)' : 'wrapper (static aToken)'} | ${created} | ${f(tvl, 1)} | ${f(liq, 1)} | ${f(meanApy(v.id, 30, now))} / ${f(meanApy(v.id, 90, now))} | ${f(Math.min(...pts90))} / ${f(Math.max(...pts90))} | ${m ? `${Number(m.now.fee) * 100}%` : '0'} | ${m ? `${Number(m.now.timelockSeconds) / DAY} d` : 'gov.'} |`)
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
const aaveLiq = vault('waBasUSDC').apy.filter(([t]) => t > now - 365 * DAY).map(([, , l]) => l)
const aaveThin = vault('waBasUSDC').apy.filter(([t, , l]) => t > now - 730 * DAY && l < 5).map(([t, , l]) => `${new Date(t * 1000).toISOString().slice(0, 10)} (${f(l, 2)}M)`)
p()
p(`Aave v3 Base USDC now: supply ${f(data.aaveUsdcNow.supplyUsdM, 1)}M, utilization ${f(data.aaveUsdcNow.utilization! * 100, 1)}%, available ${f(data.aaveUsdcNow.liquidityUsdM, 1)}M; available liquidity over the last 365 d (DefiLlama TVL = supply − borrow): min ${f(Math.min(...aaveLiq), 2)}M, median ${f(aaveLiq.sort((a, b) => a - b)[Math.floor(aaveLiq.length / 2)], 1)}M. Days under 5M in the last 2 years: ${aaveThin.join(', ') || 'none'}.`)
p()

// Gas
p('## Gas per operation (simulator formula, window means, USDC)')
p()
p('| Window | Split | Days | collect-like op (650k) | gtUSDCp in + out | sparkUSDC in + out | waBasUSDC in + out | LP exit at 1,000 (not charged by the sweep) |')
p('|---|---|---|---|---|---|---|---|')
for (const r of rows) p(`| ${r.window} | ${r.split} | ${f(r.days, 1)} | ${f(r.gasPerOp, 4)} | ${f(r.vault.gtUSDCp!.gasIn + r.vault.gtUSDCp!.gasOut, 4)} | ${f(r.vault.sparkUSDC!.gasIn + r.vault.sparkUSDC!.gasOut, 4)} | ${f(r.vault.waBasUSDC!.gasIn + r.vault.waBasUSDC!.gasOut, 4)} | ${f(r.lpExit[1000], 4)} |`)
p()

// Per window
for (const d of DEPOSITS) {
  p(`## Stables bucket at ${d.toLocaleString('en-US')} USDC, per window (net USDC vs holding USDC; LP net of its gas, exit not charged)`)
  p()
  p('| Window | Split | Regime | Days | LP net | LP vs hold 50/50 | LP ops | LP gas | gtUSDCp | sparkUSDC | waBasUSDC | best vault − LP |')
  p('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const l = r.lp[d]
    const vs = LAB_VAULTS.map((id) => {
      const v = r.vault[id]!
      return v.status === 'none' ? 'n/a (predates)' : v.status === 'young' ? `${sgn(v.byDeposit[d]!.net, 3)}*` : sgn(v.byDeposit[d]!.net, 3)
    })
    const ok = LAB_VAULTS.filter((id) => r.vault[id]!.status !== 'none').map((id) => r.vault[id]!.byDeposit[d]!.net)
    p(`| ${r.window} | ${r.split} | ${r.regime} | ${f(r.days, 1)} | ${l ? sgn(l.net, 3) : 'skipped (no cbBTC yet)'} | ${l ? sgn(l.vsHold, 3) : '–'} | ${l?.ops ?? '–'} | ${l ? f(l.gas, 3) : '–'} | ${vs.join(' | ')} | ${l && ok.length ? sgn(Math.max(...ok) - l.net, 3) : '–'} |`)
  }
  p()
  p(`* the vault held under ${MIN_TVL_M}M USD at the window's start (not seasoned then).`)
  p()
}

// Totals per split, on the windows every arm has
p('## Totals per split (sum over the windows where the LP and every listed vault ran; net USDC)')
p()
p('| Split | Deposit | Windows | Days | LP net | LP net incl. exit | gtUSDCp | sparkUSDC | waBasUSDC | gtUSDCp / sparkUSDC by share price | LP ann. % | gtUSDCp ann. % | sparkUSDC ann. % | waBasUSDC ann. % |')
p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
const totals: Record<string, unknown> = {}
for (const split of ['train', 'test', 'all']) {
  for (const d of DEPOSITS) {
    const ws = rows.filter((r) => (split === 'all' || r.split === split) && r.lp[d] && LAB_VAULTS.every((id) => r.vault[id]!.status !== 'none'))
    const days = ws.reduce((a, r) => a + r.days, 0)
    const lpNet = ws.reduce((a, r) => a + r.lp[d]!.net, 0)
    const lpExit = ws.reduce((a, r) => a + r.lp[d]!.net - r.lpExit[d]!, 0)
    const v = Object.fromEntries(LAB_VAULTS.map((id) => [id, ws.reduce((a, r) => a + r.vault[id]!.byDeposit[d]!.net, 0)]))
    const byPrice = (id: string) => ws.reduce((a, r) => { const x = r.vault[id]!; return a + d * (x.growthPrice ?? Number.NaN) - d - x.gasIn - x.gasOut }, 0)
    const ann = (x: number) => (x / d / days) * 365 * 100
    totals[`${split}-${d}`] = { windows: ws.map((r) => r.window), days, lpNet, lpExit, ...v, gtUSDCpByPrice: byPrice('gtUSDCp'), sparkUSDCByPrice: byPrice('sparkUSDC') }
    p(`| ${split} | ${d} | ${ws.length} | ${f(days, 0)} | ${sgn(lpNet)} | ${sgn(lpExit)} | ${LAB_VAULTS.map((id) => sgn(v[id]!)).join(' | ')} | ${sgn(byPrice('gtUSDCp'))} / ${sgn(byPrice('sparkUSDC'))} | ${f(ann(lpNet))} | ${LAB_VAULTS.map((id) => f(ann(v[id]!))).join(' | ')} |`)
  }
}
p()
p('Windows left out above: sparkUSDC predates them (dec2024, aug2024) or the LP did not run (aug2024):')
p()
p('| Window | Deposit | LP net | gtUSDCp | waBasUSDC |')
p('|---|---|---|---|---|')
for (const r of rows.filter((r) => r.vault.sparkUSDC!.status === 'none'))
  for (const d of DEPOSITS) p(`| ${r.window} | ${d} | ${r.lp[d] ? sgn(r.lp[d]!.net, 3) : '–'} | ${r.vault.gtUSDCp!.status} ${sgn(r.vault.gtUSDCp!.byDeposit[d]!.net, 3)} | ${r.vault.waBasUSDC!.status} ${sgn(r.vault.waBasUSDC!.byDeposit[d]!.net, 3)} |`)
p()

// Whole mix
p('## Whole Conservador mix at 1,000 USDC (net USDC vs the deposit)')
p()
p('Live mix: `conservador-live-v2` as it runs. Additive: volatile buckets alone at 500 (cbBTC 80 / WETH 20 of them) + stables bucket alone at 500; its gap to the live mix is the error of splitting the mix. Vault mixes: the same volatile run + 500 in the vault.')
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
p('## Break-even (90-day mean APY now)')
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
p('## APY model vs the Morpho share price (growth over each window, bps)')
p()
p('| Window | gtUSDCp APY model | gtUSDCp share price | sparkUSDC APY model | sparkUSDC share price |')
p('|---|---|---|---|---|')
const bps = (g: number | null) => (g === null ? '–' : f((g - 1) * 1e4, 2))
for (const r of rows) p(`| ${r.window} | ${bps(r.vault.gtUSDCp!.growthApy)} | ${bps(r.vault.gtUSDCp!.growthPrice)} | ${bps(r.vault.sparkUSDC!.growthApy)} | ${bps(r.vault.sparkUSDC!.growthPrice)} |`)
p()

console.log(out.join('\n'))
if (argv.includes('--json')) writeFileSync(opt('json', ''), `${JSON.stringify({ fetchedAt: data.fetchedAt, gasUnits: Object.fromEntries(Object.entries(GAS_UNITS).map(([k, v]) => [k, { deposit: Number(v.deposit), redeem: Number(v.redeem) }])), rows, totals, mix: mixTot }, null, 1)}\n`)
