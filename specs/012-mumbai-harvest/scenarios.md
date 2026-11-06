# 012 scenarios: full harvest

Unit = decide-pure test (`packages/decide/src/*.test.ts`), op = operator test, fork = Base fork e2e
(`apps/mamoru-operator/test/`), d1 = app test against local D1. Evidence: `specs/012-mumbai-harvest/results/`.

| Id | Reqs | Kind | Given | When | Then (reason code / effect) |
|---|---|---|---|---|---|
| HRV-S01 | R1 R2 R7 | fork | V4 Base account, managed USDC/cbBTC position, fees > 3x cost | 3 reviews | `harvest` collect; then `convert` with `amountIn` = cbBTC held after collect; then entry or `vault_deposit`. 3 tx hashes |
| HRV-S02 | R1 | unit | volatile held, its bucket under-weight > 5 pts, allocation mints it | review | no sale; `enter_mint`/`increase_liquidity` uses it (`pendingMint`) |
| HRV-S03 | R6 | unit | V4 `budget.room` < largest position re-mint + sale value | review with idle volatile | no sale; `DECIDE_WAIT_BUDGET` |
| HRV-S04 | R6 | unit | same room, a position out of range | review | `rerange` proposed (not gated) |
| HRV-S05 | R6 | unit | vault at `ratioBps x C`, free USDC 100 | review | no `vault_deposit`; `DECIDE_WAIT_BUDGET` |
| HRV-S06 | R3 | unit | V4, remote value above target by > band and ≥ entry min | review | `returnDue.amount` = excess |
| HRV-S07 | R4 | op | engine deposit 500 USDC, redeem 100 USDC, shares now worth 410 | snapshot | `netDepositedUsdc` 400, vault yield 10 |
| HRV-S08 | R4 | op | Safe holds vault shares no engine op explains | snapshot | vault yield `null` |
| HRV-S09 | R8 | d1 | one day: harvest collected 3 USD, rerange collected 2 USD on the same token | cron write | two `yield_ledger_income` rows, `harvest` 3, `re-range` 2 |
| HRV-S10 | R2 | unit | free 60 USDC, all gaps inside the 3 % band, vault bucket 2 pts above target | review | `vault_deposit` ≤ ceiling − value (never over target + 5 pts) |
| HRV-S11 | R2 | unit | free 60 USDC of which 50 waiting for depth (`DECIDE_WAIT_DEPTH`) | review | no sweep (10 < 40) |
| HRV-S12 | R2 R5 | unit | sweep deposited to the ceiling | next review | `reduceOf` proposes no redeem (no churn) |
| HRV-S13 | R9 | unit | each live policy (v6, v7, monad, one-auth-v4) with a harvested volatile balance | review | sale proposed (`hasManageAny` true) or the policy is named in the result |
| HRV-S14 | R9 R3 | unit | V3 account with a Monad sleeve above target | review | no return asked; recorded as out (askReturn V4 only) |
| HRV-S15 | R4 | d1 | `/api/accounts/:k/yield` with vault yield 10 and LP earned 5 | GET | `earnedSoFarUsd` 15, `vaultYieldUsd` 10; with null vault yield: 5 and `null` |
| HRV-S16 | R6 | op | V4 `budgetLeft` read throws | review | `budget.room = 0n`, no reinvestment, re-range still allowed |
| HRV-S17 | — | op | V4 op reverts `Cap24hExceeded(s, v)` | op log | error name and values in the log line and op record |

Production acceptance (A7): after release, list the ops of kind `harvest` and `convert` with tx hashes from the op
history; not a scenario, a recorded observation in `results/`.
