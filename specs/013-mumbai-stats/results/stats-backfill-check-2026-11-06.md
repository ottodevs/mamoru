# Stats v2 on a D1 copy after the backfill, against the chain script (6 Nov 2026)

What was run (read-only on prod): prod D1 exported to a local SQLite copy; the A1 migrations applied
(`XXXX_income_events`, `XXXX_snapshot_tokens`, `XXXX_stats_facts`, `XXXX_stats_vault_daily`); the output of
`apps/mamoru-operator/scripts/stats-backfill.ts` applied (45 Monad `account_daily` rows from 1 Nov, 8 `stats_vault_daily`
rows); one live cron pull simulated on both chains with the A1-D2 operator reader (Base block 54019999, Monad block
119981042); then `statsInput` + `guardStats` of `GET /api/stats` v2. Reference: `scripts/stats-figures.ts` (PR #326),
`results/stats-figures-2026-11-06.md` (read 19:02Z). Aggregates only.

## Snapshots

| Id | API v2 on the copy | Chain script | Within tolerance |
|---|---|---|---|
| S1 Total deposits | $4,363 | $4,363.34 | yes |
| S2 Money working | $2,894 | $2,894.27 | yes |
| S3 Idle | $1,468 | $1,468.36 | yes |
| S9 Largest account | $1,728 | $1,728.27 | yes |
| S10 In stablecoins | 79.1 % | 79.1 % | yes |
| S6 APR 7 days | 45.0 % (last closed day, 5 Nov) | 45.0 % on 5 Nov (27.6 % with today's partial day) | yes, same day |
| S7 Total accounts | 57 | 65 | definition: see below |
| S8 Average account | $485 (9 owners > $1) | $290.89 (15 Safes > $1) | definition: see below |
| S4, S5 Earned | withheld (incomplete) | $0.98, $3.20 | needs 012 operator events, see below |

## Distributions

| | API v2 | Chain script |
|---|---|---|
| D1 by token | USDC $3,453 (79.1 %) · WETH $739 (16.9 %) · Other $171 (3.9 %) | USDC $3,452.97 · WETH $740.20 · Other $170.17 |
| D2 by chain | Base $3,973 (91.1 %) · Monad $390 (8.9 %) | Base $3,972.86 · Monad $390.48 |
| D3 by place | Stable vaults $1,626 · Idle $1,468 · Other $1,269 | Stable vaults $1,626.16 · Idle $1,468.36 · Other $1,268.82 |

## Daily (closed days)

| Day | APR API | APR script | 7 d API | 7 d script | Earned API | Earned script | Deposits API | Deposits script |
|---|---|---|---|---|---|---|---|---|
| 29 Oct | 31.5 % | 31.5 % | — | 20.9 % | | | | |
| 30 Oct | 80.8 % | 80.8 % | — | 30.8 % | | | | |
| 31 Oct | 4.0 % | 4.0 % | — | 23.5 % | | | | |
| 1 Nov | 6.3 % | 6.3 % | 22.2 % | 23.3 % | | | $70 | $69.86 |
| 2 Nov | 10.1 % | 10.3 % | 20.5 % | 20.5 % | | | $234 | $233.86 |
| 3 Nov | 38.9 % | 38.9 % | 27.3 % | 27.4 % | $0.23 | $0.23 | $234 | $234.61 |
| 4 Nov | 51.2 % | 51.2 % | 36.5 % | 36.5 % | $0.45 | $0.45 | $419 | $419.35 |
| 5 Nov | 62.4 % | 62.4 % | 45.0 % | 45.0 % | $0.70 | $0.70 | $411 | $411.64 |

The API series starts on 26 Oct (earlier days are backed by fewer than 3 owners and are withheld). Within 0.5 pp
everywhere except 26 Oct (API 11.7 %, script 19.5 %) and the 7-day figure of 1 Nov that includes it (22.2 % vs 23.3 %):
on that day D1's `fees_open` (first read of the day) and the script's previous-close accrued fees differ around a
collect. From 2 Nov on, every day and every 7-day figure is within 0.2 pp.

## Differences to decide

- **S7 and S8 count different things.** The script counts Safes (a Base account and its Monad sleeve are two); the API
  counts owners (one), as spec 013 does for k ≥ 3. D1 has 57 owners with 57 Base accounts and 9 Monad sleeves; the
  script's 65 is the Safes of those 66 that have an address. S8 is S1 / owners holding > $1 (9) in the API, S1 / Safes > $1 (15) in the script.
- **S4 and S5** come from spec 012's `earned.ts`, which marks them incomplete until the operator sends the HT6 income
  events and vault flows (a pull from today's operator has neither), so they are withheld on the copy. After the 012
  operator and Worker are live they publish; the reconcile against the script is then repeated.
