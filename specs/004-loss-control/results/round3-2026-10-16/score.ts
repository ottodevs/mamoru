// Lab round 3 (#101) scorer, written before the TRAIN grids ran. Reads one or more sweep.json files that each hold a
// `baseline`-named reference variant (or the one given with --base) and prints, per variant against it:
// the constraint (mean return not worse by more than 0.10 pp at 1,000 and at 100,000), the primary criteria won (of 6:
// lower mean max DD, lower worst max DD, better worst-window return, at both deposits), their sum in pp
// (-dMeanDD - dWorstDD + dWorstRet, summed over deposits), ops and gas, and windows improved (return), with how many
// by more than 0.5 pp (the start-time noise).
//   bun score.ts <sweep.json>... [--base baseline] [--windows] [--only a,b]
import { readFileSync } from 'node:fs'

type M = { returnPct: number; maxDrawdownPct: number; ops: number; gas: number }
type Cell = { window: string; split: string; deposit: number; variant: string; status: string; metrics?: M }

const argv = process.argv.slice(2)
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const files = argv.filter((a, i) => !a.startsWith('--') && !['--base', '--only'].includes(argv[i - 1] ?? ''))
const base = opt('base') ?? 'baseline'
const only = opt('only')?.split(',')
const cells: Cell[] = files.flatMap((f) => (JSON.parse(readFileSync(f, 'utf8')) as { cells: Cell[] }).cells).filter((c) => c.status === 'ok')
const deposits = [...new Set(cells.map((c) => c.deposit))].filter((d) => d >= 1000).sort((a, b) => a - b)
const variants = [...new Set(cells.map((c) => c.variant))].filter((v) => v !== base && (!only || only.includes(v)))

const agg = (v: string, d: number) => {
  const cs = cells.filter((c) => c.variant === v && c.deposit === d)
  const m = cs.map((c) => c.metrics!)
  return {
    n: cs.length,
    mean: m.reduce((s, x) => s + x.returnPct, 0) / m.length,
    meanDD: m.reduce((s, x) => s + x.maxDrawdownPct, 0) / m.length,
    worstDD: Math.max(...m.map((x) => x.maxDrawdownPct)),
    worstRet: Math.min(...m.map((x) => x.returnPct)),
    ops: m.reduce((s, x) => s + x.ops, 0),
    gas: m.reduce((s, x) => s + x.gas, 0),
  }
}
const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2)

type Row = { v: string; pass: boolean; won: number; sum: number; lines: string[] }
const rows: Row[] = variants.map((v) => {
  let pass = true
  let won = 0
  let sum = 0
  const lines: string[] = []
  for (const d of deposits) {
    const b = agg(base, d)
    const x = agg(v, d)
    const dm = x.mean - b.mean
    const dmd = x.meanDD - b.meanDD
    const dwd = x.worstDD - b.worstDD
    const dwr = x.worstRet - b.worstRet
    if (dm < -0.1) pass = false
    // A criterion is won only by a strict improvement at the table's precision (0.005 pp).
    won += (dmd < -0.005 ? 1 : 0) + (dwd < -0.005 ? 1 : 0) + (dwr > 0.005 ? 1 : 0)
    sum += -dmd - dwd + dwr
    lines.push(`| ${d} | ${f(dm)} | ${f(dmd)} | ${f(dwd)} | ${f(dwr)} | ${x.ops} (${b.ops}) | ${x.gas.toFixed(2)} (${b.gas.toFixed(2)}) |`)
  }
  return { v, pass, won, sum, lines }
})
rows.sort((a, b) => Number(b.pass) - Number(a.pass) || b.won - a.won || b.sum - a.sum)
console.log('| Variant | Pass Δmean | Primary won /6 | Σ primary Δ | dep | mean Δ | mean DD Δ | worst DD Δ | worst ret Δ | ops (base) | gas (base) |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) for (const l of r.lines) console.log(`| ${r.v} | ${r.pass ? 'yes' : 'no'} | ${r.won} | ${f(r.sum)} ${l}`)

if (argv.includes('--windows')) {
  for (const r of rows) {
    console.log(`\n**${r.v}** (delta vs ${base}, pp)\n\n| Window | dep | return | Δ return | Δ max DD | ops (base) | gas (base) |\n|---|---|---|---|---|---|---|`)
    for (const d of deposits) {
      let better = 0
      let big = 0
      let n = 0
      for (const c of cells.filter((c) => c.variant === r.v && c.deposit === d)) {
        const b = cells.find((x) => x.variant === base && x.deposit === d && x.window === c.window)
        if (!b) continue
        n++
        const dr = c.metrics!.returnPct - b.metrics!.returnPct
        if (dr > 0.005) better++
        if (dr > 0.5) big++
        console.log(`| ${c.window} | ${d} | ${c.metrics!.returnPct.toFixed(2)} | ${f(dr)} | ${f(c.metrics!.maxDrawdownPct - b.metrics!.maxDrawdownPct)} | ${c.metrics!.ops} (${b.metrics!.ops}) | ${c.metrics!.gas.toFixed(2)} (${b.metrics!.gas.toFixed(2)}) |`)
      }
      console.log(`| windows improved at ${d} | | ${better}/${n} | of them > 0.5 pp: ${big} | | | |`)
    }
  }
}
