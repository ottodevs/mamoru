// otto/mamoru#413 scorer. Reads the stage files of packages/backtest/lab/harvest-modes-413.ts.
//   bun score.ts train-bc.json [train-d.json] [--cells]      TRAIN: score per arm and the pick per mode
//   bun score.ts test.json [--cells]                          TEST: the table per mode x scenario
// Score (fixed before TRAIN ran): mean over the arm's cells (windows x deposits) of the net return after the 10 % fee, %
// of the deposit; ties within 0.005 pp go to fewer operations. Mode of an arm: live = A, A-k..-vault = B, B-k = C, D-k = D
// (the arm names of harvest.ts predate the mode letters of the ticket).
import { readFileSync } from 'node:fs'

type M = { net: number; fee: number; netAfterFee: number; vsHoldAfterFee: number; returnAfterFeePct: number; worstVsDepositPct: number; maxDrawdownPct: number; savings: number; savingsWaiting: number; vaultYield: number; realized: number; feesAccrued: number; gas: number; ops: number; harvests: number; swaps: number; increases: number; sweeps: number; switches: number; unconverted: number; exposureRemoved: number }
type Cell = { window: string; split: string; regime: string; scenario: string; deposit: number; arm: string; status: string; reason?: string; m?: M }

const argv = process.argv.slice(2)
const files = argv.filter((a) => !a.startsWith('--'))
const all = files.flatMap((f) => (JSON.parse(readFileSync(f, 'utf8')) as { cells: Cell[] }).cells)
const cells = all.filter((c) => c.status === 'ok')
const mode = (arm: string) => (arm === 'live' ? 'A' : arm.startsWith('A-') ? 'B' : arm.startsWith('B-') ? 'C' : 'D')
const arms = [...new Set(cells.map((c) => c.arm))]
const deposits = [...new Set(cells.map((c) => c.deposit))].sort((a, b) => a - b)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN)
const f = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d)
const skipped = [...new Set(all.filter((c) => c.status !== 'ok').map((c) => `${c.window} (${c.reason})`))]
if (skipped.length) console.log(`Skipped: ${skipped.join('; ')}\n`)

if (argv.includes('--cells')) {
  console.log('| Window | Scenario | Deposit | Mode | Arm | Net after fee | vs hold after fee | Worst vs deposit % | Max DD % | Savings | Fee | Fees accrued | Gas | Ops | Harvests | Swaps | Increases | Sweeps | Switches | Exposure removed |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const c of cells) {
    const m = c.m!
    console.log(`| ${c.window} | ${c.scenario} | ${c.deposit} | ${mode(c.arm)} | ${c.arm} | ${f(m.netAfterFee)} | ${f(m.vsHoldAfterFee)} | ${f(m.worstVsDepositPct)} | ${m.maxDrawdownPct.toFixed(2)} | ${m.savings.toFixed(2)} | ${m.fee.toFixed(2)} | ${m.feesAccrued.toFixed(2)} | ${m.gas.toFixed(2)} | ${m.ops} | ${m.harvests} | ${m.swaps} | ${m.increases} | ${m.sweeps} | ${m.switches} | ${f(m.exposureRemoved)} |`)
  }
  process.exit(0)
}

// Score per arm, and the pick per mode.
const score = arms.map((arm) => {
  const cs = cells.filter((c) => c.arm === arm)
  return { arm, mode: mode(arm), n: cs.length, score: mean(cs.map((c) => c.m!.returnAfterFeePct)), ops: sum(cs.map((c) => c.m!.ops)), byDeposit: deposits.map((d) => mean(cs.filter((c) => c.deposit === d).map((c) => c.m!.returnAfterFeePct))) }
})
const ns = new Set(score.map((s) => s.n))
if (ns.size !== 1) throw new Error(`arms have different cell counts: ${[...ns].join(', ')}`)
console.log(`| Mode | Arm | Cells | Score: mean return after fee % | ${deposits.map((d) => `at ${d.toLocaleString('en-US')}`).join(' | ')} | Ops |`)
console.log(`|---|---|---|---|${deposits.map(() => '---|').join('')}---|`)
for (const s of score) console.log(`| ${s.mode} | ${s.arm} | ${s.n} | ${f(s.score, 4)} | ${s.byDeposit.map((x) => f(x, 4)).join(' | ')} | ${s.ops} |`)
console.log('')
for (const m of ['A', 'B', 'C', 'D']) {
  const xs = score.filter((s) => s.mode === m)
  if (!xs.length) continue
  const best = xs.reduce((a, b) => (b.score > a.score + 0.005 || (Math.abs(b.score - a.score) <= 0.005 && b.ops < a.ops) ? b : a))
  console.log(`Pick ${m}: ${best.arm} (score ${f(best.score, 4)}, ops ${best.ops})`)
}
console.log('')

// Per mode x scenario x deposit: sums over the scenario's windows (USD) and worst cases.
const scenarios = [...new Set(cells.map((c) => c.scenario))]
for (const d of deposits) {
  console.log(`### ${d.toLocaleString('en-US')} USDC\n`)
  console.log('| Scenario (windows) | Mode | Net after fee | vs hold after fee | Worst vs deposit % | Max DD % | Savings built | Fee 10 % | Fees accrued | Gas | Ops |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const sc of scenarios) {
    const ws = [...new Set(cells.filter((c) => c.scenario === sc).map((c) => c.window))]
    for (const arm of arms) {
      const cs = cells.filter((c) => c.scenario === sc && c.arm === arm && c.deposit === d)
      if (!cs.length) continue
      const g = (k: keyof M) => sum(cs.map((c) => c.m![k]))
      console.log(`| ${sc} (${ws.join(', ')}) | ${mode(arm)} | ${f(g('netAfterFee'))} | ${f(g('vsHoldAfterFee'))} | ${f(Math.min(...cs.map((c) => c.m!.worstVsDepositPct)))} | ${Math.max(...cs.map((c) => c.m!.maxDrawdownPct)).toFixed(2)} | ${g('savings').toFixed(2)} | ${g('fee').toFixed(2)} | ${g('feesAccrued').toFixed(2)} | ${g('gas').toFixed(2)} | ${g('ops')} |`)
    }
  }
  console.log('')
}
