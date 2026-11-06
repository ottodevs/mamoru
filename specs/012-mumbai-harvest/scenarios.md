# 012 scenarios: full harvest (r2)

unit = decide-pure test, op = operator test, d1 = app test on local D1, fork = Base/Monad fork e2e with the **live**
policy and account shape, live = read-only on prod data. Evidence in `specs/012-mumbai-harvest/results/`.

| Id | Reqs | Kind | Given | When | Then |
|---|---|---|---|---|---|
| HRV-S01 | R1 R3 R8 | fork | v7 Base account (live policy), managed USDC/cbBTC position with fees > 3x cost, plus 0.001 cbBTC principal idle | reviews until settled | same account: `harvest` (collect X cbBTC) → `enter_swap harvestSale` amountIn = X exactly (principal untouched) → `vault_deposit` or entry of the USDC; receipts reconcile (collected = sold; USDC out of sale = USDC placed ± dust) |
| HRV-S02 | R2 | unit | harvested-unsold worth 0.5x sale cost | 3 reviews with 2 more harvests | waits `DECIDE_WAIT_HARVEST_SALE` until > cost, then one sale of the sum |
| HRV-S03 | R7 | unit | V4, `room` < 1.5 x LP value + sale value | review | no sale/sweep, `DECIDE_WAIT_BUDGET` |
| HRV-S04 | R7 | unit | same room, a position out of range | review | `rerange` proposed |
| HRV-S05 | R7 | unit | vault at `ratioBps x C`, free 100 | review | no deposit, `DECIDE_WAIT_BUDGET` |
| HRV-S06 | R4 | unit | V4, remote idle 30 USDC ≥ entryMin for 6 h, sleeve below target | review | `returnDue` 30 |
| HRV-S07 | R5 | op | samples t1 value 500, deposit 100 at t1.5, t2 value 603 | snapshot | event `vault-yield` usd 3 at t2 |
| HRV-S08 | R5 R10 | op | shares not explained by engine ops | first sample | `backfill` usd null, `explained = 0` |
| HRV-S09 | R9 | d1 | two harvests same account same day + one rerange | cron writes twice (replay) | three events, keys unique, replay inserts nothing |
| HRV-S10 | R3 | unit | free 60, gaps inside band, vault 2 pts above target | review | `vault_deposit` ≤ ceiling − value |
| HRV-S11 | R3 | unit | free 60 of which 50 in `waiting` | review | no sweep |
| HRV-S12 | R3 R6 | unit | after sweep to ceiling | next review | no redeem |
| HRV-S13 | R11 | fork | each live policy (v6, v7, live-wmon-usdc-monad-v6, one-auth-v4) with harvested volatile | review + execute on fork | sale executes on chain, or the policy is named in #107 with the revert |
| HRV-S14 | R4 R11 | fork | live V3 Monad account state | HT9 session read | either bridge-out session found → `bridge_out` home within `bridgeLimit` executes on fork, or no session → `DECIDE_WAIT_RENEWAL` and the account in #107 as "needs a renewal" with the read |
| HRV-S15 | R10 | d1 | vault yield not counted for the account | GET `/yield` + Portfolio render | `earnedStatus: 'partial'`, marker visible at 1280 and 390 |
| HRV-S16 | R7 | op | V4 `budgetLeft` throws | review | `room = 0n`, no reinvestment, re-range allowed |
| HRV-S17 | — | op | V4 op reverts `Cap24hExceeded(s, v)` | op record | decoded name and values recorded |
| HRV-S18 | R4 | unit | return done at t0; sleeve still idle-short at t0 + 2 h | review on Base | no `bridge_out` to that chain until t0 + 24 h, `DECIDE_WAIT_BRIDGE` |
| HRV-S19 | — (one definition) | d1 | fixture of 5 accounts, Base + Monad, all sources | same read time | Σ Portfolio earned == `/stats` total earned; same for 24 h |
| HRV-S20 | R5 | live | prod D1 + chain, read-only | run reconciliation script | count of vault holdings with cost basis vs not counted, written to `results/vault-basis-<date>.md`. **Release gate:** every holding whose shares all came from engine ops has a basis (0 unexplained among them); any other unexplained holding is listed with its reason and shows the "not counted" marker in Portfolio |
| HRV-S21 | R1 | unit (operator) | harvested counter 10, balance 100; a re-range mint spends 10 of that token | next observation | counter 0; no harvest sale proposed; principal untouched |
| HRV-S22 | R5 R9 | D1 fixture (copy of prod receipts) | accounts with collected fees before the switch | HT7 migration + replay | per account, total earned after ≥ earned-so-far before; no fee row lost or doubled on replay |
| HRV-S23 | R2 | unit (decide) | harvested volatile worth 2 × op cost, `harvestedSince` 8 days ago | review | sale proposed (age bar 1×) |
| HRV-S24 | R5 | unit (app) | vault interval 48 h with 4 USDC yield, window covers its last 24 h | earned 24h | counts 2 USDC (prorated), not 4 |
| HRV-S21 | R1 R3 R9 | live | prod after release | pick one account that harvested | collect, sale and reinvest tx hashes; matching `yield_ledger_income` events; `/yield` figure includes them; recorded in `results/` |
