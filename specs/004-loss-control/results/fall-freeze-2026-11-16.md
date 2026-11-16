# 004 Lab: freeze new entries into a falling bucket, 16 Nov 2026

Ticket otto/mamoru#101 (protocol posted there before TRAIN ran). Question from the owners (Captains #devcon-8, 15-16 Nov,
with ETH and MON falling): while a volatile token falls, is it better to keep the USDC waiting than to keep putting it
into that bucket's pool? Lab only: `decide`, the policies and the operator are unchanged.

Simulator `backtest-1`, production `decide` at `4d7f8338`, policy `conservador-live-v2` (50/40/10 on USDC/USDT 0.01%,
USDC/cbBTC 0.05%, WETH/USDC 0.3%), review every sample, session limits enforced, deposits 1,000 and 100,000. TRAIN: the
7 windows with cbBTC; TEST: 5 windows, each candidate run **once**. v7's Morpho vault and the Monad sleeve are not in the
simulator; the two volatile buckets here (cbBTC 40 %, WETH 10 %) stand in for Balance and Growth.

Datasets: rebuilt in the cell from public Base archive RPCs (`cli/windows.ts backfill`, every gap refetched until 0
failed blocks). Check: baseline on `oct2025` at 1,000 = -3.33 %, as in the 16 Oct note.

## Rule and variants

The existing `fallFreeze` (`decide/src/guard`, `DECIDE_ENTRY_PAUSED_FALL`): while the 24 h TWAP fall **and** the 24 h
realized vol of a bucket's pool are at or over its thresholds, the bucket gets no entry or top-up; re-ranges and
harvests run as before; the money waits as USDC. Off in production.

| Variant | cbBTC bucket | WETH bucket |
|---|---|---|
| `ff-default` | fall 7 %, vol 80 % | fall 9 %, vol 100 % |
| `ff-trend` | fall 7 %, no vol condition | fall 9 %, no vol condition |
| `ff-trend5` | fall 5 % | fall 5 % |
| `ff-trend3` | fall 3 % | fall 3 % |
| `cppi85-m2` | volatile buckets <= 2 x (value - 85 % of peak) (round 3 TEST pass) | same |
| `cppi85-m2+ff-trend5` | both | both |

Scoring: round-3 `score.ts` unchanged. Constraint: mean return no worse than baseline by more than 0.10 pp at both
deposits. Primary (6): mean max DD, worst max DD and worst-window return, at both deposits. Per-window deltas under
0.5 pp are start-time noise.

## TRAIN (`train-score.md`)

| Variant | Pass | Primary /6 | dep | mean Δ | mean DD Δ | worst DD Δ | worst ret Δ | ops (base) |
|---|---|---|---|---|---|---|---|---|
| cppi85-m2 | yes | 6 | 1,000 | +0.14 | -1.47 | -3.09 | +1.42 | 492 (646) |
| | | | 100,000 | +0.45 | -1.74 | -2.76 | +3.61 | 8,630 (10,915) |
| cppi85-m2+ff-trend5 | yes | 6 | 1,000 | +0.15 | -1.37 | -2.79 | +1.02 | 465 (646) |
| | | | 100,000 | +0.47 | -1.64 | -2.75 | +3.61 | 8,457 (10,915) |
| ff-trend | yes | 3 | 1,000 | +0.19 | +0.00 | +0.00 | +0.05 | 600 (646) |
| | | | 100,000 | +0.33 | -0.16 | +0.00 | +1.88 | 10,850 (10,915) |
| ff-default | yes | 3 | 1,000 | +0.08 | +0.00 | +0.00 | +0.04 | 605 (646) |
| | | | 100,000 | +0.32 | -0.16 | +0.00 | +1.88 | 10,855 (10,915) |
| ff-trend3 | yes | 3 | 1,000 | +0.12 | +0.07 | -0.06 | -0.34 | 548 (646) |
| | | | 100,000 | +0.11 | -0.01 | +0.23 | +1.86 | 10,525 (10,915) |
| ff-trend5 | yes | 2 | 1,000 | +0.11 | +0.09 | +0.00 | -0.14 | 576 (646) |
| | | | 100,000 | +0.36 | -0.06 | +0.21 | +1.88 | 10,725 (10,915) |

- The freeze never fires in a calm or rally window: same return, same ops (LC-L1 holds: 0 % of reviews frozen).
- In the crashes it saves ops and gas and adds a little: `ff-trend` +0.17 / +1.16 / 0.00 pp at 1,000 (Oct, Feb, Mar
  2025); at 100,000 the +1.88 pp of the worst return is one window (Mar 2025). Drawdown does not move: the freeze only
  stops new money, and an account that is already placed has little new money in a fall.

TEST candidates (at most 2): `ff-trend`, the best freeze-only arm, and `cppi85-m2+ff-trend5`. `cppi85-m2` was already
judged on TEST in round 3; it is re-run beside them on the rebuilt data as a reference, not as a candidate.

## TEST, run once (`test-score.md`)

| Variant | Pass | Primary /6 | dep | mean Δ | mean DD Δ | worst DD Δ | worst ret Δ | ops (base) |
|---|---|---|---|---|---|---|---|---|
| ff-trend | yes | 0 | 1,000 | +0.05 | +0.12 | +0.34 | -0.16 | 656 (730) |
| | | | 100,000 | +0.08 | +0.29 | +1.44 | +0.00 | 8,415 (8,431) |
| cppi85-m2+ff-trend5 | **no** | 4 | 1,000 | +0.06 | -1.31 | -2.10 | +0.40 | 481 (730) |
| | | | 100,000 | -0.48 | -0.88 | +0.73 | -2.02 | 7,256 (8,431) |
| cppi85-m2 (reference) | yes | 6 | 1,000 | +0.32 | -1.77 | -3.85 | +1.29 | 549 (730) |
| | | | 100,000 | +0.54 | -1.73 | -3.10 | +1.71 | 7,442 (8,431) |

`ff-trend` per window: every delta is under 0.5 pp (apr2025 -0.16, feb2026 +0.39 at 1,000); the worst drawdown is
slightly **worse** (+0.34 / +1.44 pp, feb2026).

## Verdict

1. **Freezing new entries in a fall is not a protection lever.** It passes the return constraint and costs nothing in
   calm markets, but on TEST it wins none of the six drawdown and worst-case criteria; its gains are inside the noise.
   Reason: it only holds back money that is not yet in the pool. What a fall costs is the money already in the pool.
2. **Adding it to CPPI makes CPPI worse** (fails the constraint on TEST at 100,000). Do not combine them.
3. **What does cut losses in a fall is holding less volatile exposure: CPPI 85 % / x2**, again on rebuilt data: mean
   drawdown -1.5 to -1.8 pp, worst drawdown -2.8 to -3.9 pp, worst window +1.3 to +3.6 pp, mean return +0.1 to +0.5 pp.
   Its price: it gives up about 0.4 to 1.1 pp in calm and rally windows (sep2026 -1.10, calm-2026-04 -1.14, may2025
   -1.00 at 1,000), because it holds less volatile exposure from day one. It is a product decision (less upside for
   less drawdown), not a free fix.
4. As in October: stopping re-ranges in a fall is worse (16 Oct note), and so is a 24 h trend exit (a coin flip).

## Limits

- Base windows only. Monad's WMON (15 % Growth in v7) is not in the datasets; #415 measures its fast-fall case on a fork.
- v7's Stable bucket is a Morpho vault; here it is the USDC/USDT pool. Neither has price exposure, so the
  volatile-bucket results carry over; absolute returns do not.
- An account that deposits at the start of a fall would get more from the freeze than these windows show (they place
  the deposit at the first sample). Not measured.

## Reproduce

```
export MAMORU_LAB_DATASETS=<dir> BACKFILL_RPC_URL=<archive endpoints, comma separated>
bun packages/backtest/cli/windows.ts backfill oct2025 feb2025 mar2025 dec2024 calm-2025-09 calm-2026-04 sep2026 apr2025 may2025 jun2025 calm-2026-05 feb2026
R=specs/004-loss-control/results/fall-freeze-2026-11-16
bun packages/backtest/cli/sweep.ts --variants $R/variants-train.json --windows sep2026,oct2025,feb2025,mar2025,dec2024,calm-2025-09,calm-2026-04 --deposits 1000,100000 --out $R/train
bun packages/backtest/cli/sweep.ts --variants $R/variants-test.json --split test --deposits 1000,100000 --out $R/test
bun specs/004-loss-control/results/round3-2026-10-16/score.ts $R/train/sweep.json --windows
```
