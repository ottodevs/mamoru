# Rerange width, weekly cap and fall freeze: TRAIN sweep (Lab, 13 Nov 2026)

Ticket otto/mamoru#406. Everything below is **measured** on the recorded TRAIN windows unless it says "reading" or
"not measured". Raw sweep: `rerange-width-guard-2026-11-13/sweep.{json,md}` (630 cells); tables regenerate with
`python3 rerange-width-guard-2026-11-13/tables.py`; variants: `variants/rerange-width-guard-2026-11-13.json`.

## Question

Production runs lazy re-ranging with `maxPerWeek 2`, a 2000-tick fixed width and the fall freeze off. Does a wider
range, a volatility width, another weekly cap or the fall freeze (WETH 9% / vol 100%) lose less in a crash without
costing too much in calm and rally weeks?

## What changed in the Lab first (so the sweep is the production rule)

- **The simulator did not honour `maxPerWeek`.** `decide` reads `Observation.recentReranges` for the cap; the backtest
  never filled it, so every earlier sweep ran with no weekly cap whatever the policy said (none of the earlier results
  used a cap, so they stand; merges of v5+ policies, which count the same list, were uncounted). The world now records
  each re-range and `observe` passes the last 7 days, as the engine does.
- A sweep variant takes `engine`: the same object /ops stores as engine settings (`rerange` with `mode`,
  `maxPerWeek`, `edgeBufferTicks`, `edgeBufferBps`, `maxWaitSeconds`, `minDwellSeconds`, `horizonSeconds`,
  `lvrWeightBps`, `costTest`; `guard` with `enabled` and the thresholds). It is validated by the production
  `validateEngineSettings` and applied by the production `withEngineSettings`, so the policy is the one the operator
  builds (including `requireCostEstimate: true`). `range.maxPerWeek` and the optional lazy keys are also accepted as
  typed `overrides`. Tests (`rerange-overrides.test.ts`) show each knob changes the run: cap 1 against none, dwell,
  wait, buffer in bps, cost test off, and the guard on a falling path.
- Variant `prod-baseline` = lazy, `maxPerWeek 2`, `maxWaitSeconds 21600`, `minDwellSeconds 1800`, `edgeBufferBps 2500`,
  `edgeBufferTicks 100`, `horizonSeconds 86400`, `lvrWeightBps 10000`, cost test off, guard off, width 2000.

## Setup

- Sim `backtest-1`, review every sample, sessions enforced, cap = deposit, gas model of `run.ts`. Deposits 100, 1,000,
  10,000 USDC.
- **Account: the stables pool (USDC/USDT 0.01%) at 90% and WETH/USDC 0.3% at 10%**, the live weights, with no cbBTC
  bucket. The cbBTC bucket is left out so the BTC pool does not mix into the WETH/USDC result; the stables pool stays
  because the session caps are sized for the live weights (a risk-only account is refused by them). The rerange settings
  also act on the stables pool (about 1 re-range per window there), so the "reranges" column is both pools. "Hold" is
  what the sim means by it: the entry mix held.
- TRAIN has 8 windows; **aug2024 is excluded** (no cbBTC pool on Base then, the cap prices fail). 7 run: calm sep2026,
  calm-2025-09, calm-2026-04; crash oct2025, feb2025, mar2025; rally dec2024. Rally is one window.
- Grid: width {fixed 2000, volWidth k=3 H=3 d (the Lab reference of range-geometry-2026-10-16: min 600, max 6000,
  early ratio 1.5), fixed 4000 on WETH/USDC} x `maxPerWeek` {1, 2, 3, 5, unlimited} x guard {off, on 9%/100%} = 30
  variants. The full grid fits: 5 min 42 s with 4 jobs, so nothing was cut. Tables show the **mean over the windows of
  the regime** (not the sum); "worst max DD" is the worst window of the regime.
- Net vs hold in USD is `vs hold % x deposit`. Max drawdown barely moves between variants (it is the 10% ETH exposure,
  about 2.4% in a crash week), so it does not separate them.

## Tables

### Calm (sep2026, calm-2025-09, calm-2026-04): mean per window

Deposit 100 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -0.30 | -0.298 | 2.15 | 0.43 | 10.7 | 1.0 |
| w2000-mpw1-guardoff | 3 | -0.30 | -0.298 | 2.15 | 0.43 | 10.7 | 1.0 |
| w2000-mpw3-guardoff | 3 | -0.30 | -0.298 | 2.15 | 0.43 | 10.7 | 1.0 |
| w2000-mpw5-guardoff | 3 | -0.30 | -0.298 | 2.15 | 0.43 | 10.7 | 1.0 |
| w2000-mpwinf-guardoff | 3 | -0.30 | -0.298 | 2.15 | 0.43 | 10.7 | 1.0 |
| w2000-mpw2-guardon | 3 | -0.30 | -0.298 | 2.15 | 0.43 | 10.7 | 1.0 |
| w2000-mpw3-guardon | 3 | -0.30 | -0.298 | 2.15 | 0.43 | 10.7 | 1.0 |
| wvol-mpw2-guardoff | 3 | -0.17 | -0.167 | 1.76 | 0.29 | 10.0 | 1.0 |
| wvol-mpw2-guardon | 3 | -0.17 | -0.167 | 1.76 | 0.29 | 10.0 | 1.0 |
| w4000-mpw2-guardoff | 3 | +0.20 | +0.198 | 1.07 | 0.05 | 6.0 | 0.0 |
| w4000-mpw2-guardon | 3 | +0.20 | +0.198 | 1.07 | 0.05 | 6.0 | 0.0 |

Deposit 1000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw1-guardoff | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw3-guardoff | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw5-guardoff | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpwinf-guardoff | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw2-guardon | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw3-guardon | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| wvol-mpw2-guardoff | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpw2-guardon | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| w4000-mpw2-guardoff | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpw2-guardon | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |

Deposit 10000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | +10.27 | +0.103 | 1.09 | 2.03 | 211.3 | 1.0 |
| w2000-mpw1-guardoff | 3 | +10.27 | +0.103 | 1.09 | 2.03 | 211.3 | 1.0 |
| w2000-mpw3-guardoff | 3 | +10.27 | +0.103 | 1.09 | 2.03 | 211.3 | 1.0 |
| w2000-mpw5-guardoff | 3 | +10.27 | +0.103 | 1.09 | 2.03 | 211.3 | 1.0 |
| w2000-mpwinf-guardoff | 3 | +10.27 | +0.103 | 1.09 | 2.03 | 211.3 | 1.0 |
| w2000-mpw2-guardon | 3 | +10.27 | +0.103 | 1.09 | 2.03 | 211.3 | 1.0 |
| w2000-mpw3-guardon | 3 | +10.27 | +0.103 | 1.09 | 2.03 | 211.3 | 1.0 |
| wvol-mpw2-guardoff | 3 | +9.65 | +0.096 | 1.08 | 1.96 | 202.3 | 1.0 |
| wvol-mpw2-guardon | 3 | +9.65 | +0.096 | 1.08 | 1.96 | 202.3 | 1.0 |
| w4000-mpw2-guardoff | 3 | +23.26 | +0.233 | 1.02 | 1.23 | 136.0 | 0.0 |
| w4000-mpw2-guardon | 3 | +23.26 | +0.233 | 1.02 | 1.23 | 136.0 | 0.0 |

### Crash (oct2025, feb2025, mar2025): mean per window

Deposit 100 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -0.82 | -0.821 | 2.47 | 0.42 | 18.7 | 2.7 |
| w2000-mpw1-guardoff | 3 | -0.51 | -0.505 | 2.46 | 0.30 | 14.3 | 1.3 |
| w2000-mpw3-guardoff | 3 | -0.98 | -0.978 | 2.73 | 0.57 | 22.3 | 3.7 |
| w2000-mpw5-guardoff | 3 | -1.04 | -1.037 | 2.77 | 0.63 | 23.7 | 4.3 |
| w2000-mpwinf-guardoff | 3 | -1.04 | -1.037 | 2.77 | 0.63 | 23.7 | 4.3 |
| w2000-mpw2-guardon | 3 | -0.60 | -0.604 | 2.46 | 0.38 | 17.7 | 2.7 |
| w2000-mpw3-guardon | 3 | -0.63 | -0.627 | 2.46 | 0.43 | 19.3 | 3.0 |
| wvol-mpw2-guardoff | 3 | -0.73 | -0.732 | 2.46 | 0.37 | 16.7 | 2.7 |
| wvol-mpw2-guardon | 3 | -0.56 | -0.565 | 2.46 | 0.36 | 16.0 | 2.7 |
| w4000-mpw2-guardoff | 3 | -0.58 | -0.581 | 2.42 | 0.23 | 13.0 | 1.7 |
| w4000-mpw2-guardon | 3 | -0.40 | -0.403 | 2.42 | 0.22 | 13.0 | 1.7 |

Deposit 1000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -2.67 | -0.267 | 2.40 | 0.60 | 42.7 | 2.7 |
| w2000-mpw1-guardoff | 3 | -2.69 | -0.269 | 2.40 | 0.53 | 40.0 | 1.3 |
| w2000-mpw3-guardoff | 3 | -2.76 | -0.276 | 2.40 | 0.64 | 44.3 | 3.7 |
| w2000-mpw5-guardoff | 3 | -5.06 | -0.506 | 2.40 | 0.82 | 47.3 | 5.0 |
| w2000-mpwinf-guardoff | 3 | -5.11 | -0.511 | 2.40 | 0.88 | 49.3 | 5.7 |
| w2000-mpw2-guardon | 3 | -0.88 | -0.088 | 2.40 | 0.59 | 43.3 | 2.7 |
| w2000-mpw3-guardon | 3 | -0.92 | -0.092 | 2.40 | 0.63 | 43.0 | 3.7 |
| wvol-mpw2-guardoff | 3 | -2.84 | -0.284 | 2.39 | 0.55 | 38.7 | 2.7 |
| wvol-mpw2-guardon | 3 | -1.58 | -0.158 | 2.39 | 0.50 | 36.7 | 2.7 |
| w4000-mpw2-guardoff | 3 | -4.05 | -0.405 | 2.35 | 0.46 | 33.3 | 1.7 |
| w4000-mpw2-guardon | 3 | -2.29 | -0.229 | 2.35 | 0.38 | 31.0 | 1.7 |

Deposit 10000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -25.80 | -0.258 | 2.40 | 2.25 | 195.7 | 2.7 |
| w2000-mpw1-guardoff | 3 | -26.45 | -0.264 | 2.40 | 2.09 | 177.7 | 1.3 |
| w2000-mpw3-guardoff | 3 | -26.26 | -0.263 | 2.40 | 2.19 | 193.0 | 3.3 |
| w2000-mpw5-guardoff | 3 | -26.76 | -0.268 | 2.40 | 2.37 | 195.7 | 4.7 |
| w2000-mpwinf-guardoff | 3 | -48.38 | -0.484 | 2.40 | 2.72 | 209.3 | 8.7 |
| w2000-mpw2-guardon | 3 | -7.66 | -0.077 | 2.40 | 1.99 | 186.0 | 2.7 |
| w2000-mpw3-guardon | 3 | -7.87 | -0.079 | 2.40 | 2.04 | 187.0 | 3.3 |
| wvol-mpw2-guardoff | 3 | -27.68 | -0.277 | 2.40 | 1.95 | 166.0 | 2.7 |
| wvol-mpw2-guardon | 3 | -15.35 | -0.153 | 2.40 | 1.80 | 158.7 | 2.7 |
| w4000-mpw2-guardoff | 3 | -41.99 | -0.420 | 2.34 | 1.51 | 141.0 | 1.7 |
| w4000-mpw2-guardon | 3 | -24.58 | -0.246 | 2.34 | 1.27 | 125.3 | 1.7 |

### Rally (dec2024): mean per window

Deposit 100 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 1 | +0.06 | +0.064 | 0.64 | 0.45 | 5.0 | 0.0 |
| w2000-mpw1-guardoff | 1 | +0.06 | +0.064 | 0.64 | 0.45 | 5.0 | 0.0 |
| w2000-mpw3-guardoff | 1 | +0.06 | +0.064 | 0.64 | 0.45 | 5.0 | 0.0 |
| w2000-mpw5-guardoff | 1 | +0.06 | +0.064 | 0.64 | 0.45 | 5.0 | 0.0 |
| w2000-mpwinf-guardoff | 1 | +0.06 | +0.064 | 0.64 | 0.45 | 5.0 | 0.0 |
| w2000-mpw2-guardon | 1 | +0.06 | +0.064 | 0.64 | 0.45 | 5.0 | 0.0 |
| w2000-mpw3-guardon | 1 | +0.06 | +0.064 | 0.64 | 0.45 | 5.0 | 0.0 |
| wvol-mpw2-guardoff | 1 | +0.06 | +0.064 | 0.64 | 0.45 | 5.0 | 0.0 |
| wvol-mpw2-guardon | 1 | +0.06 | +0.064 | 0.64 | 0.45 | 5.0 | 0.0 |
| w4000-mpw2-guardoff | 1 | -0.28 | -0.283 | 0.82 | 0.64 | 6.0 | 0.0 |
| w4000-mpw2-guardon | 1 | -0.28 | -0.283 | 0.82 | 0.64 | 6.0 | 0.0 |

Deposit 1000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw1-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw3-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw5-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpwinf-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw2-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw3-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw2-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw2-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w4000-mpw2-guardoff | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpw2-guardon | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |

Deposit 10000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 1 | +48.44 | +0.484 | 0.39 | 2.36 | 67.0 | 1.0 |
| w2000-mpw1-guardoff | 1 | +48.44 | +0.484 | 0.39 | 2.36 | 67.0 | 1.0 |
| w2000-mpw3-guardoff | 1 | +48.44 | +0.484 | 0.39 | 2.36 | 67.0 | 1.0 |
| w2000-mpw5-guardoff | 1 | +48.44 | +0.484 | 0.39 | 2.36 | 67.0 | 1.0 |
| w2000-mpwinf-guardoff | 1 | +48.44 | +0.484 | 0.39 | 2.36 | 67.0 | 1.0 |
| w2000-mpw2-guardon | 1 | +48.44 | +0.484 | 0.39 | 2.36 | 67.0 | 1.0 |
| w2000-mpw3-guardon | 1 | +48.44 | +0.484 | 0.39 | 2.36 | 67.0 | 1.0 |
| wvol-mpw2-guardoff | 1 | +48.91 | +0.489 | 0.39 | 2.29 | 66.0 | 0.0 |
| wvol-mpw2-guardon | 1 | +48.91 | +0.489 | 0.39 | 2.29 | 66.0 | 0.0 |
| w4000-mpw2-guardoff | 1 | +32.35 | +0.324 | 0.51 | 1.85 | 54.0 | 0.0 |
| w4000-mpw2-guardon | 1 | +32.35 | +0.324 | 0.51 | 1.85 | 54.0 | 0.0 |

## Reading

All numbers here are from the tables.

**Weekly cap (guard off, fixed 2000, crash, 1,000 USDC).** Net vs hold per crash window: cap 1 -2.69, **cap 2 (prod)
-2.67**, cap 3 -2.76, cap 5 -5.06, unlimited -5.11 USD; reranges 1.3 / 2.7 / 3.7 / 5.0 / 5.7. Re-ranging into a fall
costs about 2.4 USD per crash week from the fifth re-range on. Cap 1, 2 and 3 are indistinguishable at this resolution.
In calm and rally windows the cap never binds (1 re-range a window, 0 in the rally): the numbers are identical for
every cap. At 100 USDC cap 1 is best (-0.51 against -0.82 USD) because every re-range is a larger share of the account.
The prod value 2 sits on the plateau. Nothing here argues for raising it.

**Fall freeze (9% / 100%, fixed 2000, cap 2, 1,000 USDC).** Crash windows: -2.67 -> **-0.88** USD per window (+1.79 USD,
+0.18 pp); at 10,000: -25.8 -> -7.7 USD. Where it comes from: feb2025 -5.68 -> -0.35 USD; oct2025 and mar2025 move
by less than 0.1 USD. In the four calm and rally windows the guard **never fired**: end values equal the guard-off run
in all 180 cells (zero measured cost). Worst window of the whole TRAIN set, 1,000 USDC: -0.568% -> -0.138%.
**Caveat that matters:** the 9% / 100% thresholds were chosen on oct2025, feb2025 and sep2026 (`FALL_FREEZE_DEFAULTS`),
so the crash gain is in sample for two of the three crash windows, and the largest part comes from one of them.
mar2025 is the only crash window not used to pick the thresholds, and there the guard changes almost nothing.
The cost of the freeze (money kept out while the price rebounds) shows in V-shaped weeks; TRAIN has none in calm or
rally. Not measured.

**Width.** Fixed 4000 against fixed 2000 (cap 2, guard on, 1,000 USDC): calm +2.31 vs +0.62 USD per window (the wide range
barely re-ranges: 0 against 1 per window, gas 0.18 against 0.65); rally dec2024 +2.72 vs +4.46 (less fee per unit of
liquidity); crash -2.29 vs -0.88. Mean over the 7 windows +0.040% vs +0.053%, worst window -0.458% vs -0.138%. It is a
calm-month gain bought with a worse crash and a worse rally. At **100 USDC** it is the best variant (mean -0.128% vs
-0.378% for 2000/cap 2/guard on, and -0.471% for prod-baseline) because gas per window is 0.21 against 0.41 USD on a
10 USD risk position. Volatility width (k 3, H 3 d): about neutral to worse than fixed 2000 at 1,000 and 10,000
(mean +0.020% and +0.045% vs +0.053% and +0.080%), better at 100 (-0.304%). Not better than a fixed width anywhere that matters.

**Best TRAIN candidates against prod-baseline** (mean vs hold per window over 7 windows / worst window; gas per window):

| Deposit | prod-baseline | 2000, cap 2, guard on | 2000, cap 1, guard on | 4000, cap 2, guard on |
|---|---|---|---|---|
| 100 | -0.471% / -1.136%; 0.43 | -0.378% / -1.090%; 0.41 | -0.264% / -0.871%; 0.38 | -0.128% / -0.529%; 0.21 |
| 1,000 | -0.024% / -0.568%; 0.62 | +0.053% / -0.138%; 0.62 | +0.046% / -0.154%; 0.59 | +0.040% / -0.458%; 0.35 |
| 10,000 | +0.003% / -0.522%; 2.17 | +0.080% / -0.144%; 2.06 | +0.072% / -0.210%; 2.01 | +0.041% / -0.444%; 1.33 |

## Does the guard reduce loss in crashes, and what does it cost?

Reduces: yes on TRAIN, by 1.8 USD per 1,000 USDC per crash window, concentrated in feb2025. Cost in calm and rally:
none measured (it did not fire in 4 of 4). Cost in the case TRAIN does not contain (a fast fall that reverses): not measured.

## Caveats

- **TRAIN only, 7 windows, one rally, three crashes.** A per-window difference under 0.5 pp is inside the start-time
  noise found in the geometry round. The guard result rests mainly on one window (feb2025) whose thresholds were fitted.
- **The TEST split was already consumed for the width question** (range-geometry-2026-10-16: three variants and a
  combination were run on it). It cannot give an unbiased width verdict any more. For the guard and the cap, TEST
  windows (apr2025 crash, may2025 rally, jun2025 calm with a 22 Jun dip that recovers) have not been run with these
  settings; run the one chosen candidate on them **once**, after it is picked, and tune nothing afterwards. jun2025 is the
  window where a freeze that costs would show.
- The account is a stables/WETH model of production (no cbBTC; depth sizing and the account cap of production are not
  modelled; the gas model of `run.ts` has estimates for re-range). Absolute USD per window is small (one week, a 10%
  sleeve): read the ordering, not the dollars.
- Reranges and ops are both pools. Exposure of the account to the price (max drawdown) is the same in every variant.

## Reading for a decision (not a measurement)

Turn the fall freeze on (WETH 9% / vol 100%): it is the only change that moved crash weeks and it cost nothing on TRAIN
calm and rally. Keep `maxPerWeek` at 2 (1 to 3 are equivalent; 5 or more is measurably worse in a crash). Keep width 2000
for accounts of 1,000 USDC and up. For accounts around 100 USDC a 4000 width saves about half the gas and is the best
variant in this grid; it loses about 1.7 USD per 1,000 USDC in a rally week and 1.4 USD in a crash week, so it is a
size-dependent choice, not a general one. Next step before any production change: one TEST run of `w2000-mpw2-guardon`
(and `w4000-mpw2-guardon` if small accounts matter), then the usual soak.

## Appendix A: full grid, deposit 1,000 USDC


calm

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| w2000-mpw1-guardoff | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw1-guardon | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| prod-baseline | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw2-guardon | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw3-guardoff | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw3-guardon | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw5-guardoff | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpw5-guardon | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpwinf-guardoff | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| w2000-mpwinf-guardon | 3 | +0.62 | +0.062 | 1.19 | 0.65 | 35.3 | 1.0 |
| wvol-mpw1-guardoff | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpw1-guardon | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpw2-guardoff | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpw2-guardon | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpw3-guardoff | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpw3-guardon | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpw5-guardoff | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpw5-guardon | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpwinf-guardoff | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| wvol-mpwinf-guardon | 3 | +0.56 | +0.056 | 1.18 | 0.64 | 34.7 | 1.0 |
| w4000-mpw1-guardoff | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpw1-guardon | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpw2-guardoff | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpw2-guardon | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpw3-guardoff | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpw3-guardon | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpw5-guardoff | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpw5-guardon | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpwinf-guardoff | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |
| w4000-mpwinf-guardon | 3 | +2.31 | +0.231 | 1.02 | 0.18 | 21.7 | 0.0 |

crash

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| w2000-mpw1-guardoff | 3 | -2.69 | -0.269 | 2.40 | 0.53 | 40.0 | 1.3 |
| w2000-mpw1-guardon | 3 | -1.02 | -0.102 | 2.40 | 0.53 | 38.3 | 1.3 |
| prod-baseline | 3 | -2.67 | -0.267 | 2.40 | 0.60 | 42.7 | 2.7 |
| w2000-mpw2-guardon | 3 | -0.88 | -0.088 | 2.40 | 0.59 | 43.3 | 2.7 |
| w2000-mpw3-guardoff | 3 | -2.76 | -0.276 | 2.40 | 0.64 | 44.3 | 3.7 |
| w2000-mpw3-guardon | 3 | -0.92 | -0.092 | 2.40 | 0.63 | 43.0 | 3.7 |
| w2000-mpw5-guardoff | 3 | -5.06 | -0.506 | 2.40 | 0.82 | 47.3 | 5.0 |
| w2000-mpw5-guardon | 3 | -2.72 | -0.272 | 2.40 | 0.70 | 45.0 | 4.3 |
| w2000-mpwinf-guardoff | 3 | -5.11 | -0.511 | 2.40 | 0.88 | 49.3 | 5.7 |
| w2000-mpwinf-guardon | 3 | -2.77 | -0.277 | 2.40 | 0.76 | 47.0 | 5.0 |
| wvol-mpw1-guardoff | 3 | -3.03 | -0.303 | 2.39 | 0.52 | 34.0 | 1.3 |
| wvol-mpw1-guardon | 3 | -1.72 | -0.172 | 2.39 | 0.43 | 33.0 | 1.3 |
| wvol-mpw2-guardoff | 3 | -2.84 | -0.284 | 2.39 | 0.55 | 38.7 | 2.7 |
| wvol-mpw2-guardon | 3 | -1.58 | -0.158 | 2.39 | 0.50 | 36.7 | 2.7 |
| wvol-mpw3-guardoff | 3 | -2.87 | -0.287 | 2.39 | 0.58 | 40.3 | 3.3 |
| wvol-mpw3-guardon | 3 | -1.59 | -0.159 | 2.39 | 0.51 | 36.7 | 3.3 |
| wvol-mpw5-guardoff | 3 | -4.37 | -0.437 | 2.39 | 0.65 | 41.3 | 4.0 |
| wvol-mpw5-guardon | 3 | -2.69 | -0.269 | 2.39 | 0.54 | 37.0 | 4.0 |
| wvol-mpwinf-guardoff | 3 | -4.37 | -0.437 | 2.39 | 0.65 | 41.3 | 4.0 |
| wvol-mpwinf-guardon | 3 | -2.69 | -0.269 | 2.39 | 0.54 | 37.0 | 4.0 |
| w4000-mpw1-guardoff | 3 | -4.23 | -0.423 | 2.35 | 0.45 | 30.3 | 1.3 |
| w4000-mpw1-guardon | 3 | -2.45 | -0.245 | 2.35 | 0.37 | 28.0 | 1.3 |
| w4000-mpw2-guardoff | 3 | -4.05 | -0.405 | 2.35 | 0.46 | 33.3 | 1.7 |
| w4000-mpw2-guardon | 3 | -2.29 | -0.229 | 2.35 | 0.38 | 31.0 | 1.7 |
| w4000-mpw3-guardoff | 3 | -4.05 | -0.405 | 2.35 | 0.46 | 33.3 | 1.7 |
| w4000-mpw3-guardon | 3 | -2.29 | -0.229 | 2.35 | 0.38 | 31.0 | 1.7 |
| w4000-mpw5-guardoff | 3 | -4.05 | -0.405 | 2.35 | 0.46 | 33.3 | 1.7 |
| w4000-mpw5-guardon | 3 | -2.29 | -0.229 | 2.35 | 0.38 | 31.0 | 1.7 |
| w4000-mpwinf-guardoff | 3 | -4.05 | -0.405 | 2.35 | 0.46 | 33.3 | 1.7 |
| w4000-mpwinf-guardon | 3 | -2.29 | -0.229 | 2.35 | 0.38 | 31.0 | 1.7 |

rally

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| w2000-mpw1-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw1-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| prod-baseline | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw2-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw3-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw3-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw5-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpw5-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpwinf-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w2000-mpwinf-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw1-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw1-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw2-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw2-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw3-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw3-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw5-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpw5-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpwinf-guardoff | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| wvol-mpwinf-guardon | 1 | +4.46 | +0.446 | 0.39 | 0.60 | 16.0 | 0.0 |
| w4000-mpw1-guardoff | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpw1-guardon | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpw2-guardoff | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpw2-guardon | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpw3-guardoff | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpw3-guardon | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpw5-guardoff | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpw5-guardon | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpwinf-guardoff | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |
| w4000-mpwinf-guardon | 1 | +2.72 | +0.272 | 0.51 | 0.76 | 16.0 | 0.0 |

## Appendix B: per window, net vs hold in USD (deposit 1000; 10000 in brackets) and reranges

| Window | prod-baseline | w2000-mpwinf-guardoff | w2000-mpw2-guardon | w2000-mpw3-guardon | wvol-mpw2-guardon | w4000-mpw2-guardoff | w4000-mpw2-guardon |
|---|---|---|---|---|---|---|---|
| sep2026 | +1.49 (+14.8) / 1rr | +1.49 (+14.8) / 1rr | +1.49 (+14.8) / 1rr | +1.49 (+14.8) / 1rr | +1.64 (+16.5) / 1rr | +1.35 (+13.4) / 0rr | +1.35 (+13.4) / 0rr |
| calm-2025-09 | +1.16 (+23.3) / 1rr | +1.16 (+23.3) / 1rr | +1.16 (+23.3) / 1rr | +1.16 (+23.3) / 1rr | +1.22 (+23.9) / 1rr | +4.34 (+44.1) / 0rr | +4.34 (+44.1) / 0rr |
| calm-2026-04 | -0.78 (-7.2) / 1rr | -0.78 (-7.2) / 1rr | -0.78 (-7.2) / 1rr | -0.78 (-7.2) / 1rr | -1.19 (-11.4) / 1rr | +1.24 (+12.3) / 0rr | +1.24 (+12.3) / 0rr |
| oct2025 | -1.42 (-10.5) / 2rr | -7.05 (-62.9) / 7rr | -1.38 (-10.4) / 2rr | -1.38 (-10.6) / 3rr | -1.68 (-13.3) / 2rr | -5.76 (-55.8) / 1rr | -4.58 (-44.4) / 1rr |
| feb2025 | -5.68 (-52.2) / 2rr | -7.36 (-67.6) / 5rr | -0.35 (+1.9) / 2rr | -0.47 (+1.5) / 3rr | -1.32 (-9.3) / 2rr | -3.40 (-28.3) / 1rr | +0.77 (+12.3) / 1rr |
| mar2025 | -0.92 (-14.6) / 4rr | -0.92 (-14.6) / 5rr | -0.91 (-14.4) / 4rr | -0.91 (-14.4) / 5rr | -1.74 (-23.4) / 4rr | -3.01 (-41.8) / 3rr | -3.05 (-41.7) / 3rr |
| dec2024 | +4.46 (+48.4) / 0rr | +4.46 (+48.4) / 0rr | +4.46 (+48.4) / 0rr | +4.46 (+48.4) / 0rr | +4.46 (+48.9) / 0rr | +2.72 (+32.4) / 0rr | +2.72 (+32.4) / 0rr |


---

# Addendum: v7-like account (13 Nov 2026)

Everything above is the **10% WETH account** (stables LP 90% + WETH/USDC 10%), not production. Production runs
`conservador-live-v7`: 50% Stable in ERC-4626 vaults, 35% WETH/USDC/3000, 15% Growth on Monad. Reruns below are on
the closest account the simulator allows. Measured unless stated.

## What the simulator can and cannot hold

- **Vaults are not in the replay.** `runBacktest` has no vault positions (the ERC-4626 code is a separate study arm that
  never goes through `decide`), so the Stable 50% cannot be vault supply, and a flat vault APY is not supported.
- **Idle USDC is refused by the session caps.** A pool-less Stable bucket (tried at 65/35 and 90/10) makes `decide` size
  the first mint at about half the account, over the `riskMint` cap, so every review after the first swap is denied
  (`POLICY_DENIED_CUMULATIVE`, 99 of 100 reviews) and no position is ever opened.
- **Closest feasible, used here:** the Stable share is the USDC/USDT 0.01% LP (a stable-yielding stand-in, not a vault;
  it earns pool fees and pays small LP gas that a vault would not, so gas and ops are somewhat overstated) at 65%, and
  WETH/USDC/3000 at **35% of the account, its true share** (stables 6500 / risk 3500). **Monad's 15% is left out**; it
  is folded into the Stable stand-in. Hold is the entry mix held. Same 7 TRAIN windows, same deposits, same variants'
  settings; variants: `variants/rerange-v7like-2026-11-13.json`, raw: `rerange-v7like-2026-11-13/{train,test}.json`,
  tables: `rerange-v7like-2026-11-13/tables.py`.

## TRAIN, v7-like (mean per window of the regime)

#### v7-like, calm (sep2026, calm-2025-09, calm-2026-04): mean per window

Deposit 100 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -0.45 | -0.449 | 4.94 | 0.51 | 16.7 | 1.0 |
| w2000-mpw2-guardon | 3 | -0.45 | -0.449 | 4.94 | 0.51 | 16.7 | 1.0 |
| w2000-mpw5-guardoff | 3 | -0.45 | -0.449 | 4.94 | 0.51 | 16.7 | 1.0 |
| w4000-mpw2-guardoff | 3 | +0.41 | +0.414 | 3.72 | 0.06 | 9.3 | 0.0 |
| w4000-mpw2-guardon | 3 | +0.41 | +0.414 | 3.72 | 0.06 | 9.3 | 0.0 |

Deposit 1000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -0.54 | -0.054 | 3.91 | 0.98 | 78.3 | 1.0 |
| w2000-mpw2-guardon | 3 | -0.54 | -0.054 | 3.91 | 0.98 | 78.3 | 1.0 |
| w2000-mpw5-guardoff | 3 | -0.54 | -0.054 | 3.91 | 0.98 | 78.3 | 1.0 |
| w4000-mpw2-guardoff | 3 | +4.31 | +0.431 | 3.72 | 0.40 | 45.7 | 0.0 |
| w4000-mpw2-guardon | 3 | +4.31 | +0.431 | 3.72 | 0.40 | 45.7 | 0.0 |

Deposit 10000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -0.50 | -0.005 | 3.80 | 4.43 | 480.0 | 1.0 |
| w2000-mpw2-guardon | 3 | -0.50 | -0.005 | 3.80 | 4.43 | 480.0 | 1.0 |
| w2000-mpw5-guardoff | 3 | -0.50 | -0.005 | 3.80 | 4.43 | 480.0 | 1.0 |
| w4000-mpw2-guardoff | 3 | +44.32 | +0.443 | 3.69 | 2.61 | 296.0 | 0.0 |
| w4000-mpw2-guardon | 3 | +44.32 | +0.443 | 3.69 | 2.61 | 296.0 | 0.0 |

#### v7-like, crash (oct2025, feb2025, mar2025): mean per window

Deposit 100 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -1.98 | -1.983 | 8.25 | 0.43 | 20.7 | 2.3 |
| w2000-mpw2-guardon | 3 | -1.30 | -1.300 | 8.25 | 0.37 | 19.7 | 2.3 |
| w2000-mpw5-guardoff | 3 | -2.18 | -2.184 | 8.25 | 0.61 | 24.7 | 3.7 |
| w4000-mpw2-guardoff | 3 | -1.67 | -1.668 | 8.08 | 0.29 | 18.0 | 1.7 |
| w4000-mpw2-guardon | 3 | -1.08 | -1.078 | 8.08 | 0.28 | 16.7 | 1.7 |

Deposit 1000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -9.37 | -0.937 | 8.24 | 1.00 | 74.3 | 2.3 |
| w2000-mpw2-guardon | 3 | -3.06 | -0.306 | 8.24 | 0.93 | 75.7 | 2.3 |
| w2000-mpw5-guardoff | 3 | -17.03 | -1.703 | 8.24 | 1.22 | 83.3 | 4.7 |
| w4000-mpw2-guardoff | 3 | -14.60 | -1.460 | 8.02 | 0.74 | 55.3 | 1.7 |
| w4000-mpw2-guardon | 3 | -8.57 | -0.857 | 8.02 | 0.63 | 50.7 | 1.7 |

Deposit 10000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 3 | -91.48 | -0.915 | 8.23 | 4.42 | 351.3 | 2.3 |
| w2000-mpw2-guardon | 3 | -27.50 | -0.275 | 8.23 | 3.86 | 341.3 | 2.3 |
| w2000-mpw5-guardoff | 3 | -92.86 | -0.929 | 8.23 | 4.51 | 350.0 | 4.7 |
| w4000-mpw2-guardoff | 3 | -143.32 | -1.433 | 8.01 | 3.24 | 261.7 | 1.3 |
| w4000-mpw2-guardon | 3 | -82.24 | -0.822 | 8.01 | 2.69 | 238.7 | 1.3 |

#### v7-like, rally (dec2024): mean per window

Deposit 100 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 1 | +0.61 | +0.614 | 1.45 | 0.65 | 11.0 | 0.0 |
| w2000-mpw2-guardon | 1 | +0.61 | +0.614 | 1.45 | 0.65 | 11.0 | 0.0 |
| w2000-mpw5-guardoff | 1 | +0.61 | +0.614 | 1.45 | 0.65 | 11.0 | 0.0 |
| w4000-mpw2-guardoff | 1 | +0.02 | +0.023 | 1.97 | 0.66 | 9.0 | 0.0 |
| w4000-mpw2-guardon | 1 | +0.02 | +0.023 | 1.97 | 0.66 | 9.0 | 0.0 |

Deposit 1000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 1 | +11.30 | +1.130 | 1.42 | 1.32 | 33.0 | 1.0 |
| w2000-mpw2-guardon | 1 | +11.30 | +1.130 | 1.42 | 1.32 | 33.0 | 1.0 |
| w2000-mpw5-guardoff | 1 | +11.30 | +1.130 | 1.42 | 1.32 | 33.0 | 1.0 |
| w4000-mpw2-guardoff | 1 | +5.87 | +0.587 | 1.93 | 0.88 | 22.0 | 0.0 |
| w4000-mpw2-guardon | 1 | +5.87 | +0.587 | 1.93 | 0.88 | 22.0 | 0.0 |

Deposit 10000 USDC

| Variant | n | net vs hold USD | net vs hold % | worst max DD % | gas USD | ops | reranges |
|---|---|---|---|---|---|---|---|
| prod-baseline | 1 | +118.80 | +1.188 | 1.42 | 5.31 | 130.0 | 1.0 |
| w2000-mpw2-guardon | 1 | +118.80 | +1.188 | 1.42 | 5.31 | 130.0 | 1.0 |
| w2000-mpw5-guardoff | 1 | +118.80 | +1.188 | 1.42 | 5.31 | 130.0 | 1.0 |
| w4000-mpw2-guardoff | 1 | +63.30 | +0.633 | 1.93 | 3.22 | 90.0 | 0.0 |
| w4000-mpw2-guardon | 1 | +63.30 | +0.633 | 1.93 | 3.22 | 90.0 | 0.0 |

#### v7-like, all 7 TRAIN windows: mean vs hold % / worst window %

| Variant | 100 | 1,000 | 10,000 |
|---|---|---|---|
| prod-baseline | -0.954 / -2.912 | -0.263 / -2.190 | -0.224 / -2.151 |
| w2000-mpw2-guardon | -0.662 / -2.908 | +0.007 / -0.445 | +0.050 / -0.396 |
| w2000-mpw5-guardoff | -1.041 / -3.391 | -0.592 / -2.650 | -0.230 / -2.186 |
| w4000-mpw2-guardoff | -0.534 / -2.114 | -0.357 / -2.047 | -0.334 / -2.012 |
| w4000-mpw2-guardon | -0.281 / -1.736 | -0.099 / -1.646 | -0.072 / -1.612 |


Worst max DD is now 8.2% in a crash week (the 35% exposure) and is the same for every variant except width 4000 (8.0%).

## TEST, run once (v7-like, prod-baseline against `w2000-mpw2-guardon`, 5 TEST windows, jun2025 included)

Cells are `prod-baseline | w2000-mpw2-guardon`. TEST was not used to choose anything here; it was already spent on
width in the geometry round, and this run is the single one for these two variants.

#### v7-like, TEST (run once): net vs hold USD (%), gas USD, reranges

Deposit 100 USDC

| Window | Regime | prod-baseline | w2000-mpw2-guardon |
|---|---|---|---|
| apr2025 | crash | -1.24 (-1.24%), gas 0.10, 2 rr | -1.23 (-1.23%), gas 0.09, 2 rr |
| may2025 | rally | -4.47 (-4.47%), gas 0.11, 2 rr | -4.47 (-4.47%), gas 0.11, 2 rr |
| jun2025 | calm | -0.25 (-0.25%), gas 0.47, 4 rr | -0.25 (-0.25%), gas 0.47, 4 rr |
| calm-2026-05 | calm | +0.25 (+0.25%), gas 0.12, 2 rr | +0.25 (+0.25%), gas 0.12, 2 rr |
| feb2026 | stable-stress | -2.47 (-2.47%), gas 4.72, 4 rr | -2.33 (-2.33%), gas 4.52, 4 rr |

Deposit 1000 USDC

| Window | Regime | prod-baseline | w2000-mpw2-guardon |
|---|---|---|---|
| apr2025 | crash | -11.86 (-1.19%), gas 0.45, 2 rr | -11.87 (-1.19%), gas 0.42, 2 rr |
| may2025 | rally | -44.05 (-4.41%), gas 0.22, 2 rr | -44.05 (-4.41%), gas 0.22, 2 rr |
| jun2025 | calm | +0.86 (+0.09%), gas 1.36, 5 rr | +0.86 (+0.09%), gas 1.36, 5 rr |
| calm-2026-05 | calm | +3.02 (+0.30%), gas 0.54, 2 rr | +3.02 (+0.30%), gas 0.54, 2 rr |
| feb2026 | stable-stress | +18.09 (+1.81%), gas 7.68, 4 rr | +17.92 (+1.79%), gas 6.04, 4 rr |

Deposit 10000 USDC

| Window | Regime | prod-baseline | w2000-mpw2-guardon |
|---|---|---|---|
| apr2025 | crash | -96.14 (-0.96%), gas 1.26, 2 rr | -96.58 (-0.97%), gas 1.25, 2 rr |
| may2025 | rally | -440.35 (-4.40%), gas 0.79, 2 rr | -440.35 (-4.40%), gas 0.79, 2 rr |
| jun2025 | calm | +17.28 (+0.17%), gas 6.00, 6 rr | +17.28 (+0.17%), gas 6.00, 6 rr |
| calm-2026-05 | calm | +18.78 (+0.19%), gas 2.80, 2 rr | +18.78 (+0.19%), gas 2.80, 2 rr |
| feb2026 | stable-stress | +224.36 (+2.24%), gas 15.24, 4 rr | +231.83 (+2.32%), gas 14.41, 4 rr |


## What this changes

- **Cap:** the case for 2 over 5 is stronger at 35%: crash weeks -9.37 (cap 2) vs -17.03 USD (cap 5, guard off) per
  1,000 USDC window, 4.7 re-ranges against 2.3. Prod's 2 stays.
- **Guard on TRAIN:** much larger than at 10%: crash -9.37 -> **-3.06** USD per window at 1,000 (-91.5 -> -27.5 at
  10,000); all 7 windows mean -0.263% -> +0.007%, worst window -2.19% -> -0.445%. It is again all feb2025
  (-21.9 -> -3.1 USD at 1,000); oct2025 and mar2025 move by under 0.1 USD. It did not fire in calm or rally. Same
  in-sample caveat as above (feb2025 and oct2025 fitted the thresholds).
- **Guard on TEST: not confirmed.** apr2025 (crash): -11.86 vs -11.87 USD at 1,000, no difference (it did not help in
  the Liberation Day crash). jun2025 (the dip that recovers): identical to the cent in all deposits, so **no freeze
  cost there either**: it did not fire. calm-2026-05 and may2025: identical. Only feb2026 moves: +18.09 -> +17.92 at
  1,000 (slightly worse), +224 -> +232 at 10,000 (slightly better), gas lower. So the TRAIN gain rests on one window
  and the one independent crash window (apr2025) shows nothing. The guard has no measured cost on TEST, and no measured
  benefit on it.
- **Width 4000:** at 35% it is worse in crashes (-14.6 vs -9.4 USD at 1,000 without guard) and loses half the rally
  (+5.9 vs +11.3) while winning calm (+4.3 vs -0.5). Mean over TRAIN is worse than w2000/cap 2/guard on at every deposit
  (guard on: -0.099% vs +0.007% at 1,000). With the guard on it is best only at 100 USDC (mean -0.281% vs -0.662%),
  from gas (0.06 vs 0.51 per calm window). May 2025 rally on TEST: both lose 4.4% to hold (not measured for 4000).
- **Recommendation:** unchanged in direction, weaker in strength. Keep cap 2 and width 2000. The guard is a low-cost
  option, not a proven benefit: measured cost on TEST is zero, measured TEST benefit is none, TRAIN benefit is one
  fitted window. Turn it on only as an insurance choice for Ot, not on the strength of these numbers. Confidence:
  medium on cap and width, low on the guard. Not modelled: vault yield, Monad sleeve, depth sizing, real v7 cap shape.
