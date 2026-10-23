# 004 Lab: harvest to a USDC savings layer (A·k) against compounding in kind (B), 23 Oct 2026

Ticket otto/mamoru#178, feeds #107. Lab only: `packages/decide` and `apps/mamoru-operator` are unchanged, and a run
without a harvest arm is the run of before, result hash included (test: `live` arm = no arm, op for op).

Simulator `backtest-1`, production `decide`, policy `conservador-live-v2` (50/40/10 on USDC/USDT 0.01%, USDC/cbBTC
0.05%, WETH/USDC 0.3%) unchanged for every arm, review every sample, session limits enforced. Deposits 100, 500,
1,000, 5,000 and 25,000 USDC. TRAIN: 7 windows (aug2024 skipped: no cbBTC on Base yet). TEST: 5 windows, run **once**
with the TRAIN picks. Datasets already on disk, no RPC.

**Revision 2 (after review of a1637b0, GPT-6 Sol, five P1 measurement findings).** All numbers below are from the
re-run; the change log and a before/after table are at the end ("Revision after review"). The picks, the ordering of
the arms, the minimum-deposit result and the recommendation did not change; A's captured fell slightly at most
deposits and B's fell at every deposit.

## Arms

| Arm | Rule | Where |
|---|---|---|
| `live` | `decide` as it is: harvest when fees > 3 × the userOp budget (5.1M gas at 2 × base fee + tip), collect only (#140); the volatile fees wait in the account and target-weights re-allocates them. The run only measures. | `decide/src/harvest` |
| `A-k{k}` | Savings layer. Per position, at a review: harvest when `fees ≥ k × cost`, `cost = gas(collect) + gas(swap) + pool fee and price impact of selling the volatile part` (the last two read from the simulated swap against the sample's active liquidity, as QuoterV2 would). Collect, then sell the volatile part in a **second userOp** (#140: a convert in the same batch could sell principal). The USDC goes to a layer outside the buckets: never back into BTC/ETH, not in the target weights. Fees a re-range or reduce collects also go there, once the operation has gone through: the USDC part at once, the volatile part at the pool's next harvest swap, or in a swap of its own (same k rule, swap cost only) when the pool has no position left. Until sold it is reported as *unconverted*, never as savings. The engine's own harvest is off: a position `decide` wants to harvest is shown to it without fees, so the review goes on to its next proposal. | `backtest/src/harvest.ts` |
| `A-k{k}-T7d` | The same, plus the time cap: 7 days after a position's last harvest (or first review), harvest when fees cover the cost once. | same |
| `B-k{k}` | Compound in kind: when `fees ≥ k × (gas(collect) + gas(increaseLiquidity))`, collect and add to the same position what fits its range at the current price; what does not fit stays in the account (target-weights re-allocates it, as live). No swap to the ratio. The run tracks, per position, the liquidity compounding bought. | same |

Grid: k ∈ {2, 3, 5, 10} from the ticket **plus {20, 50}**, added before the TRAIN grid ran because the ticket's grid
spends roughly 1/k of the fees on cost (a k = 3 harvest pays a third of what it collects), while live's trigger sits at
about 40-50 × the real cost of a collect. B on the same k grid; its pick is the reference.

A harvest arm's operations take the review's one operation: on a review where the arm harvests, `decide` is not run.
Sessions do not limit the arm's own operations (the live `convert-any` grant would carry them; not counted here).

## Assumptions

- **Gas.** `DEFAULT_GAS` of the simulator: collect 650k gas (estimate, no live receipt), swap 470k (median of live
  receipts), increaseLiquidity 635k (estimate), at the sample's base fee + 0.001 gwei tip, plus a 3.1e9 wei L1 fee per
  op, priced in USDC through WETH/USDC. One harvest costs **about 0.01-0.02 USDC** (TRAIN mean 0.018-0.020, TEST
  0.011-0.014, swap fee included). Live's trigger prices the same collect at 5.1M gas × 2 × base fee.
- **Savings yield.** The layer earns, each interval, what the account's own stables position earned per unit of its
  value (USDC/USDT 0.01%, ±20 ticks), compounding. It assumes the layer sits in that pool and range, is small next to
  it, and costs no gas to deposit; it is valued 1:1 in USDC (no USDT depeg haircut). The yield is 0.1-0.3 USDC on
  25,000 a month: it moves no conclusion.
- **Captured (metric 1).** A: the USDC that reached the layer (its yield included) − the gas of its collects and
  swaps; volatile fees collected and not sold yet are reported as *unconverted*, not captured. Live: every fee
  collected, held in kind and valued at the end price, − the gas of its collects. B: the compounded liquidity's share
  of each position at the end (its amounts and the fees owed on it), plus what stayed in the account in kind (what an
  increase could not take, the collect of a re-range or reduce, the compounded share a re-range or reduce took out) at
  the end price, − the gas of its collects and increases. Fees still in positions at the end count for no arm
  (reported apart). Every run checks, token by token, that each fee unit earned was either collected or is still owed.
- **Exposure removed (metric 3).** A: Σ over sales of (value of the volatile fees sold, at the pool mid, at the sale) −
  (the same tokens at the window's end price). Positive: holding them would have lost that much. Live and B: 0.
- **Cost / fees (metric 2).** Gas of the harvest operations + swap fee and impact, over the fees every position
  accrued. Live counts its harvest gas only (its re-allocation swaps are not harvest cost; they are in the value).
- **Drift (metric 5).** At every review, the largest distance (pp of the account) between a bucket's weight and its
  target. A bucket is worth its positions in any of its pools and the idle volatile of its pools (at the TWAP); the
  account is its free USDC plus the buckets (the savings layer is outside). Sampled at every review from the first one
  where every bucket holds a position in one of its pools, whatever the distance. "Max" is dominated by transients (a re-range closes a position and the bucket reads ~0 until the
  re-mint one review later, and the 10 Oct 2025 cascade): read the mean.
- **#150.** Gas is charged against the value series, not the balances, so an account cannot go negative through a
  failed op; the lowest value net of gas is reported per cell. Lowest anywhere: 81.24 on a 100 USDC deposit (TEST,
  apr2025): no account goes near zero, so the small-deposit columns are readable.

## Selection protocol (declared before TRAIN ran; `harvest-2026-10-23/score.ts`)

Score = mean over the 5 deposits of (Σ over TRAIN windows of captured) / (Σ of fees accrued). Highest score wins among
A arms and, separately, among B arms; ties go to fewer harvests. Per pool, the same score on that pool's ledger.
Minimum deposit: the smallest grid deposit from which (at it and every larger one) the A pick beats the B pick on mean
captured **and** removes exposure in the crash windows (sum > 0).

## TRAIN (7 windows)

Score, % of fees captured net of cost (`raw/harvest-train-score.md`):

| Arm | All pools | USDC/USDT | USDC/cbBTC | WETH/USDC | Harvests |
|---|---|---|---|---|---|
| live | **92.59** | 86.32 | 94.43 | 90.78 | 4,768 |
| A-k2 / -T7d | 64.00 / 63.92 | 70.78 / 69.91 | 63.13 / 63.13 | 63.74 / 63.73 | 22,828 |
| A-k3 / -T7d | 74.03 / 73.98 | 76.73 / 76.26 | 73.82 / 73.80 | 73.56 / 73.57 | 18,522 |
| A-k5 / -T7d | 82.82 / 82.83 | 83.55 / 82.59 | 82.65 / 82.64 | 82.79 / 83.08 | 13,681 |
| A-k10 / -T7d | 88.46 / 88.87 | 82.48 / 84.01 | 89.58 / 90.04 | 87.69 / 87.77 | 8,746 |
| **A-k20 / -T7d** | 89.80 / **90.87** | 83.66 / **85.24** | 90.64 / **91.84** | 89.58 / **90.32** | 5,284 / 5,334 |
| A-k50 / -T7d | 83.76 / 87.14 | 69.93 / 78.75 | 86.97 / 89.22 | 81.14 / 85.22 | 2,512 |
| B-k10 | 89.03 | 84.55 | 89.73 | 88.90 | 8,185 |
| **B-k20** | **89.78** | 86.58 | 90.82 | 88.70 | 4,938 |
| B-k50 | 87.84 | 78.03 | 89.03 | 88.07 | 2,344 |

(B-k2..k5 track A-k2..k5 within a point; full table in the raw file.)

**Picks: A-k20-T7d and B-k20.** Per pool: A-k20-T7d for all three (revision 1 had A-k20 for USDC/USDT and WETH/USDC,
within 0.4 pp), so **one k = 20, T = 7 d for all three pools** is the recommendation; T matters only where fees are slow (small deposits, the stables pool). k = 50 loses because fees
still in positions at the end of a week are not captured; below k = 10 the cost eats the fees.

At the pick, per deposit (means over the 7 windows; exposure summed over the 4 crash windows):

| Deposit | Arm | Captured | Exposure removed, crash | Exposure removed, all | Cost / fees % | Harvests | Swaps | Drift mean % | vs hold % |
|---|---|---|---|---|---|---|---|---|---|
| 100 | live | 1.03 | 0 | 0 | 1.18 | 20 | 0 | 0.80 | -1.74 |
| 100 | A-k20-T7d | 1.03 | 0.05 | 0.00 | 5.76 | 39 | 41 | 0.84 | -1.73 |
| 100 | B-k20 | 0.99 | 0 | 0 | 2.16 | 18 | 0 | 0.83 | -1.68 |
| 1,000 | live | 12.54 | 0 | 0 | 1.92 | 237 | 0 | 0.84 | -0.36 |
| 1,000 | A-k20-T7d | 12.18 | 0.57 | -0.21 | 4.47 | 273 | 275 | 0.87 | -0.43 |
| 1,000 | B-k20 | 12.12 | 0 | 0 | 3.87 | 234 | 0 | 0.82 | -0.51 |
| 25,000 | live | 310.17 | 0 | 0 | 1.66 | 3,421 | 0 | 0.83 | -0.27 |
| 25,000 | A-k20-T7d | 301.53 | 16.11 | -5.57 | 3.65 | 3,791 | 3,749 | 0.99 | -0.62 |
| 25,000 | B-k20 | 304.93 | 0 | 0 | 3.63 | 3,573 | 0 | 0.86 | -0.43 |

Swaps can exceed harvests: a swap of its own sells volatile fees a re-range left in a pool with no position.

## TEST (5 windows, run once)

| Deposit | Arm | Captured | Exposure removed, crash (apr2025) | Exposure removed, all | Cost / fees % | Harvests | Swaps | Drift mean % | vs hold % |
|---|---|---|---|---|---|---|---|---|---|
| 100 | live | 1.77 | 0 | 0 | 1.47 | 41 | 0 | 0.75 | -2.75 |
| 100 | A-k20-T7d | 1.70 | 0.03 | -0.04 | 4.97 | 53 | 56 | 0.85 | -2.59 |
| 100 | B-k20 | 1.71 | 0 | 0 | 2.69 | 35 | 0 | 0.75 | -2.47 |
| 500 | live | 9.28 | 0 | 0 | 1.76 | 190 | 0 | 0.77 | -0.42 |
| 500 | A-k20-T7d | 8.88 | 0.20 | -0.15 | 4.00 | 206 | 206 | 0.79 | -0.43 |
| 500 | B-k20 | 8.99 | 0 | 0 | 3.68 | 185 | 0 | 0.76 | -0.39 |
| 1,000 | live | 18.54 | 0 | 0 | 1.70 | 345 | 0 | 0.77 | -0.08 |
| 1,000 | A-k20-T7d | 17.88 | 0.41 | -0.29 | 3.87 | 355 | 358 | 0.80 | -0.12 |
| 1,000 | B-k20 | 18.15 | 0 | 0 | 3.65 | 337 | 0 | 0.73 | -0.01 |
| 5,000 | live | 89.61 | 0 | 0 | 1.52 | 1,260 | 0 | 1.02 | +0.22 |
| 5,000 | A-k20-T7d | 89.64 | 2.11 | -1.67 | 3.22 | 1,310 | 1,296 | 0.76 | +0.26 |
| 5,000 | B-k20 | 90.04 | 0 | 0 | 3.18 | 1,257 | 0 | 0.76 | +0.23 |
| 25,000 | live | 417.21 | 0 | 0 | 1.14 | 3,726 | 0 | 1.23 | +0.18 |
| 25,000 | A-k20-T7d | 415.45 | 9.13 | -8.45 | 2.71 | 3,930 | 3,712 | 0.81 | +0.04 |
| 25,000 | B-k20 | 421.19 | 0 | 0 | 2.70 | 3,757 | 0 | 0.77 | +0.05 |

Per pool on TEST (all deposits pooled; captured and cost as % of the pool's fees):

| Pool | live captured / cost | A-k20-T7d captured / cost | B-k20 captured / cost | A exposure removed, crash / all |
|---|---|---|---|---|
| USDC/USDT 0.01% | 99.02 / 0.51 | 98.55 / 1.03 | 98.69 / 0.93 | 0 / -0.26 |
| USDC/cbBTC 0.05% | 98.81 / 1.28 | 96.92 / 2.94 | 96.48 / 3.10 | +5.95 / -2.45 |
| WETH/USDC 0.3% | 99.45 / 1.33 | 96.59 / 3.25 | 96.69 / 2.95 | +5.94 / -7.90 |

TEST confirms TRAIN: same ordering (live > B-k20 ≥ A-k20-T7d on captured, A ahead of B on cbBTC alone), cost/fees 2.7-5.0% for A against 1.1-1.8%
for live, A removes exposure in the crash window at every deposit, and gives it back in the rally and calm windows.

## Where A beats B, window by window (A-k20-T7d − B-k20, captured)

| Window | Regime | 1,000 | 25,000 | A exposure removed at 25,000 |
|---|---|---|---|---|
| mar2025 (T) | crash | +1.33 | +12.36 | +14.89 |
| apr2025 (TEST) | crash | +0.31 | +9.76 | +9.13 |
| calm-2026-05 (TEST) | calm | +0.32 | +10.55 | +6.88 |
| sep2026 (T) | calm | +0.05 | -9.30 | -7.50 |
| feb2025 (T) | crash | -0.28 | -5.99 | +2.47 |
| oct2025 (T) | crash | -0.30 | -2.49 | -1.25 |
| dec2024 (T) | rally | -0.03 | -10.99 | -10.40 |
| feb2026 (TEST) | stable-stress | -1.39 | -34.09 | -17.00 |
| other calm and rally windows | | -0.11 to -0.48 | -2.1 to -10.5 | -4.7 to +0.9 |

The sign follows the path of BTC/ETH between each sale and the window's end, not the deposit. In oct2025 and feb2026
the fall came and recovered inside the window, so fees sold near the low lost against holding them; in feb2025 the
fall was early and the end price was still lower, but A's extra swap cost was larger than what it removed.

## Minimum deposit

| | TRAIN | TEST |
|---|---|---|
| A-k20-T7d beats B-k20 on (1) mean captured **and** (3) crash exposure, at every deposit from | **none in the grid** (wins at 100 and 1,000, loses at 500, 5,000, 25,000) | **none in the grid** (loses at every deposit, by 0.5-1.5% of fees) |
| A captures positive net USDC savings from | 100 | 100 |
| A removes exposure in the crash windows (sum > 0) from | 100 | 100 |

There is no minimum deposit above which A·k beats B on (1): the difference is the price path (above), less A's extra
cost, and it scales with the deposit instead of crossing zero. On (3) A wins at every deposit, by construction (B
removes none).

The absolute floor that does exist is the one #156 asks for: the deposit below which a position's fees do not reach
k × the harvest cost within a week, so the 7-day cap does the harvesting. At k = 20, with the gas assumptions above:

| Pool | Fees per week per 1,000 USDC of account (TRAIN / TEST) | Mean cost of one harvest, USDC (TRAIN / TEST) | Account size at which one week of fees = 20 × cost (TRAIN / TEST) |
|---|---|---|---|
| USDC/USDT 0.01% (50%) | 0.39 / 1.03 | 0.018 / 0.011 | ~940 / ~210 |
| USDC/cbBTC 0.05% (40%) | 3.02 / 4.02 | 0.020 / 0.013 | ~135 / ~65 |
| WETH/USDC 0.3% (10%) | 1.66 / 2.81 | 0.020 / 0.014 | ~235 / ~100 |

So with A-k20-T7d an account of **about 250 USDC** harvests its volatile pools at least weekly on the k rule, and
**about 1,000 USDC** for the stables pool; smaller accounts still harvest, through T, once fees cover the cost once
(about 0.02 USDC). Captured net savings were positive at 100 USDC in every split. A base fee 10× higher moves every
floor 10× up.

## Recommendation for #107

1. **"Profits become USDC" is honest at k = 20, T = 7 d, for all three pools**, priced on the real cost of a collect
   plus a swap (not the 5.1M-gas userOp budget live uses). It keeps almost all the fees: 95-97% net of cost against
   96-99% for live and B. What it costs: about **2 pp more of the fees** than live (3.9% vs 1.7% at 1,000, TEST),
   i.e. 0.4-0.6 USDC per 1,000 per month; the same as compounding in kind (B).
2. **Do not sell it as protection.** The exposure it removes is small and two-sided: +0.4 USDC per 1,000 in the
   TEST crash week (0.04% of the account), −0.3 over all TEST windows. It neither raises nor lowers value vs hold in a
   way the Lab can tell apart from re-range path noise (means within ±0.15 pp of live at ≥ 1,000).
3. It does what Ot asked of policy A: no harvest is ever undone, the savings sit outside the target weights, and the
   principal's drift stays where it is (mean 0.73-1.23% for every arm, measured from entry; no arm consistently above
   another).
4. Do not ship k ∈ {2, 3, 5}: they spend 10-43% of the fees on cost (TRAIN, by deposit). Keep the absolute floor from #156; at k = 20 the
   k rule needs ~250 USDC per account for weekly harvests on the volatile pools.
5. The engine change it needs (#107, not this ticket): a harvest trigger on the real collect+swap cost with k and T,
   a separate swap op for the volatile part (or a convert bound to the collected amount, #140), and a savings ledger
   the allocator does not see.

## Limits and caveats

- **Windows are short.** Crash windows are 7 days and exposure is measured to the window's end: a fall that
  recovers inside the window shows as exposure added (oct2025, feb2026). Over months, the sign of (3) is the sign of
  BTC/ETH's drift.
- **Re-range path noise.** Arms that change when fees leave the account change later entries and re-ranges; value vs
  hold moves by up to ±0.5 pp per window for reasons unrelated to harvesting (one re-range more or less). Read
  captured and cost, which are attributed per harvest, before value vs hold.
- **Gas units for collect and increase are estimates** with no live receipt; the swap is a live median. Collect +
  swap is modelled as two userOps (two L1 fees). A single batched op would lower A's cost.
- **Arm operations and the one-op rule.** A swap of its own (pending fees in a pool with no position) also takes the
  review's operation.
- **B is a simple compounder**: it adds what fits the range and leaves the rest idle; a Beefy-style swap to ratio
  would cost one more op.
- **Arm operations bypass sessions.** On chain they would draw on the `convert-any` grant's usage, which #149 sized
  for live's harvest rate; A-k20 harvests ~1.1× as often as live and swaps once per harvest.
- **Savings yield** is an assumption (stable pool return, no deposit gas, no depeg haircut), and immaterial.
- **No Monad** (no Lab windows), **aug2024** skipped (no cbBTC). One draw of each window's start; the round-3 offsets
  study showed up to 0.5 pp of start noise in returns.
- Dataset ids are those of the files (below); the sweep cuts each to its window's blocks, so each run's own id differs.

## Data

| Window | Split | File | Dataset id (file) |
|---|---|---|---|
| sep2026 | train | base-30d-5m.json | 0xce812243…3bd3c823 |
| oct2025 | train | base-2025-10-crash-10m.json | 0x62eb8ee7…f211efc06 |
| feb2025 | train | base-2025-02-crash-10m.json | 0x1038178a…e0c45e8a |
| mar2025 | train | base-2025-03-crash-10m.json | 0x3ef17c22…60cee341 |
| dec2024 | train | base-2024-12-rally-10m.json | 0xadd6f12a…beffb729e |
| calm-2025-09 | train | base-2025-09-calm-10m.json | 0xf15b619d…281c965825 |
| calm-2026-04 | train | base-2026-04-calm-10m.json | 0x0c6446ab…3645f31e0d |
| aug2024 | train | base-2024-08-crash-10m.json | skipped (no cbBTC) |
| apr2025 | test | base-2025-04-crash-10m.json | 0xf3e15168…87387f20 |
| may2025 | test | base-2025-05-rally-10m.json | 0x90ae3fc6…cf905428 |
| jun2025 | test | base-2025-06-calm-10m.json | 0xe4448ef4…f1c5ba0bf5 |
| calm-2026-05 | test | base-2026-05-calm-10m.json | 0xd60e4132…29f4282e |
| feb2026 | test | base-2026-02-usdt-10m.json | 0x950bdeee…4c2bd598bf |

Raw: `harvest-2026-10-23/{train,test}.sweep.json` (every cell, result hash per cell; the hash names the arm),
`raw/harvest-{train,test}.md` (per window × deposit × arm, all 7 metrics), `raw/harvest-{train,test}-score.md`
(aggregates, pick, minimum deposit, floor).

## Reproduce

```
bun packages/backtest/cli/sweep.ts --variants specs/004-loss-control/results/harvest-2026-10-23/variants-train.json --deposits 100,500,1000,5000,25000 --jobs 4
bun packages/backtest/cli/sweep.ts --variants specs/004-loss-control/results/harvest-2026-10-23/variants-test.json --split test --deposits 100,500,1000,5000,25000 --jobs 4
bun specs/004-loss-control/results/harvest-2026-10-23/score.ts <train sweep.json>
bun specs/004-loss-control/results/harvest-2026-10-23/score.ts <test sweep.json> --pick A-k20-T7d,B-k20
bun specs/004-loss-control/results/harvest-2026-10-23/score.ts <sweep.json> --cells
```

TRAIN: 760 cells, 323 s on 4 jobs. TEST: 100 cells, 33 s.

## Revision after review

Review of a1637b0 (GPT-6 Sol): NO APTO, five P1 measurement findings. Fixed in `backtest/src/{harvest,run}.ts`, one
test per finding in `harvest.test.ts` ("review fixes"), TRAIN and TEST re-run.

| # | Finding | Fix |
|---|---|---|
| 1 | Savings arm moved a re-range's or reduce's fees to the ledger and cleared them from the position before the operation ran, so an operation that failed still credited them. | The fees are diverted only after the operation went through, from what its collect credited to the account (refused if the account does not hold them). Every run now checks that each fee unit earned, per token, was collected or is still owed. With the current simulator a decrease can only fail for a missing position, so no published cell was affected by this one; the order is now right regardless. |
| 2 | Volatile fees left waiting by a re-range in a pool with no position were never sold, yet counted in captured at full end value, with no swap cost. | They are sold in a swap of their own when they meet the k rule (cost: swap gas + fee and impact). Until sold they are reported as *unconverted*, outside captured. At the end of the re-run, unconverted is at most 0.44 USDC in a cell (0.17 at the pick). |
| 3 | Drift started only when the first pool of each bucket had a position. | A bucket is entered, and valued, through any of its pools. (Every bucket of `conservador-live-v2` has one pool, so this changes no cell here.) |
| 4 | Drift samples were discarded until weights first came within the 3% band. | Sampled from entry, whatever the distance. Mean drift moved by at most 0.08 pp; the conclusion that no arm drifts more stands. |
| 5 | B's captured valued the compounded fees as tokens held to the end. | Valued as the share of each position the compounded liquidity bought (amounts and fees owed on it), plus what stayed in kind. |

Before → after on the headline table (TEST, mean captured, USDC):

| Deposit | live | A-k20-T7d | B-k20 | A − B |
|---|---|---|---|---|
| 100 | 1.77 → 1.77 | 1.71 → 1.70 | 1.71 → 1.71 | -0.00 → -0.01 |
| 500 | 9.28 → 9.28 | 8.90 → 8.88 | 9.03 → 8.99 | -0.13 → -0.10 |
| 1,000 | 18.54 → 18.54 | 17.90 → 17.88 | 18.27 → 18.15 | -0.37 → -0.28 |
| 5,000 | 89.61 → 89.61 | 88.56 → 89.64 | 90.63 → 90.04 | -2.07 → -0.41 |
| 25,000 | 417.21 → 417.21 | 414.76 → 415.45 | 423.92 → 421.19 | -9.16 → -5.75 |

TRAIN score of the picks: A-k20-T7d 91.91 → 90.87%, B-k20 90.07 → 89.78%. What changed: B was overstated (finding 5),
by up to 0.7% of fees; A at 100 USDC was overstated by the pending fees (finding 2); A at 5,000 and 25,000 TEST rose
because selling stranded fees changed later harvests (path). What did not: the picks (k = 20, T = 7 d), the arm
order, A losing to B on mean captured at every TEST deposit and winning on crash exposure, no minimum deposit in the
grid, the floor (~250 USDC volatile pools, ~1,000 stables pool), and the recommendation.
