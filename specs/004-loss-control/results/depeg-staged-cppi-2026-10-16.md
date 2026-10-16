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

Results follow below this line once run.
