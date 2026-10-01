// Replays a dataset file through `decide` and prints the result.
//   bun packages/backtest/cli/run.ts --dataset .local/base-30d.json --policy conservador-live-v2 --deposit 1000
// --json writes the whole result (series and operation log) to a file. --every N reviews one sample in N.
import { readFileSync, writeFileSync } from 'node:fs'
import { POLICIES } from '@mamoru/policy'
import { entry } from '@mamoru/registry'
import { decodeDataset, type DatasetJson } from '../src/dataset.ts'
import { runBacktest } from '../src/run.ts'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : fallback
  if (v === undefined) throw new Error(`missing --${name}`)
  return v
}

const ds = decodeDataset(JSON.parse(readFileSync(arg('dataset'), 'utf8')) as DatasetJson)
const policy = POLICIES[arg('policy', 'conservador-live-v2')]
if (!policy) throw new Error(`unknown policy; known: ${Object.keys(POLICIES).join(', ')}`)
const decimals = entry(policy.savingsAsset).decimals ?? 6
const unit = 10n ** BigInt(decimals)
const deposit = BigInt(Math.round(Number(arg('deposit', '1000')) * 100)) * (unit / 100n)

const started = performance.now()
const r = runBacktest(ds, policy, { deposit, reviewEvery: Number(arg('every', '1')) })
const ms = Math.round(performance.now() - started)

const money = (v: bigint) => `${(Number(v) / Number(unit)).toFixed(4)} ${policy.savingsAsset}`
const pct = (bps: number) => `${(bps / 100).toFixed(3)}%`
const m = r.metrics
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16)
console.log(`${r.policyId} over ${iso(r.window.fromTime)} .. ${iso(r.window.toTime)} (${m.days.toFixed(1)} days, ${r.window.samples} samples, ${r.window.gaps} gaps, ${ms} ms)`)
console.log(`dataset ${ds.id}`)
console.log(`deposit        ${money(m.start)}`)
console.log(`end, net gas   ${money(m.end)}   net ${money(m.net)} (${pct(m.returnBps)})`)
console.log(`hold the mix   ${money(m.hodl)}   LP vs hold ${money(m.vsHodl)}`)
console.log(`fees earned    ${money(m.fees)}   gas ${money(m.gas)}`)
console.log(`in range       ${pct(m.timeInRangeBps)}   max drawdown ${pct(m.maxDrawdownBps)}   worst week ${pct(m.worstWeekBps)}`)
console.log(`operations     ${Object.entries(m.operations).map(([k, n]) => `${k} ${n}`).join(', ')}, discarded ${m.discarded}`)
console.log(`reviews        ${Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`)
for (const s of r.sessions) console.log(`  ${s.exhausted ? 'OVER ' : '     '}${s.grant}: ${s.peakPerWindow} of ${s.limit ?? 'n/a'} uses in its busiest session window`)
console.log(`result ${r.resultHash}`)
if (process.argv.includes('--json')) {
  writeFileSync(arg('json'), JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  console.log(`wrote ${arg('json')}`)
}
