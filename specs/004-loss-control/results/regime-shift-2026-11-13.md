# Regime shift: Balance weight to Stable in a downtrend (otto/mamoru#409, 13 Nov 2026)

Lab only. No live policy changes (`conservador-live-*` untouched). Account: the v7-like account of
`rerange-width-guard-2026-11-13.md` (v7-like section) (USDC/USDT LP 65% as the Stable stand-in, WETH/USDC/3000 35%), its `prod-baseline`
engine settings (lazy, maxPerWeek 2, maxWait 21600, dwell 1800, edgeBuffer 2500 bps / 100 ticks, horizon 86400, lvr
10000, costTest off, width 2000) and `w2000-mpw2-guardon` as comparators. Measured unless marked *assumed*.

## Findings on the mechanism (read before building)

- **The engine already reduces a bucket whose target drops.** `decide` runs every step on `weightTargets(obs, policy)`
  (packages/decide/src/rebalance/weights.ts), the Lab hook that CPPI, volTarget and staged exits use: it lowers a
  volatile bucket's preference and gives the difference to `stables`. With `allocation: 'target-weights'` the rest is
  production code: `reduceOf` (rerange/index.ts) proposes a `reduce` of the bucket's position once it sits more than
  `DRIFT_BPS` (5 points of the account) over its target, sized to the excess; `idleConvertOf` sells the freed WETH
  (not while the fall freeze holds that pool: the guard never turns a pause into a sell-back); `allocate` puts the
  savings into the Stable bucket (an LP here, a vault deposit on v7). Restoring the preference reverses it: Stable is
  over target, is reduced (or redeemed from a vault on v7), and `allocate` re-enters WETH/USDC. One operation per review.
- So no new executor and no backtest-only path: the rule is one more cap inside `weightTargets`
  (`regimePreference`), read only when `policy.regimeShift` is set. `release` (releaseOf) is the home-account payout
  path, not a weight path, and was not needed.
- The state needs memory (hysteresis, minimum time in state), so it follows the depeg guard / staged-exit pattern: a
  pure step in decide (`regimeStep`, packages/decide/src/guard/regime.ts) that the engine runs at every snapshot and
  passes as `Observation.guard.regime = { risk: true }` while defensive.

## The rule (`PolicyVersion.regimeShift`, Lab only)

Prices are the 30-minute TWAP of WETH in USDC (pool oracle cumulatives).

- **Enter defensive** (from normal, after `minDwellSeconds` in normal): 24 h TWAP fall >= `fall24hBps` AND either
  7-day TWAP fall >= `fall7dBps` (`belowMeanBps` 0) or TWAP >= `belowMeanBps` under the 7-day mean TWAP.
- **While defensive** the `risk` preference is `min(own, defensivePreference)`; the rest goes to `stables`.
- **Leave** (after `minDwellSeconds` defensive): TWAP back over the 7-day mean TWAP (`exitOnMean`), or no new low
  since entry for `exitNoLowSeconds`.
- Missing history never enters; while defensive only the no-new-low exit can run.
- **What the operator would store** per account: `{ defensive, since, low, lowAt }` (a flag and three numbers). Inputs
  per review from its snapshot history: TWAP now (already observed), TWAP 24 h ago (already built for the fall
  freeze), TWAP 7 days ago and the 7-day mean tick (two more cumulative reads; WETH/USDC/3000's oracle cardinality may
  not cover 7 days, so from the engine's own snapshots). A restart that loses the state starts normal.
- *Assumed, not swept:* `exitOnMean` true, `exitNoLowSeconds` 3 days, `minDwellSeconds` 1 day.
- 7-day figures use the history there is, at least 24 h: Lab windows are cut at their start (no warm-up samples in
  the datasets), so in a 7-day crash window "7-day fall" is the fall since the window opened. Live would see a full
  7 days; that changes when the signal fires.

## No change without the option (measured)

- `packages/backtest/src/regime-shift.test.ts`: result hashes of every policy in `POLICIES`, the two v7-like
  comparators and the staged/CPPI/volTarget rules (which share `weightTargets`) on a synthetic crash-and-recovery are
  pinned to the hashes captured on a4928035 before the change. They match.
- Real windows: all 42 TRAIN and 30 TEST comparator cells (`prod-baseline`, `w2000-mpw2-guardon`) have the same
  `resultHash` as `rerange-v7like-2026-11-13/{train,test}.json`.
- `packages/decide/src/guard/regime.test.ts`: a defensive flag without the rule gives the same decision.

## TRAIN sweep

Grid: X (`fall7dBps`) 500/1000/1500 x Y (`fall24hBps`) 200/400 x defensive share 15%/0% (from 35%) x guard off/on =
24, plus 4 of the "below the 7-day mean by Z" form (Z 500/1000, Y 200, 15%/0%, guard off). 30 variants x 7 TRAIN
windows x 3 deposits = 630 cells, 273 s. Not trimmed. aug2024 (TRAIN crash) cannot run on this account: the pricer
needs a cbBTC pool it lacks (same as the #406 v7-like run).

**Picking rule, written into `tables.py` before any table was read:** highest mean vs hold % over the 7 windows x 3
deposits, among regime variants whose dec2024 rally cost against their own comparator (same guard setting) is at most
0.25 points at every deposit and whose calm windows average at most 1 shift; ties within 0.02 points go to fewer
shifts, then guard off. 26 of 28 eligible. **Picked: `rs-x500-y400-d0-goff`** (X 5%, Y 4%, Balance 35% -> 0%, guard
off). Its guard-on twin is 0.002 points behind.

#### All 7 TRAIN windows, mean vs hold % (top, comparators, and the 15% form of the pick)

| Variant | 100 | 1,000 | 10,000 | worst window % | shifts/window |
|---|---|---|---|---|---|
| rs-x500-y400-d0-goff (pick) | +0.033 | +0.235 | +0.268 | -3.064 | 0.86 |
| rs-x500-y400-d0-gon | +0.016 | +0.234 | +0.279 | -3.181 | 0.86 |
| rs-x500-y200-d0-goff | -0.123 | +0.092 | +0.126 | -3.064 | 1.14 |
| rs-x500-y400-d1500-gon | -0.451 | -0.034 | +0.011 | -2.069 | 0.86 |
| w2000-mpw2-guardon | -0.662 | +0.007 | +0.050 | -2.908 | 0 |
| rs-x500-y400-d1500-goff | -0.578 | -0.150 | -0.140 | -1.987 | 0.86 |
| prod-baseline | -0.954 | -0.263 | -0.224 | -2.912 | 0 |
| rs-x1000-y400-d0-goff | -1.093 | -0.799 | -0.760 | -4.002 | 0.86 |
| rs-x1500-y400-d0-goff | -1.410 | -1.067 | -1.095 | -4.002 | 0.71 |

Full ranking and every regime x deposit table: `regime-shift-2026-11-13/train-tables.md`.

#### TRAIN by regime, 1,000 USDC, mean per window

| Regime | Variant | net vs hold USD | % | worst DD % | gas USD | swaps | shifts |
|---|---|---|---|---|---|---|---|
| calm (3) | prod-baseline | -0.54 | -0.054 | 3.91 | 0.98 | 27.0 | 0 |
| calm (3) | w2000-mpw2-guardon | -0.54 | -0.054 | 3.91 | 0.98 | 27.0 | 0 |
| calm (3) | rs-x500-y400-d0-goff | +6.51 | +0.651 | 1.55 | 0.51 | 24.0 | 0.3 |
| crash (3) | prod-baseline | -9.37 | -0.937 | 8.24 | 1.00 | 23.7 | 0 |
| crash (3) | w2000-mpw2-guardon | -3.06 | -0.306 | 8.24 | 0.93 | 23.0 | 0 |
| crash (3) | rs-x500-y400-d0-goff | -4.79 | -0.479 | 6.22 | 0.38 | 18.7 | 1.7 |
| rally (1) | all three | +11.30 | +1.130 | 1.42 | 1.32 | 14.0 | 0 |

Crash windows one by one, 1,000 USDC (USD vs hold / shifts): oct2025 -4.48 / -4.45 / **+5.23 (1)**; feb2025
-21.90 / -3.08 / **+7.57 (1)**; mar2025 -1.74 / -1.66 / **-27.18 (3)** (baseline / guard on / pick).

What TRAIN says:
- **Larger X is worse everywhere.** X 1000 and 1500 fire after most of the fall and leave on the first bounce over the
  7-day mean: sell low, buy back higher. Crash at 1,000: X 500 -4.79, X 1000 -27.18, X 1500 -26.70 USD (guard off, 0%).
- **Y moves little**: at X 500 only in calm (Y 200 adds a shift there and gives up 3 USD per window); at X 1000
  and 1500 by under 1.5 USD per crash window. The 7-day test binds.
- **0% beats 15%** whenever the signal is right, and loses more when it is wrong; the 15% form has the smaller worst
  window (-1.99% vs -3.06%).
- **mar2025 is a whipsaw**: 3 shifts in 7 days with a one-day minimum, -27 USD against -1.7 for the baseline.
- **Calm gains are a direction bet, not a fee effect**: the pick earns +6.51 USD per calm window by sitting out WETH
  while it drifted down in those months. Nothing in the signal knows that.
- The guard adds nothing on top of the pick (it acts on the same falls, after the risk bucket is already out).

## TEST, run once (prod-baseline, w2000-mpw2-guardon, rs-x500-y400-d0-goff)

#### 1,000 USDC: net vs hold USD (%), worst DD %, gas USD, swaps, shifts

| Window | Regime | prod-baseline | w2000-mpw2-guardon | rs-x500-y400-d0-goff |
|---|---|---|---|---|
| apr2025 | crash | -11.86 (-1.19), DD 6.90, gas 0.45, 59 sw | -11.87 (-1.19), DD 6.90, 0.42, 49 | **+30.54 (+3.05)**, DD 1.58, 0.10, 12, 1 shift |
| may2025 | rally | -44.05 (-4.41), DD 0.72, 0.22, 15 | same | same, 0 shifts (no false signal) |
| jun2025 | calm, dip that recovers | +0.86 (+0.09), DD 6.72, 1.36, 89 | same | **-28.48 (-2.85)**, DD 6.00, 1.07, 78, 2 shifts |
| calm-2026-05 | calm | +3.02 (+0.30), DD 3.21, 0.54, 20 | same | -8.24 (-0.82), DD 3.77, 0.61, 26, 3 shifts, **626 reviews refused** |
| feb2026 | stable-stress | +18.09 (+1.81), DD 5.92, 7.68, 42 | +17.92 (+1.79), DD 5.82, 6.04, 38 | -6.28 (-0.63), DD 3.71, 2.01, 19, 1 shift |

#### Mean vs hold % over the 5 TEST windows (100 / 1,000 / 10,000)

| Variant | 100 | 1,000 | 10,000 | worst window % |
|---|---|---|---|---|
| prod-baseline | -1.638 | -0.679 | -0.552 | -4.471 |
| w2000-mpw2-guardon | -1.608 | -0.682 | -0.538 | -4.471 |
| rs-x500-y400-d0-goff | -1.587 | -1.130 | -1.201 | -4.471 |

100 and 10,000 USDC per window: `regime-shift-2026-11-13/test-tables.md` (same signs; at 10,000 apr2025 +299 vs -96,
jun2025 -281 vs +17, feb2026 -79 vs +224 USD).

What TEST says:
- **The one crash is a large win**: apr2025 +42 USD per 1,000 against the baseline, drawdown 1.6% against 6.9%.
- **False signals cost about as much**: jun2025 (WETH -25% on 22 Jun, then recovers) -29 USD; feb2026 -24 USD;
  calm-2026-05 -11 USD. may2025 (rally) costs nothing: the rule did not fire.
- **The session caps stop it repeating**: in calm-2026-05, after the third shift, 626 reviews were refused by a
  cumulative cap of the approval (`POLICY_DENIED_CUMULATIVE`; the entry grants' totals are sized for one entry plus
  top-ups, and the WETH/USDC enter-mint total stood at 88% of its cap). Live would hit the same wall until the owner
  renews.
- Net over TEST it is worse than both comparators at 1,000 and 10,000 USDC (-1.13% vs -0.68% per window at 1,000).

## Caveats

- **No vaults** (measured limitation): the Stable share is an LP stand-in, so gas and swaps per shift are higher than
  a vault deposit/redeem would be, and the vault yield while defensive is not counted.
- **No Monad** Growth sleeve (15% folded into the Stable stand-in).
- **TRAIN overlaps the guard's fitting** (feb2025, oct2025); the regime thresholds were picked on the same windows.
- **Few crash windows**: 3 on TRAIN (aug2024 cannot run on this account), 1 on TEST. Every conclusion on crashes
  rests on 1-3 events.
- **Truncated history** (*assumed* equivalent): the 7-day figures start at each window's first sample.
- *Assumed:* exit settings (mean exit on, 3-day no-new-low, 1-day minimum in state) were not swept.
- Cap refusals are what the Lab's session model does (enforce, renewed yearly); a real approval renewal was not modelled.

## Recommendation

**Do not ship.** Confidence: medium that the picked rule loses money on average (TEST mean worse than both comparators
at 1,000 and 10,000, three of four non-rally TEST windows lose 11-29 USD per 1,000), low on any finer claim (one
TEST crash). It is a bet on ETH's direction after a 5% weekly fall: it paid in apr2025, oct2025 and feb2025 and lost in
mar2025, jun2025, feb2026 and calm-2026-05. It cuts drawdown in real crashes (6.9% to 1.6% in apr2025) and could be
offered as an explicit owner choice ("protect me in downtrends, I accept the whipsaw"), not as a default.

To ship it anyway: the operator keeps `{ defensive, since, low, lowAt }` per account (D1 or its state file) and builds
`guard.regime` from snapshot history (TWAP 7 days ago and the 7-day mean, beyond the pool oracle's reach); an
engine-settings key for the rule and its thresholds; a cap check, since the entry totals of today's approval cover
only a few round trips (calm-2026-05 hit one after three shifts); no UI change needed (the decision already carries `targets`). On v7 the move is
reduce WETH/USDC + vault deposit, and back by vault redeem + entry; that path was not simulated.

Files: rule `packages/decide/src/guard/regime.ts`, wiring `rebalance/weights.ts`; backtest `src/run.ts`, `observe.ts`,
`world.ts`, `sweep.ts`; tests `packages/decide/src/guard/regime.test.ts`, `packages/backtest/src/regime-shift.test.ts`;
variants `variants/regime-shift-2026-11-13.json` (TRAIN) and `variants/regime-shift-test-2026-11-13.json` (TEST); raw
`regime-shift-2026-11-13/{train,test}.json`; tables `regime-shift-2026-11-13/tables.py` (`python3 tables.py train|test`).
