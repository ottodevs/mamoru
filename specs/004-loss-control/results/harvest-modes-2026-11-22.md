# 004 Lab: where harvested yield goes (four modes), 22 Nov 2026

Ticket otto/mamoru#413. The owners have since chosen mode B. This run validates that choice and the thresholds B
needs. Lab only: `packages/decide` and `apps/*` are unchanged. The simulator changes are in `packages/backtest`, and every
earlier run gives the same result hash (tests). Everything below is net of the 10 % fee on realized yield (collected
fees plus vault growth; fees still owed are not charged).

## Answer

| Mode | Return after fee vs A | Savings built (USD, sum of the 5 TEST windows) | Gas vs A | Worst point vs deposit (offset 0) | In one line |
|---|---|---|---|---|---|
| A, today (HRV-R3: harvest back by target weight) | 0 | 0 | 1,000: 12.3 USD · 100,000: 73 USD | -8.04 % / -7.93 % | Principal grows from fees. No savings. |
| **B, savings in the Stable vault, outside the targets** | 1,000: **-0.11 pp** · 100,000: **-0.08 pp** | 1,000: **107.5 USD** · 100,000: **9,081 USD** (96-99 % of fees accrued) | 1,000: -44 % · 100,000: +45 % | -6.99 % / -7.84 % | What it promises: almost every fee ends up as USDC savings. It costs about a tenth of a point, which is inside the noise. |
| C, reinvest in the same pool | -0.10 pp · -0.20 pp | 0 | -49 % · +39 % | -7.09 % / -7.84 % | No better than A, and no savings. |
| D, C then B on the pool's APR | -0.10 pp · -0.16 pp | 1.1 USD · 112 USD | as C | as C | At the TRAIN thresholds it almost never switches, so it behaves as C. Not worth building. |

- The first three columns are the mean of the three TEST start offsets (0, 30, 60 min; `robustness.md`): return after fee and gas averaged per window, savings and gas summed over the 5 windows. At offset 0 alone (`test-score.md`), B built 107.74 and 9,069.21 USD. Over the 5 TEST windows (about 2.5 months) the "pp" are percentage points of the deposit. The worst point is the lowest
  value of the account, savings included, net of gas, over all TEST windows at offset 0 (1,000 / 100,000).
- **Recommendation: B, as decided.** Keep the swap trigger at k = 50 with the 7-day cap. Use 1 USDC as the smallest
  sweep for small accounts. Give large accounts a daily sweep or a size-scaled floor (see "B's thresholds"). Do not build
  C or D.
- **The trade-off of B:** the principal no longer grows from its own fees. In return, almost every fee is out of the
  pools and safe in USDC. The cost measured here is about 0.1 pp over 2.5 months, which is smaller than the noise between
  start offsets (up to 0.25 pp). It does not cut the worst drawdown on average. In the sudden dump (apr2025) B came out
  ahead at 100,000 by +610 to +660 USD at every offset. In the sustained fall (feb2026) and in the dip that recovers
  (jun2025) it came out behind, by -150 to -790 USD.

## Setup

- **Account:** v8 weights, Stable 50 / WETH-USDC 0.3 % 25 / USDC-cbBTC 0.05 % 25 (`lab-413-v8like`).
  - The pool simulator has no vault, so the Stable bucket is the USDC/USDT 0.01 % LP, as in #406. Only mode B's savings
    layer uses the vault: gtUSDCp's daily share price from the Morpho API, the series #186 read.
  - Sessions, range (2,000 ticks) and the engine's own harvest rule are conservador-live-v2's.
  - The engine settings are #406's production baseline (lazy re-range). The weekly re-range cap is not applied: main's
    backtest skips it, and #406 fixes that.
  - Monad is left out. There is no WMON dataset, and Monad is being exited.
- **Deposits:** 1,000 and 100,000 USDC. Production `decide` reviews every sample (5 or 10 min), sessions are enforced, and
  no session refused anything.
- **Windows:** the Lab's fixed split (`windows.ts`). aug2024 is skipped (no cbBTC on Base yet).

  | Scenario | TRAIN | TEST |
  |---|---|---|
  | Sustained fall | feb2025, mar2025 | feb2026 |
  | Sudden dump (MON-unlock-like) | oct2025 | apr2025 |
  | Rally | dec2024 | may2025 |
  | Fall then recover | — | jun2025 |
  | Sideways | sep2026, calm-2025-09, calm-2026-04 | calm-2026-05 |

- **Modes in the simulator** (`packages/backtest/src/harvest.ts`):
  - **A** is `live`: `decide` as it is. The run only measures.
  - **B** is `savings` with the new `vault` sink. A position is harvested when its fees reach k × (collect + swap + the
    swap's pool fee and impact), or after 7 days once they cover that cost. The volatile part is sold in its own op, and
    the USDC joins the savings layer, which is never in the bucket weights (`allocate` never sees it). The layer waits as
    USDC until max(1 USDC, s × the gas of a vault deposit) is reached. One deposit (797k gas, as #186) then puts it in,
    and from there it grows with gtUSDCp's share price. The fees a re-range or reduce collects go there too. No redeem is
    charged: no mode pays the exit of its positions.
  - **C** is `compound`: collect, then `increaseLiquidity` into the same position with what fits its range. The rest stays
    in the account.
  - **D** is the new `switch`, per pool. A pool's APR counts only when its positions were held over at least half the
    window; otherwise its mode stays. Added after review: TRAIN-d and TEST were re-run with it, and every cell came out byte-identical. It acts as C while the pool's trailing fee APR (fees over the time-weighted value
    of its positions) is at or above the exit threshold. Below it, it acts as B. It returns to C only above the enter
    threshold. Each pool starts in C and keeps it until it has a full APR window of history.
- **New `engine` order:** an arm's operation now sits where the engine would put it. A re-range or merge first (a merge
  is kind `rerange`), then the arm's harvest (the harvest slot), then `decide`'s other proposals. One review, one
  operation, as in the engine: a review that re-ranges does not also harvest. A vault deposit goes only on a review where `decide`
  proposes nothing. The old order (the arm first, which delays a due re-range) stays the default, so earlier results
  reproduce.
- **Metrics per cell:**
  - Net after fee: end value (positions, idle, savings layer) net of gas, minus the deposit, minus 10 % of realized yield.
    Against idle USDC, the gap is the same number.
  - Against hold (the first entry mix, held), after the fee.
  - Worst point against the deposit, and the largest fall from a high.
  - Savings built (USD), fees accrued, gas, and operations (every userOp, the arm's own included).

### Selection protocol (fixed before TRAIN ran)

1. Score per variant: the mean over TRAIN cells (windows × deposits) of the return after fee, in % of the deposit. Ties
   within 0.005 pp go to fewer operations.
2. Pick B (k ∈ {10, 20, 50} × s ∈ {0, 20, 100}) and C (k ∈ {10, 20, 50}) first. Then pick D's APR thresholds (exit/enter
   ∈ {5/10, 10/20, 20/40, 40/80 %} × window ∈ {1, 3 days}), using B's pick for its harvest and sweep rule.
3. TEST runs once with the picks. Start offsets of 30 and 60 minutes (each window starts later, its end stays), declared
   before TEST, only measure how much of a gap is path rather than rule.

**A first pass was discarded** (`harvest-modes-2026-11-22/discarded-first-order/`). It ran in the old order, with the
arm's harvest ahead of `decide`. At 100,000 that pushed due re-ranges back almost every review, and its TEST showed gaps
between modes of up to 1,000 USD that the destination of a fee cannot produce. That TEST pass had been looked at.

- What changed after it: only the order, which matches the engine now.
- What stayed the same: the grid and the rule.
- Then TRAIN was run again from scratch and its picks written down, and only then was TEST run, once.
- The discarded picks were B k20/s100, C k50 and D 40/80 %/3 d. The new ones are B k50/s100, C k50 and D 5/10 %/1 d.

## TRAIN

`harvest-modes-2026-11-22/train-score.md` has the full table; `train-savings.md` has B's grid. Mean return after fee, over
14 cells:

| Variant | Score | at 1,000 | at 100,000 | Ops |
|---|---|---|---|---|
| A live | -0.884 | -0.960 | -0.807 | 11,562 |
| B k10 (s0 / s20 / s100) | -0.947 / -0.945 / -0.939 | ≈ -1.05 | ≈ -0.83 | ≈ 26,400 |
| B k20 (s0 / s20 / s100) | -0.965 / -0.965 / -0.959 | ≈ -0.98 | ≈ -0.95 | ≈ 20,700 |
| **B k50 (s0 / s20 / s100)** | -0.878 / -0.878 / **-0.877** | -0.936 | -0.817 | 13,686 (s100) |
| C k10 / k20 / **k50** | -0.936 / -0.919 / **-0.906** | | | 24,626 / 19,271 / 12,669 |
| **D 5/10 % 1 d** (best of 8; the others -0.905 to -1.002) | **-0.899** | -0.927 | -0.870 | 12,836 |

**Picks:** B = k50, T 7 d, s100 · C = k50 · D = k50, T 7 d, s100, APR 5 %/10 % over 1 day.

## TEST (offset 0, run once; `test-score.md`, cells in `test-cells.md`)

Sums per scenario, USD. "vs hold" and "net" are after the fee.

| Scenario | Deposit | A net / vs hold | B net / vs hold | C net / vs hold | D net / vs hold | B savings built |
|---|---|---|---|---|---|---|
| sudden dump (apr2025) | 1,000 | -53.07 / -11.28 | -56.13 / -14.35 | -57.35 / -15.57 | -57.37 / -15.58 | 14.93 |
| rally (may2025) | 1,000 | +32.28 / -24.47 | +32.36 / -24.39 | +32.57 / -24.18 | +32.57 / -24.18 | 11.27 |
| fall then recover (jun2025) | 1,000 | -13.49 / -14.43 | -12.55 / -13.49 | -12.96 / -13.91 | -12.99 / -13.93 | 23.57 |
| sideways (calm-2026-05) | 1,000 | -15.31 / +3.57 | -15.20 / +3.69 | -15.41 / +3.48 | -15.43 / +3.45 | 13.35 |
| sustained fall (feb2026) | 1,000 | -10.58 / +8.74 | -18.97 / +0.35 | -14.74 / +4.58 | -14.74 / +4.58 | 44.62 |
| sudden dump (apr2025) | 100,000 | -6,813 / -2,634 | -6,158 / -1,979 | -6,552 / -2,373 | -6,344 / -2,165 | 875.51 |
| rally (may2025) | 100,000 | +2,912 / -2,763 | +3,008 / -2,667 | +3,014 / -2,661 | +3,010 / -2,665 | 992.32 |
| fall then recover (jun2025) | 100,000 | -436 / -531 | -1,017 / -1,111 | -939 / -1,033 | -930 / -1,024 | 2,367.90 |
| sideways (calm-2026-05) | 100,000 | -1,755 / +134 | -1,753 / +135 | -1,771 / +118 | -1,770 / +118 | 1,153.54 |
| sustained fall (feb2026) | 100,000 | +64 / +1,996 | -724 / +1,208 | -1,302 / +630 | -1,303 / +629 | 3,679.94 |

Worst point against the deposit, the lowest window (A / B / C / D):
- 1,000: -8.04 / -6.99 / -7.09 / -7.09 %.
- 100,000: -7.93 / -7.84 / -7.84 / -7.84 %. At 100,000 in feb2026 alone, B's lowest point was -7.49 % against A's -6.25 %.

### Robustness (`robustness.md`)

Mean return after fee over the 5 TEST windows, by start offset:

| Mode | 1,000: 0 / 30 / 60 min | mean | 100,000: 0 / 30 / 60 min | mean |
|---|---|---|---|---|
| A | -1.203 / -1.246 / -1.154 | -1.201 | -1.206 / -1.360 / -1.108 | -1.225 |
| B | -1.410 / -1.259 / -1.258 | -1.309 | -1.329 / -1.411 / -1.171 | -1.304 |
| C | -1.358 / -1.284 / -1.249 | -1.297 | -1.510 / -1.334 / -1.432 | -1.425 |
| D | -1.359 / -1.283 / -1.256 | -1.299 | -1.467 / -1.282 / -1.400 | -1.383 |

The order of the modes changes with the offset: at 30 minutes, D is first at 100,000. A is first in 5 of the 6
offset × deposit cases (third at 100,000, 30 minutes). B is 0.01-0.21 pp behind A, depending on the offset and the deposit.

**Why the gaps are path, not the rule:** at 100,000 some single-window gaps between modes reach 500-800 USD, while that
window's fees are 0.9-4.8k. Keeping the fees out of the pools (B) or putting them back (A, C) moves at most those fees'
own exposure: B's "exposure removed" is tens of USD. The rest comes from the engine taking different re-range and entry
paths once one operation lands on a different review. For example, feb2026 at 100,000: A accrued 4,825 USD of fees, B
3,706.

## B's thresholds (owners' follow-ups)

- **Swap trigger.** k = 50 (harvest when fees ≥ 50 × collect + swap cost; after 7 days once they cover it) beat k = 10 and
  k = 20 on TRAIN at both deposits.
  - Less gas and half the operations: at 1,000, 7.5 USD of gas against 15.1 at k10 over the TRAIN windows. At 100,000,
    169 against 355.
  - Savings built still 94-99 % of fees accrued.
  - The #178 pick (k20, T 7 d) was for the v2 mix.
- **Smallest sweep.** s ∈ {0, 20, 100} × the deposit gas, never under 1 USDC: within 0.006 pp of each other.
  - At 1,000, sweeps fall from 66 to 61 over the TRAIN windows, and 1.5-3 USD waits at the end of each run.
  - At 100,000, the gas-based floor (about 1.5 USD at s100) never binds. The account sweeps about 20 times a day: 1,916
    deposits over the TRAIN windows, 47 USD of gas.
  - A floor scaled to the account (e.g. 0.1 % of it) or one sweep a day would cut that. Not tested here.
  - The 1 USDC floor (v7/v8 engine `vaultMinDeposit`) is right for small accounts.
- **Vault yield on savings** is small inside a window: 0.14 USD on about 106 USD saved at 1,000 over the TRAIN windows,
  16 USD on 10.9k at 100,000. It grows with time, since savings pile up.
- **Effect of keeping savings out of the targets** (B against A, both on v8 weights):
  - The principal stays near the deposit instead of growing from fees.
  - About -0.1 pp of return over 2.5 months, inside the noise.
  - 96-99 % of fees end in USDC.
  - No change to the worst drawdown on average.
  - The rejected variant (savings inside Stable's 50 %) was not simulated.

## Limits

- The Stable bucket is an LP in the simulator, not the vault. Only B's savings layer is the vault.
- No weekly re-range cap (main's backtest; #406).
- No Monad and no withdrawals: B's "savings go out first" is not exercised.
- Windows are 1-4 weeks. B's compounding loss and its savings' vault yield both grow over months, and neither is measured
  here past a month.
- The 10 % fee is taken at the end on realized yield, not at each collect.
- D's APR is the fee APR of the pool's own positions, read from the simulator. On chain it would come from
  `yield_ledger_income`.

## Files

- `packages/backtest/src/harvest.ts`: the vault sink, the switch arm, realized yield.
- `packages/backtest/src/run.ts`: the vault share price, per-pool APR intervals, the `engine` order.
- `packages/backtest/src/types.ts`: `vaultPrices`, `labHarvestOrder`.
- `packages/backtest/src/harvest-modes.test.ts`: tests.
- `packages/backtest/lab/harvest-modes-413.ts`: the runner, the grid and the picks.
- `harvest-modes-2026-11-22/`: stage JSON, `score.ts`, the score, cell and robustness tables, and the discarded pass.
