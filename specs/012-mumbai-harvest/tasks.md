# 012 tasks: full harvest

Spec `spec.md`, plan `plan.md`, scenarios `scenarios.md`. Ticket otto/mamoru#107 (subtasks as its checklist).
Every task: own worktree from `origin/main`, PR with label `ethglobal-mumbai`, `release:check` green, review by a
different model (`--high-stakes` for decide and operator), merge by the coordinator. No `Co-Authored-By` or model
lines. No contract, registry or secret change. No deploy from a task.

## Order

```
HT1 (domain, serial) ─┬─ HT2 decide R6 ─┐
                      ├─ HT3 decide R2 ─┼─ HT5 operator (operator.ts, serial) ─ HT8 fork e2e
                      ├─ HT4 decide tests R1/R3/R9 (parallel, test-only)
                      ├─ HT6 operator receipts R4/R8 ─┐
                      └─ HT7 migration + app R4/R8 ───┴─ HT8
```

Parallel group A after HT1: HT2, HT3, HT4, HT6, HT7. HT2 and HT3 both edit `allocate/index.ts`: HT3 stacks on HT2's
branch. HT5 is the only task touching `operator.ts`.

## Tasks

**HT1. Domain types** (serial, first; hot file `packages/domain`)
- Files: `packages/domain/src/reason-codes.ts`, `packages/domain/src/app-api.ts`
  (`YieldLedgerView.vaultYieldUsd`), `packages/decide/src/types.ts` (`Observation.budget?`), their tests. ≤ 5 files.
- Reqs: R4, R6, R8. Accepts: typecheck + existing tests.
- Must not: change any existing code's meaning; add UI text.

**HT2. Room check before reinvesting** (decide-pure)
- Files: `packages/decide/src/allocate/index.ts`, `packages/decide/src/rerange/index.ts` (idleConvertOf gate),
  `packages/decide/src/index.ts` (pass reserve), new `packages/decide/src/budget.test.ts`.
- Reqs: R6. Accepts: HRV-S03, S04, S05.
- Must not: gate exit, rerange, harvest, reduce or redeem.

**HT3. Sweep free USDC to the vault up to the drain line** (decide-pure, stacked on HT2)
- Files: `packages/decide/src/allocate/index.ts`, `packages/decide/src/vault.test.ts`.
- Reqs: R2, R5. Accepts: HRV-S10, S11, S12.
- Must not: change `DRIFT_BPS`, `rebalanceBandBps` or `vaultMinDeposit`; take money listed in `waiting`.

**HT4. Harvest-to-sale and cross-chain checks** (tests only, parallel)
- Files: `packages/decide/src/harvest.test.ts` (new), `packages/decide/src/allocate.test.ts`.
- Reqs: R1, R3, R7, R9. Accepts: HRV-S02, S06, S13, S14.
- Must not: change source; a failing check becomes a ticket comment and a fix task, not a silent edit.

**HT5. Operator: fill `budget`, decode V4 budget reverts** (serial; only task in `operator.ts`)
- Files: `apps/mamoru-operator/src/operator.ts` (observation build), `apps/mamoru-operator/src/session-usage.ts`
  (V4 `budgetLeft` read beside `readPolicyBudgets`), error decode helper + tests.
- Reqs: R6. Accepts: HRV-S16, S17.
- Must not: read more than one `budgetLeft` per account per review; touch bridge-out sizing.

**HT6. Operator receipts: vault cost basis and income source** (parallel; no `operator.ts`)
- Files: `apps/mamoru-operator/src/yield-receipts.ts`, `apps/mamoru-operator/src/state.ts` (`OpFacts.vault`,
  `source`), `apps/mamoru-operator/src/snapshot.ts` (serve `netDepositedUsdc`, `sharesAccounted`, income by source),
  tests.
- Reqs: R4, R8. Accepts: HRV-S07, S08.
- Must not: add RPC reads outside the receipt path (backfill uses stored tx hashes only).

**HT7. Migration and app** (parallel)
- Files: `migrations/d1/XXXX_income_ledger.sql`, `apps/mamoru-app/src/api/yield-ledger.ts`,
  `apps/mamoru-app/src/api/accounts/yield.ts`, tests.
- Reqs: R4, R8. Accepts: HRV-S09, S15.
- Must not: change UI components or copy (the figure keeps its place; only its value grows).

**HT8. Base fork e2e and evidence** (after HT5, HT6, HT7)
- Files: `apps/mamoru-operator/test/e2e-harvest.ts` (new), `specs/012-mumbai-harvest/results/*.md`.
- Reqs: R1, R2, R7. Accepts: HRV-S01.
- Must not: send on mainnet; force a harvest in production.

## Deploy (coordinator)

Migration → operator redeploy (one, for HT2/HT3/HT5/HT6) → app Worker on beta. Prod with the hackathon batch.
