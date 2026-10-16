# 004 Lab: rebalance policy (experiments 4 and 6), 16 Oct 2026

Ticket otto/mamoru#101. Research note: noema `1-projects/mamoru/research/capital-protection/lp-risk-experiments-2026-10-16.md`
(experiments 4 and 6). Lab-only policy options, off by default; `conservador-live-v2` is unchanged byte for byte.

Simulator `backtest-1`, production `decide`, review every sample, session limits enforced, deposits 5, 1,000 and
100,000 USDC. TRAIN: 7 windows that have cbBTC (aug2024 is skipped by every variant). TEST: 5 windows, each candidate
run **once**. Variant files: `results/variants/*.json`; full per-cell tables: `results/raw/rebalance-*.md`.

## Protocol (declared before the TRAIN grid ran)

- Primary, at 1,000 and at 100,000: lower mean max drawdown, lower worst max drawdown, better worst-window return.
- Constraint: mean return not worse than baseline by more than 0.10 pp at either deposit.
- Experiment 4 also: fewer ops and less gas at equal return.
- Ranking: pass the constraint, then primary criteria won (of 6), then the sum of the primary deltas.
- At most 2 candidates per experiment to TEST; the combination picked on TRAIN, then run once on TEST.
- Noise: moving a window's start by one sample moves its return by up to 0.5 pp, so per-window deltas under 0.5 pp
  are counted apart.

The 5 USD column is reported but not judged: at that size the simulator charges gas against the account until the
value goes below zero (baseline worst TEST return -252%), so its numbers measure gas, not policy.

## What was built

| Option | Where | Rule |
|---|---|---|
| `range.lazy { edgeBufferTicks, minDwellSeconds, horizonSeconds, lvrWeightBps }` | `decide/src/rebalance/lazy.ts`, `rerange/index.ts` | No near-edge trigger. Re-range only when the tick is past the edge by the buffer, has been out of range for the dwell, and the fees a new centred range of the same value would earn over H (pool fee growth of the last 24 h, diluted by active liquidity, as the simulator credits fees) exceed 3 ops of gas at the engine's userOp budget + the pool fee on half the value + LVR over H (sigma^2/4 * L * sqrt(P), sigma = 24 h realized vol). Missing history: the cost test abstains. New code `DECIDE_RANGE_BELOW_COST`; dwell waits use `DECIDE_RANGE_COOLDOWN`. |
| `volTarget { targetVolBps, bandBps, stepBps }` | `decide/src/rebalance/weights.ts` | Volatile preference x min(1, sigma*/sigma_24h), stables absorb the rest; the scale moves on a `stepBps` grid with hysteresis (keeps the level nearest the holdings within +-`bandBps` of vol). Without the grid and band the first run churned (vt45: 927 ops vs 547 at 1,000, reduce/re-buy loops in the October cascade). |
| `cppi { floorBps, multiplier }` | same | Volatile buckets together <= multiplier x (value - floorBps x peak), never above their preferences. Peak tracked by the run (engine would persist it). |

All steps read the scaled preferences; `Decision.policyRef` still names the policy as given, and `Decision.targets`
appears only when an overlay is set. "At most one bucket move per review" holds by construction: `decide` proposes one
operation per review, and a weight change moves money through the ordinary reduce (5 pp drift band) and entries.

## Experiment 4: lazy, cost-aware re-range (TRAIN grid, 24 variants)

H {6 h, 24 h} x buffer {0, 100, 200, 400} x dwell {0, 30, 120} min, LVR weight 1. Selected rows (deltas vs baseline, pp;
full ranking in `raw/rebalance-exp4-train.md`):

| Variant | Pass Δmean | Primary won /6 | Σ primary Δ | dep | mean Δ | mean DD Δ | worst DD Δ | worst ret Δ | ops (base) | gas (base) |
|---|---|---|---|---|---|---|---|---|---|---|
| lazy-h24h-b100-d30 | yes | 2 | -1.08 | 1000 | +0.09 | -0.05 | +0.39 | -0.46 | 386 (547) | 5.38 (13.12) |
| lazy-h24h-b100-d30 | yes | 2 | -1.08 | 100000 | +0.05 | +0.13 | +0.45 | +0.29 | 1051 (1036) | 22.06 (49.80) |
| lazy-h24h-b100-d30 | yes | 2 | -1.08 | 5 | +12.92 | -11.35 | -20.53 | +21.46 | 45 (156) | 0.98 (5.43) |
| lazy-h6h-b200-d120 | yes | 1 | -1.58 | 1000 | +0.26 | +0.01 | +0.39 | -0.97 | 363 (547) | 4.80 (13.12) |
| lazy-h6h-b200-d120 | yes | 1 | -1.58 | 100000 | +0.10 | +0.13 | +0.45 | +0.36 | 1019 (1036) | 21.75 (49.80) |
| lazy-h6h-b200-d120 | yes | 1 | -1.58 | 5 | +12.89 | -11.32 | -20.53 | +21.46 | 45 (156) | 0.98 (5.43) |
| lazy-h6h-b0-d0 | yes | 1 | -1.86 | 1000 | +0.26 | +0.00 | +0.39 | -0.87 | 353 (547) | 4.94 (13.12) |
| lazy-h6h-b0-d0 | yes | 1 | -1.86 | 100000 | -0.08 | +0.18 | +0.45 | +0.02 | 1098 (1036) | 23.96 (49.80) |
| lazy-h6h-b0-d0 | yes | 1 | -1.86 | 5 | +11.92 | -10.35 | -19.98 | +21.46 | 60 (156) | 1.32 (5.43) |
| lazy-h24h-b400-d120 | yes | 1 | -1.95 | 1000 | +0.07 | +0.01 | +0.39 | -1.34 | 362 (547) | 5.14 (13.12) |
| lazy-h24h-b400-d120 | yes | 1 | -1.95 | 100000 | +0.10 | +0.13 | +0.45 | +0.36 | 1020 (1036) | 21.75 (49.80) |
| lazy-h24h-b400-d120 | yes | 1 | -1.95 | 5 | +12.89 | -11.32 | -20.53 | +21.46 | 45 (156) | 0.98 (5.43) |
| lazy-h24h-b0-d0 | no | 0 | -4.10 | 1000 | -0.23 | +0.14 | +0.39 | -2.26 | 382 (547) | 5.58 (13.12) |
| lazy-h24h-b0-d0 | no | 0 | -4.10 | 100000 | -0.22 | +0.27 | +0.45 | -0.60 | 1114 (1036) | 24.11 (49.80) |
| lazy-h24h-b0-d0 | no | 0 | -4.10 | 5 | +11.92 | -10.35 | -19.98 | +21.46 | 60 (156) | 1.32 (5.43) |

Reading:

- **Every variant passes the return constraint and none passes the primary objective.** Worst max drawdown is
  +0.39 pp (1,000) and +0.45 pp (100,000) for all 24: positions left out of range in a fall hold the volatile token
  longer. Mean drawdown moves by less than 0.2 pp. It is a cost lever, not a drawdown lever.
- **Gas falls by 55-65% at every size**: 1,000: 13.12 -> 4.7-5.4 USD over the 7 windows, ops 547 -> 348-391;
  100,000: 49.80 -> ~22 USD. At 5 USD: ops 156 -> 45, gas 5.43 -> 0.98, mean return +12.9 pp (gas was the loss).
- With the full LVR term the cost test almost never says yes at 1,000 (e.g. sep2026: zero re-ranges): estimated LVR
  of a 2,000-tick range at sigma 35-45% (~0.3-0.5%/day) exceeds its estimated fees. The buffer and dwell barely
  matter once the cost test is on; H matters through gas only (fees and LVR both scale with H).
- At 100,000 ops do not fall: the baseline already re-ranges rarely there, because harvests spend the `convert-any`
  usage limit and later proposals are refused (sep2026: 8,111 `SESSION_USAGE_SPENT` reviews). That is a separate
  baseline finding (below).

Candidates: **lazy-h24h-b100-d30** (best primary sum) and **lazy-h6h-b200-d120** (fewest ops, best mean at 1,000).

## Experiment 6: volatility target and CPPI (TRAIN grid, 12 variants)

| Variant | Pass Δmean | Primary won /6 | Σ primary Δ | dep | mean Δ | mean DD Δ | worst DD Δ | worst ret Δ | ops (base) | gas (base) |
|---|---|---|---|---|---|---|---|---|---|---|
| cppi90-m2 | yes | 6 | 19.65 | 1000 | +0.22 | -2.18 | -4.55 | +2.13 | 344 (547) | 7.91 (13.12) |
| cppi90-m2 | yes | 6 | 19.65 | 100000 | +0.20 | -2.06 | -4.54 | +4.20 | 1249 (1036) | 48.18 (49.80) |
| cppi85-m2 | yes | 6 | 11.99 | 1000 | +0.08 | -1.38 | -2.78 | +1.29 | 422 (547) | 13.00 (13.12) |
| cppi85-m2 | yes | 6 | 11.99 | 100000 | +0.02 | -1.17 | -3.06 | +2.30 | 1190 (1036) | 52.68 (49.80) |
| vt60-s2500 | yes | 3 | 0.30 | 1000 | -0.05 | -0.09 | +0.01 | -0.21 | 718 (547) | 18.80 (13.12) |
| vt60-s2500 | yes | 3 | 0.30 | 100000 | +0.01 | -0.06 | +0.01 | +0.38 | 1232 (1036) | 59.95 (49.80) |
| cppi85-m5 | yes | 0 | -0.01 | 1000 | +0.00 | +0.00 | +0.00 | +0.00 | 547 (547) | 13.12 (13.12) |
| cppi85-m5 | yes | 0 | -0.01 | 100000 | -0.00 | +0.00 | +0.01 | +0.00 | 1038 (1036) | 55.38 (49.80) |
| cppi90-m3 | no | 6 | 11.51 | 1000 | +0.06 | -1.37 | -2.55 | +1.13 | 509 (547) | 15.82 (13.12) |
| cppi90-m3 | no | 6 | 11.51 | 100000 | -0.11 | -1.15 | -3.02 | +2.29 | 1349 (1036) | 56.15 (49.80) |
| cppi85-m3 | no | 6 | 4.84 | 1000 | -0.10 | -0.29 | -0.50 | +0.28 | 690 (547) | 17.16 (13.12) |
| cppi85-m3 | no | 6 | 4.84 | 100000 | +0.26 | -0.57 | -0.73 | +2.47 | 1210 (1036) | 66.94 (49.80) |
| vt30-s5000 | no | 4 | -0.47 | 1000 | -0.59 | -0.31 | +0.27 | -0.76 | 1011 (547) | 27.68 (13.12) |
| vt30-s5000 | no | 4 | -0.47 | 100000 | -0.18 | -0.11 | -0.04 | +0.09 | 1258 (1036) | 57.05 (49.80) |
| vt45-s2500 | no | 4 | -0.58 | 1000 | -0.19 | -0.02 | -0.01 | -0.73 | 779 (547) | 24.90 (13.12) |
| vt45-s2500 | no | 4 | -0.58 | 100000 | -0.08 | -0.05 | +0.01 | +0.09 | 1256 (1036) | 69.40 (49.80) |
| vt45-s5000 | no | 3 | -1.13 | 1000 | -0.15 | +0.11 | -0.04 | -1.21 | 871 (547) | 22.50 (13.12) |
| vt45-s5000 | no | 3 | -1.13 | 100000 | -0.09 | -0.06 | +0.01 | +0.09 | 1286 (1036) | 62.63 (49.80) |
| vt60-s5000 | no | 2 | -0.90 | 1000 | -0.23 | +0.15 | +0.00 | -0.86 | 718 (547) | 19.79 (13.12) |
| vt60-s5000 | no | 2 | -0.90 | 100000 | -0.10 | -0.01 | +0.01 | +0.09 | 1188 (1036) | 60.94 (49.80) |

Reading:

- **Volatility target fails**: no sigma* passes both the constraint and the primary objective with a clear margin;
  vt60-s2500 is neutral (+-0.1 pp) at 30% more ops. 24 h realized vol of the 30-min TWAP reacts after the move, and
  every weight change costs a reduce, a convert and an entry.
- **CPPI with multiplier 2 passes everything on TRAIN**: cppi90-m2 lowers worst max drawdown by 4.5 pp at both sizes
  and mean drawdown by ~2.1 pp, with mean return +0.2 pp. Multiplier 5 at an 85% floor never binds (identical to
  baseline).
- **It is mostly lower exposure from the start**: m2 at a 90% floor allows 20% volatile instead of 50% on day one.
  Per window (below) it wins every crash and loses 1.2-1.7 pp in every calm or rally window. The positive mean is
  TRAIN having 3 crashes of 7.


**cppi90-m2** (delta vs baseline, pp; ops)

| Window | dep | return | Δ return | Δ max DD | ops (base) | gas (base) |
|---|---|---|---|---|---|---|
| windows improved at 5 | | 6/7 | of them > 0.5 pp: 6 | | | |
| sep2026 | 1000 | 0.91 | -1.65 | -0.79 | 51 (72) | 0.53 (0.73) |
| oct2025 | 1000 | -1.36 | +1.96 | -4.55 | 28 (79) | 1.61 (3.95) |
| feb2025 | 1000 | -1.46 | +2.13 | -3.45 | 54 (98) | 1.57 (2.57) |
| mar2025 | 1000 | -1.30 | +2.22 | -2.59 | 94 (122) | 0.81 (0.93) |
| dec2024 | 1000 | 0.89 | -1.18 | -1.16 | 27 (36) | 2.02 (2.91) |
| calm-2025-09 | 1000 | 0.39 | -0.22 | -1.89 | 66 (93) | 1.15 (1.61) |
| calm-2026-04 | 1000 | 1.14 | -1.72 | -0.81 | 24 (47) | 0.21 (0.42) |
| windows improved at 1000 | | 3/7 | of them > 0.5 pp: 3 | | | |
| sep2026 | 100000 | 0.88 | -1.24 | -0.83 | 165 (161) | 26.02 (25.95) |
| oct2025 | 100000 | -1.25 | +1.69 | -4.54 | 150 (162) | 4.56 (4.21) |
| feb2025 | 100000 | -1.17 | -0.35 | -1.44 | 224 (197) | 3.92 (3.27) |
| mar2025 | 100000 | -1.38 | +4.20 | -4.20 | 209 (152) | 1.62 (1.41) |
| dec2024 | 100000 | 1.14 | -1.19 | -0.57 | 133 (125) | 9.06 (11.87) |
| calm-2025-09 | 100000 | 0.61 | -0.28 | -1.97 | 203 (83) | 1.60 (1.75) |
| calm-2026-04 | 100000 | 0.95 | -1.42 | -0.90 | 165 (156) | 1.41 (1.35) |
| windows improved at 100000 | | 2/7 | of them > 0.5 pp: 2 | | | |

**cppi85-m2** (delta vs baseline, pp; ops)

| Window | dep | return | Δ return | Δ max DD | ops (base) | gas (base) |
|---|---|---|---|---|---|---|
| windows improved at 5 | | 3/7 | of them > 0.5 pp: 3 | | | |
| sep2026 | 1000 | 1.45 | -1.10 | -0.53 | 58 (72) | 0.63 (0.73) |
| oct2025 | 1000 | -2.29 | +1.04 | -2.78 | 34 (79) | 4.87 (3.95) |
| feb2025 | 1000 | -2.25 | +1.33 | -2.04 | 64 (98) | 1.90 (2.57) |
| mar2025 | 1000 | -2.04 | +1.48 | -1.77 | 108 (122) | 0.86 (0.93) |
| dec2024 | 1000 | 1.20 | -0.87 | -0.75 | 43 (36) | 3.21 (2.91) |
| calm-2025-09 | 1000 | 0.47 | -0.14 | -1.27 | 80 (93) | 1.23 (1.61) |
| calm-2026-04 | 1000 | 1.71 | -1.15 | -0.54 | 35 (47) | 0.30 (0.42) |
| windows improved at 1000 | | 3/7 | of them > 0.5 pp: 3 | | | |
| sep2026 | 100000 | 1.30 | -0.83 | -0.55 | 165 (161) | 25.99 (25.95) |
| oct2025 | 100000 | -1.44 | +1.50 | -3.06 | 147 (162) | 6.67 (4.21) |
| feb2025 | 100000 | -1.79 | -0.97 | -0.19 | 224 (197) | 4.11 (3.27) |
| mar2025 | 100000 | -3.29 | +2.30 | -2.40 | 212 (152) | 1.63 (1.41) |
| dec2024 | 100000 | 1.58 | -0.74 | -0.17 | 128 (125) | 10.56 (11.87) |
| calm-2025-09 | 100000 | 0.70 | -0.19 | -1.24 | 153 (83) | 2.34 (1.75) |
| calm-2026-04 | 100000 | 1.42 | -0.95 | -0.60 | 161 (156) | 1.37 (1.35) |
| windows improved at 100000 | | 2/7 | of them > 0.5 pp: 2 | | | |

Candidates: **cppi90-m2** and **cppi85-m2**.

## Combination picked on TRAIN: lazy-h24h-b100-d30 + cppi90-m2


**combo-lazy-h24h-b100-d30+cppi90-m2** (delta vs baseline, pp; ops)

| Window | dep | return | Δ return | Δ max DD | ops (base) | gas (base) |
|---|---|---|---|---|---|---|
| windows improved at 5 | | 6/7 | of them > 0.5 pp: 6 | | | |
| sep2026 | 1000 | 1.05 | -1.50 | -0.85 | 19 (72) | 0.18 (0.73) |
| oct2025 | 1000 | -2.36 | +0.97 | -3.29 | 22 (79) | 12.04 (3.95) |
| feb2025 | 1000 | -0.97 | +2.62 | -3.24 | 36 (98) | 0.71 (2.57) |
| mar2025 | 1000 | -1.54 | +1.98 | -2.29 | 63 (122) | 0.30 (0.93) |
| dec2024 | 1000 | 1.07 | -1.00 | -1.26 | 28 (36) | 1.89 (2.91) |
| calm-2025-09 | 1000 | 0.81 | +0.20 | -2.45 | 45 (93) | 0.24 (1.61) |
| calm-2026-04 | 1000 | 0.84 | -2.01 | -0.81 | 14 (47) | 0.11 (0.42) |
| windows improved at 1000 | | 4/7 | of them > 0.5 pp: 3 | | | |
| sep2026 | 100000 | 0.97 | -1.15 | -0.84 | 201 (161) | 1.96 (25.95) |
| oct2025 | 100000 | -1.22 | +1.72 | -4.31 | 174 (162) | 16.23 (4.21) |
| feb2025 | 100000 | -0.67 | +0.14 | -1.54 | 150 (197) | 2.11 (3.27) |
| mar2025 | 100000 | -2.03 | +3.55 | -3.71 | 204 (152) | 1.45 (1.41) |
| dec2024 | 100000 | 1.21 | -1.12 | -0.71 | 178 (125) | 10.09 (11.87) |
| calm-2025-09 | 100000 | 0.79 | -0.11 | -2.43 | 96 (83) | 0.38 (1.75) |
| calm-2026-04 | 100000 | 0.83 | -1.53 | -0.98 | 161 (156) | 1.37 (1.35) |
| windows improved at 100000 | | 3/7 | of them > 0.5 pp: 2 | | | |

TRAIN aggregate: mean +0.18 / +0.22 pp, mean max DD -2.03 / -2.07 pp, worst max DD -3.29 / -4.31 pp, worst return
+1.23 / +3.55 pp (1,000 / 100,000); ops 227 vs 547 at 1,000.

## TEST, each candidate run once

| Variant | Pass Δmean | Primary won /6 | Σ primary Δ | dep | mean Δ | mean DD Δ | worst DD Δ | worst ret Δ | ops (base) | gas (base) |
|---|---|---|---|---|---|---|---|---|---|---|
| combo-lazy-h24h-b100-d30+cppi90-m2 | yes | 6 | 18.49 | 1000 | -0.05 | -2.26 | -4.10 | +0.47 | 259 (536) | 14.59 (21.46) |
| combo-lazy-h24h-b100-d30+cppi90-m2 | yes | 6 | 18.49 | 100000 | +0.39 | -2.76 | -6.13 | +2.77 | 885 (804) | 14.70 (12.11) |
| cppi85-m2 | yes | 6 | 14.72 | 1000 | +0.23 | -1.77 | -3.85 | +1.22 | 462 (536) | 16.64 (21.46) |
| cppi85-m2 | yes | 6 | 14.72 | 100000 | +0.30 | -1.81 | -4.20 | +1.87 | 930 (804) | 19.12 (12.11) |
| lazy-h24h-b100-d30 | yes | 2 | -0.14 | 1000 | -0.07 | +0.17 | +0.51 | -0.84 | 464 (536) | 12.31 (21.46) |
| lazy-h24h-b100-d30 | yes | 2 | -0.14 | 100000 | +0.13 | -0.34 | -1.09 | -0.05 | 805 (804) | 11.74 (12.11) |
| cppi90-m2 | no | 4 | 2.87 | 1000 | +0.44 | -2.52 | -5.29 | +1.99 | 363 (536) | 15.16 (21.46) |
| cppi90-m2 | no | 4 | 2.87 | 100000 | -1.49 | -1.05 | +2.06 | -5.91 | 936 (804) | 12.65 (12.11) |
| lazy-h6h-b200-d120 | no | 3 | -0.65 | 1000 | -0.67 | +0.33 | +0.78 | -1.14 | 416 (536) | 5.89 (21.46) |
| lazy-h6h-b200-d120 | no | 3 | -0.65 | 100000 | -0.10 | -0.11 | -1.29 | +0.20 | 763 (804) | 9.94 (12.11) |

Per window (deltas vs baseline, pp):


**cppi90-m2** (delta vs baseline, pp; ops)

| Window | dep | return | Δ return | Δ max DD | ops (base) | gas (base) |
|---|---|---|---|---|---|---|
| windows improved at 5 | | 5/5 | of them > 0.5 pp: 5 | | | |
| apr2025 | 1000 | -1.49 | +2.01 | -3.34 | 76 (152) | 0.16 (0.34) |
| may2025 | 1000 | 0.96 | -1.49 | -0.61 | 48 (71) | 0.39 (0.50) |
| jun2025 | 1000 | 0.49 | -0.63 | -2.06 | 93 (142) | 0.84 (0.92) |
| calm-2026-05 | 1000 | 0.83 | +0.97 | -1.29 | 36 (52) | 0.39 (0.53) |
| feb2026 | 1000 | -1.51 | +1.33 | -5.29 | 110 (119) | 13.38 (19.17) |
| windows improved at 1000 | | 3/5 | of them > 0.5 pp: 3 | | | |
| apr2025 | 100000 | -1.84 | +2.80 | -3.68 | 182 (161) | 0.52 (0.48) |
| may2025 | 100000 | 0.97 | -1.45 | -0.66 | 185 (170) | 0.60 (0.53) |
| jun2025 | 100000 | 0.76 | -0.93 | -1.21 | 170 (160) | 0.68 (0.63) |
| calm-2026-05 | 100000 | -0.36 | +0.64 | -1.76 | 153 (149) | 1.45 (1.41) |
| feb2026 | 100000 | -10.55 | -8.51 | +2.06 | 246 (164) | 9.40 (9.07) |
| windows improved at 100000 | | 2/5 | of them > 0.5 pp: 2 | | | |

**combo-lazy-h24h-b100-d30+cppi90-m2** (delta vs baseline, pp; ops)

| Window | dep | return | Δ return | Δ max DD | ops (base) | gas (base) |
|---|---|---|---|---|---|---|
| windows improved at 5 | | 5/5 | of them > 0.5 pp: 5 | | | |
| apr2025 | 1000 | -1.80 | +1.70 | -2.96 | 77 (152) | 0.16 (0.34) |
| may2025 | 1000 | 0.61 | -1.85 | -0.82 | 17 (71) | 0.05 (0.50) |
| jun2025 | 1000 | 0.83 | -0.29 | -2.15 | 69 (142) | 0.20 (0.92) |
| calm-2026-05 | 1000 | 0.23 | +0.37 | -1.28 | 22 (52) | 0.19 (0.53) |
| feb2026 | 1000 | -3.03 | -0.19 | -4.10 | 74 (119) | 13.99 (19.17) |
| windows improved at 1000 | | 2/5 | of them > 0.5 pp: 1 | | | |
| apr2025 | 100000 | -1.87 | +2.77 | -3.67 | 172 (161) | 0.50 (0.48) |
| may2025 | 100000 | 0.61 | -1.81 | -0.91 | 180 (170) | 0.56 (0.53) |
| jun2025 | 100000 | 0.79 | -0.91 | -1.24 | 170 (160) | 0.68 (0.63) |
| calm-2026-05 | 100000 | -0.27 | +0.73 | -1.86 | 139 (149) | 1.26 (1.41) |
| feb2026 | 100000 | -0.88 | +1.16 | -6.13 | 224 (164) | 11.69 (9.07) |
| windows improved at 100000 | | 3/5 | of them > 0.5 pp: 3 | | | |

**cppi85-m2** (delta vs baseline, pp; ops)

| Window | dep | return | Δ return | Δ max DD | ops (base) | gas (base) |
|---|---|---|---|---|---|---|
| windows improved at 5 | | 3/5 | of them > 0.5 pp: 3 | | | |
| apr2025 | 1000 | -2.28 | +1.22 | -2.34 | 135 (152) | 0.28 (0.34) |
| may2025 | 1000 | 1.46 | -1.00 | -0.41 | 55 (71) | 0.41 (0.50) |
| jun2025 | 1000 | 0.68 | -0.44 | -1.37 | 115 (142) | 0.98 (0.92) |
| calm-2026-05 | 1000 | 0.51 | +0.65 | -0.86 | 41 (52) | 0.43 (0.53) |
| feb2026 | 1000 | -2.11 | +0.73 | -3.85 | 116 (119) | 14.54 (19.17) |
| windows improved at 1000 | | 3/5 | of them > 0.5 pp: 3 | | | |
| apr2025 | 100000 | -2.77 | +1.87 | -2.42 | 182 (161) | 0.52 (0.48) |
| may2025 | 100000 | 1.45 | -0.97 | -0.44 | 180 (170) | 0.58 (0.53) |
| jun2025 | 100000 | 1.07 | -0.62 | -0.81 | 166 (160) | 0.66 (0.63) |
| calm-2026-05 | 100000 | -0.57 | +0.43 | -1.17 | 152 (149) | 1.44 (1.41) |
| feb2026 | 100000 | -1.26 | +0.78 | -4.20 | 250 (164) | 15.92 (9.07) |
| windows improved at 100000 | | 3/5 | of them > 0.5 pp: 2 | | | |

**lazy-h24h-b100-d30** (delta vs baseline, pp; ops)

| Window | dep | return | Δ return | Δ max DD | ops (base) | gas (base) |
|---|---|---|---|---|---|---|
| windows improved at 5 | | 4/5 | of them > 0.5 pp: 4 | | | |
| apr2025 | 1000 | -4.34 | -0.84 | +0.73 | 163 (152) | 0.35 (0.34) |
| may2025 | 1000 | 2.01 | -0.44 | -0.53 | 49 (71) | 0.19 (0.50) |
| jun2025 | 1000 | 1.41 | +0.29 | -0.31 | 129 (142) | 0.69 (0.92) |
| calm-2026-05 | 1000 | -0.63 | -0.48 | +0.44 | 40 (52) | 0.36 (0.53) |
| feb2026 | 1000 | -1.69 | +1.15 | +0.51 | 83 (119) | 10.72 (19.17) |
| windows improved at 1000 | | 2/5 | of them > 0.5 pp: 1 | | | |
| apr2025 | 100000 | -4.70 | -0.05 | +0.15 | 154 (161) | 0.46 (0.48) |
| may2025 | 100000 | 1.53 | -0.89 | -0.61 | 165 (170) | 0.49 (0.53) |
| jun2025 | 100000 | 1.75 | +0.06 | -0.08 | 160 (160) | 0.63 (0.63) |
| calm-2026-05 | 100000 | -0.90 | +0.10 | -0.09 | 137 (149) | 1.24 (1.41) |
| feb2026 | 100000 | -0.59 | +1.46 | -1.09 | 189 (164) | 8.92 (9.07) |
| windows improved at 100000 | | 3/5 | of them > 0.5 pp: 1 | | | |

**lazy-h6h-b200-d120** (delta vs baseline, pp; ops)

| Window | dep | return | Δ return | Δ max DD | ops (base) | gas (base) |
|---|---|---|---|---|---|---|
| windows improved at 5 | | 4/5 | of them > 0.5 pp: 4 | | | |
| apr2025 | 1000 | -4.34 | -0.85 | +1.08 | 125 (152) | 0.28 (0.34) |
| may2025 | 1000 | 1.51 | -0.95 | -0.53 | 29 (71) | 0.10 (0.50) |
| jun2025 | 1000 | 1.85 | +0.73 | -0.11 | 125 (142) | 0.71 (0.92) |
| calm-2026-05 | 1000 | -0.63 | -0.48 | +0.44 | 40 (52) | 0.36 (0.53) |
| feb2026 | 1000 | -4.64 | -1.80 | +0.78 | 97 (119) | 4.44 (19.17) |
| windows improved at 1000 | | 1/5 | of them > 0.5 pp: 1 | | | |
| apr2025 | 100000 | -4.44 | +0.20 | +0.15 | 138 (161) | 0.43 (0.48) |
| may2025 | 100000 | 1.53 | -0.89 | -0.61 | 141 (170) | 0.36 (0.53) |
| jun2025 | 100000 | 1.87 | +0.17 | +1.31 | 159 (160) | 0.61 (0.63) |
| calm-2026-05 | 100000 | -0.90 | +0.10 | -0.09 | 137 (149) | 1.24 (1.41) |
| feb2026 | 100000 | -2.12 | -0.08 | -1.29 | 188 (164) | 7.30 (9.07) |
| windows improved at 100000 | | 3/5 | of them > 0.5 pp: 0 | | | |

## Verdict

- **Experiment 4 (lazy re-range): reject as a drawdown rule, keep as a gas rule.** TEST confirms it: drawdown
  neutral-to-worse at 1,000 (+0.17 mean, +0.51 worst for the 24 h candidate; the 6 h one fails the return
  constraint, -0.67 pp), gas -43% at 1,000. Windows improved: 2/5 at 1,000 (1 above 0.5 pp), 3/5 at 100,000 (1).
  Worth a separate small-account (< ~200 USD) experiment where gas is the loss.
- **Experiment 6 volatility target: reject.**
- **CPPI**: cppi85-m2 is the only single rule that passed every criterion on TEST at both sizes (mean +0.23 / +0.30,
  worst DD -3.85 / -4.20, worst return +1.22 / +1.87). cppi90-m2 **failed on TEST** at 100,000: feb2026 -10.55%
  vs -2.04% (worst DD +2.06, worst return -5.91 pp). Cause: CPPI moves most of the account into the stables bucket,
  and in the February 2026 USDT depeg the 40-tick USDC/USDT range re-ranges and swaps 100k through a thin pool again
  and again. CPPI concentrates the account in the stable pair; it needs the stables depeg guard (spec 004
  `RISK_DEPEG_PAIRED`) or a no-rerange rule on the stables bucket before it can ship.
- **Combination**: passes every criterion on TEST at both sizes (mean -0.05 / +0.39, mean DD -2.26 / -2.76, worst DD
  -4.10 / -6.13, worst return +0.47 / +2.77; ops 259 vs 536 at 1,000). The lazy rule fixes cppi90-m2's feb2026 hole
  (it blocks the stables re-range churn). But per window it improves return in only 2/5 (1,000) and 3/5 (100,000)
  windows: it trades 1-2 pp of upside in calm and rally windows for 2-6 pp less drawdown in crashes. That is a
  product choice (a more defensive preset), not a free improvement.
- 13 windows, 5 on TEST, one start time each. Not enough to ship anything; enough to say CPPI m2 is a real
  drawdown lever with an upside cost, and the volatility target is not.

## Found on the way (not fixed here)

- **Baseline at 100,000**: harvests spend `convert-any` uses (64 per session) within days, after which every
  proposal using that grant is refused (sep2026: 140 harvests, then 8,111 `SESSION_USAGE_SPENT` reviews). Harvest
  frequency against the usage limit needs its own ticket.
- At 5 USD the simulator lets gas take the account below zero; the run should stop or flag it.
- The LVR term in the cost test is an estimate from the simulator's own fee model, which over-estimates fees on
  the 40-tick stable range by ~22% (lab note 2026-10-02).

## Reproduce

```
bun packages/backtest/cli/sweep.ts --variants specs/004-loss-control/results/variants/exp4-train-grid.json --deposits 5,1000,100000 --jobs 3
bun packages/backtest/cli/sweep.ts --variants specs/004-loss-control/results/variants/exp6-train-grid.json --deposits 5,1000,100000 --jobs 3
bun packages/backtest/cli/sweep.ts --variants specs/004-loss-control/results/variants/combo-train.json --deposits 5,1000,100000 --jobs 3
bun packages/backtest/cli/sweep.ts --variants specs/004-loss-control/results/variants/test-candidates.json --split test --deposits 5,1000,100000 --jobs 3
```
