// Lab sweep: a policy variant over every Lab window x deposit, through the production `decide`.
//   bun packages/backtest/cli/sweep.ts                                   today's live policy on TRAIN
//   bun packages/backtest/cli/sweep.ts --split all                       TRAIN and TEST, reported apart
//   bun packages/backtest/cli/sweep.ts --set range.cooldownSeconds=3600 --name cd1h      variant + the unchanged baseline
//   bun packages/backtest/cli/sweep.ts --variants my-variants.json       [{ "name", "policy", "overrides" }, ...]
// Options: --policy <id> (conservador-live-v2), --windows a,b, --deposits 1000,100000, --jobs N, --out <dir>,
// --no-baseline. Tune on TRAIN; run TEST once per candidate, to judge it. Same inputs give the same files.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { keccak256, stringToHex } from 'viem'
import { canonicalJson } from '@mamoru/decide'
import { policyHash } from '@mamoru/policy'
import { decodeDataset, type DatasetJson } from '../src/dataset.ts'
import { runBacktest, SIM_VERSION } from '../src/run.ts'
import { aggregate, cellMetrics, decimalsOf, markdown, overridesFromAssignments, policyOf, sortCells, type Cell, type Variant } from '../src/sweep.ts'
import { datasetsDir, LAB_WINDOWS, labWindow, windowBlocks } from '../src/windows.ts'

type Job = { window: string; variants: Variant[]; deposits: number[] }

const argv = process.argv.slice(2)
const has = (name: string) => argv.includes(`--${name}`)
function arg(name: string, fallback?: string): string {
  const i = argv.indexOf(`--${name}`)
  const v = i >= 0 ? argv[i + 1] : fallback
  if (v === undefined) throw new Error(`missing --${name}`)
  return v
}
const all = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]!] : []))

/** One window: decode its dataset once, run every variant and deposit. */
function runJob(job: Job): Cell[] {
  const w = labWindow(job.window)
  const ds = decodeDataset(JSON.parse(readFileSync(join(datasetsDir(), w.file), 'utf8')) as DatasetJson)
  // Only the window's own blocks: a dataset can hold a sample of the window next to it.
  const { fromBlock, toBlock } = windowBlocks(w)
  const from = ds.samples.findIndex((s) => s.block >= fromBlock)
  const to = ds.samples.findLastIndex((s) => s.block <= toBlock)
  if (from < 0 || to < from) throw new Error(`${w.file} has no sample in blocks ${fromBlock}..${toBlock}`)
  const cells: Cell[] = []
  for (const v of job.variants) {
    const policy = policyOf(v)
    const head = { window: w.id, split: w.split, regime: w.regime, variant: v.name, policyId: policy.policyId }
    const missing = [...new Set(policy.buckets.flatMap((b) => b.pools))].filter((p) => !ds.samples.slice(from, to + 1).some((s) => s.pools[ds.pools.indexOf(p)]))
    for (const deposit of job.deposits) {
      if (missing.length > 0) {
        cells.push({ ...head, deposit, status: 'skipped', reason: `no data for ${missing.join(', ')}` })
        continue
      }
      const unit = 10n ** BigInt(decimalsOf(policy))
      // Cents of the savings asset, as cli/run.ts takes a deposit.
      const r = runBacktest(ds, policy, { deposit: (BigInt(Math.round(deposit * 100)) * unit) / 100n, from, to, reviewEvery: 1, sessions: 'enforce', sessionRenewal: 'renewed' })
      cells.push({ ...head, deposit, status: 'ok', metrics: cellMetrics(r, decimalsOf(policy)) })
    }
  }
  return cells
}

if (has('worker')) {
  const job = JSON.parse(await Bun.stdin.text()) as Job
  // Written whole before the process ends: a pipe holds less than a large result.
  await Bun.write(Bun.stdout, JSON.stringify(runJob(job)))
} else await main()

async function main(): Promise<void> {

  let variants: Variant[]
  if (has('variants')) variants = JSON.parse(readFileSync(arg('variants'), 'utf8')) as Variant[]
  else {
    const policy = arg('policy', 'conservador-live-v2')
    const sets = all('set')
    variants = sets.length === 0 ? [{ name: policy, policy }] : [{ name: arg('name', 'variant'), policy, overrides: overridesFromAssignments(sets) }]
    if (sets.length > 0 && !has('no-baseline')) variants.unshift({ name: 'baseline', policy })
  }
  const names = new Set(variants.map((v) => v.name))
  if (names.size !== variants.length) throw new Error('two variants share a name')
  for (const v of variants) policyOf(v) // refuses an unknown policy or parameter before any work starts

  // --windows picks windows by id; the report's split is then the one they belong to, never a label they do not have.
  const picked = has('windows') ? arg('windows').split(',').map(labWindow) : null
  const splits = new Set(picked?.map((w) => w.split))
  const split = has('split') ? arg('split') : picked ? (splits.size === 1 ? [...splits][0]! : 'all') : 'train'
  if (!['train', 'test', 'all'].includes(split)) throw new Error('--split train | test | all')
  if (picked && split !== 'all' && picked.some((w) => w.split !== split)) throw new Error(`--windows names windows outside --split ${split}`)
  const windows = picked ?? LAB_WINDOWS.filter((w) => split === 'all' || w.split === split)
  const deposits = arg('deposits', '1000,100000').split(',').map(Number)
  if (deposits.length === 0 || deposits.some((d) => !Number.isFinite(d) || d <= 0)) throw new Error('--deposits: positive amounts of the savings asset')
  // Half the cores at most and below normal priority: the box runs other work.
  const jobsArg = Number(arg('jobs', String(Math.max(1, Math.floor(availableParallelism() / 2)))))
  if (!Number.isInteger(jobsArg) || jobsArg < 1) throw new Error('--jobs: a positive whole number')
  const jobs = Math.min(windows.length, jobsArg)
  if (windows.some((w) => w.split === 'test')) console.error('TEST windows included: judge a candidate on them, do not tune on them.')

  const started = performance.now()
  const queue: Job[] = windows.map((w) => ({ window: w.id, variants, deposits }))
  const cells: Cell[] = []
  async function worker(): Promise<void> {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const p = Bun.spawn(['nice', '-n', '10', process.execPath, import.meta.path, '--worker'], { stdin: new Blob([JSON.stringify(job)]), stdout: 'pipe', stderr: 'inherit', env: process.env })
      const text = await new Response(p.stdout).text()
      if ((await p.exited) !== 0) throw new Error(`window ${job.window} failed`)
      cells.push(...(JSON.parse(text) as Cell[]))
      console.error(`${job.window} done`)
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker))

  const sorted = sortCells(cells, LAB_WINDOWS, variants, deposits)
  const aggs = aggregate(sorted)
  const report = {
    format: 'mamoru-lab-sweep-v1',
    simVersion: SIM_VERSION,
    split,
    deposits,
    variants: variants.map((v) => ({ ...v, policyId: policyOf(v).policyId, policyHash: policyHash(policyOf(v)) })),
    windows: windows.map((w) => w.id),
    cells: sorted,
    aggregates: aggs,
  }
  const json = canonicalJson(JSON.parse(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))))
  const id = keccak256(stringToHex(json)).slice(2, 10)
  const out = arg('out', join(datasetsDir(), '..', 'sweeps', `${variants.map((v) => v.name).join('_').replace(/[^\w.+-]/g, '-')}-${split}-${id}`))
  mkdirSync(out, { recursive: true })
  const md = markdown(sorted, aggs)
  writeFileSync(join(out, 'sweep.json'), `${json}\n`)
  writeFileSync(join(out, 'sweep.md'), md)
  console.log(md)
  console.log(`${sorted.length} cells, ${jobs} jobs, ${Math.round((performance.now() - started) / 1000)} s; wrote ${out}/sweep.{json,md}`)
}
