# 012: Full harvest: collect, sell to USDC, reinvest, and count vault yield as earned

> **Status 7 Nov: delivered** and running in both operators since ~05:00 IST; first mainnet harvest on Monad (collect `0xd758f364…`, sale `0xb7099796…`). Merged: #303, #305, #308, #310–#313, #318. Open: #309 (copy approval). Found during implementation: V3 Monad sleeves have no bridge-out grant (return needs a new grant, after the hackathon); the 24 h hold after a return is unconditional; the harvested counter's clamp to the balance is stored, so an owner withdrawal lowers it for good.

Ticket: otto/mamoru#107 (context: #140, the collect-only harvest). Event: ETHGlobal Mumbai 2026 (Continuity), priority 2 of 3.
PRD: [`docs/ethglobal-mumbai/prd.md`](../../docs/ethglobal-mumbai/prd.md) (summary) §2 decisions 2 and 4, §5.2, §9, annex B.
Status: draft r2 (after the GPT-6 Sol gate, NO APTO r1). Plan: `plan.md`. Tasks: `tasks.md`. Scenarios: `scenarios.md`. Threats: `threats.md`.
Execution order across specs: [`specs/mumbai-execution.md`](../mumbai-execution.md).

## Problem

Mamoru earns in two places and shows only one.

1. **Uniswap pools.** Fees accrue apart from the position and must be collected. The engine collects them (`harvestOf`,
   `packages/decide/src/harvest/index.ts:28`) with `convert: null` since #140: a sale in the same batch swapped an
   amount fixed before inclusion, which could be principal. The volatile fees then sit in the Safe mixed with any
   volatile principal; nothing tells them apart, so nothing sells exactly them. Collected USDC joins free savings and is
   placed only when a bucket's gap passes the 3 % fill band (`allocate/index.ts:220`).
2. **ERC-4626 vaults (gtUSDCp, waBasUSDC on Base, `policies-v7.ts:17`).** Yield raises the share price; nothing is
   collected. The snapshot values the shares (`apps/mamoru-operator/src/snapshot.ts:261`), but "Earned so far" counts
   only LP fees (`apps/mamoru-app/src/api/accounts/yield.ts:103`).

Accounts with fees accrued since launch have never had a full cycle. When this ships several will harvest in the same
hour; that is the demo, and it stays on chain.

## Scope

In: Base and Monad, V3 (v6/v7) and V4 (T8) live accounts. Out: incentives (Merkl, Morpho rewards; none active, PRD
annex B.3), contract changes, a new swap venue, the 3x harvest threshold, the 5-point drain band (`DRIFT_BPS = 500`).

## Earned: one definition

`earned = collected LP fees + accrued uncollected LP fees + vault yield`. Portfolio ("Earned so far") and `/stats`
("Total earned", "Earned in the last 24h", spec 013) use this one definition and the same rows. A part that cannot be
known is reported as not counted, never as 0 and never folded silently into a smaller total.

## Requirements

- **HRV-R1. Sell exactly what was harvested, in its own op.** The operator keeps, per account, chain and volatile token,
  the harvested-unsold amount: `+` the volatile a confirmed harvest op collected (its receipt facts), `−` what a
  confirmed harvest sale sold, and never above the Safe's balance of that token. A later review sells
  `min(harvested-unsold, Safe balance)` to USDC in a separate op (#140), with the policy's slippage and TWAP gate.
  Principal is never sold by this path; the existing idle-volatile rules for principal are unchanged. Entries do not
  mint harvested-unsold volatile: it is always sold (no mint-direct exception).
- **HRV-R2. A sale below its cost waits and accumulates.** While the harvested-unsold value is ≤ the sale's op cost x
  the harvest factor, the bucket says `DECIDE_WAIT_HARVEST_SALE`; later harvests add to it and it is sold as soon as it
  covers the cost. After 7 days the bar drops to 1 × op cost, so harvested fees are never stuck; below that they are
  dust and stay in the idle total.
- **HRV-R3. Reinvest USDC with the usual rules, past the fill band.** Free USDC a review leaves unplaced, at or above
  `vaultMinDeposit` (40 USDC), goes to the Stable bucket's vault on Base even inside the 3 % fill band, up to one unit
  below the drain line (target + 5 points of total), so no later review redeems it. Money another bucket is waiting for
  (`waiting`) is never swept.
- **HRV-R4. Idle USDC on another chain goes home.** No veto between chains (PRD decision 4). When a remote Safe's
  **idle USDC** is ≥ the return threshold (`entryMin`, the floor an entry must be worth) and has stayed idle for one
  dwell period (6 h) while its own engine could not place it, it is brought home over CCTP (standard, fee 0). After a
  return, Base sends nothing to that chain for 24 h unless its sleeve placed everything (no ping-pong).
  V4: through #278's return path. V3: only if the live signed V3 remote policy allows a Monad→Base bridge-out, under
  spec 011's `SessionObs.bridgeLimit` (split sends, fail closed). If the signed policy forbids it, the account is
  recorded as "needs a renewal" with the evidence; no contract change.
- **HRV-R5. Vault yield is earned.** Per account and vault, from consecutive snapshot samples:
  `yield(interval) = value(now) − value(previous) − net flows(interval)`, net flows being the USDC of the account's own
  ERC-4626 `Deposit` minus `Withdraw` events (owner = the Safe) between the two samples. Yield accrued before tracking
  starts is one `backfill` amount, `value(first sample) − net deposited known from engine ops`, or not counted when the
  shares are not explained by engine ops.
- **HRV-R6. Partial vault redeems.** Already allowed without the owner's signature and used to rebalance (PRD annex
  B.2). No change.
- **HRV-R7. Keep positions before reinvesting (V4).** A reinvestment op (sale of R1, sweep of R3, an entry of
  harvested USDC) goes only if V4's room after it (`budgetLeft`: min of account bucket, sub-bucket, 30 days, 24 h)
  still covers re-minting **all** current LP positions on that chain, `reserve = 1.5 x LP value`: a re-range re-mints
  the position (1.0) and swaps to re-centre it, at most half its value (0.5, a fully out-of-range position is one token
  and re-centres to about half each). An upper bound, not an average. Otherwise the
  USDC or volatile waits with `DECIDE_WAIT_BUDGET`. A vault at its ceiling (`ratioBps x C`, I5) is not deposited into.
  V3 has no `budgetLeft`: V3 relies on the on-chain per-pool totals and the operator's revert handling.
- **HRV-R8. Threshold unchanged.** Harvest fires when fees > 3 x op cost (`costFactorBps: 30000`).
- **HRV-R9. Every income is an event with a label and a time.** One ledger row per income event: key = tx hash + log
  index (fee collects) or vault + sample id (vault yield); block time (or sample time); source exactly one of
  `harvest`, `re-range` (fees collected by an op that removed liquidity: re-range, reduce, exit), `vault-yield`,
  `backfill`. Rolling windows (24 h) sum events by time; `backfill` is excluded from them.
- **HRV-R10. Missing is marked.** When vault yield is not counted for an account, the yield API returns that status and
  the Portfolio shows a minimal "not counted" marker next to "Earned so far" (constitution XVI). Copy proposed in the
  PR, OK from Ot and Brais before merge; the task ships it.
- **HRV-R11. Every live account, or named.** R1–R10 hold on live V3 (v6, v7) and V4 accounts on Base and Monad, each
  checked on a fork with its live policy. An account a requirement cannot serve is named in #107 with its reason.

## Edge cases

- Harvested volatile in a pool that is exit-only on V4: sold through an eligible pool of the same token, or waits.
- Two harvests of one account in one UTC day: two events (R9).
- Safe balance of the token drops below harvested-unsold (a re-range spent it, a user withdrawal): harvested-unsold is
  clipped to the balance at the next observation.
- Share price below cost basis (bad debt): vault yield negative, as read.
- `budgetLeft` unreadable: no reinvestment op (`DECIDE_WAIT_BUDGET`); positions still maintained.

## Acceptance

- **A1.** Fork, live v7 policy, one account: collect → sale of exactly the harvested volatile → deposit or entry; the
  amounts reconcile receipt to receipt (HRV-R1, R3, R8). HRV-S01.
- **A2.** Harvested volatile below the sale cost waits, accumulates over harvests and is sold (HRV-R2). HRV-S02.
- **A3.** V4 room below the all-positions reserve: reinvestment waits, a re-range still goes (HRV-R7). HRV-S03..S05.
- **A4.** Idle USDC on Monad above threshold returns home on V4; V3 per the live-policy check (HRV-R4). HRV-S06, S14, S18.
- **A5.** Vault yield by interval and backfill; unexplained shares not counted with the marker (HRV-R5, R10). HRV-S07, S08, S15.
- **A6.** Σ Portfolio earned over all accounts == `/stats` total earned at the same read time (one definition). HRV-S19.
- **A7.** Read-only reconciliation on prod data: how many vault holdings get a cost basis, recorded in `results/`. HRV-S20.
- **A8.** Production after release: one account with collect, sale and reinvest tx hashes, the matching ledger events
  and the API figure that includes them. HRV-S21. No scenario is forced on mainnet.
