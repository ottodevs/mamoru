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
