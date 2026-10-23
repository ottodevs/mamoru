// Lab #178 scorer, written before the TRAIN grid ran. Reads sweep.json files whose variants carry a harvest arm.
//   bun score.ts <sweep.json>... [--pick A-k10,B-k10] [--cells]
// Prints, per split:
// - per arm and deposit: mean USDC captured net of costs, exposure removed summed over the crash windows, total cost
//   over total fees, harvests and swaps (sums), principal drift (worst max, mean of means), mean value vs hold, lowest
//   value net of gas;
// - TRAIN pick (only from TRAIN cells): the A arm, and the B arm, with the highest score = mean over deposits of
//   (sum over windows of captured) / (sum over windows of fees accrued). Ties: fewer harvests. Per pool the same score
//   on that pool's ledger. `--pick` names the arms instead (for TEST, the TRAIN picks);
// - minimum deposit: the smallest deposit of the grid from which, at it and every larger one, the picked A arm beats
//   the picked B arm on (1) mean captured and (3) exposure removed in the crash windows (B removes none);
// - the absolute floor: per pool, the deposit at which a week of fees reaches k x the mean cost of one harvest.
// `--cells` prints the per-window table instead.
import { readFileSync } from 'node:fs'
import { labWindow } from '../../../../packages/backtest/src/windows.ts'

type Pool = { fees: number; harvests: number; swaps: number; increases: number; cost: number; captured: number; exposureRemoved: number; uncollected: number }
type H = { arm: string; captured: number; exposureRemoved: number; cost: number; fees: number; costToFeesPct: number | null; harvests: number; swaps: number; increases: number; driftMaxPct: number; driftMeanPct: number; minValue: number; savings: number; yieldEarned: number; byPool: Record<string, Pool> }
type M = { returnPct: number; vsHoldPct: number; harvest?: H }
type Cell = { window: string; split: string; regime: string; deposit: number; variant: string; status: string; reason?: string; metrics?: M }
type Report = { cells: Cell[]; variants: { name: string; harvest?: { kind: string; k?: number; capSeconds?: number } }[] }

const argv = process.argv.slice(2)
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--pick')
const reports = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Report)
const all = reports.flatMap((r) => r.cells)
const cells = all.filter((c) => c.status === 'ok' && c.metrics?.harvest)
const kOf = new Map(reports.flatMap((r) => r.variants).map((v) => [v.name, v.harvest?.k ?? 0]))
const deposits = [...new Set(cells.map((c) => c.deposit))].sort((a, b) => a - b)
const arms = [...new Set(cells.map((c) => c.variant))]
const f2 = (x: number) => x.toFixed(2)
const f4 = (x: number) => x.toFixed(4)
const sgn = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d)
const POOLS = ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000']
const short = (p: string) => p.replace('pool:', '')

const skipped = [...new Set(all.filter((c) => c.status !== 'ok').map((c) => `${c.window} (${c.reason})`))]
if (skipped.length) console.log(`Skipped windows: ${skipped.join('; ')}\n`)

if (argv.includes('--cells')) {
  for (const split of ['train', 'test']) {
    const rows = cells.filter((c) => c.split === split)
    if (!rows.length) continue
    console.log(`### ${split.toUpperCase()}\n`)
    console.log('| Window | Regime | Deposit | Arm | Captured | Exposure removed | Cost / fees % | Harvests | Swaps | Increases | Drift max % | Drift mean % | vs hold % | Return % | Min value |')
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const c of rows) {
      const h = c.metrics!.harvest!
      console.log(`| ${c.window} | ${c.regime} | ${c.deposit} | ${c.variant} | ${f4(h.captured)} | ${f4(h.exposureRemoved)} | ${h.costToFeesPct === null ? 'n/a' : f2(h.costToFeesPct)} | ${h.harvests} | ${h.swaps} | ${h.increases} | ${f2(h.driftMaxPct)} | ${f2(h.driftMeanPct)} | ${f2(c.metrics!.vsHoldPct)} | ${f2(c.metrics!.returnPct)} | ${f2(h.minValue)} |`)
    }
    console.log('')
  }
  process.exit(0)
}

const of = (split: string, arm: string, d: number) => cells.filter((c) => c.split === split && c.variant === arm && c.deposit === d)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0)

function agg(split: string, arm: string, d: number, pool?: string) {
  const cs = of(split, arm, d)
  const hs = cs.map((c) => c.metrics!.harvest!)
  const part = (h: H) => (pool ? (h.byPool[pool] ?? { fees: 0, harvests: 0, swaps: 0, increases: 0, cost: 0, captured: 0, exposureRemoved: 0, uncollected: 0 }) : h)
  const crash = cs.filter((c) => c.regime === 'crash').map((c) => part(c.metrics!.harvest!).exposureRemoved)
  return {
    n: cs.length,
    captured: mean(hs.map((h) => part(h).captured)),
    capturedSum: sum(hs.map((h) => part(h).captured)),
    exposureCrash: sum(crash),
    exposureAll: sum(hs.map((h) => part(h).exposureRemoved)),
    cost: sum(hs.map((h) => part(h).cost)),
    fees: sum(hs.map((h) => part(h).fees)),
    harvests: sum(hs.map((h) => part(h).harvests)),
    swaps: sum(hs.map((h) => part(h).swaps)),
    increases: sum(hs.map((h) => part(h).increases)),
    driftMax: Math.max(...hs.map((h) => h.driftMaxPct)),
    driftMean: mean(hs.map((h) => h.driftMeanPct)),
    vsHold: mean(cs.map((c) => c.metrics!.vsHoldPct)),
    ret: mean(cs.map((c) => c.metrics!.returnPct)),
    minValue: Math.min(...hs.map((h) => h.minValue)),
  }
}

function score(split: string, arm: string, pool?: string): { score: number; harvests: number } {
  const per = deposits.map((d) => agg(split, arm, d, pool))
  return { score: mean(per.map((a) => (a.fees > 0 ? a.capturedSum / a.fees : 0))), harvests: sum(per.map((a) => a.harvests)) }
}

function best(prefix: string, pool?: string): string {
  const cands = arms.filter((a) => a.startsWith(prefix)).map((a) => ({ a, ...score('train', a, pool) }))
  cands.sort((x, y) => y.score - x.score || x.harvests - y.harvests)
  return cands[0]!.a
}

for (const split of ['train', 'test']) {
  if (!cells.some((c) => c.split === split)) continue
  const windows = [...new Set(cells.filter((c) => c.split === split).map((c) => c.window))]
  console.log(`## ${split.toUpperCase()} (${windows.length} windows: ${windows.join(', ')})\n`)
  console.log('| Deposit | Arm | Mean captured | Exposure removed (crash, sum) | Exposure removed (all) | Cost / fees % | Harvests | Swaps | Increases | Drift max % | Drift mean % | Mean vs hold % | Mean return % | Min value |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const d of deposits) for (const arm of arms) {
    const a = agg(split, arm, d)
    if (!a.n) continue
    console.log(`| ${d} | ${arm} | ${f4(a.captured)} | ${f4(a.exposureCrash)} | ${f4(a.exposureAll)} | ${a.fees > 0 ? f2((100 * a.cost) / a.fees) : 'n/a'} | ${a.harvests} | ${a.swaps} | ${a.increases} | ${f2(a.driftMax)} | ${f2(a.driftMean)} | ${f2(a.vsHold)} | ${f2(a.ret)} | ${f2(a.minValue)} |`)
  }
  console.log('')
}

const hasTrain = cells.some((c) => c.split === 'train')
const picked = opt('pick')?.split(',')
const pickA = picked?.find((p) => p.startsWith('A-')) ?? (hasTrain ? best('A-') : undefined)
const pickB = picked?.find((p) => p.startsWith('B-')) ?? (hasTrain ? best('B-') : undefined)
if (hasTrain) {
  console.log('## TRAIN score (mean over deposits of captured / fees)\n')
  console.log(`| Arm | Score % | ${POOLS.map(short).join(' % | ')} % | Harvests |`)
  console.log(`|---|---|${POOLS.map(() => '---|').join('')}---|`)
  for (const arm of arms) {
    const s = score('train', arm)
    console.log(`| ${arm} | ${f2(100 * s.score)} | ${POOLS.map((p) => f2(100 * score('train', arm, p).score)).join(' | ')} | ${s.harvests} |`)
  }
  console.log(`\nTRAIN pick: ${best('A-')} (A), ${best('B-')} (B). Per pool (A): ${POOLS.map((p) => `${short(p)} ${best('A-', p)}`).join(', ')}.\n`)
}

if (pickA && pickB) {
  for (const split of ['train', 'test']) {
    if (!cells.some((c) => c.split === split && c.variant === pickA)) continue
    console.log(`## Minimum deposit, ${split.toUpperCase()}: ${pickA} against ${pickB}\n`)
    console.log('| Deposit | Captured A | Captured B | A - B | Exposure removed A (crash) | A beats B on (1) and (3) | A captured > 0 |')
    console.log('|---|---|---|---|---|---|---|')
    const wins: boolean[] = []
    const pos: boolean[] = []
    for (const d of deposits) {
      const a = agg(split, pickA, d)
      const b = agg(split, pickB, d)
      const win = a.captured > b.captured && a.exposureCrash > 0
      wins.push(win)
      pos.push(a.captured > 0)
      console.log(`| ${d} | ${f4(a.captured)} | ${f4(b.captured)} | ${sgn(a.captured - b.captured, 4)} | ${f4(a.exposureCrash)} | ${win ? 'yes' : 'no'} | ${a.captured > 0 ? 'yes' : 'no'} |`)
    }
    const from = (xs: boolean[]) => {
      const i = xs.findIndex((_, j) => xs.slice(j).every(Boolean))
      return i < 0 ? 'none in the grid' : `${deposits[i]} USDC`
    }
    console.log(`\nA beats B from: ${from(wins)}. A captures net savings from: ${from(pos)}.\n`)
  }

  // Absolute floor: per pool, the deposit at which a week of fees pays k x one harvest's mean cost (TRAIN, the A pick).
  const k = kOf.get(pickA) ?? 0
  const src = hasTrain ? 'train' : 'test'
  console.log(`## Absolute floor (${src.toUpperCase()}, ${pickA}, k = ${k})\n`)
  console.log('| Pool | Fees per week per 1,000 USDC deposit | Mean cost of one harvest | Deposit at which a week of fees = k x cost |')
  console.log('|---|---|---|---|')
  for (const p of POOLS) {
    const cs = cells.filter((c) => c.split === src && c.variant === pickA)
    let feesPerK = 0
    let weeks = 0
    let cost = 0
    let harvests = 0
    for (const c of cs) {
      const pl = c.metrics!.harvest!.byPool[p]
      if (!pl) continue
      const w = labWindow(c.window)
      const days = (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000
      feesPerK += (pl.fees / c.deposit) * 1000
      weeks += days / 7
      cost += pl.cost
      harvests += pl.harvests
    }
    const perWeek = weeks ? feesPerK / weeks : 0
    const perHarvest = harvests ? cost / harvests : 0
    console.log(`| ${short(p)} | ${f4(perWeek)} | ${f4(perHarvest)} | ${perWeek > 0 ? ((k * perHarvest) / perWeek * 1000).toFixed(0) : 'n/a'} |`)
  }
  console.log('')
}
