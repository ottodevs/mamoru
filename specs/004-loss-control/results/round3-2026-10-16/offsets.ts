// Lab round 3 (#101) start-offset summary: one sweep.json per start offset, each with `baseline`. For every other
// variant and deposit, the deltas of the four aggregate metrics against the baseline at the same offset, as
// min / median / max over the offsets; and the baseline's own aggregates over the offsets, to show the noise.
//   bun offsets.ts <sweep.json>...
import { readFileSync } from 'node:fs'

type M = { returnPct: number; maxDrawdownPct: number }
type Cell = { window: string; deposit: number; variant: string; status: string; metrics?: M }
type Agg = { mean: number; meanDD: number; worstDD: number; worstRet: number }

const runs = process.argv.slice(2).map((f) => {
  const j = JSON.parse(readFileSync(f, 'utf8')) as { startOffsetMinutes?: number; cells: Cell[] }
  return { offset: j.startOffsetMinutes ?? 0, cells: j.cells.filter((c) => c.status === 'ok') }
})
const agg = (cells: Cell[], v: string, d: number): Agg => {
  const m = cells.filter((c) => c.variant === v && c.deposit === d).map((c) => c.metrics!)
  return {
    mean: m.reduce((s, x) => s + x.returnPct, 0) / m.length,
    meanDD: m.reduce((s, x) => s + x.maxDrawdownPct, 0) / m.length,
    worstDD: Math.max(...m.map((x) => x.maxDrawdownPct)),
    worstRet: Math.min(...m.map((x) => x.returnPct)),
  }
}
const keys = ['mean', 'meanDD', 'worstDD', 'worstRet'] as const
const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2)
const spread = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return `${f(s[0]!)} / ${f(s[Math.floor(s.length / 2)]!)} / ${f(s.at(-1)!)}`
}
const deposits = [...new Set(runs[0]!.cells.map((c) => c.deposit))].sort((a, b) => a - b)
const variants = [...new Set(runs[0]!.cells.map((c) => c.variant))]
console.log(`Offsets (min): ${runs.map((r) => r.offset).join(', ')}. Cells: min / median / max over the offsets.\n`)
console.log('| Variant | dep | mean return | mean max DD | worst max DD | worst return | per offset |\n|---|---|---|---|---|---|---|')
for (const d of deposits) {
  const b = runs.map((r) => agg(r.cells, 'baseline', d))
  console.log(`| baseline (level, %) | ${d} | ${keys.map((k) => spread(b.map((x) => x[k]))).join(' | ')} | |`)
}
for (const v of variants.filter((x) => x !== 'baseline'))
  for (const d of deposits) {
    const ds = runs.map((r) => {
      const b = agg(r.cells, 'baseline', d)
      const x = agg(r.cells, v, d)
      return Object.fromEntries(keys.map((k) => [k, x[k] - b[k]])) as Agg
    })
    const passes = ds.filter((x) => x.mean >= -0.1).length
    const won = ds.map((x) => (x.meanDD < -0.005 ? 1 : 0) + (x.worstDD < -0.005 ? 1 : 0) + (x.worstRet > 0.005 ? 1 : 0))
    console.log(`| ${v} (Δ pp) | ${d} | ${keys.map((k) => spread(ds.map((x) => x[k]))).join(' | ')} | constraint held ${passes}/${runs.length}; criteria won per offset ${won.join(',')} of 3 |`)
  }
