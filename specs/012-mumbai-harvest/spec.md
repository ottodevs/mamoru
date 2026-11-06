# 012: Full harvest: collect, sell to USDC, reinvest, and count vault yield as earned

Ticket: otto/mamoru#107 (context: #140, the collect-only harvest). Event: ETHGlobal Mumbai 2026 (Continuity), priority 2 of 3.
PRD: [`docs/ethglobal-mumbai/prd.md`](../../docs/ethglobal-mumbai/prd.md) (summary) §2 decisions 2 and 4, §5.2, §9, annex B.
Status: draft r1. Plan: `plan.md`. Tasks: `tasks.md`. Scenarios: `scenarios.md`. Threats: `threats.md`.

## Problem

Mamoru earns in two places and shows only one.

1. **Uniswap pools.** Fees accrue apart from the position and must be collected. The engine collects them (`harvestOf`,
   `packages/decide/src/harvest/index.ts:28`) with `convert: null` since #140: a sale in the same batch swapped an
   amount fixed before inclusion, which could be principal. The volatile fees then sit in the Safe until a later
   review sells them (`idleConvertOf`, `rerange/index.ts:365`) or an entry mints them, under rules nobody has checked
   end to end for harvested fees. Collected USDC joins free savings and is placed only when a bucket's gap passes the
   3 % fill band (`allocate/index.ts:220`).
2. **The gtUSDCp vault (Morpho, Base).** Yield raises the share price (`convertToAssets`); nothing is collected.
   The snapshot values the shares (`apps/mamoru-operator/src/snapshot.ts:262`), but "Earned so far" counts only LP
   fees (`apps/mamoru-app/src/api/accounts/yield.ts:103`). Most of the Stable bucket's yield is invisible.

Accounts with fees accrued since launch have never had a full cycle. When this ships several will harvest in the same
hour; that is the demo, and it stays on chain.

## Scope

In: Base and Monad, V3 (v6/v7) and V4 (T8) accounts that are live. Out: incentives (Merkl, Morpho rewards; none
active, PRD annex B.3), contract changes, a new swap venue, any change to the 3x cost threshold or to the 5-point
drain band (`DRIFT_BPS = 500`, PRD annex B.2).

## Requirements

- **HRV-R1. Sell what was collected, in its own op.** After a harvest is confirmed, the volatile fees it collected are
  sold to USDC by a later op that sizes on the Safe's balance at that review, never on an amount fixed before the
  harvest landed (#140). Slippage and the price guard are the policy's (`execution.slippageBps`, the TWAP gate). Where
  the allocation is about to mint that volatile into its own bucket (`pendingMint`), the mint counts as the
  reinvestment and no sale happens. Below the op cost times the harvest factor it waits, `DECIDE_HARVEST_BELOW_COST`.
- **HRV-R2. Reinvest USDC with the usual rules, past the fill band.** Free USDC a review leaves unplaced, at or above
  `vaultMinDeposit` (40 USDC, `policies-v7.ts:30`), goes to the Stable bucket's vault on Base even when that bucket's
  gap is inside the 3 % fill band, up to the bucket's drain ceiling (target + 5 points of total), so the next review
  never redeems what this one deposited.
- **HRV-R3. USDC on another chain goes where it earns.** A remote sleeve above its target by more than the band, by at
  least an entry's minimum, is brought home over CCTP (standard transfer, fee 0), as #278 already does for V4
  accounts. Harvested USDC on Monad feeds the same rule; there is no veto between chains (PRD decision 4). Bridge caps
  of V3 accounts (20 % of C per call, 50 % per approval, `policies-v6.ts:27`) apply as spec 011 states.
- **HRV-R4. Vault yield is earned.** Per account and vault: `vault yield = value of the shares now − net deposited`,
  where net deposited is the sum of the USDC the account's own ERC-4626 `Deposit` events put in minus the USDC its
  `Withdraw` events took out (owner = the Safe), read from the receipts of the engine's vault ops. It adds to "Earned
  so far" and to `/stats` (spec 013). No collect op is invented.
- **HRV-R5. Partial vault redeems.** Already allowed without the owner's signature and already used to rebalance
  (PRD annex B.2). No change.
- **HRV-R6. Keep positions before reinvesting.** On V4 accounts, a reinvestment op (the sale of R1, the vault deposit
  of R2) goes only if V4's room after it (`budgetLeft`: account bucket, sub-bucket, 30 days, 24 h) still covers the
  re-mint of the account's largest managed position on that chain. Otherwise it waits with `DECIDE_WAIT_BUDGET`. A vault
  already at its ceiling (`ratioBps x C`, I5) is not deposited into; the USDC stays free with the same code.
- **HRV-R7. Threshold unchanged.** Harvest fires when fees > 3 x op cost (`costFactorBps: 30000`).
- **HRV-R8. Every income has a label.** The ledger records income per account, chain and UTC day under exactly one of
  `harvest` (fees collected by a harvest op), `re-range` (fees collected by an op that removed liquidity: re-range,
  reduce, exit) and `vault-yield` (R4). The app and `/stats` read these labels, never infer them.
- **HRV-R9. Every live account, or named.** R1–R8 hold on the live V3 (v6, v7) and V4 accounts on Base and Monad. An
  account a requirement cannot serve is named in the ticket with its reason (example: a V3 account has no return home,
  `askReturn` runs on V4 only, `operator.ts:6371`).

## Edge cases

- Fees collected but the pool is exit-only on V4: its volatile is sold through an eligible pool or waits (existing
  rule, `rerange/index.ts:376`).
- A harvest and a re-range of the same position in one UTC day: two labels, two rows (R8 keys on the label).
- The vault holds shares the engine did not deposit (sent by hand, a migration): net deposited cannot be known from
  the account's ops; its vault yield is "not counted", never 0 and never the whole value (constitution XVI).
- Share price below the cost basis (bad debt): vault yield is shown negative, as read.
- `budgetLeft` unreadable: no reinvestment op this review (`DECIDE_WAIT_BUDGET`); positions are still maintained.
- V3 accounts: V3 has no `budgetLeft`; the per-pool totals are enforced on chain. A revert is recorded with its decoded
  error and the op is not retried in a loop (existing backoff).

## Acceptance

- **A1.** Given a Base account with a managed position whose fees are > 3x cost, when the engine reviews, then a
  harvest op collects them; and when a later review sees the volatile in the Safe, then a separate op sells exactly that
  balance to USDC; and when USDC is free ≥ 40, then a vault deposit follows (HRV-R1, R2, R7). Scenario HRV-S01.
- **A2.** Given V4 room below the largest position's re-mint, when the review would sell or deposit, then it waits with
  `DECIDE_WAIT_BUDGET` and a re-range of an out-of-range position still goes (HRV-R6). HRV-S03, S04.
- **A3.** Given a vault at `ratioBps x C`, when USDC is free, then no deposit and `DECIDE_WAIT_BUDGET` (HRV-R6). HRV-S05.
- **A4.** Given a V4 Monad sleeve above target by more than the band, when Base reviews, then a return home is asked
  for the excess (HRV-R3). HRV-S06.
- **A5.** Given an account with engine vault deposits and a higher share price, when the app answers `/yield`, then
  `vaultYieldUsd` = value − net deposited and "Earned so far" includes it; with an unexplained share balance it is null
  (HRV-R4). HRV-S07, S08.
- **A6.** Given a harvest and a re-range in one day, when the ledger is written, then two income rows with their labels
  (HRV-R8). HRV-S09.
- **A7.** In production after release, accounts with accrued fees harvest on their own and leave tx hashes in the op
  history; no scenario is forced on mainnet (PRD §5.2 acceptance).
