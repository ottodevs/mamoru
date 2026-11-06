# 012 plan: full harvest

Spec: `spec.md`. Tasks: `tasks.md`. Scenarios: `scenarios.md`.

## What exists and is reused

| Piece | Where | Used for |
|---|---|---|
| Collect-only harvest | `packages/decide/src/harvest/index.ts:28` | R7 unchanged; R1 starts after it |
| Idle volatile sale, sized on the held balance | `packages/decide/src/rerange/index.ts:365` (`amountIn: held`) | R1 |
| One op per review, precedence `exit > rerange > harvest > reduce > idle > entry` | `packages/decide/src/index.ts:259` | R1 is a later review by construction (`idle` is null when `harvests.length`, `:250`) |
| Vault deposit / redeem, drain band 5 points | `allocate/index.ts`, `rerange/index.ts:247-334`, `DRIFT_BPS` `:55` | R2 ceiling, R5 |
| Return home of a remote excess (#278) | `allocate/index.ts:407-418`, `operator.ts:6368` (V4 only) | R3 |
| V4 room read | `budgetLeft(account, key, ratioBps)` `MamoruActionPolicyV4.sol:1500`; precedent `bridge-out.ts:1969` with margin | R6 |
| Receipt facts per op, read once, kept on the stored op | `apps/mamoru-operator/src/yield-receipts.ts`, `state.ts` `StoredOp.facts`, `rerange?: true` | R4, R8 |
| Vault valuation at share price | `snapshot.ts:261-263` | R4 value side |
| Yield ledger D1 tables | `migrations/d1/0010`, `0015` | R8 home |
| Earned so far | `apps/mamoru-app/src/api/accounts/yield.ts:103` | R4 display |

Rule from constitution XX: nothing new where an existing rule covers it. R1, R3 and R5 are mostly verification of
existing paths plus tests; the new code is R2 (sweep), R4 (vault cost basis), R6 (room check) and R8 (labels).

## Design

### R1 sale

No new proposal kind. `idleConvertOf` already sells `held` (the balance at review time) of a bucket that is not
under-weight. Two checks are added as tests, not code, unless they fail:
- a bucket under-weight by more than 5 points keeps its volatile for the mint the allocation proposes (`keep`), which
  is the reinvestment;
- every live policy has `manage-any` (v4, v6, v7, monad, one-auth-v4: confirmed by grep), so `hasManageAny` never
  blocks the sale on a live account.
The op history shows the sale as `convert` (`opIntentView`, `operator.ts:869`). No label needed on the sale: income is
labelled where it is collected (R8).

### R2 sweep

In `allocate()`, after the normal choice, when no proposal was picked and free savings ≥ `vaultMin`:
`amount = min(free, ceiling − vaultBucketValue)`, `ceiling = target + total × DRIFT_BPS / 10_000 − 1 unit`. If
`amount ≥ vaultMin`, propose `vault_deposit` to the bucket's first vault with room (existing `vault_deposit` builder),
reason `STRATEGY_PREFERENCE_DEVIATION`. Free USDC listed in `waiting` for another bucket (depth, bridge, gas) is
subtracted first: the sweep never takes money another bucket is waiting for. Chains without a vault bucket (Monad)
skip it.

### R6 room

`Observation` gains `budget?: { room: bigint }` (USD units, V4's own valuation, min of the four values `budgetLeft`
returns, less `SIBLING_ROOM_MARGIN_BPS`-style margin). The operator fills it once per review for V4 accounts (account
bucket key `address(0)`, ratio 10_000). Decide: `reserve = value of the largest managed position on this chain`
(`positionValue`). A sale (R1) or sweep (R2) whose value > `room − reserve` is not proposed; the bucket row says
`DECIDE_WAIT_BUDGET`. Exits, re-ranges, harvests, reduces and redeems are never gated by this check (they keep the
positions or spend nothing). Without `budget` (V3, or unread on V4: the operator sets `room: 0n` on V4 read failure)
behaviour is: V3 unchanged, V4 waits.
The vault ceiling `ratioBps × C` is already enforced at prepare (`test_listedVaultExposureCapped`); the sweep amount is
also clipped by it so it is not proposed to fail.

### R4 vault cost basis

`yield-receipts.ts` decodes, for ops of kind `vault_deposit` / `vault_redeem`, the ERC-4626 events of the vault with
`owner == Safe`:
`event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)` and
`event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)`.
Kept on `StoredOp.facts.vault = { vault, assetsIn | assetsOut, shares }`. Backfill: the same path already re-reads ops
with a txHash and no facts (header of `yield-receipts.ts`), so existing vault ops get facts on the first run.
Per account and vault the snapshot serves `{ netDepositedUsdc, sharesAccounted }`. If `sharesAccounted ≠ shares held`
(± 1 wei rounding), the vault's yield is `null` (not counted).
`vaultYieldUsdc = valueUsdc − netDepositedUsdc`.

### R8 labels

Income source of an op's collected fees: `harvest` when the intent kind is `harvest`; `re-range` for any other op that
collected (rerange, reduce, close_position). `vault-yield` is the day's change of cumulative vault yield per account.
New table, written by the Worker cron that writes the ledger today (`apps/mamoru-app/src/api/yield-ledger.ts`):

```sql
-- migrations/d1/XXXX_income_ledger.sql (coordinator numbers it)
CREATE TABLE yield_ledger_income (
  day TEXT NOT NULL, chain_id INTEGER NOT NULL, account_key TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod','beta','test','unknown')),
  source TEXT NOT NULL CHECK (source IN ('harvest','re-range','vault-yield')),
  usd INTEGER,                 -- raw USDC; null while unpriced or not counted
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, chain_id, account_key, source)
) WITHOUT ROWID;
CREATE TABLE yield_ledger_vault_daily (
  day TEXT NOT NULL, chain_id INTEGER NOT NULL, account_key TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod','beta','test','unknown')),
  vault TEXT NOT NULL, shares TEXT NOT NULL, value_usdc INTEGER NOT NULL,
  net_deposited_usdc INTEGER,  -- null: shares not explained by engine ops
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, chain_id, account_key, vault)
) WITHOUT ROWID;
```

Additive only. Spec 013 reads both for "Earned in the last 24h" and "Total earned".

### App

`YieldLedgerView` (`packages/domain`) gains `vaultYieldUsd: string | null`. `earnedSoFarUsd` = LP accrued + collected
+ vault yield when all known; when vault yield is null the figure is LP-only and the view says
`vaultYieldUsd: null` (the UI shows "vault yield not counted" only if spec 013 / Ot+Brais approve the text; until then
the number is unchanged in shape).

## Sequences

1. Review N: fees > 3x cost → `harvest` (collect to Safe). Receipt facts: collected0/1 → income `harvest`.
2. Review N+1: volatile held, bucket not under-weight → `convert` sized on `held` → USDC free.
3. Review N+2: free USDC, room OK → entry for an under-weight bucket; else sweep to vault (R2).
4. Snapshot cron: vault value vs net deposited → `yield_ledger_vault_daily`, income `vault-yield` delta.
5. Monad: steps 1–3 on the sleeve's own engine; excess over target → `returnDue` → CCTP home (V4).

## Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Sale reverts on slippage | volatile stays | next review retries with the new balance; existing backoff |
| V4 budget revert (`BudgetExceeded`, `Cap24hExceeded`, `Cap30Exceeded`) | op fails, gas spent | decode the error name into the op log (T5); R6 should make it rare |
| `budgetLeft` read fails | no reinvestment op | `DECIDE_WAIT_BUDGET`; positions maintained |
| Vault op receipt unreadable | no facts | vault yield null for that account until read |
| Many accounts harvest at once | bundler/gas burst | one op per account per review already; relayer nonce serial (constitution XI) |

## Data and deploy notes

- Migration `XXXX_income_ledger.sql`: additive, applied by the coordinator **before** the Worker that writes it.
- Operator redeploy (coordinator, `operator:deploy <sha>`): R2, R6, R4 receipts. Restart once for all merged 012 PRs.
- App Worker: writer of the new tables + `/yield` view. Order: migration → operator → app (beta), then prod with the
  hackathon batch (PRD decision 5, `--min-soak-hours=0 --hotfix="ethglobal-mumbai"`).
- No secret, no contract, no registry change.
- Funds-touching PRs (decide, operator) are reviewed with `xreview --high-stakes` / `review:pr`, peer gate if Sol has
  no headroom.

## Constitution check

- I (no custody): no new grant, no new recipient; sale and deposit go to the Safe or the listed vault. Pass.
- IV (Uniswap V3 only execution): the sale is a V3 swap in the policy's pool. Pass.
- V (gates): sale and sweep pass the same gates as today's idle sale and vault deposit. Pass.
- XI (one op, one nonce): one op per review, unchanged. Pass.
- XVI (truth on screen): labels are recorded, not inferred; unexplained vault shares → not counted, never 0. Pass.
- XIX (between chains): CCTP standard, fee 0, recipient fixed by policy; return home reused. Pass.
- XX (simplicity): rules in one sentence each: "sell what you collected when its bucket is full", "free USDC fills the
  vault up to its drain line", "reinvest only if V4 room still covers the biggest re-mint". No new proposal kind. Pass.
