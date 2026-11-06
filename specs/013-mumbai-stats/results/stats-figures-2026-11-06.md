# Stats figures, read from the chain (6 Nov 2026)

Script: `apps/mamoru-operator/scripts/stats-figures.ts` (read-only). Read at 2026-11-06T19:02:24.000Z, Base block 54006844, Monad block 119972354. Accounts: D1 `accounts`, env prod + beta, not test. Every amount is read from the chain with the operator's snapshot reader; tokens valued in USD at the read's Uniswap pool price (USDC = 1). Only aggregates.

## Snapshots

| Id | Figure | Value |
|---|---|---|
| S1 | Total deposits | $4,363.34 |
| S2 | Money working (LP + vaults) | $2,894.27 |
| S3 | Idle capital | $1,468.36 |
| — | Uncollected fees (in S1) | $0.71 |
| S4 | Earned in the last 24h | $0.98 |
| S5 | Total earned | $3.20 |
| S6 | Average APR, 7 days (capital-weighted) | 27.6 % |
| S7 | Total accounts (prod + beta) | 65 (prod only 61) |
| — | Accounts with > $1 | 15 |
| S8 | Average account (funded) | $290.89 |
| S9 | Largest account | $1,728.27 |
| S10 | In USD stablecoins | 79.1 % |

S4 parts by chain: {"Base": {"fees": -0.2636, "collected": 0.5082, "vaultYield": 0.2326}, "Monad": {"fees": 0.1012, "collected": 0.3984, "vaultYield": 0}}. S5 parts: collected $2.22 (D1 receipts, every day since launch), uncollected $0.71 (now), vault yield since 18 Oct $0.27.

## Distributions (k ≥ 3 accounts per slice; smaller slices merged)

**D1 by token:** USDC $3,452.97 (79.1 %); WETH $740.20 (17.0 %); Other $170.17 (3.9 %) — merged: cbBTC, USDT, WMON

**D2 by chain:** Base $3,972.86 (91.1 %); Monad $390.48 (8.9 %)

**D3 by place:** Stable vaults $1,626.16 (37.3 %); Idle $1,468.36 (33.7 %); Other $1,268.82 (29.1 %) — merged: Stable pairs, Volatile pairs

## Daily (UTC day close; last row is today up to the read)

| Day | Deposits | Earned | of which collected | APR | APR 7d | Base 7d | Monad 7d |
|---|---|---|---|---|---|---|---|
| 2026-10-18 | $70.50 | $0.02 | $0.00 | 9.5 % | — | — | — |
| 2026-10-19 | $70.51 | $0.02 | $0.00 | 10.3 % | 10.3 % | 10.3 % | — |
| 2026-10-20 | $70.81 | $0.03 | $0.00 | 14.7 % | 12.5 % | 12.5 % | — |
| 2026-10-21 | $71.05 | $0.03 | $0.00 | 13.5 % | 12.8 % | 12.8 % | — |
| 2026-10-22 | $70.41 | $0.02 | $0.00 | 9.9 % | 12.1 % | 12.1 % | — |
| 2026-10-23 | $70.37 | $0.02 | $0.00 | 10.8 % | 11.8 % | 11.8 % | — |
| 2026-10-24 | $70.36 | $0.11 | $0.00 | 55.4 % | 19.1 % | 19.1 % | — |
| 2026-10-25 | $70.13 | $0.01 | $0.09 | 7.3 % | 17.4 % | 17.4 % | — |
| 2026-10-26 | $70.13 | $0.04 | $0.06 | 19.5 % | 18.7 % | 18.7 % | — |
| 2026-10-27 | $70.39 | $0.02 | $0.00 | 10.1 % | 18.1 % | 18.1 % | — |
| 2026-10-28 | $70.51 | $0.02 | $0.00 | 11.6 % | 17.8 % | 17.8 % | — |
| 2026-10-29 | $69.55 | $0.06 | $0.00 | 31.5 % | 20.9 % | 20.9 % | — |
| 2026-10-30 | $69.53 | $0.15 | $0.00 | 80.8 % | 30.8 % | 30.8 % | — |
| 2026-10-31 | $69.65 | $0.01 | $0.00 | 4.0 % | 23.5 % | 23.5 % | — |
| 2026-11-01 | $69.86 | $0.01 | $0.05 | 6.3 % | 23.3 % | 23.3 % | 61.1 % |
| 2026-11-02 | $233.86 | $0.04 | $0.41 | 10.3 % | 20.5 % | 20.1 % | 92.9 % |
| 2026-11-03 | $234.61 | $0.23 | $0.04 | 38.9 % | 27.4 % | 19.2 % | 292.5 % |
| 2026-11-04 | $419.35 | $0.45 | $0.40 | 51.2 % | 36.5 % | 22.8 % | 213.8 % |
| 2026-11-05 | $411.64 | $0.70 | $0.32 | 62.4 % | 45.0 % | 25.6 % | 219.6 % |
| 2026-11-06 | $4,363.34 | $0.73 | $0.84 | 16.2 % | 27.6 % | 14.2 % | 139.5 % |

## Method

- **Deposits (S1, T3):** idle tokens + LP principal + uncollected fees + owed + vault shares at their share price, per Safe, Base and Monad summed per account.
- **Earned per day:** per position, accrued fees at the day's close minus at its open (positions opened or closed in the day count from or to zero), plus fees collected that day (D1 `yield_ledger_account_receipts`), plus vault yield = shares held at close × share-price change over the day.
- **Earned 24h (S4):** the same between a read 24 h ago and now; collected fees: today's in full and yesterday's prorated by the hours of yesterday inside the window (receipts are per UTC day).
- **APR:** Σ earned / Σ working capital × 365, working capital = average of open and close LP + vault value. Capital-weighted, idle excluded, no compounding. 7-day figure = 7-day sums, not an average of daily rates. A day with a large late deposit has a low rate because the average of open and close overstates its capital; a time-weighted average from 10-minute samples is the follow-up.
- **Check against D1:** `account_snapshot_latest` holds Base only ($3,972.54); the chain gives Base $3,972.86 and Monad $390.48. Base matches within $0.40; Monad is missing from D1 (task A1-D1).
