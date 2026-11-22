// otto/mamoru#127: a dataset replayed at 1k, 10k and 100k USDC per account through the live policies (v7, v8) with prod's
// depth sizing (30/500/5) and no deposit cap. Prints one JSON line per run.
//   bun packages/backtest/cli/capless-replay.ts .local/base-17d.json
import { readFileSync } from 'node:fs'
import { conservadorLiveV7, conservadorLiveV8, ENGINE_SETTINGS_TEMPLATES, withEngineSettings } from '@mamoru/policy'
import { decodeDataset, type DatasetJson } from '../src/dataset.ts'
import { runBacktest } from '../src/run.ts'
const ds = decodeDataset(JSON.parse(readFileSync(process.argv[2] ?? '.local/base-17d.json', 'utf8')) as DatasetJson)
const depth = ENGINE_SETTINGS_TEMPLATES['conservador + depth 30/500/5, cap 1000']!
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2)
for (const [name, base] of [['v7', conservadorLiveV7], ['v8', conservadorLiveV8]] as const) {
  for (const dep of [1_000n, 10_000n, 100_000n]) {
    const policy = withEngineSettings(base, { ...depth, capUsdc: Number(dep) })
    const t = performance.now()
    const r = runBacktest(ds, policy, { deposit: dep * 1_000_000n, reviewEvery: 1, capUsdc: dep * 1_000_000n } as never)
    const m = r.metrics
    const waits = Object.entries(r.reasons).filter(([k]) => /WAIT|IDLE|NO_CAPITAL|DEPTH/.test(k)).map(([k, n]) => `${k}:${n}`).join(' ')
    console.log(JSON.stringify({ policy: name, deposit: Number(dep), days: +m.days.toFixed(1), end: usd(m.end), net: usd(m.net), hodl: usd(m.hodl), vsHodl: usd(m.vsHodl), returnPct: +(m.returnBps / 100).toFixed(3), fees: usd(m.fees), gas: usd(m.gas), inRangePct: +(m.timeInRangeBps / 100).toFixed(1), maxDdPct: +(m.maxDrawdownBps / 100).toFixed(2), ops: m.operations, refused: m.refused, discarded: m.discarded, waits, ms: Math.round(performance.now() - t) }))
  }
}
