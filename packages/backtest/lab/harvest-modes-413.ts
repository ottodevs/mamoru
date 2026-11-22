// otto/mamoru#413 lab: where harvested yield goes. Four modes on a v8-like Base account (Stable 50 / WETH-USDC 25 /
// USDC-cbBTC 25), production `decide` in the simulator, the Lab's fixed TRAIN/TEST windows (windows.ts).
//   A  `live`: today (spec 012): the engine harvests and the USDC re-enters by target weight.
//   B  `savings` + vault sink: harvested fees, volatile sold to USDC, go to a savings layer in the Stable vault, outside
//      the bucket weights (harvest.ts).
//   C  `compound`: fees go back into the position they came from.
//   D  `switch`: C while the pool's trailing fee APR is high, B once it falls under a threshold, with hysteresis.
//
//   bun packages/backtest/lab/harvest-modes-413.ts --stage train-bc|train-d|test [--offset <minutes>] [--out <dir>] [--jobs N]
//
// `--offset`: every window starts that many minutes later (its end stays), as the #101 round-3 robustness check. Declared
// before TEST ran: TEST at offset 0 is the result; offsets 30 and 60 only measure how much of a gap between modes is
// the path (which review each operation lands on) rather than the rule.
//
// Selection rule, fixed before TRAIN ran: within a mode, the variant with the highest mean over TRAIN cells (windows x
// deposits) of the net return after the 10 % fee, in % of the deposit; ties within 0.005 pp go to fewer operations. B
// and C are picked first (stage train-bc), D's APR thresholds next with B's pick for its harvest and sweep rule (stage
// train-d). TEST runs once, with the picks written in PICKS below after TRAIN.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { conservadorLiveV2, parseEngineSettings, withEngineSettings, type PolicyVersion } from '@mamoru/policy'
import { decodeDataset, makeDataset, type DatasetJson } from '../src/dataset.ts'
import { armName, type HarvestArm } from '../src/harvest.ts'
import { runBacktest } from '../src/run.ts'
import { datasetsDir, LAB_WINDOWS, labWindow, windowBlocks } from '../src/windows.ts'

const ROOT = join(import.meta.dir, '../../..')
const RESULTS = join(ROOT, 'specs/004-loss-control/results/harvest-modes-2026-11-22')
const DEPOSITS = [1_000, 100_000]
const USDC = 1_000_000
const WEEK = 7 * 86_400
const DAY = 86_400
/** The 10 % fee on realized yield (owner decision of 22 Nov): collected fees and vault growth; fees still owed are not charged. */
const FEE_BPS = 1_000

/**
 * The engine settings the Lab used as the production baseline in #406 (lazy re-range); the depth sizing and the guard
 * off/on as there. The backtest on main does not apply `maxPerWeek` (#406 fixes it, not merged).
 */
const ENGINE = parseEngineSettings({ capUsdc: 1_000_000, depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 }, guard: { btc: { fallBps: 700, volBps: 8000 }, enabled: false, eth: { fallBps: 900, volBps: 10000 } }, rerange: { costTest: 'off', edgeBufferBps: 2500, edgeBufferTicks: 100, horizonSeconds: 86400, lvrWeightBps: 10000, maxPerWeek: 2, maxWaitSeconds: 21600, minDwellSeconds: 1800, mode: 'lazy' } })

/**
 * v8's weights on a policy the pool simulator can run: the Stable bucket is stood in by the USDC/USDT 0.01 % LP (the
 * simulator has no vault, world.ts), WETH/USDC 0.3 % and USDC/cbBTC 0.05 % at 25 % each, conservador-live-v2's sessions,
 * range (2000 ticks) and harvest rule (3x the op budget).
 */
export const POLICY: PolicyVersion = withEngineSettings(
  {
    ...conservadorLiveV2,
    policyId: 'lab-413-v8like',
    buckets: [
      { id: 'stables', preference: 5000, pools: ['pool:USDC/USDT/100'] },
      { id: 'risk', preference: 2500, pools: ['pool:WETH/USDC/3000'] },
      { id: 'btc-usdc', preference: 2500, pools: ['pool:USDC/cbBTC/500'] },
    ],
  },
  ENGINE,
)

/** Scenario names of the owners' question for the Lab windows. */
export const SCENARIO: Record<string, string> = {
  feb2025: 'sustained fall',
  mar2025: 'sustained fall',
  oct2025: 'sudden dump',
  aug2024: 'sudden dump',
  dec2024: 'rally',
  sep2026: 'sideways',
  'calm-2025-09': 'sideways',
  'calm-2026-04': 'sideways',
  apr2025: 'sudden dump',
  feb2026: 'sustained fall',
  may2025: 'rally',
  jun2025: 'fall then recover',
  'calm-2026-05': 'sideways',
}

const vault = (sweepK: number) => ({ kind: 'vault', sweepK }) as const

function trainBC(): HarvestArm[] {
  const out: HarvestArm[] = [{ kind: 'live' }]
  for (const k of [10, 20, 50]) for (const sweepK of [0, 20, 100]) out.push({ kind: 'savings', k, capSeconds: WEEK, sink: vault(sweepK) })
  for (const k of [10, 20, 50]) out.push({ kind: 'compound', k })
  return out
}

/** Filled after stage train-bc: B's pick (k, T, sweep), whose harvest and sweep rule D reuses; C's pick. */
// TRAIN picks (results/harvest-modes-2026-11-22/train-score.md), written after each TRAIN stage and before TEST ran.
// TRAIN picks (results/harvest-modes-2026-11-22/train-score.md), written after each TRAIN stage and before TEST ran.
export const PICKS: { B: HarvestArm | null; C: HarvestArm | null; D: HarvestArm | null } = {
  B: { kind: 'savings', k: 50, capSeconds: WEEK, sink: vault(100) },
  C: { kind: 'compound', k: 50 },
  D: { kind: 'switch', k: 50, capSeconds: WEEK, sink: vault(100), aprSeconds: DAY, exitBps: 500, enterBps: 1000 },
}

function trainD(): HarvestArm[] {
  const b = PICKS.B
  if (!b || b.kind !== 'savings' || !b.sink) throw new Error('stage train-d needs PICKS.B (a savings arm with a vault sink)')
  const out: HarvestArm[] = []
  for (const [exitBps, enterBps] of [[500, 1000], [1000, 2000], [2000, 4000], [4000, 8000]] as const) for (const aprSeconds of [DAY, 3 * DAY]) out.push({ kind: 'switch', k: b.k, ...(b.capSeconds ? { capSeconds: b.capSeconds } : {}), sink: b.sink, aprSeconds, exitBps, enterBps })
  return out
}

function testArms(): HarvestArm[] {
  if (!PICKS.B || !PICKS.C || !PICKS.D) throw new Error('stage test needs every pick')
  return [{ kind: 'live' }, PICKS.B, PICKS.C, PICKS.D]
}

/** gtUSDCp's daily share price from the Morpho API, as the #186 study read it (stables-4626-2026-10-23). */
function vaultPrices(): { time: number; price: number }[] {
  const d = JSON.parse(readFileSync(join(ROOT, 'specs/004-loss-control/results/raw/stables-4626-data.json'), 'utf8')) as { vaults: { id?: string; name: string; morpho?: { sharePrice: [number, number][] } }[] }
  const g = d.vaults.find((v) => v.name.startsWith('Gauntlet USDC Prime'))
  if (!g?.morpho) throw new Error('no gtUSDCp share price in stables-4626-data.json')
  return g.morpho.sharePrice.map(([time, price]) => ({ time, price }))
}

export type Cell = {
  window: string
  split: string
  regime: string
  scenario: string
  deposit: number
  arm: string
  status: 'ok' | 'skipped'
  reason?: string
  m?: {
    /** End value (positions, idle, savings layer) net of gas, minus the deposit; USD. */
    net: number
    fee: number
    netAfterFee: number
    /** Against holding the first entry mix (hodl basket), after the fee; against idle USDC is `netAfterFee`. */
    vsHoldAfterFee: number
    returnAfterFeePct: number
    /** Lowest value over the run against the deposit (%, negative a loss), and the largest fall from a high (%). */
    worstVsDepositPct: number
    maxDrawdownPct: number
    savings: number
    savingsWaiting: number
    vaultYield: number
    realized: number
    feesAccrued: number
    gas: number
    ops: number
    harvests: number
    swaps: number
    increases: number
    sweeps: number
    switches: number
    unconverted: number
    exposureRemoved: number
    resultHash: string
  }
}

function runWindow(id: string, arms: HarvestArm[], offsetMinutes = 0): Cell[] {
  const w = labWindow(id)
  const ds = decodeDataset(JSON.parse(readFileSync(join(datasetsDir(), w.file), 'utf8')) as DatasetJson)
  const { fromBlock, toBlock } = windowBlocks(w)
  const from = ds.samples.findIndex((s) => s.block >= fromBlock + offsetMinutes * 30)
  const to = ds.samples.findLastIndex((s) => s.block <= toBlock)
  const own = makeDataset(ds.chainId, ds.pools, ds.samples.slice(from, to + 1))
  const prices = vaultPrices()
  const head = { window: id, split: w.split, regime: w.regime, scenario: SCENARIO[id] ?? w.regime }
  const missing = [...new Set(POLICY.buckets.flatMap((b) => b.pools))].filter((p) => !own.samples.some((s) => s.pools[own.pools.indexOf(p)]))
  const cells: Cell[] = []
  for (const arm of arms)
    for (const deposit of DEPOSITS) {
      if (missing.length) {
        cells.push({ ...head, deposit, arm: armName(arm), status: 'skipped', reason: `no data for ${missing.join(', ')}` })
        continue
      }
      const r = runBacktest(own, POLICY, { deposit: BigInt(deposit * USDC), reviewEvery: 1, sessions: 'enforce', sessionRenewal: 'renewed', harvest: arm, vaultPrices: prices, labHarvestOrder: 'engine' })
      const h = r.harvest!
      const n = (v: bigint) => Number(v) / USDC
      const fee = (Number(h.realized) * FEE_BPS) / 10_000 / USDC
      const net = n(r.metrics.net)
      const min = r.series.value.reduce((a, b) => (b < a ? b : a), r.series.value[0]!)
      cells.push({
        ...head,
        deposit,
        arm: armName(arm),
        status: 'ok',
        m: {
          net,
          fee,
          netAfterFee: net - fee,
          vsHoldAfterFee: n(r.metrics.vsHodl) - fee,
          returnAfterFeePct: ((net - fee) / deposit) * 100,
          worstVsDepositPct: ((n(min) - deposit) / deposit) * 100,
          maxDrawdownPct: r.metrics.maxDrawdownBps / 100,
          savings: n(h.savings),
          savingsWaiting: n(h.vault?.waiting ?? 0n),
          vaultYield: n(h.yieldEarned),
          realized: n(h.realized),
          feesAccrued: n(r.metrics.fees),
          gas: n(r.metrics.gas),
          ops: Object.values(r.metrics.operations).reduce((a, b) => a + b, 0),
          harvests: h.harvests,
          swaps: h.swaps,
          increases: h.increases,
          sweeps: h.vault?.sweeps ?? 0,
          switches: h.switches?.count ?? 0,
          unconverted: n(h.unconverted),
          exposureRemoved: n(h.exposureRemoved),
          resultHash: r.resultHash,
        },
      })
    }
  return cells
}

const argv = process.argv.slice(2)
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

if (argv.includes('--worker')) {
  const job = JSON.parse(await Bun.stdin.text()) as { window: string; arms: HarvestArm[]; offset: number }
  await Bun.write(Bun.stdout, JSON.stringify(runWindow(job.window, job.arms, job.offset)))
} else if (import.meta.main) {
  const stage = opt('stage')
  const arms = stage === 'train-bc' ? trainBC() : stage === 'train-d' ? trainD() : stage === 'test' ? testArms() : null
  if (!arms) throw new Error('--stage train-bc|train-d|test')
  const split = stage === 'test' ? 'test' : 'train'
  const offset = Number(opt('offset') ?? 0)
  const name = offset ? `${stage}-offset${offset}` : stage
  const windows = LAB_WINDOWS.filter((w) => w.split === split).map((w) => w.id)
  const jobs = Number(opt('jobs') ?? Math.max(1, Math.min(windows.length, availableParallelism() - 2)))
  const queue = [...windows]
  const cells: Cell[] = []
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const p = Bun.spawn(['bun', import.meta.path, '--worker'], { stdin: new Blob([JSON.stringify({ window: id, arms, offset })]), stdout: 'pipe', stderr: 'inherit' })
        const out = await new Response(p.stdout).text()
        if ((await p.exited) !== 0) throw new Error(`window ${id} failed`)
        cells.push(...(JSON.parse(out) as Cell[]))
        console.error(`${id} done`)
      }
    }),
  )
  const order = (c: Cell) => `${windows.indexOf(c.window).toString().padStart(2, '0')}|${arms.findIndex((a) => armName(a) === c.arm).toString().padStart(2, '0')}|${c.deposit.toString().padStart(7, '0')}`
  cells.sort((a, b) => (order(a) < order(b) ? -1 : 1))
  const dir = opt('out') ?? RESULTS
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ stage, offsetMinutes: offset, policy: POLICY.policyId, engine: ENGINE, deposits: DEPOSITS, feeBps: FEE_BPS, arms, cells }, null, 1))
  console.error(`wrote ${join(dir, `${name}.json`)}: ${cells.length} cells`)
}
