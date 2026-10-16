# 004 Lab round 3: stables depeg guard, staged exits, CPPI with the guard, start offsets (16 Oct 2026)

Ticket otto/mamoru#101. Research note: noema `1-projects/mamoru/research/capital-protection/lp-risk-experiments-2026-10-16.md`
(experiments 3 and 7). Follows `rebalance-policy-2026-10-16.md` (CPPI 85/m2 passed TRAIN and TEST; CPPI 90/m2 failed
TEST at 100,000 in feb2026). Lab-only policy options, off by default; `conservador-live-v2` is unchanged byte for byte.

## Protocol (declared before any TRAIN grid of this round ran)

Same objective as the earlier rounds. Simulator `backtest-1`, production `decide`, review every sample, sessions
enforced and renewed, deposits 1,000 and 100,000 USDC (the 5 USD column is left out: it measures gas, not policy).

- Primary, at 1,000 and at 100,000: lower mean max drawdown, lower worst max drawdown, better worst-window return
  (6 criteria). Constraint: mean return not worse than baseline by more than 0.10 pp at either deposit.
- Ranking: pass the constraint, then criteria won, then the sum of the primary deltas. Gas and ops reported, and the
  windows whose return improved, with how many by more than 0.5 pp (start-time noise).
- Scorer: `round3-2026-10-16/score.ts`, written with this protocol.

**(A) Depeg guard**, on the live policy: deviation z {30, 50, 100} bps x hold t {10, 30} min x action {freeze, exit}
(12 variants). Fixed, from spec 004: release when under 20 bps for 72 h, exit sales sized to 20 bps of impact.
The Lab has no Chainlink feed: the reference is the stables pool's 30-min TWAP against 1.0, either side.

Before this protocol a data-only scan (no policy run) measured the USDC/USDT 30-min TWAP deviation in every window, to
know whether TRAIN can exercise the guard at all. TRAIN: max 56 bps (mar2025: 96 samples >= 30, 6 >= 50, none >= 100);
every other TRAIN window with cbBTC stays under 30. aug2024 (TRAIN, no cbBTC) reaches 183 bps (363 samples >= 50, 7 >=
100). TEST: feb2026 113 bps (62 >= 30, 14 >= 50, 2 >= 100), calm-2026-05 31 bps (4 >= 30), the rest under 20. So on
the 7 TRAIN windows the z=100 variants equal the baseline by construction and z=50 fires for about an hour.

Because of that, a supplementary TRAIN run: the same 12 variants on **aug2024** with the live policy minus the cbBTC
pool (`nobtc`: the btc-usdc bucket has no pool, so stables and risk share the account 5:1), against `nobtc` without
the guard. It is the only TRAIN window with a real depeg; the pool was young and thin then.

Selection for (C), declared now: among the variants that pass the constraint on the 7 TRAIN windows, the one with the
largest sum over both deposits of (Δ return - Δ max DD) on aug2024-nobtc; ties broken by the higher z, then the
longer t, then freeze over exit (the least intrusive).

**(B) Staged exits**, on the live policy: steps {(-3, -6, -10), (-5, -10, -15)} % from the 7-day high x re-entry
{ladder, ema} (4 variants); the ladder gap is the third step (10% or 15%). Up to 2 candidates that pass the
constraint, by the ranking, go to TEST once each. Staged exits have never been run on TEST.

**(C) CPPI with the guard**: cppi85-m2 and cppi90-m2, each with and without the guard chosen in (A), on TRAIN.
TEST was already seen by both CPPI candidates in the previous round, so their TEST run here is a **robustness check
only**: it can show whether the guard closes the feb2026 hole, not select or tune anything.

**(D) Start offsets** for the final candidates (baseline, the two CPPI+guard variants, the staged candidates): the
TRAIN windows started 0, 10, 60, 240 and 720 minutes late (end unchanged), each against the baseline at the same
offset. Reported: the distribution (min, median, max over the 5 offsets) of the deltas of the four aggregate metrics.


## What was built

| Option | Where | Rule |
|---|---|---|
| `depegGuard { thresholdBps, holdSeconds, action, releaseBps, releaseSeconds, exitImpactBps }` | `decide/src/guard/depeg.ts`, `decide/src/index.ts` | `pegStep` (pure, called by the run at every sample as the engine would): trips after the stables pool's 30-min TWAP is >= z bps off 1.0 for t without a break; releases after 72 h under 20 bps. Tripped: the stables bucket is frozen (no entry, top-up, re-range, reduce, idle convert or harvest in that pool; its share waits as USDC). `exit` also closes the position (reduce of all its liquidity) and sells USDT to USDC, each sale sized to 20 bps of impact against the active liquidity. Code `RISK_DEPEG_PAIRED`. |
| `stagedExit { step1Bps, step2Bps, step3Bps, reentry, ladderGapBps }` | `decide/src/rebalance/staged.ts`, `weights.ts` | `stageStep` (pure, per volatile bucket, every sample): a third of the bucket's preference goes to stables at each step of fall of the TWAP from the 7-day high (or the high since the last re-entry). The bucket is then reduced at a 1-point drift band (live: 5) and its freed token converted, through the ordinary reduce and convert. `ema`: all thirds back when the TWAP, having been under its 7-day EMA, crosses over it. `ladder`: each third back `ladderGapBps` under the price it was sold at; all back within step 1 of the high. Code `RISK_STAGED_EXIT`. |
| `--start-offset <min>` | `backtest/cli/sweep.ts` | every window starts that much later, end unchanged. |

`Decision.labGuards` reports both, only with one of the options set. `conservador-live-v2` replays with the same result
hashes as main on all TRAIN cells. Reproduce: variant files and `score.ts` / `offsets.ts` in `round3-2026-10-16/`;
sweep outputs there as `*.sweep.json`; per-window tables in `raw/round3-*.md`.

## (A) Depeg guard, TRAIN

7 TRAIN windows (`raw/round3-depeg-train.md`):

| Variant | Pass | Won /6 | Σ | 1k: Δmean / ΔmeanDD / ΔworstDD / Δworst ret | 100k: same |
|---|---|---|---|---|---|
| dg50-t10-exit | yes | 2 | +1.12 | -0.06 / +0.01 / 0 / -0.35 | +0.19 / -0.14 / 0 / +1.35 |
| dg30-t10-exit | yes | 2 | +1.08 | -0.06 / +0.02 / 0 / -0.38 | +0.19 / -0.14 / 0 / +1.34 |
| dg30-t30-exit | yes | 2 | +1.06 | -0.07 / +0.02 / 0 / -0.40 | +0.19 / -0.14 / 0 / +1.34 |
| dg50-t30-*, dg100-* | yes | 0 | 0 | never trips: identical to baseline | |
| dg30-t30-freeze | yes | 0 | -0.25 | -0.05 / 0 / 0 / -0.25 | 0 |
| dg30-t10-freeze | yes | 0 | -0.39 | -0.06 / +0.02 / 0 / -0.37 | 0 |

Everything above comes from one window, mar2025 (max 56 bps). The guard is a no-op in the other six.

aug2024, `nobtc` policy (`raw/round3-depeg-aug2024.md`), against `nobtc` without the guard:

| Variant | 1k Δ return / Δ max DD | 100k Δ return / Δ max DD |
|---|---|---|
| dg30-t10-freeze | -0.06 / -0.23 | -0.06 / -0.28 |
| other freeze variants | 0 / 0 (identical to `nobtc`: nothing in the stables pool to block while tripped) | 0 / 0 |
| every exit variant | -2.0 .. -2.8 / +1.9 .. +2.8 | -1.9 .. -2.4 / +2.9 .. +3.4 |

**Exit loses 2-3 pp** wherever the peg comes back: it sells USDT at the bottom of the deviation and pays the
impact. Freeze holds the position and waits.

By the declared rule (passes on TRAIN, best Σ(Δreturn - ΔmaxDD) on aug2024): **dg30-t10-freeze** (+0.39; every other
freeze variant 0, every exit variant negative).

## (B) Staged exits, TRAIN

| Variant | Pass | Won /6 | Σ | 1k: Δmean / ΔmeanDD / ΔworstDD / Δworst ret | 100k: same | ops 1k / 100k (base 547 / 1036) | gas 1k / 100k (13.12 / 49.80) |
|---|---|---|---|---|---|---|---|
| **st3-6-10-ema** | yes | 5 | +8.91 | -0.01 / -1.20 / -3.86 / -0.01 | +0.11 / -0.50 / -1.11 / +2.25 | 775 / 1136 | 21.15 / 59.11 |
| st3-6-10-ladder | no (1k -0.14) | 5 | +5.67 | -0.14 / -0.81 / -2.38 / -0.52 | -0.00 / -0.41 / -1.06 / +1.53 | 916 / 1231 | 27.06 / 59.51 |
| st5-10-15-ema | no (1k -0.33) | 5 | +3.67 | -0.33 / -0.62 / -1.66 / -0.97 | +0.13 / -0.29 / -0.56 / +1.51 | 662 / 1122 | 22.86 / 65.96 |
| st5-10-15-ladder | no (1k -0.41) | 5 | +0.67 | -0.41 / -0.16 / -1.76 / -1.40 | -0.05 / -0.02 / -0.02 / +0.12 | 789 / 1204 | 20.07 / 68.29 |

Only st3-6-10-ema passes the constraint; it is the one TEST candidate. Windows improved (return): 3/7 at 1k (2 above
0.5 pp), 2/7 at 100k (1). It costs ops and gas: +42% ops and +61% gas at 1k (dec2024: 105 ops vs 36, gas 9.14 vs
2.91; the calm months +60-100 ops). The ladder re-buys into the fall and loses on return; the wider steps fire too
late to cut much.

**At 100,000 the staged exit is mostly inert**, for the reason found last round: harvests spend the `convert-any` uses,
every later harvest proposal is refused, and `decide` proposes a harvest before any reduce, so the staged reduce is
never proposed (apr2025 100k: 0 reduces, 597 refused reviews; jun2025 and calm-2026-05 identical to baseline). The
100k numbers measure that interaction, not the rule.

## (C) CPPI with the guard, TRAIN

| Variant | Pass | Won /6 | Σ | 1k: Δmean / ΔmeanDD / ΔworstDD / Δworst ret | 100k: same | ops 1k / 100k |
|---|---|---|---|---|---|---|
| cppi90-m2 | yes | 6 | +19.65 | +0.22 / -2.18 / -4.55 / +2.13 | +0.20 / -2.06 / -4.54 / +4.20 | 344 / 1249 |
| cppi90-m2+dg30-t10-freeze | yes | 6 | +19.00 | +0.17 / -2.15 / -4.55 / +1.97 | +0.14 / -2.01 / -4.54 / +3.79 | 330 / 1195 |
| cppi85-m2 | yes | 6 | +11.99 | +0.08 / -1.38 / -2.78 / +1.29 | +0.02 / -1.17 / -3.06 / +2.30 | 422 / 1190 |
| cppi85-m2+dg30-t10-freeze | yes | 6 | +11.78 | +0.03 / -1.35 / -2.78 / +1.21 | +0.00 / -1.16 / -3.06 / +2.21 | 401 / 1134 |

The CPPI rows reproduce the previous round exactly. On TRAIN the guard costs 0.05-0.4 pp, all in mar2025 (it freezes
the stables bucket through a 30-56 bps wobble that came back), and saves 14-54 ops.

## TEST, run once

| Variant | Pass | Won /6 | Σ | 1k: Δmean / ΔmeanDD / ΔworstDD / Δworst ret | 100k: same | ops 1k / 100k (536 / 804) | gas 1k / 100k (21.46 / 12.11) |
|---|---|---|---|---|---|---|---|
| dg30-t10-freeze (candidate) | yes | 0 | 0 | -0.06 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 514 / 804 | 21.09 / 12.11 |
| st3-6-10-ema (candidate) | yes | 5 | +11.50 | -0.08 / -1.48 / -5.05 / +0.75 | +0.02 / -0.72 / -3.50 / -0.00 | 674 / 920 | 18.45 / 19.55 |
| cppi90-m2+dg30-t10-freeze (robustness) | yes | 6 | +21.35 | +0.38 / -2.52 / -5.29 / +1.69 | +0.38 / -2.73 / -6.33 / +2.80 | 329 / 866 | 14.61 / 11.67 |
| cppi90-m2 (seen last round) | no | 4 | +2.87 | +0.44 / -2.52 / -5.29 / +1.99 | -1.49 / -1.05 / +2.06 / -5.91 | 363 / 936 | 15.16 / 12.65 |
| cppi85-m2+dg30-t10-freeze (robustness) | yes | 6 | +14.72 | +0.23 / -1.77 / -3.85 / +1.22 | +0.27 / -1.81 / -4.20 / +1.87 | 428 / 868 | 15.97 / 18.25 |
| cppi85-m2 (seen last round) | yes | 6 | +14.72 | +0.23 / -1.77 / -3.85 / +1.22 | +0.30 / -1.81 / -4.20 / +1.87 | 462 / 930 | 16.64 / 19.12 |

- **Guard alone (a genuine TEST of a TRAIN pick)**: on the live policy it changes only feb2026 at 1k (-0.29 pp,
  22 fewer ops). The live policy holds 50% in stables but re-ranges them little, so it has little to protect.
- **Staged st3-6-10-ema (genuine TEST)**: passes the constraint and 5 of 6 criteria (100k worst return -0.00).
  Windows improved: 2/5 at 1k (apr2025 +0.75, feb2026 +0.75; jun2025 -1.14, calm-2026-05 -0.34, may2025 -0.44), 1/5 at
  100k (inert there, see above). Worst DD -5.05 pp at 1k is feb2026. It churns in calm months: jun2025 231 ops vs 142,
  calm-2026-05 154 vs 52 with 549 refused reviews.
- **CPPI + guard, robustness check only.** Both CPPI rules had been run on these TEST windows last round, so this
  is not a selection: the guard was chosen on TRAIN and this run only shows what it does to the known hole. It closes
  it: cppi90-m2 feb2026 at 100k goes from -10.55% to -1.17% (+9.38 pp, max DD -8.39 pp vs the unguarded run; ops 176
  vs 246). Against the live baseline cppi90-m2+guard then wins every criterion at both sizes. cppi85-m2 is unchanged by
  the guard (feb2026 100k -0.15 pp, 62 fewer ops). Windows improved vs baseline for cppi90-m2+guard: 3/5 at each size,
  all three above 0.5 pp; the two losers are the rally and calm months (-0.6 to -1.5 pp), as on TRAIN.

## (D) Start offsets, TRAIN

TRAIN windows started 0, 10, 60, 240, 720 min late; each variant against the baseline at the same offset. min /
median / max over the 5 offsets (`raw/round3-offsets.md`):

| Variant | dep | Δ mean return | Δ mean max DD | Δ worst max DD | Δ worst return | constraint held |
|---|---|---|---|---|---|---|
| baseline (level, %) | 1k | -0.43 / -0.39 / -0.31 | 3.60 / 3.66 / 3.77 | 7.62 / 7.80 / 7.91 | -4.47 / -3.58 / -3.35 | |
| baseline (level, %) | 100k | -0.33 / +0.04 / +0.19 | 3.27 / 3.52 / 3.76 | 7.49 / 7.79 / 7.85 | -5.58 / -4.08 / -2.99 | |
| cppi90-m2+dg30-t10-freeze | 1k | +0.17 / +0.27 / +0.33 | -2.32 / -2.21 / -2.15 | -4.84 / -4.70 / -4.55 | +1.97 / +2.07 / +3.10 | 5/5 |
| cppi90-m2+dg30-t10-freeze | 100k | -0.12 / -0.06 / +0.25 | -2.28 / -2.01 / -1.73 | -4.84 / -4.70 / -4.54 | +1.79 / +2.41 / +3.79 | 4/5 |
| cppi85-m2+dg30-t10-freeze | 1k | +0.03 / +0.12 / +0.24 | -1.60 / -1.47 / -1.35 | -3.16 / -3.06 / -2.78 | +1.10 / +1.47 / +2.42 | 5/5 |
| cppi85-m2+dg30-t10-freeze | 100k | -0.13 / -0.05 / +0.20 | -1.52 / -1.20 / -1.02 | -3.36 / -3.16 / -3.06 | +0.78 / +1.72 / +2.23 | 3/5 |
| st3-6-10-ema | 1k | -0.06 / +0.00 / +0.10 | -1.44 / -1.29 / -1.20 | -4.45 / -3.88 / -3.75 | -0.04 / -0.01 / +1.24 | 5/5 |
| st3-6-10-ema | 100k | -0.28 / +0.06 / +0.11 | -0.91 / -0.67 / -0.50 | -2.77 / -1.58 / -1.11 | +0.20 / +0.63 / +2.25 | 4/5 |

- The baseline's own mean return moves 0.12 pp (1k) and 0.52 pp (100k) with the start time, its worst return 1.1-2.6
  pp. The 0.10 pp return constraint is inside that noise at 100k.
- **The drawdown cuts are robust**: every variant lowers mean and worst max DD at every offset and both sizes, and
  the CPPI variants improve the worst return at every offset. The return side is not: at 100k both CPPI+guard rules
  fall below -0.10 pp at 1-2 of 5 offsets (min -0.12, -0.13), the staged rule at 1 (-0.28).
- The staged rule's worst-return gain at 1k is zero at 4 of 5 offsets; its drawdown cut is the steady part.

## Verdict

- **Depeg guard: keep `freeze`, reject `exit`.** Exit sells into the deviation and loses 2-3 pp when the peg returns
  (aug2024). Freeze at 30 bps / 10 min costs < 0.1 pp mean where nothing happens and is what makes CPPI 90 safe in a
  USDT wobble. It cannot be tuned well on this data: one TRAIN window with cbBTC reaches 56 bps.
- **CPPI 90/m2 needs the guard and, with it, is the strongest drawdown rule we have** (TRAIN 6/6, robustness TEST
  6/6, worst DD -4.5 to -6.3 pp, start offsets robust on drawdown). But its TEST pass is a re-run on spent windows,
  not an out-of-sample result. It still trades 0.6-1.7 pp of upside in calm and rally windows.
- **CPPI 85/m2**: the guard changes almost nothing; it remains the only CPPI rule with a clean TEST pass (last round).
- **Staged exits st3-6-10-ema**: a real drawdown cut at 1k (TEST worst DD -5 pp), neutral mean, but +25-40% ops and
  churn in calm months, and inert at 100k until the harvest/usage-limit issue is fixed. Not ready.
- Next: fix the 100k harvest starvation (its own ticket), then new held-out windows (a second stable-stress week,
  a V-shaped crash) before any of these goes near a live policy. Nothing here changes `conservador-live-v2`.

## Limits

- No oracle: the guard reads the pool against 1.0 and cannot tell a USDC depeg from a USDT one (spec 004 needs both).
- aug2024 is a young, thin pool and runs on a two-bucket policy.
- Staged exits park the sold thirds in the stables bucket (the USDC/USDT range), not in bare USDC; under a tripped
  guard they wait as USDC.
- Same simulator limits as spec 004: 5-10 min samples, single-range swap impact, no MEV.
