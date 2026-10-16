// The Lab windows (src/windows.ts): list them, backfill them, and write the manifest of the market in each.
//   bun packages/backtest/cli/windows.ts list
//   bun packages/backtest/cli/windows.ts backfill apr2025 may2025      (one after the other; resumes from the cache)
//   bun packages/backtest/cli/windows.ts manifest                      (writes <datasets>/manifest.json and .md)
// A long backfill runs as a user unit and is polled, not held in a terminal:
//   systemd-run --user --unit=mamoru-lab-backfill --collect -p WorkingDirectory=$PWD bun packages/backtest/cli/windows.ts backfill apr2025
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeDataset, type DatasetJson } from '../src/dataset.ts'
import { marketOfDataset } from '../src/market.ts'
import { datasetsDir, LAB_WINDOWS, labWindow, windowBlocks } from '../src/windows.ts'

const [cmd, ...ids] = process.argv.slice(2)
const dir = datasetsDir()

if (cmd === 'list') {
  for (const w of LAB_WINDOWS) {
    const { fromBlock, toBlock } = windowBlocks(w)
    console.log(`${w.split.padEnd(5)} ${w.id.padEnd(13)} ${w.regime.padEnd(13)} ${existsSync(join(dir, w.file)) ? 'have   ' : 'missing'} ${w.file} blocks ${fromBlock}..${toBlock} step ${w.step}  ${w.label}`)
  }
} else if (cmd === 'backfill') {
  let failed = 0
  for (const id of ids.length > 0 ? ids : LAB_WINDOWS.filter((w) => !existsSync(join(dir, w.file))).map((w) => w.id)) {
    const w = labWindow(id)
    const { fromBlock, toBlock } = windowBlocks(w)
    console.log(`backfill ${w.id}: ${w.from} .. ${w.to}`)
    const p = Bun.spawnSync(['bun', join(import.meta.dir, 'backfill.ts'), '--from-block', String(fromBlock), '--to-block', String(toBlock), '--step', String(w.step), '--out', join(dir, w.file), '--concurrency', process.env.CONCURRENCY ?? '4'], { stdout: 'inherit', stderr: 'inherit' })
    if (p.exitCode !== 0) failed++
  }
  process.exitCode = failed > 0 ? 1 : 0
} else if (cmd === 'manifest') {
  const rows = []
  for (const w of LAB_WINDOWS) {
    const path = join(dir, w.file)
    if (!existsSync(path)) {
      console.error(`missing ${w.file}`)
      continue
    }
    const ds = decodeDataset(JSON.parse(readFileSync(path, 'utf8')) as DatasetJson)
    const { fromBlock, toBlock } = windowBlocks(w)
    const own = { ...ds, samples: ds.samples.filter((s) => s.block >= fromBlock && s.block <= toBlock) }
    rows.push({ ...w, datasetId: ds.id, samples: own.samples.length, market: marketOfDataset(own) })
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ format: 'mamoru-lab-manifest-v1', windows: rows }, null, 1)}\n`)
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`)
  const lines = [
    '| Split | Window | Regime | Days | BTC move | BTC max DD | BTC vol | ETH move | ETH max DD | ETH vol | USDT off peg, max |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => {
      const m = r.market
      return `| ${r.split} | ${r.id} | ${r.regime} | ${m.days.toFixed(0)} | ${pct(m.btc?.move ?? null)} | ${pct(m.btc?.maxDrawdown ?? null)} | ${pct(m.btc?.vol ?? null)} | ${pct(m.eth?.move ?? null)} | ${pct(m.eth?.maxDrawdown ?? null)} | ${pct(m.eth?.vol ?? null)} | ${m.usdtMaxOffPegBps === null ? 'n/a' : `${m.usdtMaxOffPegBps.toFixed(0)} bps`} |`
    }),
  ]
  writeFileSync(join(dir, 'manifest.md'), `${lines.join('\n')}\n`)
  console.log(lines.join('\n'))
} else {
  console.error('usage: windows.ts list | backfill [id...] | manifest')
  process.exitCode = 2
}
