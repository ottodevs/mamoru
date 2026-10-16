# Range geometry: skew in a fall and volatility width (Lab, 16 Oct 2026)

Ticket otto/mamoru#101. Experiments 1 and 2 of the risk research note (noema
`lp-risk-experiments-2026-10-16`). Lab only: policy `conservador-lab-geometry-v1` (fork), `conservador-live-v2`
untouched. Sim `backtest-1`, review every sample, sessions enforced, deposits 1,000 and 100,000 USDC. Raw sweeps,
variant files and the scoring script are in `geometry-2026-10-16/`.

## What was built

- `policy.geometry.skew` `{ belowShareBps, regime: 'ret24h' | 'ema7d', fallBps, mirror }`. In a falling regime a new
  range holds `belowShareBps` of its width below the price (in the volatile token's price), so it starts mostly in
  USDC. Regime `ret24h`: the 24 h TWAP change is a fall of at least `fallBps`; `ema7d`: the TWAP is under a 7-day EMA.
  `mirror`: upward skew by the same amount in the opposite regime. The edge the placement sits near gets half the
  short side as its re-range threshold, so a 95% placement does not trip the re-range at once.
- `policy.geometry.volWidth` `{ k, horizonSeconds, minTicks, maxTicks, earlyRatio }`. Width = k * sigma_24h *
  sqrt(H) in ticks, clamped to [600, 6000]. With `earlyRatio` r > 0: while sigma_1h > r * sigma_7d, sigma is
  max(sigma_24h, sigma_1h), and an in-range position narrower than 2/3 of that width is re-ranged (cooldown applies).
- The stables pool (it has a `widthTicksByPool` entry) keeps 40 ticks and is never skewed. Missing history: the rule
  abstains (centred range, policy width).
- History (`Observation.geometry`): 24 h-ago 30-min TWAP, 7-day EMA (time constant 3.5 days) of the TWAP tick, and
  realized volatility from 10-minute TWAP means over 1 h, 24 h and 7 days. Built by the backtest only for a policy with
  `geometry`; the engine does not build it.

## Protocol

Declared before the TRAIN grid ran (`score.py`):

- Score, summed over both deposits, in pp: (- change in mean max drawdown) + (- change in worst max drawdown) +
  (change in worst-window return), against the unchanged policy.
- Constraint: mean return no worse than baseline by more than 0.10 pp at both deposits.
- Candidates: up to two per experiment with a positive score that pass the constraint. Gas and ops reported, not scored.
- Each candidate runs once on TEST. Nothing was re-tuned after it.

Start-time sensitivity: one 10-minute shift moved a window's return by up to 0.5 pp. Per-window deltas under 0.5 pp
are noise.

## TRAIN grid (7 windows; 39 variants)

Baseline on TRAIN: 1k mean -0.33%, worst -3.58%, mean max DD 3.60%, worst max DD 7.62%; 100k -0.23%, -5.58%, 3.52%, 7.49%.

Skew: share below {50, 65, 80, 95}% x regime {ret24h -2%, ret24h -4%, ema7d}, and the mirror at {65, 80, 95}%.

| Variant | Score | Pass | 1k: d mean ret / d mean DD / d worst DD / d worst ret | 100k: same | DD windows better-worse (1k, 100k) |
|---|---|---|---|---|---|
| **s95-r4** | +0.69 | yes | -0.04 / -0.33 / -0.04 / -0.16 | +0.01 / -0.28 / -0.05 / +0.15 | 5-0, 7-0 |
| **s65-ema** | +0.64 | yes | -0.00 / -0.05 / -0.20 / +0.07 | +0.01 / -0.07 / -0.00 / +0.25 | 2-1, 3-0 |
| s65-ema-m | +0.49 | yes | -0.04 / -0.06 / -0.20 / +0.07 | -0.00 / +0.10 / -0.00 / +0.25 | 4-2, 2-3 |
| s80-r4 | +0.28 | yes | -0.04 / -0.08 / -0.03 / -0.04 | -0.05 / -0.03 / -0.01 / +0.18 | 3-0, 2-0 |
| s95-ema | +0.25 | no (1k mean -0.24) | | | |
| s80-ema | +0.23 | yes | | | |
| s80-r2 | +0.22 | yes | | | |
| s95-r2 | +0.16 | no (1k mean -0.28) | | | |
| s50-* | 0.00 | yes | identical to baseline (sanity check: 50% is the centred range) | | |
| other skew | < 0 | | every mirrored 80-95% variant is worse: more ops, worse worst return | | |

Volatility width: k {1.5, 2, 3} x H {1 d, 3 d} x early widening r {off, 1.5, 2}. **No variant scored above zero.**
The best were k=3, H=3 d (the widest): r=0 scored +0.10 but failed the constraint (1k mean -0.27 pp); r=1.5 scored
-0.02 and passed (1k mean +0.27 pp, worst DD -0.35 pp, but worst return -0.40 pp; 100k gas -25%). Narrower widths
(k 1.5-2, H 1 d) were clearly worse: up to +384 ops and -3.2 pp on the worst window at 1k.

Chosen: **experiment 1: s95-r4 and s65-ema. Experiment 2: none** by the rule. For the requested combination the
best of experiment 2, `v-k3-h3d-r1.5`, was paired with `s95-r4`; it is run on TEST as a reference, not as a
candidate. The combination on TRAIN: score -0.97 (1k worst return -5.64% against -3.58%, mar2025 -2.13 pp); it is
worse than either part.

## TEST (5 windows, run once)

| Variant | 1k mean ret | 1k worst ret | 1k mean / worst DD | 100k mean ret | 100k worst ret | 100k mean / worst DD | Ops 1k / 100k | Gas 1k / 100k |
|---|---|---|---|---|---|---|---|---|
| baseline | -0.58 | -3.50 | 4.26 / 9.24 | -0.71 | -4.64 | 4.56 / 10.51 | 536 / 804 | 21.46 / 12.11 |
| s95-r4 | -0.50 | -3.63 | 3.68 / 6.90 | **-1.07** | -4.64 | 4.51 / 10.27 | 586 / 803 | 12.87 / 10.08 |
| s65-ema | -0.58 | -3.16 | 3.82 / 7.35 | -0.82 | -4.64 | 4.51 / 10.27 | 567 / 803 | 12.96 / 10.08 |
| v-k3-h3d-r1.5 (not a candidate) | -0.47 | -3.25 | 4.35 / 9.30 | -0.75 | -4.17 | 4.05 / 6.75 | 466 / 835 | 13.10 / 10.73 |
| combination (not a candidate) | **-1.03** | -4.37 | 3.90 / 7.17 | -0.95 | -4.17 | 4.47 / 9.04 | 509 / 843 | 11.51 / 10.60 |

Per window, change against baseline (return pp / max DD pp):

| Window | Deposit | Baseline ret / DD | s95-r4 | s65-ema | v-k3-h3d-r1.5 | combination |
|---|---|---|---|---|---|---|
| apr2025 crash | 1k | -3.50 / 5.44 | -0.13 / -0.88 | +0.34 / -0.53 | +0.25 / -0.32 | +0.05 / -0.53 |
| may2025 rally | 1k | 2.46 / 1.01 | -0.45 / +0.04 | 0 / 0 | +0.12 / +0.06 | -0.16 / -0.02 |
| jun2025 calm | 1k | 1.12 / 3.46 | -0.79 / +0.24 | -0.41 / +0.24 | +0.23 / -0.17 | -0.01 / -0.05 |
| calm-2026-05 | 1k | -0.14 / 2.16 | 0 / 0 | +0.04 / -0.03 | -0.57 / +0.83 | -0.59 / +0.83 |
| feb2026 stable stress | 1k | -2.84 / 9.24 | +1.78 / -2.34 | +0.03 / -1.89 | +0.53 / +0.06 | -1.53 / -2.07 |
| apr2025 crash | 100k | -4.64 / 6.20 | 0 / 0 | 0 / 0 | +0.47 / -0.74 | +0.47 / -0.74 |
| may2025 rally | 100k | 2.42 / 1.10 | -1.35 / +0.08 | 0 / 0 | +0.24 / +0.01 | -0.19 / -0.17 |
| jun2025 calm | 100k | 1.69 / 2.01 | +0.04 / -0.06 | 0 / 0 | -0.79 / +1.09 | -0.79 / +1.09 |
| calm-2026-05 | 100k | -1.00 / 2.96 | 0 / 0 | 0 / 0 | -0.48 / +0.85 | -0.48 / +0.85 |
| feb2026 stable stress | 100k | -2.04 / 10.51 | -0.46 / -0.24 | -0.51 / -0.24 | +0.38 / -3.76 | -0.18 / -1.47 |

Reading:

- **s95-r4 fails on TEST.** 100k mean -0.35 pp (the constraint allows -0.10), from may2025 (-1.35 pp: a 24 h fall
  inside a +40% week placed ranges below the price and missed the rally). The 1k worst-DD cut (9.24 to 6.90) is one
  window, feb2026; the other four windows lose return or stay flat (1 better, 3 worse).
- **s65-ema is close to neutral.** 1k: mean unchanged, worst return +0.34 pp, worst DD 9.24 to 7.35 (feb2026), 3 of 5
  windows better on DD. 100k: only feb2026 changes (-0.51 pp, -0.24 pp DD), mean -0.10 pp, at the edge of the
  constraint. Most per-window changes are inside the 0.5 pp noise.
- **The volatility width (reference only) did best on TEST**: 100k worst DD 10.51 to 6.75 on feb2026, worst return
  +0.47 pp, but the calm windows lose 0.5-0.8 pp with higher DD. It was not a candidate on TRAIN, and choosing it now
  would be tuning on TEST.
- **The combination is worse than both parts** on TRAIN and TEST (1k mean -0.45 pp on TEST).
- Gas: the 1k baseline's 21.46 USDC on TEST is mostly feb2026 (19.17), a few ops at high base fee. Every variant
  missed those blocks by timing, so the gas cut there is chance, not the rule.

## Recommendation

Do not promote either rule to a live policy. Neither experiment produced a candidate that passed TEST by the
declared rule: s95-r4 fails the return constraint at 100k, s65-ema passes only at the edge, and both gains rest on
one window (feb2026). Keep both options in the Lab, off by default. If the Lab comes back to geometry: s65-ema with
the LC-L1 start offsets on TRAIN (to see whether its effect is more than noise), and the volatility width judged on
new windows, since this TEST set is now spent for it. The research note's next experiments (4 recentre only when
it pays, 6 volatility-targeted weights) go first.

## Limits

- Lab windows are cut at their start: the 7-day EMA and 7-day volatility use the history inside the window (at
  least 24 h), so in a 7-day window they never see a full week. Live would have it.
- `vol24hBps` becomes available at 80% coverage of a day (about 19 h into a window), the other figures at 24 h. Left
  as run (review finding 1 on PR #56): changing it now would mean a second TEST run.
- The reduced edge threshold of a skew rule applies to every position of the pool, centred ones too (finding 2).
- The skew applies to every new mint of a volatile pool in the regime, top-ups included, not only re-mints.
- Same simulator limits as spec 004: 5-10 min samples, single-range swap impact, no MEV.
